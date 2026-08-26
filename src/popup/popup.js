import { getSettings, setSettings } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
let words = [];
let settings = {};

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const shown = q
    ? words.filter((w) => w.word.toLowerCase().includes(q) || (w.brief || '').includes(q))
    : words;

  $('count').textContent = words.length;
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = words.length && !shown.length ? '没有匹配的生词。' : '还没有收藏的单词。';
  $('list').innerHTML = shown
    .map(
      (w) => `<li data-word="${encodeURIComponent(w.word)}">
        <span class="w">${escapeHtml(w.word)}</span>
        <span class="b" title="${escapeHtml(w.brief || '')}">${escapeHtml(w.brief || '')}</span>
        <button class="del" title="删除">×</button>
      </li>`
    )
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function load() {
  const res = await send({ type: 'book:list' });
  words = res?.ok ? res.data : [];
  render();
}

/* -------------------------------------------------------- 查词翻译 */

/** 和划词卡片上是同一套图标，两处看到的东西保持一致。 */
const ICON = {
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>'
};

let qPort = null;
let qId = 0;
let qData = null;   // 当前结果，发音 / 收藏 / 复制都从它取
let playing = null;

function paintOut(html) {
  $('qOut').hidden = false;
  $('qOut').innerHTML = html;
}

function paintError(message) {
  qData = null;
  paintOut(`<div class="r-error"><b>查询失败</b>${escapeHtml(message)}</div>`);
}

/** 断开上一次查询的长连接：换词或清空输入框后，后台就不用再往回推了。 */
function closeQuery() {
  if (!qPort) return;
  try { qPort.disconnect(); } catch { /* 已经断了 */ }
  qPort = null;
}

/**
 * 查一段文字。和划词卡片走同一条长连接：结果分几批回来，
 * 先到的先显示，没到的那几路先晃一条微光条。
 */
function ask(text) {
  const id = ++qId;
  closeQuery();
  qData = null;
  paintOut('<div class="r-skeleton"><span></span><span></span><span></span></div>');

  let port;
  try {
    port = chrome.runtime.connect({ name: 'ld-query' });
  } catch {
    return paintError('扩展已更新，请重新打开弹窗。');
  }
  qPort = port;
  let got = false;
  port.onMessage.addListener((res) => {
    got = true;
    if (id !== qId) return;
    if (!res?.ok) return paintError(res?.error || '未知错误');
    qData = res.data;
    paintOut(res.kind === 'word' ? wordHtml(res.data, res.cached) : textHtml(res.data, res.cached));
    if (res.kind === 'word') syncStar(res.data.word);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (qPort === port) qPort = null;
    if (!got && id === qId) paintError('扩展已更新，请重新打开弹窗。');
  });
  try {
    // manual：弹窗里的内容是用户亲手输的，不受「中译英」开关约束——他要查的就是这个。
    port.postMessage({ type: 'query', text, manual: true });
  } catch {
    paintError('扩展已更新，请重新打开弹窗。');
  }
}

function headHtml(title, phonHtml, withStar) {
  return `<div class="r-head">
      <div class="r-title">
        <b class="r-word">${title}</b>
        ${phonHtml ? `<span class="r-phon">${phonHtml}</span>` : ''}
      </div>
      <div class="r-acts">
        <button class="r-btn" data-act="speak" title="发音">${ICON.speak}</button>
        ${withStar ? `<button class="r-btn" data-act="star" title="加入生词本">${ICON.star}</button>` : ''}
        <button class="r-btn" data-act="copy" title="复制">${ICON.copy}</button>
      </div>
    </div>`;
}

/** 这次结果实际由哪些引擎给出，是否来自本地缓存。 */
function sourceHtml(d, cached) {
  const names = (d.sources || []).filter(Boolean);
  if (!names.length) return '';
  return `<div class="r-src">来源 ${escapeHtml(names.join(' + ') + (cached ? ' · 本地缓存' : ''))}</div>`;
}

