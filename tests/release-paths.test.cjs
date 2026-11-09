'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {withinCheckout} = require('../scripts/release-paths.cjs');

test('release paths accept contained files and new directories, and reject traversal and linked escapes', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-release-paths-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const root = path.join(temporary, 'checkout'), outside = path.join(temporary, 'checkout-other');
  await fs.mkdir(path.join(root, 'dist'), {recursive: true});
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'dist', 'artifact.zip'), 'Synthetic archive');
  await fs.writeFile(path.join(outside, 'private.txt'), 'Synthetic outside file');
  const realRoot = require('node:fs').realpathSync(root);
  assert.equal(withinCheckout(root, 'dist/artifact.zip'), path.join(realRoot, 'dist', 'artifact.zip'));
  assert.equal(withinCheckout(root, path.join(root, 'dist', 'artifact.zip')), path.join(realRoot, 'dist', 'artifact.zip'));
  assert.equal(withinCheckout(root, 'test-results/nested/new', {mustExist: false}), path.join(realRoot, 'test-results', 'nested', 'new'));
  for (const value of ['../checkout-other/private.txt', path.join(outside, 'private.txt'), 'dist/../../checkout-other/private.txt', '.']) {
    assert.throws(() => withinCheckout(root, value), /inside the checkout/);
  }
  await fs.symlink(outside, path.join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => withinCheckout(root, 'linked-outside/private.txt'), /links outside/);
  assert.throws(() => withinCheckout(root, 'linked-outside/new/destination', {mustExist: false}), /links outside/);
  assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'Synthetic outside file');
  assert.deepEqual(await fs.readdir(outside), ['private.txt']);
});

test('maintainer release CLIs reject outside paths before processing archive or publication inputs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-release-cli-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const root = path.resolve(__dirname, '..');
  const publish = spawnSync(process.execPath, [path.join(root, 'scripts', 'publish-release.cjs'), 'prepare', '--assets', directory], {encoding: 'utf8'});
  assert.equal(publish.status, 1);
  assert.match(publish.stderr, /inside the checkout/);
  const verify = spawnSync(process.execPath, [path.join(root, 'scripts', 'test-release.cjs'), '--archive', path.join(directory, 'archive.tar.gz'), '--reference', directory, '--destination', path.join(directory, 'new')], {encoding: 'utf8'});
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /inside the checkout/);
  assert.deepEqual(await fs.readdir(directory), []);
});
