'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { processExport, writeStoredZip } = require('../src/core/pipeline.cjs');
const { readRecords } = require('../src/core/reader.cjs');
const { unpackZip } = require('../src/core/inputs.cjs');
const converter = require('../src/core/converter.cjs');
const { conversation, fixtureZip, workspace } = require('./helpers/conversion.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceHtml = values => '<!doctype html><html><script>var jsonData = ' + converter.htmlSafeJson(values) + ';</script></html>';
const collect = async file => { const rows = []; for await (const record of readRecords(file)) rows.push(record.value); return rows; };

test('stored and deflated ChatGPT exports produce matching JSON and HTML without changing the ZIP', async t => {
  for (const deflate of [false, true]) {
    const original = conversation('synthetic-main', ':::writing{variant="email" subject="Synthetic"}\nBody\n:::');
    const html = sourceHtml([original]);
    const w = await workspace(t, [['nested/conversations.json', JSON.stringify([original])], ['nested/chat.html', html]], { deflate });
    const before = await fs.readFile(w.input);
    const result = await processExport({ input: w.input, outputDir: w.root });
    assert.equal(result.conversations, 1);
    assert.equal(result.profile, 7);
    assert.equal(sha(await fs.readFile(w.input)), sha(before));
    assert.deepEqual(await collect(result.paths.original), [original]);
    assert.deepEqual(await collect(result.paths.indexJson), await collect(result.paths.indexHtml));
    assert.match((await collect(result.paths.indexJson))[0].mapping.assistant.message.content.parts[0], /SUBJECT/);
    assert.equal(await fs.readFile(result.paths.originalHtml, 'utf8'), html);
    assert.ok(!(await fs.readdir(result.outputDir)).includes('.work'));
    const sums = (await fs.readFile(result.paths.checksums, 'utf8')).trim().split('\n');
    assert.equal(sums.length, 4);
    for (const line of sums) { const [hash, name] = line.split('  '); assert.equal(hash, sha(await fs.readFile(path.join(result.outputDir, name)))); }
  }
});

test('numeric split-file order is preserved without deduplication or missing records', async t => {
  const a = conversation('synthetic-a'), b = conversation('synthetic-b');
  const w = await workspace(t, [['conversations-002.json', JSON.stringify([b])], ['conversations-001.json', JSON.stringify([a])]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual((await collect(result.paths.original)).map(item => item.id), ['synthetic-a', 'synthetic-b']);
  assert.equal(result.conversations, 2);
  assert.equal(result.htmlConversations, 2);
  assert.equal(result.paths.originalHtml, undefined);
});

test('source HTML is preserved but cannot cause the converted outputs to disagree', async t => {
  const json = conversation('synthetic-json'), html = sourceHtml([conversation('synthetic-other')]);
  const w = await workspace(t, [['conversations.json', JSON.stringify([json])], ['chat.html', html]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.equal(await fs.readFile(result.paths.originalHtml, 'utf8'), html);
  assert.deepEqual(await collect(result.paths.indexJson), await collect(result.paths.indexHtml));
  assert.equal((await collect(result.paths.indexHtml))[0].id, 'synthetic-json');
});

test('concurrent runs create exclusive folders and preserve existing files', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const existing = path.join(w.root, 'conversations-index.json');
  await fs.writeFile(existing, 'Existing user file');
  const results = await Promise.all([processExport({ input: w.input, outputDir: w.root }), processExport({ input: w.input, outputDir: w.root })]);
  assert.notEqual(results[0].outputDir, results[1].outputDir);
  assert.equal(await fs.readFile(existing, 'utf8'), 'Existing user file');
  for (const result of results) assert.equal(await fs.readFile(result.paths.indexJson, 'utf8'), await fs.readFile(results[0].paths.indexJson, 'utf8'));
});

test('writing profile options are applied and email cannot be disabled', async t => {
  const assistant = ':::writing{variant="standard"}\nStandard\n:::\n:::writing{variant="email" subject="Subject"}\nBody\n:::';
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation('synthetic-options', assistant)])]]);
  const result = await processExport({ input: w.input, outputDir: w.root, options: { standard: false, document: false, chatMessage: false } });
  assert.equal(result.profile, 0);
  const text = (await collect(result.paths.indexJson))[0].mapping.assistant.message.content.parts[0];
  assert.match(text, /:::writing\{variant="standard"\}/);
  assert.match(text, /\*\*SUBJECT\*\*/);
});

