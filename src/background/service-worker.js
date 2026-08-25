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
  ZH_TRANSLATE_ENGINES,
  ZH_DICT_ENGINES,
  engineOrder,
  voiceFallback
} from '../common/engines.js';

const CACHE_KEY = 'ld_cache_v3'; // 结果里加了发音字段 speak，换个键作废旧缓存
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

/** 汉字（含扩展 A 区与兼容区）。选区里出现汉字就按中文 → 英文的方向查。 */
const ZH_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function hasChinese(text) {
  return ZH_CHAR.test(text);
}

/** 中文词判定：纯汉字且不超过 6 个字，走汉英词典而不是整句翻译。 */
function isZhWord(text) {
  return /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{1,6}$/.test(text);
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

function translateToEn(text, settings) {
  return runEngines(ZH_TRANSLATE_ENGINES, settings.zhTransEngine, settings.fallback, text, '中译英');
}

function lookupZh(word, settings) {
  return runEngines(ZH_DICT_ENGINES, settings.zhDictEngine, settings.fallback, word, '汉英查词');
}

/**
 * 整句卡片。speak 告诉卡片喇叭该读哪一句：中译英读译文，英译中读原文——
 * 两种情况读的都是英文那一侧，也就是真正需要听的那一侧。
 */
function textCard(text, hit, toEn) {
  const translation = hit?.data.translation || '';
  return {
    kind: 'text',
    data: {
      text,
      translation,
      src: hit?.data.src,
      sources: sourcesOf(hit),
      speak: toEn ? { text: translation, lang: 'en' } : { text, lang: hit?.data.src || 'en' }
    }
  };
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
  const zhDefs = mergeGroups(trans?.data.terms || [], cn?.data.zh || []);
  const enDefs = en?.data.en || [];

  const phonetics = pickFirst(['uk', 'us', 'text'], cn?.data.phonetics, en?.data.phonetics);
  const audio = pickFirst(['uk', 'us', 'other'], cn?.data.audio, en?.data.audio);
  // 词典给的录音链接随时可能 404 / 502，再挂一份通用发音，播放失败时由卡片改用它。
  if (isSingleWord(text) || isShortPhrase(text)) {
    audio.tts = { uk: voiceFallback(text, 'uk'), us: voiceFallback(text, 'us') };
  }
  if (!phonetics.uk && !phonetics.us && !phonetics.text && trans?.data.translit) {
    phonetics.text = `/${trans.data.translit}/`;
  }
  // 三路都没给出释义时，退化成整句翻译卡片。
  if (!zhDefs.length && !enDefs.length) return textCard(text, trans, false);

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
      speak: { text, lang: 'en' },
      sources: sourcesOf(trans, cnUsed ? cn : null, enDefs.length ? en : null)
    }
  };
}

/**
 * 中文词：汉英词典给英文对应词，翻译引擎补拼音和整体译文。
 * 卡片读的是排在最前的那个英文词——查中文词时想听的正是它，中文本身不必念。
 */
async function lookupZhWord(text, settings) {
  const [t, d] = await Promise.allSettled([
    translateToEn(text, settings),
    lookupZh(text, settings)
  ]);

  const trans = t.status === 'fulfilled' ? t.value : null;
  const dict = d.status === 'fulfilled' ? d.value : null;
  if (!trans && !dict) throw t.reason || d.reason || new Error('查询失败');

  // 词典的对应词更贴近词条，排在前面；翻译引擎（Google 的 dt=bd）补它没覆盖的词性。
  const groups = mergeGroups(dict?.data.groups || [], trans?.data.terms || []);
  const pinyin = dict?.data.pinyin || trans?.data.translit || '';
  // 一个对应词都没有的中文词（多半是句子或生僻组合），退化成整句翻译卡片。
  if (!groups.length) return textCard(text, trans, true);

  // 词典一个词条都没给（只给了拼音，甚至什么都没给）时，就不在来源里署名。
  const dictUsed = dict && (dict.data.groups.length || dict.data.pinyin);
  const spoken = groups[0].terms[0];
  return {
    kind: 'word',
    data: {
      word: text,
      lang: 'zh',
      translation: trans?.data.translation || '',
      phonetics: { uk: '', us: '', text: pinyin },
      audio: {
        uk: '',
        us: '',
        other: '',
        tts: { uk: voiceFallback(spoken, 'uk'), us: voiceFallback(spoken, 'us') }
      },
      zh: groups,
      en: [],
      speak: { text: spoken, lang: 'en' },
      sources: sourcesOf(dictUsed ? dict : null, trans)
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

  // 内容脚本已经拦过一道；这里再挡一次，防止刚改完设置时旧的内容脚本还在发请求。
  const toEn = hasChinese(text);
  if (toEn && !settings.zhToEn) throw new Error('未开启中译英，可在扩展设置里打开');

  const wordish = toEn ? isZhWord(text) : isSingleWord(text) || isShortPhrase(text);
  const engines = toEn
    ? wordish
      ? `${settings.zhTransEngine}+${settings.zhDictEngine}`
      : settings.zhTransEngine
    : wordish
      ? `${settings.engine}+${settings.cnDictEngine}+${settings.enDictEngine}`
      : settings.engine;
  const cacheKey = `${toEn ? 'z' : 'e'}${wordish ? 'w' : 't'}:${engines}:${text.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  let result;
  if (toEn) {
    result = wordish
      ? await lookupZhWord(text, settings)
      : textCard(text, await translateToEn(text, settings), true);
  } else {
    result = wordish
      ? await lookupWord(text, settings)
      : textCard(text, await translateText(text, settings), false);
  }

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
