/**
 * 在 Node 里跑一遍后台的查询逻辑（真实联网），用于自测数据源是否正常。
 * 用法：node tools/test-query.mjs [要查的词或句子...]
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

const ask = (msg) =>
  new Promise((resolve) => listeners[0](msg, {}, resolve));

const samples = process.argv.slice(2).length
  ? process.argv.slice(2)
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
}