function wordHtml(d, cached) {
  // 有对应音源的音标做成按钮，点哪个听哪个；没有音源的就是普通文字。
  const phonPart = (region, label, ipa) => {
    const inner = `<i>${label}</i>${escapeHtml(ipa)}`;
    const playable = d.audio?.[region] || d.audio?.tts?.[region];
    return playable
      ? `<button class="r-phon-btn" data-act="speak-${region}" title="播放${label}音">${inner}</button>`
      : `<span>${inner}</span>`;
  };
  const parts = [];
  if (d.phonetics.uk) parts.push(phonPart('uk', '英', d.phonetics.uk));
  if (d.phonetics.us) parts.push(phonPart('us', '美', d.phonetics.us));
  // 中文词给的是拼音而不是音标，标一下免得看着像乱码；点它可以听中文原词怎么念。
  if (!parts.length && d.phonetics.text) {
    const zhPinyin = d.lang === 'zh' && 'speechSynthesis' in window;
    const inner = (d.lang === 'zh' ? '<i>拼音</i>' : '') + escapeHtml(d.phonetics.text);
    parts.push(
      zhPinyin
        ? `<button class="r-phon-btn" data-act="speak-zh" title="朗读中文">${inner}</button>`
        : `<span>${inner}</span>`
    );
  }
  const phon = parts.join('');

  // 词典释义可能很简略，主译文单独占一行；释义里已经有同一个词就不再重复一遍。
  const covered = d.zh.some((g) =>
    g.terms.some((t) => t.replace(/[!！。]/g, '').toLowerCase() === String(d.translation).toLowerCase())
  );
  let body = '';
  if (d.translation && (!d.zh.length || !covered)) {
    body += `<div class="r-main">${escapeHtml(d.translation)}</div>`;
  }
  body += d.zh
    .map(
      (g) => `<div class="r-def">
        <span class="r-pos">${escapeHtml(g.pos || '释义')}</span>
        <span class="r-terms">${escapeHtml(g.terms.join('；'))}</span>
      </div>`
    )
    .join('');
  if (settings.showEnglishDef !== false && d.en.length) {
    body += `<ul class="r-en">${d.en
      .map((g) => `<li><em>${escapeHtml(g.pos)}</em>${escapeHtml(g.defs[0].def)}</li>`)
      .join('')}</ul>`;
  }

  const pending = (d.pending || []).length ? '<div class="r-wait"></div>' : '';
  return headHtml(escapeHtml(d.word), phon, true) +
    `<div class="r-body">${body}</div>` + pending +
    // 来源要等各路都落地才算数，中途显示会一变再变。
    ((d.pending || []).length ? '' : sourceHtml(d, cached));
}

function textHtml(d, cached) {
  return headHtml('译文', '', false) +
    `<div class="r-body">
      <div class="r-trans">${escapeHtml(d.translation || '（无结果）')}</div>
      <div class="r-orig">${escapeHtml(d.text)}</div>
    </div>` + sourceHtml(d, cached);
}

/** 一句话摘要，收藏进生词本和复制时都用它。 */
function briefOf(d) {
  return d.translation || (d.zh?.length ? d.zh[0].terms.join('；') : '');
}

/**
 * 播一个远端录音。链接失效（词典的媒体服务器常年 5xx）时返回 false，
 * 由调用方换下一个候选。
 */
function playUrl(url) {
  return new Promise((resolve) => {
    const el = new Audio(url);
    let done = false;
    const settle = (ok) => {
      if (done) return;
      done = true;
      if (!ok) el.pause();
      resolve(ok);
    };
    el.addEventListener('playing', () => settle(true), { once: true });
    el.addEventListener('error', () => settle(false), { once: true });
    el.play().catch(() => settle(false));
    setTimeout(() => settle(false), 4000); // 一直加载不出来的也算失败
    playing?.pause();
    playing = el;
  });
}

