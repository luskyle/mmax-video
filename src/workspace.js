'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MARKER = '.mmax-workspace.json';
const DEFAULTS = { width: 640, height: 384, seed: -1 };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function writeJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('生成设置无效。');
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 256 || settings[key] > 1920 || settings[key] % 32 !== 0) {
      throw new Error('宽度和高度必须是 256 到 1920 之间的 32 的倍数。');
    }
  }
  if (!Number.isInteger(settings.seed) || settings.seed < -1 || settings.seed > 2147483647) {
    throw new Error('种子必须是 -1 或 0 到 2147483647 之间的整数。');
  }
  return { width: settings.width, height: settings.height, seed: settings.seed };
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    throw new Error('请输入 1 到 4000 个字符的提示词。');
  }
  return prompt.trim();
}

function assertOutsideModel(root, modelRoot) {
  const relative = path.relative(fs.realpathSync(modelRoot), fs.realpathSync(root));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('工作区不能位于 MiniMax 模型目录内。');
  }
}

function workspaceAt(root, modelRoot) {
  root = fs.realpathSync(root);
  assertOutsideModel(root, modelRoot);
  const marker = readJson(path.join(root, MARKER));
  if (marker.version !== 1 || typeof marker.name !== 'string') throw new Error('不是有效的 MMax Video 工作区。');
  const settings = validateSettings(marker.settings);
  const jobsDir = path.join(root, 'jobs');
  if (!fs.statSync(jobsDir).isDirectory() || path.dirname(fs.realpathSync(jobsDir)) !== root) {
    throw new Error('工作区任务目录无效或指向工作区外。');
  }
  return { root, name: marker.name, settings };
}

function createWorkspace(parent, name, modelRoot) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      name.trim() === '.' || name.trim() === '..' || /[\/\\\x00-\x1f]/.test(name)) {
    throw new Error('工作区名称无效，不能包含路径分隔符。');
  }
  parent = fs.realpathSync(parent);
  assertOutsideModel(parent, modelRoot);
  const root = path.join(parent, name.trim());
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'jobs'));
  writeJson(path.join(root, MARKER), { version: 1, name: name.trim(), settings: DEFAULTS });
  return workspaceAt(root, modelRoot);
}

function saveSettings(workspace, settings) {
  settings = validateSettings(settings);
  writeJson(path.join(workspace.root, MARKER), { version: 1, name: workspace.name, settings });
  workspace.settings = settings;
  return settings;
}

function jobDir(workspace, id) {
  if (!ID.test(id)) throw new Error('无效的任务编号。');
  const jobs = fs.realpathSync(path.join(workspace.root, 'jobs'));
  if (path.dirname(jobs) !== workspace.root) throw new Error('工作区任务目录无效。');
  const dir = path.join(jobs, id);
  if (fs.existsSync(dir) && path.dirname(fs.realpathSync(dir)) !== jobs) throw new Error('任务目录无效。');
  return dir;
}

