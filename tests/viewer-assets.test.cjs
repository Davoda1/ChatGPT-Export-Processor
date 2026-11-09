'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {getShell} = require('../src/viewer/shell.cjs');
const {htmlSafeJson} = require('../src/core/converter.cjs');
const {readRecords} = require('../src/core/reader.cjs');

test('attachment map is inert and does not alter the preserved conversation array', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-assets-shell-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const raw = {id: 'synthetic', mapping: {}, title: 'Raw </script> title'};
  const assets = {
    [JSON.stringify([0, '__proto__'])]: ['assets/example.dat'],
    [JSON.stringify([1, 'hostile'])]: ['assets/</script><script>globalThis.compromised=true</script>.dat']
  };
  const base = getShell(), output = getShell({assets});
  assert.strictEqual(getShell({assets: {}}), base);
  assert.equal(output.prefix, base.prefix);
  assert.ok(output.suffix.startsWith(';</script>\n<script type="application/json" id="archive-assets">'));
  const block = /<script type="application\/json" id="archive-assets">([^<]*)<\/script>\n/.exec(output.suffix);
  assert(block);
  assert.deepEqual(JSON.parse(block[1]), assets);
  assert.equal(output.suffix.replace(block[0], ''), base.suffix);
  assert.doesNotMatch(block[1], /<\/script/i);
  const file = path.join(directory, 'chat.html');
  await fs.writeFile(file, output.prefix + htmlSafeJson([raw]) + output.suffix);
  const records = [];
  for await (const item of readRecords(file)) records.push(item.value);
  assert.deepEqual(records, [raw]);
  assert.throws(() => getShell({assets: ['assets/example.dat']}), /conversation-node-to-path map/);
});

test('viewer exposes only safe local attachment downloads and fetches none until clicked', {timeout: 60000}, async t => {
  const filename = 'Synthetic 日本語 #?.dat';
  const href = 'assets/' + encodeURIComponent(filename);
  const content = Buffer.from('Synthetic exported attachment bytes.');
  const nodeKey = '__proto__';
  const record = {id: 'synthetic-attachments', title: 'Synthetic attachments', current_node: nodeKey, mapping: {
    [nodeKey]: {id: nodeKey, parent: null, children: [], message: {id: 'shared-message-id', author: {role: 'user'}, content: {parts: ['Unchanged source text.']}}}
  }};
  // Message IDs can be reused across exported conversations. Attachment links
  // must remain bound to the original conversation ordinal and mapping key.
  const second = structuredClone(record);
  second.id = 'synthetic-second'; second.title = 'Second attachment';
  const secondHref = 'assets/second.dat', secondContent = Buffer.from('Second attachment bytes.');
  const assets = Object.create(null);
  assets[JSON.stringify([0, nodeKey])] = [href, href, 'https://example.invalid/remote.dat', '//example.invalid/remote.dat',
    'javascript:alert(1)', 'data:text/html,test.dat', 'assets/../escape.dat', 'assets/%2e%2e/escape.dat',
    'assets/nested%2fescape.dat', 'assets/nested%5cescape.dat', 'assets/file.dat?remote=1',
    'assets/file.dat#part', 'assets/%00bad.dat', 'assets/%7fbad.dat', 'assets/file.html', 'assets//file.dat'];
  assets[JSON.stringify([1, nodeKey])] = [secondHref];
  const {prefix, suffix} = getShell({assets});
  const html = prefix + htmlSafeJson([record, second]) + suffix;
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    if (request.url === '/') { response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); response.end(html); }
    else if (request.url === '/' + href) { response.writeHead(200, {'Content-Type': 'application/octet-stream'}); response.end(content); }
    else if (request.url === '/' + secondHref) { response.writeHead(200, {'Content-Type': 'application/octet-stream'}); response.end(secondContent); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: process.getuid?.() === 0 ? ['--no-sandbox'] : []});
  t.after(() => browser.close());
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 680, height: 540}});
  const remote = [], failures = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:')) remote.push(request.url()); });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelectorAll('.attachment-link').length === 1);
  const link = page.locator('.attachment-link');
  assert.equal(await link.getAttribute('href'), href);
  assert.equal(await link.getAttribute('download'), filename);
  assert.equal(await link.textContent(), 'Download attachment: ' + filename);
  assert.equal(await page.locator('img,iframe,audio,video,object,embed').count(), 0);
  assert.deepEqual(requested, ['/']);
  assert.deepEqual(remote, []);
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  // Chromium adjusts platform-reserved filename characters during download.
  assert.match(download.suggestedFilename(), /^Synthetic .*\.dat$/);
  assert.deepEqual(await fs.readFile(await download.path()), content);
  assert.deepEqual(requested, ['/', '/' + href]);
  await page.locator('#expand').click();
  assert.equal(await page.locator('.attachment-link').count(), 2);
  assert.equal(await page.locator('.conversation').nth(0).locator('.attachment-link').getAttribute('href'), href);
  const secondLink = page.locator('.conversation').nth(1).locator('.attachment-link');
  assert.equal(await secondLink.getAttribute('href'), secondHref);
  assert.deepEqual(requested, ['/', '/' + href]);
  const [secondDownload] = await Promise.all([page.waitForEvent('download'), secondLink.click()]);
  assert.deepEqual(await fs.readFile(await secondDownload.path()), secondContent);
  assert.deepEqual(requested, ['/', '/' + href, '/' + secondHref]);
  assert.deepEqual(remote, []);
  assert.deepEqual(failures, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth), false);
});
