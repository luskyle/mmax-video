import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release target requires Linux x64.');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version.');
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
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${hash.digest('hex')}  ${path.basename(archive)}\n`);
console.log(`Packaged ${archive}`);
