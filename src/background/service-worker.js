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
  voiceFallback,
  baiduVoice,
  bingSpeak,
  ttsSupported
} from '../common/engines.js';

const CACHE_KEY = 'ld_cache_v4'; // 发音候选改成了列表，换个键作废旧缓存
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
 * 一条引擎链的总时限。单个请求各自有 8 秒超时，但一条链上挂着四五个引擎，
 * 挨个超时能拖到几十秒——卡片不该为一路慢引擎干等这么久，到点就放弃这一路。
 */
const CHAIN_TIMEOUT = 12000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * 依次尝试引擎，第一个成功的结果获胜；全失败时抛出最后一个错误。
 * 把引擎本身一起返回：降级后卡片要如实标出结果究竟来自谁。
 */
function runEngines(list, id, fallback, arg, label) {
  const chain = async () => {
    let lastError;
    for (const engine of engineOrder(list, id, fallback)) {
      try {
        return { data: await engine.run(arg), engine };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`${label}失败`);
  };
  return withTimeout(chain(), CHAIN_TIMEOUT, label);
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
 * 卡片点发音时的候选链，从优到劣。最好的那一档（必应的神经网络嗓音）要 POST
 * 才拿得到数据，不能写成链接，由卡片临用时单独向后台要（见 handlers.tts）；
 * 这里放的是能直接交给 <audio> 播的现成链接：
 *
 *   有道 dictvoice   单词和短语是词库里的真人录音，最准，但超过二十来个字符就 500；
 *   百度 gettts      纯 GET，中英文都读得了，长一点的句子也不挑。
 */
/** 'zh-CN' / 'en_GB' → 'zh' / 'en'；其余语言返回空串，表示这段别走网络合成。 */
function ttsLang(code) {
  const base = String(code || '').split(/[-_]/)[0].toLowerCase();
  return base === 'zh' || base === 'en' ? base : '';
}

function ttsChain(text, lang = 'en', region = 'us') {
  if (!ttsSupported(text, lang)) return [];
  const list = [];
  if (lang === 'en' && (isSingleWord(text) || isShortPhrase(text))) {
    list.push({ src: 'youdao', url: voiceFallback(text, region) });
  }
  list.push({ src: 'baidu', url: baiduVoice(text, lang) });
  // 候选带着出处，卡片才能按设置页选的「发音来源」筛掉不该用的那几档。
  // 筛在卡片这一侧而不是这里：卡片有缓存，改了设置得立刻生效，不能等缓存过期。
  return list.filter((c) => c.url);
}

/** 卡片用的发音字段。uk/us/other 是词典给的真人录音，tts 是各语言的兜底候选。 */
function audioOf({ uk = '', us = '', other = '' } = {}, tts = {}) {
  return { uk, us, other, tts: { uk: [], us: [], zh: [], ...tts } };
}

/**
 * 整句卡片。speak 告诉卡片喇叭该读哪一句：中译英读译文，英译中读原文——
 * 两种情况读的都是英文那一侧，也就是真正需要听的那一侧。
 */
function textCard(text, hit, toEn) {
  const translation = hit?.data.translation || '';
  const speak = toEn
    ? { text: translation, lang: 'en' }
    : { text, lang: hit?.data.src || 'en' };
  // 整句没有现成录音，但短句仍值得走一趟网络合成，比本地嗓音好听得多。
  const lang = ttsLang(speak.lang);
  const chain = lang ? ttsChain(speak.text, lang) : [];
  return {
    kind: 'text',
    data: {
      text,
      translation,
      src: hit?.data.src,
      sources: sourcesOf(hit),
      speak,
      audio: audioOf({}, lang === 'zh' ? { zh: chain } : { us: chain })
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

/**
 * 若干路引擎并行跑，每有一路落地就把「到目前为止拼得出的卡片」交给 snapshot，
 * 让卡片先显示已经拿到的部分，剩下的继续标成加载中。返回值是全部落地后的完整卡片。
 *
 * pending 里是还没落地的那几路的名字，卡片按它决定哪几块画微光条。
 */
async function progressive(jobs, onPartial, build) {
  const parts = {};
  const pending = new Set(Object.keys(jobs));
  const errors = {}; // 按路记着，全军覆没时好按主次挑一个理由报给用户
  await Promise.all(
    Object.entries(jobs).map(([key, promise]) =>
      promise
        .then(
          (value) => { parts[key] = value; },
          (err) => { errors[key] = err; }
        )
        .then(() => {
          pending.delete(key);
          // 最后一路落地后由调用方给出完整结果，这里只管中途的快照。
          if (!pending.size) return;
          const partial = build(parts, [...pending]);
          if (partial) onPartial(partial);
        })
    )
  );
  return { parts, errors };
}

/** 英文词条卡片。pending 为空表示这是最终结果，否则是中途快照。 */
function wordCard(text, { trans, cn, en }, pending) {
  // 中文释义可能来自翻译引擎（Google 的 dt=bd）或英汉词典，两边都收。
  const zhDefs = mergeGroups(trans?.data.terms || [], cn?.data.zh || []);
  const enDefs = en?.data.en || [];

  const phonetics = pickFirst(['uk', 'us', 'text'], cn?.data.phonetics, en?.data.phonetics);
  // 词典给的录音链接随时可能 404 / 502，再挂一份通用发音，播放失败时由卡片改用它。
  const audio = audioOf(pickFirst(['uk', 'us', 'other'], cn?.data.audio, en?.data.audio), {
    uk: ttsChain(text, 'en', 'uk'),
    us: ttsChain(text, 'en', 'us')
  });
  if (!phonetics.uk && !phonetics.us && !phonetics.text && trans?.data.translit) {
    phonetics.text = `/${trans.data.translit}/`;
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
      speak: { text, lang: 'en' },
      sources: sourcesOf(trans, cnUsed ? cn : null, enDefs.length ? en : null),
      pending
    }
  };
}

/** 中文词条卡片（汉英方向）。 */
function zhWordCard(text, { trans, dict }, pending) {
  // 词典的对应词更贴近词条，排在前面；翻译引擎（Google 的 dt=bd）补它没覆盖的词性。
  const groups = mergeGroups(dict?.data.groups || [], trans?.data.terms || []);
  const pinyin = dict?.data.pinyin || trans?.data.translit || '';
  // 词典一个词条都没给（只给了拼音，甚至什么都没给）时，就不在来源里署名。
  const dictUsed = dict && (dict.data.groups.length || dict.data.pinyin);
  const spoken = groups.length ? groups[0].terms[0] : text;
  return {
    kind: 'word',
    data: {
      word: text,
      lang: 'zh',
      translation: trans?.data.translation || '',
      phonetics: { uk: '', us: '', text: pinyin },
      // 喇叭读英文对应词，点拼音读中文原词，两边各备一条候选链。
      audio: audioOf(
        {},
        {
          uk: ttsChain(spoken, 'en', 'uk'),
          us: ttsChain(spoken, 'en', 'us'),
          zh: ttsChain(text, 'zh')
        }
      ),
      zh: groups,
      en: [],
      speak: { text: spoken, lang: 'en' },
      sources: sourcesOf(dictUsed ? dict : null, trans),
      pending
    }
  };
}

/** 快照里一个字都没有就别推：卡片继续显示整块骨架，比闪一个空壳好看。 */
function hasContent(card) {
  const d = card.data;
  return !!(d.translation || d.zh.length || d.en.length || d.phonetics.text ||
    d.phonetics.uk || d.phonetics.us);
}

function snapshotSink(onPartial) {
  return (card) => {
    if (hasContent(card)) onPartial(card);
  };
}

/**
 * 英文词：翻译、英汉词典、英英词典三路并行，谁先回来先显示谁。
 * 英英词典即便用户关掉了英文释义也照查——音标和真人发音也从它那里来。
 */
async function lookupWord(text, settings, onPartial) {
  const jobs = {
    trans: translateText(text, settings),
    cn: lookupCn(text, settings),
    en: lookupEn(text, settings)
  };
  const { parts, errors } = await progressive(jobs, snapshotSink(onPartial), (p, pending) =>
    wordCard(text, p, pending)
  );
  if (!parts.trans && !parts.cn && !parts.en) {
    throw errors.trans || errors.cn || errors.en || new Error('查询失败');
  }

  const card = wordCard(text, parts, []);
  // 三路都没给出释义时，退化成整句翻译卡片。
  if (!card.data.zh.length && !card.data.en.length) return textCard(text, parts.trans, false);
  return card;
}

/**
 * 中文词：汉英词典给英文对应词，翻译引擎补拼音和整体译文。
 * 卡片读的是排在最前的那个英文词——查中文词时想听的正是它，中文本身不必念。
 */
async function lookupZhWord(text, settings, onPartial) {
  const jobs = {
    trans: translateToEn(text, settings),
    dict: lookupZh(text, settings)
  };
  const { parts, errors } = await progressive(jobs, snapshotSink(onPartial), (p, pending) =>
    zhWordCard(text, p, pending)
  );
  if (!parts.trans && !parts.dict) throw errors.trans || errors.dict || new Error('查询失败');

  const card = zhWordCard(text, parts, []);
  // 一个对应词都没有的中文词（多半是句子或生僻组合），退化成整句翻译卡片。
  if (!card.data.zh.length) return textCard(text, parts.trans, true);
  return card;
}

/**
 * 一次查询。onPartial 会在中途被调用若干次，每次带上「已经拿到的部分」；
 * 返回值才是完整结果，也只有它进缓存。
 *
 * manual 表示这段文字是用户在弹窗里亲手输的，不是划词划到的。手输的内容不受
 * 「中译英」开关约束——那个开关挡的是「在中文网页上划到中文就弹卡片」，
 * 而在输入框里敲下中文，要查的显然就是它。
 */
async function query(rawText, onPartial = () => {}, manual = false) {
  const text = normalize(rawText);
  if (!text) throw new Error('empty');

  const settings = await getSettings();
  if (text.length > settings.maxTranslateChars) {
    throw new Error(`选中内容过长（超过 ${settings.maxTranslateChars} 字符）`);
  }

  // 内容脚本已经拦过一道；这里再挡一次，防止刚改完设置时旧的内容脚本还在发请求。
  const toEn = hasChinese(text);
  if (toEn && !settings.zhToEn && !manual) throw new Error('未开启中译英，可在扩展设置里打开');

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
      ? await lookupZhWord(text, settings, onPartial)
      : textCard(text, await translateToEn(text, settings), true);
  } else {
    result = wordish
      ? await lookupWord(text, settings, onPartial)
      : textCard(text, await translateText(text, settings), false);
  }

  await cacheSet(cacheKey, result);
  return result;
}

/* ---------------------------------------------------------- 整页翻译 */

/**
 * 整页翻译的译文缓存。放在 chrome.storage.session 里：一次浏览会话内有效，
 * 关掉浏览器就没了 —— 整页译文体量大，不值得像划词结果那样占着七天的本地存储。
 */
const PAGE_CACHE_KEY = 'ld_page_cache_v1';
const PAGE_CACHE_MAX = 3000;
const PAGE_SPLIT_DEPTH = 2; // 整批失败时最多对半拆两次

let pageCache = null;

async function loadPageCache() {
  if (pageCache) return pageCache;
  const store = chrome.storage.session;
  const { [PAGE_CACHE_KEY]: data } = store ? await store.get(PAGE_CACHE_KEY) : {};
  pageCache = new Map(Array.isArray(data) ? data : []);
  return pageCache;
}

let pageFlushTimer = null;
function pageCacheFlush() {
  // Map 按插入顺序排，从头删就是先进先出，留下最近翻的那批
  while (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
  clearTimeout(pageFlushTimer);
  pageFlushTimer = setTimeout(
    () => chrome.storage.session?.set({ [PAGE_CACHE_KEY]: [...pageCache] }),
    1000
  );
}

/**
 * 按用户选的引擎批量翻译若干段。行数对不上的引擎直接跳过：
 * 译文错位安到别的段落上，比不翻译还糟。
 */
async function runPageEngines(texts, settings) {
  let lastError;
  for (const engine of engineOrder(TRANSLATE_ENGINES, settings.pageEngine, settings.fallback)) {
    if (typeof engine.lines !== 'function') continue;
    try {
      const out = await engine.lines(texts);
      if (out.length === texts.length) return out;
      lastError = new Error(`${engine.name} 译文行数与原文对不上`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('整页翻译失败');
}

/**
 * 整批失败时对半拆开重试：一段特别长、或夹了奇怪字符把整批拖垮时，
 * 其余段落仍能出译文。拆到底还是失败就留空串，页面上保持原样不动。
 */
async function translateChunk(texts, settings, depth = 0) {
  try {
    return await runPageEngines(texts, settings);
  } catch (err) {
    if (texts.length === 1 || depth >= PAGE_SPLIT_DEPTH) {
      if (!depth) throw err; // 整批一次都没成功过，把原因交给页面提示用户
      return Array.from(texts, () => '');
    }
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      translateChunk(texts.slice(0, mid), settings, depth + 1),
      translateChunk(texts.slice(mid), settings, depth + 1)
    ]);
    const merged = [...a, ...b];
    // 拆完还是一段都没译出来（断网、引擎全挂）：把原因抛给页面，让它停手别再试
    if (!depth && !merged.some(Boolean)) throw err;
    return merged;
  }
}

/**
 * 内容脚本按可视顺序分批送来若干段原文，这里返回等长的译文数组。
 * 命中缓存的段落不再联网；同一批里重复的原文（导航栏、页脚常见）只翻译一次。
 */
async function pageTranslate(texts) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || ''));
  if (!list.length) return { list: [] };

  const settings = await getSettings();
  const cache = await loadPageCache();
  const key = (text) => `${settings.pageEngine}|${text}`;

  const out = Array.from(list, () => '');
  const todo = [];        // 需要联网翻译的原文，已去重
  const slots = new Map(); // 原文 → 用它的下标
  list.forEach((text, i) => {
    const hit = cache.get(key(text));
    if (hit !== undefined) {
      out[i] = hit;
      return;
    }
    if (!slots.has(text)) {
      slots.set(text, []);
      todo.push(text);
    }
    slots.get(text).push(i);
  });

  if (todo.length) {
    const done = await translateChunk(todo, settings);
    todo.forEach((text, i) => {
      const translation = done[i] || '';
      for (const slot of slots.get(text)) out[slot] = translation;
      if (translation) cache.set(key(text), translation);
    });
    pageCacheFlush();
  }
  return { list: out };
}

/** 工具栏按钮 / 快捷键触发整页翻译。只发给主框架，iframe 不参与。 */
function togglePage(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'page:toggle' }, { frameId: 0 }, () => {
    void chrome.runtime.lastError; // 内容脚本跑不到的页面（chrome:// 等），忽略
  });
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) togglePage(tab.id);
});

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

