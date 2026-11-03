/**
 * STATUS-1 联动：`groupByColumn` 必须容忍「第 5 个及以后的状态」。
 *
 * 背景（BOARD-COLS 线实测）：`apps/web/src/lib/dnd.ts` 原先把分组键写死成四个内置状态，
 * STATUS-1 让数据层可写入 `已废弃`（以及后续自定义状态）之后，一张这样的卡会让
 * `grouped[issue.status].push(...)` 直接抛 TypeError。这里锁两种情况：
 *   1. 现有 4 列下出现未知状态卡 → 不抛错、数据不丢、渲染列仍只有 BOARD_COLUMNS；
 *   2. BOARD_COLUMNS 变成 5 项（后续卡把它打开时）→ 分组自动多出该键，不再 undefined。
 */
import { describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import { BOARD_COLUMNS, groupByColumn } from '../lib/dnd';

const issue = (id: string, status: string, sort_order = 0): Issue => ({
  id,
  workspace_id: 'ws-1',
  title: id,
  description: '',
  priority: '中',
  labels: [],
  status: status as Issue['status'],
  sort_order,
  parent_issue_id: null,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  comment_count: 0,
  created_at: 1,
  updated_at: 1,
});

describe('groupByColumn（状态键不再写死四个）', () => {
  it('把未知状态（已废弃）的卡分到独立桶里，不抛错、不丢数据', () => {
    const grouped = groupByColumn([
      issue('a', '待规划', 2),
      issue('b', '待规划', 1),
      issue('c', '已废弃', 0),
    ]) as unknown as Record<string, Issue[]>;

    expect(grouped['待规划']!.map(item => item.id)).toEqual(['b', 'a']); // 组内按 sort_order
    expect(grouped['已废弃']!.map(item => item.id)).toEqual(['c']);
    // 未知状态只进桶，不改变渲染列
    expect(BOARD_COLUMNS).not.toContain('已废弃');
    expect(Object.keys(grouped).filter(key => BOARD_COLUMNS.includes(key as never))).toEqual([...BOARD_COLUMNS]);
  });

  it('BOARD_COLUMNS 扩到 5 项时分组自动多出该键（n=5 复现用例）', () => {
    const original = [...BOARD_COLUMNS];
    try {
      (BOARD_COLUMNS as string[]).push('已废弃');
      const grouped = groupByColumn([issue('c', '已废弃')]) as unknown as Record<string, Issue[]>;
      expect(Object.keys(grouped)).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']);
      expect(grouped['已废弃']!.map(item => item.id)).toEqual(['c']);
    } finally {
      BOARD_COLUMNS.splice(0, BOARD_COLUMNS.length, ...original);
    }
  });

  it('空列表也为每一列返回数组（渲染时读 .length 不会 undefined）', () => {
    const grouped = groupByColumn([]) as unknown as Record<string, Issue[]>;
    for (const status of BOARD_COLUMNS) expect(Array.isArray(grouped[status])).toBe(true);
  });
});
