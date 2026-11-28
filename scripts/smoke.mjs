import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import workspaceApi from '../src/workspace.js';
import deployment from '../src/deployment.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const binary = process.env.MMAX_SMOKE_BINARY || path.join(root, `dist/mmax-video-studio-${version}-linux-x64/mmax-video-studio`);
if (!fs.existsSync(binary)) throw new Error('Run npm run package:linux before the smoke test.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mmax-release-smoke-'));
const config = path.join(temporary, 'config');
const profile = path.join(config, 'mmax-video');
const model = path.join(temporary, 'model');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(path.join(model, 'build-deps/root/usr/bin'), { recursive: true });
fs.writeFileSync(path.join(model, 'deploy.py'),
  `import json,sys,os,time
profile = sys.argv[sys.argv.index("--profile")+1] if "--profile" in sys.argv else "hyperflow"
if sys.argv[1] == "inspect":
 print(json.dumps({"schema_version":1,"settings":dict.fromkeys(${JSON.stringify(deployment.PATH_KEYS)}, "/configured/path") | {"profile":profile},"engine_commit":"smoke","capabilities":{"backend":"cuda","fps":24,"width_height":{"min":256,"max":1344,"multiple":32},"frames":{"min":124,"max":345},"max_prompt_characters":7000}}))
elif sys.argv[1] == "generate":
 print(json.dumps(["sd-cli","--diffusion-model","/configured/"+profile+".gguf"]))
else:
 print("operation", sys.argv[1:], flush=True)
 print("models", os.environ.get("MINIMAX_H3_MODEL_DIR"), flush=True)
 time.sleep(1)
`);
fs.writeFileSync(path.join(model, 'generate.sh'), '#!/bin/sh\nprintf "%s\\n" "$@" > inference-args.txt\nfor last do :; done\nprintf "raw" > "$last"\n');
fs.writeFileSync(path.join(model, 'build-deps/root/usr/bin/ffmpeg'),
  '#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\nfor last do :; done\nprintf "video" > "$last"\n', { mode: 0o755 });
const workspace = workspaceApi.createWorkspace(temporary, 'Smoke test', model);
fs.writeFileSync(path.join(profile, 'model-root.json'), JSON.stringify({ root: model }));
fs.writeFileSync(path.join(profile, 'last-workspace.json'), JSON.stringify({ root: workspace.root }));
for (let index = 0; index < 6; index++) {
  const id = randomUUID();
  const dir = path.join(workspace.root, 'jobs', id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    ...workspace.settings, ...(index === 0 ? { width: 1920, duration: 15 } : {}),
    id, prompt: `Smoke scene ${index + 1}`, status: 'failed',
    error: 'Smoke fixture: no GPU inference is performed.', createdAt: new Date(1700000000000 + index * 1000).toISOString()
  }));
}

