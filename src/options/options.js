import { DEFAULTS, getSettings, setSettings } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
const FIELDS = {
  enabled: 'checkbox',
  trigger: 'value',
  delay: 'number',
  theme: 'value',
  showEnglishDef: 'checkbox',
  autoSpeak: 'checkbox',
  engine: 'value',
  maxTranslateChars: 'number'
};

let toastTimer = null;
function toast(msg = '已保存') {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function fill(settings) {
  for (const [id, kind] of Object.entries(FIELDS)) {
    const el = $(id);
    if (kind === 'checkbox') el.checked = !!settings[id];
    else el.value = settings[id];
  }
  $('delayOut').textContent = `${settings.delay} ms`;
  $('blocklist').value = (settings.blocklist || []).join('\n');
}

function readField(id) {
  const el = $(id);
  const kind = FIELDS[id];
  if (kind === 'checkbox') return el.checked;
  if (kind === 'number') return Number(el.value);
  return el.value;
}

async function init() {
  fill(await getSettings());

  for (const id of Object.keys(FIELDS)) {
    const el = $(id);
    const event = el.type === 'range' || el.type === 'number' ? 'input' : 'change';
    el.addEventListener(event, async () => {
      if (id === 'delay') $('delayOut').textContent = `${el.value} ms`;
      await setSettings({ [id]: readField(id) });
      toast();
    });
  }

  let blockTimer = null;
  $('blocklist').addEventListener('input', () => {
    clearTimeout(blockTimer);
    blockTimer = setTimeout(async () => {
      const list = $('blocklist')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      await setSettings({ blocklist: list });
      toast();
    }, 500);
  });

  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'cache:clear' });
    toast('缓存已清空');
  });

  $('reset').addEventListener('click', async () => {
    await chrome.storage.sync.set(DEFAULTS);
    fill(DEFAULTS);
    toast('已恢复默认设置');
  });
}

init();
