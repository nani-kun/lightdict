/**
 * 查词 / 翻译引擎注册表。
 *
 * 所有引擎都只用公开、免费、免注册的接口，返回统一结构，方便互相替换与降级：
 *   翻译引擎   run(text) -> { translation, terms, translit, src }
 *   英汉/英英   run(word) -> { phonetics, audio, en, zh }
 *   汉英词典   run(word) -> { pinyin, groups }
 *
 * 翻译引擎的 terms 是「按词性分组的对应词条」：英译中时是中文释义，中译英时是英文对应词。
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
  n: '名词', v: '动词', adj: '形容词', adv: '副词',
  // 汉英词典（金山词霸）给的是单字词性
  '名': '名词', '动': '动词', '形': '形容词', '副': '副词', '代': '代词',
  '介': '介词', '连': '连词', '叹': '感叹词', '数': '数词', '量': '量词',
  '助': '助词', '拟声': '拟声词'
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
 * Google 翻译公开端点：一次调用同时拿到整句翻译（dt=t）、词典释义（dt=bd）与音译（dt=rm）。
 * clients5 的 dict-chrome-ex 通道更稳定；translate.googleapis.com 作为备用主机。
 * 目标语言换成 en 就是中译英：dict 变成英文对应词，src_translit 变成拼音。
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

/**
 * 依次试各个主机，把返回的 JSON 交给 parse 解析。parse 抛错（拿到的是限流页、
 * 空译文……）时换下一个主机再试，全试完仍不行就把最后一个错误抛出去。
 */
async function googleFetch(query, parse) {
  let lastError;
  for (const host of GOOGLE_HOSTS) {
    try {
      return parse(await fetchJSON(host + query));
    } catch (err) {
      lastError = err; // 被限流或返回 HTML 时换下一个主机
    }
  }
  throw lastError || new Error('google 请求失败');
}

async function google(text, to = 'zh-CN') {
  const query = `&dj=1&sl=auto&tl=${to}&dt=t&dt=bd&dt=rm&q=` + encodeURIComponent(text);
  return googleFetch(query, (data) => {
    const sentences = data.sentences || [];
    const translation = sentences.map((s) => s.trans || '').join('').trim();
    if (!translation) throw new Error('empty translation');
    const terms = (data.dict || [])
      .map((d) => ({ pos: posZh(d.pos), terms: googleTerms(d) }))
      .filter((g) => g.terms.length);
    const translit = sentences.find((s) => s.src_translit)?.src_translit || '';
    return { translation, terms, translit, src: data.src || 'en' };
  });
}

/** 有道翻译的公开演示接口，中文语境下译文更自然，国内网络也能直连。 */
async function youdao(text, to = 'zh-CN') {
  const url =
    `https://aidemo.youdao.com/trans?from=auto&to=${to === 'en' ? 'en' : 'zh-CHS'}&q=` +
    encodeURIComponent(text);
  const data = await fetchJSON(url);
  if (String(data?.errorCode ?? '') !== '0') throw new Error(`youdao ${data?.errorCode}`);
  const translation = (data.translation || []).join('').trim();
  if (!translation) throw new Error('empty translation');
  return { translation, terms: [], translit: '', src: 'auto' };
}

/** MyMemory：开放的翻译记忆库，匿名调用每天有免费额度。 */
async function mymemory(text, to = 'zh-CN') {
  const pair = to === 'en' ? 'zh-CN|en' : 'en|zh-CN';
  const url =
    `https://api.mymemory.translated.net/get?langpair=${encodeURIComponent(pair)}&q=` +
    encodeURIComponent(text);
  const data = await fetchJSON(url);
  // 超长（单次限 500 字符）或超额度时它照样回 200，把错误话术塞进 translatedText，
  // 只有 responseStatus 会露馅。不挡的话，页面上会出现一句英文报错冒充译文。
  const status = String(data?.responseStatus ?? '200');
  if (status !== '200') throw new Error(`mymemory ${status} ${data?.responseDetails || ''}`.trim());
  const translation = data?.responseData?.translatedText || '';
  if (!translation) throw new Error('empty translation');
  return { translation, terms: [], translit: '', src: pair.split('|')[0] };
}

/**
 * SimplyTranslate：Google 翻译的公共前端镜像，直连被拦截时的备胎。
 * 上游被 Google 限流时它会把错误页原样塞进 translated_text，所以要挡一下 HTML。
 */
