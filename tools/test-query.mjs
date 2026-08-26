/**
 * 在 Node 里跑一遍后台的查询逻辑（真实联网），用于自测数据源是否正常。
 * 用法：node tools/test-query.mjs [要查的词或句子...]
 *      node tools/test-query.mjs --engines   # 逐个体检所有引擎
 *      node tools/test-query.mjs --page      # 走一遍整页翻译的批量通道（英文 + 日文两组）
 */
/**
 * Node 的 fetch 没有 cookie 罐，而浏览器里是有的：微软引擎要靠 bing.com 在
 * 打开翻译页时种下的 cookie 才能调接口（credentials: 'include'）。
 * 这里补一个按域名存的极简 cookie 罐，让这个工具跑出来的结果和扩展里一致。
 *
 * 顺带把 User-Agent 也伪装成浏览器：Bing 会挡掉 node/curl 这类 UA（同样回 401），
 * 而扩展在 Chrome 里发请求时本来就带着真实的浏览器 UA。
 */
const cookieJar = new Map();

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const host = new URL(url).hostname;
  const headers = new Headers(init.headers || {});
  headers.set('user-agent', BROWSER_UA);
  const jar = cookieJar.get(host);
  if (jar?.size && init.credentials !== 'omit') {
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const res = await nodeFetch(url, { ...init, headers });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) {
    if (!cookieJar.has(host)) cookieJar.set(host, new Map());
    const bag = cookieJar.get(host);
    for (const line of set) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) bag.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  return res;
};

const store = { sync: {}, local: {}, session: {} };
const listeners = [];
const connectListeners = [];

globalThis.chrome = {
  storage: {
    sync: {
      get: async (d) => ({ ...d, ...store.sync }),
      set: async (o) => Object.assign(store.sync, o)
    },
    local: {
      get: async (k) => ({ [k]: store.local[k] }),
      set: async (o) => Object.assign(store.local, o),
      remove: async (k) => delete store.local[k]
    },
    // 整页翻译的译文缓存放在 session 区
    session: {
      get: async (k) => ({ [k]: store.session[k] }),
      set: async (o) => Object.assign(store.session, o),
      remove: async (k) => delete store.session[k]
    }
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onConnect: { addListener: (fn) => connectListeners.push(fn) },
    onInstalled: { addListener: () => {} }
  }
};

// 中译英默认打开：这个工具就是用来体检数据源的，两个方向都要能试。
store.sync.zhToEn = true;

await import('../src/background/service-worker.js');
const {
  TRANSLATE_ENGINES,
  CN_DICT_ENGINES,
  EN_DICT_ENGINES,
  ZH_TRANSLATE_ENGINES,
  ZH_DICT_ENGINES
} = await import('../src/common/engines.js');

/** --engines：绕过降级链，逐个直连每个引擎，看谁还活着。 */
if (process.argv.includes('--engines')) {
  const probe = async (engine, arg) => {
    const t0 = Date.now();
    try {
      const r = await engine.run(arg);
      const phon = r.phonetics?.uk || r.phonetics?.us || '';
      const brief = r.translation
        ? r.translation
        : [...(r.zh || []), ...(r.groups || []), ...(r.en || [])]
            .map((g) => `[${g.pos}] ${(g.terms || g.defs.map((d) => d.def)).join('；')}`)
            .join(' / ') || JSON.stringify(r).slice(0, 80);
      const extra = [phon || r.pinyin || '', r.audio?.us || r.audio?.uk ? '🔈' : '']
        .filter(Boolean)
        .join(' ');
      console.log(`  ✓ ${engine.id.padEnd(16)} ${Date.now() - t0}ms  ${extra} ${brief.slice(0, 78)}`);
    } catch (err) {
      console.log(`  ✗ ${engine.id.padEnd(16)} ${Date.now() - t0}ms  ${err.message}`);
    }
  };

  console.log('\n翻译引擎（"Chrome extensions are small programs."）');
  for (const e of TRANSLATE_ENGINES) await probe(e, 'Chrome extensions are small programs.');
  console.log('\n英汉词典（"resilient"）');
  for (const e of CN_DICT_ENGINES) await probe(e, 'resilient');
  console.log('\n英英词典（"resilient"）');
  for (const e of EN_DICT_ENGINES) await probe(e, 'resilient');
  console.log('\n中译英引擎（"今天天气很好，我们出去走走吧。"）');
  for (const e of ZH_TRANSLATE_ENGINES) await probe(e, '今天天气很好，我们出去走走吧。');
  console.log('\n汉英词典（"人工智能"）');
  for (const e of ZH_DICT_ENGINES) await probe(e, '人工智能');
  process.exit(0);
}

const ask = (msg) =>
  new Promise((resolve) => listeners[0](msg, {}, resolve));

/**
 * 划词查询走长连接：后台每拼出一块就推一次，最后一次才是完整结果。
 * onPartial 拿到的就是中途的快照，能看出是哪一路拖慢了整张卡片。
 */
function query(text, onPartial = () => {}) {
  return new Promise((resolve, reject) => {
    const inbox = []; // 后台注册的「收内容脚本消息」回调
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    const port = {
      name: 'ld-query',
      onMessage: { addListener: (fn) => inbox.push(fn) },
      onDisconnect: { addListener: () => {} },
      disconnect: () => finish(reject, new Error('连接被后台关掉了')),
      postMessage(res) {
        if (!res.ok) return finish(reject, new Error(res.error));
        if (res.data?.pending?.length) return onPartial(res);
        finish(resolve, res);
      }
    };
    connectListeners.forEach((fn) => fn(port));
    inbox.forEach((fn) => fn({ type: 'query', text }));
  });
}

