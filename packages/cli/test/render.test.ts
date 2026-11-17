/** KB-CLI-3b：表格 CJK 宽度对齐（CLI-09）与统一时间格式（CLI-11）的纯渲染单测。 */
import { describe, expect, it } from 'vitest';
import { displayWidth, formatDateTime, table } from '../src/render.js';

describe('render（KB-CLI-3b）', () => {
  it('table：CJK 记 2，36 位 id 与中文混排后各行列起始一致', () => {
    const out = table(
      ['id', '标题'],
      [
        ['12345678-1234-1234-1234-123456789012', '中文标题很长的一行'],
        ['deadbee', 'ab'],
      ],
    );
    const lines = out.trimEnd().split('\n');
    // 第二列起点（第一列值 + 补位 + 分隔空格）的显示宽度每行一致 → 对齐
    const secondColStarts = lines.map((line) => {
      const m = /\S( {2,})/.exec(line)!;
      return displayWidth(line.slice(0, m.index + 1 + m[1].length));
    });
    expect(new Set(secondColStarts).size).toBe(1);
  });

  it('displayWidth：ASCII 记 1、CJK/全角记 2', () => {
    expect(displayWidth('ab12')).toBe(4);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('，。')).toBe(4);
    expect(displayWidth('a中b文')).toBe(6);
  });

  // P3：--title-stdin 允许换行/控制字符进标题，表格不能被切成多行
  it('table：含换行/制表/控制字符的单元格折叠成单行，行数与列宽不受影响', () => {
    const out = table(
      ['id', '标题'],
      [
        ['deadbee1', '第一行\n第二行'],
        ['deadbee2', '带\t制表\u0007与\r回车'],
        ['deadbee3', '正常标题'],
      ],
    );
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(4); // 表头 + 3 行，没有被换行切坏
    expect(lines[1]).toContain('第一行 第二行');
    expect(lines[1]).not.toContain('\n');
    expect(lines[2]).toContain('带 制表 与 回车');
    // 各行列起点仍然一致
    const secondColStarts = lines.map((line) => {
      const m = /\S( {2,})/.exec(line)!;
      return displayWidth(line.slice(0, m.index + 1 + m[1].length));
    });
    expect(new Set(secondColStarts).size).toBe(1);
  });

  it('formatDateTime：YYYY-MM-DD HH:mm:ss（本地时区）', () => {
    expect(formatDateTime(new Date(2026, 10, 6, 1, 2, 3).getTime())).toBe('2026-11-06 01:02:03');
  });
});
