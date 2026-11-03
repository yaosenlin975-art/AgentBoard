#!/usr/bin/env node
/**
 * BOM 守卫（REPO-BOM-GUARD）。
 *
 * 背景：根 `package.json` 曾被 PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File` 写入，
 * 产生 UTF-8 BOM（EF BB BF）。Vite 会把 package.json 当 PostCSS 配置加载，Node 的 JSON 解析遇到 BOM
 * 直接抛 `Unexpected token '﻿'`，web 测试与 build 全挂，且报错点离真凶很远。
 *
 * 本脚本扫描仓库内「文本配置与源码」的 BOM：
 *   - 命中：逐行列出 `路径  (EF BB BF)` 并以退出码 1 失败（让 CI/pretest 停下）；
 *   - 未命中：打印扫描数量并退出码 0。
 *
/**
 * 用法：
 *   node scripts/check-bom.mjs            # 扫描仓库；「非豁免」命中 → exit 1
 *   node scripts/check-bom.mjs --list     # 只列清单，命中也不失败（人工核查用）
 *   node scripts/check-bom.mjs --strict    # 忽略豁免基线，任何 BOM 都失败（清理存量时用）
 *   node scripts/check-bom.mjs --dir apps # 只扫子目录
 *
 * 存量豁免：`scripts/bom-baseline.txt` 列出本次事故前就带 BOM 的历史文件（只警告、不失败），
 * 免得新增守卫当天就把全仓测试打红；每清掉一个就从基线删一行，清空后本脚本即进入全量阻断模式。
 * 不自动修复：去掉 BOM 会改动文件字节，需单独提交并回读校验，交给人来决定。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOM = [0xef, 0xbb, 0xbf];
const EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.css',
]);
/** 不扫的目录（依赖、产物、工具缓存、非源码快照） */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.codegraph',
  '.superpowers',
  '.workbuddy',
  '.zcode',
  '.logs',
  'dist',
  'coverage',
  'refs',
  'gui-test-screenshots',
  'idle-task-drafts',
]);

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const strict = args.includes('--strict');
const dirIndex = args.indexOf('--dir');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const start = dirIndex >= 0 && args[dirIndex + 1] !== undefined ? resolve(root, args[dirIndex + 1]) : root;
const baselinePath = join(root, 'scripts', 'bom-baseline.txt');

function readBaseline() {
  if (strict) return new Set();
  try {
    return new Set(
      readFileSync(baselinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

const baseline = readBaseline();

function hasBom(path) {
  let fd;
  try {
    fd = readFileSync(path);
  } catch {
    return false;
  }
  return fd.length >= 3 && fd[0] === BOM[0] && fd[1] === BOM[1] && fd[2] === BOM[2];
}

const hits = [];
let scanned = 0;

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
      // `.tmp-*`：临时浏览器 profile（CDP 调试产物，如 .tmp-edge-9356）等一次性目录，不是仓库源码
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    if (dot <= 0) continue;
    if (!EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue;
    scanned += 1;
    try {
      if (statSync(full).size === 0) continue;
    } catch {
      continue;
    }
    if (hasBom(full)) hits.push(relative(root, full).split('\\').join('/'));
  }
}

walk(start);

const fresh = hits.filter((hit) => !baseline.has(hit));
const known = hits.filter((hit) => baseline.has(hit));

if (known.length > 0) {
  console.log(`check-bom: 存量豁免 ${known.length} 个（见 scripts/bom-baseline.txt，清掉一个就删一行）：`);
  for (const hit of known) console.log(`  · ${hit}`);
}

if (fresh.length === 0) {
  console.log(`check-bom: OK（扫描 ${scanned} 个文本文件，新增 BOM 0 个）`);
  process.exit(0);
}

console.log(`check-bom: 发现 ${fresh.length} 个**新增**带 UTF-8 BOM 的文件（扫描 ${scanned} 个）：`);
for (const hit of fresh) console.log(`  ${hit}  (EF BB BF)`);
console.log('');
console.log('修复方式：用 UTF-8 无 BOM 重写（`node` 写字节 / `Set-Content -Encoding utf8NoBOM` / 编辑器保存为 UTF-8），');
console.log('不要用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 或 `Out-File`（会加 BOM）。');

if (listOnly) {
  console.log('（--list：仅列清单，不失败）');
  process.exit(0);
}
process.exit(1);
