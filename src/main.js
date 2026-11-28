'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const workspaceApi = require('./workspace');
const deployment = require('./deployment');

const DEFAULT_MODEL_ROOT = path.join(app.getPath('home'), 'apps', 'minimax');
let window;
let workspace = null;
let generator;
let modelRoot = DEFAULT_MODEL_ROOT;
let deploymentOptions = deployment.validateOptions();
let deploymentTask;

function state() {
  const deploymentState = { modelRoot, deploymentOptions, maintenance: deploymentTask.state };
  if (!workspace) return { workspace: null, jobs: [], active: generator.active || deploymentTask.state.running, ...deploymentState };
  if (!generator.active) workspaceApi.reconcileJobs(workspace);
  const jobs = workspaceApi.loadJobs(workspace);
  return { workspace, jobs, active: generator.active || deploymentTask.state.running || jobs.some(job => job.status === 'running'), ...deploymentState };
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
  deploymentOptions = deployment.validateOptions(saved.options);
  return saved.root;
}

function rememberModelRoot(root, options) {
  const file = path.join(app.getPath('userData'), 'model-root.json');
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ root, options }, null, 2));
  fs.renameSync(temporary, file);
}

function deploymentStatus() {
  const status = workspaceApi.inspectModelRoot(modelRoot, deploymentOptions);
  let configuration = null;
  try { configuration = deployment.inspect(modelRoot, deploymentOptions); }
  catch (error) { status.missing.push(error.message); }
  const imageStatus = workspaceApi.inspectModelRoot(modelRoot, deploymentOptions, true);
  return { ...status, imageStatus, configuration, options: deploymentOptions, operation: deploymentTask.state };
}

function ensureIdle() {
  if (state().active) throw new Error('生成或部署操作正在运行，请等待完成后再修改配置或工作区。');
}

async function deleteRecord(current, id) {
  ensureIdle();
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '删除创作记录',
    message: '删除这条创作记录及其作品、原始文件和日志？',
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
  ipcMain.handle('model:status', () => deploymentStatus());
  ipcMain.handle('model:choose', async () => {
    ensureIdle();
    const dialogOptions = { title: '选择 MiniMax 本地目录', properties: ['openDirectory'] };
    if (fs.existsSync(modelRoot)) dialogOptions.defaultPath = modelRoot;
    const result = await dialog.showOpenDialog(window, dialogOptions);
    if (result.canceled) return state();
    ensureIdle();
    const selected = fs.realpathSync(result.filePaths[0]);
    for (const name of ['generate.sh', 'deploy.py']) {
      if (!fs.statSync(path.join(selected, name)).isFile()) throw new Error(`目录必须包含 ${name}。`);
    }
    if (workspace) workspaceApi.workspaceAt(workspace.root, selected);
    const options = selected === modelRoot ? deploymentOptions : deployment.validateOptions();
    rememberModelRoot(selected, options);
    modelRoot = selected;
    deploymentOptions = options;
    generator.modelRoot = selected;
    generator.options = options;
    return state();
  });
  ipcMain.handle('model:save', (_event, input) => {
    ensureIdle();
    const options = deployment.validateOptions(input);
    deployment.inspect(modelRoot, options);
    rememberModelRoot(modelRoot, options);
    deploymentOptions = options;
    generator.options = options;
    return deploymentStatus();
  });
  ipcMain.handle('model:operation', async (_event, action, input) => {
    ensureIdle();
    if (!['doctor', 'build', 'download'].includes(action)) throw new Error('不支持的部署操作。');
    if (action === 'download' || action === 'build') {
      if (action === 'download' && input?.acceptLicense !== true) throw new Error('请先阅读并确认模型许可证。');
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message: action === 'download' ? '确认下载并校验模型？' : '确认构建 CUDA 推理器？',
        detail: action === 'download'
          ? input.profile === 'image'
            ? '图片权重与图片 VAE 新增约 13 GiB，可复用文本编码器。MiniMax-H3-Image 有独立许可证和地域限制；对外托管或年收入超过 100 万美元需额外授权。请确认已阅读许可证并具备使用资格。'
            : '下载将写入当前模型目录，单套约 31–33 GiB。请先阅读部署项目 README 的模型许可证。损坏文件不会被自动覆盖。'
          : '将拉取固定版本引擎并编译，可能耗时较长。不会安装系统依赖或修改驱动；已有源码修改会导致构建拒绝。',
        buttons: ['取消', '确认执行'], defaultId: 0, cancelId: 0
      });
      if (result.response !== 1) return deploymentTask.state;
    }
    ensureIdle();
    return deploymentTask.start(modelRoot, deploymentOptions, action, input);
  });
  ipcMain.handle('model:operation-status', () => deploymentTask.state);
  ipcMain.handle('model:show', (_event, target) => {
    const files = { readme: path.join(modelRoot, 'README.md'), config: path.join(modelRoot, 'config.local.json'), log: deploymentTask.logFile };
    if (!Object.hasOwn(files, target) || !fs.existsSync(files[target])) throw new Error('文件不存在。');
    shell.showItemInFolder(files[target]);
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
    ensureIdle();
    const job = generator.start(requireWorkspace(), prompt, settings);
    return { ...state(), startedId: job.id };
  });
  ipcMain.handle('generation:menu', (_event, id) => {
    const current = requireWorkspace();
    const snapshot = state();
    if (!snapshot.jobs.some(job => job.id === id)) throw new Error('找不到创作记录。');
    Menu.buildFromTemplate([{
      label: snapshot.active ? '生成或部署操作期间不能删除记录' : '删除创作记录…',
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
    generator.options = deploymentOptions;
    deploymentTask = new deployment.DeploymentTask(path.join(app.getPath('userData'), 'deployment.log'), () => {
      if (window && !window.isDestroyed()) window.webContents.send('deployment:event', deploymentTask.state);
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
      if (generator.active || deploymentTask.state.running) {
        event.preventDefault();
        dialog.showMessageBox(window, { type: 'info', message: '生成或部署操作正在运行，请等待完成后再关闭应用。' });
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
