/**
 * STATUS-3-UI：看板列由 `GET /api/workspaces/:id/statuses` 派生（按 sort_order），接口失败回落五条内置。
 * 覆盖：派生列、5 列渲染、自定义状态列出现在正确 sort_order 位置、删除状态后列消失、详情下拉含自定义状态。
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, WorkspaceStatus, WorkspaceStatusKind } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { DetailPanel } from '../components/detail/DetailPanel';
import { BUILTIN_STATUS_NAMES, statusAccent, statusNames, statusOptions } from '../lib/workspaceStatuses';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const WS = 'ws-1';

function status(name: string, kind: WorkspaceStatusKind, sortOrder: number, isBuiltin = 1): WorkspaceStatus {
  return { id: `s-${name}`, workspace_id: WS, name, kind, sort_order: sortOrder, is_builtin: isBuiltin };
}

const FIVE = [
  status('待规划', 'open', 0),
  status('进行中', 'started', 10),
  status('待验收', 'review', 20),
  status('已关闭', 'done', 30),
  status('已废弃', 'deprecated', 40),
];

function issue(id: string, title: string, statusName: string): Issue {
  return {
    id,
    workspace_id: WS,
    title,
    description: '',
    priority: '中',
    labels: [],
    status: statusName as Issue['status'],
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

function mockBoard(statuses: WorkspaceStatus[], issues: Issue[] = []) {
  let current = statuses;
  server.use(
    http.get(`/api/workspaces/${WS}/statuses`, () => HttpResponse.json(current)),
    http.get('/api/issues', () => HttpResponse.json(issues)),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/workspaces', () => HttpResponse.json([{ id: WS, name: '主项目', path: 'D:/p', created_at: 1 }])),
    http.get('/api/issues/:id', ({ params }) => {
      const hit = issues.find((candidate) => candidate.id === String(params.id));
      return hit === undefined
        ? HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 })
        : HttpResponse.json(hit);
    }),
    http.get('/api/issues/:id/comments', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/issues/:id/attachments', () => HttpResponse.json([])),
  );
  return {
    setStatuses(next: WorkspaceStatus[]) {
      current = next;
      server.use(http.get(`/api/workspaces/${WS}/statuses`, () => HttpResponse.json(current)));
    },
  };
}

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <Board />
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

function columnNames(): string[] {
  const container = screen.getByTestId('board-columns');
  return [...container.querySelectorAll('[data-testid^="column-"]:not([data-testid^="column-create-"])')].map(
    (node) => node.getAttribute('data-testid')?.replace('column-', '') ?? '',
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: WS, selectedLabelsByWorkspace: {} });
  usePanelStore.setState({ view: null, issueId: null, refPanel: null, rightOpen: false, sessionId: null, chatSession: null, unread: {} });
});

describe('列字典纯函数', () => {
  it('statusNames 按 sort_order 排序；空数组回落五条内置', () => {
    expect(statusNames([status('已关闭', 'done', 30), status('待规划', 'open', 0)])).toEqual(['待规划', '已关闭']);
    expect(statusNames([])).toEqual([...BUILTIN_STATUS_NAMES]);
    expect(BUILTIN_STATUS_NAMES).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']);
  });

  it('已废弃与已关闭的颜色不同', () => {
    expect(statusAccent('deprecated')).not.toBe(statusAccent('done'));
    // UNSLOP：不再按状态给色相，靠石墨台阶区分（琥珀只留给「待验收」）
    expect(statusAccent('deprecated')).toBe('text-ink-2');
    expect(statusAccent('done')).toBe('text-ink-3');
    // ARCH-02：blocked 与已废弃同档石墨，不占用强调色
    expect(statusAccent('blocked')).toBe('text-ink-2');
  });
});

describe('看板列派生', () => {
  it('接口返回 5 条内置 → 渲染 5 列，grid 模板跟着变成 repeat(5, …)', async () => {
    mockBoard(FIVE);
    renderBoard();

    await waitFor(() => expect(columnNames()).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']));
    const container = screen.getByTestId('board-columns');
    expect(container.style.gridTemplateColumns).toBe('repeat(5, minmax(240px, 1fr))');
    // 已废弃列头颜色区别于已关闭
    const deprecatedHeader = within(screen.getByTestId('column-已废弃')).getByRole('heading', { level: 3 });
    // UNSLOP：已废弃用更深一档石墨与已关闭区分（不再借琥珀）
    expect(deprecatedHeader.className).toContain('text-ink-2');
  });

  it('自定义状态列出现在 sort_order 指定的位置', async () => {
    mockBoard([
      status('待规划', 'open', 0),
      status('已关闭', 'done', 30),
      status('等一下', 'started', 15, 0), // 自定义，插在中间
    ]);
    renderBoard();

    await waitFor(() => expect(columnNames()).toEqual(['待规划', '等一下', '已关闭']));
    expect(screen.getByTestId('board-columns').style.gridTemplateColumns).toBe('repeat(3, minmax(240px, 1fr))');
  });

  it('接口失败 → 回落五条内置列（兜底）', async () => {
    server.use(
      http.get(`/api/workspaces/${WS}/statuses`, () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
      http.get('/api/issues', () => HttpResponse.json([])),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    renderBoard();
    await waitFor(() => expect(columnNames()).toEqual([...BUILTIN_STATUS_NAMES]));
  });

  it('删除自定义状态后 invalidate → 该列消失', async () => {
    const mock = mockBoard([...FIVE, status('等一下', 'started', 25, 0)]);
    const { qc } = renderBoard();
    await waitFor(() => expect(columnNames()).toContain('等一下'));

    // 服务端删除该状态（带迁移目标），前端 invalidate 后应重新拉取并移除该列
    mock.setStatuses(FIVE);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['workspace-statuses', WS] });
    });
    await waitFor(() => expect(columnNames()).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']));
  });

  it('自定义状态列里能渲染该状态的卡', async () => {
    mockBoard(FIVE, [issue('i1', '废弃的卡', '已废弃'), issue('i2', '普通卡', '待规划')]);
    renderBoard();
    await waitFor(() => expect(columnNames()).toContain('已废弃'));
    const deprecated = screen.getByTestId('column-已废弃');
    await waitFor(() => expect(within(deprecated).getByText('废弃的卡')).toBeInTheDocument());
    expect(within(screen.getByTestId('column-待规划')).getByText('普通卡')).toBeInTheDocument();
  });
});

describe('详情状态下拉的选项（statusOptions）', () => {
  it('含自定义状态，顺序按 sort_order', () => {
    const options = statusOptions([...FIVE, status('等一下', 'started', 25, 0)], false);
    expect(options.map((option) => option.name)).toEqual(['待规划', '进行中', '待验收', '等一下', '已关闭', '已废弃']);
    expect(options.every((option) => option.disabled === false)).toBe(true);
  });

  it('有未关闭后代时，kind=done 的项禁用（其余不禁用）', () => {
    const options = statusOptions(FIVE, true);
    const done = options.find((option) => option.name === '已关闭');
    expect(done?.disabled).toBe(true);
    expect(options.find((option) => option.name === '已废弃')?.disabled).toBe(false);
    expect(options.find((option) => option.name === '待规划')?.disabled).toBe(false);
  });

  it('kind=blocked 自定义状态不被当成关闭类（有未关闭后代时仍可选）', () => {
    const options = statusOptions([...FIVE, status('等外部确认', 'blocked', 25, 0)], true);
    expect(options.find((option) => option.name === '等外部确认')?.disabled).toBe(false);
  });

  it('兜底字典（无 kind 信息）仍按名字禁用「已关闭」', () => {
    const options = statusOptions([], true);
    expect(options.find((option) => option.name === '已关闭')?.disabled).toBe(true);
    expect(options.find((option) => option.name === '已废弃')?.disabled).toBe(false);
  });
});
