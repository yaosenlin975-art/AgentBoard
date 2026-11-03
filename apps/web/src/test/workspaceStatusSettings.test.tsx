/**
 * STATUS-3-UI 设置侧：自定义状态增删（删除必须选迁移目标、展示卡数）+ 变更后 invalidate 让看板重新拉取。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, WorkspaceStatus, WorkspaceStatusKind } from '@agentboard/shared';
import { WorkspaceStatusSettings } from '../components/settings/WorkspaceStatusSettings';
import { server } from './server';

const WS = 'ws-1';

function status(id: string, name: string, kind: WorkspaceStatusKind, order: number, isBuiltin = 1): WorkspaceStatus {
  return { id, workspace_id: WS, name, kind, sort_order: order, is_builtin: isBuiltin };
}

function issue(id: string, statusName: string): Issue {
  return {
    id,
    workspace_id: WS,
    title: `卡 ${id}`,
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

let statuses: WorkspaceStatus[];
let created: Array<Record<string, unknown>>;
let deleted: string[];
let statusCalls: number;

beforeEach(() => {
  statuses = [
    status('s-open', '待规划', 'open', 0),
    status('s-done', '已关闭', 'done', 30),
    status('s-wait', '等外部确认', 'started', 15, 0),
  ];
  created = [];
  deleted = [];
  statusCalls = 0;
  server.use(
    http.get(`/api/workspaces/${WS}/statuses`, () => {
      statusCalls += 1;
      return HttpResponse.json(statuses);
    }),
    http.get('/api/issues', () => HttpResponse.json([issue('i1', '等外部确认'), issue('i2', '等外部确认'), issue('i3', '待规划')])),
    http.post(`/api/workspaces/${WS}/statuses`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      const next = status(String(body.name), String(body.name), body.kind as WorkspaceStatusKind, 25, 0);
      statuses = [...statuses, next];
      return HttpResponse.json(next, { status: 201 });
    }),
    http.delete(`/api/workspaces/${WS}/statuses/:statusId`, ({ request, params }) => {
      const url = new URL(request.url);
      deleted.push(`${String(params.statusId)}?migrate_to=${url.searchParams.get('migrate_to')}`);
      statuses = statuses.filter((item) => item.id !== String(params.statusId));
      return HttpResponse.json({ migrated: 2 });
    }),
  );
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceStatusSettings workspaceId={WS} />
    </QueryClientProvider>,
  );
}

describe('设置里的工作区状态', () => {
  it('列出全部状态与卡数；内置不可删', async () => {
    renderSettings();
    await screen.findByTestId('status-row-等外部确认');
    expect(screen.getByTestId('status-count-等外部确认')).toHaveTextContent('2 张卡');
    expect(screen.getByTestId('status-count-待规划')).toHaveTextContent('1 张卡');
    expect(screen.queryByTestId('status-delete-待规划')).toBeNull();
    expect(screen.getByTestId('status-delete-等外部确认')).toBeInTheDocument();
  });

  it('新增自定义状态：POST 带 name/kind，成功后列表多一项（invalidate 后重新拉取）', async () => {
    renderSettings();
    await screen.findByTestId('status-row-等外部确认');

    await userEvent.type(screen.getByTestId('status-create-name'), '暂停');
    await userEvent.selectOptions(screen.getByTestId('status-create-kind'), 'deprecated');
    await userEvent.click(screen.getByTestId('status-create-submit'));

    await waitFor(() => expect(created).toEqual([{ name: '暂停', kind: 'deprecated' }]));
    await waitFor(() => expect(screen.getByTestId('status-row-暂停')).toBeInTheDocument());
    expect(await screen.findByTestId('status-settings-notice')).toHaveTextContent('已新增状态「暂停」');
    expect(statusCalls).toBeGreaterThanOrEqual(2); // 至少一次初始拉取 + 一次 invalidate 重拉
  });

  it('删除自定义状态：必须先选迁移目标，DELETE 带 migrate_to，行消失', async () => {
    renderSettings();
    await screen.findByTestId('status-row-等外部确认');

    await userEvent.click(screen.getByTestId('status-delete-等外部确认'));
    const confirm = await screen.findByTestId('status-delete-confirm');
    expect(confirm).toHaveTextContent('2 张卡');
    const yes = within(confirm).getByTestId('status-delete-confirm-yes');
    expect(yes).toBeDisabled();

    await userEvent.selectOptions(within(confirm).getByTestId('status-migrate-target'), '待规划');
    expect(yes).toBeEnabled();
    await userEvent.click(yes);

    await waitFor(() => expect(deleted).toEqual(['s-wait?migrate_to=待规划']));
    await waitFor(() => expect(screen.queryByTestId('status-row-等外部确认')).toBeNull());
  });
});
