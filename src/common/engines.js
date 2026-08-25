/**
 * 查词 / 翻译引擎注册表。
 *
 * 所有引擎都只用公开、免费、免注册的接口，返回统一结构，方便互相替换与降级：
 *   翻译引擎 run(text) -> { translation, zh, translit, src }
 *   词典引擎 run(word) -> { phonetics, audio, en, zh }
 *
 * 后台脚本按用户选择的引擎调用；设置页直接读这里的 name / note 渲染下拉框，
 * 新增引擎只需要在下面的数组里加一项。
 */

const TIMEOUT = 8000;

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

/** 词性英文名 / 缩写 → 中文，用于卡片上的小标签。 */
const POS_ZH = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
  pronoun: '代词', preposition: '介词', conjunction: '连词',
  interjection: '感叹词', exclamation: '感叹词', determiner: '限定词',
  article: '冠词', numeral: '数词', abbreviation: '缩写', phrase: '短语',
  prefix: '前缀', suffix: '后缀', particle: '助词', auxiliary: '助动词',
  'n.': '名词', 'v.': '动词', 'vt.': '及物动词', 'vi.': '不及物动词',
  'adj.': '形容词', 'adv.': '副词', 'prep.': '介词', 'conj.': '连词',
  'pron.': '代词', 'int.': '感叹词', 'num.': '数词', 'art.': '冠词',
  'abbr.': '缩写', 'aux.': '助动词', 'det.': '限定词', 'pl.': '复数',
  n: '名词', v: '动词', adj: '形容词', adv: '副词'
};

function posZh(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return POS_ZH[key] || raw || '';
}

/** 去掉 Wiktionary 释义里的 HTML 标签与实体。 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------- 翻译引擎 */

/**
 * Google 翻译公开端点：一次调用同时拿到整句翻译（dt=t）和词典释义（dt=bd）。
 * clients5 的 dict-chrome-ex 通道更稳定；translate.googleapis.com 作为备用主机。
 */
const GOOGLE_HOSTS = [
  'https://clients5.google.com/translate_a/single?client=dict-chrome-ex',
  'https://translate.googleapis.com/translate_a/single?client=gtx'
];

/**
 * Google 的词典条目会把置信度极低的生僻字也塞进来（resilient → "仡"，score 2e-5），
 * 按分数过滤掉，让位给专业词典引擎给出的释义。
 */
const GOOGLE_MIN_SCORE = 0.001;

function googleTerms(group) {
  const entries = group.entry || [];
  if (!entries.length) return (group.terms || []).slice(0, 8);
  return entries
    .filter((e) => (e.score ?? 0) >= GOOGLE_MIN_SCORE)
    .map((e) => e.word)
    .filter(Boolean)
    .slice(0, 8);
}

async function google(text) {
  const query = '&dj=1&sl=auto&tl=zh-CN&dt=t&dt=bd&dt=rm&q=' + encodeURIComponent(text);
  let lastError;
  for (const host of GOOGLE_HOSTS) {
    try {
      const data = await fetchJSON(host + query);
      const sentences = data.sentences || [];
      const translation = sentences.map((s) => s.trans || '').join('').trim();
      if (!translation) throw new Error('empty translation');
      const zh = (data.dict || [])
        .map((d) => ({ pos: posZh(d.pos), terms: googleTerms(d) }))
        .filter((g) => g.terms.length);
      const translit = sentences.find((s) => s.src_translit)?.src_translit || '';
      return { translation, zh, translit, src: data.src || 'en' };
    } catch (err) {
      lastError = err; // 被限流或返回 HTML 时换下一个主机
    }
  }
  throw lastError || new Error('google 请求失败');
}

/** 有道翻译的公开演示接口，中文语境下译文更自然，国内网络也能直连。 */
async function youdao(text) {
  const url =
    'https://aidemo.youdao.com/trans?from=auto&to=zh-CHS&q=' + encodeURIComponent(text);
  const data = await fetchJSON(url);
  if (String(data?.errorCode ?? '') !== '0') throw new Error(`youdao ${data?.errorCode}`);
  const translation = (data.translation || []).join('').trim();
  if (!translation) throw new Error('empty translation');
  return { translation, zh: [], translit: '', src: 'auto' };
}

/** MyMemory：开放的翻译记忆库，匿名调用每天有免费额度。 */
async function mymemory(text) {
  const url =
    'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(text);
  const data = await fetchJSON(url);
  const translation = data?.responseData?.translatedText || '';
  if (!translation) throw new Error('empty translation');
  return { translation, zh: [], translit: '', src: 'en' };
}

