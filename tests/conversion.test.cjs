'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const converter = require('../src/core/converter.cjs');
const reference = require('../src/vendor/reference-1.1.0.cjs');
const { marker, conversation } = require('./helpers/conversion.cjs');

function converted(text, { role = 'assistant', references = [], widgets = {}, options = { allWritingBlocks: true } } = {}) {
  const c = conversation('synthetic-1', text);
  const message = c.mapping.assistant.message;
  message.author.role = role;
  message.metadata = { content_references: references, view_state: { widgets } };
  converter.transformObj(c, converter.enabledSet(options));
  return c.mapping.assistant.message;
}

test('user text, multimodal data, Unicode and private-use marker literals remain unchanged', () => {
  const c = conversation('synthetic-1', 'Assistant', marker('genui', { citation: { ref: 'turn0view0' } }) + '\n😀 Árvíztűrő 日本語');
  c.mapping.user.message.content.parts.push({ content_type: 'image_asset_pointer', asset_pointer: 'synthetic-image', width: 1024 });
  const original = structuredClone(c);
  converter.transformObj(c, converter.enabledSet({ allWritingBlocks: true }));
  assert.deepEqual(c.mapping.user.message.content, original.mapping.user.message.content);
  assert.deepEqual(converter.checkUserContentUnchanged(original, c), [1, null]);
  assert.equal(c.current_node, original.current_node);
});

test('email blocks always convert and nested fences stay balanced', () => {
  const text = ':::writing{variant="email" subject="Synthetic subject"}\nBody\n```js\nlet x = 1;\n```\n:::';
  const actual = converted(text, { options: {} }).content.parts[0];
  assert.match(actual, /\*\*SUBJECT\*\*: Synthetic subject/);
  assert.match(actual, /````markdown/);
  assert.match(actual, /```js\nlet x = 1;\n```/);
});

test('optional writing-block switches are independent', () => {
  for (const [variant, key] of [['standard', 'standard'], ['document', 'document'], ['chat_message', 'chatMessage']]) {
    const text = `:::writing{variant="${variant}" title="Synthetic title"}\nSynthetic body\n:::`;
    assert.equal(converted(text, { options: {} }).content.parts[0], text);
    assert.notEqual(converted(text, { options: { [key]: true } }).content.parts[0], text);
  }
});

test('escaped writing-block title attributes are decoded without executing text', () => {
  assert.deepEqual(converter.writingAttrs('variant="document" title="One\\nTwo\\u0021"'), { variant: 'document', title: 'One\nTwo!' });
  const text = ':::writing{variant="document" title="Synthetic"}\n<script>globalThis.UNSAFE=1</script>\n:::';
  assert.match(converted(text).content.parts[0], /<script>/);
  assert.equal(globalThis.UNSAFE, undefined);
});

test('message-scoped grouped citations retain recorded URLs including queries and fragments', () => {
  const text = marker('genui', { citation: { refs: ['turn0view0', 'turn0view0'] } });
  const references = [{ type: 'grouped_webpages', prefix: 'genui', items: [{ refs: [{ turn_index: 0, ref_type: 'view', ref_index: 0 }], url: 'https://example.invalid/source?q=1#part', title: 'Synthetic source' }] }];
  assert.equal(converted(text, { references }).content.parts[0], '[Synthetic source](https://example.invalid/source?q=1#part)');
});

test('unrecorded citation alternate destinations are rejected', () => {
  const references = [{ type: 'grouped_webpages', prefix: 'genui', items: [{ refs: [{ turn_index: 0, ref_type: 'view', ref_index: 0 }], url: 'https://example.invalid/recorded', title: 'Recorded' }], alt: '[Injected](https://other.invalid/)' }];
  assert.equal(converted(marker('genui', { citation: { ref: 'turn0view0' } }), { references }).content.parts[0], '[Recorded](https://example.invalid/recorded)');
});

test('links reject executable, local-file and malformed schemes', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///example', 'https://', 'https://example.invalid/\ninvalid']) {
    assert.equal(converter.transformText(marker('url', 'Readable\ue202' + url)), 'Readable');
  }
  assert.equal(converter.transformText(marker('url', 'A [B]\ue202https://example.invalid/a(b)?x=1')), '[A \\[B\\]](https://example.invalid/a%28b%29?x=1)');
});

test('chart series preserve zero, fractions, negatives and missing values', () => {
  const content = { meta: { title: 'Synthetic chart' }, xKey: 'category', series: [{ dataKey: 'a', label: 'A', valueSuffix: '%' }, { dataKey: 'b', label: 'B' }], data: [{ category: 'One', a: 0, b: -1.25 }, { category: 'Two', a: 2.5 }] };
  for (const key of ['chart', 'charts_widget_v2']) {
    const value = converter.transformText(marker('genui', { [key]: { content } }));
    assert.match(value, /One \| 0% \| -1\.25/);
    assert.match(value, /Two \| 2\.5% \|  \|/);
  }
});

test('product metadata preserves literal zero price and safe recorded destination', () => {
  const value = converted(marker('product', ['turn0product0', 'Synthetic item', { description: 'Description' }]), {
    references: [{ type: 'products', products: [{ cite: 'turn0product0', title: 'Synthetic item', price: 0, currency: 'EUR', merchants: 'Synthetic shop', url: 'https://example.invalid/item' }] }]
  }).content.parts[0];
  assert.match(value, /0 EUR/);
  assert.match(value, /https:\/\/example.invalid\/item/);
});

test('automation and visualization markers become static notices', () => {
  assert.equal(converter.transformText(marker('genui', { suggest_automation: { label: 'Synthetic reminder' } })), 'Suggested reminder: Synthetic reminder');
  assert.equal(converter.transformText(marker('visualize', { path: 'synthetic-preview.html' })), '[Interactive visualization not included in this export.]');
});

test('malformed marker input is bounded, preserves adjacent prose and is idempotent', () => {
  for (const text of ['Before \ue200genui\ue202{broken after', marker('genui', { chart: null }), 'Before ' + marker('entity', ['turn0view0', 'Name']) + ' after']) {
    const output = converter.transformText(text);
    assert.equal(converter.transformText(output), output);
    if (text.startsWith('Before')) assert.ok(output.startsWith('Before'));
  }
});

test('HTML JSON serialization neutralizes script endings, ampersands and line separators', () => {
  const original = { value: '</script><script>globalThis.UNSAFE=1</script>&\u2028\u2029' };
  const output = converter.htmlSafeJson(original);
  assert.ok(!output.includes('<'));
  assert.ok(!output.includes('&'));
  assert.ok(!output.includes('\u2028'));
  assert.deepEqual(JSON.parse(output), original);
});

test('all eight writing profiles match the independently preserved 1.1.0 rules', () => {
  const text = ['email', 'standard', 'document', 'chat_message'].map(variant => `:::writing{variant="${variant}" title="Title" subject="Subject"}\nSynthetic text\n:::`).join('\n\n') + '\n' + marker('genui', { suggest_automation: { label: 'Static reminder' } });
  for (let bits = 0; bits < 8; bits++) {
    const original = conversation('synthetic-1', text), actual = structuredClone(original), expected = structuredClone(original);
    const enabled = converter.enabledSet({ standard: !!(bits & 1), document: !!(bits & 2), chatMessage: !!(bits & 4) });
    converter.transformObj(actual, enabled);
    reference.transformObj(expected, enabled);
    assert.deepEqual(actual, expected);
  }
});
