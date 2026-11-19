#!/usr/bin/env node
/**
 * 编译产物的 JS 语法守卫（build 后自动跑）。
 *
 * 为什么需要：`tsc` 只做类型检查，不校验正则字面量的**语义**。字符类里的非法转义
 * （典型：`u` 标志下写 `\'`）能编译通过，但 Node 加载模块时直接抛
 * `SyntaxError: Invalid regular expression: ... Invalid escape`。
 * CLI 入口会 import 全部 command 模块，任一模块语法失败 = `kb` 全命令不可用（2026-11-17 事故）。
 *
 * `node --check` 用的就是 V8 的解析器，能在 dist 落盘后立刻抓到这类「TS 合法 / JS 非法」的差异。
 * 退出码：0 全部通过；1 有文件语法失败（列出文件与首行错误）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(cliRoot, 'dist');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(distDir);
} catch {
  console.error(`[check-dist-syntax] 找不到编译产物：${distDir}（先跑 tsc）`);
  process.exit(1);
}

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  // 编译产物是 ESM（package.json type: module）；node --check 对 .js 按包类型解析，失败才记录
  if (result.status !== 0) {
    const message = (result.stderr || '').split('\n').filter(line => line.trim() !== '');
    failures.push({ file: relative(cliRoot, file), message: message.slice(0, 3).join('\n  ') });
  }
}

if (failures.length > 0) {
  console.error(`[check-dist-syntax] ${failures.length} 个产物语法失败（tsc 抓不到这类错误）：`);
  for (const failure of failures) console.error(`  - ${failure.file}\n  ${failure.message}`);
  process.exit(1);
}

console.log(`[check-dist-syntax] OK：${files.length} 个产物语法通过`);
