'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const runtimePath = '/opt/chatgpt-export-processor/chatgpt-export-processor';

function verifyNativeBinary(file, platform) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The application entrypoint must be a regular native binary, not a symlink.');
  const magic = Buffer.alloc(4), descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, magic, 0, 4, 0); } finally { fs.closeSync(descriptor); }
  if (platform === 'win' ? magic[0] !== 0x4d || magic[1] !== 0x5a : !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('The application entrypoint must be a native binary.');
  if (platform === 'linux' && !(stat.mode & 0o111)) throw new Error('Native executable has no executable permission.');
  return stat;
}

function compileLinuxEntrypoint(destination, target = runtimePath) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The installed amd64 native entrypoint must be built on Linux x64.');
  if (!path.isAbsolute(target) || /[\x00-\x1f]/.test(target)) throw new Error('The native entrypoint requires an absolute runtime path.');
  if (fs.existsSync(destination)) throw new Error('Native entrypoint output already exists.');
  // The production build uses the fixed default path. The explicit parameter
  // permits native delegation tests without writing to system directories.
  const result = spawnSync('cc', [
    '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
    '-fstack-protector-strong', '-fPIE', '-pie', '-Wl,-z,relro,-z,now', '-s',
    '-DPROCESSOR_EXECUTABLE=' + JSON.stringify(target),
    path.join(__dirname, '..', 'src', 'native', 'linux-entrypoint.c'), '-o', destination,
  ], {encoding: 'utf8'});
  if (result.error || result.status !== 0) {
    fs.rmSync(destination, {force: true});
    throw new Error('Unable to compile the Linux native entrypoint; install a C compiler and development headers.');
  }
  fs.chmodSync(destination, 0o755);
  verifyNativeBinary(destination, 'linux');
}

module.exports = {compileLinuxEntrypoint, verifyNativeBinary, runtimePath};