/**
 * 发音。指定 region（点音标）时只放那个口音，放不出来就退到通用发音接口，
 * 不会偷偷换成另一个口音；不指定（点喇叭）时按可用程度依次尝试。
 */
async function speak(region) {
  const d = qData;
  if (!d) return;
  const a = d.audio || {};
  // 美音优先，其次英音，再退到通用发音接口，最后才轮到澳/新等口音的录音——
  // 口音跟卡片上的音标对不上时，听起来最「怪」的就是它。
  const chain = region ? [a[region], a.tts?.[region]] : [a.us, a.uk, a.tts?.us, a.other];
  for (const url of chain.filter(Boolean)) {
    if (await playUrl(url)) return;
  }
  // 读的不一定是标题：中文词读它的英文对应词，整句结果读英文那一侧。
  speakLocal(d.speak?.text || d.word || '', region, d.speak?.lang || 'en');
}

/**
 * 所有录音都放不出来时的最后一招：系统语音合成。挑嗓音的规则来自 voices.js，
 * 和划词卡片、设置页的「试听」共用同一份，听到的是同一个嗓音。
 */
function speakLocal(text, region, lang) {
  if (!text || !('speechSynthesis' in window)) return;
  const V = globalThis.LightDictVoices;
  const base = V ? V.baseOf(lang) : 'en';
  const chosen = (base === 'zh' ? settings.voiceZh : settings.voiceEn) || '';
  const voice = V ? V.pick(speechSynthesis.getVoices(), base, region, chosen) : null;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || (base === 'en' ? (region === 'uk' ? 'en-GB' : 'en-US') : 'zh-CN');
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** 朗读中文原词：中文词结果上点拼音时用，走系统的中文嗓音。 */
function speakZh() {
  playing?.pause();
  speakLocal(qData?.word || '', undefined, 'zh');
}

async function copyResult(btn) {
  const d = qData;
  if (!d) return;
  // 词条复制「单词 + 释义」，整句卡片只复制译文。
  const text = d.word ? `${d.word} ${briefOf(d)}`.trim() : d.translation || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch { /* 用户没给剪贴板权限，静默放过 */ }
  const old = btn.innerHTML;
  btn.innerHTML = ICON.check;
  setTimeout(() => (btn.innerHTML = old), 1200);
}

async function syncStar(word) {
  const res = await send({ type: 'book:has', word });
  if (res?.ok && res.data) $('qOut').querySelector('[data-act="star"]')?.classList.add('on');
}

async function toggleStar(btn) {
  const d = qData;
  if (!d?.word) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await send({
    type: 'book:toggle',
    item: { word: d.word, brief: briefOf(d), url: tab?.url || '', title: tab?.title || '' }
  });
  if (!res?.ok) return;
  btn.classList.toggle('on', !!res.data);
  load(); // 下面的生词本列表跟着更新
}

function submitAsk() {
  const text = $('q').value.replace(/\s+/g, ' ').trim();
  if (!text) {
    qId++;
    closeQuery();
    $('qOut').hidden = true;
    return;
  }
  ask(text);
}

function initAsk() {
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAsk();
  });
  $('qGo').addEventListener('click', submitAsk);
  // 清空输入框就把结果收起来，弹窗不至于一直挂着上一次的查询。
  $('q').addEventListener('input', () => {
    if ($('q').value.trim()) return;
    qId++;
    closeQuery();
    $('qOut').hidden = true;
  });
  $('qOut').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'speak') speak();
    else if (act === 'speak-uk') speak('uk');
    else if (act === 'speak-us') speak('us');
    else if (act === 'speak-zh') speakZh();
    else if (act === 'copy') copyResult(btn);
    else if (act === 'star') toggleStar(btn);
  });
  $('q').focus();
}

/* -------------------------------------------------------- 整页翻译 */

let pageTabId = null;
let pagePoll = null;
// 整页翻译的快捷键，初始化时向浏览器问一次：用户改过就显示改后的，
// macOS 上 Chrome 给的是 ⌥T 这样的符号写法。没设置快捷键时留空，只字不提。
let pageShortcut = '';

