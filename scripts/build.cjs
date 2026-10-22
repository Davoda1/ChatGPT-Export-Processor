'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const {build, Platform, Arch} = require('electron-builder');
const {verify} = require('./verify-package.cjs');
const root = path.resolve(__dirname, '..');
const packageInfo = require('../package.json');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
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
async function createDeb(directory, outDir) {
  if (process.platform !== 'linux') throw new Error('Debian packaging requires Linux and dpkg-deb.');
  const staging = await fsp.mkdtemp(path.join(outDir, 'deb-stage-'));
  try {
    const install = path.join(staging, 'opt', 'chatgpt-export-processor');
    await fsp.mkdir(path.dirname(install), {recursive: true});
    await fsp.cp(directory, install, {recursive: true, verbatimSymlinks: true});
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
    await fsp.mkdir(path.join(staging, 'DEBIAN'));
    const control = `Package: chatgpt-export-processor\nVersion: ${packageInfo.version}\nArchitecture: amd64\nSection: utils\nPriority: optional\nMaintainer: davoda1\nHomepage: ${packageInfo.homepage}\nDepends: libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2, libatk-bridge2.0-0, libxss1, libxtst6, xdg-utils\nDescription: Local ChatGPT export conversion and validation\n Convert export archives and inspect conversion evidence without a server.\n`;
    await fsp.writeFile(path.join(staging, 'DEBIAN', 'control'), control, {mode: 0o644});
    const target = path.join(outDir, `chatgpt-export-processor_${packageInfo.version}_amd64.deb`);
    if (fs.existsSync(target)) throw new Error('Package already exists; move it before rebuilding.');
    run('dpkg-deb', ['--root-owner-group', '--build', staging, target]);
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
  await build({projectDir: root, config: {...packageInfo.build, electronDist: electronZip}, targets: platform.createTarget(['dir'], Arch.x64), publish: 'never'});
  // A verified stock archive passed as electronDist retains the default app.
  // Only the renamed application entrypoint and its own ASAR are shipped.
  for (const stock of [targetPlatform === 'win' ? 'electron.exe' : 'electron', 'version', path.join('resources', 'default_app.asar')]) await fsp.rm(path.join(directory, stock), {force: true});
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
    run('tar', ['-czf', target, '-C', directory, '.']);
    await createDeb(directory, outDir);
  }
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {zipDirectory, createDeb};