test('bundled data exactly matches loose outputs and includes only a consolidated checksum file', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])], ['chat.html', sourceHtml([conversation()])]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  const extracted = path.join(w.root, 'extracted'); await fs.mkdir(extracted);
  const entries = await unpackZip(result.paths.bundle, extracted);
  for (const entry of entries) assert.equal(sha(await fs.readFile(entry.file)), sha(await fs.readFile(path.join(result.outputDir, path.basename(entry.entry)))));
  const zip = await fs.readFile(result.paths.bundle);
  assert.ok(zip.includes(Buffer.from('SHA256SUM.txt')));
  assert.ok(!zip.includes(Buffer.from('.sha256')));
});

test('ZIP64 output round-trips through an independent ZIP reader', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const source = path.join(w.root, 'source.json'); await fs.writeFile(source, JSON.stringify([conversation()]));
  const zip = path.join(w.root, 'zip64.zip');
  await writeStoredZip([{ name: 'conversations.json', file: source }], zip, { forceZip64: true });
  const extracted = path.join(w.root, 'zip64-extracted'); await fs.mkdir(extracted);
  const entries = await unpackZip(zip, extracted);
  assert.equal(entries.length, 1);
  assert.deepEqual(await collect(entries[0].file), [conversation()]);
});

test('ambiguous or incomplete split exports fail without partial output folders', async t => {
  for (const names of [['conversations.json', 'conversations-001.json'], ['conversations-001.json', 'conversations-003.json'], ['conversations-002.json'], ['conversations-01.json', 'conversations-1.json']]) {
    const w = await workspace(t, names.map(name => [name, JSON.stringify([conversation()])]));
    await assert.rejects(processExport({ input: w.input, outputDir: w.root }), /both|chunk numbers/);
    assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
  }
});

test('malformed JSON, duplicate keys, invalid conversation shape and lossy numbers leave no outputs', async t => {
  const data = [
    '[{"mapping":{},"mapping":{}}]',
    '[{"mapping":{}} {"mapping":{}}]',
    '[{"unrelated":true}]',
    '[{"mapping":{},"number":9007199254740993}]',
    '[{"mapping":{},"number":-0}]'
  ];
  for (const json of data) {
    const w = await workspace(t, [['conversations.json', json]]);
    await assert.rejects(processExport({ input: w.input, outputDir: w.root }));
    assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
  }
});

test('malicious paths and CRC corruption fail without touching existing files', async t => {
  for (const [entries, options] of [
    [[['../conversations.json', JSON.stringify([conversation()])]], {}],
    [[['conversations.json', JSON.stringify([conversation()])]], { corruptCrc: true }]
  ]) {
    const w = await workspace(t, entries, options);
    await assert.rejects(processExport({ input: w.input, outputDir: w.root }));
    assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
  }
});

test('cancellation cleans up only its owned run folder', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const controller = new AbortController();
  await fs.writeFile(path.join(w.root, 'keep.txt'), 'Keep');
  await assert.rejects(processExport({ input: w.input, outputDir: w.root }, {
    signal: controller.signal, progress: event => { if (event.temporary) controller.abort(); }
  }), { name: 'AbortError' });
  assert.deepEqual((await fs.readdir(w.root)).sort(), ['export.zip', 'keep.txt']);
});

test('pre-cancelled jobs and invalid option types do not create a run folder', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(processExport({ input: w.input, outputDir: w.root }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(processExport({ input: w.input, outputDir: w.root, options: { standard: 'yes' } }), /true or false/);
  assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
});

test('large aggregate input is streamed across records with byte-equivalent user content', async t => {
  const sample = 'Synthetic preserved Unicode: 日本語 😀. '.repeat(4000);
  const values = Array.from({ length: 50 }, (_, i) => conversation(`synthetic-${i}`, 'Assistant', sample));
  const w = await workspace(t, [['conversations.json', JSON.stringify(values)]], { deflate: true });
  const result = await processExport({ input: w.input, outputDir: w.root });
  let count = 0;
  for await (const record of readRecords(result.paths.indexJson)) {
    assert.equal(record.value.mapping.user.message.content.parts[0], sample); count++;
  }
  assert.equal(count, values.length);
});
