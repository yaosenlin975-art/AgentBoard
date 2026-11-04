/**
 * KB-DIFF-W：`lib/textDiff.ts` 单测。
 * 覆盖纯新增 / 纯删除 / 交错 / 全等 / 空文件 / 大正文降级 / 3 行上下文与折叠计数。
 */
import { describe, expect, it } from 'vitest';
import { DIFF_CONTEXT, DIFF_LARGE_CHARS, diffLines } from '../lib/textDiff';

const texts = (result: ReturnType<typeof diffLines>): string[] =>
  result.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`));

describe('diffLines（行级 LCS）', () => {
  it('全等：无 +/-（hunks 为空，UI 显示「无差异」），same 计数等于行数', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.same).toBe(3);
    expect(result.hunks).toEqual([]);
  });

  it('纯新增：只有 + 行，且带上下文', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const after = ['l1', 'l2', 'l3', 'NEW', 'l4', 'l5'].join('\n');
    const result = diffLines(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(texts(result)).toEqual([' l1', ' l2', ' l3', '+NEW', ' l4', ' l5']);
  });

  it('纯删除：只有 - 行', () => {
    const before = ['a', 'b', 'c'].join('\n');
    const after = ['a', 'c'].join('\n');
    const result = diffLines(before, after);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(texts(result)).toContain('-b');
  });

  it('交错改动：同一块内既有 - 也有 +', () => {
    const before = ['a', 'b', 'c', 'd'].join('\n');
    const after = ['a', 'B', 'c', 'd'].join('\n');
    const result = diffLines(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(texts(result)).toEqual(expect.arrayContaining(['-b', '+B']));
  });

  it('空文件：空 → 内容全是 +；内容 → 空全是 -', () => {
    expect(diffLines('', 'x\ny').added).toBeGreaterThan(0);
    expect(diffLines('', 'x\ny').removed).toBe(0);
    const emptied = diffLines('x\ny', '');
    expect(emptied.removed).toBeGreaterThan(0);
    expect(emptied.added).toBe(0);
  });

  it('3 行上下文 + 远处变更折叠（skippedBefore 记录省略行数）', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const after = [...before];
    after[20] = 'CHANGED';
    const result = diffLines(before.join('\n'), after.join('\n'), { context: DIFF_CONTEXT });
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0]!;
    // 块内 = 变更前 3 行 + 变更 + 变更后 3 行
    expect(hunk.lines).toHaveLength(DIFF_CONTEXT * 2 + 2);
    expect(hunk.skippedBefore).toBe(17); // 20 - 3
    expect(hunk.lines[0]!.text).toBe('line-17');
    expect(texts(result)).toContain('-line-20');
    expect(texts(result)).toContain('+CHANGED');
  });

  it('两处相隔很远的变更 → 两个块，第二块 skippedBefore > 0', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const after = [...before];
    after[3] = 'A';
    after[50] = 'B';
    const result = diffLines(before.join('\n'), after.join('\n'));
    expect(result.hunks.length).toBe(2);
    expect(result.hunks[1]!.skippedBefore).toBeGreaterThan(0);
  });

  it('大正文（> 20 万字符）默认降级：truncated=true，且给出两侧行数与统计', () => {
    const bigBefore = Array.from({ length: 4000 }, (_, i) => `line-${i}-${'x'.repeat(60)}`).join('\n');
    const bigAfter = bigBefore.replace('line-2000', 'line-CHANGED');
    expect(bigBefore.length).toBeGreaterThan(DIFF_LARGE_CHARS);
    const result = diffLines(bigBefore, bigAfter);
    expect(result.truncated).toBe(true);
    expect(result.oldLines).toBe(4000);
    expect(result.newLines).toBe(4000);
    expect(result.added + result.removed).toBeGreaterThan(0);
    // 降级时只给首尾样本，不逐行渲染
    const rendered = result.hunks.flatMap((hunk) => hunk.lines);
    expect(rendered.length).toBeLessThanOrEqual(DIFF_CONTEXT * 4);
    // 显式 force 时仍可逐行比对
    const forced = diffLines(bigBefore, bigAfter, { force: true });
    expect(forced.truncated).toBe(false);
    expect(forced.added + forced.removed).toBe(2);
  });
});
