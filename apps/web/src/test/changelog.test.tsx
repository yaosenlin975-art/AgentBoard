import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { ChangelogPanel } from '../components/changelog/ChangelogPanel';
import { server } from './server';

/** LOG03：变更日志面板（时间轴 / 筛选分页 / CRUD / CAS 冲突 / 归档只读 / 切 workspace）。 */

const DAY = 24 * 60 * 60 * 1000;
const BASE_TS = Date.parse('2026-11-02T10:00:00.000Z');

function entry(overrides: Partial<WorkspaceChangeLog> = {}): WorkspaceChangeLog {
  return {
    id: 'log-1',
    workspace_id: 'ws-1',
    origin_workspace_id: 'ws-1',
    origin_workspace_name: '项目',
    origin_workspace_path: 'D:/project',
    title: '默认标题',
    body_md: '默认正文',
    change_type: '新增',
    occurred_at: BASE_TS,
    created_by: 'user',
    updated_by: 'user',
    created_at: BASE_TS,
    updated_at: BASE_TS,
    revision: 1,
    legacy_source_key: null,
    ...overrides,
  };
}

interface ListCall { workspaceId: string; changeType: string | null; q: string | null; offset: string | null; limit: string | null }

let listCalls: ListCall[];
let createCalls: Array<Record<string, unknown>>;
let patchCalls: Array<{ id: string; body: Record<string, unknown> }>;
let deleteCalls: Array<{ id: string; body: Record<string, unknown> }>;

function captureList(request: Request): ListCall {
  const url = new URL(request.url);
  const call: ListCall = {
    workspaceId: url.pathname.split('/')[3] ?? '',
    changeType: url.searchParams.get('change_type'),
    q: url.searchParams.get('q'),
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit'),
  };
  listCalls.push(call);
  return call;
}

function renderPanel(workspaceId = 'ws-1', onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChangelogPanel workspaceId={workspaceId} onClose={onClose} />
    </QueryClientProvider>,
  );
  const rerenderWith = (nextWorkspaceId: string) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ChangelogPanel workspaceId={nextWorkspaceId} onClose={onClose} />
      </QueryClientProvider>,
    );
  return { ...view, onClose, rerenderWith };
}

function mockActiveList(items: WorkspaceChangeLog[], nextOffset: number | null = null) {
  listCalls = [];
  server.use(
    http.get('/api/workspaces/:workspaceId/changelog', ({ request }) => {
      captureList(request);
      return HttpResponse.json({ items, next_offset: nextOffset });
    }),
  );
}

