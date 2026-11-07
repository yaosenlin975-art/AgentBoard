/**
 * SIDEBAR-3：收起态 tooltip / 角标 / 当前项指示 / aria-label 同步。
 * SIDEBAR-4：Ctrl/Cmd+B 形态切换（非输入区、Alt 与长按重复不响应、卸载移除监听）。
 *
 * 收起态的行为大多由 index.css 的 `.ab-sidebar[data-mode='collapsed']` 作用域承担，
 * jsdom 不跑布局与伪元素，所以这里断言「数据接线」：data-tip 文案、角标文本与 99+、
 * data-active/aria-current、aria-label 带数量；视觉规格由 dev 页截图与 CSS 本身保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { SideBar } from '../components/shell/SideBar';
import type { DecisionListItemDto } from '../components/decisions/types';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { resetOverlays } from '../state/overlayStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };

const NOW = Date.now();

/** DEC-BADGE：侧栏徽标只消费 active 列表，按需造 grace / open 两类条目 */
function decisionItem(id: string, state: 'grace' | 'open'): DecisionListItemDto {
  const locked = state === 'open';
  return {
    id,
    workspace_id: ws.id,
    issue_id: 'issue-1',
    question: `问题 ${id}`,
    context_md: '',
    trigger: 'manual',
    state,
    created_by: 'agent',
    grace_seconds: 180,
    grace_until: NOW + 120_000,
    locked_at: locked ? NOW - 5_000 : null,
    stop_requested_at: locked ? NOW - 5_000 : null,
    stop_ack_at: null,
    answer_revision: 0,
    created_at: NOW - 10_000,
    answered_at: null,
    withdrawn_at: null,
    withdrawn_by: null,
    withdrawn_reason: null,
    issue_title: '任务',
    issue_status: '进行中',
    issue_priority: '中',
    option_count: 0,
    options: [],
    blocked_downstream_count: 0,
    remaining_grace_seconds: locked ? null : 120,
    waiting_seconds: locked ? 5 : null,
  };
}

function decisionsHandler(items: DecisionListItemDto[]) {
  return http.get('/api/decisions', () =>
    HttpResponse.json({
      decisions: items,
      counts: {
        grace: items.filter((item) => item.state === 'grace').length,
        open: items.filter((item) => item.state === 'open').length,
        stale_open: 0,
        answered_recent: 0,
      },
    }),
  );
}

/** jsdom 没有真实视口：按窄屏/宽屏让 matchMedia 作答（断点查询串含 max-width） */
function mockViewport(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderSideBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SideBar workspace={ws} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockViewport(false);
  document.documentElement.classList.remove('dark');
  useAppStore.setState({ wsStatus: 'open' });
  useNavStore.setState({
    view: 'board',
    drawer: null,
    sidebarMode: 'collapsed',
    sidebarModeExplicit: false,
    chatOrigin: null,
    decisionFocus: null,
  });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    refPanel: null,
    chatDrafts: {},
    rightOpen: false,
  });
  resetOverlays();
  // 待决策固定为宽限中 1 + 已落锁 2，供分项徽标 / tooltip / aria-label 断言
  server.use(
    decisionsHandler([
      decisionItem('d-grace', 'grace'),
      decisionItem('d-open-1', 'open'),
      decisionItem('d-open-2', 'open'),
    ]),
  );
});

