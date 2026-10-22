'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {getShell} = require('../src/viewer/shell.cjs');
const {readRecords} = require('../src/core/reader.cjs');

test('viewer shell is deterministic and permits only hashed executable scripts', () => {
  const first = getShell(), second = getShell();
  assert.strictEqual(first, second);
  assert.ok(first.prefix.endsWith('var jsonData = '));
  assert.ok(first.suffix.startsWith(';</script>'));
  assert.match(first.prefix, /type="text\/plain" id="archive-data"/);
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(first.prefix)[1];
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /img-src 'none'/);
  const scripts = [...first.suffix.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  for (const body of scripts) {
    const hash = crypto.createHash('sha256').update(body).digest('base64');
    assert.ok(policy.includes(`'sha256-${hash}'`));
  }
  const css = /<style>([\s\S]*?)<\/style>/.exec(first.prefix)[1];
  assert.ok(policy.includes(`'sha256-${crypto.createHash('sha256').update(css).digest('base64')}'`));
  assert.doesNotMatch(first.prefix + first.suffix, /<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:/i);
});

test('inert viewer data preserves hostile text and matches strict reader shell hashes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-viewer-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const record = {id:'synthetic-viewer',title:'Synthetic </script> <img src=x>',current_node:'user',mapping:{user:{id:'user',parent:null,children:[],message:{author:{role:'user'},content:{content_type:'text',parts:['<script>doNotRun()</script>\u2028\u2029 & Unicode: árvíz']}}}}};
  const {prefix,suffix} = getShell();
  const json = JSON.stringify([record]).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const file = path.join(directory,'chat-index.html');
  await fs.writeFile(file, prefix + json + suffix);
  const meta = {}, records = [];
  for await (const entry of readRecords(file, meta)) records.push(entry.value);
  assert.deepEqual(records,[record]);
  const hash = body => crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(meta.prefixSha256,hash(prefix));
  assert.equal(meta.suffixSha256,hash(suffix));
  // A literal in a trusted vendor script may contain a closing-tag string;
  // exact shell hashes, rather than a text count, identify the real document.
  assert.ok(meta.htmlClosings >= 1);
});
