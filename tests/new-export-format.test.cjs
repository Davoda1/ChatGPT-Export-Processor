'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const { processExport } = require('../src/core/pipeline.cjs');
const { resolveInputs } = require('../src/core/inputs.cjs');
const { readRecords } = require('../src/core/reader.cjs');
const { conversation, marker, workspace } = require('./helpers/conversion.cjs');

const modernIndex = '<!doctype html><title>Export index</title><script>throw new Error("DO_NOT_EXECUTE_EXPORT_INDEX")</script><main>Modern export landing page</main>';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assetKey = (ordinal, node) => JSON.stringify([ordinal, node]);
const collect = async file => {
  const values = [];
  for await (const record of readRecords(file)) values.push(record.value);
  return values;
};
const assetsIn = async file => {
  const html = await fs.readFile(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const assetScript = scripts.find(([, attributes]) => /\bid=["']archive-assets["']/i.test(attributes));
  assert.ok(assetScript, 'generated HTML includes an explicit attachment map');
  assert.match(assetScript[1], /\btype=["']application\/json["']/i);
  return JSON.parse(assetScript[2]);
};

// Independent ZIP reader checks final archive contents, including nested assets.
async function bundleFiles(file) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = new Map();
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(files));
    zip.on('entry', entry => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); zip.close(); return; }
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}

test('modern stored and deflated exports recreate raw HTML and retain converted JSON/HTML agreement', async t => {
  for (const deflate of [false, true]) {
    const raw = [conversation('synthetic-modern', marker('url', 'Synthetic source\ue202https://example.com/source'))];
    const w = await workspace(t, [['index.html', modernIndex], ['conversations-000.json', JSON.stringify(raw)]], { deflate });
    const inputHash = hash(await fs.readFile(w.input));
    const result = await processExport({ input: w.input, outputDir: w.root });
    assert.equal(result.conversations, raw.length);
    assert.deepEqual(await collect(result.paths.original), raw);
    assert.deepEqual(await collect(result.paths.originalHtml), raw);
    const converted = await collect(result.paths.indexJson);
    assert.deepEqual(await collect(result.paths.indexHtml), converted);
    assert.notDeepEqual(converted, raw, 'the raw HTML must not be built from already-converted JSON');
    for (const htmlPath of [result.paths.originalHtml, result.paths.indexHtml]) {
      const html = await fs.readFile(htmlPath, 'utf8');
      assert.doesNotMatch(html, /DO_NOT_EXECUTE_EXPORT_INDEX|Modern export landing page/);
      assert.match(html, /Content-Security-Policy/);
      assert.match(html, /connect-src 'none'/);
      assert.match(html, /img-src 'none'/);
    }
    assert.equal(hash(await fs.readFile(w.input)), inputHash);
    assert.ok(!(await fs.readdir(result.outputDir)).includes('.work'));
  }
});

test('nested case-insensitive markers select sibling source data without unrelated exports', async t => {
  const raw = [conversation('synthetic-selected')];
  const w = await workspace(t, [
    ['selected/INDEX.HTML', modernIndex],
    ['selected/CONVERSATIONS.JSON', JSON.stringify(raw)],
    ['unrelated/conversations.json', JSON.stringify([conversation('synthetic-unrelated')])],
    ['unrelated/docs/index.html', '<p>Documentation index</p>']
  ]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual(await collect(result.paths.original), raw);
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
  const resolved = await resolveInputs({ original: w.input, indexJson: result.paths.indexJson });
  t.after(() => resolved.cleanup());
  assert.equal(resolved.byRole.original.length, 1);
  assert.deepEqual(await collect(resolved.byRole.original[0].file), raw);
  assert.ok(!resolved.byRole.originalHtml, 'the modern application index is not an original conversation viewer');
});

test('modern split exports merge in numeric order and ignore chunks outside the selected root', async t => {
  const raw = Array.from({ length: 11 }, (_, i) => conversation('synthetic-chunk-' + i));
  const entries = [['selected/index.html', modernIndex], ...raw.map((value, i) => ['selected/conversations-' + i + '.json', JSON.stringify([value])]).reverse(), ['other/conversations-11.json', JSON.stringify([conversation('synthetic-unrelated')])]];
  const w = await workspace(t, entries);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual(await collect(result.paths.original), raw);
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
  const resolved = await resolveInputs({ original: w.input, indexJson: result.paths.indexJson });
  t.after(() => resolved.cleanup());
  assert.equal(resolved.byRole.original.length, raw.length);
  assert.ok(resolved.byRole.original.every(item => item.entry.startsWith('selected/')));
});

test('JSON-only archives remain supported and now receive a reconstructed raw viewer', async t => {
  const raw = [conversation('synthetic-json-only')];
  const w = await workspace(t, [['conversations.json', JSON.stringify(raw)]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
});

test('legacy source HTML is preserved byte for byte when both export markers exist', async t => {
  const raw = [conversation('synthetic-legacy')];
  const source = Buffer.from('\ufeff<!doctype html>\r\n<title>Original export</title><script>var jsonData = ' + JSON.stringify(raw) + ';</script>\r\n<!-- preserved bytes -->\r\n');
  const w = await workspace(t, [['chat.html', source], ['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual(await fs.readFile(result.paths.originalHtml), source);
  assert.deepEqual(await collect(result.paths.original), raw);
  assert.deepEqual(await collect(result.paths.indexJson), await collect(result.paths.indexHtml));
});

test('raw HTML reconstruction safely embeds script-ending strings and Unicode without changing data', async t => {
  const dangerous = '</ScRiPt><script>globalThis.syntheticInjected=true</script><!-- & > \u2028 \u2029 😀 日本語';
  const raw = [conversation('synthetic-script-safety', dangerous, dangerous)];
  raw[0].title = dangerous;
  const w = await workspace(t, [['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)]]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
  const html = await fs.readFile(result.paths.originalHtml, 'utf8');
  assert.doesNotMatch(html, /<\/ScRiPt><script>globalThis\.syntheticInjected/);
  assert.match(html, /\\u003c\/ScRiPt/);
});

test('matched attachments use portable local names, appear in both viewers, and retain bundled bytes and hashes', async t => {
  const raw = [conversation('synthetic-assets')];
  raw[0].mapping.user.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-synthetic' });
  raw[0].mapping.assistant.message.metadata.attachments = [{ id: 'file-attachment' }, { id: 'file-missing' }, { id: 'CON' }];
  const reference = 'sediment://file-audio#part';
  raw[0].mapping.assistant.message.content.parts.push({ content_type: 'audio', asset_pointer: reference });
  const audioName = 'sediment_file-audio_part-' + hash(reference).slice(0, 12) + '.dat';
  const media = new Map([
    ['images/file-synthetic.dat', Buffer.from([0, 255, 100, 0, 17])],
    ['files/file-attachment.dat', Buffer.from('Synthetic attachment bytes')],
    ['CON/audio #?/日本語/' + audioName, Buffer.from('Synthetic audio bytes')],
    ['NUL/CON.dat', Buffer.from('Synthetic reserved filename bytes')]
  ]);
  const w = await workspace(t, [
    ['selected/index.html', modernIndex], ['selected/conversations.json', JSON.stringify(raw)],
    ...[...media].map(([name, bytes]) => ['selected/' + name, bytes]),
    ['selected/unmatched.dat', 'Not referenced'],
    ['selected/file-attachment.txt', 'Wrong extension'],
    ['other/file-missing.dat', 'Outside selected export']
  ], { deflate: true });
  const result = await processExport({ input: w.input, outputDir: w.root });
  const assets = await assetsIn(result.paths.originalHtml);
  assert.deepEqual(await assetsIn(result.paths.indexHtml), assets);
  assert.deepEqual(Object.keys(assets).sort(), [assetKey(0, 'assistant'), assetKey(0, 'user')]);
  assert.equal(assets[assetKey(0, 'user')].length, 1);
  assert.equal(assets[assetKey(0, 'assistant')].length, 3);
  assert.match(assets[assetKey(0, 'user')][0], /-file-synthetic\.dat$/);
  const links = Object.values(assets).flat();
  assert.equal(new Set(links).size, media.size);
  for (const href of links) assert.match(href, /^assets\/[a-f0-9]{16,64}-[A-Za-z0-9_.-]+\.dat$/, 'portable filename independent of source directory syntax');
  const bundled = await bundleFiles(result.paths.bundle);
  for (const [name, bytes] of media) {
    const href = links.find(link => link.endsWith('-' + path.posix.basename(name)));
    assert.ok(href, name + ' has a mapped download link');
    assert.deepEqual(await fs.readFile(path.join(result.outputDir, href)), bytes);
    assert.deepEqual(bundled.get(href), bytes);
  }
  assert.equal([...bundled.keys()].filter(name => name.startsWith('assets/')).length, media.size);
  const manifest = (await fs.readFile(result.paths.checksums, 'utf8')).trim().split('\n');
  assert.equal(manifest.length, 4 + media.size);
  for (const line of manifest) {
    const [digest, name] = line.split('  ');
    assert.equal(digest, hash(await fs.readFile(path.join(result.outputDir, name))), name);
    assert.equal(digest, hash(bundled.get(name)), name + ' in ZIP');
  }
  assert.deepEqual(bundled.get('SHA256SUM.txt'), await fs.readFile(result.paths.checksums));
  assert.ok(![...bundled.keys()].some(name => name.endsWith('.sha256')));
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
});

test('missing attachments create no invented links and prototype-like mapping keys remain ordinary data', async t => {
  const raw = [conversation('synthetic-special-id')];
  raw[0].mapping.user.message.id = '__proto__';
  raw[0].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-safe' }, { asset_pointer: 'file-service://file-missing' });
  Object.defineProperty(raw[0].mapping, '__proto__', { value: raw[0].mapping.user, enumerable: true, configurable: true, writable: true });
  delete raw[0].mapping.user;
  raw[0].mapping.__proto__.id = '__proto__';
  raw[0].mapping.root.children = ['__proto__'];
  raw[0].mapping.assistant.parent = '__proto__';
  const w = await workspace(t, [['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)], ['files/file-safe.dat', 'Synthetic asset']]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  const assets = await assetsIn(result.paths.originalHtml);
  const key = assetKey(0, '__proto__');
  assert.equal(Object.hasOwn(assets, key), true);
  assert.equal(assets[key].length, 1);
  assert.match(assets[key][0], /^assets\/[a-f0-9]{16,64}-file-safe\.dat$/);
  assert.doesNotMatch(JSON.stringify(assets), /file-missing/);
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
});

test('matched attachment basenames from different folders cannot overwrite one another', async t => {
  const raw = [conversation('synthetic-asset-collision')];
  raw[0].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-duplicate' });
  const w = await workspace(t, [
    ['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)],
    ['first/file-duplicate.dat', 'First synthetic asset'],
    ['second/file-duplicate.dat', 'Second synthetic asset']
  ]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  const assets = await assetsIn(result.paths.originalHtml);
  const links = assets[assetKey(0, 'user')];
  assert.equal(links.length, 2);
  assert.notEqual(links[0], links[1]);
  const bytes = await Promise.all(links.map(href => fs.readFile(path.join(result.outputDir, href), 'utf8')));
  assert.deepEqual(bytes.sort(), ['First synthetic asset', 'Second synthetic asset']);
  const bundled = await bundleFiles(result.paths.bundle);
  assert.deepEqual(links.map(href => bundled.get(href).toString()).sort(), bytes.sort());
});

test('repeated message IDs never share attachments across conversations or mapping nodes', async t => {
  const raw = Array.from({ length: 3 }, (_, i) => conversation('synthetic-duplicate-message-' + i));
  for (const record of raw) {
    record.mapping.user.message.id = 'synthetic-repeated-message';
    record.mapping.assistant.message.id = 'synthetic-repeated-message';
  }
  raw[0].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-first' });
  raw[0].mapping.assistant.message.content.parts.push({ asset_pointer: 'file-service://file-assistant' });
  raw[1].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-second' });
  const w = await workspace(t, [
    ['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)],
    ['files/file-first.dat', 'First conversation user attachment'],
    ['files/file-assistant.dat', 'First conversation assistant attachment'],
    ['files/file-second.dat', 'Second conversation user attachment']
  ]);
  const result = await processExport({ input: w.input, outputDir: w.root });
  const assets = await assetsIn(result.paths.originalHtml);
  assert.deepEqual(await assetsIn(result.paths.indexHtml), assets);
  assert.deepEqual(Object.keys(assets).sort(), [assetKey(0, 'assistant'), assetKey(0, 'user'), assetKey(1, 'user')]);
  const expected = [
    [assetKey(0, 'user'), 'file-first.dat', 'First conversation user attachment'],
    [assetKey(0, 'assistant'), 'file-assistant.dat', 'First conversation assistant attachment'],
    [assetKey(1, 'user'), 'file-second.dat', 'Second conversation user attachment']
  ];
  for (const [key, basename, bytes] of expected) {
    assert.equal(assets[key].length, 1);
    assert.ok(assets[key][0].endsWith('-' + basename));
    assert.equal(await fs.readFile(path.join(result.outputDir, assets[key][0]), 'utf8'), bytes);
  }
  for (const key of [assetKey(1, 'assistant'), assetKey(2, 'user'), assetKey(2, 'assistant')]) assert.equal(Object.hasOwn(assets, key), false);
  assert.deepEqual(await collect(result.paths.originalHtml), raw);
});

test('ambiguous source roots, incomplete chunks, and malformed modern exports leave no partial output', async t => {
  const row = JSON.stringify([conversation('synthetic-rejection')]);
  const cases = [
    [['a/index.html', modernIndex], ['a/conversations.json', row], ['b/index.html', modernIndex], ['b/conversations.json', row]],
    [['index.html', modernIndex], ['a/conversations-0.json', row], ['b/conversations-1.json', row]],
    [['index.html', modernIndex], ['conversations-0.json', row], ['conversations-2.json', row]],
    [['index.html', modernIndex], ['conversations-01.json', row], ['conversations-1.json', row]],
    [['index.html', modernIndex], ['conversations-9007199254740992.json', row]],
    [['index.html', modernIndex], ['conversations.json', row], ['conversations-0.json', row]],
    [['index.html', modernIndex]],
    [['index.html', modernIndex], ['conversations.json', 'not JSON']],
    [['index.html', modernIndex], ['conversations.json', '[null]']]
  ];
  for (const entries of cases) {
    const w = await workspace(t, entries);
    await assert.rejects(processExport({ input: w.input, outputDir: w.root }));
    assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
  }
});

test('CRC failure in a matched attachment removes the unfinished output folder', async t => {
  const raw = [conversation('synthetic-asset-crc')];
  raw[0].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-broken' });
  const w = await workspace(t, [['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)], ['files/file-broken.dat', 'Synthetic asset bytes']]);
  const zip = await fs.readFile(w.input);
  let offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  let corrupted = false;
  while (offset >= 0 && zip.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === 'files/file-broken.dat') {
      zip.writeUInt32LE((zip.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16);
      corrupted = true;
      break;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(corrupted, true);
  await fs.writeFile(w.input, zip);
  await assert.rejects(processExport({ input: w.input, outputDir: w.root }), /CRC/);
  assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
});

test('cancellation while copying attachments cleans only the current unfinished output', async t => {
  const raw = [conversation('synthetic-asset-cancel')];
  raw[0].mapping.user.message.content.parts.push({ asset_pointer: 'file-service://file-cancel' });
  const w = await workspace(t, [['index.html', modernIndex], ['conversations.json', JSON.stringify(raw)], ['files/file-cancel.dat', 'Synthetic asset bytes']]);
  const keep = path.join(w.root, 'keep.txt');
  await fs.writeFile(keep, 'Existing user file');
  const controller = new AbortController();
  let copyingStarted = false;
  await assert.rejects(processExport({ input: w.input, outputDir: w.root }, {
    signal: controller.signal,
    progress: event => {
      if (event.phase === 'Copying exported attachments') {
        copyingStarted = true;
        controller.abort();
      }
    }
  }), { name: 'AbortError' });
  assert.equal(copyingStarted, true);
  assert.equal(await fs.readFile(keep, 'utf8'), 'Existing user file');
  assert.deepEqual((await fs.readdir(w.root)).sort(), ['export.zip', 'keep.txt']);
});
