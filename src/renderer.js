'use strict';

import { SceneCanvas } from './canvas.mjs';

const $ = id => document.getElementById(id);
const settingInputs = ['kind', 'preset', 'width', 'height', 'seed', 'duration', 'format', 'audio'];
const presets = { video: ['640x384', '960x544', '1088x608'], image: ['1024x1024', '1344x768', '768x1344', '512x512'] };
let current = { workspace: null, jobs: [], active: false };
let selectedId = null;
let loadedPage = null;
let playingPage = null;
let draft = null;
let busy = false;
let refreshPending = false;
let timelineVisible = false;
let progressJob = null;
let progressUnits = 0;
const timelineEntries = new Map();
const sceneCanvas = new SceneCanvas($('timeline-view'));

function message(text, isError = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', isError);
  $('notice').classList.toggle('hidden', !text);
}

function settings() {
  return {
    kind: $('kind').value,
    width: Number($('width').value), height: Number($('height').value), seed: Number($('seed').value),
    duration: Number($('duration').value), format: $('format').value, audio: $('audio').value === 'on'
  };
}

function setSettings(value) {
  $('kind').value = value.kind || 'video';
  for (const id of ['width', 'height', 'seed', 'duration', 'format']) $(id).value = value[id];
  $('audio').value = value.audio ? 'on' : 'off';
  updateMediaControls();
}

function updateMediaControls() {
  const image = $('kind').value === 'image';
  const choices = presets[$('kind').value];
  $('preset').replaceChildren(...[...choices, 'custom'].map(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'custom' ? '自定义' : value.replace('x', ' × ');
    return option;
  }));
  for (const key of ['width', 'height']) {
    $(key).min = image ? '512' : '256';
    $(key).max = image ? '2048' : '1344';
  }
  document.querySelector('.output-settings').classList.toggle('hidden', image);
  $('image-hint').classList.toggle('hidden', !image);
  $('deployment-summary').classList.toggle('hidden', image);
  updatePreset();
}

function updatePreset() {
  const key = `${$('width').value}x${$('height').value}`;
  $('preset').value = presets[$('kind').value].includes(key) ? key : 'custom';
}

function updatePromptCount() {
  $('prompt-count').textContent = `${[...$('prompt').value].length} / 7000`;
}

function setBusy(value) {
  busy = value;
  const locked = busy || current.active;
  $('generate').disabled = locked || !current.workspace || selectedId !== null;
  $('generate').classList.toggle('hidden', selectedId !== null);
  for (const id of ['new-workspace', 'open-workspace']) $(id).disabled = locked;
  $('open-settings').disabled = busy || (current.active && !current.maintenance?.running);
  $('new-scene').disabled = locked || !current.workspace;
  $('toggle-view').disabled = busy || !current.workspace;
  const readonly = locked || selectedId !== null || !current.workspace;
  $('prompt').readOnly = readonly;
  for (const id of settingInputs) $(id).disabled = readonly;
}

function selectScene(id) {
  if (busy) return;
  if (selectedId === null && current.workspace) draft = { prompt: $('prompt').value, settings: settings() };
  selectedId = id;
  setView(false);
  render(current);
}

function setView(timeline) {
  if (timeline === timelineVisible) return;
  timelineVisible = timeline;
  if (timeline) $('preview').pause();
  else for (const entry of timelineEntries.values()) entry.video.pause();
}

function removeTimelineEntry(id) {
  const entry = timelineEntries.get(id);
  timelineEntries.delete(id);
  entry.video.pause();
  entry.video.removeAttribute('src');
  entry.video.load();
  entry.image.removeAttribute('src');
  entry.node.remove();
}

function showRecordMenu(event, id) {
  event.preventDefault();
  window.mmax.recordMenu(id).catch(error => message(error.message, true));
}

