'use strict';

const $ = id => document.getElementById(id);
let busy = false;
let active = false;

function message(text, isError = false) {
  const notice = $('notice');
  notice.textContent = text;
  notice.classList.toggle('error', isError);
  notice.classList.toggle('hidden', !text);
}

function renderStatus(status) {
  const output = $('model-status');
  const ready = status.missing.length === 0;
  output.textContent = ready
    ? '已就绪：必要文件均已找到。'
    : `未就绪，缺少：${status.missing.join('；')}`;
  output.classList.toggle('ready', ready);
  output.classList.toggle('error', !ready);
}

async function refresh() {
  const state = await window.mmax.state();
  active = state.active;
  $('model-path').textContent = state.modelRoot || '尚未配置';
  $('choose-model').disabled = busy || active;
  renderStatus(await window.mmax.modelStatus());
}

$('back').addEventListener('click', () => {
  window.mmax.openHome().catch(error => message(error.message, true));
});

$('choose-model').addEventListener('click', async () => {
  if (busy || active) return;
  busy = true;
  $('choose-model').disabled = true;
  message('');
  try {
    await window.mmax.chooseModel();
    await refresh();
  } catch (error) {
    message(error.message, true);
  } finally {
    busy = false;
    $('choose-model').disabled = active;
  }
});

window.mmax.onEvent(() => {
  refresh().catch(error => message(error.message, true));
});
refresh().catch(error => message(error.message, true));
setInterval(() => {
  if (active && !busy) refresh().catch(error => message(error.message, true));
}, 5000);