async function simplytranslate(text, to = 'zh-CN') {
  const url =
    `https://simplytranslate.org/api/translate?engine=google&from=auto&to=${to}&text=` +
    encodeURIComponent(text);
  const data = await fetchJSON(url);
  const translation = String(data?.translated_text || '').trim();
  if (!translation) throw new Error('empty translation');
  if (/<\/?[a-z][^>]*>/i.test(translation)) throw new Error('upstream blocked');
  return {
    translation,
    terms: [],
    translit: data?.pronunciation || '',
    src: data?.source_language || 'auto'
  };
}

/* ------------------------------------------------------ 整页批量翻译 */

/**
 * 整页翻译一次要送去几百段文字，一段一次请求会立刻被限流，所以把若干段用换行
 * 拼成一串送出去，再按行拆回来 —— 四家服务都会原样保留换行。
 *
 * 拆出来的行数对不上就抛错：宁可让上层换引擎或把这一批拆成两半重试，
 * 也不能把译文错位安到别的段落上。
 */
function linesVia(run) {
  return async (texts, to) => {
    const { translation } = await run(texts.join('\n'), to);
    const parts = translation.split('\n');
    if (parts.length !== texts.length) throw new Error('译文行数与原文对不上');
    return parts.map((t) => t.trim());
  };
}

/**
 * Google 会把长段落切成若干句分别返回，每句都带着自己那截原文（orig），
 * 顺次拼起来正好是送进去的那一串。所以按 orig 里的换行计数归位，
 * 比直接拆译文里的换行稳（长段落的译文里往往一个换行都没有）。
 */
async function googleLines(texts, to = 'zh-CN') {
  const input = texts.join('\n');
  const query = `&dj=1&sl=auto&tl=${to}&dt=t&q=` + encodeURIComponent(input);
  return googleFetch(query, (data) => {
    const sentences = data.sentences || [];
    if (!sentences.length) throw new Error('empty translation');
    const out = Array.from(texts, () => '');
    let i = 0;
    for (const s of sentences) {
      if (i >= texts.length) break;
      // 译文里的换行是 Google 自己带出来的，拼进当前这一段时换成空格。
      out[i] += String(s.trans || '').replace(/\s*\n\s*/g, ' ');
      // 一截原文里有几个换行，就说明它跨过了几段，指针跟着往后挪。
      for (const _ of String(s.orig || '').matchAll(/\n/g)) i++;
    }
    const result = out.map((t) => t.trim());
    if (!result.some(Boolean)) throw new Error('empty translation');
    return result;
  });
}

/* ---------------------------------------------------------- 词典引擎 */

const EMPTY_DICT = {
  phonetics: { uk: '', us: '', text: '' },
  audio: { uk: '', us: '', other: '' },
  en: [],
  zh: []
};

/** 发音文件名里可能出现的口音后缀，如 hello-uk.mp3、data-ie-uk-us.mp3。 */
const ACCENT_TAGS = new Set(['us', 'uk', 'gb', 'au', 'nz', 'ca', 'ie', 'in', 'za']);

/**
 * 从发音链接末尾切出口音标签。一个文件可以同时标多个地区（data-ie-uk-us.mp3），
 * 从后往前收；至少留下一段词形，免得 "us.mp3" 这类文件名被整段当成标签。
 */
function accentTags(url) {
  const file = String(url || '').split('/').pop().replace(/\.\w+$/, '').toLowerCase();
  const parts = file.split('-');
  const tags = [];
  for (let i = parts.length - 1; i >= 1 && ACCENT_TAGS.has(parts[i]); i--) tags.unshift(parts[i]);
  return tags;
}

