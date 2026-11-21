'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DEFAULTS, createWorkspace, workspaceAt, saveSettings, loadJobs, reconcileJobs, videoUrl, jobFile, deleteJob, Generator, modelFiles, inspectModelRoot, validateSettings } = require('../src/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmax-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, 'model');
  fs.mkdirSync(path.join(model, 'models/diffusion_models'), { recursive: true });
  fs.mkdirSync(path.join(model, 'build-deps/root/usr/bin'), { recursive: true });
  fs.writeFileSync(path.join(model, 'models/diffusion_models/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf'), 'model');
  return { root, model };
}

function waitForCompletion(generator) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(interval); reject(new Error('generation timed out')); }, 10000);
    const interval = setInterval(() => {
      if (!generator.active) { clearTimeout(timer); clearInterval(interval); resolve(); }
    }, 20);
  });
}

test('workspaces persist settings and reject invalid locations and dimensions', t => {
  const { root, model } = fixture(t);
  const workspace = createWorkspace(root, '测试空间', model);
  const settings = { width: 1088, height: 608, seed: 42, duration: 10, format: 'mp4', audio: false };
  saveSettings(workspace, settings);
  assert.deepEqual(workspaceAt(workspace.root, model).settings, settings);
  assert.throws(() => saveSettings(workspace, { width: 1080, height: 608, seed: 42 }), /32/);
  assert.throws(() => createWorkspace(model, 'unsafe', model), /MiniMax/);
  assert.throws(() => createWorkspace(root, '../escape', model), /名称/);
  assert.throws(() => createWorkspace(root, '测试空间', model));
  for (const invalid of [{ duration: 6 }, { duration: null }, { format: 'avi' }, { format: '../mp4' }, { audio: 'false' }]) {
    assert.throws(() => validateSettings({ ...settings, ...invalid }), /时长|格式|音频/);
  }
});

test('old workspace settings and jobs retain playable WebM outputs', t => {
  const { root, model } = fixture(t);
  const workspace = createWorkspace(root, 'legacy', model);
  const settings = { width: 640, height: 384, seed: 42 };
  fs.writeFileSync(path.join(workspace.root, '.mmax-workspace.json'), JSON.stringify({ version: 1, name: 'legacy', settings }));
  const id = crypto.randomUUID();
  const dir = path.join(workspace.root, 'jobs', id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, ...settings, status: 'completed', prompt: 'legacy', createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'video.webm'), 'legacy video');
  assert.deepEqual(workspaceAt(workspace.root, model).settings, { ...DEFAULTS, ...settings });
  const [job] = loadJobs(workspace);
  assert.equal(job.audio, true);
  assert.equal(job.duration, 5);
  assert.equal(job.format, 'webm');
  assert.equal(jobFile(workspace, id, 'video'), path.join(dir, 'video.webm'));
  assert.match(videoUrl(workspace, id), /video\.webm$/);
});

test('MiniMax directory must contain the files needed to generate video', t => {
  const { model } = fixture(t);
  const script = path.join(model, 'generate.sh');
  const ffmpeg = path.join(model, 'build-deps/root/usr/bin/ffmpeg');
  assert.notEqual(inspectModelRoot(model).missing.length, 0);
  fs.writeFileSync(script, '');
  fs.writeFileSync(ffmpeg, '');
  assert.equal(modelFiles(model).root, fs.realpathSync(model));
  assert.equal(inspectModelRoot(model).missing.length, 0);
  fs.rmSync(ffmpeg);
  assert.throws(() => modelFiles(model), /缺少运行文件/);
});

