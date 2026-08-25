import { DEFAULTS, getSettings, setSettings } from '../common/settings.js';
import {
  TRANSLATE_ENGINES,
  CN_DICT_ENGINES,
  EN_DICT_ENGINES,
  ZH_TRANSLATE_ENGINES,
  ZH_DICT_ENGINES
} from '../common/engines.js';

const $ = (id) => document.getElementById(id);
const FIELDS = {
  enabled: 'checkbox',
  trigger: 'value',
  delay: 'number',
  theme: 'value',
  showEnglishDef: 'checkbox',
  autoSpeak: 'checkbox',
  engine: 'value',
  cnDictEngine: 'value',
  enDictEngine: 'value',
  zhToEn: 'checkbox',
  zhTransEngine: 'value',
  zhDictEngine: 'value',
  fallback: 'checkbox',
  maxTranslateChars: 'number'
};

/** 用注册表里的引擎填充下拉框，并把当前选项的说明写到副标题上。 */
function buildEngineSelect(id, engines, noteId) {
  const el = $(id);
  el.innerHTML = '';
  for (const { id: value, name } of engines) {
    el.append(new Option(name, value));
  }
  const showNote = () => {
    const hit = engines.find((e) => e.id === el.value);
    if (hit) $(noteId).textContent = hit.note;
  };
  el.addEventListener('change', showNote);
  return showNote;
}

const syncEngineNotes = [];

/** 中译英关掉时，把它的两个引擎选项灰掉——省得以为改了会有用。 */
function syncDeps() {
  const on = $('zhToEn').checked;
  for (const row of document.querySelectorAll('[data-dep="zhToEn"]')) {
    row.classList.toggle('dim', !on);
    row.querySelectorAll('select').forEach((el) => (el.disabled = !on));
  }
}

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
  syncEngineNotes.forEach((fn) => fn());
  syncDeps();
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
  syncEngineNotes.push(
    buildEngineSelect('engine', TRANSLATE_ENGINES, 'engineNote'),
    buildEngineSelect('cnDictEngine', CN_DICT_ENGINES, 'cnDictEngineNote'),
    buildEngineSelect('enDictEngine', EN_DICT_ENGINES, 'enDictEngineNote'),
    buildEngineSelect('zhTransEngine', ZH_TRANSLATE_ENGINES, 'zhTransEngineNote'),
    buildEngineSelect('zhDictEngine', ZH_DICT_ENGINES, 'zhDictEngineNote')
  );
  fill(await getSettings());

  for (const id of Object.keys(FIELDS)) {
    const el = $(id);
    const event = el.type === 'range' || el.type === 'number' ? 'input' : 'change';
    el.addEventListener(event, async () => {
      if (id === 'delay') $('delayOut').textContent = `${el.value} ms`;
      if (id === 'zhToEn') syncDeps();
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
