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
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
  // CR2-06：界面验证的临时产物目录（截图/草稿），不属于仓库源码，不应阻断 build 门禁
  '.qa-temp',
  // D17：Rust 构建产物（cargo target）。与 dist 同类，不是仓库源码。
  // 实测 desktop/src-tauri/target/release/build 下 236 个 crate 子目录，
  // 单个 crate 递归读取 3~26 秒（数十个文件），全量扫描跑不完，构建门禁会永久挂住。
  'target',
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
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return false;
  }
  return buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
}

const hits = [];
let scanned = 0;

/**
 * 已访问目录的实体路径集合（D17）。
 *
 * 防御 junction / symlink 造成的环与重复遍历：Windows 上 node_modules、
 * 以及历史遗留的 apps/desktop/node_modules 都存在指向上级 .pnpm 的 reparse point。
 * 目录树里一旦有 `A -> B -> A`，无环检测的递归就永不返回，构建门禁会静默挂死
 * （表现为进程 CPU 不涨、日志停住，比报错更难查）。
 *
 * 用 realpath 去重而非 lstat：junction 的 lstat 不是 symbolic link，判不出来。
 */
const visitedDirs = new Set();

function walk(dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (visitedDirs.has(real)) return;
  visitedDirs.add(real);
  if (visitedDirs.size > 20000) {
    // 兜底：目录数异常（多半是环或挂载了巨型目录），直接中止，避免门禁挂死
    console.error(`check-bom: 已访问目录超过 20000 个，疑似目录环或异常挂载，中止扫描：${dir}`);
    process.exit(2);
  }

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
    // `.tmp-*` 临时文件（kb list / CDP 抓取脚本等一次性产物）同样不扫：它们不是仓库源码
    if (entry.name.startsWith('.tmp-')) continue;
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

/**
 * 用 `git ls-files` 取待扫描清单（D17）。
 *
 * 为什么不用磁盘递归遍历：本机 D: 是 HDD 且被持续占用，实测平均读延迟 604ms、
 * 队列深度 23（同机 C: SSD 为 0.4ms / 队列 0，差 1500 倍），顺序读仅 5.5 MB/s。
 * 原始实现会走进 `desktop/src-tauri/target`（数万文件），每个文件 open 就要 200-600ms，
 * 结果构建门禁永久挂住、日志停住、CPU 不涨——比报错更难查。
 *
 * `git ls-files` 只读 .git index，实测 23ms 返回 1579 条，且天然满足：
 *   - 只含已跟踪文件（未跟踪的 target / node_modules / dist / 临时目录自动排除）
 *   - 不需要维护 SKIP_DIRS 黑名单
 *   - 不受磁盘遍历速度影响
 *
 * 代价：未跟踪文件不参与 BOM 检查。可接受——未跟踪文件不应阻断 build 门禁；
 * 需要 lint 未跟踪文件时应先 `git add`。
 */
function listFilesViaGit() {
  const t0 = Date.now();
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const all = result.stdout.split('\0').filter(Boolean);
  const picked = all.filter((relPath) => {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    if (base.startsWith('.tmp-')) return false;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return false;
    return EXTENSIONS.has(base.slice(dot).toLowerCase());
  });
  return { files: picked, total: all.length, elapsedMs: Date.now() - t0 };
}

/** 扫描清单（git 不可用时回退磁盘遍历） */
// `--dir` 指定子目录时按磁盘遍历该子树：这是人工定向排查用的，
// 且此时 `git ls-files` 的全仓清单反而不符合语义。
const gitList = dirIndex >= 0 ? null : listFilesViaGit();
if (gitList !== null) {
  const start = Date.now();
  for (const relPath of gitList.files) {
    const full = join(root, relPath);
    scanned += 1;
    try {
      if (statSync(full).size === 0) continue;
    } catch {
      continue;
    }
    if (hasBom(full)) hits.push(relPath);
  }
  const scanMs = Date.now() - start;
  console.log(
    `check-bom: 清单来自 git ls-files（${gitList.files.length}/${gitList.total} 个文本文件，` +
      `取清单 ${gitList.elapsedMs}ms，扫描 ${Math.round(scanMs / 1000)}s）`,
  );
} else {
  console.log('check-bom: git ls-files 不可用，回退磁盘遍历（慢盘上可能很慢）');
  walk(start);
}

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
