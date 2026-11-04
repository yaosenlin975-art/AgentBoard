#!/usr/bin/env node
/**
 * Docs 引用校验（KB-DOC-3）。
 *
 * 目的：让「引用的 Docs/... 目标必须真实存在」成为可执行门禁，避免文档搬迁后
 * 留下一堆指向空气的链接（本次 KB-DOC 迁移的真实动因）。
 *
 * 扫描范围：仓库内文本文件（md / ts / tsx / js / mjs / json / css / html / yml），
 * 跳过依赖、产物、日志与临时目录；提取 `Docs/...` 形式的仓库相对路径引用，逐条查存。
 *
 * 三档结论：
 *   1. 假路径白名单（FAKE_PATHS）：测试断言输入或文字示例，故意不存在的路径，不算问题；
 *   2. 基线已知（scripts/docs-refs-baseline.txt）：本轮受派边界与历史快照造成的存量悬空引用，
 *      只告警、不阻断（修掉后删对应行即可）；
 *   3. 目标不存在：既不在假路径也不在基线的悬空引用 —— 以退出码 1 阻断。
 *
 * 用法：
 *   node scripts/check-docs-refs.mjs            # 扫描全仓；档 3 命中 → exit 1
 *   node scripts/check-docs-refs.mjs --strict   # 基线也视为失败（清存量时用）
 *   node scripts/check-docs-refs.mjs --list     # 只列报告，不失败
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const listOnly = args.includes('--list');

/** 不扫的目录：依赖、产物、日志、外部只读资料与工具缓存 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.logs',
  '.superpowers',
  '.workbuddy',
  '.zcode',
  '.codegraph',
  'refs',
  'gui-test-screenshots',
]);
const EXTS = new Set([
  '.md', '.mdx', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.css', '.html', '.yml', '.yaml',
]);

/**
 * 假路径白名单：它们是断言输入或文字示例，必须保持原样（改了反而破坏语义）。
 * 见知识页 b1b42706 §1.5「测试里的假路径」。
 */
const FAKE_PATHS = new Set([
  'Docs/ref.md',
  'Docs/proof.md',
  'Docs/old-proof.md',
  'Docs/old-source.md',
  'Docs/A.md',
  'Docs/design.md',
  'Docs/交接文档.md',
  'Docs/guide-x.md',
  'Docs/README/skill',
  'Docs/2026-10-30-workbuddy-auth-compat-plan.md',
]);

const baselinePath = join(root, 'scripts', 'docs-refs-baseline.txt');
function readBaseline() {
  try {
    const entries = new Set();
    for (const line of readFileSync(baselinePath, 'utf8').split('\n')) {
      const text = line.trim();
      if (text === '' || text.startsWith('#')) continue;
      entries.add(text);
    }
    return entries;
  } catch {
    return new Set();
  }
}
const baseline = readBaseline();

// 仓库相对 `Docs/` 前缀；排除前面紧跟字母、数字、反斜杠或斜杠的片段
// （避免把 `D:\WorkSpaces\REA\Docs/...` 这类外部绝对路径算成本仓库引用）。
const REF_RE = /(?<![\w\\/])(Docs\/[\w\u4e00-\u9fa5.\-/]+)/gu;

const refs = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.tmp-')) continue;
    if (!EXTS.has(extname(entry.name).toLowerCase())) continue;
    // 校验器自身与基线文件只「声明」路径，不构成引用，跳过以免自指噪音
    if (entry.name === 'check-docs-refs.mjs' || entry.name === 'docs-refs-baseline.txt') continue;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, full).split('\\').join('/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const re = new RegExp(REF_RE.source, 'gu');
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const target = m[1].replace(/\.+$/, '');
        // 纯目录引用（`Docs/`、`Docs/evidence/`）与 glob/占位符不算逐文件引用
        if (target === 'Docs/' || target.endsWith('/')) continue;
        if (/[{}*]/.test(target)) continue;
        refs.push({ file: rel, line: i + 1, target });
      }
    }
  }
}
walk(root);

const missing = refs.filter((r) => !existsSync(join(root, r.target)));
const seen = new Set();
const unique = [];
for (const r of missing) {
  const key = `${r.file}|${r.target}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(r);
}

const fake = unique.filter((r) => FAKE_PATHS.has(r.target));
const known = unique.filter((r) => !FAKE_PATHS.has(r.target) && baseline.has(`${r.file}|${r.target}`));
const broken = unique.filter((r) => !FAKE_PATHS.has(r.target) && !baseline.has(`${r.file}|${r.target}`));

const scannedFiles = new Set(refs.map((r) => r.file)).size;
console.log(
  `check-docs-refs: 扫描 ${refs.length} 处 Docs 引用（${scannedFiles} 个文件）；` +
    `假路径 ${fake.length} 处、基线已知 ${known.length} 处、目标不存在 ${broken.length} 处`,
);

if (fake.length > 0) {
  console.log(`\n假路径白名单（${fake.length} 处，测试断言输入/文字示例，保持原样）：`);
  for (const r of fake) console.log(`  ${r.file}:${r.line}  ->  ${r.target}`);
}

if (known.length > 0) {
  console.log(
    `\n基线已知悬空（${known.length} 处，见 scripts/docs-refs-baseline.txt，只告警）：` +
      (strict ? '' : ' 修掉后删除对应行；--strict 时视为失败'),
  );
  for (const r of known) console.log(`  ${r.file}:${r.line}  ->  ${r.target}`);
}

if (broken.length > 0) {
  console.log(`\n目标不存在（${broken.length} 处，必须修）：`);
  for (const r of broken) console.log(`  ${r.file}:${r.line}  ->  ${r.target}`);
}

if (broken.length === 0 && (!strict || known.length === 0)) {
  console.log('\ncheck-docs-refs: OK');
  process.exit(0);
}

if (listOnly) {
  console.log('\n（--list：仅列报告，不失败）');
  process.exit(0);
}
process.exit(1);
