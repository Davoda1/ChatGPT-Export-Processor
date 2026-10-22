'use strict';
const {app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, session} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {mkdirSync} = require('node:fs');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {JobController} = require('./job-controller.cjs');
const {loadPreferences, savePreferences, normalizePreferences} = require('./preferences.cjs');
const {validateRole, selectedFile, publicSelection, jobSpec, writeReportExclusive} = require('./file-policy.cjs');
const {exitAfterReady} = require('./exit.cjs');

// Chromium launch switches may precede application arguments in packaged builds.
const cliIndex = process.argv.indexOf('--cli');
const cli = cliIndex !== -1;
const args = cli ? process.argv.slice(cliIndex) : process.argv.slice(process.defaultApp ? 2 : 1);
if (cli && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('disable-gpu');
}
app.setName('ChatGPT Export Processor');
const requestedUserData = app.commandLine.getSwitchValue('user-data-dir');
const userDataDirectory = requestedUserData ? path.resolve(requestedUserData) : path.join(app.getPath('appData'), 'ChatGPT-Export-Processor-Public');
mkdirSync(userDataDirectory, {recursive: true, mode: 0o700});
app.setPath('userData', userDataDirectory);
const preferencesFile = path.join(app.getPath('userData'), 'preferences.json');
let preferences = loadPreferences(preferencesFile);
nativeTheme.themeSource = preferences.theme;
const rendererPath = path.join(__dirname, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
let window = null, closing = false, dialogOpen = false;
const selection = {};
const jobs = new JobController(event => {
  if (window && !window.isDestroyed()) window.webContents.send('processor:event', event);
});

function trusted(event) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererURL;
}
function handle(name, callback) {
  ipcMain.handle(`processor:${name}`, (event, ...values) => {
    if (!trusted(event)) throw new Error('Untrusted application request.');
    return callback(...values);
  });
}
async function withDialog(callback) {
  if (jobs.running) throw new Error('Wait for the current task or cancel it first.');
  if (dialogOpen) throw new Error('A file dialog is already open.');
  dialogOpen = true;
  try { return await callback(); } finally { dialogOpen = false; }
}
function registerIPC() {
  handle('state', () => ({version: app.getVersion(), preferences, selection: publicSelection(selection), result: jobs.result, running: jobs.running, outputAvailable: !!jobs.outputDir}));
  handle('choose-input', role => withDialog(async () => {
    validateRole(role);
    const extensions = {original: ['zip', 'json'], indexJson: ['json'], indexHtml: ['html', 'htm'], bundle: ['zip']}[role];
    const result = await dialog.showOpenDialog(window, {title: 'Choose a ChatGPT export file', properties: ['openFile'], filters: [{name: 'Supported input', extensions}]});
    if (result.canceled || !result.filePaths[0]) return null;
    const file = await selectedFile(result.filePaths[0], role);
    selection[role] = file;
    return publicSelection({[role]: file})[role];
  }));
  handle('clear-input', role => {
    if (jobs.running || dialogOpen) throw new Error('Wait for the current operation to finish.');
    validateRole(role); delete selection[role]; return publicSelection(selection);
  });
  handle('choose-output', () => withDialog(async () => {
    const result = await dialog.showOpenDialog(window, {title: 'Choose a parent folder for new outputs', properties: ['openDirectory', 'createDirectory']});
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await fs.realpath(result.filePaths[0]);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Choose a folder.');
    selection.outputDir = {path: directory, name: path.basename(directory) || path.parse(directory).root, token: crypto.randomUUID()};
    return publicSelection(selection).outputDir;
  }));
  handle('start', request => {
    if (dialogOpen) throw new Error('Close the file dialog before starting.');
    return jobs.start(jobSpec(request, selection));
  });
  handle('cancel', () => jobs.cancel());
  handle('evidence', id => {
    if (typeof id !== 'string' || id.length > 128) throw new Error('Invalid finding.');
    return jobs.request('evidence', {id});
  });
  handle('export-report', options => withDialog(async () => {
    if (!jobs.result) throw new Error('Complete an inspection first.');
    const format = options?.format;
    if (!['json', 'html', 'csv'].includes(format) || options?.includeEvidence === true) throw new Error('Choose a supported report format. Raw message exports are not enabled.');
    const result = await dialog.showSaveDialog(window, {title: 'Save a local validation report', defaultPath: `validation-report.${format}`, filters: [{name: format.toUpperCase(), extensions: [format]}]});
    if (result.canceled || !result.filePath) return null;
    const content = await jobs.request('report', {format});
    const protectedFiles = [...jobs.protectedFiles, ...Object.values(selection).filter(value => value?.path).map(value => value.path)];
    const name = await writeReportExclusive(result.filePath, content, protectedFiles);
    return {name};
  }));
  handle('reveal-output', async () => {
    if (!jobs.outputDir) throw new Error('There is no completed conversion output folder.');
    const error = await shell.openPath(jobs.outputDir);
    if (error) throw new Error('The output folder could not be opened.');
    return true;
  });
  handle('preferences', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['theme', 'density'].includes(key))) throw new Error('Invalid preferences.');
    preferences = savePreferences(preferencesFile, normalizePreferences({...preferences, ...value}));
    nativeTheme.themeSource = preferences.theme;
    return preferences;
  });
  ipcMain.on('processor:ready', event => { if (trusted(event) && !window.isDestroyed()) window.show(); });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1180, height: 800, minWidth: 680, minHeight: 540,
    show: false, autoHideMenuBar: true,
    title: 'ChatGPT Export Processor',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080c12' : '#f3f6f2',
    icon: path.join(__dirname, '../../build/icons/256x256.png'),
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false, devTools: !app.isPackaged},
  });
  window.setMenu(null);
  // Native borders differ across platforms. Keep the supported minimum for
  // the workspace itself, with the operating-system frame added outside it.
  const [outerWidth, outerHeight] = window.getSize();
  const [contentWidth, contentHeight] = window.getContentSize();
  window.setMinimumSize(680 + Math.max(0, outerWidth - contentWidth), 540 + Math.max(0, outerHeight - contentHeight));
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    (jobs.running ? jobs.cancel() : jobs.dispose()).finally(() => app.quit());
  });
  window.loadFile(rendererPath);
}

if (!cli && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    if (cli) {
      const code = await require('../cli.cjs').runCli(args.slice(1));
      await exitAfterReady(app, code); return;
    }
    app.setAppUserModelId('io.github.davoda1.chatgpt-export-processor');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const allowedRoot = pathToFileURL(path.join(__dirname, '../renderer/')).href;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: !details.url.startsWith(allowedRoot)}));
    registerIPC(); createWindow();
  }).catch(error => { console.error('Application startup failed:', error.message); void exitAfterReady(app, 1); });
  app.on('window-all-closed', () => app.quit());
}