beforeEach(() => {
  listCalls = [];
  createCalls = [];
  patchCalls = [];
  deleteCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('变更日志面板', () => {
  it('左列表：按 occurred_at DESC,id DESC 排序并本地日期分组；右侧连续滚动区渲染全部 Markdown 正文', async () => {
    const older = entry({ id: 'log-old', title: '较早一条', occurred_at: BASE_TS - DAY, body_md: '## 小标题\n\n- 列表项' });
    const sameDayFirst = entry({ id: 'log-b', title: '同日 B', occurred_at: BASE_TS });
    const sameDaySecond = entry({ id: 'log-a', title: '同日 A', occurred_at: BASE_TS });
    mockActiveList([older, sameDaySecond, sameDayFirst]);

    renderPanel();

    const list = await screen.findByTestId('changelog-list');
    const ids = within(list).getAllByRole('button').map((node) => node.getAttribute('data-testid'));
    expect(ids).toEqual(['changelog-entry-log-b', 'changelog-entry-log-a', 'changelog-entry-log-old']);
    // 两个日期分组
    expect(list.querySelectorAll('[data-testid^="changelog-day-"]')).toHaveLength(2);

    // LOG-SCROLL：右侧是连续滚动区，三条日志按同样顺序全部渲染
    const scroll = await screen.findByTestId('changelog-scroll');
    const docIds = [...scroll.querySelectorAll('[data-changelog-id]')].map((n) => n.getAttribute('data-changelog-id'));
    expect(docIds).toEqual(['log-b', 'log-a', 'log-old']);
    // 默认选中最新一条
    expect(screen.getByTestId('changelog-doc-log-b')).toHaveAttribute('aria-current', 'true');

    // 正文全部展开（无需点击展开）：MarkdownView 懒加载，等真实标题元素
    const body = screen.getByTestId('changelog-doc-body-log-old');
    expect(await within(body).findByRole('heading', { level: 2 }, { timeout: 5000 })).toHaveTextContent('小标题');
    expect(within(body).getByRole('listitem')).toHaveTextContent('列表项');
  });

  it('搜索与类型筛选进入请求参数；清除筛选恢复全量', async () => {
    mockActiveList([entry()]);
    renderPanel();
    await screen.findByTestId('changelog-entry-log-1');
    expect(listCalls.at(-1)).toMatchObject({ workspaceId: 'ws-1', changeType: null, q: null, offset: '0' });

    await userEvent.type(screen.getByLabelText('搜索变更日志'), '缓存');
    await userEvent.selectOptions(screen.getByLabelText('变更日志类型'), '修复');
    await userEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ changeType: '修复', q: '缓存', offset: '0' }));

    await userEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ changeType: null, q: null }));
  });

  it('分页：next_offset 驱动 offset，上一页禁用态', async () => {
    mockActiveList([entry()], 20);
    renderPanel();
    await screen.findByTestId('changelog-entry-log-1');

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listCalls.at(-1)?.offset).toBe('20'));
  });

  it('新增：POST 带 actor=user/类型/毫秒时间，成功后刷新列表', async () => {
    mockActiveList([]);
    server.use(
      http.post('/api/workspaces/:workspaceId/changelog', async ({ request }) => {
        createCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(entry({ id: 'log-new', title: '新日志' }));
      }),
    );
    renderPanel();
    await screen.findByTestId('changelog-empty');

    await userEvent.click(screen.getByTestId('changelog-create'));
    await userEvent.type(screen.getByLabelText('日志标题'), '新日志');
    await userEvent.selectOptions(screen.getByLabelText('日志类型'), '修复');
    fireEvent.change(screen.getByLabelText('日志正文'), { target: { value: '正文内容' } });
    await userEvent.click(screen.getByTestId('changelog-form-submit'));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({ title: '新日志', body_md: '正文内容', change_type: '修复', actor: 'user' });
    expect(typeof createCalls[0]!.occurred_at).toBe('number');
    await waitFor(() => expect(screen.queryByTestId('changelog-form')).toBeNull());
  });

  it('编辑：PATCH 带 expected_revision；CAS 冲突保留输入并显示当前 revision', async () => {
    mockActiveList([entry({ id: 'log-1', revision: 2, title: '原标题' })]);
    server.use(
      http.patch('/api/workspaces/:workspaceId/changelog/:id', async ({ request, params }) => {
        patchCalls.push({ id: String(params.id), body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ error: { code: 'CHANGELOG_REVISION_CONFLICT', message: '变更日志已更新，请重新读取' } }, { status: 409 });
      }),
      http.get('/api/workspaces/:workspaceId/changelog/:id', () => HttpResponse.json(entry({ id: 'log-1', revision: 7, title: '别人改过' }))),
    );
    renderPanel();
    await screen.findByTestId('changelog-entry-log-1');

    await userEvent.click(screen.getByRole('button', { name: '编辑日志：原标题' }));
    const titleInput = screen.getByLabelText('日志标题');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, '我的修改');
    await userEvent.click(screen.getByTestId('changelog-form-submit'));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]).toMatchObject({ id: 'log-1' });
    expect(patchCalls[0]!.body).toMatchObject({ expected_revision: 2, actor: 'user', title: '我的修改' });

    const conflict = await screen.findByTestId('changelog-conflict');
    expect(conflict).toHaveTextContent('变更日志已更新，请重新读取');
    expect(conflict).toHaveTextContent('当前 revision：7');
    expect(screen.getByLabelText('日志标题')).toHaveValue('我的修改');

    await userEvent.click(screen.getByRole('button', { name: '载入最新' }));
    await waitFor(() => expect(screen.getByLabelText('日志标题')).toHaveValue('别人改过'));
  });

  it('删除：确认框显示标题与 revision，DELETE 带 CAS，成功后调用 onClose', async () => {
    mockActiveList([entry({ id: 'log-1', title: '待删日志', revision: 3 })]);
    server.use(
      http.delete('/api/workspaces/:workspaceId/changelog/:id', async ({ request, params }) => {
        deleteCalls.push({ id: String(params.id), body: (await request.json()) as Record<string, unknown> });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const onClose = vi.fn();
    renderPanel('ws-1', onClose);
    await screen.findByTestId('changelog-entry-log-1');

    await userEvent.click(screen.getByRole('button', { name: '删除日志：待删日志' }));
    const confirm = await screen.findByTestId('changelog-delete-confirm');
    expect(confirm).toHaveTextContent('待删日志');
    expect(confirm).toHaveTextContent('当前 revision 3');

    await userEvent.click(screen.getByTestId('changelog-delete-confirm-yes'));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(deleteCalls[0]!.body).toMatchObject({ expected_revision: 3, actor: 'user' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('归档只读：归档列表无写入口，选中后时间轴无编辑/删除按钮，且不混入活动列表', async () => {
    mockActiveList([entry({ id: 'log-active', title: '活动日志' })]);
    server.use(
      http.get('/api/changelog/archived-workspaces', () =>
        HttpResponse.json({
          items: [
            { origin_workspace_id: 'ws-old', origin_workspace_name: '旧项目', origin_workspace_path: 'D:/old', entry_count: 2, last_occurred_at: BASE_TS },
          ],
          next_offset: null,
        }),
      ),
      http.get('/api/changelog/archived-workspaces/:origin/entries', ({ params }) =>
        HttpResponse.json({
          items: [entry({ id: 'arch-1', workspace_id: null, origin_workspace_id: String(params.origin), title: '归档日志', change_type: '历史' })],
          next_offset: null,
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('changelog-entry-log-active');

    await userEvent.click(screen.getByTestId('changelog-tab-archived'));
    await screen.findByTestId('changelog-archived-workspace-ws-old');
    // 归档区没有新增入口，活动中也不显示归档条目
    expect(screen.queryByTestId('changelog-create')).toBeNull();
    expect(screen.queryByTestId('changelog-entry-log-active')).toBeNull();

    await userEvent.click(screen.getByTestId('changelog-archived-workspace-ws-old'));
    await screen.findByTestId('changelog-entry-arch-1');
    expect(screen.queryByRole('button', { name: /编辑日志：归档日志/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除日志：归档日志/ })).toBeNull();
    expect(screen.getByTestId('changelog-archived-entries')).toHaveTextContent('只读');
  });

  it('切换 workspace：请求带新 id，编辑草稿与筛选复位，不显示旧 workspace 数据', async () => {
    const listByWorkspace: Record<string, WorkspaceChangeLog[]> = {
      'ws-1': [entry({ id: 'log-ws1', title: 'WS1 日志' })],
      'ws-2': [entry({ id: 'log-ws2', workspace_id: 'ws-2', origin_workspace_id: 'ws-2', title: 'WS2 日志' })],
    };
    listCalls = [];
    server.use(
      http.get('/api/workspaces/:workspaceId/changelog', ({ request, params }) => {
        captureList(request);
        return HttpResponse.json({ items: listByWorkspace[String(params.workspaceId)] ?? [], next_offset: null });
      }),
    );
    const { rerenderWith } = renderPanel('ws-1');
    await screen.findByTestId('changelog-entry-log-ws1');

    await userEvent.type(screen.getByLabelText('搜索变更日志'), '旧筛选');
    await userEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(listCalls.at(-1)?.q).toBe('旧筛选'));

    rerenderWith('ws-2');
    await screen.findByTestId('changelog-entry-log-ws2');
    expect(screen.queryByTestId('changelog-entry-log-ws1')).toBeNull();
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ workspaceId: 'ws-2', q: null, offset: '0' }));
    expect(screen.getByLabelText('搜索变更日志')).toHaveValue('');
  });
});


