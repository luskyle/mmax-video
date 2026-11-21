import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deb = path.join(root, `dist/mmax-video-studio_${version}_amd64.deb`);
const field = name => execFileSync('dpkg-deb', ['--field', deb, name], { encoding: 'utf8' }).trim();
assert.equal(field('Package'), 'mmax-video-studio');
assert.equal(field('Version'), version);
assert.equal(field('Architecture'), 'amd64');
assert.match(field('Depends'), /libnss3/);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mmax-deb-test-'));
try {
  const database = path.join(temporary, 'var/lib/dpkg');
  fs.mkdirSync(path.join(database, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(database, 'status'), '');
  const dpkg = ['--root', temporary, '--force-not-root', '--force-depends'];
  execFileSync('dpkg', [...dpkg, '--install', deb], { stdio: 'inherit' });
  const installed = path.join(temporary, 'opt/mmax-video-studio/mmax-video-studio');
  assert.ok(fs.statSync(installed).isFile());
  assert.equal(fs.readlinkSync(path.join(temporary, 'usr/bin/mmax-video-studio')), '/opt/mmax-video-studio/mmax-video-studio');
  assert.equal(fs.existsSync(path.join(temporary, 'usr/share/applications/mmax-video.desktop')), false);
  execFileSync(process.execPath, [path.join(root, 'scripts/smoke.mjs')], {
    stdio: 'inherit', env: { ...process.env, MMAX_SMOKE_BINARY: installed }
  });
  execFileSync('dpkg', [...dpkg, '--remove', 'mmax-video-studio'], { stdio: 'inherit' });
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.existsSync(path.join(temporary, 'usr/bin/mmax-video-studio')), false);
  console.log('Debian package install, application launch and removal passed in an isolated root.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
