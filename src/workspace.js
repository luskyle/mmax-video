'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const deployment = require('./deployment');

const MARKER = '.mmax-workspace.json';
const DEFAULTS = { width: 640, height: 384, seed: -1, duration: 5, format: 'webm', audio: true };
const FPS = 24;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function writeJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateSettings(settings, forGeneration = false) {
  if (!settings || typeof settings !== 'object') throw new Error('生成设置无效。');
  const image = settings.kind === 'image';
  if (settings.kind !== undefined && !['image', 'video'].includes(settings.kind)) throw new Error('画面类型无效。');
  const maxSize = image ? 2048 : forGeneration ? 1344 : 1920;
  const minSize = image ? 512 : 256;
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(settings[key]) || settings[key] < minSize || settings[key] > maxSize || settings[key] % 32 !== 0) {
      throw new Error(`宽度和高度必须是 ${minSize} 到 ${maxSize} 之间的 32 的倍数。`);
    }
  }
  if (!Number.isInteger(settings.seed) || settings.seed < -1 || settings.seed > 2147483647) {
    throw new Error('种子必须是 -1 或 0 到 2147483647 之间的整数。');
  }
  if (image) return { kind: 'image', width: settings.width, height: settings.height, seed: settings.seed, duration: 0, format: 'png', audio: false };
  const { duration = DEFAULTS.duration, format = DEFAULTS.format, audio = DEFAULTS.audio } = settings;
  if (!(forGeneration ? [5, 10, 14] : [5, 10, 14, 15]).includes(duration)) {
    throw new Error(forGeneration ? '视频时长必须为 5、10 或 14 秒；旧的 15 秒记录仍可查看。' : '视频时长无效。');
  }
  if (!['webm', 'mp4'].includes(format)) throw new Error('视频格式必须为 WebM 或 MP4。');
  if (typeof audio !== 'boolean') throw new Error('音频设置无效。');
  return { width: settings.width, height: settings.height, seed: settings.seed, duration, format, audio };
}

function framesForDuration(duration) {
  return Math.ceil((duration * FPS - 5) / 17) * 17 + 5;
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 7000) {
    throw new Error('请输入 1 到 7000 个字符的提示词。');
  }
  return prompt.trim();
}

function isFile(file, executable = false) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (executable) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

function ffmpegEnvironment(root, ffmpeg, tmpdir) {
  const env = { ...process.env };
  if (tmpdir) env.TMPDIR = tmpdir;
  if (ffmpeg === path.join(root, 'build-deps/root/usr/bin/ffmpeg')) {
    const libs = path.join(root, 'build-deps/root/usr/lib/x86_64-linux-gnu');
    env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  return env;
}

function findFfmpeg(root, custom = '') {
  const bundled = path.join(root, 'build-deps/root/usr/bin/ffmpeg');
  const candidates = new Set(custom ? [deployment.resolvePath(root, custom)] :
    [bundled, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'ffmpeg'))]);
  const failures = [];
  for (const file of candidates) {
    if (!isFile(file, true)) continue;
    const result = spawnSync(file, ['-version'], { cwd: root, env: ffmpegEnvironment(root, file), encoding: 'utf8', timeout: 5000 });
    if (!result.error && result.status === 0) return { file };
    failures.push(`${file}：${result.error ? result.error.message : result.stderr.trim() || (result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`)}`);
  }
  return {
    file: null,
    error: failures.length ? `FFmpeg 无法运行：${failures.join('；')}` : custom ? `FFmpeg 不存在或不可执行：${custom}` : 'FFmpeg（请安装到 PATH 或放入 build-deps/root/usr/bin/ffmpeg）'
  };
}

function inspectModelRoot(modelRoot, inputOptions = deployment.DEFAULT_OPTIONS, image = false) {
  const options = deployment.validateOptions(inputOptions);
  let root;
  try {
    root = fs.realpathSync(modelRoot);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { root: modelRoot, files: {}, missing: [modelRoot] };
    }
    throw error;
  }
  const ffmpeg = image ? { file: null } : findFfmpeg(root, options.ffmpeg);
  const files = {
    script: path.join(root, 'generate.sh'),
    deploy: path.join(root, 'deploy.py'),
    ffmpeg: ffmpeg.file
  };
  const missing = [];
  for (const file of [files.script, files.deploy]) {
    if (!isFile(file)) missing.push(file);
  }
  if (!image && !files.ffmpeg) missing.push(ffmpeg.error);
  if (isFile(files.script) && isFile(files.deploy)) {
    const output = path.join(os.tmpdir(), `mmax-check-${crypto.randomUUID()}.${image ? 'png' : 'webm'}`);
    const args = image ? ['generate-image', 'MMax image check', output, '--dry-run'] :
      ['generate', 'MMax deployment check', output, '--profile', options.profile, '--steps', String(options.steps), '--dry-run'];
    const result = spawnSync('python3', [files.deploy, ...args], {
      cwd: root, env: deployment.environment(root, options), encoding: 'utf8', timeout: 10000
    });
    if (result.error) {
      missing.push(`部署检查无法运行：${result.error.message}`);
    } else if (result.status !== 0) {
      missing.push(`部署检查失败：${result.stderr.trim() || result.stdout.trim() || (result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`)}`);
    } else {
      try {
        const command = JSON.parse(result.stdout);
        const index = Array.isArray(command) ? command.indexOf('--diffusion-model') : -1;
        if (index < 0 || typeof command[index + 1] !== 'string') missing.push('部署检查未返回扩散模型路径。');
        else files.model = command[index + 1];
      } catch (error) {
        missing.push(`部署检查返回无效结果：${error.message}`);
      }
    }
  }
  return { root, files, missing };
}

