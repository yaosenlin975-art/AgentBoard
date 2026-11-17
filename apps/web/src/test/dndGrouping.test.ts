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
import { BOARD_COLUMNS, columnDroppableId, groupByColumn, resolveDrop } from '../lib/dnd';
import { groupIssuesForDisplay } from '../lib/displayOptions';

const issue = (id: string, status: string, sort_order = 0, overrides: Partial<Issue> = {}): Issue => ({
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
  ...overrides,
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

/**
 * DRAG-FIX：分组模式（按标签分组）开放拖拽。
 * 渲染层每组独立 SortableContext（Column.tsx），结算仍走 resolveDrop 统一语义
 * （sort_order 插值 + 跨列带 status，不加跨组特判）。
 */
describe('分组模式拖拽放行（DRAG-FIX）', () => {
  /** 前端组：a(0) b(1000) [待规划] x(0) [待验收] z(0, 占用)[进行中]；未分类组：c(2000)[待规划] */
  const groupedIssues: Issue[] = [
    issue('a', '待规划', 0, { labels: ['前端'] }),
    issue('b', '待规划', 1000, { labels: ['前端'] }),
    issue('c', '待规划', 2000),
    issue('x', '待验收', 0, { labels: ['前端'] }),
    issue('z', '进行中', 0, { labels: ['前端'], claimed_by: 'agent:codex', claimed_at: 1 }),
  ];

  it('groupIssuesForDisplay：组按首遇顺序，组内保持列内 sort_order 子序列', () => {
    const groups = groupIssuesForDisplay(groupedIssues, 'label');
    expect(groups!.map((group) => group.key)).toEqual(['前端', '未分类']);
    expect(groups![0]!.issues.map((i) => i.id)).toEqual(['a', 'b', 'x', 'z']);
    expect(groups![1]!.issues.map((i) => i.id)).toEqual(['c']);
  });

  it('组内重排生效：同组两卡之间拖拽返回 sort_order 插值 patch（跨组同列同理）', () => {
    // b 拖到 a 之前：取边界 -1000
    expect(resolveDrop(groupedIssues, 'b', 'a')).toEqual({ id: 'b', patch: { sort_order: -1000 } });
    // a 拖到 b 之后（b 与 c 之间）：取中值 1500
    expect(resolveDrop(groupedIssues, 'a', 'b')).toEqual({ id: 'a', patch: { sort_order: 1500 } });
  });

  it('跨列拖拽改状态生效：拖到待验收列容器返回带 status 的 patch', () => {
    expect(resolveDrop(groupedIssues, 'a', columnDroppableId('待验收'))).toEqual({
      id: 'a',
      patch: { status: '待验收', sort_order: 1000 },
    });
  });

  it('占用卡仍冻结：claimed_by 非空 → null（分组不豁免）', () => {
    expect(resolveDrop(groupedIssues, 'z', 'a')).toBeNull();
    expect(resolveDrop(groupedIssues, 'z', columnDroppableId('待规划'))).toBeNull();
  });
});
