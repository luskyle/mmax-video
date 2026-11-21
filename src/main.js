'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const workspaceApi = require('./workspace');

const DEFAULT_MODEL_ROOT = path.join(app.getPath('home'), 'apps', 'minimax');
let window;
let workspace = null;
let generator;
let modelRoot = DEFAULT_MODEL_ROOT;

function state() {
  if (!workspace) return { workspace: null, jobs: [], active: generator.active, modelRoot };
  if (!generator.active) workspaceApi.reconcileJobs(workspace);
  const jobs = workspaceApi.loadJobs(workspace);
  return { workspace, jobs, active: generator.active || jobs.some(job => job.status === 'running'), modelRoot };
}

function requireWorkspace() {
  if (!workspace) throw new Error('请先创建或打开工作区。');
  return workspace;
}

function remember(root) {
  fs.writeFileSync(path.join(app.getPath('userData'), 'last-workspace.json'), JSON.stringify({ root }));
}

function loadModelRoot() {
  const file = path.join(app.getPath('userData'), 'model-root.json');
  if (!fs.existsSync(file)) return DEFAULT_MODEL_ROOT;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved || typeof saved.root !== 'string' || !path.isAbsolute(saved.root)) throw new Error('保存的 MiniMax 路径无效。');
  return saved.root;
}

function rememberModelRoot(root) {
  fs.writeFileSync(path.join(app.getPath('userData'), 'model-root.json'), JSON.stringify({ root }));
}

function ensureIdle() {
  if (state().active) throw new Error('画面正在生成，完成前不能新建画面、删除记录或切换工作区及 MiniMax 目录。');
}

async function deleteRecord(current, id) {
  ensureIdle();
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '删除创作记录',
    message: '删除这条创作记录及其视频、原始文件和日志？',
    detail: '删除后无法恢复，其他创作记录不受影响。',
    buttons: ['取消', '删除记录和文件'],
    defaultId: 0,
    cancelId: 0
  });
  if (result.response !== 1) return;
  ensureIdle();
  if (workspace !== current) throw new Error('工作区已切换，请重新选择要删除的记录。');
  workspaceApi.deleteJob(current, id);
  window.webContents.send('generation:event', { type: 'deleted', id });
}

function registerHandlers() {
  ipcMain.handle('state', () => state());
  ipcMain.handle('model:status', () => workspaceApi.inspectModelRoot(modelRoot));
  ipcMain.handle('model:choose', async () => {
    ensureIdle();
    const options = { title: '选择 MiniMax 本地目录', properties: ['openDirectory'] };
    if (fs.existsSync(modelRoot)) options.defaultPath = modelRoot;
    const result = await dialog.showOpenDialog(window, options);
    if (result.canceled) return state();
    const selected = workspaceApi.modelFiles(result.filePaths[0]).root;
    if (workspace) workspaceApi.workspaceAt(workspace.root, selected);
    rememberModelRoot(selected);
    modelRoot = selected;
    generator.modelRoot = selected;
    return state();
  });
  ipcMain.handle('page:settings', () => window.loadFile(path.join(__dirname, 'settings.html')));
  ipcMain.handle('page:home', () => window.loadFile(path.join(__dirname, 'index.html')));
  ipcMain.handle('workspace:create', async (_event, name) => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择工作区的父目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return state();
    workspace = workspaceApi.createWorkspace(result.filePaths[0], name, modelRoot);
    remember(workspace.root);
    return state();
  });
  ipcMain.handle('workspace:open', async () => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '打开 MMax Video Studio 工作区', properties: ['openDirectory'] });
    if (result.canceled) return state();
    workspace = workspaceApi.workspaceAt(result.filePaths[0], modelRoot);
    remember(workspace.root);
    return state();
  });
  ipcMain.handle('workspace:settings', (_event, settings) => {
    workspaceApi.saveSettings(requireWorkspace(), settings);
    return state();
  });
  ipcMain.handle('scene:new', () => {
    ensureIdle();
    requireWorkspace();
    return state();
  });
  ipcMain.handle('generation:start', (_event, prompt, settings) => {
    const job = generator.start(requireWorkspace(), prompt, settings);
    return { ...state(), startedId: job.id };
  });
  ipcMain.handle('generation:menu', (_event, id) => {
    const current = requireWorkspace();
    const snapshot = state();
    if (!snapshot.jobs.some(job => job.id === id)) throw new Error('找不到创作记录。');
    Menu.buildFromTemplate([{
      label: snapshot.active ? '生成期间不能删除记录' : '删除创作记录…',
      enabled: !snapshot.active,
      click: () => deleteRecord(current, id).catch(error => {
        window.webContents.send('generation:event', { type: 'error', message: error.message });
      })
    }]).popup({ window });
  });
  ipcMain.handle('generation:video', (_event, id) => workspaceApi.videoUrl(requireWorkspace(), id));
  ipcMain.handle('generation:show', (_event, id, type) => {
    shell.showItemInFolder(workspaceApi.jobFile(requireWorkspace(), id, type));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(() => {
    modelRoot = loadModelRoot();
    generator = new workspaceApi.Generator(modelRoot, event => {
      if (window && !window.isDestroyed()) window.webContents.send('generation:event', event);
    });
    registerHandlers();
    window = new BrowserWindow({
      width: 1260, height: 850, minWidth: 900, minHeight: 680,
      backgroundColor: '#0c111b',
      title: 'MMax Video Studio',
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
        workspace = workspaceApi.workspaceAt(JSON.parse(fs.readFileSync(last, 'utf8')).root, modelRoot);
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
