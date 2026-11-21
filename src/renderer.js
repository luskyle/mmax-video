'use strict';

const $ = id => document.getElementById(id);
let current = { workspace: null, jobs: [], active: false };
let selectedId = null;
let playingId = null;
let busy = false;

function message(text, isError = false) {
  const notice = $('notice');
  notice.textContent = text;
  notice.classList.toggle('error', isError);
  notice.classList.toggle('hidden', !text);
}

function settings() {
  return { width: Number($('width').value), height: Number($('height').value), seed: Number($('seed').value) };
}

function setSettings(value) {
  $('width').value = value.width;
  $('height').value = value.height;
  $('seed').value = value.seed;
  updatePreset();
}

function updatePreset() {
  const key = `${$('width').value}x${$('height').value}`;
  $('preset').value = ['640x384', '960x544', '1088x608'].includes(key) ? key : 'custom';
}

function setBusy(value) {
  busy = value;
  const disabled = busy || current.active;
  $('generate').disabled = disabled || !current.workspace;
  $('new-workspace').disabled = disabled;
  $('open-workspace').disabled = disabled;
  $('save-settings').disabled = busy || !current.workspace;
}

function render(state, resetSettings = false) {
  const previousRoot = current.workspace?.root;
  current = state;
  const workspace = state.workspace;
  $('workspace-name').textContent = workspace?.name || '尚未选择工作区';
  $('workspace-path').textContent = workspace?.root || '创建或打开一个工作区，开始创作。';
  if (workspace && (resetSettings || workspace.root !== previousRoot)) {
    setSettings(workspace.settings);
    selectedId = null;
    playingId = null;
  }
  $('job-count').textContent = state.jobs.length;
  const history = $('history');
  history.replaceChildren();
  if (!state.jobs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '生成的视频会显示在这里。';
    history.append(empty);
  }
  if (!state.jobs.some(job => job.id === selectedId)) selectedId = state.jobs[0]?.id || null;
  for (const job of state.jobs) {
    const button = document.createElement('button');
    button.className = `history-item${job.id === selectedId ? ' selected' : ''}`;
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = job.prompt;
    const info = document.createElement('span');
    info.className = 'history-info';
    info.textContent = `${job.width} × ${job.height}  ·  ${statusText(job)}  ·  ${new Date(job.createdAt).toLocaleString('zh-CN')}`;
    button.append(title, info);
    button.addEventListener('click', () => { selectedId = job.id; render(current); });
    history.append(button);
  }
  const job = state.jobs.find(item => item.id === selectedId);
  $('show-video').disabled = !job || job.status !== 'completed';
  $('show-log').disabled = !job;
  $('job-detail').classList.toggle('hidden', !job);
  $('job-detail').textContent = job ? `${statusText(job)} · ${job.width} × ${job.height} · 种子 ${job.seed}${job.error ? ` · ${job.error}` : ''}` : '';
  if (job?.status === 'completed') {
    $('preview-empty').classList.add('hidden');
    $('preview').classList.remove('hidden');
    if (playingId !== job.id) {
      playingId = job.id;
      window.mmax.video(job.id).then(url => {
        if (selectedId === job.id) $('preview').src = url;
      }).catch(error => message(error.message, true));
    }
  } else {
    playingId = null;
    $('preview').pause();
    $('preview').removeAttribute('src');
    $('preview').classList.add('hidden');
    $('preview-empty').classList.remove('hidden');
    $('preview-empty').querySelector('strong').textContent = job ? statusText(job) : '你的作品将出现在这里';
    $('preview-empty').querySelector('span').textContent = job?.error || (job ? '生成过程和输出文件保存在工作区。' : '生成完成后，可在此播放或在工作区查看文件。');
  }
  setBusy(busy);
}

function statusText(job) {
  return { running: job.phase || '生成中', completed: '已完成', failed: '生成失败', interrupted: '已中断' }[job.status] || job.status;
}

async function action(callback, resetSettings = false) {
  setBusy(true);
  message('');
  try { render(await callback(), resetSettings); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}

$('prompt').addEventListener('input', () => { $('prompt-count').textContent = `${$('prompt').value.length} / 4000`; });
$('preset').addEventListener('change', event => {
  if (event.target.value === 'custom') return;
  const [width, height] = event.target.value.split('x');
  $('width').value = width;
  $('height').value = height;
});
for (const id of ['width', 'height']) $(id).addEventListener('input', updatePreset);
$('new-workspace').addEventListener('click', () => { $('workspace-input').value = ''; $('create-dialog').showModal(); $('workspace-input').focus(); });
$('create-dialog').addEventListener('close', () => {
  if ($('create-dialog').returnValue === 'default') action(() => window.mmax.createWorkspace($('workspace-input').value));
});
$('open-workspace').addEventListener('click', () => action(() => window.mmax.openWorkspace()));
$('save-settings').addEventListener('click', () => action(() => window.mmax.saveSettings(settings()), true));
$('generate').addEventListener('click', () => action(async () => {
  const state = await window.mmax.start($('prompt').value, settings());
  selectedId = state.jobs[0]?.id || null;
  return state;
}));
$('show-video').addEventListener('click', () => window.mmax.show(selectedId, 'video').catch(error => message(error.message, true)));
$('show-log').addEventListener('click', () => window.mmax.show(selectedId, 'log').catch(error => message(error.message, true)));
window.mmax.onEvent(event => {
  if (event.type === 'error') message(event.message, true);
  if (busy) return;
  window.mmax.state().then(state => render(state)).catch(error => message(error.message, true));
});
window.mmax.state().then(state => render(state, true)).catch(error => message(error.message, true));
setInterval(() => {
  if (current.active && !busy) window.mmax.state().then(state => render(state)).catch(error => message(error.message, true));
}, 5000);