function renderTimeline() {
  const root = current.workspace?.root;
  const jobs = [...current.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const ids = new Set(jobs.map(job => job.id));
  for (const id of timelineEntries.keys()) if (!ids.has(id)) removeTimelineEntry(id);
  $('timeline-count').textContent = `${jobs.length} 个画面`;
  $('timeline-empty').classList.toggle('hidden', jobs.length > 0);
  $('timeline-track').classList.toggle('hidden', jobs.length === 0);
  jobs.forEach((job, index) => {
    let entry = timelineEntries.get(job.id);
    if (!entry) {
      const node = $('timeline-card-template').content.firstElementChild.cloneNode(true);
      node.dataset.jobId = job.id;
      entry = {
        node, card: node.querySelector('.timeline-card'), open: node.querySelector('.timeline-open'),
        video: node.querySelector('video'), image: node.querySelector('img'), placeholder: node.querySelector('.timeline-placeholder'),
        mediaKey: null, mediaError: null
      };
      timelineEntries.set(job.id, entry);
      entry.open.addEventListener('click', () => selectScene(job.id));
      entry.card.addEventListener('contextmenu', event => showRecordMenu(event, job.id));
      entry.video.addEventListener('play', () => {
        $('preview').pause();
        for (const other of timelineEntries.values()) if (other !== entry) other.video.pause();
      });
      entry.video.addEventListener('error', () => {
        if (timelineEntries.get(job.id) !== entry || !current.jobs.some(item => item.id === job.id)) return;
        entry.mediaError = '视频无法播放，请打开该画面查看文件。';
        entry.placeholder.textContent = entry.mediaError;
        entry.placeholder.classList.remove('hidden');
        entry.video.classList.add('hidden');
      });
      entry.image.addEventListener('error', () => {
        if (timelineEntries.get(job.id) !== entry) return;
        entry.mediaError = '图片无法加载，请打开画面查看文件。';
        entry.placeholder.textContent = entry.mediaError;
        entry.placeholder.classList.remove('hidden');
        entry.image.classList.add('hidden');
      });
    }
    if ($('timeline-track').children[index] !== entry.node) {
      $('timeline-track').insertBefore(entry.node, $('timeline-track').children[index] || null);
    }
    entry.card.dataset.status = job.status;
    entry.card.classList.toggle('selected', selectedId === job.id);
    entry.open.setAttribute('aria-label', `打开画面：${job.prompt}`);
    entry.open.title = `打开画面：${job.prompt}`;
    entry.node.querySelector('.canvas-drag').setAttribute('aria-label', `移动画面：${job.prompt}`);
    entry.node.querySelector('.timeline-index').textContent = String(index + 1).padStart(2, '0');
    entry.node.querySelector('.timeline-card-title').textContent = job.prompt;
    entry.node.querySelector('.timeline-meta').textContent = `${job.width} × ${job.height} · ${mediaDescription(job)}`;
    const time = entry.node.querySelector('time');
    time.dateTime = job.createdAt;
    time.textContent = new Date(job.createdAt).toLocaleString('zh-CN');
    const status = entry.node.querySelector('.timeline-status');
    status.textContent = job.error || statusText(job);
    status.title = status.textContent;
    if (job.status === 'completed') {
      const key = `${root}/${job.id}/${job.format}`;
      if (entry.mediaKey !== key) {
        entry.mediaKey = key;
        entry.mediaError = null;
        window.mmax.video(job.id).then(url => {
          if (timelineEntries.get(job.id) === entry && entry.mediaKey === key && current.workspace?.root === root &&
              current.jobs.some(item => item.id === job.id && item.status === 'completed')) {
            (job.kind === 'image' ? entry.image : entry.video).src = url;
          }
        }).catch(error => {
          if (timelineEntries.get(job.id) !== entry || current.workspace?.root !== root ||
              !current.jobs.some(item => item.id === job.id)) return;
          entry.mediaError = error.message;
          entry.placeholder.textContent = error.message;
          entry.placeholder.classList.remove('hidden');
          entry.video.classList.add('hidden');
          entry.image.classList.add('hidden');
        });
      }
      entry.video.classList.toggle('hidden', job.kind === 'image' || Boolean(entry.mediaError));
      entry.image.classList.toggle('hidden', job.kind !== 'image' || Boolean(entry.mediaError));
      entry.placeholder.classList.toggle('hidden', !entry.mediaError);
      if (entry.mediaError) entry.placeholder.textContent = entry.mediaError;
    } else {
      if (entry.mediaKey) {
        entry.video.pause();
        entry.video.removeAttribute('src');
        entry.video.load();
        entry.mediaKey = null;
        entry.mediaError = null;
      }
      entry.video.classList.add('hidden');
      entry.image.classList.add('hidden');
      entry.placeholder.classList.remove('hidden');
      entry.placeholder.textContent = statusText(job);
    }
  });
  sceneCanvas.sync(jobs.map(job => timelineEntries.get(job.id).node));
}

function statusText(job) {
  return { running: job.phase || '生成中', completed: '已完成', failed: '生成失败', interrupted: '已中断' }[job.status] || job.status;
}

function mediaDescription(job) {
  return job.kind === 'image' ? '图片 · PNG' : `${job.duration} 秒 · ${job.format.toUpperCase()} · ${job.audio ? '有声' : '无声'}`;
}

function updateElapsed() {
  const job = current.jobs.find(item => item.status === 'running');
  if (!job) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 1000));
  $('generation-elapsed').textContent = `已用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function renderProgress() {
  const job = current.jobs.find(item => item.status === 'running');
  $('generation-progress').classList.toggle('hidden', !job);
  if (!job) {
    progressJob = null;
    progressUnits = 0;
    $('generation-fill').style.width = '0%';
    return;
  }
  $('progress-phase').textContent = statusText(job);
  $('progress-prompt').textContent = job.prompt;
  const sampling = job.stage === 'sampling' && Number.isInteger(job.samplingStep);
  if (progressJob !== job.id) { progressJob = job.id; progressUnits = 0; }
  const steps = job.steps || 6;
  const units = { preparing: 1, sampling: 1 + 6 * Math.max(0, Math.min(steps, job.samplingStep || 0)) / steps, decoding: 8, encoding: 9 };
  progressUnits = Math.max(progressUnits, units[job.stage] || 1);
  $('generation-fill').style.width = `${progressUnits * 10}%`;
  $('generation-bar').setAttribute('aria-valuenow', String(progressUnits));
  $('generation-bar').setAttribute('aria-valuetext', statusText(job));
  const phases = ['preparing', 'sampling', 'decoding', 'encoding'];
  const phaseIndex = Math.max(0, phases.indexOf(job.stage));
  for (const [index, element] of [...document.querySelectorAll('[data-phase]')].entries()) {
    element.classList.toggle('is-complete', index < phaseIndex);
    element.classList.toggle('is-active', index === phaseIndex);
  }
  $('progress-caption').textContent = sampling
    ? `采样 ${job.samplingStep} / ${steps} 步，之后还需解码和导出`
    : '随实际处理阶段推进，不代表剩余时间';
  $('active-scene').classList.toggle('hidden', selectedId === job.id && !timelineVisible);
  updateElapsed();
}

function render(state) {
  const rootChanged = current.workspace?.root !== state.workspace?.root;
  current = state;
  const workspace = state.workspace;
  const options = state.deploymentOptions;
  $('deployment-summary').textContent = state.maintenance?.running ? '部署操作正在运行，请等待完成。' :
    options ? `CUDA · ${options.profile} · ${options.steps} 步 · 24 fps（在设置中修改）` : '';
  $('workspace-name').textContent = workspace?.name || '尚未选择工作区';
  $('workspace-path').textContent = workspace?.root || '创建或打开一个工作区，开始创作。';
  if (rootChanged) {
    for (const id of timelineEntries.keys()) removeTimelineEntry(id);
    sceneCanvas.reset();
    progressJob = null;
    progressUnits = 0;
    draft = workspace ? { prompt: '', settings: { ...workspace.settings } } : null;
    selectedId = state.jobs.find(job => job.status === 'running')?.id || state.jobs[0]?.id || null;
    loadedPage = null;
  }
  if (selectedId !== null && !state.jobs.some(job => job.id === selectedId)) {
    selectedId = state.jobs.find(job => job.status === 'running')?.id || state.jobs[0]?.id || null;
  }
  if (selectedId === null && !draft && workspace) draft = { prompt: '', settings: { ...workspace.settings } };
  const job = state.jobs.find(item => item.id === selectedId);
  const page = `${workspace?.root || ''}/${selectedId || 'draft'}`;
  if (loadedPage !== page) {
    const values = job ? { prompt: job.prompt, settings: job } : draft;
    if (values) {
      $('prompt').value = values.prompt;
      setSettings(values.settings);
    } else {
      $('prompt').value = '';
    }
    updatePromptCount();
    loadedPage = page;
  }
  $('scene-title').textContent = job ? '创作画面' : '新建画面';
  $('scene-status').textContent = job
    ? `${new Date(job.createdAt).toLocaleString('zh-CN')} · ${statusText(job)} · 参数只读`
    : '填写提示词后开始生成';
  $('job-count').textContent = state.jobs.length;
  const history = $('history');
  const scrollTop = history.scrollTop;
  history.replaceChildren();
  if (!state.jobs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '生成的视频和图片会显示在这里。';
    history.append(empty);
  }
  for (const item of state.jobs) {
    const button = document.createElement('button');
    button.className = `history-item${item.id === selectedId ? ' selected' : ''}`;
    button.title = '点击切换创作画面；右键删除记录';
    button.setAttribute('aria-current', item.id === selectedId ? 'page' : 'false');
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = item.prompt;
    const info = document.createElement('span');
    info.className = 'history-info';
    info.textContent = `${mediaDescription(item)} · ${statusText(item)}`;
    button.append(title, info);
    button.addEventListener('click', () => selectScene(item.id));
    button.addEventListener('contextmenu', event => showRecordMenu(event, item.id));
    history.append(button);
  }
  history.scrollTop = scrollTop;
  $('show-video').disabled = !job || job.status !== 'completed';
  $('job-detail').classList.toggle('hidden', !job);
  $('job-detail').textContent = job
    ? `${statusText(job)} · ${job.profile || 'hyperflow'} · ${job.steps || 6} 步 · ${job.width} × ${job.height} · ${mediaDescription(job)} · 种子 ${job.seed}${job.error ? ` · ${job.error}` : ''}`
    : '';
  if (job?.status === 'completed') {
    $('preview-empty').classList.add('hidden');
    $('preview').classList.toggle('hidden', job.kind === 'image');
    $('image-preview').classList.toggle('hidden', job.kind !== 'image');
    if (playingPage !== page) {
      playingPage = page;
      $('preview').pause();
      $('preview').removeAttribute('src');
      $('preview').load();
      $('image-preview').removeAttribute('src');
      window.mmax.video(job.id).then(url => {
        if (playingPage === page) $(job.kind === 'image' ? 'image-preview' : 'preview').src = url;
      }).catch(error => {
        if (playingPage === page) { playingPage = null; message(error.message, true); }
      });
    }
  } else {
    playingPage = null;
    $('preview').pause();
    $('preview').removeAttribute('src');
    $('preview').classList.add('hidden');
    $('image-preview').classList.add('hidden');
    $('image-preview').removeAttribute('src');
    $('preview-empty').classList.remove('hidden');
    $('preview-empty').querySelector('strong').textContent = job ? statusText(job) : '你的作品将出现在这里';
    $('preview-empty').querySelector('span').textContent = job?.error || (job ? '生成过程和输出文件保存在工作区。' : '生成完成后，可在此播放或在工作区查看文件。');
  }
  renderProgress();
  $('scene-view').classList.toggle('hidden', timelineVisible);
  $('timeline-view').classList.toggle('hidden', !timelineVisible);
  document.querySelector('.content').classList.toggle('canvas-mode', timelineVisible);
  $('toggle-view').setAttribute('aria-pressed', String(timelineVisible));
  const viewLabel = timelineVisible ? '切换到创作视图' : '切换到画布视图';
  $('toggle-view').setAttribute('aria-label', viewLabel);
  $('toggle-view').title = viewLabel;
  if (timelineVisible) renderTimeline();
  sceneCanvas.setVisible(timelineVisible);
  setBusy(busy);
}

async function refreshState() {
  if (busy) { refreshPending = true; return; }
  refreshPending = false;
  try { render(await window.mmax.state()); }
  catch (error) { message(error.message, true); }
}

async function action(callback) {
  if (busy) return;
  setBusy(true);
  message('');
  try { render(await callback()); }
  catch (error) { message(error.message, true); }
  finally {
    setBusy(false);
    if (refreshPending) refreshState();
  }
}

$('prompt').addEventListener('input', updatePromptCount);
$('kind').addEventListener('change', () => {
  const image = $('kind').value === 'image';
  $('width').value = image ? '1024' : '640';
  $('height').value = image ? '1024' : '384';
  $('duration').value = '5';
  $('format').value = 'webm';
  $('audio').value = 'on';
  updateMediaControls();
});
$('image-preview').addEventListener('error', () => message('图片预览失败，请检查作品文件。', true));
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
$('open-settings').addEventListener('click', () => window.mmax.openSettings().catch(error => message(error.message, true)));
$('toggle-view').addEventListener('click', () => {
  if (busy || !current.workspace) return;
  setView(!timelineVisible);
  render(current);
});
$('new-scene').addEventListener('click', () => action(async () => {
  const state = await window.mmax.newScene();
  if (selectedId !== null || !draft) {
    if (!draft) draft = { prompt: '', settings: { ...state.workspace.settings } };
    selectedId = null;
    loadedPage = null;
  }
  setView(false);
  $('prompt').focus();
  return state;
}));
$('generate').addEventListener('click', () => action(async () => {
  const state = await window.mmax.start($('prompt').value, settings());
  selectedId = state.startedId;
  draft = null;
  return state;
}));
$('active-scene').addEventListener('click', () => {
  const job = current.jobs.find(item => item.status === 'running');
  if (job) selectScene(job.id);
});
$('show-video').addEventListener('click', () => window.mmax.show(selectedId, 'video').catch(error => message(error.message, true)));
window.mmax.onEvent(event => {
  if (event.type === 'error') message(event.message, true);
  refreshState();
});
window.mmax.onDeploymentEvent(() => refreshState());
refreshState();
setInterval(() => { if (current.active) refreshState(); }, 2000);
setInterval(updateElapsed, 1000);