describe('收起态 tooltip / 角标 / 当前项（SIDEBAR-3）', () => {
  it('[T1] 六个入口都有 data-tip，数量进 tooltip；账号/设置/状态行也有提示', async () => {
    renderSideBar();
    for (const view of ['board', 'decisions', 'tree', 'knowledge', 'log', 'chat']) {
      const li = screen.getByTestId(`sidebar-entry-${view}`).closest('li');
      expect(li).not.toBeNull();
      expect(li).toHaveAttribute('data-tip');
    }
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-entry-decisions').closest('li')).toHaveAttribute(
        'data-tip',
        '待决策 · 宽限中 1 · 已超时 2',
      ),
    );
    expect(screen.getByTestId('sidebar-entry-chat').closest('li')).toHaveAttribute('data-tip', '聊天');
    expect(screen.getByTestId('topbar-accounts')).toHaveAttribute('data-tip', '账号管理');
    expect(screen.getByTestId('topbar-settings')).toHaveAttribute('data-tip', '设置');
    expect(screen.getByTestId('sidebar-status').getAttribute('data-tip')).toBe('服务运行中 · 主题：跟随系统');
  });

  it('[T2] 角标：有数才渲染，>99 显示 99+，tooltip 同步 99+', () => {
    renderSideBar();
    expect(screen.queryByTestId('sidebar-chat-unread')).toBeNull();

    act(() => usePanelStore.setState({ unread: { s1: 60, s2: 60 } }));
    const badge = screen.getByTestId('sidebar-chat-unread');
    expect(badge).toHaveTextContent('99+');
    expect(badge.className).toContain('ab-sidebar-badge');
    expect(screen.getByTestId('sidebar-entry-chat').closest('li')).toHaveAttribute('data-tip', '聊天 · 99+');
  });

  it('[T2b] 待决策分项徽标：宽限中（琥珀）与已落锁（红）分别渲染，收起态同样可见', async () => {
    renderSideBar();
    await waitFor(() => expect(screen.getByTestId('sidebar-decisions-grace')).toHaveTextContent('1'));
    expect(screen.getByTestId('sidebar-decisions-locked')).toHaveTextContent('2');
    expect(screen.getByTestId('sidebar-decisions-grace').className).toContain('ab-decision-badge-grace');
    expect(screen.getByTestId('sidebar-decisions-locked').className).toContain('ab-decision-badge-locked');
    // 收起态（56px 图标栏）徽标仍挂在入口按钮内
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-mode', 'collapsed');
    expect(screen.getByTestId('sidebar-entry-decisions')).toContainElement(
      screen.getByTestId('sidebar-decisions-badge'),
    );
  });

  it('[T2c] 分项为 0 不渲染该数字；两项都 0 整块不出现；任一 >99 折成 99+', async () => {
    server.use(decisionsHandler([decisionItem('d-grace', 'grace')]));
    renderSideBar();
    await waitFor(() => expect(screen.getByTestId('sidebar-decisions-grace')).toHaveTextContent('1'));
    expect(screen.queryByTestId('sidebar-decisions-locked')).toBeNull();
    cleanup();

    server.use(decisionsHandler([]));
    renderSideBar();
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-entry-decisions')).toHaveAttribute('aria-label', '待决策'),
    );
    expect(screen.queryByTestId('sidebar-decisions-badge')).toBeNull();
    cleanup();

    const many = [
      ...Array.from({ length: 101 }, (_, i) => decisionItem(`g-${i}`, 'grace')),
      ...Array.from({ length: 120 }, (_, i) => decisionItem(`o-${i}`, 'open')),
    ];
    server.use(decisionsHandler(many));
    renderSideBar();
    await waitFor(() => expect(screen.getByTestId('sidebar-decisions-grace')).toHaveTextContent('99+'));
    expect(screen.getByTestId('sidebar-decisions-locked')).toHaveTextContent('99+');
  });

  it('[T3] 当前项：data-active 与 aria-current 同步', () => {
    renderSideBar();
    expect(screen.getByTestId('sidebar-entry-board')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('sidebar-entry-board')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-entry-tree')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('sidebar-entry-tree')).not.toHaveAttribute('aria-current');
  });

  it('[T4] aria-label 带数量：待决策 N 条 / 聊天 N 条未读', async () => {
    renderSideBar();
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-entry-decisions')).toHaveAttribute(
        'aria-label',
        '待决策，宽限中 1 条，已超时 2 条',
      ),
    );
    act(() => usePanelStore.setState({ unread: { s1: 2, s2: 3 } }));
    expect(screen.getByTestId('sidebar-entry-chat')).toHaveAttribute('aria-label', '聊天，5 条未读');
  });
});

describe('Ctrl/Cmd+B 形态切换（SIDEBAR-4）', () => {
  it('[T5] 非输入区 Ctrl+B 与 Cmd+B 都切换一次，且与顶部按钮同一 toggleSidebar', () => {
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');

    // fireEvent 返回 false 表示 preventDefault 已调用（不触发浏览器默认行为）
    expect(fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true })).toBe(false);
    expect(sidebar).toHaveAttribute('data-mode', 'expanded');
    expect(useNavStore.getState().sidebarMode).toBe('expanded');

    expect(fireEvent.keyDown(document.body, { key: 'B', metaKey: true })).toBe(false);
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');

    // 与顶部按钮等价：点一次同样落在同一 store 动作上
    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
  });

  it('[T6] input / textarea / select / contenteditable（含内部子节点）内不劫持', () => {
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.appendChild(inner);
    document.body.append(input, textarea, select, editable);

    for (const target of [input, textarea, select, editable, inner]) {
      // true = 未 preventDefault，浏览器默认行为保留
      expect(fireEvent.keyDown(target, { key: 'b', ctrlKey: true })).toBe(true);
      expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    }
    expect(fireEvent.keyDown(inner, { key: 'b', metaKey: true })).toBe(true);
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    for (const node of [input, textarea, select, editable]) node.remove();
  });

  it('[T7] 带 Alt 或长按自动重复（repeat）不切换', () => {
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');

    expect(fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true, altKey: true })).toBe(true);
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');

    expect(fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true, repeat: true })).toBe(true);
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
  });

  it('[T8] 卸载后移除监听；重新挂载后一次按键只切一次', () => {
    const first = renderSideBar();
    first.unmount();

    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');

    renderSideBar();
    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    // 只切一次：collapsed → expanded（若重复绑定会立刻切回 collapsed）
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
  });
});

