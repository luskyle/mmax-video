import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release target requires Linux x64.');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Debian release version must be numeric major.minor.patch.');
const name = `mmax-video-studio-${manifest.version}-linux-x64`;
const dist = path.join(root, 'dist');
const destination = path.join(dist, name);
const electron = path.join(root, 'node_modules/electron/dist');
if (!fs.existsSync(path.join(electron, 'electron'))) throw new Error('Electron binary is missing. Run npm run install:electron.');

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(electron, destination, { recursive: true });
fs.renameSync(path.join(destination, 'electron'), path.join(destination, 'mmax-video-studio'));
fs.renameSync(path.join(destination, 'LICENSE'), path.join(destination, 'LICENSE.electron'));
fs.rmSync(path.join(destination, 'resources/default_app.asar'), { force: true });
const app = path.join(destination, 'resources/app');
fs.mkdirSync(app, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, description: manifest.description, main: manifest.main, private: true
}, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'README.md'), path.join(destination, 'README.md'));
fs.cpSync(path.join(root, 'docs'), path.join(destination, 'docs'), { recursive: true });
fs.chmodSync(path.join(destination, 'mmax-video-studio'), 0o755);

const archive = path.join(dist, `${name}.tar.gz`);
execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', dist, name], { stdio: 'inherit' });
const stage = path.join(dist, `${name}-deb-stage`);
const deb = path.join(dist, `mmax-video-studio_${manifest.version}_amd64.deb`);
fs.rmSync(stage, { recursive: true, force: true });
try {
  const control = path.join(stage, 'DEBIAN');
  const binaryDir = path.join(stage, 'usr/bin');
  const installDir = path.join(stage, 'opt/mmax-video-studio');
  fs.mkdirSync(control, { recursive: true });
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.cpSync(destination, installDir, { recursive: true });
  fs.symlinkSync('/opt/mmax-video-studio/mmax-video-studio', path.join(binaryDir, 'mmax-video-studio'));
  fs.writeFileSync(path.join(control, 'control'), [
    'Package: mmax-video-studio',
    `Version: ${manifest.version}`,
    'Section: video',
    'Priority: optional',
    'Architecture: amd64',
    'Maintainer: MMax Video Studio contributors <844804539@qq.com>',
    'Homepage: https://github.com/luskyle/mmax-video',
    'Depends: libasound2t64 | libasound2, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatk1.0-0t64 | libatk1.0-0, libatspi2.0-0t64 | libatspi2.0-0, libc6 (>= 2.35), libcairo2, libcups2t64 | libcups2, libdbus-1-3, libexpat1, libgbm1, libglib2.0-0t64 | libglib2.0-0, libgtk-3-0t64 | libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libudev1, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2',
    'Description: Local MiniMax H3 video creation studio',
    ' Electron desktop application with an interactive video canvas.',
    ' MiniMax, CUDA and FFmpeg must be installed separately.',
    ''
  ].join('\n'));
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, deb], { stdio: 'inherit' });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
const checksums = [];
for (const file of [archive, deb]) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${path.basename(file)}`);
}
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), checksums.join('\n') + '\n');
console.log(`Packaged ${archive} and ${deb}`);
