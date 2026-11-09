'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {audit} = require('../src/core/audit.cjs');
const {getShell} = require('../src/viewer/shell.cjs');
const {htmlSafeJson} = require('../src/core/converter.cjs');
const {processExport} = require('../src/core/pipeline.cjs');
const {conversation,workspace} = require('./helpers/conversion.cjs');

test('independent inspection recognizes generated attachment metadata without weakening viewer shell checks', async t => {
  const raw = [conversation('synthetic-audit-asset')];
  raw[0].mapping.user.message.content.parts.push({asset_pointer:'file-service://file-audit'});
  const w = await workspace(t,[['index.html','<script>throw new Error("unused")</script>'],['conversations.json',JSON.stringify(raw)],['files/file-audit.dat','Synthetic bytes']]);
  const output = await processExport({input:w.input,outputDir:w.root});
  const result = await audit({original:w.input,indexJson:output.paths.indexJson,indexHtml:output.paths.indexHtml});
  assert.equal(result.report.checks.find(check => check.name === 'HTML shell').status,'PASS');
  assert.equal(result.report.checks.find(check => check.name === 'JSON / HTML agreement').status,'PASS');
});

test('attachment shell normalization rejects injected markup, duplicate keys, and unsafe links', async t => {
  const raw = [conversation('synthetic-hostile-assets')];
  const w = await workspace(t,[['conversations.json',JSON.stringify(raw)]]);
  const source = path.join(w.root,'source.json');
  await fs.writeFile(source,JSON.stringify(raw));
  const base = getShell();
  const blocks = [
    JSON.stringify({'</ScRiPt><h1>Injected</h1><script type="application/json">':['assets/safe.dat']}),
    '{"same":["assets/a.dat"],"same":["assets/b.dat"]}',
    JSON.stringify({unsafe:['https://example.invalid/remote.dat']}),
    JSON.stringify({unsafe:['assets/%2e%2e/escape.dat']}),
    JSON.stringify({unsafe:['assets/nested%2fescape.dat']}),
    JSON.stringify({unsafe:['assets/%00bad.dat']})
  ];
  for (let index=0;index<blocks.length;index++) {
    const html = path.join(w.root,`hostile-${index}.html`);
    const suffix = ';</script>\n<script type="application/json" id="archive-assets">'+blocks[index]+'</script>\n'+base.suffix.slice(';</script>\n'.length);
    await fs.writeFile(html,base.prefix+htmlSafeJson(raw)+suffix);
    const result = await audit({original:source,indexJson:source,indexHtml:html});
    assert.equal(result.report.checks.find(check => check.name==='HTML shell').status,'REVIEW');
  }
  const safeAssets = {[JSON.stringify([0,'node</ScRiPt>\u2028日本語'])]:['assets/safe.dat']};
  const safe = getShell({assets:safeAssets});
  const html = path.join(w.root,'safe.html');
  await fs.writeFile(html,safe.prefix+htmlSafeJson(raw)+safe.suffix);
  const result = await audit({original:source,indexJson:source,indexHtml:html});
  assert.equal(result.report.checks.find(check => check.name==='HTML shell').status,'PASS');
});