/** Free Dictionary API：音标、真人发音音频、英文释义与例句。 */
async function dictionaryapi(word) {
  const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word);
  const data = await fetchJSON(url);
  if (!Array.isArray(data) || !data.length) throw new Error('no entry');

  const phonetics = { uk: '', us: '', text: '' };
  const audio = { uk: '', us: '', other: '' };
  const en = [];

  for (const entry of data) {
    if (entry.phonetic && !phonetics.text) phonetics.text = entry.phonetic;
    for (const p of entry.phonetics || []) {
      const url = String(p.audio || '').trim();
      const text = String(p.text || '').trim();
      const tags = url ? accentTags(url) : [];
      const regions = [];
      if (tags.includes('uk') || tags.includes('gb')) regions.push('uk');
      if (tags.includes('us')) regions.push('us');
      for (const r of regions) {
        if (!audio[r]) audio[r] = url;
        if (text && !phonetics[r]) phonetics[r] = text;
      }
      // 澳/新/加等口音不冒充英美音，只在没有英美录音时兜底，免得点“美”听到澳音。
      if (url && !regions.length && !audio.other) audio.other = url;
      if (text && !phonetics.text) phonetics.text = text;
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

/**
 * 有道的通用发音接口，任意英文词都能读（type 1=英音，2=美音）。
 * 词典给的录音链接会失效——Free Dictionary 的媒体服务器尤其不稳——用它兜底。
 */
export function voiceFallback(word, region = 'us') {
  const w = String(word || '').trim();
  if (!w) return '';
  return youdaoVoice(`${encodeURIComponent(w)}&type=${region === 'uk' ? 1 : 2}`);
}

/**
 * 金山词霸的联想接口。英文词返回中文释义，中文词返回英文对应词，
 * 两个方向共用这一次请求，只是 part（词性）一边是 "adj." 一边是 "形"。
 */
async function icibaMeans(word) {
  const url =
    'https://dict-mobile.iciba.com/interface/index.php?c=word&m=getsuggest&nums=1&client=6&is_need_mean=1&word=' +
    encodeURIComponent(word);
  const data = await fetchJSON(url);
  const hit = (data?.message || [])[0];
  return (hit?.means || []).map((g) => [posZh(g.part), g.means || []]);
}

/** 金山词霸：中文释义按词性分组，条目短，一眼能扫完。 */
async function iciba(word) {
  const zh = groupTerms(await icibaMeans(word));
  if (!zh.length) throw new Error('no entry');
  return { ...EMPTY_DICT, zh };
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

/* -------------------------------------------------------- 汉英词典 */

/**
 * 把若干 [词性, 词条数组] 合并成卡片用的分组：同词性并到一起，重复词条只留最先出现的，
 * 每组最多 8 条、最多 4 组。汉英方向常见一个词在多个来源里重复，去重后卡片才不会刷屏。
 */
function groupTerms(pairs) {
  const byPos = new Map();
  const seen = new Set();
  for (const [pos, terms] of pairs) {
    for (const raw of terms) {
      const term = String(raw || '').trim();
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key);
      if (!byPos.has(pos)) byPos.set(pos, []);
      const list = byPos.get(pos);
      if (list.length < 8) list.push(term);
    }
  }
  return [...byPos].map(([pos, terms]) => ({ pos, terms })).slice(0, 4);
}

/** 金山词霸的汉英词条形如 "（写字； 记录； 书写） write"，前面的中文注解对查词没用。 */
function stripZhNote(term) {
  return String(term || '').replace(/^（[^）]*）\s*/, '').trim();
}

/**
 * 有道汉英（jsonapi 的 ce 词典）：拼音 + 按词性分组的英文对应词。
 * 一条 tr.l.i 拼起来才是一个词条：数组里既有 { "#text": "artificial" } 这样的分段，
 * 也有 " " 之类的连接串，逐段丢掉的话 "artificial intelligence" 会被拆成两个词。
 */
async function youdaoce(word) {
  const dicts = encodeURIComponent(JSON.stringify({ count: 1, dicts: [['ce']] }));
  const url = `https://dict.youdao.com/jsonapi?dicts=${dicts}&q=` + encodeURIComponent(word);
  const data = await fetchJSON(url);

  const pinyin = String(data?.ce?.word?.[0]?.phone || data?.simple?.word?.[0]?.phone || '').trim();
  const pairs = [];
  for (const entry of data?.ce?.word || []) {
    for (const group of entry.trs || []) {
      for (const tr of group.tr || []) {
        const line = tr?.l || {};
        const term = (line.i || [])
          .map((item) => (typeof item === 'string' ? item : item?.['#text'] || ''))
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (term) pairs.push([posZh(line.pos), [term]]);
      }
    }
  }
  const groups = groupTerms(pairs);
  if (!groups.length && !pinyin) throw new Error('no entry');
  return { pinyin, groups };
}

/** 金山词霸汉英：词条短，常用义项覆盖得不错，但不给拼音。 */
async function icibace(word) {
  const pairs = (await icibaMeans(word)).map(([pos, terms]) => [pos, terms.map(stripZhNote)]);
  const groups = groupTerms(pairs);
  if (!groups.length) throw new Error('no entry');
  return { pinyin: '', groups };
}

/** 有道联想（le=en）：中文词返回 "book; write; letter" 这样一串英文对应词，接口最轻。 */
async function youdaosuggestce(word) {
  const url =
    'https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&cache=false&le=en&q=' +
    encodeURIComponent(word);
  const data = await fetchJSON(url);
  const entries = data?.data?.entries || [];
  const hit = entries.find((e) => String(e.entry || '').trim() === word) || entries[0];
  const groups = groupTerms([['', String(hit?.explain || '').split(/[;；]/)]]);
  if (!groups.length) throw new Error('no entry');
  return { pinyin: '', groups };
}

/* ------------------------------------------------------------ 注册表 */

/**
 * 英译中：整句译文，Google 还会附带中文词性释义。
 *
 * lines(texts) 是整页翻译用的批量入口：一次送多段、按原顺序返回等长的译文数组。
 * pageNote 是这一项在设置页「网页翻译」下拉框里的说明（整页场景关心的点和划词不同）。
 */
export const TRANSLATE_ENGINES = [
  {
    id: 'google',
    name: 'Google 翻译',
    note: '综合最好，单词还会附带中文词性释义',
    pageNote: '整页翻译最合适：一次能吃下几十段，分段也最准',
    run: (t) => google(t, 'zh-CN'),
    lines: (texts) => googleLines(texts, 'zh-CN')
  },
  {
    id: 'youdao',
    name: '有道翻译',
    note: '中文译文更自然，国内网络可直连',
    pageNote: '译文更自然，国内网络可直连；整页翻译时请求略慢',
    run: (t) => youdao(t, 'zh-CN'),
    lines: linesVia((t) => youdao(t, 'zh-CN'))
  },
  {
    id: 'mymemory',
    name: 'MyMemory',
    note: '开放翻译记忆库，匿名每日有免费额度',
    pageNote: '单次请求限 500 字符，整页翻译容易失败，建议只作降级备胎',
    run: (t) => mymemory(t, 'zh-CN'),
    lines: linesVia((t) => mymemory(t, 'zh-CN'))
  },
  {
    id: 'simplytranslate',
    name: 'SimplyTranslate',
    note: 'Google 的公共镜像，直连被拦时的备胎，有限流',
    pageNote: 'Google 的公共镜像，限流较紧，整页翻译只建议作备胎',
    run: (t) => simplytranslate(t, 'zh-CN'),
    lines: linesVia((t) => simplytranslate(t, 'zh-CN'))
  }
];

/** 中译英：把中文句子译成英文，同一批服务换个目标语言即可。 */
export const ZH_TRANSLATE_ENGINES = [
  { id: 'google', name: 'Google 翻译', note: '综合最好，单词还会附带英文对应词与拼音', run: (t) => google(t, 'en') },
  { id: 'youdao', name: '有道翻译', note: '中文原文理解得更准，国内网络可直连', run: (t) => youdao(t, 'en') },
  { id: 'mymemory', name: 'MyMemory', note: '开放翻译记忆库，匿名每日有免费额度', run: (t) => mymemory(t, 'en') },
  { id: 'simplytranslate', name: 'SimplyTranslate', note: 'Google 的公共镜像，直连被拦时的备胎，有限流', run: (t) => simplytranslate(t, 'en') }
];

/** 英汉：给出中文释义，顺带提供音标与发音。 */
export const CN_DICT_ENGINES = [
  { id: 'youdao', name: '有道词典', note: '中文释义 + 英美音标 + 真人发音，覆盖最全', run: youdaodict },
  { id: 'iciba', name: '金山词霸', note: '按词性分组的短词条，一眼扫得完', run: iciba },
  { id: 'youdaosuggest', name: '有道联想', note: '接口最轻，响应最快，也收派生词', run: youdaosuggest }
];

/** 汉英：中文词给出英文对应词，顺带给拼音。 */
export const ZH_DICT_ENGINES = [
  { id: 'youdaoce', name: '有道汉英', note: '英文对应词按词性分组，另有拼音，覆盖最全', run: youdaoce },
  { id: 'iciba', name: '金山词霸', note: '词条短，常用义项覆盖得不错', run: icibace },
  { id: 'youdaosuggest', name: '有道联想', note: '接口最轻，响应最快，也收词组', run: youdaosuggestce }
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
