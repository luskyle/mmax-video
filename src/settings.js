'use strict';

const $ = id => document.getElementById(id);
const pathFields = [
  ['model_dir', '模型目录'], ['runtime_dir', '运行与生成锁目录'],
  ['source_dir', '引擎源码目录'], ['build_dir', 'CUDA 构建目录'],
  ['sd_cli', 'sd-cli 推理器'], ['diffusion_model', '扩散模型（须匹配预设）'],
  ['text_encoder', '文本编码器（视频／图片共用）'], ['video_vae', '视频 VAE'], ['audio_vae', '音频 VAE'],
  ['image_model', 'MiniMax-H3-Image 图片模型'], ['image_vae', '独立图片 VAE']
];
const fields = [
  ...pathFields.map(([key, label]) => ({ key: `MINIMAX_H3_${key.toUpperCase()}`, label, resolved: key })),
  { key: 'ffmpeg', label: 'FFmpeg（留空自动检测）' },
  { key: 'CUDA_HOME', label: 'CUDA Toolkit 目录', advanced: true },
  { key: 'MINIMAX_H3_CUDA_ARCHITECTURES', label: 'CUDA 架构，例如 86;89（留空自动检测）', advanced: true },
  { key: 'HF_ENDPOINT', label: '模型下载端点（HTTPS）', advanced: true }
];
let busy = false;
let active = false;
let operation = { running: false };
let saved = null;

for (const field of fields) {
  const group = document.createElement('div');
  const label = document.createElement('label');
  label.htmlFor = field.key;
  label.textContent = field.label;
  const input = document.createElement('input');
  input.id = field.key;
  input.type = 'text';
  input.placeholder = '继承部署配置';
  const effective = document.createElement('p');
  effective.id = `effective-${field.key}`;
  effective.className = 'hint effective-path';
  group.append(label, input, effective);
  $(field.advanced ? 'environment-fields' : 'deployment-fields').append(group);
  input.addEventListener('input', updateControls);
}

function message(text, isError = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', isError);
  $('notice').classList.toggle('hidden', !text);
}

function options() {
  const env = {};
  for (const field of fields) if (field.key !== 'ffmpeg' && $(field.key).value.trim()) env[field.key] = $(field.key).value.trim();
  return { profile: $('profile').value, steps: Number($('steps').value), env, ffmpeg: $('ffmpeg').value.trim() };
}

function dirty() {
  if (!saved) return false;
  const current = options();
  return current.profile !== saved.profile || current.steps !== saved.steps || current.ffmpeg !== saved.ffmpeg ||
    fields.some(field => field.key !== 'ffmpeg' && (current.env[field.key] || '') !== (saved.env[field.key] || ''));
}

function updateControls() {
  const locked = busy || active || operation.running;
  for (const id of ['profile', ...fields.map(field => field.key), 'build-jobs', 'download-profile', 'accept-license', 'clear-overrides']) $(id).disabled = locked;
  $('steps').disabled = locked || $('profile').value === 'hyperflow';
  for (const id of ['save', 'discard']) $(id).disabled = locked || !saved || !dirty();
  for (const id of ['choose-model', 'refresh', 'doctor', 'checksum', 'image-doctor', 'build', 'download']) $(id).disabled = locked || dirty();
  $('download').disabled ||= !$('accept-license').checked;
  $('back').disabled = busy;
  $('save-state').textContent = dirty() ? '有未保存修改；请保存后再执行操作' : '已保存';
}

function profileHelp() {
  const hyperflow = $('profile').value === 'hyperflow';
  $('steps').min = hyperflow ? '6' : '1';
  $('steps').max = hyperflow ? '6' : '20';
  $('profile-help').textContent = hyperflow
    ? 'HyperFlow 使用独立蒸馏模型，固定 6 步、Euler 和匹配 sigma，不等同于 Standard 改成六步。'
    : 'Standard 使用原剪枝模型，支持 1–20 步，默认 20 步并保留引擎默认采样方法。';
}

function fillOptions(value) {
  saved = value;
  $('profile').value = value.profile;
  $('steps').value = value.steps;
  for (const field of fields) $(field.key).value = field.key === 'ffmpeg' ? value.ffmpeg : value.env[field.key] || '';
  profileHelp();
}