test('successful jobs keep all outputs and logs in the workspace', async t => {
  const { root, model } = fixture(t);
  fs.writeFileSync(path.join(model, 'generate.sh'), '#!/bin/bash\nprintf "sampling completed\\n"\nprintf "raw" > "$2"\n');
  const ffmpeg = path.join(model, 'build-deps/root/usr/bin/ffmpeg');
  fs.writeFileSync(ffmpeg, '#!/bin/bash\nprintf "converted" > "${@: -1}"\n', { mode: 0o755 });
  const workspace = createWorkspace(root, 'videos', model);
  const generator = new Generator(model, () => {});
  const job = generator.start(workspace, 'a panda', { width: 640, height: 384, seed: 42 });
  assert.throws(() => generator.start(workspace, 'another', workspace.settings), /正在运行/);
  await waitForCompletion(generator);
  const [finished] = loadJobs(workspace);
  assert.equal(finished.status, 'completed');
  const dir = path.join(workspace.root, 'jobs', job.id);
  assert.equal(fs.readFileSync(path.join(dir, 'video.webm'), 'utf8'), 'converted');
  assert.match(fs.readFileSync(path.join(dir, 'generation.log'), 'utf8'), /sampling completed/);
  assert.match(videoUrl(workspace, job.id), /video\.webm$/);
  assert.deepEqual(fs.readdirSync(model).sort(), ['build-deps', 'generate.sh', 'models']);
  assert.throws(() => videoUrl(workspace, '../escape'), /编号/);
});

test('duration, format and audio choices control inference and export arguments', async t => {
  for (const settings of [
    { ...DEFAULTS, duration: 5, format: 'webm', audio: true },
    { ...DEFAULTS, duration: 10, format: 'mp4', audio: false },
    { ...DEFAULTS, duration: 15, format: 'mp4', audio: true },
    { ...DEFAULTS, duration: 15, format: 'webm', audio: false }
  ]) {
    await t.test(`${settings.duration}s ${settings.format} audio=${settings.audio}`, async t => {
      const { root, model } = fixture(t);
      fs.writeFileSync(path.join(model, 'generate.sh'), '#!/bin/bash\nprintf "%s\\n" "$@" > inference-args.txt\nprintf "raw" > "$2"\n');
      fs.writeFileSync(path.join(model, 'build-deps/root/usr/bin/ffmpeg'),
        '#!/bin/bash\nprintf "%s\\n" "$@" > export-args.txt\nprintf "converted" > "${@: -1}"\n', { mode: 0o755 });
      const workspace = createWorkspace(root, 'videos', model);
      const generator = new Generator(model, () => {});
      const job = generator.start(workspace, 'a scene', settings);
      await waitForCompletion(generator);
      const dir = path.join(workspace.root, 'jobs', job.id);
      const inference = fs.readFileSync(path.join(dir, 'inference-args.txt'), 'utf8').trim().split('\n');
      const exported = fs.readFileSync(path.join(dir, 'export-args.txt'), 'utf8').trim().split('\n');
      const frames = Number(inference[inference.indexOf('--video-frames') + 1]);
      assert.equal(frames % 17, 5);
      assert.ok(frames >= settings.duration * 24 && frames < settings.duration * 24 + 17);
      assert.equal(inference[inference.indexOf('--fps') + 1], '24');
      assert.equal(exported[exported.indexOf('-t') + 1], String(settings.duration));
      assert.equal(exported[exported.indexOf('-c:v') + 1], settings.format === 'mp4' ? 'libx264' : 'copy');
      assert.equal(exported.includes('0:a:0'), settings.audio);
      assert.equal(exported.includes('-an'), !settings.audio);
      if (settings.audio) assert.equal(exported[exported.indexOf('-c:a') + 1], settings.format === 'mp4' ? 'aac' : 'libopus');
      const [finished] = loadJobs(workspace);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.frames, frames);
      assert.equal(finished.audio, settings.audio);
      assert.equal(jobFile(workspace, job.id, 'video'), path.join(dir, `video.${settings.format}`));
    });
  }
});

