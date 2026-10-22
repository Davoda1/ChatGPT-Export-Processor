'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('processor', Object.freeze({
  getState: () => ipcRenderer.invoke('processor:state'),
  chooseInput: role => ipcRenderer.invoke('processor:choose-input', role),
  clearInput: role => ipcRenderer.invoke('processor:clear-input', role),
  chooseOutput: () => ipcRenderer.invoke('processor:choose-output'),
  start: options => ipcRenderer.invoke('processor:start', options),
  cancel: () => ipcRenderer.invoke('processor:cancel'),
  evidence: id => ipcRenderer.invoke('processor:evidence', id),
  exportReport: options => ipcRenderer.invoke('processor:export-report', options),
  revealOutput: () => ipcRenderer.invoke('processor:reveal-output'),
  setPreferences: value => ipcRenderer.invoke('processor:preferences', value),
  ready: () => ipcRenderer.send('processor:ready'),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Event handler must be a function.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('processor:event', listener);
    return () => ipcRenderer.removeListener('processor:event', listener);
  },
}));
