'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace, workspaceAt, saveSettings, loadJobs, reconcileJobs, videoUrl, Generator } = require('../src/workspace');

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
    const timer = setTimeout(() => reject(new Error('generation timed out')), 10000);
    const interval = setInterval(() => {
      if (!generator.active) { clearTimeout(timer); clearInterval(interval); resolve(); }
    }, 20);
  });
}

test('workspaces persist settings and reject invalid locations and dimensions', t => {
  const { root, model } = fixture(t);
  const workspace = createWorkspace(root, '测试空间', model);
  saveSettings(workspace, { width: 1088, height: 608, seed: 42 });
  assert.deepEqual(workspaceAt(workspace.root, model).settings, { width: 1088, height: 608, seed: 42 });
  assert.throws(() => saveSettings(workspace, { width: 1080, height: 608, seed: 42 }), /32/);
  assert.throws(() => createWorkspace(model, 'unsafe', model), /MiniMax/);
  assert.throws(() => createWorkspace(root, '../escape', model), /名称/);
  assert.throws(() => createWorkspace(root, '测试空间', model));
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