/**
 * SimplyTranslate：Google 翻译的公共前端镜像，直连被拦截时的备胎。
 * 上游被 Google 限流时它会把错误页原样塞进 translated_text，所以要挡一下 HTML。
 */
async function simplytranslate(text) {
  const url =
    'https://simplytranslate.org/api/translate?engine=google&from=auto&to=zh-CN&text=' +
    encodeURIComponent(text);
  const data = await fetchJSON(url);
  const translation = String(data?.translated_text || '').trim();
  if (!translation) throw new Error('empty translation');
  if (/<\/?[a-z][^>]*>/i.test(translation)) throw new Error('upstream blocked');
  return {
    translation,
    zh: [],
    translit: data?.pronunciation || '',
    src: data?.source_language || 'auto'
  };
}

/* ---------------------------------------------------------- 词典引擎 */

const EMPTY_DICT = { phonetics: { uk: '', us: '', text: '' }, audio: { uk: '', us: '' }, en: [], zh: [] };

/** Free Dictionary API：音标、真人发音音频、英文释义与例句。 */
async function dictionaryapi(word) {
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
  return { ...EMPTY_DICT, phonetics, audio, en: en.slice(0, 4) };
}

/** 有道的释义行形如 "adj. 有弹性的；能复原的"，拆成词性 + 词条。 */
function splitZhLine(line) {
  const m = String(line || '').trim().match(/^([a-z]+\.)\s*(.+)$/i);
  const pos = m ? posZh(m[1]) : '';
  const body = m ? m[2] : String(line || '').trim();
  const terms = body.split(/[；;]/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
  return { pos, terms };
}

/**
 * 有道词典网页接口：一次拿到英美音标、真人发音和按词性分组的中文释义，
 * 是英汉方向覆盖最全的一个。
 */
async function youdaodict(word) {
  const dicts = encodeURIComponent(JSON.stringify({ count: 1, dicts: [['ec']] }));
  const url = `https://dict.youdao.com/jsonapi?dicts=${dicts}&q=` + encodeURIComponent(word);
  const data = await fetchJSON(url);

  const head = data?.simple?.word?.[0] || data?.ec?.word?.[0] || {};
  const phonetics = { uk: wrapIpa(head.ukphone), us: wrapIpa(head.usphone), text: '' };
  const audio = { uk: youdaoVoice(head.ukspeech), us: youdaoVoice(head.usspeech) };

  const zh = [];
  for (const entry of data?.ec?.word || []) {
    for (const group of entry.trs || []) {
      for (const tr of group.tr || []) {
        for (const line of tr?.l?.i || []) {
          // "【名】（Book）（英）布克" 这类人名 / 地名音译对查词没用，丢掉。
          if (typeof line !== 'string' || line.trim().startsWith('【')) continue;
          const parsed = splitZhLine(line);
          if (parsed.terms.length) zh.push(parsed);
        }
      }
    }
  }
  if (!zh.length && !phonetics.uk && !phonetics.us) throw new Error('no entry');
  return { ...EMPTY_DICT, phonetics, audio, zh: zh.slice(0, 4) };
}

function wrapIpa(raw) {
  const s = String(raw || '').trim();
  return s ? `/${s}/` : '';
}

/** simple.word 里的 speech 字段是查询串，补上主机就是可播放的 mp3。 */
function youdaoVoice(speech) {
  return speech ? 'https://dict.youdao.com/dictvoice?audio=' + speech : '';
}

/** 金山词霸：中文释义按词性分组，条目短，一眼能扫完。 */
async function iciba(word) {
  const url =
    'https://dict-mobile.iciba.com/interface/index.php?c=word&m=getsuggest&nums=1&client=6&is_need_mean=1&word=' +
    encodeURIComponent(word);
  const data = await fetchJSON(url);
  const hit = (data?.message || [])[0];
  const zh = (hit?.means || [])
    .map((g) => ({ pos: posZh(g.part), terms: (g.means || []).slice(0, 8) }))
    .filter((g) => g.terms.length);
  if (!zh.length) throw new Error('no entry');
  return { ...EMPTY_DICT, zh: zh.slice(0, 4) };
}

/**
 * 有道词典的联想接口，返回的 explain 形如
 *   "n. 书，书籍；本子; v. 预订，登记"
 * 拆成按词性分组的中文释义。
 */
function parseYoudaoExplain(explain) {
  return String(explain || '')
    .split(/;\s*(?=[a-z]+\.\s)/i)
    .map(splitZhLine)
    .filter((g) => g.terms.length);
}

/** 有道联想：接口极轻，词组和派生词给的是短词条而不是整句解释。 */
async function youdaosuggest(word) {
  const url =
    'https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&cache=false&le=en&q=' +
    encodeURIComponent(word);
  const data = await fetchJSON(url);
  const entries = data?.data?.entries || [];
  const key = word.toLowerCase();
  const hit = entries.find((e) => String(e.entry || '').toLowerCase() === key) || entries[0];
  const zh = parseYoudaoExplain(hit?.explain);
  if (!zh.length) throw new Error('no entry');
  return { ...EMPTY_DICT, zh: zh.slice(0, 4) };
}

/** Wiktionary 官方 REST 接口：词条最全，冷僻词和短语也查得到。 */
async function wiktionary(word) {
  const url = 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word);
  const data = await fetchJSON(url);
  const groups = data?.en || [];
  const en = [];
  for (const g of groups) {
    const defs = (g.definitions || [])
      .map((d) => ({ def: stripHtml(d.definition), example: stripHtml((d.examples || [])[0]) }))
      .filter((d) => d.def)
      .slice(0, 3);
    if (defs.length) en.push({ pos: String(g.partOfSpeech || '').toLowerCase(), defs });
  }
  if (!en.length) throw new Error('no entry');
  return { ...EMPTY_DICT, en: en.slice(0, 4) };
}