describe('SPEC-ALIGN：状态圆点尺寸（原型规格）', () => {
  it('[T13] 收起态圆点 6px、展开态 8px', () => {
    renderSideBar();
    const status = screen.getByTestId('topbar-ws-status');
    const dot = status.querySelector('span');
    expect(dot).not.toBeNull();
    // 收起态：原型 6px（h-1.5 / w-1.5）
    expect(dot?.className).toContain('h-1.5');
    expect(dot?.className).toContain('w-1.5');

    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-mode', 'expanded');
    // 展开态保留原 8px（h-2 / w-2）
    expect(dot?.className).toContain('h-2');
    expect(dot?.className).toContain('w-2');
    expect(dot?.className).not.toContain('h-1.5');
  });
});

describe('窄屏浮层 + 遮罩（SIDEBAR-5）', () => {
  it('[T9] <920px 收起态：仍是图标栏，无遮罩与占位块', () => {
    mockViewport(true);
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(sidebar).not.toHaveAttribute('data-overlay');
    expect(screen.queryByTestId('sidebar-backdrop')).toBeNull();
    expect(document.querySelector('.ab-sidebar-rail-slot')).toBeNull();
  });

  it('[T10] <920px 展开为瞬时浮层：Ctrl+B 打开、不写形态记忆，再点按钮收起并回焦', () => {
    mockViewport(true);
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    const toggle = screen.getByTestId('sidebar-collapse-toggle');

    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    expect(sidebar).toHaveAttribute('data-mode', 'expanded');
    expect(sidebar).toHaveAttribute('data-overlay', 'true');
    expect(screen.getByTestId('sidebar-backdrop')).toBeInTheDocument();
    // 56px 占位仍在流内，主区不被 208px 挤压
    expect(document.querySelector('.ab-sidebar-rail-slot')).not.toBeNull();
    // 瞬时态：store 与 localStorage 都没有被写成 expanded
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    const persisted = JSON.parse(localStorage.getItem('agentboard.nav') ?? '{"state":{}}') as {
      state?: { sidebarMode?: string };
    };
    expect(persisted.state?.sidebarMode).toBeUndefined();

    fireEvent.click(toggle);
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(screen.queryByTestId('sidebar-backdrop')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('[T11] Esc / 点遮罩 / 选中入口三条路径都收起，焦点回到切换按钮', () => {
    mockViewport(true);
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    const toggle = screen.getByTestId('sidebar-collapse-toggle');
    const open = (): void => {
      fireEvent.click(toggle);
      expect(sidebar).toHaveAttribute('data-overlay', 'true');
    };

    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(document.activeElement).toBe(toggle);

    open();
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(document.activeElement).toBe(toggle);

    open();
    fireEvent.click(screen.getByTestId('sidebar-entry-tree'));
    expect(useNavStore.getState().view).toBe('tree');
    expect(sidebar).toHaveAttribute('data-mode', 'collapsed');
    expect(document.activeElement).toBe(toggle);
  });

  it('[T12] ≥920px 走内联两形态：不加遮罩与浮层标记，切换写回 store', () => {
    mockViewport(false);
    renderSideBar();
    const sidebar = screen.getByTestId('sidebar');
    const toggle = screen.getByTestId('sidebar-collapse-toggle');

    expect(sidebar).not.toHaveAttribute('data-overlay');
    expect(screen.queryByTestId('sidebar-backdrop')).toBeNull();

    fireEvent.click(toggle);
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
    expect(sidebar).toHaveAttribute('data-mode', 'expanded');
    expect(sidebar).not.toHaveAttribute('data-overlay');
  });
});
