/**
 * KB-DIFF-W：行级 unified diff（自实现，无依赖）。
 *
 * 语义：
 * - 行级 LCS；变更块上下各保留 `context`（默认 3）行上下文；
 * - 相邻块之间未变的行折叠成一段，交给 UI 显示「… 共 N 行未变 …」；
 * - 大正文保护：任一侧字符数 > `maxChars`（默认 20 万）且未显式要求全文时，**不跑 LCS**，
 *   退回「按行比对的统计 + 变更区首尾样本」（O(n)），避免主线程被 O(n·m) 卡死。
 *
 * 纯函数、不触 DOM，便于单测。
 */

export type DiffLineKind = 'add' | 'del' | 'same';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  /** 与上一块之间被省略的未变行数（首块为开头省略的行数） */
  skippedBefore: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  same: number;
  /** 是否走了大正文降级（未逐行比对） */
  truncated: boolean;
  /** 降级时给出的两侧总行数，便于 UI 展示「全文 N 行 → 降级后 M 行」 */
  oldLines: number;
  newLines: number;
}

export const DIFF_CONTEXT = 3;
/** 单侧字符数超过此值时默认不逐行 diff（20 万） */
export const DIFF_LARGE_CHARS = 200_000;
/** LCS DP 的格子上限：中段乘积超过它就不做 LCS（防内存/耗时爆炸） */
const MAX_DP_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  // 末尾换行不额外产生一条空行差异
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

/** 大正文降级：不跑 LCS，只按行集合/位置做便宜统计与首尾样本 */
function summarize(oldLines: string[], newLines: string[], context: number): DiffResult {
  const oldCount = countByLine(oldLines);
  const newCount = countByLine(newLines);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newCount) {
    const before = oldCount.get(line) ?? 0;
    if (count > before) added += count - before;
  }
  for (const [line, count] of oldCount) {
    const after = newCount.get(line) ?? 0;
    if (count > after) removed += count - after;
  }
  const same = Math.min(oldLines.length, newLines.length) - removed > 0
    ? Math.max(0, Math.min(oldLines.length, newLines.length) - removed)
    : 0;

  const head = [
    ...oldLines.slice(0, context).map((text) => ({ kind: 'del' as const, text })),
    ...newLines.slice(0, context).map((text) => ({ kind: 'add' as const, text })),
  ];
  const tail = [
    ...oldLines.slice(-context).map((text) => ({ kind: 'del' as const, text })),
    ...newLines.slice(-context).map((text) => ({ kind: 'add' as const, text })),
  ];
  return {
    hunks: [
      { skippedBefore: 0, lines: head },
      { skippedBefore: Math.max(0, oldLines.length - context), lines: tail },
    ],
    added,
    removed,
    same,
    truncated: true,
    oldLines: oldLines.length,
    newLines: newLines.length,
  };
}

function countByLine(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** 截掉公共前缀/后缀，返回中段（减少 DP 规模） */
function trimCommon(oldLines: string[], newLines: string[]): { prefix: number; oldMid: string[]; newMid: string[]; suffix: number } {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    prefix,
    oldMid: oldLines.slice(prefix, oldLines.length - suffix),
    newMid: newLines.slice(prefix, newLines.length - suffix),
    suffix,
  };
}

/** 中段 LCS → 操作序列（same/del/add） */
function lcsOps(oldMid: string[], newMid: string[]): DiffLine[] {
  const n = oldMid.length;
  const m = newMid.length;
  if (n === 0) return newMid.map((text) => ({ kind: 'add' as const, text }));
  if (m === 0) return oldMid.map((text) => ({ kind: 'del' as const, text }));
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldMid[i] === newMid[j]
        ? dp[(i + 1) * width + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      ops.push({ kind: 'same', text: oldMid[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      ops.push({ kind: 'del', text: oldMid[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: newMid[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: oldMid[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: newMid[j]! });
    j += 1;
  }
  return ops;
}

/**
 * 行级 unified diff。
 * @param before 旧版 Markdown 原文
 * @param after 新版 Markdown 原文
 */
export function diffLines(
  before: string,
  after: string,
  options: { context?: number; maxChars?: number; force?: boolean } = {},
): DiffResult {
  const context = options.context ?? DIFF_CONTEXT;
  const maxChars = options.maxChars ?? DIFF_LARGE_CHARS;
  const force = options.force === true;
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  if (!force && (before.length > maxChars || after.length > maxChars)) {
    return summarize(oldLines, newLines, context);
  }

  const { prefix, oldMid, newMid, suffix } = trimCommon(oldLines, newLines);
  if (oldMid.length * newMid.length > MAX_DP_CELLS && !force) {
    return summarize(oldLines, newLines, context);
  }
  const ops = [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })),
    ...lcsOps(oldMid, newMid),
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: 'same' as const, text })),
  ];

  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'del').length;
  const same = ops.length - added - removed;

  // 按 context 分组：只有「±context 行内」出现变更的 same 才保留，其余折叠
  const hunks: DiffHunk[] = [];
  let index = 0;
  let skipped = 0;
  while (index < ops.length) {
    // 找下一处变更
    let next = index;
    while (next < ops.length && ops[next]!.kind === 'same') next += 1;
    if (next >= ops.length) break; // 尾部只剩 same：折叠到最后一块的下次
    const start = Math.max(index, next - context);
    skipped += start - index;
    const hunkLines: DiffLine[] = ops.slice(start, Math.min(ops.length, next + context + 1)).filter(() => true);
    // 从 start 开始连续取到变更之后 context 行（保证块内上下文完整）
    let end = next + 1;
    let after = 0;
    while (end < ops.length && after < context) {
      if (ops[end]!.kind === 'same') after += 1;
      end += 1;
    }
    // 合并同一块中的后续变更（相邻变更之间 same ≤ 2*context 时不切块）
    while (end < ops.length) {
      let probe = end;
      let gap = 0;
      while (probe < ops.length && ops[probe]!.kind === 'same') {
        probe += 1;
        gap += 1;
      }
      if (probe >= ops.length || gap > context * 2) break;
      let tail = probe + 1;
      let tailSame = 0;
      while (tail < ops.length && tailSame < context) {
        if (ops[tail]!.kind === 'same') tailSame += 1;
        tail += 1;
      }
      end = tail;
    }
    hunks.push({ skippedBefore: skipped, lines: ops.slice(start, end) });
    skipped = 0;
    index = end;
  }

  return { hunks, added, removed, same, truncated: false, oldLines: oldLines.length, newLines: newLines.length };
}
