'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const fixture = {
  status: 'REVIEW', statusLabel: 'Review needed', ruleVersion: '1.1.0',
  counts: { conversations: 2, errors: 0, warnings: 1, info: 0, total: 1, messages: 4, userMessages: 2 },
  checks: [{ name: 'User content preservation', status: 'PASS', detail: 'Both user messages matched.' }, { name: 'Schema', status: 'REVIEW', detail: 'An unfamiliar field needs review.' }],
  coverage: { hasOriginal: true, hasJson: true, hasHtml: true, complete: true },
  profile: 'All writing blocks', profileCandidates: [{name:'All writing blocks',mismatchedConversations:0},{name:'Mismatching profile',mismatchedConversations:2}], files: [{ name: 'synthetic.json', role: 'original', bytes: 512, records: 2, sha256: 'a'.repeat(64) }],
  findings: [{ id: '00001', severity: 'warning', rule: 'SCHEMA', message: 'An unfamiliar field was found.', title: 'Synthetic conversation', file: 'synthetic.json', pointer: '/mapping/node/message/content/extra' }],
  schema: { baseline: 'known-schema', inventory: { extra: { types: { string: 1 }, count: 1 } }, changes: [{ kind: 'new', key: 'extra', types: ['string'], count: 1 }] }, limitations: ['Synthetic test fixture.'],
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 680, height: 540 }, colorScheme: 'dark' });
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) network.push(request.url()); });
    await page.addInitScript(report => {
      let listener, run, selection = {}, preferences = { theme: 'system', density: 'comfortable' };
      window.uiTest = { ready: false, starts: [], exports: [], revealed: false };
      window.processor = {
        async getState() { return { version: '1.0.0', preferences, selection, result: null }; },
        async ready() { window.uiTest.ready = true; },
        onEvent(callback) { listener = callback; return () => { listener = null; }; },
        async chooseInput(role) { const names = { original: 'synthetic-chatgpt-export.zip', indexJson: 'conversations-index.json', indexHtml: 'chat-index.html', bundle: 'processed.zip' }; return selection[role] = { name: names[role], token: role }; },
        async chooseOutput() { return selection.outputDir = { name: 'Outputs', token: 'output' }; },
        async clearInput(role) { delete selection[role]; return { ...selection }; },
        async setPreferences(value) { preferences = value; return preferences; },
        async start(spec) { window.uiTest.starts.push(spec); listener({ type: 'progress', value: { phase: 'Reading records', ratio: 0.5 } }); run = setTimeout(() => listener({ type: 'complete', value: report, outputAvailable: spec.mode === 'convert' }), 350); return { started: true }; },
        async cancel() { clearTimeout(run); listener({ type: 'cancelled' }); },
        async evidence() { return { source: '<img src="missing" onerror="window.evidenceExecuted=true">', expected: 'Expected text', actual: 'Actual text' }; },
        async exportReport(options) { window.uiTest.exports.push(options); return { saved: true }; },
        async revealOutput() { window.uiTest.revealed = true; return { opened: true }; },
      };
    }, fixture);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.waitForFunction(() => window.uiTest.ready);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('#run').isDisabled(), true);
    await page.locator('#chooseOriginal').click();
    assert.equal(await page.locator('#run').isDisabled(), true);
    await page.locator('#chooseOutput').click();
    assert.equal(await page.locator('#run').isDisabled(), false);
    await page.locator('#run').click(); await page.locator('#cancelRun').click();
    assert.equal(await page.locator('#run').isEnabled(), true);
    await page.locator('#run').click(); await page.waitForSelector('#view-overview.active');
    assert.match(await page.locator('#overviewContent').textContent(), /Review needed/);
    assert.doesNotMatch(await page.locator('#overviewContent').textContent(), /Mismatching profile/);
    assert.match(await page.locator('#overviewContent').textContent(), /Selected profile/);
    await page.getByRole('button', {name:'Open output folder'}).click();
    assert.equal(await page.evaluate(() => window.uiTest.revealed), true);
    await page.locator('[data-page="findings"]').click();
    await page.waitForFunction(() => document.querySelector('.evidence')?.textContent.includes('Actual text'));
    await page.locator('[data-tab="source"]').click();
    assert.match(await page.locator('.evidence pre').textContent(), /<img/);
    assert.equal(await page.locator('.evidence img').count(), 0);
    assert.equal(await page.evaluate(() => window.evidenceExecuted), undefined);
    await page.locator('#findingSearch').fill('does not match');
    assert.match(await page.locator('#findingListCount').textContent(), /0 findings/);
    await page.locator('#findingSearch').fill('');
    await page.locator('[data-page="schema"]').click();
    assert.equal(await page.locator('#schemaRows tr').count(), 1);
    await page.locator('[data-page="reports"]').click(); await page.locator('[data-export="summary"]').click();
    assert.equal(await page.locator('#includeEvidence').count(), 0);
    await page.locator('#reportFormat').selectOption('json'); await page.locator('#saveReport').click();
    assert.deepEqual(await page.evaluate(() => window.uiTest.exports), [{ format: 'json', includeEvidence: false }]);
    await page.locator('[data-page="settings"]').click(); await page.locator('[data-theme-choice="light"]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('[data-theme-choice="dark"]').click();
    await page.locator('[data-page="workspace"]').click();
    await page.locator('#modeInspect').click();
    await page.locator('[data-choose="indexJson"]').click(); await page.locator('[data-choose="indexHtml"]').click();
    await page.locator('[data-clear="original"]').click();
    assert.match(await page.locator('#readiness').textContent(), /limited/);
    await page.locator('#inspectSource').selectOption('bundle');
    assert.equal(await page.locator('#run').isDisabled(), true);
    await page.locator('[data-choose="bundle"]').click();
    assert.equal(await page.locator('#run').isEnabled(), true);
    await page.locator('#run').click(); await page.waitForSelector('#view-overview.active');
    assert.equal(await page.evaluate(() => window.uiTest.starts.at(-1).inspectionSource), 'bundle');
    assert.equal(await page.evaluate(() => window.uiTest.starts.at(-1).mode), 'inspect');
    assert.equal(await page.getByRole('button', {name:'Open output folder'}).count(), 0);
    await page.locator('[data-page="workspace"]').click();
    const measurements = [];
    for (const [width,height] of [[680,540],[900,540],[1024,600],[1280,720],[1440,900],[1920,1080]]) {
      await page.setViewportSize({width,height});
      for (const mode of ['convert','inspect']) {
        await page.locator(mode === 'convert' ? '#modeConvert' : '#modeInspect').click();
        if (mode === 'inspect') await page.locator('#inspectSource').selectOption('files');
        const fit = await page.evaluate(() => { const content = document.querySelector('.workspace-content'), box = content.getBoundingClientRect(); return { globalX:document.documentElement.scrollWidth-innerWidth, globalY:document.documentElement.scrollHeight-innerHeight, workspaceX:content.scrollWidth-content.clientWidth, workspaceY:content.scrollHeight-content.clientHeight, clipped:[...content.querySelectorAll('button,input,select')].filter(x=>{const r=x.getBoundingClientRect();return r.height>0&&(r.right>box.right+1||r.bottom>box.bottom+1||r.left<box.left-1);}).map(x=>x.id||x.getAttribute('aria-label')||x.textContent) }; });
        measurements.push({width,height,mode,...fit});
        if (process.env.UI_SCREENSHOT_DIR && (width === 680 || width === 1280)) { fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, {recursive:true}); await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'workspace-' + width + '-' + mode + '.png')}); }
        assert.equal(fit.globalX,0); assert.equal(fit.globalY,0); assert.equal(fit.workspaceX,0); assert.equal(fit.workspaceY,0); assert.deepEqual(fit.clipped,[]);
      }
    }
    await page.setViewportSize({width:680,height:540});
    for (const view of ['overview','findings','schema','reports','settings']) {
      await page.locator('[data-page="'+view+'"]').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight),false);
    }
    await page.locator('#help').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#modalBackdrop').isHidden(),true);
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    console.log(JSON.stringify({ passed: true, workflows: ['convert','inspect','cancel','findings','inert evidence','schema','report export','themes','optional inputs','keyboard modal'], measurements }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
