/**
 * LightDict 整页翻译：把外文网页就地变成双语对照。
 *
 * 源语言自动识别，目标语言固定为简体中文：英文、日文、韩文、俄文、法文……
 * 只要不是简体中文，都会在原文下面补一段中文译文。
 *
 * 做法是「往原文里塞一行译文」而不是「在原文旁边再摆一份文档」：
 * 找出页面上最内层的那些块级元素（一段、一个标题、一个列表项……），
 * 把译文作为它的最后一个子节点插进去。译文因此继承原文的字体、字号、颜色、
 * 行高与对齐方式，看上去就是同一段文字换了一行；页面原有的排版（列表编号、
 * 表格结构、flex/grid 的子项数量）也不会因为多出一个兄弟节点而错乱。
 *
 * 只在主框架里工作：整页翻译由工具栏按钮或快捷键显式触发，消息只发给 frameId 0。
 */
(() => {
  if (window.__lightdictPageLoaded) return;
  window.__lightdictPageLoaded = true;

  /* ------------------------------------------------------------ 常量 */

  /** 这些标签里的文字要么不是自然语言，要么翻译了反而坏事。 */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TT',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP',
    'SVG', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'VIDEO', 'AUDIO', 'MATH',
    'LD-TR'
  ]);

  /**
   * 按标签名判定块级，而不是去读 getComputedStyle：整页几千个元素逐个算样式太贵，
   * 而这份名单已经覆盖了绝大多数排版。名单外的元素（span、a、b、em……）一律当行内，
   * 由包着它的块级元素连同上下文一起翻译，译文因此是完整的一句而不是碎片。
   */
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER',
    'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HGROUP', 'LABEL', 'LEGEND', 'LI', 'MAIN', 'MENU', 'NAV', 'OL', 'P',
    'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD',
    'TR', 'UL'
  ]);

  const TR_TAG = 'ld-tr';        // 自定义标签，页面 CSS 几乎选不到它
  const MAX_UNIT_CHARS = 3000;   // 单段超过这个长度多半是整页塞进了一个容器，跳过
  const BATCH_CHARS = 1200;      // 一次请求拼多少字符（换行拼接，后台按行拆回）
  const BATCH_LINES = 20;        // 一次请求最多几段
  const CONCURRENCY = 3;         // 同时在飞的请求数，再多容易被限流
  const MAX_FAILS = 3;           // 连续失败几批就停手，不再骚扰接口
  const MAX_UNITS = 1000;        // 一次扫描最多收多少段，防止超大页面失控
  const RESCAN_DELAY = 700;      // 页面新增内容后等多久再扫（无限滚动会连着变）

  /* ------------------------------------------------------------ 状态 */

  let on = false;
  let busy = false;
  let pending = false;
  let fails = 0;
  let handled = new WeakSet(); // 已经处理过的段落，重扫时跳过
  const wrapped = new Map();   // 为了插译文而临时改过 flex-wrap 的容器 → 它原来的 style 属性
  let observer = null;
  let rescanTimer = null;
  let stats = { total: 0, done: 0, failed: 0, error: '' };

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

  /* -------------------------------------------------------- 段落收集 */

  function skipped(el) {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (el.id === 'lightdict-host' || el.id === 'lightdict-page-hud') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    return false;
  }

  function isBlock(el) {
    return BLOCK_TAGS.has(el.tagName.toUpperCase());
  }

  /** 段落文字：innerText 拿到的是「渲染后」的文本，隐藏起来的内容自然不会被收进来。 */
  function unitText(el) {
    return String(el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------ 源语言识别 */

  /**
   * 源语言不问用户、也不额外发一次请求去问服务：翻译引擎自己都带自动识别
   * （Google 的 sl=auto、微软的 auto-detect……），这里只需要判断「这一段还要不要翻」。
   *
   * 判据是字符所属的文字系统，不是具体语种——反正目标语言只有简体中文一个，
   * 分得清「已经是简体中文」和「不是」就够了。麻烦只出在汉字上：中文、日文、
   * 韩文共用这批字，所以汉字要不要翻，得看这一段自称的语言（见 hanIsZh）。
   */

  /** 假名与谚文：只要出现，这段就一定是日文或韩文，不必再看汉字占比。 */
  const KANA_HANGUL = /[\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;

  /** 汉字（含扩展 A 区与兼容区）。 */
  const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

  /**
   * 成词的非汉字文字：连着两个「不是汉字的字母」。拉丁、西里尔、希腊、阿拉伯、
   * 天城、泰文……一网打尽，比逐个列出各语种的码位可靠得多。
   * 要求连着两个，是为了滤掉编号、单位、符号（"3"、"A"、"→"）这类不是语言的东西。
   */
  const FOREIGN_WORD = /(?:(?![\u2e80-\u2fff\u3005\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\p{L}){2}/u;

  /** 这些语言里的汉字不是简体中文：日文、韩文的汉字词，以及繁体中文。 */
  const HAN_NOT_ZH = /^(ja|ko|zh-(hant|tw|hk|mo)|yue|lzh)\b/;

  /**
   * 就近取这一段自称的语言：元素上的 lang 优先于 <html lang>。
   * 中文页面里引一段日文、日文页面里引一段中文，都靠它区分开。
   */
  function langOf(el) {
    const node = el.closest('[lang]');
    return node?.getAttribute('lang') || document.documentElement.lang || '';
  }

  /** 这一段里的汉字算不算「已经是简体中文」（算，就不用翻了）。 */
  function hanIsZh(lang) {
    return !HAN_NOT_ZH.test(String(lang).trim().toLowerCase());
  }

  /**
   * 值得翻译的一段：里面得有成词的外文，而且它还不是简体中文。
   *
   * zhHan 由 hanIsZh() 给出，说的是「这一段里的汉字算不算中文」——
   * 日文、韩文、繁体中文里的汉字都还要翻，简体中文里的当然不翻。
   */
  function translatable(text, zhHan) {
    if (text.length < 2 || text.length > MAX_UNIT_CHARS) return false;
    // 假名 / 谚文：日文里汉字本来就多，再去算汉字占比只会把整段误判成中文。
    if (KANA_HANGUL.test(text)) return true;
    const han = (text.match(HAN) || []).length;
    // 成词的外文，且没被汉字淹没：中文段落里夹几个品牌名、缩写不算外文段落。
    if (FOREIGN_WORD.test(text) && han * 4 < text.length) return true;
    // 到这儿就只剩汉字了：日文、韩文、繁体页面里的汉字词照翻，简体的放过。
    return han > 0 && !zhHan;
  }

  /**
   * 这一段用的是哪套文字。批量翻译时一次请求只送同一套文字的段落：
   * 引擎的自动识别是「整个请求认一门语言」，把俄文段和日文段拼进同一次请求，
   * 认出来的那一门会把另一门连蒙带猜地译错（比原样留着还糟）。
   *
   * 假名、汉字、谚文合并成一类 cjk：日文页面里本来就混着「全是汉字」的短语
   * （地名、机构名），拆开只会把请求数翻几倍，而三者互相误认的代价小得多。
   */
  const SCRIPTS = [
    ['cjk', /[\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/],
    ['cyrl', /[\u0400-\u052f]/],
    ['grek', /[\u0370-\u03ff\u1f00-\u1fff]/],
    ['arab', /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/],
    ['hebr', /[\u0590-\u05ff]/],
    ['thai', /[\u0e00-\u0e7f]/],
    ['deva', /[\u0900-\u097f]/]
  ];

  function scriptOf(text) {
    for (const [name, re] of SCRIPTS) if (re.test(text)) return name;
    return 'latn'; // 拉丁字母，以及上面没列到的小语种，一律归在一起
  }

  /**
   * 深度优先找「最内层的块级元素」：还有块级子元素就继续往下走，
   * 走到头的那个块级元素就是一段。夹在块级子元素之间的散装文本会被漏掉，
   * 这种写法很少见，为此把整棵树切碎并不划算。
   */
  function walk(el, out) {
    if (out.length >= MAX_UNITS || skipped(el)) return;

    let hasBlockChild = false;
    for (const kid of el.children) {
      if (isBlock(kid) && !skipped(kid)) {
        hasBlockChild = true;
        break;
      }
    }
    if (hasBlockChild) {
      for (const kid of el.children) walk(kid, out);
      return;
    }
    if (!isBlock(el) || handled.has(el)) return;

    const text = unitText(el);
    if (!translatable(text, hanIsZh(langOf(el)))) return;
    const rects = el.getClientRects();
    if (!rects.length) return; // 没有渲染框（折叠菜单、隐藏标签页……）

    handled.add(el);
    out.push({ el, text, top: rects[0].top, script: scriptOf(text) });
  }

  /** 先翻眼前看得见的，再往下、最后才回头补视口上方的——读者的视线在哪就先给哪。 */
  function collect() {
    const out = [];
    if (document.body) walk(document.body, out);
    out.sort((a, b) => order(a.top) - order(b.top));
    return out;
  }

  function order(top) {
    return top >= -50 ? top : 1e7 - top;
  }

  /* -------------------------------------------------------- 译文插入 */

  /**
   * 译文节点的样式。除了「另起一行」必需的那几条，其余一律 inherit：
   * 译文要和原文长得一模一样，就不能自作主张定字体和颜色。
   * 每条都加 !important，免得页面用 `article * { ... }` 这类规则把它改掉。
   */
  const TR_BASE = [
    'display: block',
    'width: 100%',        // 父级是 flex 时不加这条，译文会被挤到原文右边
    'flex-basis: 100%',
    'grid-column: 1 / -1',
    'margin: .35em 0 0',
    'padding: 0',
    'float: none',
    'position: static',
    'max-width: none',
    'max-height: none',
    'height: auto',
    'overflow: visible',
    'white-space: normal', // 原文若是 nowrap，长译文会把容器撑破
    'text-overflow: clip',
    'font: inherit',
    'color: inherit',
    'line-height: inherit',
    'text-align: inherit',
    'text-indent: 0',
    'letter-spacing: normal',
    'visibility: visible',
    'opacity: 1',
    'pointer-events: auto',
    'user-select: text'
  ];

  const TR_VARIANT = {
    plain: [],
    muted: ['opacity: .72'],
    dotted: ['text-decoration: underline dotted currentColor', 'text-underline-offset: 3px']
  };

  function trStyle(kind) {
    return [...TR_BASE, ...(TR_VARIANT[kind] || [])].map((d) => `${d} !important`).join(';');
  }

  let styleKind = 'plain';

  /**
   * 段落本身是一行不换行的 flex 容器（导航条最典型）时，插进去的译文会被挤在原文右边，
   * 把原本的几项压扁。给这种容器临时加上 flex-wrap: wrap，让译文自己占一行。
   *
   * 原来的 style 属性整条存进 wrapped，恢复原文时整条写回去（本来没有就整条删掉）。
   * 全程只动 style 这个属性、不碰 el.style：Blink 里只要写过一次 el.style，
   * 哪怕之后把属性删掉，序列化时也会重新冒出一个空的 style=""，页面就不是原样了。
   */
  function ensureWrap(el) {
    if (wrapped.has(el)) return;
    const css = getComputedStyle(el);
    if (!/^(inline-)?flex$/.test(css.display) || css.flexWrap !== 'nowrap') return;
    const style = el.getAttribute('style');
    wrapped.set(el, style);
    el.setAttribute('style', (style ? style + ';' : '') + 'flex-wrap: wrap !important');
  }

  function insert(el, text) {
    if (!el.isConnected) return false;
    ensureWrap(el);
    const node = document.createElement(TR_TAG);
    node.setAttribute('data-ld-tr', '');
    node.style.cssText = trStyle(styleKind);
    node.textContent = text;
    el.appendChild(node);
    return true;
  }

  function clearAll() {
    for (const node of document.querySelectorAll(`${TR_TAG}[data-ld-tr]`)) node.remove();
    for (const [el, style] of wrapped) {
      if (style === null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    }
    wrapped.clear();
    handled = new WeakSet();
    stats = { total: 0, done: 0, failed: 0, error: '' };
    fails = 0;
  }

  /* -------------------------------------------------------- 翻译流程 */

  /**
   * 按字符数和段数拼批：拼太大 URL 会超长，拼太小请求次数又太多。
   * 文字系统一变也另起一批，好让引擎对每一批都只认一门源语言（见 scriptOf）。
   */
  function batches(units) {
    const out = [];
    let cur = [];
    let chars = 0;
    for (const unit of units) {
      const full = cur.length >= BATCH_LINES || chars + unit.text.length > BATCH_CHARS;
      if (cur.length && (full || cur[0].script !== unit.script)) {
        out.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(unit);
      chars += unit.text.length;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function pool(items, size, worker) {
    let i = 0;
    const lane = async () => {
      while (i < items.length && on && fails < MAX_FAILS) await worker(items[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  }

  async function translateBatch(batch) {
    const res = await send({ type: 'page:translate', texts: batch.map((u) => u.text) });
    if (!on) return;
    if (!res?.ok) {
      fails++;
      stats.failed += batch.length;
      stats.error = res?.error || '扩展已更新，请刷新页面';
      hud();
      return;
    }
    fails = 0;
    const list = res.data?.list || [];
    batch.forEach((unit, i) => {
      const text = list[i];
      if (text && insert(unit.el, text)) stats.done++;
      else stats.failed++;
    });
    hud();
  }

  async function run() {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      do {
        pending = false;
        const units = collect();
        if (!units.length) break;
        stats.total += units.length;
        hud();
        await pool(batches(units), CONCURRENCY, translateBatch);
      } while (pending && on && fails < MAX_FAILS);
    } finally {
      busy = false;
      hud(true);
    }
  }

  /** 自己插进页面的节点（译文、右下角提示条），别被下面的观察器当成新内容。 */
  function ours(node) {
    return (
      node.tagName === TR_TAG.toUpperCase() ||
      node.id === 'lightdict-page-hud' ||
      node.id === 'lightdict-host'
    );
  }

  /** 无限滚动、SPA 换页都会往页面里塞新内容，扫一遍把新段落也翻了。 */
  function watch() {
    if (observer || !document.body) return;
    observer = new MutationObserver((records) => {
      if (!on) return;
      const fresh = records.some((r) =>
        [...r.addedNodes].some(
          (n) => (n.nodeType === 1 && !ours(n)) || (n.nodeType === 3 && n.data.trim())
        )
      );
      if (!fresh) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(run, RESCAN_DELAY);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function unwatch() {
    clearTimeout(rescanTimer);
    observer?.disconnect();
    observer = null;
  }

  /* ------------------------------------------------------------ 提示 */

  // 快捷键触发时看不到工具栏弹窗，页面右下角给一个小小的进度条提示。
  let hudHost = null;
  let hudBox = null;
  let hudTimer = null;

  function ensureHud() {
    if (hudBox) return hudBox;
    hudHost = document.createElement('div');
    hudHost.id = 'lightdict-page-hud';
    hudHost.style.cssText =
      'all: initial !important; position: fixed !important; z-index: 2147483647 !important;' +
      'right: 16px !important; bottom: 16px !important; pointer-events: none !important;';
    const root = hudHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .pill {
        font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
              "Microsoft YaHei", Roboto, sans-serif;
        padding: 8px 12px; border-radius: 999px; color: #fff;
        background: rgba(28, 30, 38, .92);
        box-shadow: 0 6px 20px -6px rgba(15, 23, 42, .5);
        opacity: 0; transform: translateY(6px);
        transition: opacity .18s ease, transform .18s ease;
      }
      .pill.show { opacity: 1; transform: none; }
      .pill b { font-weight: 600; color: #a5b4fc; }`;
    hudBox = document.createElement('div');
    hudBox.className = 'pill';
    root.append(style, hudBox);
    (document.body || document.documentElement).appendChild(hudHost);
    return hudBox;
  }

  function hudSay(html, hold = 1600) {
    const box = ensureHud();
    box.innerHTML = html;
    box.classList.add('show');
    clearTimeout(hudTimer);
    if (!hold) return;
    hudTimer = setTimeout(() => {
      box.classList.remove('show');
      // 淡出之后连宿主一起摘掉：说完话就走，页面上不留任何多余节点。
      hudTimer = setTimeout(() => {
        hudHost?.remove();
        hudHost = null;
        hudBox = null;
      }, 400);
    }, hold);
  }

  /** 翻译过程中常驻，结束后停留一会儿再淡出。 */
  function hud(finished = false) {
    if (!on) return;
    if (stats.error && fails >= MAX_FAILS) {
      hudSay(`翻译中断：${escapeHtml(stats.error)}`, 4000);
      return;
    }
    const rest = Math.max(0, stats.total - stats.done - stats.failed);
    if (!finished && rest) {
      hudSay(`LightDict 翻译中 <b>${stats.done}</b>/${stats.total}`, 0);
    } else if (finished) {
      const failNote = stats.failed ? `，${stats.failed} 段没译出` : '';
      hudSay(`已翻译 <b>${stats.done}</b> 段${failNote}`);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /* ------------------------------------------------------------ 开关 */

  function status() {
    return {
      on,
      busy,
      total: stats.total,
      done: stats.done,
      failed: stats.failed,
      error: fails >= MAX_FAILS ? stats.error : ''
    };
  }

  async function toggle() {
    if (on) {
      on = false;
      unwatch();
      clearAll();
      hudSay('已恢复原文');
      return;
    }
    on = true;
    fails = 0;
    stats = { total: 0, done: 0, failed: 0, error: '' };
    const res = await send({ type: 'settings' });
    styleKind = res?.ok ? res.data.pageStyle || 'plain' : 'plain';
    if (!on) return; // 读设置期间又被关掉了
    watch();
    run();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'page:toggle') {
      toggle();
      sendResponse(status());
    } else if (msg?.type === 'page:status') {
      sendResponse(status());
    }
    return false;
  });

  // 译文样式改了就地重画，省得关掉再打开一次。
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !on || !changes.pageStyle) return;
    styleKind = changes.pageStyle.newValue || 'plain';
    const css = trStyle(styleKind);
    for (const node of document.querySelectorAll(`${TR_TAG}[data-ld-tr]`)) node.style.cssText = css;
  });
})();
