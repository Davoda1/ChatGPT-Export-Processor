'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('publication scan rejects private artifacts and redacts credential values', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-privacy-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'examples'));
  await fs.mkdir(path.join(root, 'dist'));
  const scanner = path.join(root, 'scripts', 'privacy-check.cjs');
  await fs.copyFile(path.join(__dirname, '../scripts/privacy-check.cjs'), scanner);
  await fs.writeFile(path.join(root, 'README.md'), 'Synthetic project source.');
  await fs.writeFile(path.join(root, 'dist', 'build.zip'), Buffer.from([0, 1, 2]));
  const run = () => spawnSync(process.execPath, [scanner], {cwd: root, encoding: 'utf8'});
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /PASS:/);

  const names = [
    ...['zip', 'tar', 'tgz', 'gz', 'deb', 'exe'].map(extension => 'artifact.' + extension),
    'UPPERCASE.ZIP', 'conversations.json', 'conversations-01.json',
    'conversations-index.json', 'chat.html', 'chat-index.html', 'user.json',
    'message_feedback.json', 'shared_conversations.json', 'model_comparisons.json',
    'validation-report.json', 'validation-report.html', 'validation-report.csv', 'SHA256SUM.txt',
  ];
  for (const name of names) {
    const file = path.join(root, 'examples', name);
    // Filename policy must also reject opaque or binary content.
    await fs.writeFile(file, Buffer.from([0, 1, 2]));
    const result = run();
    assert.equal(result.status, 1, name);
    assert.ok(result.stderr.includes('examples/' + name + ':'), name);
    assert.ok(!result.stderr.includes(root), 'diagnostics must use relative paths');
    await fs.unlink(file);
  }

  const syntheticCredential = ['github', '_pat_', 'A'.repeat(24)].join('');
  await fs.writeFile(path.join(root, 'example.cjs'), 'const value = ' + JSON.stringify(syntheticCredential) + ';');
  const secret = run();
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /example\.cjs: credential/);
  assert.ok(!(secret.stdout + secret.stderr).includes(syntheticCredential), 'never print detected credential values');
});
