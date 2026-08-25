/**
 * 在 Node 里跑一遍后台的查询逻辑（真实联网），用于自测数据源是否正常。
 * 用法：node tools/test-query.mjs [要查的词或句子...]
 *      node tools/test-query.mjs --engines   # 逐个体检所有引擎
 */
const store = { sync: {}, local: {} };
const listeners = [];

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
    }
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} }
  }
};

await import('../src/background/service-worker.js');
const { TRANSLATE_ENGINES, CN_DICT_ENGINES, EN_DICT_ENGINES } = await import(
  '../src/common/engines.js'
);

/** --engines：绕过降级链，逐个直连每个引擎，看谁还活着。 */
if (process.argv.includes('--engines')) {
  const probe = async (engine, arg) => {
    const t0 = Date.now();
    try {
      const r = await engine.run(arg);
      const phon = r.phonetics?.uk || r.phonetics?.us || '';
      const brief = r.translation
        ? r.translation
        : [...(r.zh || []), ...(r.en || [])]
            .map((g) => `[${g.pos}] ${(g.terms || g.defs.map((d) => d.def)).join('；')}`)
            .join(' / ') || JSON.stringify(r).slice(0, 80);
      const extra = [phon, r.audio?.us || r.audio?.uk ? '🔈' : ''].filter(Boolean).join(' ');
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
  process.exit(0);
}

const ask = (msg) =>
  new Promise((resolve) => listeners[0](msg, {}, resolve));

// --engine=youdao / --cn=iciba / --en=wiktionary：指定本次使用的引擎
const args = process.argv.slice(2);
for (const flag of args.filter((a) => a.startsWith('--'))) {
  const [k, v] = flag.slice(2).split('=');
  if (k === 'engine') store.sync.engine = v;
  if (k === 'cn') store.sync.cnDictEngine = v;
  if (k === 'en') store.sync.enDictEngine = v;
  if (k === 'no-fallback') store.sync.fallback = false;
}

const words = args.filter((a) => !a.startsWith('--'));
const samples = words.length
  ? words
  : [
      'resilient',
      'book',
      'give up',
      'Chrome extensions are small software programs that customize the browsing experience.'
    ];

for (const text of samples) {
  const res = await ask({ type: 'query', text });
  console.log('\n─────', JSON.stringify(text.slice(0, 60)));
  if (!res.ok) {
    console.log('  ✗', res.error);
    continue;
  }
  if (res.kind === 'word') {
    const d = res.data;
    console.log(`  ${d.word}  ${d.phonetics.uk || d.phonetics.us || d.phonetics.text || '(无音标)'}`);
    d.zh.forEach((g) => console.log(`    [${g.pos}] ${g.terms.join('；')}`));
    d.en.forEach((g) => console.log(`    (${g.pos}) ${g.defs[0].def}`));
    console.log('    audio:', d.audio.us || d.audio.uk || '(无)');
  } else {
    console.log('  译文:', res.data.translation);
  }
  console.log('    来源:', (res.data.sources || []).join(' + ') || '(未知)');
}
