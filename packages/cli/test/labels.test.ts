import { describe, expect, it } from 'vitest';
import { parseLabels } from '../src/commands/createIssue.js';

/** TAG-HYGIENE：标签分隔与规范化（逗号/全角逗号/空白都是分隔符，去空去重） */
describe('parseLabels', () => {
  it('空格分隔 → 多个标签（历史上会被当成一个带空格的标签）', () => {
    expect(parseLabels('调研 跨平台 文档')).toEqual(['调研', '跨平台', '文档']);
  });

  it('半角/全角逗号与空白混合', () => {
    expect(parseLabels('web,server')).toEqual(['web', 'server']);
    expect(parseLabels('调研，跨平台')).toEqual(['调研', '跨平台']);
    expect(parseLabels('web, server，cli')).toEqual(['web', 'server', 'cli']);
  });

  it('多余空白与连续分隔符被丢掉，重复标签去重', () => {
    expect(parseLabels('  测试 ,,  测试  ,文档  ')).toEqual(['测试', '文档']);
    expect(parseLabels('a\t\tb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('空串/纯分隔符 → 空数组', () => {
    expect(parseLabels('')).toEqual([]);
    expect(parseLabels(' , ，  ')).toEqual([]);
  });

  it('含空格的多词短语会被拆开（标签不含空格是硬约定）', () => {
    expect(parseLabels('功能 web UI 用户需求2026-11-03')).toEqual(['功能', 'web', 'UI', '用户需求2026-11-03']);
  });
});
