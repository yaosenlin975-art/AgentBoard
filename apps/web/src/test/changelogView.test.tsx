/**
 * LOG-VIEW：工作区日志从浮窗改为「知识库右侧的日志视图」。
 * 覆盖：入口位置与文案、进入视图而非浮窗、左右两栏、默认选中最新、点列表切详情（Markdown）、窄屏退化、空态、归档只读。
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { ChangelogPanel } from '../components/changelog/ChangelogPanel';
import { ViewSwitcher } from '../components/ui/ViewSwitcher';
import { server } from './server';

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

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function withClient(node: React.ReactNode) {
  return render(<QueryClientProvider client={newClient()}>{node}</QueryClientProvider>);
}

function mockList(items: WorkspaceChangeLog[], nextOffset: number | null = null) {
  server.use(
    http.get('/api/workspaces/:workspaceId/changelog', () => HttpResponse.json({ items, next_offset: nextOffset })),
  );
}

/** 模拟 App 的接线：视图互斥 + 日志作为主区域视图渲染 */
function Harness() {
  const [logOpen, setLogOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const toggleLog = (): void => {
    setKnowledgeOpen(false);
    setLogOpen((open) => !open);
  };
  return (
    <div>
      <div data-testid="harness-switcher">
        <ViewSwitcher
          layout="board"
          onLayout={() => undefined}
          knowledgeOpen={knowledgeOpen}
          onToggleKnowledge={() => {
            setLogOpen(false);
            setKnowledgeOpen((open) => !open);
          }}
          logOpen={logOpen}
          onToggleLog={toggleLog}
        />
      </div>
      {logOpen ? (
        <ChangelogPanel
          workspaceId="ws-1"
          logOpen
          onToggleLog={toggleLog}
          onToggleKnowledge={() => {
            setLogOpen(false);
            setKnowledgeOpen(true);
          }}
        />
      ) : (
        <p data-testid="board-stub">平铺看板内容</p>
      )}
    </div>
  );
}

beforeEach(() => {
  mockList([entry()]);
});

describe('日志入口（知识库右侧）', () => {
  it('「日志」按钮紧挨「知识库」右侧，四个视图按钮顺序固定', () => {
    withClient(
      <ViewSwitcher
        layout="board"
        onLayout={() => undefined}
        knowledgeOpen={false}
        onToggleKnowledge={() => undefined}
        logOpen={false}
        onToggleLog={() => undefined}
      />,
    );
    const switcher = screen.getByTestId('view-switcher');
    const labels = within(switcher).getAllByRole('button').map((node) => node.textContent);
    expect(labels).toEqual(['平铺看板', '任务树', '知识库', '日志']);
    expect(labels.indexOf('日志')).toBe(labels.indexOf('知识库') + 1);
    expect(screen.getByTestId('view-log')).toHaveAttribute('aria-pressed', 'false');
  });

  it('点「日志」进入主区域视图而不是浮窗', async () => {
    withClient(<Harness />);
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
    const entryButton = within(screen.getByTestId('harness-switcher')).getByTestId('view-log');

    await userEvent.click(entryButton);

    const panel = await screen.findByTestId('changelog-panel');
    expect(panel.tagName).toBe('SECTION');
    // 不是浮窗：没有 dialog 角色
    expect(screen.queryByRole('dialog')).toBeNull();
    // 与平铺看板/知识库同级：视图切换器仍在视图内部
    expect(within(panel).getByTestId('view-switcher')).toBeInTheDocument();
    expect(screen.queryByTestId('board-stub')).toBeNull();
    expect(within(screen.getByTestId('harness-switcher')).getByTestId('view-log')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('日志视图：左右两栏', () => {
  it('左列表 + 右详情在同一分行容器内，默认选中最新一条', async () => {
    const latest = entry({ id: 'log-latest', title: '最新一条', occurred_at: BASE_TS });
    const older = entry({ id: 'log-old', title: '较早一条', occurred_at: BASE_TS - DAY });
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);

    const split = await screen.findByTestId('changelog-split');
    const listPane = within(split).getByTestId('changelog-list-pane');
    const detailPane = within(split).getByTestId('changelog-detail-pane');
    expect(listPane).toBeInTheDocument();
    expect(detailPane).toBeInTheDocument();

    // 列表按时间倒序：最新在顶，且默认选中最新
    const listItems = within(listPane).getAllByRole('button', { name: /最新一条|较早一条/ });
    expect(listItems.map((node) => node.getAttribute('data-testid'))).toEqual([
      'changelog-entry-log-latest',
      'changelog-entry-log-old',
    ]);
    expect(within(listPane).getByTestId('changelog-entry-log-latest')).toHaveAttribute('aria-current', 'true');
    expect(within(listPane).getByTestId('changelog-entry-log-old')).not.toHaveAttribute('aria-current');
    expect(within(detailPane).getByTestId('changelog-detail-title')).toHaveTextContent('最新一条');
  });

  it('点左侧条目切换右侧详情并渲染 Markdown', async () => {
    const latest = entry({ id: 'log-latest', title: '最新一条', body_md: '最新正文' });
    const older = entry({
      id: 'log-old',
      title: '较早一条',
      occurred_at: BASE_TS - DAY,
      body_md: '## 小节标题\n\n- 列表项',
    });
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);

    const detailPane = await screen.findByTestId('changelog-detail-pane');
    expect(within(detailPane).getByTestId('changelog-detail-title')).toHaveTextContent('最新一条');

    await userEvent.click(screen.getByTestId('changelog-entry-log-old'));

    await waitFor(() =>
      expect(within(detailPane).getByTestId('changelog-detail-title')).toHaveTextContent('较早一条'),
    );
    const body = within(detailPane).getByTestId('changelog-detail-body');
    expect(await within(body).findByRole('heading', { level: 2 }, { timeout: 5000 })).toHaveTextContent('小节标题');
    expect(within(body).getByRole('listitem')).toHaveTextContent('列表项');
    expect(screen.getByTestId('changelog-entry-log-old')).toHaveAttribute('aria-current', 'true');
  });

  it('≤900px 退化为上下堆叠（单列），≥901px 才是左右两栏', async () => {
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const split = await screen.findByTestId('changelog-split');
    expect(split.className).toContain('grid-cols-1');
    expect(split.className).toContain('min-[901px]:grid-cols-[minmax(200px,300px)_minmax(0,1fr)]');
  });

  it('空态：左栏给出空提示，右栏提示无详情', async () => {
    mockList([]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    expect(await screen.findByTestId('changelog-empty')).toHaveTextContent('这个工作区还没有变更日志');
    expect(screen.getByTestId('changelog-detail-empty')).toHaveTextContent('（暂无变更日志）');
    expect(screen.queryByTestId('changelog-list')).toBeNull();
  });

  it('切 workspace：列表与详情都换成新工作区，不残留旧条目', async () => {
    server.use(
      http.get('/api/workspaces/:workspaceId/changelog', ({ params }) => {
        const id = String(params.workspaceId);
        return HttpResponse.json({
          items: [entry({ id: `log-${id}`, workspace_id: id, origin_workspace_id: id, title: `${id} 日志` })],
          next_offset: null,
        });
      }),
    );
    const { rerender } = withClient(<ChangelogPanel workspaceId="ws-1" />);
    await screen.findByTestId('changelog-entry-log-ws-1');

    rerender(
      <QueryClientProvider client={newClient()}>
        <ChangelogPanel workspaceId="ws-2" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('changelog-entry-log-ws-2');
    expect(screen.queryByTestId('changelog-entry-log-ws-1')).toBeNull();
    expect(screen.getByTestId('changelog-detail-title')).toHaveTextContent('ws-2 日志');
  });

  it('归档 tab 仍是只读区（无新增入口、无活动条目）', async () => {
    server.use(
      http.get('/api/changelog/archived-workspaces', () => HttpResponse.json({ items: [], next_offset: null })),
    );
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    await screen.findByTestId('changelog-split');

    await userEvent.click(screen.getByTestId('changelog-tab-archived'));

    expect(await screen.findByTestId('changelog-archived')).toBeInTheDocument();
    expect(screen.queryByTestId('changelog-create')).toBeNull();
    expect(screen.queryByTestId('changelog-split')).toBeNull();
  });
});
