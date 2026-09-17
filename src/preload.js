'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only a fixed, narrow set of operations is exposed to the renderer.
// No generic ipcRenderer.send/invoke is ever exposed directly.
contextBridge.exposeInMainWorld('amazonAutomation', {
  selectExcel: () => ipcRenderer.invoke('automation:selectExcel'),
  previewExcel: () => ipcRenderer.invoke('automation:previewExcel'),
  start: (browserTarget) => ipcRenderer.invoke('automation:start', browserTarget),
  stop: () => ipcRenderer.invoke('automation:stop'),
  downloadSuccessfulItems: () => ipcRenderer.invoke('automation:downloadSuccessfulItems'),

  onProgress: (callback) => {
    ipcRenderer.on('automation:progress', (_event, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.on('automation:log', (_event, line) => callback(line));
  },
  onStatus: (callback) => {
    ipcRenderer.on('automation:status', (_event, data) => callback(data));
  },
});