/* ------------------------------------------------------------ 语音合成 */

/**
 * 必应的朗读接口要 POST 才拿得到音频，内容脚本受页面 CORS 限制发不出去，
 * 只能由这里代劳。回给卡片的是 data: 链接——Blob 和 URL.createObjectURL 造出来的
 * 地址都只在 service worker 自己这边有效，传过去是打不开的。
 */
const ttsCache = new Map(); // "语言|口音|文本" → data: 链接，只留在内存里
const TTS_CACHE_MAX = 24;   // 一条几十 KB，别攒太多

/** ArrayBuffer → base64。一次 apply 太多参数会爆栈，分块转。 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 合成一段语音交给卡片播。失败（会话刮不到、被限流、文字太长）时返回空链接，
 * 由卡片顺着自己的候选链往下退，不当成错误报给用户。
 */
async function tts({ text, lang, region }) {
  const body = String(text || '').trim();
  const base = ttsLang(lang);
  const accent = region === 'uk' ? 'uk' : 'us';
  if (!base || !ttsSupported(body, base)) return { url: '' };
  // 卡片那边照理已经按设置拦过一道了，这里再确认一次：换个调用方也不会漏。
  const { ttsSource } = await getSettings();
  if (ttsSource !== 'auto' && ttsSource !== 'bing') return { url: '' };

  const key = `${base}|${base === 'zh' ? '-' : accent}|${body}`;
  const hit = ttsCache.get(key);
  if (hit) {
    ttsCache.delete(key); // 重新插到末尾，常听的那几个词不会被挤掉
    ttsCache.set(key, hit);
    return { url: hit };
  }

  let url = '';
  try {
    url = 'data:audio/mpeg;base64,' + toBase64(await bingSpeak(body, base, accent));
  } catch {
    return { url: '' };
  }
  ttsCache.set(key, url);
  while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
  return { url };
}

/* ----------------------------------------------------------- 消息入口 */

const handlers = {
  settings: () => getSettings(),
  tts: (msg) => tts(msg),
  'page:translate': ({ texts }) => pageTranslate(texts),
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
    pageCache = null;
    await chrome.storage.local.remove(CACHE_KEY);
    await chrome.storage.session?.remove(PAGE_CACHE_KEY);
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

/**
 * 查询走长连接而不是一问一答：一次查询会分几次回话，先把先到的部分推给对面，
 * 最后再推完整结果。对面换词或关掉结果时直接断开连接，这边就不再往回推了。
 * 划词卡片和弹窗里的查词框用的都是它。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ld-query') return;
  let alive = true;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    alive = false;
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'query') return;
    const post = (payload) => {
      if (!alive) return;
      try {
        port.postMessage(payload);
      } catch {
        alive = false; // 对面的页面已经走了
      }
    };
    query(msg.text, (partial) => post({ ok: true, ...partial }), !!msg.manual)
      .then((res) => post({ ok: true, ...res }))
      .catch((err) => post({ ok: false, error: String(err?.message || err) }))
      .finally(() => {
        if (alive) port.disconnect();
      });
  });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set(DEFAULTS);
    chrome.runtime.openOptionsPage?.();
  }
});