function renderOperation(value) {
  operation = value;
  const labels = { doctor: '诊断／校验', build: 'CUDA 构建', download: '模型下载' };
  $('operation-status').textContent = value.action
    ? `${labels[value.action]}：${value.running ? '正在运行' : value.status === 'completed' ? '完成' : value.error || '失败'}`
    : '尚未执行部署操作。';
  $('operation-status').classList.toggle('error', value.status === 'failed');
  $('operation-status').classList.toggle('ready', value.status === 'completed');
  const log = $('operation-log');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
  log.textContent = (value.output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (atEnd) log.scrollTop = log.scrollHeight;
  updateControls();
}

function renderStatus(status, fill = false) {
  if (fill) fillOptions(status.options);
  const ready = status.missing.length === 0;
  $('model-status').textContent = ready ? `配置检查通过（尚未验证显存或模型 SHA256）。模型：${status.files.model}；FFmpeg：${status.files.ffmpeg}` : `未就绪：${status.missing.join('；')}`;
  $('model-status').classList.toggle('ready', ready);
  $('model-status').classList.toggle('error', !ready);
  const image = status.imageStatus;
  $('image-status').textContent = image?.missing.length === 0 ? '图片生成配置就绪：MiniMax-H3-Image · PNG · 固定六步（不使用视频 VAE 或 FFmpeg）。' :
    `图片生成未就绪：${image?.missing.join('；') || '请更新部署项目'}`;
  $('image-status').classList.toggle('ready', image?.missing.length === 0);
  for (const field of fields) {
    const effective = field.key === 'ffmpeg' ? status.files.ffmpeg : status.configuration?.settings[field.resolved];
    $(`effective-${field.key}`).textContent = effective ? `实际：${effective}` : '';
  }
  const caps = status.configuration?.capabilities;
  $('capabilities').textContent = caps
    ? `CUDA · 视频：${caps.fps} fps · 宽高 ${caps.width_height.min}–${caps.width_height.max}（${caps.width_height.multiple} 的倍数）· ${caps.frames.min}–${caps.frames.max} 帧 · 提示词 ${caps.max_prompt_characters} 字符。视频导出 5／10／14 秒，音频始终参与视频推理。图片：512–2048，固定六步，PNG。引擎版本：${status.configuration.engine_commit}`
    : '无法读取部署能力，请检查根目录或更新 minimax-deploy。';
  renderOperation(status.operation);
}

async function refresh(fill = false) {
  const state = await window.mmax.state();
  active = state.active && !state.maintenance?.running;
  $('model-path').textContent = state.modelRoot;
  renderStatus(await window.mmax.modelStatus(), fill);
}

async function action(callback) {
  if (busy) return;
  busy = true;
  updateControls();
  message('');
  try { await callback(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; updateControls(); }
}

$('profile').addEventListener('change', () => {
  $('steps').value = $('profile').value === 'hyperflow' ? '6' : '20';
  profileHelp();
  updateControls();
});
$('steps').addEventListener('input', updateControls);
$('accept-license').addEventListener('change', updateControls);
$('clear-overrides').addEventListener('click', () => {
  for (const field of fields) $(field.key).value = '';
  updateControls();
});
$('discard').addEventListener('click', () => { fillOptions(saved); updateControls(); message('已撤销未保存修改。'); });
$('save').addEventListener('click', () => action(async () => {
  renderStatus(await window.mmax.saveModel(options()), true);
  message('应用配置已保存。请确认上方检查结果，再开始生成。');
}));
$('refresh').addEventListener('click', () => action(() => refresh()));
$('choose-model').addEventListener('click', () => action(async () => {
  await window.mmax.chooseModel();
  await refresh(true);
}));
$('back').addEventListener('click', () => {
  if (dirty()) { message('请先保存或撤销未保存的修改。', true); return; }
  window.mmax.openHome().catch(error => message(error.message, true));
});
for (const [id, target] of [['show-readme', 'readme'], ['show-config', 'config'], ['show-log', 'log']]) {
  $(id).addEventListener('click', () => window.mmax.showDeploymentFile(target).catch(error => message(error.message, true)));
}
for (const [id, name] of [['doctor', 'doctor'], ['checksum', 'doctor'], ['image-doctor', 'doctor'], ['build', 'build'], ['download', 'download']]) {
  $(id).addEventListener('click', () => action(async () => {
    renderOperation(await window.mmax.deploymentOperation(name, {
      checksum: id === 'checksum', image: id === 'image-doctor', jobs: Number($('build-jobs').value),
      profile: $('download-profile').value, acceptLicense: $('accept-license').checked
    }));
  }));
}
window.mmax.onDeploymentEvent(value => {
  renderOperation(value);
  if (!value.running) refresh().catch(error => message(error.message, true));
});
window.mmax.onEvent(() => { refresh().catch(error => message(error.message, true)); });
action(() => refresh(true));
