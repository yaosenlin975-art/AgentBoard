#!/usr/bin/env node
'use strict';
/**
 * D10 白盒验证：用**真实便携包布局**核对资源根与包含性判定。
 *
 *   node scripts/desktop/verify-entry-containment.mjs [--pkg <便携包根>]
 *
 * 默认读 dist-package/AgentBoard（qa 现场同形）。不启动服务、不改任何文件。
 *
 * 断言：
 *   ① dev 候选（4 级上溯）逃出资源根 → 被拒
 *   ② 便携包候选（exe_dir/../apps/server）落在资源根内 → 被接受
 *   ③ 资源根 = 包根（同时含 app\ 与 runtime\ 那一级）
 *   ④ 安装版布局：exe_dir/apps/server 在 exe_dir 之内 → 被接受
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const pkgArgIdx = args.indexOf('--pkg');
const PKG =
  pkgArgIdx >= 0
    ? resolve(args[pkgArgIdx + 1])
    : resolve(import.meta.dirname, '..', '..', 'dist-package', 'AgentBoard');

/** 去 \\?\ 前缀、统一分隔符、小写（对应 Rust 的 strip_verbatim + is_within） */
function norm(p) {
  return p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
}

/** 消解 . 与 ..（对应 fs::canonicalize 的路径归一语义，但不碰文件系统） */
function collapse(p) {
  const parts = norm(p).split('\\');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('\\');
}

function isWithin(child, base) {
  const c = collapse(child);
  const b = collapse(base);
  return c === b || c.startsWith(`${b}\\`);
}

if (!existsSync(PKG) || !statSync(PKG).isDirectory()) {
  console.error(`便携包根不存在：${PKG}`);
  console.error('先跑 pnpm package:portable，或用 --pkg 指定');
  process.exit(2);
}

const exeDir = join(PKG, 'app', 'desktop');
// 资源根（便携包）= exe_dir/../.. = 包根。用字符串保留未归一形态，避免 join 就地消解
const root = `${exeDir}\\..\\..`;

const devCandidate = `${exeDir}\\..\\..\\..\\..\\apps\\server\\dist\\index.js`;
const portableCandidate = `${exeDir}\\..\\apps\\server\\dist\\index.js`;
const installedCandidate = join(PKG, 'apps', 'server', 'dist', 'index.js');

console.log(`便携包根       = ${PKG}`);
console.log(`exe_dir        = ${exeDir}`);
console.log(`资源根         = ${collapse(root)}`);
console.log(`  ├ 含 app\\    = ${existsSync(join(collapse(root), 'app'))}`);
console.log(`  └ 含 runtime\\= ${existsSync(join(collapse(root), 'runtime'))}`);
console.log('');
console.log(`dev 候选       = ${collapse(devCandidate)}`);
console.log(`便携包候选     = ${collapse(portableCandidate)}  (存在=${existsSync(portableCandidate)})`);
console.log('');

const pass1 = !isWithin(devCandidate, root);
const pass2 = isWithin(portableCandidate, root);
const pass3 =
  existsSync(join(collapse(root), 'app')) && existsSync(join(collapse(root), 'runtime'));
// 安装版布局单独验：根 = exe_dir 自身
const installedRoot = PKG;
const pass4 = isWithin(installedCandidate, installedRoot);

console.log('=== 断言 ===');
console.log(`① dev 候选逃出资源根被拒        : ${pass1 ? 'PASS' : 'FAIL'}`);
console.log(`② 便携包候选落在根内被接受      : ${pass2 ? 'PASS' : 'FAIL'}`);
console.log(`③ 资源根=包根（同含 app 与 runtime）: ${pass3 ? 'PASS' : 'FAIL'}`);
console.log(`④ 安装版 exe_dir/apps/server 在根内: ${pass4 ? 'PASS' : 'FAIL'}`);
console.log('');
console.log(
  `对照：dev 候选实际落到 ${collapse(devCandidate)}`,
);
console.log(
  `      是否落在便携包根内 = ${isWithin(devCandidate, root)}（应为 false）`,
);

process.exit(pass1 && pass2 && pass3 && pass4 ? 0 : 1);