/** 只发给主框架：整页翻译不管 iframe，状态也就只有一份。 */
function tabSend(msg) {
  return new Promise((resolve) => {
    if (pageTabId == null) return resolve(null);
    chrome.tabs.sendMessage(pageTabId, msg, { frameId: 0 }, (res) => {
      void chrome.runtime.lastError; // 内容脚本跑不到的页面（chrome:// 等）
      resolve(res);
    });
  });
}

/** 按钮上的字随状态走：没开→整页翻译，翻译中→进度，已翻译→恢复原文。 */
function renderPage(state) {
  const btn = $('pageBtn');
  const label = $('pageLabel');
  const note = $('pageNote');

  if (!state) {
    btn.disabled = true;
    label.textContent = '整页翻译';
    note.textContent = '此页面不支持整页翻译（刷新后再试）';
    return;
  }
  btn.disabled = false;
  btn.classList.toggle('on', state.on);
  if (!state.on) {
    label.textContent = '整页翻译';
    note.textContent = '自动识别语言，译成简体中文对照' + (pageShortcut ? `（${pageShortcut}）` : '');
    return;
  }
  label.textContent = '恢复原文';
  const rest = state.total - state.done - state.failed;
  if (state.error) note.textContent = `翻译中断：${state.error}`;
  else if (rest > 0) note.textContent = `翻译中 ${state.done} / ${state.total} 段…`;
  else note.textContent = `已翻译 ${state.done} 段` + (state.failed ? `，${state.failed} 段没译出` : '');
}

/** 翻译过程中轮询进度；翻完就停下，别让弹窗一直忙。 */
function watchPage(state) {
  clearInterval(pagePoll);
  renderPage(state);
  if (!state?.on) return;
  pagePoll = setInterval(async () => {
    const next = await tabSend({ type: 'page:status' });
    renderPage(next);
    const rest = next ? next.total - next.done - next.failed : 0;
    if (!next?.on || (!next.busy && rest <= 0)) clearInterval(pagePoll);
  }, 500);
}

async function initPage() {
  const commands = (await chrome.commands?.getAll?.().catch(() => [])) || [];
  pageShortcut = commands.find((c) => c.name === 'toggle-page')?.shortcut || '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageTabId = tab?.id ?? null;
  watchPage(await tabSend({ type: 'page:status' }));

  $('pageBtn').addEventListener('click', async () => {
    $('pageBtn').disabled = true;
    watchPage(await tabSend({ type: 'page:toggle' }));
  });
}

async function init() {
  settings = await getSettings();
  $('enabled').checked = settings.enabled;
  $('tip').classList.toggle('off', !settings.enabled);
  if (!settings.enabled) $('tip').textContent = '划词功能已关闭。';

  $('enabled').addEventListener('change', async (e) => {
    await setSettings({ enabled: e.target.checked });
    $('tip').classList.toggle('off', !e.target.checked);
    $('tip').textContent = e.target.checked
      ? '选中英文单词或句子，停留片刻即可查询。'
      : '划词功能已关闭。';
  });

  $('search').addEventListener('input', render);

  $('list').addEventListener('click', async (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.classList.contains('del')) {
      const word = decodeURIComponent(li.dataset.word);
      await send({ type: 'book:remove', word });
      words = words.filter((w) => w.word !== word);
      render();
    }
  });

  $('clear').addEventListener('click', async () => {
    if (!words.length) return;
    await send({ type: 'book:clear' });
    words = [];
    render();
  });

  $('export').addEventListener('click', () => {
    if (!words.length) return;
    const text = words.map((w) => `${w.word}\t${w.brief || ''}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    chrome.downloads?.download
      ? chrome.downloads.download({ url, filename: 'lightdict-wordbook.txt' })
      : Object.assign(document.createElement('a'), { href: url, download: 'lightdict-wordbook.txt' }).click();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  initAsk();
  initPage();
  load();
}

init();
