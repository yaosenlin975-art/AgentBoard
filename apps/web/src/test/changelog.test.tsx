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
  // LOG-SCROLL：右侧连续渲染全部条目后，MarkdownView 的懒加载门控依赖 IntersectionObserver；
  // jsdom 没有该 API，这里给一个「观察即视为可见」的桩，否则 Markdown 永远停在水合 fallback。
  class ImmediateIntersectionObserver {
    private callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(element: Element): void {
      // 日志条目本身由选中逻辑观察（不自动触发，避免抢默认选中）；其它观察者（Markdown 懒加载门控）立即视为可见
      if (element.hasAttribute('data-changelog-id')) return;
      setTimeout(() => {
        this.callback(
          [{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }, 0);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', {
    value: ImmediateIntersectionObserver,
    writable: true,
    configurable: true,
  });
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

    // 正文全部直接渲染（不折叠）。真实 Markdown 结构（h2/li）由 changelogView.test.tsx 的独立用例覆盖，
    // 这里只断言文本已进入正文容器，避免与懒加载门控耦合。
    const body = screen.getByTestId('changelog-doc-body-log-old');
    expect(body).toHaveTextContent('小标题');
    expect(body).toHaveTextContent('列表项');
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

  it('无限滚动：首屏 20 条，距底 240px 内预取下一页 40 条，按 id 去重并显示到底提示', async () => {
    const first = entry({ id: 'log-1', title: '第一条' });
    const second = entry({ id: 'log-2', title: '第二条', occurred_at: BASE_TS - DAY });
    listCalls = [];
    server.use(
      http.get('/api/workspaces/:workspaceId/changelog', ({ request }) => {
        const call = captureList(request);
        // 第二页故意重复返回 log-1，验证客户端按 id 去重（并发新增会让 offset 位移）
        if (call.offset === '0') return HttpResponse.json({ items: [first], next_offset: 20 });
        return HttpResponse.json({ items: [first, second], next_offset: null });
      }),
    );
    renderPanel();

    const listEl = await screen.findByTestId('changelog-list');
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ offset: '0', limit: '20' }));
    expect(screen.getByTestId('changelog-list-status')).toHaveTextContent('继续向下滚动加载更多');

    Object.defineProperty(listEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(listEl, 'scrollTop', { value: 500, writable: true, configurable: true });
    fireEvent.scroll(listEl);

    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ offset: '20', limit: '40' }));
    await waitFor(() => expect(screen.getByTestId('changelog-list-status')).toHaveTextContent('已到底 · 共 2 条'));
    expect(screen.getAllByTestId('changelog-entry-log-1')).toHaveLength(1);
    expect(screen.getByTestId('changelog-entry-log-2')).toBeInTheDocument();
  });

  it('无限滚动：下一页失败显示可重试错误，重试后继续加载', async () => {
    const first = entry({ id: 'log-1', title: '第一条' });
    const second = entry({ id: 'log-2', title: '第二条', occurred_at: BASE_TS - DAY });
    let secondPageAttempts = 0;
    listCalls = [];
    server.use(
      http.get('/api/workspaces/:workspaceId/changelog', ({ request }) => {
        const call = captureList(request);
        if (call.offset === '0') return HttpResponse.json({ items: [first], next_offset: 20 });
        secondPageAttempts += 1;
        if (secondPageAttempts === 1) return new HttpResponse(null, { status: 500 });
        return HttpResponse.json({ items: [second], next_offset: null });
      }),
    );
    renderPanel();

    const listEl = await screen.findByTestId('changelog-list');
    Object.defineProperty(listEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(listEl, 'scrollTop', { value: 500, writable: true, configurable: true });
    fireEvent.scroll(listEl);

    const retry = await screen.findByRole('button', { name: '重试' });
    expect(screen.getByTestId('changelog-list-status')).toHaveTextContent('加载失败');
    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByTestId('changelog-entry-log-2')).toBeInTheDocument());
    expect(screen.getByTestId('changelog-list-status')).toHaveTextContent('已到底 · 共 2 条');
  });

  it('无限滚动：切换类型筛选后从首屏重新请求并把列表滚动位置归零', async () => {
    listCalls = [];
    server.use(
      http.get('/api/workspaces/:workspaceId/changelog', ({ request }) => {
        captureList(request);
        return HttpResponse.json({ items: [entry()], next_offset: 20 });
      }),
    );
    renderPanel();

    const listEl = await screen.findByTestId('changelog-list');
    Object.defineProperty(listEl, 'scrollTop', { value: 320, writable: true, configurable: true });
    await userEvent.selectOptions(screen.getByLabelText('变更日志类型'), '修复');

    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ changeType: '修复', offset: '0', limit: '20' }));
    expect((await screen.findByTestId('changelog-list')).scrollTop).toBe(0);
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

  it('LOG-HEAD-REMOVE：不再渲染「工作区日志」标题与「当前/历史工作区」切换，直接给当前工作区日志', async () => {
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
    );
    renderPanel();
    await screen.findByTestId('changelog-entry-log-active');

    // 标题与切换按钮都不再存在（历史工作区日志因此没有前端入口，服务端接口保留）
    expect(screen.queryByRole('heading', { name: '工作区日志' })).toBeNull();
    expect(screen.queryByTestId('changelog-tab-active')).toBeNull();
    expect(screen.queryByTestId('changelog-tab-archived')).toBeNull();
    expect(screen.queryByText('当前工作区')).toBeNull();
    expect(screen.queryByText('历史工作区')).toBeNull();
    // 归档区不会被渲染，也不会去拉归档列表
    expect(screen.queryByTestId('changelog-archived')).toBeNull();
    expect(screen.queryByTestId('changelog-archived-workspace-ws-old')).toBeNull();
    // 当前工作区日志照常可见
    expect(screen.getByTestId('changelog-split')).toBeInTheDocument();
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