function loadJobs(workspace) {
  return fs.readdirSync(path.join(workspace.root, 'jobs'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && ID.test(entry.name))
    .map(entry => readJson(path.join(jobDir(workspace, entry.name), 'job.json')))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function processStillRunning(job, dir) {
  if (!Number.isInteger(job.pid) || job.pid <= 0) return false;
  try {
    const args = fs.readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').split('\0');
    return args.includes(path.join(dir, 'original.webm')) || args.includes(path.join(dir, 'video.webm'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}

function reconcileJobs(workspace) {
  for (const job of loadJobs(workspace)) {
    if (job.status !== 'running') continue;
    const dir = jobDir(workspace, job.id);
    if (!processStillRunning(job, dir)) {
      job.status = 'interrupted';
      job.error = '应用退出时任务未完成，请查看日志并重新生成。';
      job.finishedAt = new Date().toISOString();
      writeJson(path.join(dir, 'job.json'), job);
    }
  }
}

function videoUrl(workspace, id) {
  const dir = jobDir(workspace, id);
  const job = readJson(path.join(dir, 'job.json'));
  if (job.id !== id || job.status !== 'completed') throw new Error('该任务没有可播放的视频。');
  const file = path.join(dir, 'video.webm');
  if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw new Error('视频路径无效。');
  return pathToFileURL(file).href;
}

function runProcess(command, args, options, log, onOutput, onPid) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let processError;
    const fail = error => {
      if (!processError) processError = error;
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    };
    child.on('error', fail);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', fail);
      stream.on('data', chunk => {
        try {
          log.write(chunk);
          onOutput(chunk.toString('utf8'));
        } catch (error) {
          fail(error);
        }
      });
    }
    child.on('close', (code, signal) => {
      if (processError) reject(processError);
      else if (code === 0) resolve();
      else reject(new Error(`进程失败（${signal ? `信号 ${signal}` : `退出码 ${code}`}），请查看任务日志。`));
    });
    try { onPid(child.pid); } catch (error) { fail(error); }
  });
}

class Generator {
  constructor(modelRoot, notify) {
    this.modelRoot = modelRoot;
    this.notify = notify;
    this.active = false;
  }

  start(workspace, prompt, input) {
    if (this.active) throw new Error('已有任务正在运行，请等待完成。');
    reconcileJobs(workspace);
    if (loadJobs(workspace).some(job => job.status === 'running')) {
      throw new Error('此工作区的前一个任务仍在运行，请等待其结束后重新打开工作区。');
    }
    prompt = validatePrompt(prompt);
    const settings = validateSettings(input);
    const script = path.join(this.modelRoot, 'generate.sh');
    const model = path.join(this.modelRoot, 'models/diffusion_models/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf');
    const ffmpeg = path.join(this.modelRoot, 'build-deps/root/usr/bin/ffmpeg');
    for (const file of [script, model, ffmpeg]) {
      if (!fs.existsSync(file)) throw new Error(`缺少运行文件：${file}`);
    }
    const id = crypto.randomUUID();
    const dir = jobDir(workspace, id);
    fs.mkdirSync(dir);
    const job = { id, prompt, ...settings, status: 'running', phase: '启动中', createdAt: new Date().toISOString() };
    writeJson(path.join(dir, 'job.json'), job);
    this.active = true;
    this.execute(workspace, job, dir, script, model, ffmpeg).catch(error => {
      console.error('Unable to finalize generation:', error);
      this.notify({ type: 'error', message: `任务状态保存失败：${error.message}` });
    }).finally(() => { this.active = false; this.notify({ type: 'changed' }); });
    return job;
  }

  async execute(workspace, job, dir, script, model, ffmpeg) {
    const metadata = path.join(dir, 'job.json');
    const log = fs.createWriteStream(path.join(dir, 'generation.log'), { flags: 'a' });
    let logError;
    log.on('error', error => { logError = error; });
    const update = () => { writeJson(metadata, job); this.notify({ type: 'changed' }); };
    const setPid = pid => { job.pid = pid || null; update(); };
    let buffer = '';
    const onOutput = text => {
      buffer = (buffer + text).slice(-4096);
      let phase = job.phase;
      if (buffer.includes('sampling completed')) phase = '解码视频和音频';
      else {
        const matches = [...buffer.matchAll(/\|\s*\d+\/6\s*-/g)];
        if (matches.length) phase = `采样 ${matches.at(-1)[0].match(/\d+\/6/)[0]}`;
        else if (buffer.includes('generate_video ')) phase = '准备采样';
      }
      if (phase !== job.phase) { job.phase = phase; update(); }
    };
    const raw = path.join(dir, 'original.webm');
    const final = path.join(dir, 'video.webm');
    try {
      const env = { ...process.env, MINIMAX_H3_BACKEND: 'cuda', MINIMAX_H3_DIFFUSION_MODEL: model, TMPDIR: dir };
      await runProcess('bash', [script, job.prompt, raw, '--width', String(job.width), '--height', String(job.height),
        '--seed', String(job.seed), '--steps', '6', '--sampling-method', 'euler', '--sigmas', 'hyperflow-h3-flash-6'],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }, log, onOutput, setPid);
      if (logError) throw logError;
      if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) throw new Error('推理结束但没有生成视频。');
      job.phase = '转换音频以便播放';
      update();
      const libs = path.join(this.modelRoot, 'build-deps/root/usr/lib/x86_64-linux-gnu');
      const ffenv = { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'), TMPDIR: dir };
      await runProcess(ffmpeg, ['-v', 'error', '-n', '-i', raw, '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '128k', final],
      { cwd: dir, env: ffenv, stdio: ['ignore', 'pipe', 'pipe'] }, log, () => {}, setPid);
      if (logError) throw logError;
      if (!fs.existsSync(final) || fs.statSync(final).size === 0) throw new Error('音频转换后没有生成视频。');
      job.status = 'completed';
      job.phase = '已完成';
    } catch (error) {
      job.status = 'failed';
      job.phase = '失败';
      job.error = error.message;
    } finally {
      await new Promise(resolve => {
        if (log.destroyed) resolve();
        else log.end(resolve);
      });
      if (logError) {
        job.status = 'failed';
        job.error = `日志写入失败：${logError.message}`;
      }
      job.pid = null;
      job.finishedAt = new Date().toISOString();
      update();
    }
  }
}

module.exports = { DEFAULTS, Generator, createWorkspace, workspaceAt, saveSettings, loadJobs, reconcileJobs, videoUrl, validateSettings, validatePrompt };
