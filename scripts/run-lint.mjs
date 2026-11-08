/**
 * CR-11：lint 运行器 + 存量违规基线冻结。
 * - `node scripts/run-lint.mjs`：按 eslint.config.mjs 扫描，当前违规数 <= 基线 → exit 0；
 *   任何 (文件, 规则) 超出基线（新增违规）→ 打印明细 exit 1。基线里已经清零的条目会提示收缩（不阻断）。
 * - `node scripts/run-lint.mjs --update-baseline`：以当前违规重写 scripts/eslint-baseline.json（违规清零后用它收缩基线）。
 * 基线只增不瞒：新增违规必须改代码或显式收缩基线，不允许静默放行。
 */
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repoRoot, 'scripts', 'eslint-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');

const eslint = new ESLint({ cwd: repoRoot });
const results = await eslint.lintFiles(['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}']);

/** (file, ruleId) -> error 计数；warning 不入基线（本配置不产 warning，防御未来规则调整误放行） */
const current = new Map();
for (const result of results) {
  const rel = path.relative(repoRoot, result.filePath).replaceAll('\\', '/');
  for (const msg of result.messages) {
    if (msg.severity !== 2 || msg.ruleId === null) continue;
    const key = `${rel}::${msg.ruleId}`;
    current.set(key, (current.get(key) ?? 0) + 1);
  }
  for (const sup of result.suppressedMessages ?? []) {
    if (sup.ruleId === null) continue;
    const key = `${rel}::${sup.ruleId}`;
    current.set(key, (current.get(key) ?? 0) + 1);
  }
}

if (updateBaseline) {
  const baseline = {};
  for (const key of [...current.keys()].sort()) baseline[key] = current.get(key);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`基线已更新：${baselinePath}（${Object.keys(baseline).length} 条目）`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch {
  console.error(`基线文件不可读：${baselinePath}；先执行 pnpm lint:update-baseline 生成`);
  process.exit(1);
}

const newViolations = [];
for (const [key, count] of current) {
  const frozen = baseline[key];
  if (frozen === undefined || count > frozen) {
    newViolations.push([key, count, frozen ?? 0]);
  }
}
const cleared = Object.keys(baseline).filter((key) => !current.has(key));

if (newViolations.length > 0) {
  console.error(`lint 基线门禁：新增违规 ${newViolations.length} 处（超出 scripts/eslint-baseline.json 冻结的存量）`);
  for (const [key, count, frozen] of newViolations.slice(0, 30)) {
    console.error(`  ${key}：${frozen} → ${count}`);
  }
  if (newViolations.length > 30) console.error(`  …其余 ${newViolations.length - 30} 处略`);
  console.error('修复代码；确认存量确需放宽时执行 pnpm lint:update-baseline 并在卡里说明。');
  process.exit(1);
}

console.log(
  `lint OK：存量违规 ${[...current.values()].reduce((a, b) => a + b, 0)} 处（全部在基线内）` +
    (cleared.length > 0 ? `；基线中 ${cleared.length} 条已清零，可用 pnpm lint:update-baseline 收缩` : ''),
);
