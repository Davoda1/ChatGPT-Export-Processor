'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {finished, pipeline} = require('node:stream/promises');
const {build, Platform, Arch} = require('electron-builder');
const {verify} = require('./verify-package.cjs');
const root = path.resolve(__dirname, '..');
const packageInfo = require('../package.json');
const archiveEpoch = 1767225600;
const linuxDependencies = [
  'libasound2t64 (>= 1.0.17) | libasound2 (>= 1.0.17)',
  'libatk-bridge2.0-0t64 (>= 2.5.3) | libatk-bridge2.0-0 (>= 2.5.3)',
  'libatk1.0-0t64 (>= 2.32.0) | libatk1.0-0 (>= 2.32.0)',
  'libatspi2.0-0t64 (>= 2.9.90) | libatspi2.0-0 (>= 2.9.90)',
  'libc6 (>= 2.34)', 'libcairo2 (>= 1.14.0)',
  'libcups2t64 (>= 1.7.0) | libcups2 (>= 1.7.0)',
  'libdbus-1-3 (>= 1.9.14)', 'libexpat1 (>= 2.1~beta3)', 'libgbm1 (>= 21.1.0)', 'libgcc-s1 (>= 4.2)',
  'libglib2.0-0t64 (>= 2.50.0) | libglib2.0-0 (>= 2.50.0)',
  'libgtk-3-0t64 (>= 3.9.10) | libgtk-3-0 (>= 3.9.10)',
  'libnspr4 (>= 2:4.9-2~)', 'libnss3 (>= 2:3.30)', 'libpango-1.0-0 (>= 1.14.0)', 'libudev1 (>= 183)',
  'libx11-6 (>= 2:1.4.99.1)', 'libxcb1 (>= 1.9.2)', 'libxcomposite1 (>= 1:0.4.5)',
  'libxdamage1 (>= 1:1.1)', 'libxext6', 'libxfixes3', 'libxkbcommon0 (>= 0.5.0)', 'libxrandr2',
  'libxss1', 'libxtst6', 'xdg-utils',
];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}
async function withAsarWriteCompletion(task) {
  // The pinned ASAR 3.4.1 writer returns after end(), before its destination
  // finishes. Its internal export is looked up for each call, unlike cached
  // ESM named exports, so this build-scoped wrapper can be fully restored.
  const disk = require('@electron/asar/lib/disk');
  const original = disk.streamFilesystem;
  disk.streamFilesystem = async (...args) => {
    const output = await original(...args);
    await finished(output);
    return output;
  };
  try { return await task(); }
  finally { disk.streamFilesystem = original; }
}
async function addDirectory(zip, directory, prefix = '') {
  for (const item of (await fsp.readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const source = path.join(directory, item.name), target = prefix + item.name;
    if (item.isDirectory()) await addDirectory(zip, source, target + '/');
    else if (item.isFile()) zip.addFile(source, target, {mtime: new Date('2026-01-01T00:00:00Z')});
    else throw new Error('Unexpected symlink in Windows portable directory.');
  }
}
async function zipDirectory(directory, target) {
  const {ZipFile} = require('yazl');
  const zip = new ZipFile();
  await addDirectory(zip, directory);
  const task = pipeline(zip.outputStream, fs.createWriteStream(target, {flags: 'wx'}));
  zip.end();
  await task;
}
async function installedSize(directory) {
  let kibibytes = 1;
  for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    kibibytes += entry.isDirectory() ? await installedSize(file) : Math.max(1, Math.ceil((await fsp.lstat(file)).size / 1024));
  }
  return kibibytes;
}
async function createDeb(directory, outDir) {
  if (process.platform !== 'linux') throw new Error('Debian packaging requires Linux and dpkg-deb.');
  const staging = await fsp.mkdtemp(path.join(outDir, 'deb-stage-'));
  try {
    // The data archive includes this root directory; mkdtemp's private mode
    // must not become a restrictive permission on the installation root.
    await fsp.chmod(staging, 0o755);
    const install = path.join(staging, 'opt', 'chatgpt-export-processor');
    await fsp.mkdir(path.dirname(install), {recursive: true});
    await fsp.cp(directory, install, {recursive: true, verbatimSymlinks: true});
    // dpkg records root ownership below. The fallback sandbox must arrive with
    // its required permissions, without an installer or launcher script.
    await fsp.chmod(path.join(install, 'chrome-sandbox'), 0o4755);
    await fsp.mkdir(path.join(staging, 'usr', 'bin'), {recursive: true});
    await fsp.symlink('../../opt/chatgpt-export-processor/chatgpt-export-processor', path.join(staging, 'usr', 'bin', 'chatgpt-export-processor'));
    const appDir = path.join(staging, 'usr', 'share', 'applications');
    await fsp.mkdir(appDir, {recursive: true});
    await fsp.writeFile(path.join(appDir, 'chatgpt-export-processor.desktop'), '[Desktop Entry]\nType=Application\nName=ChatGPT Export Processor\nComment=Convert and inspect ChatGPT exports locally\nExec=chatgpt-export-processor\nIcon=chatgpt-export-processor\nTerminal=false\nCategories=Utility;Development;\nStartupWMClass=chatgpt-export-processor\n');
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const iconDir = path.join(staging, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps');
      await fsp.mkdir(iconDir, {recursive: true});
      await fsp.copyFile(path.join(root, 'build', 'icons', `${size}x${size}.png`), path.join(iconDir, 'chatgpt-export-processor.png'));
    }
    const docDir = path.join(staging, 'usr', 'share', 'doc', 'chatgpt-export-processor');
    await fsp.mkdir(docDir, {recursive: true});
    await fsp.copyFile(path.join(root, 'LICENSE'), path.join(docDir, 'copyright'));
    await fsp.copyFile(path.join(root, 'README.md'), path.join(docDir, 'README.md'));
    const sizeKiB = await installedSize(staging);
    await fsp.mkdir(path.join(staging, 'DEBIAN'));
    const control = `Package: chatgpt-export-processor\nVersion: ${packageInfo.version}\nArchitecture: amd64\nSection: utils\nPriority: optional\nMaintainer: davoda1\nHomepage: ${packageInfo.homepage}\nInstalled-Size: ${sizeKiB}\nDepends: ${linuxDependencies.join(', ')}\nDescription: Local ChatGPT export conversion and validation\n Convert export archives and inspect conversion evidence without a server.\n`;
    await fsp.writeFile(path.join(staging, 'DEBIAN', 'control'), control, {mode: 0o644});
    const target = path.join(outDir, `chatgpt-export-processor_${packageInfo.version}_amd64.deb`);
    if (fs.existsSync(target)) throw new Error('Package already exists; move it before rebuilding.');
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '--threads-max=2', '--build', staging, target], {env: {...process.env, SOURCE_DATE_EPOCH: String(archiveEpoch)}});
    return target;
  } finally { await fsp.rm(staging, {recursive: true, force: true}); }
}
async function main() {
  const args = process.argv.slice(2);
  let targetPlatform = process.platform === 'win32' ? 'win' : 'linux';
  let platformSeen = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--platform' && !platformSeen) { targetPlatform = args[++index]; platformSeen = true; }
    else if (args[index] !== '--packages') throw new Error('Usage: node scripts/build.cjs --platform linux|win [--packages]');
  }
  if (!['linux', 'win'].includes(targetPlatform)) throw new Error('Use --platform linux or --platform win.');
  run(process.execPath, [path.join(__dirname, 'collect-notices.cjs')]);
  run(process.execPath, [path.join(__dirname, 'privacy-check.cjs')]);
  if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) throw new Error('Committed application icons are missing.');
  const platform = targetPlatform === 'win' ? Platform.WINDOWS : Platform.LINUX;
  const outDir = path.join(root, 'dist'), directory = path.join(outDir, targetPlatform === 'win' ? 'win-unpacked' : 'linux-unpacked');
  const {downloadArtifact} = await import('@electron/get');
  const electronZip = await downloadArtifact({version: packageInfo.devDependencies.electron, artifactName: 'electron', platform: targetPlatform === 'win' ? 'win32' : 'linux', arch: 'x64'});
  // The target directory belongs to this build; remove interrupted-build leftovers.
  await fsp.rm(directory, {recursive: true, force: true});
  await withAsarWriteCompletion(() => build({projectDir: root, config: {...packageInfo.build, electronDist: electronZip}, targets: platform.createTarget(['dir'], Arch.x64), publish: 'never'}));
  // A verified stock archive passed as electronDist retains the default app.
  // Only the renamed application entrypoint and its own ASAR are shipped.
  for (const stock of [targetPlatform === 'win' ? 'electron.exe' : 'electron', 'version', path.join('resources', 'default_app.asar')]) await fsp.rm(path.join(directory, stock), {force: true});
  for (const [source, target] of [
    ['README.md', 'README.md'], ['LICENSE', 'LICENSE-ChatGPT-Export-Processor.txt'],
    ['docs/BUILDING.md', 'BUILDING.md'], ['docs/THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
  ]) await fsp.copyFile(path.join(root, source), path.join(directory, target));
  if (targetPlatform === 'linux') {
    await fsp.mkdir(path.join(directory, 'bin'), {recursive: true});
    const link = path.join(directory, 'bin', 'chatgpt-export-processor');
    await fsp.rm(link, {force: true});
    await fsp.symlink('../chatgpt-export-processor', link);
  }
  console.log(JSON.stringify(verify(directory, targetPlatform), null, 2));
  if (!args.includes('--packages')) return;
  if (targetPlatform === 'win') await zipDirectory(directory, path.join(outDir, `ChatGPT-Export-Processor-${packageInfo.version}-Windows-x64-Portable.zip`));
  else {
    const target = path.join(outDir, `ChatGPT-Export-Processor-${packageInfo.version}-Linux-amd64.tar.gz`);
    if (fs.existsSync(target)) throw new Error('Archive already exists; move it before rebuilding.');
    run('tar', ['--sort=name', '--format=gnu', `--mtime=@${archiveEpoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w,a-s', '-czf', target, '-C', directory, '.']);
    await createDeb(directory, outDir);
  }
}
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
  // Match electron-builder's failure handling: its Windows cleanup can replace
  // exitCode after the build promise rejects, so preserve failure at exit too.
  process.on('exit', () => { process.exitCode = 1; });
});
module.exports = {zipDirectory, createDeb, withAsarWriteCompletion};
