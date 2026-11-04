/** BORROW-1.1 纯逻辑：两段式选择与显示偏好解析/分组。 */
import { describe, expect, it } from 'vitest';
import type { Issue } from '@agentboard/shared';
import {
  idsInScope,
  issueInScope,
  pruneSelection,
  toggleSelectAll,
  toggleSelected,
  type SelectionScope,
} from '../lib/selection';
import {
  DEFAULT_DISPLAY_OPTIONS,
  groupIssuesForDisplay,
  parseDisplayOptions,
  readDisplayOptions,
  writeDisplayOptions,
} from '../lib/displayOptions';

function issue(id: string, status = '待规划', labels: string[] = []): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: id,
    description: '',
    priority: '中',
    labels,
    status: status as Issue['status'],
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
  };
}

const items = [issue('a'), issue('b'), issue('c', '已关闭'), issue('d', '进行中')];

describe('两段式选择', () => {
  it('未选范围时任何卡都不在选择域；范围只作用于对应列', () => {
    const boardScope: SelectionScope = { kind: 'board' };
    const columnScope: SelectionScope = { kind: 'column', status: '待规划' };
    expect(issueInScope(null, items[0]!)).toBe(false);
    expect(issueInScope(boardScope, items[0]!)).toBe(true);
    expect(issueInScope(columnScope, items[0]!)).toBe(true);
    expect(issueInScope(columnScope, items[2]!)).toBe(false);
    expect(idsInScope(items, columnScope)).toEqual(['a', 'b']);
    expect(idsInScope(items, null)).toEqual([]);
  });

  it('勾选只接受范围内 id；范围外 id 不进入集合', () => {
    const empty: ReadonlySet<string> = new Set();
    expect([...toggleSelected(empty, 'a', true)]).toEqual(['a']);
    expect([...toggleSelected(empty, 'c', false)]).toEqual([]);
    expect([...toggleSelected(new Set(['a']), 'a', true)]).toEqual([]);
  });

  it('全选作用于范围；已全选时再点清空', () => {
    expect([...toggleSelectAll(new Set(), ['a', 'b'])]).toEqual(['a', 'b']);
    expect([...toggleSelectAll(new Set(['a', 'b']), ['a', 'b'])]).toEqual([]);
    expect([...toggleSelectAll(new Set(['a']), ['a', 'b'])]).toEqual(['a', 'b']);
  });

  it('数据刷新后剪掉已不存在的选择', () => {
    expect([...pruneSelection(new Set(['a', 'gone']), items)]).toEqual(['a']);
  });
});

describe('显示偏好', () => {
  it('解析非法/缺省值回落安全默认', () => {
    expect(parseDisplayOptions(null)).toEqual(DEFAULT_DISPLAY_OPTIONS);
    expect(parseDisplayOptions('not-json')).toEqual(DEFAULT_DISPLAY_OPTIONS);
    expect(parseDisplayOptions('{"density":"huge","grouping":"x"}')).toEqual(DEFAULT_DISPLAY_OPTIONS);
    expect(parseDisplayOptions('{"density":"compact","grouping":"label"}')).toEqual({ density: 'compact', grouping: 'label' });
  });

  it('read/write 走同一 storage key，刷新后保持', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(readDisplayOptions(storage)).toEqual(DEFAULT_DISPLAY_OPTIONS);
    writeDisplayOptions({ density: 'compact', grouping: 'label' }, storage);
    expect(readDisplayOptions(storage)).toEqual({ density: 'compact', grouping: 'label' });
  });

  it('分组按首个标签，无标签归未分类，组内保持原顺序', () => {
    expect(groupIssuesForDisplay([issue('a', '待规划', ['前端']), issue('b', '待规划', ['后端']), issue('c', '待规划', ['前端']), issue('d')], 'none')).toBeNull();
    const groups = groupIssuesForDisplay(
      [issue('a', '待规划', ['前端']), issue('b', '待规划', ['后端']), issue('c', '待规划', ['前端']), issue('d')],
      'label',
    )!;
    expect(groups.map((group) => [group.label, group.issues.map((item) => item.id)]))
      .toEqual([['前端', ['a', 'c']], ['后端', ['b']], ['未分类', ['d']]]);
  });
});