let application;
try {
  application = await electron.launch({
    executablePath: binary, args: ['--disable-gpu', '--force-device-scale-factor=1'],
    env: { ...process.env, XDG_CONFIG_HOME: config }, timeout: 30000
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('workspace-name')?.textContent === 'Smoke test');
  assert.equal(await page.title(), 'MMax Video Studio');
  await page.locator('#toggle-view').click();
  assert.equal(await page.locator('.timeline-node').count(), 6);
  assert.equal(await page.locator('#timeline-links path').count(), 5);
  const positions = await page.locator('.timeline-node').evaluateAll(nodes => nodes.map(node => new DOMMatrix(node.style.transform).f));
  assert.ok(new Set(positions).size > 1, 'canvas layout must be two-dimensional');
  const scale = () => page.locator('#timeline-world').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a);
  const before = await scale();
  await page.locator('#canvas-zoom-in').click();
  assert.ok(await scale() > before);
  await page.locator('#canvas-reset').click();
  assert.equal(await scale(), 1);
  await page.locator('#canvas-fit').click();
  const viewport = await page.locator('#timeline-canvas').boundingBox();
  for (const node of await page.locator('.timeline-node').all()) {
    const rect = await node.boundingBox();
    assert.ok(rect.x >= viewport.x && rect.y >= viewport.y && rect.x + rect.width <= viewport.x + viewport.width + 1 && rect.y + rect.height <= viewport.y + viewport.height + 1);
  }
  const handle = await page.locator('.canvas-drag').first().boundingBox();
  const first = page.locator('.timeline-node').first();
  const original = await first.getAttribute('style');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 70, handle.y + 40, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(await first.getAttribute('style'), original);
  await page.locator('#canvas-fit').click();
  await page.locator('.timeline-open').first().click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Smoke scene 1');
  assert.equal(await page.locator('#width').inputValue(), '1920');
  assert.equal(await page.locator('#duration').inputValue(), '15');
  assert.equal(await page.locator('#width').getAttribute('max'), '1344');
  assert.equal(await page.locator('#duration option[value="15"]').isDisabled(), true);
  await page.locator('#new-scene').click();
  await page.locator('#prompt').fill('test');
  await page.locator('#width').fill('1376');
  await page.locator('#generate').click();
  assert.match(await page.locator('#notice').textContent(), /1344/);
  await page.locator('#width').fill('640');
  await page.locator('#prompt').fill('🦊'.repeat(7000));
  assert.equal(await page.locator('#prompt-count').textContent(), '7000 / 7000');
  assert.equal((await page.locator('#prompt').inputValue()).length, 14000);
  await page.locator('#prompt').fill('x'.repeat(7001));
  assert.equal(await page.locator('#prompt-count').textContent(), '7001 / 7000');
  await page.locator('#generate').click();
  assert.match(await page.locator('#notice').textContent(), /7000/);
  await page.locator('#prompt').fill('Keep my draft');
  await page.locator('#toggle-view').click();
  await page.locator('#toggle-view').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep my draft');
  await page.locator('#duration').selectOption('14');
  await page.locator('#generate').click();
  await page.waitForFunction(() => document.getElementById('scene-status')?.textContent.includes('已完成'));
  const generated = workspaceApi.loadJobs(workspace).find(job => job.prompt === 'Keep my draft');
  assert.equal(generated.duration, 14);
  assert.equal(generated.frames, 345);
  assert.equal(generated.status, 'completed');
  await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.getElementById('model-status')?.classList.contains('ready'));
  assert.match(await page.locator('#model-status').textContent(), /\/configured\/hyperflow\.gguf/);
  await page.locator('#profile').selectOption('standard');
  assert.equal(await page.locator('#steps').inputValue(), '20');
  assert.equal(await page.locator('#steps').isDisabled(), false);
  await page.locator('#steps').fill('12');
  await page.locator('#MINIMAX_H3_MODEL_DIR').fill('custom-models');
  assert.equal(await page.locator('#doctor').isDisabled(), true);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state')?.textContent === '已保存');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'model-root.json'), 'utf8')).options.steps, 12);
  await page.locator('#doctor').click();
  assert.equal(await page.locator('#save').isDisabled(), true);
  assert.equal(await page.locator('#choose-model').isDisabled(), true);
  const blocked = await page.evaluate(async () => {
    try { await window.mmax.start('blocked', { width: 640, height: 384, seed: -1 }); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(blocked, /正在运行/);
  await page.locator('#back').click();
  await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.getElementById('operation-status')?.textContent.includes('完成'));
  assert.match(await page.locator('#operation-log').textContent(), /custom-models/);
  assert.equal(await page.locator('#download').isDisabled(), true);
  await page.locator('#profile').selectOption('hyperflow');
  assert.equal(await page.locator('#steps').inputValue(), '6');
  assert.equal(await page.locator('#steps').isDisabled(), true);
  await page.locator('#discard').click();
  assert.equal(await page.locator('#profile').inputValue(), 'standard');
  await page.locator('#back').click();
  await page.waitForSelector('#toggle-view');
  assert.match(await page.locator('#deployment-summary').textContent(), /standard.*12/);
  await page.locator('#new-scene').click();
  await page.locator('#prompt').fill('Standard scene');
  await page.locator('#generate').click();
  await page.waitForFunction(() => document.getElementById('scene-status')?.textContent.includes('已完成'));
  const standard = workspaceApi.loadJobs(workspace).find(job => job.prompt === 'Standard scene');
  assert.equal(standard.profile, 'standard');
  assert.equal(standard.steps, 12);
  const inferenceArgs = fs.readFileSync(path.join(workspace.root, 'jobs', standard.id, 'inference-args.txt'), 'utf8').trim().split('\n');
  assert.equal(inferenceArgs[inferenceArgs.indexOf('--profile') + 1], 'standard');
  assert.equal(inferenceArgs[inferenceArgs.indexOf('--steps') + 1], '12');
  await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.getElementById('profile')?.value === 'standard');
  assert.equal(await page.locator('#steps').inputValue(), '12');
  assert.equal(await page.locator('#MINIMAX_H3_MODEL_DIR').inputValue(), 'custom-models');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator('#build').click();
  await page.waitForFunction(() => document.getElementById('operation-status')?.textContent.includes('完成'));
  assert.match(await page.locator('#operation-log').textContent(), /build.*--jobs.*2/);
  await page.locator('#accept-license').check();
  await page.locator('#download-profile').selectOption('all');
  await page.locator('#download').click();
  await page.waitForFunction(() => document.getElementById('operation-status')?.textContent.includes('完成'));
  assert.match(await page.locator('#operation-log').textContent(), /download.*all.*--accept-license/);
  await application.close();
  application = await electron.launch({
    executablePath: binary, args: ['--disable-gpu', '--force-device-scale-factor=1'],
    env: { ...process.env, XDG_CONFIG_HOME: config }, timeout: 30000
  });
  const restarted = await application.firstWindow();
  restarted.on('pageerror', error => errors.push(error.message));
  await restarted.locator('#open-settings').click();
  await restarted.waitForFunction(() => document.getElementById('profile')?.value === 'standard');
  assert.equal(await restarted.locator('#steps').inputValue(), '12');
  assert.equal(await restarted.locator('#MINIMAX_H3_MODEL_DIR').inputValue(), 'custom-models');
  assert.deepEqual(errors, [], 'packaged renderer must not throw');
  console.log('Packaged Electron smoke test passed: legacy records, validated generation, canvas, draft and settings.');
} finally {
  try { if (application) await application.close(); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
