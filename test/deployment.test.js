'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_OPTIONS, validateOptions, environment, inspect, DeploymentTask, PATH_KEYS } = require('../src/deployment');
const { inspectModelRoot } = require('../src/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmax-deployment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('deployment overrides are validated, scoped and resolved against the deployment root', t => {
  const root = fixture(t);
  const original = process.env.CUDA_HOME;
  const value = validateOptions({ ...DEFAULT_OPTIONS, env: { CUDA_HOME: 'cuda', MINIMAX_H3_MODEL_DIR: 'weights', HF_ENDPOINT: 'https://example.test' } });
  const env = environment(root, value);
  assert.equal(env.CUDA_HOME, path.join(root, 'cuda'));
  assert.equal(env.MINIMAX_H3_MODEL_DIR, 'weights');
  assert.equal(env.MINIMAX_H3_BACKEND, 'cuda');
  assert.equal(process.env.CUDA_HOME, original);
  assert.throws(() => validateOptions({ ...DEFAULT_OPTIONS, steps: 20 }), /6/);
  for (const changes of [
    { profile: 'vulkan' }, { env: { LD_PRELOAD: '/untrusted' } }, { env: { HF_ENDPOINT: 'http://example.test' } },
    { env: { MINIMAX_H3_CUDA_ARCHITECTURES: '86;garbage' } }, { ffmpeg: 'bad\0path' }
  ]) assert.throws(() => validateOptions({ ...DEFAULT_OPTIONS, ...changes }));
  assert.equal(validateOptions({ profile: 'standard', steps: 1 }).steps, 1);
});

test('inspection requires the versioned deployment contract and works without model files', t => {
  const root = fixture(t);
  const settings = Object.fromEntries(PATH_KEYS.map(key => [key, path.join(root, key)]));
  fs.writeFileSync(path.join(root, 'deploy.py'), `import json,sys\nprint(json.dumps(${JSON.stringify(JSON.stringify({
    schema_version: 1, settings: { ...settings, profile: 'standard' }, capabilities: { backend: 'cuda' }
  }))}))\n`);
  assert.throws(() => inspect(root, { profile: 'standard', steps: 20 }), /格式不兼容/);
  fs.writeFileSync(path.join(root, 'deploy.py'), `print(${JSON.stringify(JSON.stringify({
    schema_version: 1, settings: { ...settings, profile: 'standard' }, capabilities: { backend: 'cuda' }
  }))})\n`);
  assert.equal(inspect(root, { profile: 'standard', steps: 20 }).settings.sd_cli, settings.sd_cli);
  fs.writeFileSync(path.join(root, 'deploy.py'), 'import sys\nprint("invalid configuration",file=sys.stderr)\nsys.exit(1)\n');
  assert.throws(() => inspect(root), /invalid configuration/);
});

test('an explicitly configured FFmpeg never silently falls back to another binary', t => {
  const root = fixture(t);
  const status = inspectModelRoot(root, { ...DEFAULT_OPTIONS, ffmpeg: 'not-installed' });
  assert.equal(status.files.ffmpeg, null);
  assert.ok(status.missing.some(message => message.includes('not-installed')));
});

test('maintenance runs real CLI arguments asynchronously with scoped settings, locks and durable failure logs', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'deploy.py'),
    'import sys,time,os\nprint("ARGS",sys.argv[1:],flush=True)\nprint("MODELS",os.environ.get("MINIMAX_H3_MODEL_DIR"),flush=True)\ntime.sleep(.05)\nif sys.argv[1]=="build":\n print("compiler missing",file=sys.stderr)\n sys.exit(2)\n');
  let done;
  const task = new DeploymentTask(path.join(root, 'operation.log'), () => { if (!task.state.running && done) done(); });
  const options = { ...DEFAULT_OPTIONS, env: { MINIMAX_H3_MODEL_DIR: 'custom-models' } };
  assert.throws(() => task.start(root, options, 'download', { profile: 'all' }), /许可证/);
  assert.throws(() => task.start(root, options, 'build', { jobs: 0 }), /并行数/);
  assert.throws(() => task.start(root, options, 'arbitrary', {}), /不支持/);
  for (const [action, input] of [['doctor', { checksum: true }], ['download', { profile: 'all', acceptLicense: true }], ['build', { jobs: 2 }]]) {
    const completed = new Promise(resolve => { done = resolve; });
    task.start(root, options, action, input);
    assert.equal(task.state.running, true);
    assert.throws(() => task.start(root, options, 'doctor'), /正在运行/);
    await completed;
    assert.match(task.state.output, /custom-models/);
    if (action === 'doctor') assert.match(task.state.output, /--checksum/);
    if (action === 'download') assert.match(task.state.output, /all.*--accept-license/);
    assert.equal(task.state.status, action === 'build' ? 'failed' : 'completed');
    assert.equal(fs.readFileSync(task.logFile, 'utf8'), task.state.output);
  }
  assert.match(task.state.output, /compiler missing/);
  assert.match(task.state.error, /2/);
});
