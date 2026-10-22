'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const crc32 = require('crc-32');
const {verify} = require('./verify-package.cjs');
const version = require('../package.json').version;

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function safeName(name) {
  const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') return null;
  if (normalized.includes(':') || normalized.includes('\\') || normalized.includes('\0') || path.posix.isAbsolute(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe archive entry.');
  return normalized;
}
async function inventory(directory, prefix = '') {
  const entries = [];
  for (const item of (await fsp.readdir(directory, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(directory, item.name), name = prefix + item.name;
    if (item.isDirectory()) entries.push(...await inventory(file, name + '/'));
    else if (item.isSymbolicLink()) entries.push({name, type: 'symlink', target: await fsp.readlink(file)});
    else if (item.isFile()) entries.push({name, type: 'file', hash: await hash(file)});
    else throw new Error('Unexpected packaged filesystem object.');
  }
  return entries;
}
async function extractZip(archive, destination) {
  const yauzl = require('yauzl');
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, {lazyEntries: true, validateEntrySizes: true, strictFileNames: true}, (error, value) => error ? reject(error) : resolve(value)));
  const seen = new Set();
  await new Promise((resolve, reject) => {
    const failed = error => {zip.close(); reject(error);};
    zip.once('error', failed); zip.once('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        const name = safeName(entry.fileName);
        if (!name) return;
        if (seen.has(name)) throw new Error('Duplicate archive entry.');
        seen.add(name);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000 || entry.generalPurposeBitFlag & 1) throw new Error('Unexpected symlink or encryption in portable ZIP.');
        const target = path.join(destination, ...name.split('/'));
        if (entry.fileName.endsWith('/')) {await fsp.mkdir(target, {recursive: true}); return;}
        await fsp.mkdir(path.dirname(target), {recursive: true});
        const input = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
        let crc = 0;
        const checksum = new Transform({transform(chunk, _encoding, callback) {crc = crc32.buf(chunk, crc); callback(null, chunk);}});
        await pipeline(input, checksum, fs.createWriteStream(target, {flags: 'wx'}));
        assert.equal(crc >>> 0, entry.crc32, 'Portable ZIP entry CRC must match.');
      })().then(() => zip.readEntry(), failed);
    });
    zip.readEntry();
  });
}
async function verifyArchive(archive, reference, destination) {
  assert.equal(fs.existsSync(destination), false, 'Extraction destination must be new.');
  await fsp.mkdir(destination, {recursive: true});
  const platform = process.platform === 'win32' ? 'win' : 'linux';
  if (platform === 'win') {
    assert.equal(path.basename(archive), `ChatGPT-Export-Processor-${version}-Windows-x64-Portable.zip`);
    await extractZip(archive, destination);
  } else {
    assert.equal(process.platform, 'linux');
    assert.equal(path.basename(archive), `ChatGPT-Export-Processor-${version}-Linux-amd64.tar.gz`);
    const listing = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
    const seen = new Set();
    for (const line of listing.trimEnd().split('\n')) {
      const name = safeName(line);
      if (name) {assert.equal(seen.has(name), false, 'Duplicate archive entry.'); seen.add(name);}
    }
    execFileSync('tar', ['-xzf', archive, '-C', destination], {stdio: 'inherit'});
  }
  const actual = await inventory(destination), expected = await inventory(reference);
  assert.deepEqual(actual, expected, 'Extracted release files must match the validated build byte for byte.');
  for (const entry of actual) assert.ok(!/\.(?:sh|cmd|bat|ps1)$/i.test(entry.name), 'No launcher scripts may be shipped.');
  for (const legal of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) assert.ok(fs.statSync(path.join(destination, legal)).size > 0, 'Upstream runtime legal notices must be retained.');
  const result = verify(destination, platform);
  console.log(JSON.stringify({passed: true, kind: 'release archive', platform, archive: path.basename(archive), version, files: actual.length, exactBuildMatch: true, nativeEntrypoint: result.executable, legalNotices: true}, null, 2));
}
function installedPaths() {
  return ['/opt/chatgpt-export-processor', '/usr/bin/chatgpt-export-processor', '/usr/share/applications/chatgpt-export-processor.desktop', '/usr/share/doc/chatgpt-export-processor', ...[16,24,32,48,64,128,256,512].map(size => `/usr/share/icons/hicolor/${size}x${size}/apps/chatgpt-export-processor.png`)];
}
function verifyInstalled() {
  assert.equal(process.platform, 'linux');
  const directory = '/opt/chatgpt-export-processor', entrypoint = '/usr/bin/chatgpt-export-processor';
  verify(directory, 'linux');
  assert.ok(fs.lstatSync(entrypoint).isSymbolicLink(), 'Installed bin entry must be a direct native symlink.');
  assert.equal(fs.realpathSync(entrypoint), fs.realpathSync(path.join(directory, 'chatgpt-export-processor')));
  const installDirectory = fs.statSync(directory);
  assert.equal(installDirectory.uid, 0); assert.equal(installDirectory.gid, 0); assert.equal(installDirectory.mode & 0o022, 0);
  const sandbox = fs.statSync(path.join(directory, 'chrome-sandbox'));
  assert.equal(sandbox.uid, 0); assert.equal(sandbox.gid, 0); assert.equal(sandbox.mode & 0o7777, 0o4755);
  const packageStatus = execFileSync('dpkg-query', ['-W', '-f=${Status}|${Version}|${Architecture}|${Maintainer}', 'chatgpt-export-processor'], {encoding: 'utf8'});
  assert.equal(packageStatus, `install ok installed|${version}|amd64|davoda1`);
  for (const file of installedPaths()) assert.ok(fs.existsSync(file), 'Installed application file is missing.');
  const desktop = fs.readFileSync('/usr/share/applications/chatgpt-export-processor.desktop', 'utf8');
  assert.match(desktop, /^Exec=chatgpt-export-processor$/m);
  console.log(JSON.stringify({passed: true, kind: 'installed Debian package', version, nativeBinSymlink: true, rootOwnedSandbox: true, desktopIntegration: true}, null, 2));
}
function verifyRemoved() {
  assert.equal(process.platform, 'linux');
  for (const file of installedPaths()) {
    let exists = true;
    try {fs.lstatSync(file);} catch (error) {if (error.code !== 'ENOENT') throw error; exists = false;}
    assert.equal(exists, false, 'Package removal must remove its application-owned files, including symlinks.');
  }
  console.log(JSON.stringify({passed: true, kind: 'Debian package removal', applicationFilesAbsent: true}, null, 2));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--installed') return verifyInstalled();
  if (args.length === 1 && args[0] === '--removed') return verifyRemoved();
  if (args.length !== 6 || args[0] !== '--archive' || args[2] !== '--reference' || args[4] !== '--destination') throw new Error('Usage: node scripts/test-release.cjs --archive FILE --reference DIRECTORY --destination NEW_DIRECTORY | --installed | --removed');
  await verifyArchive(path.resolve(args[1]), path.resolve(args[3]), path.resolve(args[5]));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
