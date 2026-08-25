/**
 * LightDict 后台服务。
 * 网络请求全部放在这里：内容脚本受页面 CSP / CORS 限制，而 service worker
 * 拥有 host_permissions，可以直接跨域取数据。
 */
import { DEFAULTS, getSettings } from '../common/settings.js';
import {
  TRANSLATE_ENGINES,
  CN_DICT_ENGINES,
  EN_DICT_ENGINES,
  engineOrder
} from '../common/engines.js';

const CACHE_KEY = 'ld_cache';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天
const CACHE_MAX = 600;

/* ------------------------------------------------------------------ 工具 */

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

/* ------------------------------------------------------------ 查询流程 */

/**
 * 依次尝试引擎，第一个成功的结果获胜；全失败时抛出最后一个错误。
 * 把引擎本身一起返回：降级后卡片要如实标出结果究竟来自谁。
 */
async function runEngines(list, id, fallback, arg, label) {
  let lastError;
  for (const engine of engineOrder(list, id, fallback)) {
    try {
      return { data: await engine.run(arg), engine };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`${label}失败`);
}

/** 参与了这次结果的引擎名，按「翻译 + 词典」的顺序交给卡片展示。 */
function sourcesOf(...hits) {
  return hits.filter(Boolean).map((h) => h.engine.name);
}

function translateText(text, settings) {
  return runEngines(TRANSLATE_ENGINES, settings.engine, settings.fallback, text, '翻译');
}

function lookupCn(word, settings) {
  return runEngines(CN_DICT_ENGINES, settings.cnDictEngine, settings.fallback, word, '英汉查词');
}

function lookupEn(word, settings) {
  return runEngines(EN_DICT_ENGINES, settings.enDictEngine, settings.fallback, word, '英英查词');
}

/** 合并两组释义，同词性去重，保持先来者优先。 */
function mergeGroups(primary, extra) {
  const seen = new Set(primary.map((g) => g.pos));
  return [...primary, ...extra.filter((g) => !seen.has(g.pos))].slice(0, 5);
}

/** 音标 / 发音谁给出就用谁的：逐个字段取第一个非空值，英汉优先。 */
function pickFirst(keys, ...sources) {
  const out = {};
  for (const key of keys) out[key] = sources.reduce((acc, s) => acc || s?.[key] || '', '');
  return out;
}

async function lookupWord(text, settings) {
  const [t, c, e] = await Promise.allSettled([
    translateText(text, settings),
    lookupCn(text, settings),
    lookupEn(text, settings)
  ]);

  const trans = t.status === 'fulfilled' ? t.value : null;
  const cn = c.status === 'fulfilled' ? c.value : null;
  const en = e.status === 'fulfilled' ? e.value : null;

  if (!trans && !cn && !en) throw t.reason || c.reason || e.reason || new Error('查询失败');

  // 中文释义可能来自翻译引擎（Google 的 dt=bd）或英汉词典，两边都收。
  const zhDefs = mergeGroups(trans?.data.zh || [], cn?.data.zh || []);
  const enDefs = en?.data.en || [];

  const phonetics = pickFirst(['uk', 'us', 'text'], cn?.data.phonetics, en?.data.phonetics);
  const audio = pickFirst(['uk', 'us'], cn?.data.audio, en?.data.audio);
  if (!phonetics.uk && !phonetics.us && !phonetics.text && trans?.data.translit) {
    phonetics.text = `/${trans.data.translit}/`;
  }
  // 三路都没给出释义时，退化成整句翻译卡片。
  if (!zhDefs.length && !enDefs.length) {
    return {
      kind: 'text',
      data: {
        text,
        translation: trans?.data.translation || '',
        src: trans?.data.src,
        sources: sourcesOf(trans)
      }
    };
  }

  // 某一路失败、或什么都没提供时，就不在来源里署名。
  const cnUsed =
    cn && (cn.data.zh.length || cn.data.phonetics.uk || cn.data.phonetics.us || cn.data.audio.us);
  return {
    kind: 'word',
    data: {
      word: text,
      translation: trans?.data.translation || '',
      phonetics,
      audio,
      zh: zhDefs,
      en: enDefs,
      sources: sourcesOf(trans, cnUsed ? cn : null, enDefs.length ? en : null)
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
  const engines = wordish
    ? `${settings.engine}+${settings.cnDictEngine}+${settings.enDictEngine}`
    : settings.engine;
  const cacheKey = `${wordish ? 'w' : 't'}:${engines}:${text.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const result = wordish
    ? await lookupWord(text, settings)
    : {
        kind: 'text',
        data: await translateText(text, settings).then((hit) => ({
          text,
          translation: hit.data.translation,
          src: hit.data.src,
          sources: sourcesOf(hit)
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
