'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmax', {
  state: () => ipcRenderer.invoke('state'),
  createWorkspace: name => ipcRenderer.invoke('workspace:create', name),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  saveSettings: settings => ipcRenderer.invoke('workspace:settings', settings),
  start: (prompt, settings) => ipcRenderer.invoke('generation:start', prompt, settings),
  video: id => ipcRenderer.invoke('generation:video', id),
  show: (id, type) => ipcRenderer.invoke('generation:show', id, type),
  onEvent: callback => ipcRenderer.on('generation:event', (_event, data) => callback(data))
});
