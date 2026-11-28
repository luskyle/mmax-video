'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const PATH_KEYS = ['model_dir', 'source_dir', 'build_dir', 'sd_cli', 'runtime_dir', 'diffusion_model', 'text_encoder', 'video_vae', 'audio_vae', 'image_model', 'image_vae'];
const ENV_KEYS = [...PATH_KEYS.map(key => `MINIMAX_H3_${key.toUpperCase()}`), 'CUDA_HOME', 'MINIMAX_H3_CUDA_ARCHITECTURES', 'HF_ENDPOINT'];
const DEFAULT_OPTIONS = { profile: 'hyperflow', steps: 6, env: {}, ffmpeg: '' };

function validateOptions(input = DEFAULT_OPTIONS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['profile', 'steps', 'env', 'ffmpeg'].includes(key))) {
    throw new Error('部署选项无效。');
  }
  const { profile, steps, env = {}, ffmpeg = '' } = input;
  if (!['standard', 'hyperflow'].includes(profile)) throw new Error('请选择 Standard 或 HyperFlow 预设。');
  if (!Number.isInteger(steps) || steps < 1 || steps > 20 || (profile === 'hyperflow' && steps !== 6)) {
    throw new Error('Standard 支持 1–20 步；HyperFlow 必须为 6 步。');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('环境配置无效。');
  const cleaned = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEYS.includes(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error(`不支持的部署环境配置：${key}`);
    if (value.trim()) cleaned[key] = value.trim();
  }
  if (cleaned.MINIMAX_H3_CUDA_ARCHITECTURES && !/^\d+(;\d+)*$/.test(cleaned.MINIMAX_H3_CUDA_ARCHITECTURES)) {
    throw new Error('CUDA 架构须为数字列表，例如 86 或 86;89。');
  }
  if (cleaned.HF_ENDPOINT) {
    let url;
    try { url = new URL(cleaned.HF_ENDPOINT); } catch { throw new Error('模型下载地址必须为 HTTPS URL。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('模型下载地址必须为不含凭据、查询或片段的 HTTPS URL。');
    }
  }
  if (typeof ffmpeg !== 'string' || /[\0\r\n]/.test(ffmpeg)) throw new Error('FFmpeg 路径无效。');
  return { profile, steps, env: cleaned, ffmpeg: ffmpeg.trim() };
}

function resolvePath(root, value) {
  if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(root, value);
}

function environment(root, input = DEFAULT_OPTIONS) {
  const options = validateOptions(input);
  const env = { ...process.env, ...options.env, MINIMAX_H3_BACKEND: 'cuda' };
  // The Python deployment resolves model paths itself; CUDA_HOME is relative to cwd.
  if (env.CUDA_HOME) env.CUDA_HOME = resolvePath(root, env.CUDA_HOME);
  return env;
}

function inspect(root, input = DEFAULT_OPTIONS) {
  const options = validateOptions(input);
  const result = spawnSync('python3', [path.join(root, 'deploy.py'), 'inspect', '--profile', options.profile], {
    cwd: root, env: environment(root, options), encoding: 'utf8', timeout: 10000
  });
  if (result.error) throw new Error(`无法读取部署配置：${result.error.message}`);
  if (result.status !== 0) throw new Error(`无法读取部署配置（请更新 minimax-deploy）：${result.stderr.trim() || result.signal || result.status}`);
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new Error('部署配置返回无效 JSON，请更新 minimax-deploy。'); }
  if (info?.schema_version !== 1 || info.capabilities?.backend !== 'cuda' ||
      !info.settings || PATH_KEYS.some(key => typeof info.settings[key] !== 'string') ||
      info.settings.profile !== options.profile) throw new Error('部署配置格式不兼容，请更新 minimax-deploy。');
  return info;
}

function operationArgs(action, options, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('部署操作参数无效。');
  if (action === 'doctor') {
    if (input.checksum !== undefined && typeof input.checksum !== 'boolean') throw new Error('校验选项无效。');
    if (input.image !== undefined && typeof input.image !== 'boolean') throw new Error('图片诊断选项无效。');
    return ['doctor', '--profile', input.image === true ? 'image' : options.profile, ...(input.checksum ? ['--checksum'] : [])];
  }
  if (action === 'build') {
    if (!Number.isInteger(input.jobs) || input.jobs < 1 || input.jobs > 256) throw new Error('构建并行数须为 1–256。');
    return ['build', '--jobs', String(input.jobs)];
  }
  if (action === 'download') {
    if (input.acceptLicense !== true) throw new Error('请先阅读并确认模型许可证。');
    if (!['standard', 'hyperflow', 'image', 'all'].includes(input.profile)) throw new Error('下载预设无效。');
    return ['download', '--profile', input.profile, '--accept-license'];
  }
  throw new Error('不支持的部署操作。');
}

class DeploymentTask {
  constructor(logFile, notify) {
    this.logFile = logFile;
    this.notify = notify;
    this.state = { running: false, action: null, status: 'idle', output: '' };
  }

  start(root, inputOptions, action, input) {
    if (this.state.running) throw new Error('已有部署操作正在运行。');
    const options = validateOptions(inputOptions);
    const args = operationArgs(action, options, input);
    const fd = fs.openSync(this.logFile, 'w');
    this.state = { running: true, action, status: 'running', output: '', startedAt: new Date().toISOString() };
    const child = spawn('python3', ['-u', path.join(root, 'deploy.py'), ...args], {
      cwd: root, env: environment(root, options), stdio: ['ignore', 'pipe', 'pipe']
    });
    let failure;
    const fail = error => {
      failure = error.message;
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    };
    child.on('error', fail);
    const append = chunk => {
      try {
        fs.writeSync(fd, chunk);
        this.state.output = (this.state.output + chunk.toString('utf8')).slice(-64000);
        this.notify();
      } catch (error) { fail(error); }
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('error', fail);
      stream.on('data', append);
    }
    child.on('close', (code, signal) => {
      try { fs.closeSync(fd); } catch (error) { failure = error.message; }
      this.state.running = false;
      this.state.status = code === 0 && !failure ? 'completed' : 'failed';
      this.state.error = failure || (code !== 0 ? `部署操作失败（${signal || `退出码 ${code}`}），请查看下方日志。` : null);
      this.state.finishedAt = new Date().toISOString();
      this.notify();
    });
    this.notify();
    return this.state;
  }
}

module.exports = { PATH_KEYS, DEFAULT_OPTIONS, validateOptions, resolvePath, environment, inspect, DeploymentTask };
