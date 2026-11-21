'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const workspaceApi = require('./workspace');

const MODEL_ROOT = '/home/luskyle/apps/minimax';
let window;
let workspace = null;
let generator;

function state() {
  if (!workspace) return { workspace: null, jobs: [], active: generator.active };
  if (!generator.active) workspaceApi.reconcileJobs(workspace);
  const jobs = workspaceApi.loadJobs(workspace);
  return { workspace, jobs, active: generator.active || jobs.some(job => job.status === 'running') };
}

function requireWorkspace() {
  if (!workspace) throw new Error('请先创建或打开工作区。');
  return workspace;
}

function remember(root) {
  fs.writeFileSync(path.join(app.getPath('userData'), 'last-workspace.json'), JSON.stringify({ root }));
}

function ensureIdle() {
  if (state().active) throw new Error('任务正在运行，完成前不能切换工作区。');
}

function registerHandlers() {
  ipcMain.handle('state', () => state());
  ipcMain.handle('workspace:create', async (_event, name) => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择工作区的父目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return state();
    workspace = workspaceApi.createWorkspace(result.filePaths[0], name, MODEL_ROOT);
    remember(workspace.root);
    return state();
  });
  ipcMain.handle('workspace:open', async () => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '打开 MMax Video 工作区', properties: ['openDirectory'] });
    if (result.canceled) return state();
    workspace = workspaceApi.workspaceAt(result.filePaths[0], MODEL_ROOT);
    remember(workspace.root);
    return state();
  });
  ipcMain.handle('workspace:settings', (_event, settings) => {
    workspaceApi.saveSettings(requireWorkspace(), settings);
    return state();
  });
  ipcMain.handle('generation:start', (_event, prompt, settings) => {
    generator.start(requireWorkspace(), prompt, settings);
    return state();
  });
  ipcMain.handle('generation:video', (_event, id) => workspaceApi.videoUrl(requireWorkspace(), id));
  ipcMain.handle('generation:show', (_event, id, type) => {
    if (!['video', 'log'].includes(type)) throw new Error('无效的文件类型。');
    const current = requireWorkspace();
    const job = workspaceApi.loadJobs(current).find(item => item.id === id);
    if (!job) throw new Error('找不到任务。');
    if (type === 'video' && job.status !== 'completed') throw new Error('视频尚未完成。');
    const file = path.join(current.root, 'jobs', id, type === 'video' ? 'video.webm' : 'generation.log');
    if (!fs.existsSync(file)) throw new Error('文件不存在。');
    shell.showItemInFolder(file);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(() => {
    generator = new workspaceApi.Generator(MODEL_ROOT, event => {
      if (window && !window.isDestroyed()) window.webContents.send('generation:event', event);
    });
    registerHandlers();
    window = new BrowserWindow({
      width: 1260, height: 850, minWidth: 900, minHeight: 680,
      backgroundColor: '#0c111b',
      title: 'MMax Video',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => {
      if (generator.active) {
        event.preventDefault();
        dialog.showMessageBox(window, { type: 'info', message: '视频正在生成，请等待任务完成后再关闭应用。' });
      }
    });
    const last = path.join(app.getPath('userData'), 'last-workspace.json');
    if (fs.existsSync(last)) {
      try {
        workspace = workspaceApi.workspaceAt(JSON.parse(fs.readFileSync(last, 'utf8')).root, MODEL_ROOT);
        workspaceApi.reconcileJobs(workspace);
      } catch (error) {
        dialog.showErrorBox('无法打开上次的工作区', error.message);
      }
    }
    window.loadFile(path.join(__dirname, 'index.html'));
  }).catch(error => {
    dialog.showErrorBox('应用启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