/** Datamuse：接口极轻、响应快，只给英文释义，适合网络较差时用。 */
async function datamuse(word) {
  const url = 'https://api.datamuse.com/words?md=d&max=1&sp=' + encodeURIComponent(word);
  const data = await fetchJSON(url);
  const defs = data?.[0]?.defs || [];
  if (!defs.length) throw new Error('no entry');

  const byPos = new Map();
  for (const raw of defs.slice(0, 8)) {
    const [pos, def] = String(raw).split('\t');
    if (!def) continue;
    if (!byPos.has(pos)) byPos.set(pos, []);
    const list = byPos.get(pos);
    if (list.length < 3) list.push({ def: def.trim(), example: '' });
  }
  const en = [...byPos].map(([pos, list]) => ({ pos, defs: list })).slice(0, 4);
  if (!en.length) throw new Error('no entry');
  return { ...EMPTY_DICT, en };
}

/* ------------------------------------------------------------ 注册表 */

export const TRANSLATE_ENGINES = [
  { id: 'google', name: 'Google 翻译', note: '综合最好，单词还会附带中文词性释义', run: google },
  { id: 'youdao', name: '有道翻译', note: '中文译文更自然，国内网络可直连', run: youdao },
  { id: 'mymemory', name: 'MyMemory', note: '开放翻译记忆库，匿名每日有免费额度', run: mymemory },
  { id: 'simplytranslate', name: 'SimplyTranslate', note: 'Google 的公共镜像，直连被拦时的备胎，有限流', run: simplytranslate }
];

/** 英汉：给出中文释义，顺带提供音标与发音。 */
export const CN_DICT_ENGINES = [
  { id: 'youdao', name: '有道词典', note: '中文释义 + 英美音标 + 真人发音，覆盖最全', run: youdaodict },
  { id: 'iciba', name: '金山词霸', note: '按词性分组的短词条，一眼扫得完', run: iciba },
  { id: 'youdaosuggest', name: '有道联想', note: '接口最轻，响应最快，也收派生词', run: youdaosuggest }
];

/** 英英：给出英文释义与例句，用来看词的准确用法。 */
export const EN_DICT_ENGINES = [
  { id: 'dictionaryapi', name: 'Free Dictionary', note: '英文释义带例句，另有音标与真人发音', run: dictionaryapi },
  { id: 'wiktionary', name: 'Wiktionary', note: '维基词典，冷僻词和短语也查得到', run: wiktionary },
  { id: 'datamuse', name: 'Datamuse', note: '轻量英文释义，响应最快', run: datamuse }
];

/** 把用户选的引擎排在最前；开启降级时后面跟上其余引擎。 */
export function engineOrder(list, id, fallback = true) {
  const preferred = list.filter((e) => e.id === id);
  const rest = list.filter((e) => e.id !== id);
  if (!preferred.length) return fallback ? list : list.slice(0, 1);
  return fallback ? [...preferred, ...rest] : preferred;
}
