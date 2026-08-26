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
  voiceEn: 'value',
  voiceZh: 'value',
  pageEngine: 'value',
  pageStyle: 'value',
  engine: 'value',
  cnDictEngine: 'value',
  enDictEngine: 'value',
  zhToEn: 'checkbox',
  zhTransEngine: 'value',
  zhDictEngine: 'value',
  fallback: 'checkbox',
  maxTranslateChars: 'number'
};

/**
 * 用注册表里的引擎填充下拉框，并把当前选项的说明写到副标题上。
 * noteKey 让「网页翻译」用 pageNote：同一个引擎，整页场景关心的点和划词不一样。
 */
function buildEngineSelect(id, engines, noteId, noteKey = 'note') {
  const el = $(id);
  el.innerHTML = '';
  for (const { id: value, name } of engines) {
    el.append(new Option(name, value));
  }
  const showNote = () => {
    const hit = engines.find((e) => e.id === el.value);
    if (hit) $(noteId).textContent = hit[noteKey] || hit.note;
  };
  el.addEventListener('change', showNote);
  return showNote;
}

const syncEngineNotes = [];

/* ------------------------------------------------------------ 嗓音 */

const VOICE_FIELDS = { voiceEn: 'en', voiceZh: 'zh' };
const VOICE_SAMPLE = { en: 'This is LightDict speaking.', zh: '这里是 LightDict 轻词典。' };

function voiceList(base) {
  return globalThis.LightDictVoices.matching(speechSynthesis.getVoices(), base);
}

/** 自动挑选时实际会用哪个嗓音——写进下拉框第一项，省得还要猜。 */
function autoLabel(base) {
  const hit = globalThis.LightDictVoices.pick(speechSynthesis.getVoices(), base, undefined, '');
  return hit ? `自动（当前会用 ${hit.name}）` : '自动（交给系统决定）';
}

/**
 * 用系统当前可用的嗓音填充下拉框。嗓音列表是异步加载的，voiceschanged 之后要重填；
 * 设置里存的名字如果本机没有（换了台电脑），单独列一项标出来，不要悄悄改掉它。
 */
function buildVoiceSelects(settings) {
  for (const [id, base] of Object.entries(VOICE_FIELDS)) {
    const el = $(id);
    const list = voiceList(base);
    const current = settings[id] || '';
    el.innerHTML = '';
    el.append(new Option(autoLabel(base), ''));
    for (const v of list) {
      el.append(new Option(`${v.name} · ${v.lang}${v.localService ? ' · 本地' : ' · 在线'}`, v.name));
    }
    if (current && !list.some((v) => v.name === current)) {
      el.append(new Option(`${current}（本机不可用）`, current));
    }
    el.value = current;
  }
}

/** 试听：和卡片上走同一套挑选逻辑，听到的就是实际会用的那个嗓音。 */
function tryVoice(base) {
  const chosen = $(base === 'en' ? 'voiceEn' : 'voiceZh').value;
  const voice = globalThis.LightDictVoices.pick(speechSynthesis.getVoices(), base, undefined, chosen);
  const u = new SpeechSynthesisUtterance(VOICE_SAMPLE[base]);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || (base === 'en' ? 'en-US' : 'zh-CN');
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  toast(voice ? `试听：${voice.name}` : '试听：系统默认嗓音');
}

/**
 * 整页翻译的快捷键以浏览器里登记的那个为准：用户在 chrome://extensions/shortcuts
 * 改过就显示改后的，macOS 上 Chrome 直接给的是 ⌥T 这样的符号写法。
 */
async function showShortcut() {
  const list = (await chrome.commands?.getAll?.().catch(() => [])) || [];
  const hit = list.find((c) => c.name === 'toggle-page');
  if (hit) $('pageShortcut').textContent = hit.shortcut || '未设置';
}

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
  buildVoiceSelects(settings);
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
    buildEngineSelect('zhDictEngine', ZH_DICT_ENGINES, 'zhDictEngineNote'),
    buildEngineSelect('pageEngine', TRANSLATE_ENGINES, 'pageEngineNote', 'pageNote')
  );
  const settings = await getSettings();
  fill(settings);
  showShortcut();
  // 嗓音列表往往在页面加载后才就绪，就绪时重填一次下拉框。
  speechSynthesis.addEventListener('voiceschanged', async () => buildVoiceSelects(await getSettings()));
  $('tryVoiceEn').addEventListener('click', () => tryVoice('en'));
  $('tryVoiceZh').addEventListener('click', () => tryVoice('zh'));

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