function modelFiles(modelRoot, options, image = false) {
  const status = inspectModelRoot(modelRoot, options, image);
  if (status.missing.length) throw new Error(`缺少运行文件：${status.missing.join('、')}`);
  return { root: status.root, ...status.files };
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
  if (marker.version !== 1 || typeof marker.name !== 'string') throw new Error('不是有效的 MMax Video Studio 工作区。');
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
  settings = validateSettings(settings, true);
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
    .map(entry => {
      const job = readJson(path.join(jobDir(workspace, entry.name), 'job.json'));
      if (job.id !== entry.name) throw new Error('任务编号与目录不一致。');
      return { ...job, ...validateSettings(job) };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function processStillRunning(job, dir) {
  if (!Number.isInteger(job.pid) || job.pid <= 0) return false;
  try {
    const args = fs.readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').split('\0');
    return args.includes(path.join(dir, 'original.webm')) || args.includes(path.join(dir, videoFilename(job)));
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

function videoFilename(job) {
  if (job.kind === 'image') return 'image.png';
  const { format } = validateSettings(job);
  return `video.${format}`;
}

function jobFile(workspace, id, type) {
  if (!['video', 'log'].includes(type)) throw new Error('无效的文件类型。');
  const dir = jobDir(workspace, id);
  const job = readJson(path.join(dir, 'job.json'));
  if (job.id !== id) throw new Error('任务编号与目录不一致。');
  if (type === 'video' && job.status !== 'completed') throw new Error('该任务没有可播放的视频。');
  const file = path.join(dir, type === 'video' ? videoFilename(job) : 'generation.log');
  if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw new Error('任务文件路径无效。');
  return file;
}

function videoUrl(workspace, id) {
  return pathToFileURL(jobFile(workspace, id, 'video')).href;
}

function deleteJob(workspace, id) {
  const dir = jobDir(workspace, id);
  const job = readJson(path.join(dir, 'job.json'));
  if (job.id !== id) throw new Error('任务编号与目录不一致。');
  if (job.status === 'running') throw new Error('画面正在生成，不能删除。');
  fs.rmSync(dir, { recursive: true });
}

function runProcess(command, args, options, log, onOutput, onPid) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let processError;
    let stderr = '';
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
          if (stream === child.stderr) stderr = (stderr + chunk.toString('utf8')).slice(-4096);
          onOutput(chunk.toString('utf8'));
        } catch (error) {
          fail(error);
        }
      });
    }
    child.on('close', (code, signal) => {
      if (processError) reject(processError);
      else if (code === 0) resolve();
      else {
        const details = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/[\r\n]+/)
          .map(line => line.trim()).filter(Boolean).slice(-3).join('；');
        reject(new Error(`进程失败（${signal ? `信号 ${signal}` : `退出码 ${code}`}）${details ? `：${details}。` : '，请查看任务日志。'}`));
      }
    });
    try { onPid(child.pid); } catch (error) { fail(error); }
  });
}

class Generator {
  constructor(modelRoot, notify) {
    this.modelRoot = modelRoot;
    this.notify = notify;
    this.active = false;
    this.options = deployment.validateOptions();
  }

  start(workspace, prompt, input) {
    if (this.active) throw new Error('已有任务正在运行，请等待完成。');
    reconcileJobs(workspace);
    if (loadJobs(workspace).some(job => job.status === 'running')) {
      throw new Error('此工作区的前一个任务仍在运行，请等待其结束后重新打开工作区。');
    }
    prompt = validatePrompt(prompt);
    const settings = validateSettings(input, true);
    const image = settings.kind === 'image';
    const options = deployment.validateOptions(this.options);
    const { root: modelRoot, script, ffmpeg, model } = modelFiles(this.modelRoot, options, image);
    const id = crypto.randomUUID();
    const dir = jobDir(workspace, id);
    fs.mkdirSync(dir);
    const job = {
      id, prompt, ...settings, frames: image ? 1 : framesForDuration(settings.duration), fps: image ? 0 : FPS,
      profile: image ? 'image' : options.profile, steps: image ? 6 : options.steps, model,
      status: 'running', stage: 'preparing', samplingStep: 0, phase: '加载模型与提示词', createdAt: new Date().toISOString()
    };
    writeJson(path.join(dir, 'job.json'), job);
    this.active = true;
    this.execute(workspace, job, dir, modelRoot, script, ffmpeg, options).catch(error => {
      console.error('Unable to finalize generation:', error);
      this.notify({ type: 'error', message: `任务状态保存失败：${error.message}` });
    }).finally(() => { this.active = false; this.notify({ type: 'changed' }); });
    return job;
  }

