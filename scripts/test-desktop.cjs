'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron: electron } = require('playwright');
const { conversation, fixtureZip } = require('../tests/helpers/conversion.cjs');

// Native desktop integration. The test invokes the production main process,
// preload, IPC policies, filesystem conversion, worker, and independent audit.
// On hosts that prohibit Unix-domain mutex sockets, TEST_SINGLE_INSTANCE_SHIM=1
// substitutes only Electron's OS single-instance lock in a temporary bootstrap.
// Dialog responses represent user selections; production dialog code is intact.
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function run() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-desktop-test-'));
  const appRoot = path.resolve(__dirname, '..');
  let app;
  const observations = { passed: false, platform: process.platform, singletonShim: process.env.TEST_SINGLE_INSTANCE_SHIM === '1', windowsRuntimeExecuted: process.platform === 'win32', checks: [] };
  try {
    const input = path.join(fixtureRoot, 'synthetic-export.zip');
    const outputs = path.join(fixtureRoot, 'outputs');
    const reportFile = path.join(fixtureRoot, 'saved-report.json');
    const preferencesRoot = path.join(fixtureRoot, 'preferences');
    await fs.mkdir(outputs); await fs.mkdir(preferencesRoot);
    const original = [conversation('synthetic-desktop', ':::writing{variant="email" subject="Synthetic subject"}\nSynthetic body.\n:::')];
    await fs.writeFile(input, fixtureZip([['conversations.json', JSON.stringify(original)]], {deflate:true}));
    const inputHash = sha(await fs.readFile(input));
    let launchTarget = appRoot;
    if (observations.singletonShim) {
      const bootstrap = path.join(fixtureRoot, 'bootstrap'); await fs.mkdir(bootstrap);
      const packageInfo = require('../package.json');
      await fs.writeFile(path.join(bootstrap, 'package.json'), JSON.stringify({name:packageInfo.name,version:packageInfo.version,main:'bootstrap.cjs'}));
      await fs.writeFile(path.join(bootstrap, 'bootstrap.cjs'), "'use strict';\nrequire('electron').app.requestSingleInstanceLock = () => true;\nrequire(" + JSON.stringify(path.join(appRoot,'src/main/main.cjs')) + ');\n');
      launchTarget = bootstrap;
    }
    const env = {...process.env, XDG_CONFIG_HOME: preferencesRoot};
    if (process.platform === 'win32') {
      env.APPDATA = preferencesRoot;
      env.LOCALAPPDATA = preferencesRoot;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    const flags = [];
    if (process.getuid?.() === 0) flags.push('--no-sandbox');
    if (process.platform === 'linux' && process.env.TEST_DESKTOP_DISPLAY !== '1') flags.push('--ozone-platform=headless','--disable-gpu');
    app = await electron.launch({executablePath:require('electron'),args:[...flags,launchTarget],env,timeout:30000});
    const page = await app.firstWindow({timeout:30000});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#footerStatus')?.textContent.includes('Ready'), null, {timeout:30000});
    await app.evaluate(({dialog}, values) => {
      dialog.showOpenDialog = async (_window, options) => ({canceled:false,filePaths:[options.properties.includes('openDirectory') ? values.outputs : values.input]});
      dialog.showSaveDialog = async () => ({canceled:false,filePath:values.reportFile});
    }, {input,outputs,reportFile});
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    observations.checks.push('renderer has no Node globals');
    const rejectedRole = await page.evaluate(async () => {try {await window.processor.chooseInput('__proto__');return false;}catch{return true;}});
    assert.equal(rejectedRole,true); observations.checks.push('arbitrary input roles rejected');
    await page.locator('#chooseOriginal').click(); await page.locator('#chooseOutput').click();
    const selection = await page.evaluate(async () => (await window.processor.getState()).selection);
    assert.equal(selection.original.name, 'synthetic-export.zip');
    assert.ok(!JSON.stringify(selection).includes(fixtureRoot));
    await page.locator('#run').click();
    await page.waitForSelector('#view-overview.active', {timeout:60000});
    const completed = await page.evaluate(() => window.processor.getState());
    assert.equal(completed.result.status, 'PASS', JSON.stringify(completed.result.findings));
    assert.equal(completed.outputAvailable,true);
    assert.equal(await page.getByRole('button',{name:'Open output folder'}).count(),1);
    assert.equal(sha(await fs.readFile(input)),inputHash);
    const directories = await fs.readdir(outputs);
    assert.equal(directories.length,1);
    const output = path.join(outputs,directories[0]);
    const converted = JSON.parse(await fs.readFile(path.join(output,'conversations-index.json'),'utf8'));
    assert.equal(converted[0].mapping.user.message.content.parts[0], original[0].mapping.user.message.content.parts[0]);
    assert.match(converted[0].mapping.assistant.message.content.parts[0], /SUBJECT/);
    observations.checks.push('native dialog selection → real IPC → conversion worker → independent PASS report', 'original ZIP and user text preserved', 'completed output folder available');
    await page.locator('#headAction').click(); await page.locator('#reportFormat').selectOption('json'); await page.locator('#saveReport').click();
    await page.waitForFunction(() => document.querySelector('#modalBackdrop').hidden);
    const savedReport = JSON.parse(await fs.readFile(reportFile,'utf8'));
    assert.equal(savedReport.status,'PASS');
    assert.ok(!JSON.stringify(savedReport).includes(fixtureRoot));
    observations.checks.push('native save dialog writes JSON report without absolute input paths');
    const geometry = await app.evaluate(({BrowserWindow}) => {
      const win=BrowserWindow.getAllWindows()[0];
      win.setContentSize(680,540);
      const [outerWidth,outerHeight]=win.getSize(),[contentWidth,contentHeight]=win.getContentSize();
      return {minimum:win.getMinimumSize(),content:[contentWidth,contentHeight],frame:[outerWidth-contentWidth,outerHeight-contentHeight]};
    });
    assert.deepEqual(geometry.content,[680,540]);
    assert.deepEqual(geometry.minimum,[680+geometry.frame[0],540+geometry.frame[1]]);
    await page.locator('[data-page="workspace"]').click();
    const fit = await page.evaluate(() => {const e=document.querySelector('.workspace-content');return {global:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight,workspaceX:e.scrollWidth-e.clientWidth,workspaceY:e.scrollHeight-e.clientHeight,width:innerWidth,height:innerHeight};});
    assert.equal(fit.global,false); assert.equal(fit.workspaceX,0); assert.equal(fit.workspaceY,0);
    observations.minimumWindow=fit; observations.windowFrame=geometry.frame; observations.checks.push('minimum client area retains visible workspace controls with native window borders');
    if(process.env.UI_SCREENSHOT_DIR){await fs.mkdir(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'native-workspace.png')});}
    const cancellationInput=path.join(fixtureRoot,'synthetic-cancellation.zip');
    const many=Array.from({length:6000},(_,i)=>conversation('synthetic-cancel-'+i));
    await fs.writeFile(cancellationInput,fixtureZip([['conversations.json',JSON.stringify(many)]],{deflate:true}));
    const cancelHash=sha(await fs.readFile(cancellationInput));
    await app.evaluate(({dialog}, file) => {dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},cancellationInput);
    await page.locator('#chooseOriginal').click(); await page.locator('#run').click(); await page.locator('#cancelRun').click();
    await page.waitForFunction(()=>document.querySelector('#footerStatus').textContent.includes('Cancelled'),null,{timeout:15000});
    assert.equal((await page.evaluate(()=>window.processor.getState())).running,false);
    assert.equal((await page.evaluate(()=>window.processor.getState())).result,null);
    assert.equal(sha(await fs.readFile(cancellationInput)),cancelHash);
    assert.deepEqual(await fs.readdir(outputs),directories);
    observations.checks.push('real worker cancellation removes owned partial outputs and preserves input');
    assert.deepEqual(errors,[]); observations.checks.push('no renderer JavaScript errors'); observations.passed=true;
    console.log(JSON.stringify(observations,null,2));
  } finally {
    if(app) await app.close().catch(()=>{});
    await fs.rm(fixtureRoot,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
