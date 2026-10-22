'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const {getShell} = require('../src/viewer/shell.cjs');

function fixture(index = 0) {
  const markdown = '# Synthetic heading\n\n**Bold text** and [reference](https://example.invalid/reference).\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```javascript\nconst answer = 42;\n```\n\n![Offline picture](https://example.invalid/image.png)\n\n<script>globalThis.viewerCompromised = true</script>\n\n[Unsafe](javascript:alert(1))\n\n</script><script>globalThis.viewerCompromised = true</script>';
  return {id:`synthetic-${index}`,title:`Synthetic conversation ${index}`,create_time:1700000000,current_node:'assistant',mapping:{user:{id:'user',parent:null,children:['assistant','alternate'],message:{author:{role:'user'},content:{content_type:'text',parts:['Keep this user text.']}}},assistant:{id:'assistant',parent:'user',children:[],message:{author:{role:'assistant'},content:{content_type:'text',parts:[markdown]}}},alternate:{id:'alternate',parent:'user',children:[],message:{author:{role:'assistant'},content:{content_type:'text',parts:['Alternate branch needle.']}}}}};
}

test('standalone viewer renders safely offline, paginates, searches and switches theme', {timeout: 60000}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'processor-viewer-browser-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const {prefix,suffix} = getShell();
  const records = Array.from({length:12},(_,index) => fixture(index));
  // A long conversation renders in bounded batches rather than creating the
  // entire archive DOM at once.
  let parent = 'assistant';
  for (let i = 0; i < 63; i++) {
    const id = `more-${i}`;
    records[0].mapping[parent].children.push(id);
    records[0].mapping[id] = {id,parent,children:[],message:{author:{role:'assistant'},content:{content_type:'text',parts:[`Synthetic additional message ${i}.`]}}};
    parent = id;
  }
  records[0].current_node = parent;
  const json = JSON.stringify(records).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  const file = path.join(directory,'chat-index.html');
  await fs.writeFile(file,prefix + json + suffix);
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,args:process.getuid?.() === 0 ? ['--no-sandbox'] : []});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:680,height:540},colorScheme:'dark'});
  const failures=[],requests=[];
  page.on('pageerror',error=>failures.push(error.message));
  page.on('request',request=>{if (/^https?:/.test(request.url())) requests.push(request.url());});
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 10);
  assert.equal(await page.locator('.markdown h1').first().textContent(),'Synthetic heading');
  assert.equal(await page.locator('.markdown table').count(),1);
  assert.ok(await page.locator('pre code .hljs-keyword').count() > 0);
  assert.equal(await page.locator('.message').count(),60);
  await page.locator('.load-more').click();
  assert.equal(await page.locator('.message').count(),65);
  assert.equal(await page.evaluate(() => globalThis.viewerCompromised),undefined);
  assert.equal(await page.locator('.markdown img,.markdown script,.markdown iframe').count(),0);
  assert.equal(await page.locator('.markdown a[href^="javascript:"]').count(),0);
  assert.equal(await page.locator('.markdown a[href^="https:"]').first().getAttribute('rel'),'noopener noreferrer');
  assert.deepEqual(requests,[]);
  assert.deepEqual(failures,[]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth),false);
  await page.locator('#theme').selectOption('light');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.locator('#theme').selectOption('dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.locator('#collapse').click();
  assert.equal(await page.locator('.conversation-head[aria-expanded="true"]').count(),0);
  await page.locator('#next').click();
  assert.equal(await page.locator('.conversation').count(),2);
  assert.equal(await page.locator('#page-label').textContent(),'Page 2 of 2');
  await page.locator('#search').fill('conversation 11');
  await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 1);
  assert.match(await page.locator('.conversation-head').textContent(),/Synthetic conversation 11/);
  await page.locator('.conversation-head').click();
  assert.equal(await page.locator('.message').count(),2);
  await page.locator('#branch').selectOption('all');
  assert.equal(await page.locator('.message').count(),3);
  assert.match(await page.locator('.message').last().textContent(),/Alternate branch needle/);
  await page.locator('#licenses').click();
  assert.equal(await page.locator('#license-dialog').evaluate(dialog=>dialog.open),true);
  assert.match(await page.locator('#license-body').textContent(),/highlight\.js/);
  await page.locator('#close-licenses').click();
  assert.deepEqual(failures,[]);
  assert.deepEqual(requests,[]);
});