  async execute(workspace, job, dir, modelRoot, script, ffmpeg, options) {
    const metadata = path.join(dir, 'job.json');
    const log = fs.createWriteStream(path.join(dir, 'generation.log'), { flags: 'a' });
    let logError;
    log.on('error', error => { logError = error; });
    const update = () => { writeJson(metadata, job); this.notify({ type: 'changed' }); };
    const setPid = pid => { job.pid = pid || null; update(); };
    let buffer = '';
    const onOutput = text => {
      if (job.stage === 'decoding') return;
      buffer = (buffer + text).slice(-4096);
      let phase = job.phase;
      let stage = job.stage;
      let samplingStep = job.samplingStep;
      if (buffer.includes('sampling completed')) {
        phase = job.kind === 'image' ? '解码图片' : '解码视频和音频';
        stage = 'decoding';
        samplingStep = job.steps;
      }
      else {
        const matches = [...buffer.matchAll(new RegExp(`\\|\\s*(\\d+)\\/${job.steps}\\s*-\\s*[\\d.]+\\s*(?:s/it|it/s)`, 'g'))];
        if (matches.length && stage !== 'decoding') {
          samplingStep = Math.min(job.steps, Math.max(samplingStep, ...matches.map(match => Number(match[1]))));
          phase = `采样 ${samplingStep}/${job.steps}`;
          stage = 'sampling';
        }
        else if (buffer.includes('generate_video ')) phase = '准备采样';
      }
      if (phase !== job.phase || stage !== job.stage || samplingStep !== job.samplingStep) {
        Object.assign(job, { phase, stage, samplingStep });
        update();
      }
    };
    const image = job.kind === 'image';
    const raw = path.join(dir, image ? 'image.png' : 'original.webm');
    const final = path.join(dir, videoFilename(job));
    try {
      const env = { ...deployment.environment(modelRoot, options), TMPDIR: dir };
      const args = image ? [path.join(modelRoot, 'deploy.py'), 'generate-image', '--width', String(job.width), '--height', String(job.height),
        '--seed', String(job.seed), '--', job.prompt, raw] :
        [script, '--profile', job.profile, '--steps', String(job.steps), '--width', String(job.width), '--height', String(job.height),
          '--video-frames', String(job.frames), '--seed', String(job.seed), '--', job.prompt, raw];
      await runProcess(image ? 'python3' : 'bash', args,
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }, log, onOutput, setPid);
      if (logError) throw logError;
      if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) throw new Error('推理结束但没有生成输出文件。');
      if (image) {
        job.status = 'completed';
        job.stage = 'completed';
        job.phase = '图片已生成';
        return;
      }
      job.phase = `导出 ${job.format.toUpperCase()}${job.audio ? '（含声音）' : '（仅画面）'}`;
      job.stage = 'encoding';
      update();
      const ffenv = ffmpegEnvironment(modelRoot, ffmpeg, dir);
      const videoArgs = job.format === 'mp4'
        ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        : ['-c:v', 'copy'];
      const audioArgs = job.audio
        ? ['-map', '0:a:0', '-c:a', job.format === 'mp4' ? 'aac' : 'libopus', '-b:a', '128k']
        : ['-an'];
      await runProcess(ffmpeg, ['-v', 'error', '-n', '-i', raw, '-t', String(job.duration),
        '-map', '0:v:0', ...videoArgs, ...audioArgs, final],
      { cwd: dir, env: ffenv, stdio: ['ignore', 'pipe', 'pipe'] }, log, () => {}, setPid);
      if (logError) throw logError;
      if (!fs.existsSync(final) || fs.statSync(final).size === 0) throw new Error('格式转换后没有生成视频。');
      job.status = 'completed';
      job.stage = 'completed';
      job.phase = '已完成';
    } catch (error) {
      job.status = 'failed';
      job.stage = 'failed';
      job.phase = '失败';
      job.error = error.message;
    } finally {
      await new Promise(resolve => {
        if (log.destroyed) resolve();
        else log.end(resolve);
      });
      if (logError) {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = `日志写入失败：${logError.message}`;
      }
      job.pid = null;
      job.finishedAt = new Date().toISOString();
      update();
    }
  }
}

module.exports = { DEFAULTS, Generator, createWorkspace, workspaceAt, saveSettings, loadJobs, reconcileJobs, videoUrl, jobFile, deleteJob, validateSettings, validatePrompt, modelFiles, inspectModelRoot, framesForDuration };
