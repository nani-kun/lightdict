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
  // 语音合成比查词慢得多，允许调用方单独放宽这一次的等待上限。
  const { timeout = TIMEOUT, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { credentials: 'omit', ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postForm(url, fields, init = {}) {
  const res = await fetchWithTimeout(url, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
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

/**
 * MyMemory：开放的翻译记忆库，匿名调用每天有免费额度。
 *
 * 它的 langpair 两头都得写死，没有 sl=auto 那样的开关，但源语言这一头可以写
 * Autodetect，由它自己认（响应里的 detectedLanguage 会说认成了什么）。
 * 中译英方向源语言是确定的，直接写 zh-CN，省得它把一句短中文认成日文。
 */
async function mymemory(text, to = 'zh-CN') {
  const pair = to === 'en' ? 'zh-CN|en' : 'Autodetect|zh-CN';
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
  return { translation, terms: [], translit: '', src: data?.responseData?.detectedLanguage || pair.split('|')[0] };
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

/**
 * 微软翻译：走 Bing 翻译网页版用的那条接口，免注册、无 key，译文质量与 Google 相当，
 * 长句常比 Google 更通顺（响应里的 usedLLM 表示这一句是大模型译的）。
 *
 * 调用前要先打开一次 bing.com/translator，从页面里刮出三样东西：
 *   IG           这次会话的标识，拼在 URL 上；
 *   token / key  页面里的 params_AbusePreventionHelper = [key, token, 有效期]，防滥用用的。
 * 请求还必须带上同一次访问种下的 bing.com cookie，所以这里破例用 credentials: 'include'
 * ——其余引擎一律 'omit'。少任何一样都只会拿到 401 {"ShowCaptcha":false}。
 */
const BING_PAGE = 'https://www.bing.com/translator';
const BING_API = 'https://www.bing.com/ttranslatev3?isVertical=1&IID=translator.5023&IG=';
const BING_TTS = 'https://www.bing.com/tfettts?isVertical=1&IID=translator.5023&IG=';

/** 微软用的语言代码和我们内部用的不是一套：简体中文是 zh-Hans。 */
function bingLang(to) {
  return to === 'en' ? 'en' : 'zh-Hans';
}

/** 页面给的有效期约一小时，提前 60 秒重新取，免得正好卡在边界上被判 401。 */
const BING_MARGIN = 60_000;
let bingSession = { data: null, expiresAt: 0, pending: null };

/** 打开翻译页，刮出 IG 与防滥用的 token / key。 */
async function bingFetchSession() {
  const res = await fetchWithTimeout(BING_PAGE, { credentials: 'include' });
  if (!res.ok) throw new Error(`bing HTTP ${res.status}`);
  const html = await res.text();
  const ig = html.match(/IG:"([A-F0-9]+)"/)?.[1];
  // params_AbusePreventionHelper = [1787704633099,"mnoV9...",3600000]
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
  if (!ig || !abuse) throw new Error('bing 页面结构变了，取不到令牌');
  return { ig, key: abuse[1], token: abuse[2], ttl: Number(abuse[3]) || 3600_000 };
}

/** 取一份仍然有效的会话；同一时刻的多个请求共用同一次刮取，不重复打开页面。 */
async function bingSessionGet() {
  if (bingSession.data && Date.now() < bingSession.expiresAt - BING_MARGIN) return bingSession.data;
  if (!bingSession.pending) {
    bingSession.pending = bingFetchSession()
      .then((data) => {
        bingSession = { data, expiresAt: Date.now() + data.ttl, pending: null };
        return data;
      })
      .catch((err) => {
        bingSession.pending = null; // 失败不留缓存，下次重新取
        throw err;
      });
  }
  return bingSession.pending;
}

/**
 * 送一段文字过去。令牌过期时接口回 401 并附 {"ShowCaptcha":false}，
 * 这时把会话丢掉重刮一次再试；第二次仍不行才把错误抛上去。
 */
async function bingTranslate(text, to = 'zh-CN', retry = true) {
  const { ig, key, token } = await bingSessionGet();
  let data;
  try {
    data = await postForm(
      BING_API + ig,
      { fromLang: 'auto-detect', to: bingLang(to), text, token, key },
      { credentials: 'include' }
    );
  } catch (err) {
    if (retry && /HTTP 401/.test(err.message)) {
      bingSession = { data: null, expiresAt: 0, pending: null };
      return bingTranslate(text, to, false);
    }
    throw err;
  }
  const hit = Array.isArray(data) ? data[0] : null;
  const translation = String(hit?.translations?.[0]?.text || '').trim();
  if (!translation) throw new Error('empty translation');
  return { translation, src: hit?.detectedLanguage?.language || 'auto' };
}

async function microsoft(text, to = 'zh-CN') {
  const { translation, src } = await bingTranslate(text, to);
  // 响应里的 transliteration 注的是译文读音（英译中时是译文的拼音），
  // 和这里 translit 想要的「原文读音」不是一回事，索性留空。
  return { translation, terms: [], translit: '', src };
}

/* ---------------------------------------------------------- 语音合成 */

/**
 * 网络合成只用来读短句。必应合成 1800 字符要等十几秒，而且是全部合成完才回，
 * 中间一声不吭；长文交给浏览器本地朗读反而更快，还能边读边出声。
 */
const TTS_MAX = 400;

/** 合成本来就慢（两三百字要好几秒），单独给一个比查词宽的等待上限。 */
const TTS_TIMEOUT = 15_000;

/** 必应朗读用的是 Azure 的神经网络嗓音，中英各挑一个自然、语调平稳的。 */
const BING_VOICES = {
  'en-uk': { lang: 'en-GB', voice: 'en-GB-SoniaNeural' },
  'en-us': { lang: 'en-US', voice: 'en-US-AvaNeural' },
  zh: { lang: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' }
};

/** 正文要转义再塞进 SSML，否则一个 & 就足以让整段请求变成 400。 */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 这段文字值不值得走网络合成。中英以外的语言（整页翻译里可能碰上）和长文
 * 一律交给本地朗读——两家接口都只保证中英，长文也等不起。
 */
export function ttsSupported(text, lang = 'en') {
  const t = String(text || '').trim();
  return !!t && t.length <= TTS_MAX && (lang === 'zh' || lang === 'en');
}

/**
 * 必应翻译网页版的朗读接口，和翻译共用同一份会话（IG + token + key），
 * 拿回来的是 Azure 神经网络嗓音的 mp3——目前免注册能拿到的最好音质，
 * 中英文都读得了，也不像有道那样只认单词。
 *
 * 令牌过期时它不像翻译那样回 401，而是照样 200、正文却换成
 * {"statusCode":205}，光看 res.ok 会把这段 JSON 当成音频播出去。所以这里认
 * content-type：不是 audio/ 开头就当会话过期，重刮一次再试，第二次仍不行才抛。
 */
export async function bingSpeak(text, lang = 'en', region = 'us', retry = true) {
  const body = String(text || '').trim();
  if (!ttsSupported(body, lang)) throw new Error('这段文字不走网络合成');
  const pick = lang === 'zh' ? BING_VOICES.zh : BING_VOICES[region === 'uk' ? 'en-uk' : 'en-us'];
  const { ig, key, token } = await bingSessionGet();
  // 语速压慢一点：查词时听清每个音，比听得快要紧。
  const ssml =
    `<speak version='1.0' xml:lang='${pick.lang}'><voice name='${pick.voice}'>` +
    `<prosody rate='-10%'>${xmlEscape(body)}</prosody></voice></speak>`;
  const res = await fetchWithTimeout(BING_TTS + ig, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ssml, token, key }).toString(),
    timeout: TTS_TIMEOUT
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('audio/')) {
    if (retry) {
      bingSession = { data: null, expiresAt: 0, pending: null };
      return bingSpeak(text, lang, region, false);
    }
    throw new Error(`bing 朗读失败 HTTP ${res.status} ${type || '无类型'}`);
  }
  return res.arrayBuffer();
}

/**
 * 发音来源，供设置页渲染下拉框，选中的 id 存进配置的 ttsSource。
 * 真正按它筛候选的规则在 common/voices.js 的 ttsAllows()——那份代码内容脚本、
 * 弹窗、设置页三边共用，这里只负责「有哪几项、怎么向用户解释」。
 */
export const TTS_SOURCES = [
  {
    id: 'auto',
    name: '自动',
    note: '必应优先，放不出来退到有道 / 百度，最后才用下面的系统嗓音'
  },
  {
    id: 'bing',
    name: '必应朗读',
    note: 'Azure 的神经网络嗓音，音质最好；和微软翻译共用一份会话，国内直连'
  },
  {
    id: 'baidu',
    name: '百度朗读',
    note: '响应更快，不需要令牌，长句也不挑；音质略逊于必应'
  },
  {
    id: 'local',
    name: '只用系统嗓音',
    note: '完全离线，一律不联网取发音；音质取决于系统里装了哪些嗓音'
  }
];

/**
 * 百度翻译网页版的朗读接口：纯 GET，不要 cookie 也不要令牌，链接直接交给
 * <audio> 就能播，中英文都读得了。必应那条路走不通时用它顶上。
 */
export function baiduVoice(text, lang = 'en') {
  const t = String(text || '').trim();
  if (!ttsSupported(t, lang)) return '';
  // spd 是语速，网页版默认 5；和必应一样压慢一点。
  return (
    `https://fanyi.baidu.com/gettts?lan=${lang === 'zh' ? 'zh' : 'en'}&spd=3&source=web&text=` +
    encodeURIComponent(t)
  );
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
 * Google 返回的 sentences 是把送进去的那一串切开的若干截，每截都带着自己那段原文
 * （orig）和它的译文（trans）；orig 顺次拼起来正好还原成输入。切法却随源语言而变：
 *
 *   英文等有空格分词的语言 —— 按句切，段与段之间的换行落在某一截的结尾；
 *   中日韩等语言           —— 整批只回一截，换行原样留在 orig 和 trans 里。
 *
 * 所以归位要同时认这两种形状：数 orig 里的换行知道这一截跨了几段，再按 trans 里
 * 的换行把它拆开分派下去。两边的换行数对不上就抛错——上层会把这一批对半拆开重试，
 * 也好过把译文错位安到别的段落上。
 */
async function googleLines(texts, to = 'zh-CN') {
  const input = texts.join('\n');
  const query = `&dj=1&sl=auto&tl=${to}&dt=t&q=` + encodeURIComponent(input);
  return googleFetch(query, (data) => {
    const sentences = data.sentences || [];
    if (!sentences.length) throw new Error('empty translation');
    const out = Array.from(texts, () => '');
    let i = 0; // 当前这一截原文从第几段开始
    for (const s of sentences) {
      const trans = String(s.trans || '');
      const breaks = (String(s.orig || '').match(/\n/g) || []).length;
      if (!breaks) {
        // 这一截没跨段：译文里若有换行，那是 Google 自己断的行，拼进来时换成空格。
        if (i < texts.length) out[i] += trans.replace(/\s*\n\s*/g, ' ');
        continue;
      }
      const parts = trans.split('\n');
      if (parts.length !== breaks + 1) throw new Error('译文分段与原文对不上');
      parts.forEach((part, k) => {
        if (i + k < texts.length) out[i + k] += part;
      });
      i += breaks;
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

/**
 * jsonapi 里的 i 字段有时是整串文本，有时是被拆开的若干段（含 { "#text": … }），
 * 逐段丢掉的话 "artificial intelligence" 会被拆成两个词，所以拼起来再用。
 */
function jsonapiText(i) {
  if (typeof i === 'string') return i.trim();
  if (Array.isArray(i)) {
    return i
      .map((item) => (typeof item === 'string' ? item : item?.['#text'] || ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return String(i?.['#text'] || '').trim();
}

/** ee 的例句藏在 exam.i.f.l 里，有的义项没有例句。 */
function eeExample(tr) {
  const l = tr?.exam?.i?.f?.l;
  return jsonapiText((Array.isArray(l) ? l[0] : l)?.i);
}

/** ee.word 查单词时是对象，查词组时可能是数组，统一成数组再遍历。 */
function eeGroups(word) {
  const entries = word ? (Array.isArray(word) ? word : [word]) : [];
  const en = [];
  for (const entry of entries) {
    for (const group of entry?.trs || []) {
      const defs = [];
      for (const tr of group.tr || []) {
        const def = jsonapiText(tr?.l?.i);
        if (def && defs.length < 3) defs.push({ def, example: eeExample(tr) });
      }
      if (defs.length) en.push({ pos: String(group.pos || '').trim(), defs });
    }
  }
  return en;
}

/** 柯林斯的词性标注形如 N-COUNT、V-T、ADJ，取破折号前那截；缩写补个点。 */
function collinsPos(raw) {
  const base = String(raw || '').split('-')[0].trim().toLowerCase();
  if (!base) return '';
  return base.length <= 4 ? `${base}.` : base;
}

/**
 * 柯林斯是双解：tran 形如 "If you <b>abandon</b> a place… 抛弃"，前半截英文释义、
 * 后半截中文对应词，这里只要英文那一半。派生词条目（resilient 下的 resilience）
 * 整条只有中文，截完是空串，正好丢掉。
 */
function collinsDef(tran) {
  const text = stripHtml(tran);
  const cut = text.search(/[\u4e00-\u9fff]/);
  return (cut === -1 ? text : text.slice(0, cut)).replace(/[(（【]\s*$/, '').trim();
}

/** 把柯林斯的词条按词性归拢成卡片用的分组，每组最多 3 条。 */
function collinsGroups(collins) {
  const byPos = new Map();
  for (const item of collins?.collins_entries || []) {
    for (const entry of item?.entries?.entry || []) {
      for (const tran of entry.tran_entry || []) {
        const def = collinsDef(tran.tran);
        if (!def) continue;
        const pos = collinsPos(tran?.pos_entry?.pos);
        if (!byPos.has(pos)) byPos.set(pos, []);
        const list = byPos.get(pos);
        const sent = (tran?.exam_sents?.sent || [])[0];
        if (list.length < 3) list.push({ def, example: String(sent?.eng_sent || '').trim() });
      }
    }
  }
  return [...byPos].map(([pos, defs]) => ({ pos, defs }));
}

/**
 * 有道 jsonapi 的英英词典。ee 是普林斯顿 WordNet 的释义，带例句；同一次请求顺带把
 * 柯林斯高阶双解（collins）也要回来，WordNet 收不到的词就用柯林斯那半截英文定义顶上。
 * 走的是英汉词典同一个域名，国内可直连，顺带还有英美音标与真人发音。
 *
 * dicts 的 count 要给足：只给 1 时服务端只回列表里的第一本，collins 会整本缺席。
 */
async function youdaoee(word) {
  const dicts = encodeURIComponent(JSON.stringify({ count: 99, dicts: [['ee', 'collins']] }));
  const url = `https://dict.youdao.com/jsonapi?dicts=${dicts}&q=` + encodeURIComponent(word);
  const data = await fetchJSON(url);

  const head = data?.simple?.word?.[0] || {};
  const phonetics = {
    uk: wrapIpa(head.ukphone),
    us: wrapIpa(head.usphone),
    text: wrapIpa(data?.collins?.collins_entries?.[0]?.phonetic)
  };
  const audio = { uk: youdaoVoice(head.ukspeech), us: youdaoVoice(head.usspeech), other: '' };

  const fromEe = eeGroups(data?.ee?.word);
  const en = fromEe.length ? fromEe : collinsGroups(data?.collins);
  if (!en.length) throw new Error('no entry');
  return { ...EMPTY_DICT, phonetics, audio, en: en.slice(0, 4) };
}

/**
 * 必应词典的「英英」标签页。cn.bing.com 国内有节点，但它只有网页没有 JSON 接口，
 * 释义就藏在初始 HTML 的 #homoid 里（默认 display:none，点标签才显示）：
 *
 *   <div id="homoid"><table>
 *     <tr class="def_row …"><td><div class="pos pos1">adj.</div></td>
 *       <td><div class="def_fl"><div class="de_li1 de_li3"><div class="se_d">1.</div>
 *         <div class="df_cr_w">释义里每个词各是一个 <a>，点一下就查那个词</div>
 *
 * 所以拼回整句要把标签去掉再合并空白。后台脚本里没有 DOMParser，只能用正则切。
 * 一次要下载两三百 KB 的整页 HTML，是几个英英引擎里最重的一个。
 */
async function bingdict(word) {
  const url = 'https://cn.bing.com/dict/search?mkt=zh-cn&q=' + encodeURIComponent(word);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // 页面后半段的脚本里还有一个 _homoid="homoid"，锚在 <div 上才不会切错地方。
  const block = html.match(/<div id="homoid"[\s\S]*?<\/table>/)?.[0];
  if (!block) throw new Error('no entry');

  const en = [];
  for (const row of block.split('<tr class="def_row').slice(1)) {
    const pos = stripHtml(row.match(/<div class="pos[^"]*">([\s\S]*?)<\/div>/)?.[1]);
    const defs = [...row.matchAll(/<div class="df_cr_w">([\s\S]*?)<\/div>/g)]
      .map((m) => stripHtml(m[1]))
      .filter(Boolean)
      .slice(0, 3)
      .map((def) => ({ def, example: '' }));
    if (defs.length) en.push({ pos, defs });
  }
  if (!en.length) throw new Error('no entry');
  return { ...EMPTY_DICT, en: en.slice(0, 4) };
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
 * 一条 tr.l.i 拼起来才是一个词条，拼法见 jsonapiText。
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
        const term = jsonapiText(line.i);
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
    id: 'microsoft',
    name: '微软翻译',
    note: '质量与 Google 相当，长句更通顺；走 Bing 翻译，需能访问 bing.com',
    pageNote: '译文质量接近 Google，整页翻译时可作它的主力替代',
    run: (t) => microsoft(t, 'zh-CN'),
    lines: linesVia((t) => microsoft(t, 'zh-CN'))
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
  { id: 'microsoft', name: '微软翻译', note: '质量与 Google 相当，长句更通顺；走 Bing 翻译，需能访问 bing.com', run: (t) => microsoft(t, 'en') },
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

/**
 * 英英：给出英文释义与例句，用来看词的准确用法。
 *
 * 前两家在中国大陆可直连，排在前面；后三家都在境外，直连质量看网络环境
 * ——Wiktionary 走的是 Wikimedia 的域名，大陆连不上，只对能翻墙的用户有意义。
 */
export const EN_DICT_ENGINES = [
  { id: 'youdaoee', name: '有道英英', note: 'WordNet 释义带例句，国内直连最快，没收录的词用柯林斯双解补', run: youdaoee },
  { id: 'bingdict', name: '必应词典', note: '朗文式的整句释义，国内直连，但一次要下载整页 HTML', run: bingdict },
  { id: 'dictionaryapi', name: 'Free Dictionary', note: '英文释义带例句，另有音标与真人发音；需能访问境外站点', run: dictionaryapi },
  { id: 'wiktionary', name: 'Wiktionary', note: '冷僻词和短语也查得到，但中国大陆无法直连', run: wiktionary },
  { id: 'datamuse', name: 'Datamuse', note: '轻量英文释义，响应最快；需能访问境外站点', run: datamuse }
];

/** 把用户选的引擎排在最前；开启降级时后面跟上其余引擎。 */
export function engineOrder(list, id, fallback = true) {
  const preferred = list.filter((e) => e.id === id);
  const rest = list.filter((e) => e.id !== id);
  if (!preferred.length) return fallback ? list : list.slice(0, 1);
  return fallback ? [...preferred, ...rest] : preferred;
}
