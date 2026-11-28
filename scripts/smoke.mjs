import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import workspaceApi from '../src/workspace.js';

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
  'import json, sys\nassert "--dry-run" in sys.argv and sys.argv[sys.argv.index("--profile") + 1] == "hyperflow"\nprint(json.dumps(["sd-cli", "--diffusion-model", "/configured/hyperflow.gguf"]))\n');
fs.writeFileSync(path.join(model, 'generate.sh'), '#!/bin/sh\nfor last do :; done\nprintf "raw" > "$last"\n');
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
  await page.locator('#back').click();
  await page.waitForSelector('#toggle-view');
  assert.deepEqual(errors, [], 'packaged renderer must not throw');
  console.log('Packaged Electron smoke test passed: legacy records, validated generation, canvas, draft and settings.');
} finally {
  try { if (application) await application.close(); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
