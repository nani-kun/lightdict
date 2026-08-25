/**
 * LightDict 后台服务。
 * 网络请求全部放在这里：内容脚本受页面 CSP / CORS 限制，而 service worker
 * 拥有 host_permissions，可以直接跨域取数据。
 */
import { DEFAULTS, getSettings } from '../common/settings.js';

const CACHE_KEY = 'ld_cache';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天
const CACHE_MAX = 600;
const TIMEOUT = 8000;

/* ------------------------------------------------------------------ 工具 */

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 单词判定：一个英文词（允许连字符与撇号）。 */
function isSingleWord(text) {
  return /^[A-Za-z][A-Za-z'’\-]{0,31}$/.test(text);
}

/** 短语判定：不超过 4 个词且不含句子标点，走词典而不是整句翻译。 */
function isShortPhrase(text) {
  const words = text.split(/\s+/);
  return words.length <= 4 && words.every((w) => /^[A-Za-z][A-Za-z'’\-]*$/.test(w));
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- 缓存 */

let memCache = null;

async function loadCache() {
  if (memCache) return memCache;
  const { [CACHE_KEY]: data } = await chrome.storage.local.get(CACHE_KEY);
  memCache = data && typeof data === 'object' ? data : {};
  return memCache;
}

async function cacheGet(key) {
  const cache = await loadCache();
  const hit = cache[key];
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) {
    delete cache[key];
    return null;
  }
  return hit.value;
}

let flushTimer = null;
async function cacheSet(key, value) {
  const cache = await loadCache();
  cache[key] = { ts: Date.now(), value };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys
      .sort((a, b) => cache[a].ts - cache[b].ts)
      .slice(0, keys.length - CACHE_MAX)
      .forEach((k) => delete cache[k]);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => chrome.storage.local.set({ [CACHE_KEY]: cache }), 800);
}

/* -------------------------------------------------------------- 数据源 */

/** 词性英文名 → 中文，用于卡片上的小标签。 */
const POS_ZH = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
  pronoun: '代词', preposition: '介词', conjunction: '连词',
  interjection: '感叹词', exclamation: '感叹词', determiner: '限定词',
  article: '冠词', numeral: '数词', abbreviation: '缩写', phrase: '短语',
  prefix: '前缀', suffix: '后缀', particle: '助词', auxiliary: '助动词'
};

/**
 * Google 翻译公开端点：一次调用同时拿到整句翻译（dt=t）和词典释义（dt=bd）。
 * clients5 的 dict-chrome-ex 通道更稳定；translate.googleapis.com 作为备用主机。
 */
const GOOGLE_HOSTS = [
  'https://clients5.google.com/translate_a/single?client=dict-chrome-ex',
  'https://translate.googleapis.com/translate_a/single?client=gtx'
];

async function google(text) {
  const query = '&dj=1&sl=auto&tl=zh-CN&dt=t&dt=bd&dt=rm&q=' + encodeURIComponent(text);
  let lastError;
  for (const host of GOOGLE_HOSTS) {
    try {
      const data = await fetchJSON(host + query);
      const sentences = data.sentences || [];
      const translation = sentences.map((s) => s.trans || '').join('').trim();
      if (!translation) throw new Error('empty translation');
      const zh = (data.dict || []).map((d) => ({
        pos: POS_ZH[String(d.pos || '').toLowerCase()] || d.pos || '',
        terms: (d.terms || []).slice(0, 8)
      }));
      const translit = sentences.find((s) => s.src_translit)?.src_translit || '';
      return { translation, zh, translit, src: data.src || 'en' };
    } catch (err) {
      lastError = err; // 被限流或返回 HTML 时换下一个主机
    }
  }
  throw lastError || new Error('google 请求失败');
}

/** 备用引擎：MyMemory，只做整句翻译。 */
async function mymemory(text) {
  const url =
    'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(text);
  const data = await fetchJSON(url);
  const translation = data?.responseData?.translatedText || '';
  if (!translation) throw new Error('empty translation');
  return { translation, zh: [], translit: '', src: 'en' };
}

/** 免费词典 API：音标、发音音频、英文释义与例句。 */
async function dictionaryApi(word) {
  const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word);
  const data = await fetchJSON(url);
  if (!Array.isArray(data) || !data.length) throw new Error('no entry');

  const phonetics = { uk: '', us: '', text: '' };
  const audio = { uk: '', us: '' };
  const en = [];

  for (const entry of data) {
    if (entry.phonetic && !phonetics.text) phonetics.text = entry.phonetic;
    for (const p of entry.phonetics || []) {
      const region = /-uk|_gb|\buk\b/i.test(p.audio || '') ? 'uk' : /-us|_us|\bus\b/i.test(p.audio || '') ? 'us' : '';
      if (region && p.audio && !audio[region]) audio[region] = p.audio;
      if (region && p.text && !phonetics[region]) phonetics[region] = p.text;
      if (!phonetics.text && p.text) phonetics.text = p.text;
      if (!region && p.audio && !audio.us) audio.us = p.audio;
    }
    for (const m of entry.meanings || []) {
      const defs = (m.definitions || []).slice(0, 3).map((d) => ({
        def: d.definition,
        example: d.example || ''
      }));
      if (defs.length) en.push({ pos: m.partOfSpeech || '', defs });
    }
  }
  return { phonetics, audio, en: en.slice(0, 4) };
}

