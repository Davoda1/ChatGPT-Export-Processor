'use strict';
const fs = require('node:fs');
const path = require('node:path');
function verify(dir, platform) {
  const executable = path.join(dir, platform === 'win' ? 'ChatGPT-Export-Processor.exe' : 'chatgpt-export-processor');
  const magic = Buffer.alloc(4), descriptor = fs.openSync(executable, 'r');
  try { fs.readSync(descriptor, magic, 0, 4, 0); } finally { fs.closeSync(descriptor); }
  if (platform === 'win' ? magic[0] !== 0x4d || magic[1] !== 0x5a : !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('The application entrypoint must be a native binary.');
  if (!fs.statSync(path.join(dir, 'resources', 'app.asar')).isFile()) throw new Error('Packaged application archive is missing.');
  for (const notice of ['README.md', 'BUILDING.md', 'LICENSE-ChatGPT-Export-Processor.txt', 'THIRD-PARTY-NOTICES.md', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    if (!fs.statSync(path.join(dir, notice)).isFile()) throw new Error('Packaged documentation or legal notice is missing: ' + notice);
  }
  for (const leftover of ['electron', 'electron.exe', path.join('resources', 'default_app.asar')]) if (fs.existsSync(path.join(dir, leftover))) throw new Error('Stock Electron entrypoint or default application was retained.');
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) throw new Error('Unexpected hidden build artifact in packaged application.');
    if (/\.(?:sh|cmd|bat|ps1)$/i.test(name) || /-launcher$/.test(name)) throw new Error('Launcher scripts are not permitted: ' + name);
  }
  if (platform === 'linux') {
    const link = path.join(dir, 'bin', 'chatgpt-export-processor');
    if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(executable)) throw new Error('Linux bin entry must point directly to the native executable.');
    if (!(fs.statSync(executable).mode & 0o111)) throw new Error('Native executable has no executable permission.');
    if (!fs.statSync(path.join(dir, 'chrome-sandbox')).isFile()) throw new Error('The Linux sandbox helper is missing.');
  }
  const asar = require('@electron/asar');
  const archive = path.join(dir, 'resources', 'app.asar');
  // ASAR lookups use the host path separator, including for archive members.
  // Normalize only the inventory used for portable policy comparisons.
  const names = asar.listPackage(archive).map(name => name.split(path.sep).join('/'));
  const members = new Set(names);
  function requiredFile(name) {
    if (!members.has('/' + name)) throw new Error('Required packaged file is missing: ' + name);
    const nativeName = path.join(...name.split('/'));
    const info = asar.statFile(archive, nativeName, false);
    if ('files' in info || 'link' in info || info.unpacked) throw new Error('Required packaged entry must be a regular archived file: ' + name);
    return asar.extractFile(archive, nativeName, false);
  }
  const icon = requiredFile('build/icons/256x256.png');
  if (icon.length < 24 || !icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || icon.readUInt32BE(16) !== 256 || icon.readUInt32BE(20) !== 256) throw new Error('Packaged window icon is missing or invalid.');
  const manifest = JSON.parse(requiredFile('package.json'));
  if (manifest.version !== '1.0.0' || manifest.author !== 'davoda1' || manifest.name !== 'chatgpt-export-processor') throw new Error('Unexpected packaged identity.');
  if (Object.keys(manifest.dependencies || {}).some(x => /ssh|ftp/.test(x))) throw new Error('Unexpected network deployment dependency.');
  const forbidden = names.filter(x => /(?:^|\/)(?:configs(?:\.example)?\.txt|deploy\.cjs|\.env|\.git)(?:\/|$)/i.test(x));
  if (forbidden.length) throw new Error('Private or legacy deployment files were packaged.');
  return {platform, executable: path.basename(executable), version: manifest.version, files: names.length};
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const get = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const platform = get('--platform') || (process.platform === 'win32' ? 'win' : 'linux');
    if (!['win', 'linux'].includes(platform)) throw new Error('Use --platform linux or --platform win.');
    const dir = path.resolve(get('--dir') || path.join(__dirname, '..', 'dist', platform === 'win' ? 'win-unpacked' : 'linux-unpacked'));
    console.log(JSON.stringify(verify(dir, platform), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {verify};
