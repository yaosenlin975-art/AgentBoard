#!/usr/bin/env node
/**
 * STALE-CHECK：一条命令复跑「CLI 帮助冒烟 + 产物/源码时间比对」。
 *
 * 用途：产物与源码不同步时主动发现，而不是等 agent 撞上
 * `ReferenceError: addHelpText is not defined`（dist 比 src 旧）或「接口不存在」（服务进程早于 dist）。
 *
 * 用法：
 *   node scripts/check-stale.mjs      # 或 pnpm check:stale
 * 退出码：
 *   0  冒烟全过且所有包产物均为最新
 *   1  有帮助命令非 0 / 输出里出现崩溃堆栈，或有包产物缺失/陈旧（按提示重建后复跑）
 *
 * 不常驻、不构建：只跑一次判定；重建命令由输出给出（`pnpm -r build`，单包用 `pnpm --filter <包名> build`）。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuildFreshness, formatDateTime } from './build-freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const SMOKE_TIMEOUT_MS = 20_000;

/** 帮助命令冒烟清单（卡面 4 条验收里的 5 条命令） */
const HELP_COMMANDS = [
  { label: 'kb --help', args: ['--help'] },
  { label: 'kb knowledge --help', args: ['knowledge', '--help'] },
  { label: 'kb create-issue --help', args: ['create-issue', '--help'] },
  { label: 'kb dep --help', args: ['dep', '--help'] },
  { label: 'kb list-spaces --help', args: ['list-spaces', '--help'] },
];

/** 参与时间比对的包（server 依赖 adapters/shared，任一陈旧都会让服务跑旧代码） */
const PACKAGES = [
  { label: 'packages/cli', filter: '@agentboard/cli', srcDir: join(ROOT, 'packages', 'cli', 'src'), distEntry: join(ROOT, 'packages', 'cli', 'dist', 'index.js') },
  { label: 'packages/shared', filter: '@agentboard/shared', srcDir: join(ROOT, 'packages', 'shared', 'src'), distEntry: join(ROOT, 'packages', 'shared', 'dist', 'index.js') },
  { label: 'packages/adapters', filter: '@agentboard/adapters', srcDir: join(ROOT, 'packages', 'adapters', 'src'), distEntry: join(ROOT, 'packages', 'adapters', 'dist', 'index.js') },
  { label: 'apps/server', filter: '@agentboard/server', srcDir: join(ROOT, 'apps', 'server', 'src'), distEntry: join(ROOT, 'apps', 'server', 'dist', 'index.js') },
];

const CRASH_WORDS = ['ReferenceError', 'SyntaxError', 'Cannot find module', 'ERR_MODULE_NOT_FOUND'];
const STACK_LINE = /^\s+at .+[\\/][^\s]+:\d+:\d+\s*$/m;

function firstMeaningfulLines(text, limit = 4) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines.slice(0, limit).map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
}

function runHelp(command) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...command.args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const problems = [];
  if (result.error !== undefined) {
    problems.push(result.error.code === 'ETIMEDOUT' ? `超时（>${SMOKE_TIMEOUT_MS}ms）` : `无法执行：${result.error.message}`);
  }
  if (result.status !== 0) problems.push(`exit ${result.status ?? 'null'}`);
  for (const word of CRASH_WORDS) {
    if (output.includes(word)) problems.push(`输出含 ${word}`);
  }
  if (STACK_LINE.test(output)) problems.push('输出含异常堆栈行');
  if (output.trim() === '') problems.push('无输出（构建产物可能缺失）');
  return { ok: problems.length === 0, problems, output };
}

console.log(`[stale-check] CLI 帮助冒烟：node ${relative(ROOT, CLI_ENTRY).split('\\').join('/')}`);
let smokeFailed = 0;
for (const command of HELP_COMMANDS) {
  const { ok, problems, output } = runHelp(command);
  if (ok) {
    console.log(`  [OK]   ${command.label}  exit 0`);
  } else {
    smokeFailed += 1;
    console.log(`  [FAIL] ${command.label}  ${problems.join('；')}`);
    for (const line of firstMeaningfulLines(output)) console.log(`         ${line}`);
  }
}

console.log('[stale-check] 产物 / 源码时间比对');
const stalePackages = [];
for (const pkg of PACKAGES) {
  const freshness = checkBuildFreshness(pkg);
  if (freshness.ok) {
    console.log(`  [OK]    ${pkg.label}  产物 ${formatDateTime(freshness.distMtime)} 不早于最新源码`);
  } else {
    stalePackages.push(pkg);
    console.log(`  [STALE] ${pkg.label}  ${freshness.detail}`);
  }
}

const smokePassed = HELP_COMMANDS.length - smokeFailed;
console.log(`[stale-check] 结论：冒烟 ${smokePassed}/${HELP_COMMANDS.length} 通过；产物陈旧 ${stalePackages.length}/${PACKAGES.length}`);
if (smokeFailed > 0 || stalePackages.length > 0) {
  const staleFilters = stalePackages.map((pkg) => pkg.filter);
  console.error('[stale-check] 需重建后复跑：pnpm -r build');
  if (staleFilters.length === 1) console.error(`[stale-check] 只重建该包更快：pnpm --filter ${staleFilters[0]} build`);
  console.error('[stale-check] 再复跑：pnpm check:stale');
  process.exit(1);
}
console.log('[stale-check] 全绿：帮助入口与构建产物均为最新。');