/* ------------------------------------------------------------ 查询流程 */

async function translateText(text, engine) {
  const order = engine === 'mymemory' ? [mymemory, google] : [google, mymemory];
  let lastError;
  for (const fn of order) {
    try {
      const r = await fn(text);
      if (r.translation) return r;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('翻译失败');
}

async function lookupWord(text, settings) {
  const [g, d] = await Promise.allSettled([
    translateText(text, settings.engine),
    isSingleWord(text) ? dictionaryApi(text) : Promise.reject(new Error('phrase'))
  ]);

  const trans = g.status === 'fulfilled' ? g.value : null;
  const dict = d.status === 'fulfilled' ? d.value : null;

  if (!trans && !dict) throw g.reason || new Error('查询失败');

  const zh = trans?.zh || [];
  const en = dict?.en || [];
  const phonetics = dict?.phonetics || { uk: '', us: '', text: '' };
  if (!phonetics.uk && !phonetics.us && !phonetics.text && trans?.translit) {
    phonetics.text = `/${trans.translit}/`;
  }
  // 词典和 Google 都没给出释义时，退化成整句翻译卡片。
  if (!zh.length && !en.length) {
    return { kind: 'text', data: { text, translation: trans?.translation || '', src: trans?.src } };
  }

  return {
    kind: 'word',
    data: {
      word: text,
      translation: trans?.translation || '',
      phonetics,
      audio: dict?.audio || { uk: '', us: '' },
      zh,
      en
    }
  };
}

async function query(rawText) {
  const text = normalize(rawText);
  if (!text) throw new Error('empty');

  const settings = await getSettings();
  if (text.length > settings.maxTranslateChars) {
    throw new Error(`选中内容过长（超过 ${settings.maxTranslateChars} 字符）`);
  }

  const wordish = isSingleWord(text) || isShortPhrase(text);
  const cacheKey = `${wordish ? 'w' : 't'}:${settings.engine}:${text.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const result = wordish
    ? await lookupWord(text, settings)
    : {
        kind: 'text',
        data: await translateText(text, settings.engine).then((r) => ({
          text,
          translation: r.translation,
          src: r.src
        }))
      };

  await cacheSet(cacheKey, result);
  return result;
}

/* ------------------------------------------------------------ 生词本 */

const BOOK_KEY = 'wordbook';

async function bookList() {
  const { [BOOK_KEY]: list } = await chrome.storage.local.get(BOOK_KEY);
  return Array.isArray(list) ? list : [];
}

async function bookToggle(item) {
  const list = await bookList();
  const key = item.word.toLowerCase();
  const idx = list.findIndex((x) => x.word.toLowerCase() === key);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.unshift({ ...item, ts: Date.now() });
  }
  await chrome.storage.local.set({ [BOOK_KEY]: list.slice(0, 2000) });
  return idx < 0; // true 表示已收藏
}

async function bookHas(word) {
  const list = await bookList();
  return list.some((x) => x.word.toLowerCase() === word.toLowerCase());
}

/* ----------------------------------------------------------- 消息入口 */

const handlers = {
  query: ({ text }) => query(text),
  settings: () => getSettings(),
  'book:list': () => bookList(),
  'book:has': ({ word }) => bookHas(word),
  'book:toggle': ({ item }) => bookToggle(item),
  'book:remove': async ({ word }) => {
    const list = (await bookList()).filter((x) => x.word.toLowerCase() !== word.toLowerCase());
    await chrome.storage.local.set({ [BOOK_KEY]: list });
    return true;
  },
  'book:clear': async () => {
    await chrome.storage.local.set({ [BOOK_KEY]: [] });
    return true;
  },
  'cache:clear': async () => {
    memCache = {};
    await chrome.storage.local.remove(CACHE_KEY);
    return true;
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((data) => sendResponse({ ok: true, ...(data && data.kind ? data : { data }) }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 保持消息通道打开，异步响应
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set(DEFAULTS);
    chrome.runtime.openOptionsPage?.();
  }
});
