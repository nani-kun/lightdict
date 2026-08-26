#!/usr/bin/env node
/**
 * 不联网的静态自检：语法、manifest 引用、host_permissions 覆盖、版本一致性。
 *
 * 本项目零依赖也没有 linter，这个脚本就是 CI 里唯一的门槛。
 * 联网的那半边在 tools/test-query.mjs，公开接口没有 SLA，不适合进 CI。
 *
 *   node tools/check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);

/** 递归列出所有源码文件，跳过 .git 与打包产物。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(root);
const js = files.filter((f) => /\.(js|mjs)$/.test(f));

// ---- 1. 语法 ----------------------------------------------------------------
// node --check 按扩展名决定当模块还是脚本解析。内容脚本是普通脚本（没有
// import/export），复制成 .cjs 检；带 import/export 的复制成 .mjs 检。
const tmp = mkdtempSync(join(tmpdir(), 'lightdict-check-'));
try {
  for (const file of js) {
    const src = readFileSync(file, 'utf8');
    const isModule = file.endsWith('.mjs') || /^\s*(import|export)\s/m.test(src);
    const probe = join(tmp, 'probe' + (isModule ? '.mjs' : '.cjs'));
    writeFileSync(probe, src);
    try {
      execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    } catch (e) {
      fail(`语法错误 ${relative(root, file)}\n${String(e.stderr || e.message).trim()}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. manifest 本身 -------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`manifest.json 不是合法 JSON：${e.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    fail(`version 不是合法的扩展版本号：${manifest.version}`);
  }

  // manifest 里点到的每个文件都得真的存在，少一个扩展就加载不起来。
  const referenced = [
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])])
  ].filter(Boolean);

  for (const path of referenced) {
    if (!existsSync(join(root, path))) fail(`manifest 引用了不存在的文件：${path}`);
  }

  // ---- 3. host_permissions 覆盖 ---------------------------------------------
  // 新增引擎最容易漏的一步：写了请求却忘了加权限，运行时才被静默拦掉。
  const allowed = (manifest.host_permissions || []).map((p) => p.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  const used = new Set();
  for (const file of files.filter((f) => f.startsWith(join(root, 'src')))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) used.add(m[1]);
  }
  for (const host of used) {
    if (!allowed.includes(host)) fail(`src/ 里请求了 ${host}，但 manifest 的 host_permissions 没有它`);
  }
  for (const host of allowed) {
    if (!used.has(host)) fail(`host_permissions 里的 ${host} 在 src/ 中已无人使用，请删掉（权限越窄越好）`);
  }

  // ---- 4. 版本一致性 --------------------------------------------------------
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## [${manifest.version}]`)) {
    fail(`CHANGELOG.md 里没有 ${manifest.version} 这一节，发版前请补上`);
  }
}

// ---- 5. 整页翻译的源语言判定 -------------------------------------------------
// translatable() 决定「这一段要不要送去翻译」，判错的代价是整页漏翻或把中文重翻一遍，
// 而它只是几条正则，没法靠肉眼看出来。这里把它从内容脚本里抠出来单独跑一张判定表。
{
  const src = readFileSync(join(root, 'src/content/page-translate.js'), 'utf8');
  const grab = (re) => {
    const m = src.match(re);
    if (!m) fail(`page-translate.js 里找不到 ${re}，源语言判定表跑不起来`);
    return m ? m[0] : '';
  };
  const parts = [
    grab(/const MAX_UNIT_CHARS = [^\n]+/),
    grab(/const KANA_HANGUL = [^\n]+/),
    grab(/const HAN = [^\n]+/),
    grab(/const FOREIGN_WORD = [^\n]+/),
    grab(/const HAN_NOT_ZH = [^\n]+/),
    grab(/function hanIsZh\(lang\) \{[\s\S]*?\n {2}\}/),
    grab(/function translatable\(text, zhHan\) \{[\s\S]*?\n {2}\}/),
    'return (text, lang) => translatable(text, hanIsZh(lang));'
  ];

  // 期望：true = 该翻，false = 该原样跳过。lang 是这一段就近声明的语言。
  const table = [
    ['A browser extension is a small software module.', 'en', true],
    ['Sign in', 'en', true],
    ['Une extension de navigateur est un petit module.', 'fr', true],
    ['Расширение браузера — это небольшой модуль.', 'ru', true],
    ['امتداد المتصفح هو وحدة برمجية صغيرة.', 'ar', true],
    ['ส่วนขยายเบราว์เซอร์คืออะไร', 'th', true],
    ['ブラウザ拡張機能とは何かを説明します。', 'ja', true],   // 假名 + 汉字
    ['ブラウザ拡張機能とは何かを説明します。', '', true],     // 没声明 lang 也认得出
    ['안녕하세요, 브라우저 확장 프로그램입니다.', 'ko', true],
    ['東京都水道局', 'ja', true],                            // 纯汉字，但页面自称日文
    ['瀏覽器擴充功能是一個小型的軟體模組。', 'zh-Hant', true], // 繁体也要转成简体
    ['東京都水道局', 'zh-CN', false],                        // 同样的字，中文页面里放过
    ['这一段本来就是简体中文，不该再翻一次。', 'zh-CN', false],
    ['这一段本来就是简体中文，不该再翻一次。', 'en', false],   // 英文页面里的中文段
    ['使用 Chrome 浏览器打开这个页面就能看到效果', 'zh-CN', false], // 中文夹英文品牌名
    ['2024 / 03 / 04', 'en', false],
    ['→', 'en', false],
    ['A', 'en', false]
  ];

  try {
    const translatable = new Function(parts.join('\n'))();
    for (const [text, lang, want] of table) {
      const brief = JSON.stringify(text.slice(0, 32));
      if (translatable(text, lang) !== want) {
        fail(`源语言判定错了：lang=${lang || '(无)'} ${brief} 应当${want ? '翻译' : '跳过'}`);
      }
      // 计数用的正则带 /g，共用 lastIndex 会让第二次调用结果不同，这里连跑两次比一比。
      if (translatable(text, lang) !== translatable(text, lang)) {
        fail(`源语言判定不稳定（正则 lastIndex 串了状态）：${brief}`);
      }
    }
  } catch (e) {
    fail(`源语言判定表跑不起来：${e.message}`);
  }
}

// ---- 6. 整页翻译的分批 -------------------------------------------------------
// 一次请求只该送同一套文字的段落：引擎的自动识别是整个请求认一门语言，
// 混着送会把其中一门连蒙带猜地译错。分批还必须保持原来的先后顺序。
{
  const src = readFileSync(join(root, 'src/content/page-translate.js'), 'utf8');
  const grab = (re) => {
    const m = src.match(re);
    if (!m) fail(`page-translate.js 里找不到 ${re}，分批检查跑不起来`);
    return m ? m[0] : '';
  };
  const parts = [
    grab(/const BATCH_CHARS = [^\n]+/),
    grab(/const BATCH_LINES = [^\n]+/),
    grab(/const SCRIPTS = \[[\s\S]*?\n {2}\];/),
    grab(/function scriptOf\(text\) \{[\s\S]*?\n {2}\}/),
    grab(/function batches\(units\) \{[\s\S]*?\n {2}\}/),
    'return (texts) => batches(texts.map((text) => ({ text, script: scriptOf(text) })));'
  ];

  try {
    const batches = new Function(parts.join('\n'))();
    const texts = [
      'Sign in',                        // 拉丁
      'A browser extension is small.',  // 拉丁
      'ブラウザ拡張機能とは何か',        // 假名 + 汉字
      '東京都水道局',                    // 纯汉字，和假名同属 cjk，不该另起一批
      'Расширение браузера',            // 西里尔
      'Войти',                          // 西里尔
      'Sign out'                        // 拉丁，回到第一套文字也要另起一批
    ];
    const got = batches(texts);
    const shape = got.map((b) => `${b[0].script}×${b.length}`).join(' ');
    if (shape !== 'latn×2 cjk×2 cyrl×2 latn×1') {
      fail(`整页翻译分批没按文字系统切开：得到 ${shape}`);
    }
    if (got.flat().map((u) => u.text).join('\n') !== texts.join('\n')) {
      fail('整页翻译分批打乱了段落顺序（先翻眼前可见的那套次序会失效）');
    }
  } catch (e) {
    fail(`整页翻译分批检查跑不起来：${e.message}`);
  }
}

// ---- 报告 -------------------------------------------------------------------
if (problems.length) {
  console.error(`✗ ${problems.length} 处问题：\n`);
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}
console.log(`✓ 检查通过：${js.length} 个 JS 文件、manifest v${manifest.version}`);