/**
 * --page：走一遍整页翻译的批量通道，检查译文是不是一段一段对得上。
 *
 * 不给文字就跑下面两组样例。第二组是日文，不能省：Google 对中日韩不按句切分，
 * 整批只回一截，归位逻辑要是只认英文那种形状，就会把整批译文全堆进第一段——
 * 这个错只有拿非拉丁文字的页面试才看得出来。
 */
if (process.argv.includes('--page')) {
  const engine = (process.argv.find((a) => a.startsWith('--page-engine=')) || '').split('=')[1];
  if (engine) store.sync.pageEngine = engine;
  if (process.argv.includes('--no-fallback')) store.sync.fallback = false;

  const given = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const samples = given.length
    ? [['命令行给的段落', given]]
    : [
        ['英文', [
          'What a browser extension actually is',
          'A browser extension is a small software module that customizes the browser. Extensions are built with the same web technologies as ordinary pages.',
          'Sign in',
          'The content script runs inside the page and can read or change the DOM.',
          '© 2024 The Editors. All rights reserved.'
        ]],
        ['日文', [
          'ブラウザ拡張機能とは何か',
          'ブラウザ拡張機能は、ブラウザの動作を変える小さなソフトウェアモジュールです。普通のページと同じ技術で作られています。',
          'ログイン',
          '拡張機能はあなたが訪れるすべてのページの隣に住んでいます。'
        ]]
      ];

  let bad = 0;
  for (const [label, paragraphs] of samples) {
    const t0 = Date.now();
    const res = await ask({ type: 'page:translate', texts: paragraphs });
    console.log(`\n整页翻译 · ${label}（引擎 ${store.sync.pageEngine || 'google'}，${Date.now() - t0}ms）`);
    if (!res.ok) {
      console.log('  ✗', res.error);
      bad++;
      continue;
    }
    res.data.list.forEach((tr, i) => {
      if (!tr) bad++;
      console.log(`  ${tr ? '✓' : '✗'} ${paragraphs[i].slice(0, 46)}`);
      console.log(`     ${tr || '(没译出，页面上保持原文)'}`);
    });
    // 再来一遍：这次应当全部命中缓存，快得多
    const t1 = Date.now();
    await ask({ type: 'page:translate', texts: paragraphs });
    console.log(`  缓存复查：${Date.now() - t1}ms`);
  }
  process.exit(bad ? 1 : 0);
}

// --engine=youdao / --cn=iciba / --en=wiktionary：指定本次使用的引擎
const args = process.argv.slice(2);
for (const flag of args.filter((a) => a.startsWith('--'))) {
  const [k, v] = flag.slice(2).split('=');
  if (k === 'engine') store.sync.engine = v;
  if (k === 'cn') store.sync.cnDictEngine = v;
  if (k === 'en') store.sync.enDictEngine = v;
  if (k === 'zh-engine') store.sync.zhTransEngine = v;
  if (k === 'zh') store.sync.zhDictEngine = v;
  if (k === 'no-zh') store.sync.zhToEn = false;
  if (k === 'no-fallback') store.sync.fallback = false;
}

const words = args.filter((a) => !a.startsWith('--'));
const samples = words.length
  ? words
  : [
      'resilient',
      'book',
      'give up',
      'Chrome extensions are small software programs that customize the browsing experience.',
      '开心',
      '人工智能',
      '今天天气很好，我们出去走走吧。'
    ];

for (const text of samples) {
  console.log('\n─────', JSON.stringify(text.slice(0, 60)));
  const t0 = Date.now();
  let res;
  try {
    // 中途的每一批都打一行：卡片就是按这个节奏一块一块显示出来的
    res = await query(text, (p) => {
      const got = [
        p.data.translation && '译文',
        p.data.zh?.length && '中文释义',
        p.data.en?.length && '英文释义',
        (p.data.phonetics?.uk || p.data.phonetics?.us || p.data.phonetics?.text) && '音标'
      ].filter(Boolean);
      console.log(`  · ${String(Date.now() - t0).padStart(5)}ms 先显示 ${got.join(' + ')}（还在等 ${p.data.pending.join(' ')}）`);
    });
    console.log(`  · ${String(Date.now() - t0).padStart(5)}ms 全部到齐`);
  } catch (err) {
    console.log('  ✗', err.message);
    continue;
  }
  if (res.kind === 'word') {
    const d = res.data;
    console.log(`  ${d.word}  ${d.phonetics.uk || d.phonetics.us || d.phonetics.text || '(无音标)'}`);
    if (d.speak?.text !== d.word) console.log(`    发音读作: ${d.speak?.text || '(无)'}`);
    d.zh.forEach((g) => console.log(`    [${g.pos}] ${g.terms.join('；')}`));
    d.en.forEach((g) => console.log(`    (${g.pos}) ${g.defs[0].def}`));
    const chain = [
      d.audio.us && '美 ' + d.audio.us,
      d.audio.uk && '英 ' + d.audio.uk,
      d.audio.other && '其它 ' + d.audio.other,
      d.audio.tts?.us && '兜底美 ' + d.audio.tts.us,
      d.audio.tts?.uk && '兜底英 ' + d.audio.tts.uk
    ].filter(Boolean);
    console.log('    audio:', chain.join('\n           ') || '(无)');
  } else {
    console.log('  译文:', res.data.translation);
    console.log('    朗读:', res.data.speak?.text ? `${res.data.speak.text.slice(0, 40)} (${res.data.speak.lang})` : '(无)');
  }
  console.log('    来源:', (res.data.sources || []).join(' + ') || '(未知)');
}
