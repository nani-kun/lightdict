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

// ---- 报告 -------------------------------------------------------------------
if (problems.length) {
  console.error(`✗ ${problems.length} 处问题：\n`);
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}
console.log(`✓ 检查通过：${js.length} 个 JS 文件、manifest v${manifest.version}`);
