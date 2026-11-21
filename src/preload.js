'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmax', {
  state: () => ipcRenderer.invoke('state'),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  chooseModel: () => ipcRenderer.invoke('model:choose'),
  openSettings: () => ipcRenderer.invoke('page:settings'),
  openHome: () => ipcRenderer.invoke('page:home'),
  createWorkspace: name => ipcRenderer.invoke('workspace:create', name),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  saveSettings: settings => ipcRenderer.invoke('workspace:settings', settings),
  newScene: () => ipcRenderer.invoke('scene:new'),
  start: (prompt, settings) => ipcRenderer.invoke('generation:start', prompt, settings),
  recordMenu: id => ipcRenderer.invoke('generation:menu', id),
  video: id => ipcRenderer.invoke('generation:video', id),
  show: (id, type) => ipcRenderer.invoke('generation:show', id, type),
  onEvent: callback => ipcRenderer.on('generation:event', (_event, data) => callback(data))
});
