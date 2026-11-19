#!/usr/bin/env node
/**
 * 编译产物 JS 语法门禁（参数化目录，可复用到任意包）。
 *
 * 为什么需要：`tsc` 只做类型检查，不校验正则字面量的**语义**。
 * 字符类里的非法转义（典型：`u` 标志下写 `\'`）能编译通过，但 Node 加载模块时直接抛
 * `SyntaxError: Invalid regular expression: ... Invalid escape`。
 *
 * 2026-11-17 事故：`packages/cli/dist/commands/createIssue.js` 带了 `/[\"'“”‘’]/u`，
 * CLI 入口 import 全部 command 模块，任一语法失败 = `kb` 全命令不可用（`kb --version` 都崩），
 * 三个 agent 的 `kb` 同时失效近 3 分钟。
 *
 * `node --check` 走 V8 解析器，能在 dist 落盘后立刻抓到这类「TS 合法 / JS 非法”的差异。
 * 它抓不到 import 期失败（ESM 解析、循环依赖、顶层副作用）—— 那是 cli-modules-smoke.mjs 的事。
 *
 * 用法：
 *   node scripts/verify/dist-syntax.mjs                     # 默认 packages/cli/dist
 *   node scripts/verify/dist-syntax.mjs apps/server/dist    # 任意目录（可传多个）
 *   node scripts/verify/dist-syntax.mjs --all-dist          # 仓库全部 packages 与 apps 的 dist
 *
 * 退出码：0 全部通过；1 有文件语法失败（列出**每个**失败文件与首个错误，非只报第一个）
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_DIR = 'packages/cli/dist';

/** 递归收集 *.js（不跟符号链接，避免 junction 环） */
function collectJs(dir) {
  const out = [];
  const walk = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** `--all-dist`：枚举仓库内全部 packages 与 apps 下的 dist 目录 */
function allDistDirs() {
  const dirs = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const dist = join(groupDir, name, 'dist');
      if (existsSync(dist) && statSync(dist).isDirectory()) dirs.push(dist);
    }
  }
  return dirs;
}

const args = process.argv.slice(2);
const targets = args.includes('--all-dist')
  ? allDistDirs()
  : (args.length > 0 ? args : [DEFAULT_DIR]).map((p) => resolve(ROOT, p));

if (targets.length === 0) {
  console.error('[dist-syntax] 没有可检查的 dist 目录（先构建对应包）');
  process.exit(1);
}

/** 检查全部文件，收集**所有**失败后再统一退出（一次跑完能发现全部问题） */
const failures = [];
let checked = 0;
const skipped = [];

for (const dir of targets) {
  if (!existsSync(dir)) {
    skipped.push(dir);
    continue;
  }
  const files = collectJs(dir);
  if (files.length === 0) {
    skipped.push(dir);
    continue;
  }
  for (const file of files) {
    checked += 1;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      const lines = (result.stderr || '')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== '');
      // 取错误首行（含 SyntaxError 描述）与它上一行（含 文件:行号 与源码片段）
      const head = lines.slice(0, 4).join('\n    ');
      failures.push({ file: relative(ROOT, file).split('\\').join('/'), detail: head });
    }
  }
}

for (const dir of skipped) {
  console.log(`[dist-syntax] 跳过（不存在或无 .js）：${relative(ROOT, dir).split('\\').join('/')}`);
}

if (failures.length > 0) {
  console.error(`[dist-syntax] ✘ ${failures.length}/${checked} 个产物语法失败（tsc 抓不到这类错误）：`);
  for (const f of failures) {
    console.error(`  - ${f.file}`);
    console.error(`    ${f.detail}`);
  }
  process.exit(1);
}

console.log(`[dist-syntax] ✔ dist 语法检查通过（${checked} 文件，${targets.length} 个目录）`);