test('sampling progress survives split output and remains separate from decoding and export', async t => {
  const { root, model } = fixture(t);
  fs.writeFileSync(path.join(model, 'generate.sh'),
    '#!/bin/bash\nprintf "| 6/6 - 100MB/s\\n| 2/"\nsleep 0.04\nprintf "6 - 1.0s/it\\r| 1/6 - 1.0s/it\\r"\nsleep 0.04\nprintf "sampling completed\\n"\nprintf "raw" > "$2"\n');
  fs.writeFileSync(path.join(model, 'build-deps/root/usr/bin/ffmpeg'), '#!/bin/bash\nprintf "converted" > "${@: -1}"\n', { mode: 0o755 });
  const workspace = createWorkspace(root, 'progress', model);
  const states = [];
  const generator = new Generator(model, () => states.push(loadJobs(workspace)[0]));
  generator.start(workspace, 'a scene', DEFAULTS);
  await waitForCompletion(generator);
  assert.ok(states.some(job => job.stage === 'sampling' && job.samplingStep === 2));
  assert.ok(states.some(job => job.stage === 'decoding' && job.samplingStep === 6));
  assert.ok(states.some(job => job.stage === 'encoding' && job.status === 'running'));
  assert.equal(states.at(-1).stage, 'completed');
});

test('deleting a record removes only its files and rejects running jobs and escaped paths', t => {
  const { root, model } = fixture(t);
  const workspace = createWorkspace(root, 'delete', model);
  const id = crypto.randomUUID();
  const dir = path.join(workspace.root, 'jobs', id);
  fs.mkdirSync(dir);
  const job = { id, ...DEFAULTS, status: 'running', prompt: 'scene', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  fs.writeFileSync(path.join(dir, 'video.webm'), 'video');
  fs.writeFileSync(path.join(dir, 'generation.log'), 'log');
  const keep = path.join(root, 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  assert.throws(() => deleteJob(workspace, id), /不能删除/);
  assert.throws(() => deleteJob(workspace, '../..'), /编号/);
  const alias = crypto.randomUUID();
  fs.symlinkSync(root, path.join(workspace.root, 'jobs', alias));
  assert.throws(() => deleteJob(workspace, alias), /目录无效/);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ ...job, status: 'completed' }));
  deleteJob(workspace, id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(workspace.root, '.mmax-workspace.json')));
});

test('recovery recognizes a still-running MP4 export', async t => {
  const { root, model } = fixture(t);
  const workspace = createWorkspace(root, 'recovery', model);
  const id = crypto.randomUUID();
  const dir = path.join(workspace.root, 'jobs', id);
  fs.mkdirSync(dir);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', path.join(dir, 'video.mp4')]);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  await once(child, 'spawn');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    id, ...DEFAULTS, format: 'mp4', status: 'running', pid: child.pid, prompt: 'scene', createdAt: new Date().toISOString()
  }));
  reconcileJobs(workspace);
  assert.equal(loadJobs(workspace)[0].status, 'running');
  assert.throws(() => deleteJob(workspace, id), /不能删除/);
});

test('failed and interrupted jobs are recorded without success-shaped outputs', async t => {
  const { root, model } = fixture(t);
  fs.writeFileSync(path.join(model, 'generate.sh'), '#!/bin/bash\necho "GPU failure" >&2\nexit 2\n');
  fs.writeFileSync(path.join(model, 'build-deps/root/usr/bin/ffmpeg'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const workspace = createWorkspace(root, 'videos', model);
  const generator = new Generator(model, () => {});
  const job = generator.start(workspace, 'a panda', workspace.settings);
  await waitForCompletion(generator);
  let [failed] = loadJobs(workspace);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /退出码 2/);
  assert.throws(() => videoUrl(workspace, job.id), /没有可播放/);
  failed.status = 'running';
  failed.pid = 2147483647;
  fs.writeFileSync(path.join(workspace.root, 'jobs', job.id, 'job.json'), JSON.stringify(failed));
  reconcileJobs(workspace);
  [failed] = loadJobs(workspace);
  assert.equal(failed.status, 'interrupted');
});
