/**
 * MULTI-DRAFT（6a59ef60）：多条需求拆多卡。
 *
 * 契约：响应新增 `cards[]`（1 条需求 1 张卡），顶层 title/description/labels/warnings 镜像 cards[0]（兼容旧读取）。
 * 覆盖：分条规则（编号列表 / 分号 / 换行 / 单条不拆）、模型按条返回、条数不符时的确定性兜底、
 * 以及「不补未提需求」（兜底卡的背景/验收都是「未提供」）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DRAFT_CARDS,
  fallbackCards,
  splitRequirementItems,
} from '../src/services/smartCreateDraft.js';

describe('splitRequirementItems（确定性分条）', () => {
  it('编号列表 → 每条一卡；缩进续行并入当前条', () => {
    const items = splitRequirementItems('1. 加排序开关\n2. 支持按标题搜索\n   允许模糊匹配\n3. 导出 CSV');
    expect(items).toEqual(['加排序开关', '支持按标题搜索 允许模糊匹配', '导出 CSV']);
  });

  it('短横线/圆点列表同样按条切；星号也算', () => {
    expect(splitRequirementItems('- 甲\n- 乙')).toEqual(['甲', '乙']);
    expect(splitRequirementItems('• 甲\n* 乙')).toEqual(['甲', '乙']);
  });

  it('无列表标记但含分号 → 按分号切；只有单段时按行切', () => {
    expect(splitRequirementItems('加导出；修暗色对比度')).toEqual(['加导出', '修暗色对比度']);
    expect(splitRequirementItems('第一行\n第二行')).toEqual(['第一行', '第二行']);
  });

  it('单条需求不拆（含换行但只有一个非空行）', () => {
    expect(splitRequirementItems('  只有一个需求  ')).toEqual(['只有一个需求']);
    expect(splitRequirementItems('')).toEqual([]);
  });

  it('完全重复的条目只保留一份', () => {
    expect(splitRequirementItems('1. 甲\n2. 甲\n3. 乙')).toEqual(['甲', '乙']);
  });

  it('超过上限的条数由调用方截断（split 本身不丢）', () => {
    const many = Array.from({ length: MAX_DRAFT_CARDS + 2 }, (_, i) => `${i + 1}. 需求${i + 1}`).join('\n');
    expect(splitRequirementItems(many)).toHaveLength(MAX_DRAFT_CARDS + 2);
  });
});

describe('fallbackCards（模型没按条拆分时的确定性兜底）', () => {
  it('每条原文生成一张卡：背景/验收「未提供」，要求就是原文，且带兜底 warning', () => {
    const cards = fallbackCards(['加排序开关', '支持按标题搜索']);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.local_id).toBe('c1');
    expect(cards[0]!.title).toBe('加排序开关');
    expect(cards[0]!.description).toContain('## 要求\n加排序开关');
    expect(cards[0]!.description).toContain('## 验收\n未提供');
    expect(cards[0]!.description).toContain('## 背景\n未提供');
    expect(cards[0]!.warnings.join('')).toContain('按需求原文逐条生成');
  });

  it('超长首行截断为 60 字 + 省略号（不整段当标题）', () => {
    const long = '很长的需求标题'.repeat(20);
    const [card] = fallbackCards([long]);
    expect(card!.title.length).toBeLessThanOrEqual(61);
    expect(card!.title.endsWith('…')).toBe(true);
  });
});
