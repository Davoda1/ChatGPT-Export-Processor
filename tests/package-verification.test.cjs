'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {finished} = require('node:stream/promises');
const asar = require('@electron/asar');
const {verify} = require('../scripts/verify-package.cjs');

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-package-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true, maxRetries: 5}));
  const directory = path.join(temporary, 'package'), source = path.join(temporary, 'source');
  await fs.mkdir(path.join(directory, 'resources'), {recursive: true});
  await fs.mkdir(path.join(source, 'build', 'icons'), {recursive: true});
  // A structural verification fixture, never executed as an application.
  await fs.writeFile(path.join(directory, 'ChatGPT-Export-Processor.exe'), Buffer.from([0x4d, 0x5a, 0, 0]));
  for (const name of ['README.md', 'BUILDING.md', 'LICENSE-ChatGPT-Export-Processor.txt', 'THIRD-PARTY-NOTICES.md', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) await fs.writeFile(path.join(directory, name), 'Test fixture\n');
  if (!options.missingManifest) await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({name: 'chatgpt-export-processor', version: '1.0.0', author: 'davoda1'}));
  const icon = path.join(source, 'build', 'icons', '256x256.png');
  if (options.directoryIcon) await fs.mkdir(icon);
  else if (!options.missingIcon) await fs.copyFile(path.join(__dirname, '..', 'build', 'icons', '256x256.png'), icon);
  if (options.legacyFile) {
    await fs.mkdir(path.join(source, 'nested'), {recursive: true});
    await fs.writeFile(path.join(source, 'nested', 'deploy.cjs'), '// Forbidden legacy fixture\n');
  }
  // ASAR 3.4.1 resolves with its writable after end(), before queued bytes
  // necessarily reach disk. Verification must start after the stream closes.
  const output = await asar.createPackage(source, path.join(directory, 'resources', 'app.asar'));
  await finished(output);
  return directory;
}

test('package verification reads nested ASAR icons on every host platform', async t => {
  const directory = await fixture(t);
  assert.equal(verify(directory, 'win').version, '1.0.0');
});

for (const [name, options, pattern] of [
  ['missing icon', {missingIcon: true}, /Required packaged file is missing: build\/icons\/256x256\.png/],
  ['missing manifest', {missingManifest: true}, /Required packaged file is missing: package\.json/],
  ['directory in place of icon', {directoryIcon: true}, /must be a regular archived file/],
  ['nested legacy deployment file', {legacyFile: true}, /Private or legacy deployment files were packaged/],
]) test('package verification rejects ' + name + ' with a failing exit status', async t => {
  const directory = await fixture(t, options);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'verify-package.cjs'), '--platform', 'win', '--dir', directory], {encoding: 'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
});
