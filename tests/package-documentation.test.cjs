'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {copyDocumentation, verifyDocumentation} = require('../scripts/package-documentation.cjs');

test('distribution documentation resolves nested links and rejects missing or escaping targets', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-docs-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true, maxRetries: 5}));
  const destination = path.join(temporary, 'distribution');
  const result = await copyDocumentation(path.resolve(__dirname, '..'), destination);
  assert.ok(result.localLinks > 0, 'The real README and gallery must exercise local link checks.');
  const gallery = path.join(destination, 'docs', 'extras', 'README.md');
  const original = await fs.readFile(gallery, 'utf8');
  await fs.appendFile(gallery, '\n[Unavailable guide](../../docs/missing-guide.md)\n');
  assert.throws(() => verifyDocumentation(destination), /missing local link target/);
  await fs.writeFile(path.join(temporary, 'outside.md'), 'Outside the distribution\n');
  await fs.writeFile(gallery, original + '\n[Outside guide](../../../outside.md)\n');
  assert.throws(() => verifyDocumentation(destination), /leaves its directory tree/);
});
