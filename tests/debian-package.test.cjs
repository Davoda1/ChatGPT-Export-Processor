'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createDeb} = require('../scripts/build.cjs');
const {verifyNativeBinary} = require('../scripts/linux-entrypoint.cjs');
const version = require('../package.json').version;

test('Debian archive installs a regular native command and the sandbox with correct metadata', {skip: process.platform !== 'linux' || process.arch !== 'x64'}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-debian-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const runtime = path.join(directory, 'runtime'), extracted = path.join(directory, 'extracted');
  await fs.mkdir(runtime);
  // Minimal native fixture: full runtime execution has its own release tests.
  await fs.copyFile('/bin/true', path.join(runtime, 'chatgpt-export-processor'));
  await fs.copyFile('/bin/true', path.join(runtime, 'chrome-sandbox'));
  const archive = await createDeb(runtime, directory);
  execFileSync('dpkg-deb', ['--extract', archive, extracted]);
  const entrypoint = path.join(extracted, 'usr', 'bin', 'chatgpt-export-processor');
  const stat = verifyNativeBinary(entrypoint, 'linux');
  assert.equal(stat.mode & 0o7777, 0o755);
  assert.equal((await fs.lstat(path.join(extracted, 'opt', 'chatgpt-export-processor', 'chrome-sandbox'))).mode & 0o7777, 0o4755);
  const metadata = execFileSync('dpkg-deb', ['--field', archive, 'Version', 'Architecture', 'Maintainer'], {encoding: 'utf8'});
  assert.equal(metadata, `Version: ${version}\nArchitecture: amd64\nMaintainer: davoda1\n`);
  const desktop = await fs.readFile(path.join(extracted, 'usr', 'share', 'applications', 'chatgpt-export-processor.desktop'), 'utf8');
  assert.match(desktop, /^Exec=chatgpt-export-processor$/m);
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('deb-stage-')), false, 'The private packaging stage must be removed.');
});
