/**
 * LightDict 内容脚本：监听划词 → 延迟触发 → 在选区旁弹出卡片。
 * 卡片渲染在 Shadow DOM 里，页面的 CSS 影响不到它，它也影响不到页面。
 */
(() => {
  if (window.__lightdictLoaded) return;
  window.__lightdictLoaded = true;

  const DEFAULTS = {
    enabled: true,
    delay: 400,
    trigger: 'auto',
    theme: 'auto',
    showEnglishDef: true,
    autoSpeak: false,
    zhToEn: false,
    blocklist: []
  };

  let settings = { ...DEFAULTS };
  let host = null;
  let root = null;
  let card = null;
  let timer = null;
  let anchorRect = null;
  let currentText = '';
  let reqId = 0;
  // 当前卡片可用的发音链接：uk/us 是词典给的真人录音，other 是澳/新等口音，
  // tts 是任意词都能读的通用发音接口，用来兜底。
  let audioUrls = { uk: '', us: '', other: '', tts: { uk: '', us: '' } };
  let playingAudio = null;

  /** 汉字（含扩展 A 区与兼容区）：中文选区只在开启「中译英」后才查询。 */
  const ZH_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  /* ------------------------------------------------------------ 样式 */

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  .ld-card {
    --bg: rgba(255, 255, 255, .96);
    --fg: #1c1e21;
    --muted: #6b7280;
    --line: rgba(0, 0, 0, .07);
    --accent: #4f46e5;
    --accent-soft: rgba(79, 70, 229, .1);
    --shadow: 0 12px 32px -8px rgba(15, 23, 42, .25), 0 2px 8px rgba(15, 23, 42, .08);

    position: fixed;
    z-index: 2147483647;
    width: max-content;
    min-width: 240px;
    max-width: 360px;
    padding: 14px 16px 12px;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    box-shadow: var(--shadow);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    font: 400 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", Roboto, sans-serif;
    text-align: left;
    pointer-events: auto;
    opacity: 0;
    transform: translateY(-4px) scale(.98);
    transition: opacity .16s ease, transform .16s cubic-bezier(.22, 1, .36, 1);
    overflow-wrap: break-word;
  }
  .ld-card.ld-show { opacity: 1; transform: none; }
  .ld-card[data-theme="dark"] {
    --bg: rgba(30, 32, 38, .97);
    --fg: #e8eaed;
    --muted: #9aa0a6;
    --line: rgba(255, 255, 255, .1);
    --accent: #a5b4fc;
    --accent-soft: rgba(165, 180, 252, .14);
    --shadow: 0 12px 32px -8px rgba(0, 0, 0, .6), 0 2px 8px rgba(0, 0, 0, .35);
  }

  .ld-arrow {
    position: absolute; width: 10px; height: 10px;
    background: var(--bg);
    border-left: 1px solid var(--line);
    border-top: 1px solid var(--line);
    transform: rotate(45deg);
    left: 20px;
  }
  .ld-card[data-place="below"] .ld-arrow { top: -6px; }
  .ld-card[data-place="above"] .ld-arrow { bottom: -6px; transform: rotate(225deg); }

  .ld-head { display: flex; align-items: flex-start; gap: 10px; }
  .ld-title { flex: 1; min-width: 0; }
  .ld-word {
    display: block; font-size: 19px; font-weight: 600; letter-spacing: -.01em;
    line-height: 1.3; word-break: break-word;
  }
  .ld-phon { display: block; margin-top: 3px; font-size: 12.5px; color: var(--muted); }
  .ld-phon b { font-weight: 500; color: var(--muted); opacity: .7; margin-right: 3px; }
  /* 能单独试听的音标做成按钮，但看上去仍是一行普通文字。 */
  .ld-phon-btn {
    font: inherit; color: inherit; border: 0; padding: 0; background: transparent;
    cursor: pointer; border-radius: 4px;
  }
  .ld-phon-btn:hover, .ld-phon-btn:hover b { color: var(--accent); opacity: 1; }

  .ld-actions { display: flex; gap: 2px; flex-shrink: 0; margin: -4px -6px 0 0; }
  .ld-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border: 0; border-radius: 7px;
    background: transparent; color: var(--muted); cursor: pointer;
    transition: background .12s ease, color .12s ease;
  }
  .ld-btn:hover { background: var(--accent-soft); color: var(--accent); }
  .ld-btn svg { width: 15px; height: 15px; display: block; }
  .ld-btn.ld-on { color: #f59e0b; }
  .ld-btn.ld-on svg { fill: #f59e0b; }

  .ld-body { margin-top: 10px; }
  .ld-sep { height: 1px; background: var(--line); margin: 11px 0; border: 0; }

  .ld-def { display: flex; gap: 8px; margin-top: 6px; font-size: 13.5px; }
  .ld-def:first-child { margin-top: 0; }
  .ld-pos {
    flex-shrink: 0; min-width: 34px; height: 20px; padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 5px; background: var(--accent-soft); color: var(--accent);
    font-size: 11px; font-weight: 600; line-height: 1; margin-top: 2px;
  }
  .ld-terms { flex: 1; min-width: 0; }

  .ld-main { font-size: 15.5px; font-weight: 550; line-height: 1.5; margin-bottom: 9px; }
  .ld-trans { font-size: 15px; line-height: 1.65; }
  .ld-orig {
    margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--line);
    font-size: 12.5px; color: var(--muted); font-style: italic;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }

  .ld-en { margin-top: 4px; font-size: 13px; color: var(--muted); }
  .ld-en-pos { color: var(--accent); font-style: italic; font-size: 12px; margin-right: 5px; }
  .ld-en li { margin-top: 5px; list-style: none; }
  .ld-en .ld-ex { display: block; margin-top: 2px; opacity: .75; font-style: italic; font-size: 12px; }

  .ld-toggle {
    margin-top: 9px; border: 0; background: transparent; padding: 0;
    color: var(--muted); font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .ld-toggle:hover { color: var(--accent); }

  .ld-src {
    margin-top: 10px; padding-top: 7px; border-top: 1px solid var(--line);
    font-size: 11px; line-height: 1.4; color: var(--muted); opacity: .75;
  }
  .ld-src b { font-weight: 600; color: inherit; }

  .ld-skeleton span {
    display: block; height: 11px; border-radius: 5px; margin-top: 8px;
    background: linear-gradient(90deg, var(--line), var(--accent-soft), var(--line));
    background-size: 200% 100%; animation: ld-shine 1.1s linear infinite;
  }
  .ld-skeleton span:nth-child(2) { width: 78%; }
  .ld-skeleton span:nth-child(3) { width: 55%; }
  @keyframes ld-shine { from { background-position: 200% 0; } to { background-position: -200% 0; } }

  .ld-error { font-size: 13px; color: var(--muted); }
  .ld-error b { display: block; color: var(--fg); font-weight: 600; margin-bottom: 3px; }
  `;

  const ICON = {
    speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  /* -------------------------------------------------------- 卡片骨架 */

  // 宿主自身必须拿满 z-index：position:fixed 会创建层叠上下文，
  // Shadow DOM 内部的 z-index 只在宿主内部排序，对页面元素不起作用。
  // 逐条 !important，防止页面用 `body > div { ... !important }` 之类的规则改写它。
  const HOST_CSS = [
    'all: initial',
    'position: fixed',
    'inset: auto',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'background: transparent',
    'overflow: visible',
    'display: block',
    'visibility: visible',
    'opacity: 1',
    'clip-path: none',
    'filter: none',
    'transform: none',
    'pointer-events: none',
    'z-index: 2147483647'
  ]
    .map((d) => `${d} !important`)
    .join(';');

  // top layer 里的元素不参与页面的 z-index 竞争，也不受祖先 transform/filter/overflow 影响，
  // 并且能盖住模态 <dialog> 与全屏元素——这些是普通 DOM 无论如何都盖不过的。
  const CAN_POPOVER = typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.showPopover === 'function';

  const VOID_TAGS = /^(VIDEO|IMG|CANVAS|IFRAME|EMBED|OBJECT|INPUT|TEXTAREA|SELECT)$/;

  /** 最后打开的模态 <dialog>；它会让文档其余部分 inert，卡片按钮会点不动。 */
  function openModal() {
    const list = document.querySelectorAll('dialog[open]');
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        if (list[i].matches(':modal')) return list[i];
      } catch { /* 老版 Chrome 不认 :modal */ }
    }
    return null;
  }

  /**
   * 挂载点。模态框内必须挂进它的子树，否则 inert 会吃掉卡片上的点击；
   * 全屏则只在没有 popover 兜底时才需要挪窝（全屏元素可能是 <video>，退回其父元素）。
   */
  function mountPoint() {
    const modal = openModal();
    if (modal) return modal;
    const fs = document.fullscreenElement;
    if (!CAN_POPOVER && fs) {
      const target = VOID_TAGS.test(fs.tagName) ? fs.parentElement : fs;
      if (target) return target;
    }
    return document.body || document.documentElement;
  }

  /** 保证宿主挂在正确的父节点上——SPA 换页时 body 可能被整个替换掉。 */
  function mount() {
    if (!host) return;
    const parent = mountPoint();
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  /** 重新入栈 top layer：后进入的排在更上层，能压住页面稍后打开的弹层。 */
  function promote() {
    if (!CAN_POPOVER || !host || !host.isConnected) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
    } catch { /* 忽略 */ }
    try {
      host.showPopover();
    } catch { /* 页面可能已把 popover 关掉，忽略 */ }
  }

  function demote() {
    if (!CAN_POPOVER || !host || !host.isConnected) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
    } catch { /* 忽略 */ }
  }

  function ensureCard() {
    if (card) {
      mount();
      return card;
    }
    host = document.createElement('div');
    host.id = 'lightdict-host';
    host.style.cssText = HOST_CSS;
    if (CAN_POPOVER) host.setAttribute('popover', 'manual'); // manual：不被 Esc / 点击外部自动关掉
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    card = document.createElement('div');
    card.className = 'ld-card';
    card.setAttribute('data-place', 'below');
    root.append(style, card);
    mount();

    // 页面若改写了宿主的 style，改回来。
    // 比较基准取浏览器规范化后的串，否则每次写回都判不相等，会自触发死循环。
    const normalized = host.getAttribute('style');
    new MutationObserver(() => {
      if (host.getAttribute('style') !== normalized) host.style.cssText = HOST_CSS;
    }).observe(host, { attributes: true, attributeFilter: ['style'] });

    // 卡片内部的鼠标操作不应触发新的查询，也不应被判为「点击外部」。
    card.addEventListener('mousedown', (e) => e.stopPropagation(), true);
    return card;
  }

  function applyTheme() {
    if (!card) return;
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    card.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /* ---------------------------------------------------------- 定位 */

  function place(rect) {
    const gap = 10;
    const margin = 8;
    card.style.visibility = 'hidden';
    card.style.left = '0px';
    card.style.top = '0px';
    card.classList.add('ld-show');

    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const below = rect.bottom + gap + ch <= vh - margin;
    const top = below ? rect.bottom + gap : Math.max(margin, rect.top - gap - ch);
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.min(Math.max(margin, left), vw - cw - margin);

    card.setAttribute('data-place', below ? 'below' : 'above');
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;

    const arrow = card.querySelector('.ld-arrow');
    if (arrow) {
      const cx = rect.left + rect.width / 2 - left;
      arrow.style.left = `${Math.round(Math.min(Math.max(14, cx - 5), cw - 24))}px`;
    }
    card.style.visibility = '';
  }

  /* -------------------------------------------------------- 渲染 */

  function shell(title, phonHtml, actionsHtml, bodyHtml) {
    return `
      <div class="ld-arrow"></div>
      <div class="ld-head">
        <div class="ld-title">
          <span class="ld-word">${title}</span>
          ${phonHtml}
        </div>
        <div class="ld-actions">
          ${actionsHtml}
          <button class="ld-btn" data-act="close" title="关闭 (Esc)">${ICON.close}</button>
        </div>
      </div>
      <div class="ld-body">${bodyHtml}</div>`;
  }

  function renderLoading(text) {
    const short = text.length > 28 ? text.slice(0, 28) + '…' : text;
    card.innerHTML = shell(
      esc(short),
      '',
      '',
      '<div class="ld-skeleton"><span></span><span></span><span></span></div>'
    );
  }

  function renderError(text, message) {
    const short = text.length > 28 ? text.slice(0, 28) + '…' : text;
    card.innerHTML = shell(
      esc(short),
      '',
      '',
      `<div class="ld-error"><b>查询失败</b>${esc(message)}<br>请检查网络，或在扩展选项里更换翻译引擎。</div>`
    );
  }

  /** 卡片底部的来源行：这次结果实际由哪些引擎给出，是否来自本地缓存。 */
  function renderSource(d, cached) {
    const names = (d.sources || []).filter(Boolean);
    if (!names.length) return '';
    const suffix = cached ? ' · 本地缓存' : '';
    return `<div class="ld-src"><b>来源</b> ${esc(names.join(' + ') + suffix)}</div>`;
  }

  function renderWord(d, cached) {
    // 有对应音源的音标做成按钮，点哪个听哪个；没有音源的就是普通文字。
    const phonPart = (region, label, ipa) => {
      const inner = `<b>${label}</b>${esc(ipa)}`;
      const playable = d.audio[region] || d.audio.tts?.[region];
      return playable
        ? `<button class="ld-phon-btn" data-act="speak-${region}" title="播放${label}音">${inner}</button>`
        : `<span>${inner}</span>`;
    };
    const phonParts = [];
    if (d.phonetics.uk) phonParts.push(phonPart('uk', '英', d.phonetics.uk));
    if (d.phonetics.us) phonParts.push(phonPart('us', '美', d.phonetics.us));
    // 中文词给的是拼音而不是音标，标一下免得看着像乱码；点它可以听中文原词怎么念。
    if (!phonParts.length && d.phonetics.text) {
      const zhPinyin = d.lang === 'zh' && 'speechSynthesis' in window;
      const inner = (d.lang === 'zh' ? '<b>拼音</b>' : '') + esc(d.phonetics.text);
      phonParts.push(
        zhPinyin
          ? `<button class="ld-phon-btn" data-act="speak-zh" title="朗读中文">${inner}</button>`
          : inner
      );
    }
    const phon = phonParts.length ? `<span class="ld-phon">${phonParts.join('&nbsp;&nbsp;')}</span>` : '';

    const canSpeak =
      !!(d.audio.us || d.audio.uk || d.audio.other || d.audio.tts?.us || d.audio.tts?.uk) ||
      'speechSynthesis' in window;
    // 查中文词时读的是英文对应词，标题上写清楚要读哪一个。
    const speakTitle = d.speak?.text && d.speak.text !== d.word ? `发音：${d.speak.text}` : '发音';
    const actions =
      (canSpeak
        ? `<button class="ld-btn" data-act="speak" title="${esc(speakTitle)}">${ICON.speak}</button>`
        : '') +
      `<button class="ld-btn" data-act="star" title="加入生词本">${ICON.star}</button>` +
      `<button class="ld-btn" data-act="copy" title="复制">${ICON.copy}</button>`;

    let body = '';
    // 词典释义可能很简略，主译文单独占一行，保证一眼能看懂。
    const covered = d.zh.some((g) =>
      g.terms.some(
        (t) => t.replace(/[!！。]/g, '').toLowerCase() === String(d.translation).toLowerCase()
      )
    );
    if (d.translation && (!d.zh.length || !covered)) {
      body += `<div class="ld-main">${esc(d.translation)}</div>`;
    }
    if (d.zh.length) {
      body += d.zh
        .map(
          (g) => `<div class="ld-def">
            <span class="ld-pos">${esc(g.pos || '释义')}</span>
            <span class="ld-terms">${esc(g.terms.join('；'))}</span>
          </div>`
        )
        .join('');
    }

    if (d.en.length && settings.showEnglishDef) {
      const enHtml = d.en
        .map(
          (g) => `<li><span class="ld-en-pos">${esc(g.pos)}</span>${esc(g.defs[0].def)}
            ${g.defs[0].example ? `<span class="ld-ex">“${esc(g.defs[0].example)}”</span>` : ''}</li>`
        )
        .join('');
      // 默认展开：英文释义是查词的主要用途之一，不该藏在一次点击后面。
      body += `<button class="ld-toggle" data-act="toggle-en">英文释义 ▴</button>
               <ul class="ld-en">${enHtml}</ul>`;
    }

    body += renderSource(d, cached);

    card.innerHTML = shell(esc(d.word), phon, actions, body);
    card.dataset.word = d.word;
    card.dataset.brief = d.translation || (d.zh.length ? d.zh[0].terms.join('；') : '');
    setSpeakTarget(d.speak);
    audioUrls = {
      uk: d.audio.uk || '',
      us: d.audio.us || '',
      other: d.audio.other || '',
      tts: { uk: d.audio.tts?.uk || '', us: d.audio.tts?.us || '' }
    };
    syncStar(d.word);
    if (settings.autoSpeak) speak();
  }

  /** 卡片喇叭读哪一句：中译英读译文，英译中读原文，两边读的都是英文那一侧。 */
  function setSpeakTarget(speak) {
    card.dataset.speakText = speak?.text || '';
    card.dataset.speakLang = speak?.lang || 'en';
  }

  function renderText(d, cached) {
    // 整句没有现成录音，靠浏览器的语音合成来读。
    const canSpeak = !!d.speak?.text && 'speechSynthesis' in window;
    const actions =
      (canSpeak ? `<button class="ld-btn" data-act="speak" title="朗读">${ICON.speak}</button>` : '') +
      `<button class="ld-btn" data-act="copy" title="复制译文">${ICON.copy}</button>`;
    const body = `<div class="ld-trans">${esc(d.translation || '（无结果）')}</div>
                  <div class="ld-orig">${esc(d.text)}</div>
                  ${renderSource(d, cached)}`;
    card.innerHTML = shell('译文', '', actions, body);
    card.dataset.copy = d.translation || '';
    setSpeakTarget(d.speak);
  }

  /* -------------------------------------------------- 卡片内交互 */

  /**
   * 播一个远端录音。链接失效（Free Dictionary 的媒体服务器常年 5xx）或被页面 CSP
   * 拦下时返回 false，由调用方换下一个候选。
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
      playingAudio?.pause();
      playingAudio = el;
    });
  }

  /** 挑一个匹配语言的嗓音：不挑的话系统可能用中文嗓音念英文，听着很怪。 */
  function pickVoice(lang, region) {
    const base = String(lang || 'en').split(/[-_]/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'en';
    const all = speechSynthesis.getVoices() || [];
    const same = all.filter((v) => new RegExp(`^${base}([-_]|$)`, 'i').test(v.lang || ''));
    if (!same.length) return null;
    if (base !== 'en') return same.find((v) => v.localService) || same[0];
    const want = region === 'uk' ? /^en[-_]GB/i : /^en[-_]US/i;
    return (
      same.find((v) => want.test(v.lang) && v.localService) ||
      same.find((v) => want.test(v.lang)) ||
      same.find((v) => v.localService) ||
      same[0]
    );
  }

  /** 所有录音都放不出来时的最后一招（整句朗读也走这里）：本地 TTS。 */
  function speakLocal(text, region, lang = 'en') {
    if (!('speechSynthesis' in window) || !text) return;
    let spoken = false;
    const say = () => {
      if (spoken) return;
      spoken = true;
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(lang, region);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || (lang === 'en' ? (region === 'uk' ? 'en-GB' : 'en-US') : lang);
      u.rate = 0.95;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    };
    // 嗓音列表可能还没加载好，等一下再念，否则挑不到英语嗓音。
    if (speechSynthesis.getVoices().length) say();
    else {
      speechSynthesis.addEventListener('voiceschanged', say, { once: true });
      setTimeout(say, 300);
    }
  }

  /**
   * 发音。指定 region（点音标）时只放那个口音，失败就退到通用发音接口，
   * 不会偷偷换成另一个口音；不指定（点喇叭）时按可用程度依次尝试。
   */
  async function speak(region) {
    // 读的不一定是标题：中文词读它的英文对应词，整句卡片读英文那一侧。
    const text = card.dataset.speakText || card.dataset.word || '';
    const lang = card.dataset.speakLang || 'en';
    const id = reqId; // 期间换了词就别再出声了
    // 美音优先，其次英音；再不行用通用发音接口，最后才轮到澳/新等口音的录音——
    // 口音跟卡片上的音标对不上时，听起来最“怪”的就是它。
    const chain = region
      ? [audioUrls[region], audioUrls.tts[region]]
      : [audioUrls.us, audioUrls.uk, audioUrls.tts.us, audioUrls.other];
    const urls = chain.filter(Boolean);
    const tried = new Set();
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      if (await playUrl(url)) return;
      if (id !== reqId) return;
    }
    if (id === reqId) speakLocal(text, region, lang);
  }

  /** 朗读中文原词：中文词卡片上点拼音时用，走系统的中文嗓音。 */
  function speakZh() {
    playingAudio?.pause();
    speakLocal(card.dataset.word || '', undefined, 'zh');
  }

  async function copy(btn) {
    const text = card.dataset.copy || `${card.dataset.word || ''} ${card.dataset.brief || ''}`.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = btn.innerHTML;
    btn.innerHTML = ICON.check;
    setTimeout(() => (btn.innerHTML = old), 1200);
  }

  async function syncStar(word) {
    const btn = card.querySelector('[data-act="star"]');
    if (!btn) return;
    const res = await send({ type: 'book:has', word });
    if (res?.ok && res.data) btn.classList.add('ld-on');
  }

  async function toggleStar(btn) {
    const res = await send({
      type: 'book:toggle',
      item: {
        word: card.dataset.word,
        brief: card.dataset.brief,
        url: location.href,
        title: document.title
      }
    });
    if (res?.ok) btn.classList.toggle('ld-on', !!res.data);
  }

  function onCardClick(e) {
    const btn = e.target.closest?.('[data-act]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'close') hide();
    else if (act === 'speak') speak();
    else if (act === 'speak-uk') speak('uk');
    else if (act === 'speak-us') speak('us');
    else if (act === 'speak-zh') speakZh();
    else if (act === 'copy') copy(btn);
    else if (act === 'star') toggleStar(btn);
    else if (act === 'toggle-en') {
      const list = card.querySelector('.ld-en');
      const open = list.hasAttribute('hidden');
      list.toggleAttribute('hidden', !open);
      btn.textContent = open ? '英文释义 ▴' : '英文释义 ▾';
      if (anchorRect) place(anchorRect);
    }
  }

  /* ------------------------------------------------------ 显示/隐藏 */

  function hide() {
    clearTimeout(timer);
    reqId++;
    playingAudio?.pause();
    playingAudio = null;
    currentText = '';
    anchorRect = null;
    if (card) {
      card.classList.remove('ld-show');
      card.style.top = '-9999px';
    }
    demote();
  }

  function isVisible() {
    return card && card.classList.contains('ld-show');
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch {
        resolve(null); // 扩展被重载后旧的内容脚本会走到这里
      }
    });
  }

  async function show(text, rect) {
    ensureCard();
    applyTheme();
    anchorRect = rect;
    currentText = text;
    card.dataset.copy = '';
    card.dataset.word = '';
    setSpeakTarget(null);
    audioUrls = { uk: '', us: '', other: '', tts: { uk: '', us: '' } };
    card.removeEventListener('click', onCardClick);
    card.addEventListener('click', onCardClick);

    const id = ++reqId;
    promote();
    renderLoading(text);
    place(rect);

    const res = await send({ type: 'query', text });
    if (id !== reqId) return; // 已被新的查询或关闭动作取代

    if (!res) renderError(text, '扩展已更新，请刷新页面');
    else if (!res.ok) renderError(text, res.error || '未知错误');
    else if (res.kind === 'word') renderWord(res.data, res.cached);
    else renderText(res.data, res.cached);

    place(rect);
  }

  /* -------------------------------------------------------- 选区读取 */

  function insideCard(node) {
    return !!(host && node && host.contains(node.nodeType === 1 ? node : node.parentNode));
  }

  /** 返回 { text, rect }，无有效选区时返回 null。同时兼容输入框内的选中。 */
  function readSelection() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      const { selectionStart: s, selectionEnd: e, value } = el;
      if (typeof s === 'number' && e > s) {
        const text = value.slice(s, e).trim();
        if (text) return { text, rect: el.getBoundingClientRect() };
      }
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    if (insideCard(sel.anchorNode)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  function modifierOk(e) {
    switch (settings.trigger) {
      case 'shift': return !!e.shiftKey;
      case 'ctrl': return !!(e.ctrlKey || e.metaKey);
      case 'alt': return !!e.altKey;
      default: return true;
    }
  }

  /* ---------------------------------------------------------- 事件 */

  function schedule(e) {
    clearTimeout(timer);
    const picked = readSelection();
    if (!picked) {
      if (isVisible()) hide();
      return;
    }
    // 关掉「中译英」时，中文选区一律不响应，连卡片都不弹。
    if (!settings.zhToEn && ZH_CHAR.test(picked.text)) {
      if (isVisible()) hide();
      return;
    }
    if (!modifierOk(e)) return;
    if (picked.text === currentText && isVisible()) return;
    if (picked.text.length > 3000) return;

    const { text, rect } = picked;
    timer = setTimeout(() => {
      // 延迟结束时再确认一次选区仍然存在，避免误弹。
      const again = readSelection();
      if (again && again.text === text) show(text, rect);
    }, Math.max(0, Number(settings.delay) || 0));
  }

  function onMouseUp(e) {
    if (!settings.enabled || insideCard(e.target)) return;
    // 等浏览器把选区更新完再读取
    setTimeout(() => schedule(e), 0);
  }

  function onMouseDown(e) {
    if (insideCard(e.target)) return;
    clearTimeout(timer);
    if (isVisible()) hide();
  }

  /** 键盘选词（Shift + 方向键）也应触发查询。 */
  function onKeyUp(e) {
    if (!settings.enabled) return;
    if (!e.shiftKey || !/^Arrow|^Home$|^End$/.test(e.key)) return;
    schedule(e);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isVisible()) hide();
  }

  function onScrollOrResize() {
    if (!isVisible()) return;
    const picked = readSelection();
    if (!picked) return hide();
    anchorRect = picked.rect;
    const r = picked.rect;
    if (r.bottom < 0 || r.top > document.documentElement.clientHeight) hide();
    else place(r);
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  // 进出全屏会重建 top layer，卡片需要重新挂载并重新入栈。
  document.addEventListener('fullscreenchange', () => {
    if (!isVisible()) return;
    mount();
    promote();
    if (anchorRect) place(anchorRect);
  });
  document.addEventListener('selectionchange', () => {
    if (!isVisible()) return;
    const sel = window.getSelection();
    if (sel && sel.isCollapsed && document.activeElement?.tagName !== 'INPUT') hide();
  });

  /* ---------------------------------------------------------- 初始化 */

  function blocked(list) {
    const h = location.hostname;
    return (
      Array.isArray(list) &&
      list.some((raw) => {
        const rule = String(raw).trim().toLowerCase().replace(/^\*\./, '');
        return rule && (h === rule || h.endsWith('.' + rule));
      })
    );
  }

  send({ type: 'settings' }).then((res) => {
    if (res?.ok && res.data) settings = { ...DEFAULTS, ...res.data };
    if (blocked(settings.blocklist)) settings.enabled = false;
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (blocked(settings.blocklist)) settings.enabled = false;
    applyTheme();
    if (!settings.enabled) hide();
  });
})();
