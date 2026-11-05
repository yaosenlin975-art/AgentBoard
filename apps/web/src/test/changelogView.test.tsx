/**
 * LOG-VIEW + LOG-SCROLL：日志是「知识库右侧的日志视图」，主体左列表 + 右侧连续滚动区。
 * 覆盖：入口位置与文案、进入视图而非浮窗、左右两栏、连续渲染与 1px 分割线、类型标签定宽、点击跳转、
 * 选中随滚动更新（IntersectionObserver）、reduced-motion 即时跳转、窄屏退化、空态、归档只读、切 workspace。
 * 几何（真实矩形 / 滚动位置）由 CDP 在浏览器验证；这里锁 DOM 结构与交互契约。
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { ChangelogPanel } from '../components/changelog/ChangelogPanel';
import { useNavStore } from '../state/navStore';
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

/** jsdom 没有 IntersectionObserver / scrollIntoView：由测试注入并手动触发 */
interface FakeObserver {
  callback: IntersectionObserverCallback;
  elements: Element[];
}
let observers: FakeObserver[] = [];
let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // FIX-2：Harness 依赖 navStore.view，用例间必须重置
  useNavStore.setState({ view: 'board', chatOrigin: null });
  observers = [];
  scrollSpy = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollSpy, writable: true, configurable: true });
  class FakeIntersectionObserver {
    callback: IntersectionObserverCallback;
    elements: Element[] = [];
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      observers.push(this as unknown as FakeObserver);
    }
    observe(element: Element): void {
      this.elements.push(element);
      // 日志条目由测试用手动 fireIntersect 驱动；其它观察者（MarkdownView 的懒加载门控）立即视为可见，
      // 否则 Markdown 永远停在水合前的 fallback，正文断言取不到真实元素。
      if (!(element instanceof Element) || !element.hasAttribute('data-changelog-id')) {
        setTimeout(() => {
          this.callback(
            [{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }, 0);
      }
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', {
    value: FakeIntersectionObserver,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 模拟某条日志滚入视口：触发所有观察器的回调 */
function fireIntersect(id: string): void {
  const target = document.querySelector(`[data-changelog-id="${id}"]`);
  expect(target).not.toBeNull();
  for (const observer of observers) {
    observer.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  }
}

/**
 * 模拟 App 的接线（FIX-2 后）：视图由 navStore 单一决定，工具条不再有 ViewSwitcher；
 * 切视图靠左栏入口（这里用两个等价按钮代替 SideBar，避免依赖 FIX-1 的实现）。
 */
function Harness() {
  const view = useNavStore((s) => s.view);
  const setView = useNavStore((s) => s.setView);
  return (
    <div>
      <div data-testid="harness-nav">
        <button type="button" data-testid="sidebar-entry-log" onClick={() => setView('log')}>日志</button>
        <button type="button" data-testid="sidebar-entry-board" onClick={() => setView('board')}>任务看板</button>
      </div>
      {view === 'log' ? (
        <ChangelogPanel workspaceId="ws-1" />
      ) : (
        <p data-testid="board-stub">任务看板内容</p>
      )}
    </div>
  );
}

describe('日志入口（知识库右侧）', () => {
  it('FIX-2：工具条不再有 ViewSwitcher；日志视图由左栏入口切入', async () => {
    mockList([entry()]);
    withClient(<Harness />);
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('view-switcher')).toBeNull();
    await userEvent.click(screen.getByTestId('sidebar-entry-log'));
    expect(await screen.findByTestId('changelog-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('view-switcher')).toBeNull();
  });

  it('点「日志」进入主区域视图而不是浮窗', async () => {
    mockList([entry()]);
    withClient(<Harness />);
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
    const entryButton = screen.getByTestId('sidebar-entry-log');

    await userEvent.click(entryButton);

    const panel = await screen.findByTestId('changelog-panel');
    expect(panel.tagName).toBe('SECTION');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(panel).queryByTestId('view-switcher')).toBeNull();
    expect(screen.queryByTestId('board-stub')).toBeNull();
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
  });
});

describe('日志视图：左列表 + 右侧连续滚动区', () => {
  const latest = entry({ id: 'log-latest', title: '最新一条', body_md: '最新正文' });
  const older = entry({ id: 'log-old', title: '较早一条', occurred_at: BASE_TS - DAY, body_md: '## 小节标题\n\n- 列表项' });

  it('右侧全量连续渲染（不折叠、不卡片堆叠），默认选中最新一条', async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);

    const split = await screen.findByTestId('changelog-split');
    const listPane = within(split).getByTestId('changelog-list-pane');
    const scroll = within(split).getByTestId('changelog-scroll');

    const listItems = within(listPane).getAllByRole('button', { name: /最新一条|较早一条/ });
    expect(listItems.map((node) => node.getAttribute('data-testid'))).toEqual([
      'changelog-entry-log-latest',
      'changelog-entry-log-old',
    ]);

    // 右侧：两条都在同一滚动区内，顺序与左列表一致
    const docIds = [...scroll.querySelectorAll('[data-changelog-id]')].map((n) => n.getAttribute('data-changelog-id'));
    expect(docIds).toEqual(['log-latest', 'log-old']);
    expect(within(listPane).getByTestId('changelog-entry-log-latest')).toHaveAttribute('aria-current', 'true');
    expect(within(scroll).getByTestId('changelog-doc-log-latest')).toHaveAttribute('aria-current', 'true');
    expect(within(scroll).getByTestId('changelog-doc-log-old')).not.toHaveAttribute('aria-current');

    // 正文全部直接渲染（不需要展开）
    expect(within(scroll).getByTestId('changelog-doc-body-log-old')).toBeInTheDocument();
  });

  it('LOG-PAGER：列表是唯一滚动容器，分页条在滚动区之外（滚动时不漂）', async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);

    const split = await screen.findByTestId('changelog-split');
    const pane = within(split).getByTestId('changelog-list-pane');
    const list = within(pane).getByTestId('changelog-list');
    const pager = within(pane).getByTestId('changelog-pager');

    // pane 不再整体滚（overflow-hidden），列表自己滚（min-h-0 flex-1 overflow-auto）
    expect(pane.className).toContain('overflow-hidden');
    expect(pane.className).not.toContain('overflow-auto');
    expect(list.className).toContain('overflow-auto');
    expect(list.className).toContain('flex-1');
    expect(list.className).toContain('min-h-0');
    // 分页条：pane 的最后一个子元素、不在滚动区内部、shrink-0
    expect(pane.lastElementChild).toBe(pager);
    expect(list.contains(pager)).toBe(false);
    expect(pager.className).toContain('shrink-0');
    expect(pager.className).toContain('border-t');
    // 曾经的 mt-auto 漂移写法已移除
    expect(pager.className).not.toContain('mt-auto');
  });

  it('LOG-PAGER：空态不渲染分页条（不留悬空按钮）', async () => {
    mockList([]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    expect(await screen.findByTestId('changelog-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('changelog-pager')).toBeNull();
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull();
  });
  it('右侧正文是真实 Markdown（折叠已取消，全部直接渲染）', { timeout: 20000 }, async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const scroll = await screen.findByTestId('changelog-scroll');
    const body = within(scroll).getByTestId('changelog-doc-body-log-old');
    expect(await within(body).findByRole('heading', { level: 2 }, { timeout: 15000 })).toHaveTextContent('小节标题');
    expect(within(body).getByRole('listitem')).toHaveTextContent('列表项');
  });

  it('条间 / 组间用 1px 分割线，不是卡片边框', async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const scroll = await screen.findByTestId('changelog-scroll');

    const articles = [...scroll.querySelectorAll('article[data-changelog-id]')];
    expect(articles.length).toBe(2);
    for (const article of articles) {
      expect(article.className).toContain('border-t');
      expect(article.className).not.toContain('rounded-md border border');
    }
    const groups = [...scroll.querySelectorAll('[data-testid^="changelog-doc-group-"]')];
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const group of groups) expect(group.className).toContain('border-b');
  });

  it('类型标签定宽 44px 且文字居中（三种类型同宽）', async () => {
    mockList([
      entry({ id: 'log-new', title: '新增的', change_type: '新增' }),
      entry({ id: 'log-fix', title: '修复的', change_type: '修复', occurred_at: BASE_TS - DAY }),
      entry({ id: 'log-tune', title: '调整的', change_type: '调整', occurred_at: BASE_TS - 2 * DAY }),
    ]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const scroll = await screen.findByTestId('changelog-scroll');

    for (const type of ['新增', '修复', '调整']) {
      const tags = within(scroll).getAllByTestId(`changelog-type-${type}`);
      expect(tags.length).toBeGreaterThan(0);
      const tag = tags[0]!;
      expect(tag.className).toContain('w-11');
      expect(tag.className).toContain('justify-center');
      expect(tag.className).toContain('shrink-0');
      expect(tag.className).not.toContain('min-w-');
    }
    const listTag = within(await screen.findByTestId('changelog-list-pane')).getAllByTestId('changelog-type-修复')[0]!;
    expect(listTag.className).toContain('w-11');
  });

  it('点左侧列表项 → 右侧对应日志滚入视口并同步选中', async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    await screen.findByTestId('changelog-scroll');

    await userEvent.click(screen.getByTestId('changelog-entry-log-old'));

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0]?.[0] as ScrollIntoViewOptions).toMatchObject({ behavior: 'smooth', block: 'start' });
    await waitFor(() => expect(screen.getByTestId('changelog-doc-log-old')).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByTestId('changelog-entry-log-old')).toHaveAttribute('aria-current', 'true');
  });

  it('prefers-reduced-motion: reduce 时改为即时跳转（behavior=auto）', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    try {
      mockList([older, latest]);
      withClient(<ChangelogPanel workspaceId="ws-1" />);
      await screen.findByTestId('changelog-scroll');

      await userEvent.click(screen.getByTestId('changelog-entry-log-old'));
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0]?.[0] as ScrollIntoViewOptions).toMatchObject({ behavior: 'auto' });
    } finally {
      Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: original });
    }
  });

  it('滚动位置变化时选中项跟着更新（IntersectionObserver）', async () => {
    mockList([older, latest]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    await screen.findByTestId('changelog-scroll');
    expect(screen.getByTestId('changelog-doc-log-latest')).toHaveAttribute('aria-current', 'true');

    fireIntersect('log-old');

    await waitFor(() => expect(screen.getByTestId('changelog-doc-log-old')).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByTestId('changelog-entry-log-old')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('changelog-doc-log-latest')).not.toHaveAttribute('aria-current');
  });

  it('≤900px 退化为上下堆叠（单列），≥901px 才是左右两栏', async () => {
    mockList([entry()]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const split = await screen.findByTestId('changelog-split');
    expect(split.className).toContain('grid-cols-1');
    expect(split.className).toContain('min-[901px]:grid-cols-[minmax(200px,300px)_minmax(0,1fr)]');
  });

  it('空态：左栏与右侧滚动区各给提示', async () => {
    mockList([]);
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    expect(await screen.findByTestId('changelog-empty')).toHaveTextContent('这个工作区还没有变更日志');
    expect(screen.getByTestId('changelog-empty-doc')).toHaveTextContent('这个工作区还没有变更日志');
    expect(screen.queryByTestId('changelog-list')).toBeNull();
  });

  it('切 workspace：列表与滚动区都换成新工作区，不残留旧条目', async () => {
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
    expect(screen.getByTestId('changelog-doc-title-log-ws-2')).toHaveTextContent('ws-2 日志');
  });

  it('LOG-HEAD-REMOVE：日志视图只有内容，没有标题与归档入口', async () => {
    mockList([entry()]);
    server.use(
      http.get('/api/changelog/archived-workspaces', () => HttpResponse.json({ items: [], next_offset: null })),
    );
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    await screen.findByTestId('changelog-split');

    expect(screen.queryByTestId('changelog-tab-active')).toBeNull();
    expect(screen.queryByTestId('changelog-tab-archived')).toBeNull();
    expect(screen.queryByTestId('changelog-archived')).toBeNull();
    expect(screen.queryByText('工作区日志')).toBeNull();
    // 日志内容与「按日分组 + 左侧跳转」的外壳仍在
    expect(screen.getByTestId('changelog-split')).toBeInTheDocument();
  });
});

