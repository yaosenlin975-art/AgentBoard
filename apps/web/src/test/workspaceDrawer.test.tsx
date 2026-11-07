/**
 * WS-DRAWER-01 + AUDIT-WS I-11：工作空间抽屉的搜索框、kebab 菜单（置顶/上移/下移/移除，命中区 ≥28px）
 * 与卡片名称/路径的可读性结构断言。
 * 几何不重叠（真实矩形）由 CDP 在浏览器验证，这里只锁 DOM 结构与行为。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { WorkspaceList } from '../components/workspace/WorkspaceList';
import { WorkspaceSidebarOverlay } from '../components/overlay/WorkspaceSidebarOverlay';
import { useOverlayStore } from '../state/overlayStore';
import { PINNED_IDS_KEY, pinnedOrder } from '../lib/workspaceReorder';
import { server } from './server';

const wsA: Workspace = { id: 'a1', name: '甲项目', path: 'D:\\WorkSpaces\\Alpha', created_at: 3, sort_order: 0 };
const wsB: Workspace = { id: 'b2', name: '乙项目', path: 'D:\\WorkSpaces\\beta', created_at: 1, sort_order: 1 };
const wsC: Workspace = { id: 'c3', name: '丙项目', path: 'D:\\WorkSpaces\\gamma', created_at: 2, sort_order: 2 };

/** I-11：行内控件收进 kebab 菜单，测试口径 = 先点 ⋮ 打开面板，再点面板里的菜单项 */
async function openCardMenu(id: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByTestId(`workspace-card-menu-${id}`));
  return await screen.findByTestId(`workspace-card-menu-panel-${id}`);
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderList() {
  return render(
    <QueryClientProvider client={newClient()}>
      <WorkspaceList />
    </QueryClientProvider>,
  );
}

function rowIds(): (string | null)[] {
  return [...document.querySelectorAll('[data-testid^="workspace-row-"]')].map((node) =>
    node.getAttribute('data-testid'),
  );
}

/** 默认工作空间列表 + 空 issues；reorder 回显请求顺序（模拟服务端权威顺序） */
function mockBase(list: Workspace[] = [wsA, wsB, wsC], onReorder?: (ids: string[]) => void) {
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json(list)),
    // PERF-4b：切换面板计数走 counts 聚合，不再每卡拉全量
    http.get('/api/issues/counts', ({ request }) => {
      const ids = new URL(request.url).searchParams.get('workspace_ids')?.split(',') ?? [];
      return HttpResponse.json({
        items: ids.map((id) => ({ workspace_id: id, total: 0, counts: {} })),
      });
    }),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.post('/api/workspaces/reorder', async ({ request }) => {
      const body = (await request.json()) as { ordered_ids: string[] };
      onReorder?.(body.ordered_ids);
      return HttpResponse.json({
        workspaces: body.ordered_ids.map((id, index) => {
          const found = [...list].find((workspace) => workspace.id === id);
          return { ...(found ?? wsA), sort_order: index };
        }),
        reordered_at: 1,
      });
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('WorkspaceList 搜索框', () => {
  it('按名称过滤（大小写不敏感），不改变服务端排序', async () => {
    mockBase();
    renderList();
    await screen.findByTestId('workspace-row-a1');

    await userEvent.type(screen.getByTestId('workspace-search'), '乙');
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-b2']));

    await userEvent.clear(screen.getByTestId('workspace-search'));
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']));
  });

  it('按路径过滤且大小写不敏感；无命中显示空态', async () => {
    mockBase();
    renderList();
    await screen.findByTestId('workspace-row-a1');

    // 路径 D:\WorkSpaces\gamma，输入大写 GAMMA 命中丙项目
    await userEvent.type(screen.getByTestId('workspace-search'), 'GAMMA');
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-c3']));

    await userEvent.clear(screen.getByTestId('workspace-search'));
    await userEvent.type(screen.getByTestId('workspace-search'), 'zzz-not-exist');
    await waitFor(() => expect(screen.getByTestId('workspace-search-empty')).toHaveTextContent('没有匹配的工作空间'));
    expect(rowIds()).toEqual([]);
  });

  it('抽屉打开时焦点落在搜索框', async () => {
    mockBase([wsA]);
    useOverlayStore.getState().openLeft();
    const triggerRef = { current: document.createElement('button') };
    render(
      <QueryClientProvider client={newClient()}>
        <WorkspaceSidebarOverlay triggerRef={triggerRef} />
      </QueryClientProvider>,
    );
    const input = await screen.findByTestId('workspace-search');
    await waitFor(() => expect(input).toHaveFocus());
    useOverlayStore.getState().closeLeft();
  });
});

describe('WorkspaceList 置顶', () => {
  it('置顶把该项移到首位，请求发出且按下态写入 localStorage', async () => {
    const sent: string[][] = [];
    mockBase([wsA, wsB, wsC], (ids) => sent.push(ids));
    renderList();
    const rowC = await screen.findByTestId('workspace-row-c3');

    await openCardMenu('c3');
    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    await waitFor(() => expect(sent).toEqual([['c3', 'a1', 'b2']]));
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-c3', 'workspace-row-a1', 'workspace-row-b2']));
    // 置顶态在卡面有徽标；菜单项是 menuitemcheckbox，选中态用 aria-checked
    expect(within(rowC).getByTestId('workspace-pinned-badge-c3')).toBeInTheDocument();
    await openCardMenu('c3');
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-checked', 'true');
    expect(window.localStorage.getItem(PINNED_IDS_KEY)).toBe(JSON.stringify([{ id: 'c3', originIndex: 2 }]));
  });

  it('置顶状态刷新后仍生效（按下态从 localStorage 恢复）', async () => {
    window.localStorage.setItem(PINNED_IDS_KEY, JSON.stringify([{ id: 'c3', originIndex: 2 }]));
    mockBase([
      { ...wsC, sort_order: 0 },
      { ...wsA, sort_order: 1 },
      { ...wsB, sort_order: 2 },
    ]);
    renderList();

    const rowC = await screen.findByTestId('workspace-row-c3');
    expect(within(rowC).getByTestId('workspace-pinned-badge-c3')).toBeInTheDocument();
    await openCardMenu('c3');
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-checked', 'true');
    expect(rowIds()[0]).toBe('workspace-row-c3');
  });

  it('再次点击取消置顶：还原到置顶前位置，其余项相对次序不变', async () => {
    // 原始顺序 a1,b2,c3；c3 与 a1 都被置顶过（记录各自置顶前的下标）
    window.localStorage.setItem(
      PINNED_IDS_KEY,
      JSON.stringify([
        { id: 'c3', originIndex: 2 },
        { id: 'a1', originIndex: 0 },
      ]),
    );
    const sent: string[][] = [];
    mockBase(
      [
        { ...wsC, sort_order: 0 },
        { ...wsA, sort_order: 1 },
        { ...wsB, sort_order: 2 },
      ],
      (ids) => sent.push(ids),
    );
    renderList();
    const rowC = await screen.findByTestId('workspace-row-c3');
    expect(within(rowC).getByTestId('workspace-pinned-badge-c3')).toBeInTheDocument();

    await openCardMenu('c3');
    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    await waitFor(() => expect(sent).toEqual([['a1', 'b2', 'c3']]));
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']));
    await openCardMenu('c3');
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-checked', 'false');
    expect(within(rowC).queryByTestId('workspace-pinned-badge-c3')).toBeNull();
    expect(window.localStorage.getItem(PINNED_IDS_KEY)).toBe(JSON.stringify([{ id: 'a1', originIndex: 0 }]));
  });

  it('置顶提交失败：顺序与按下态一起回滚并提示', async () => {
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
      http.get('/api/issues', () => HttpResponse.json([])),
      http.post('/api/workspaces/reorder', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: '写库失败' } }, { status: 500 }),
      ),
    );
    renderList();
    const rowC = await screen.findByTestId('workspace-row-c3');

    await openCardMenu('c3');
    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    expect(await screen.findByTestId('workspace-order-notice')).toHaveTextContent('写库失败');
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']));
    await openCardMenu('c3');
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-checked', 'false');
    expect(within(rowC).queryByTestId('workspace-pinned-badge-c3')).toBeNull();
    expect(window.localStorage.getItem(PINNED_IDS_KEY)).toBe(JSON.stringify([]));
  });

  it('pinnedOrder 纯函数：置顶移到首位、取消置顶还原置顶前位置（越界夹到末尾）', () => {
    const list = [wsC, wsA, wsB];
    expect(pinnedOrder(list, 'b2', true, []).map((w) => w.id)).toEqual(['b2', 'c3', 'a1']);
    expect(pinnedOrder(list, 'c3', false, [{ id: 'c3', originIndex: 2 }]).map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
    expect(pinnedOrder(list, 'c3', false, [{ id: 'c3', originIndex: 9 }]).map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
    expect(pinnedOrder(list, 'not-exist', true, []).map((w) => w.id)).toEqual(['c3', 'a1', 'b2']);
  });
});

describe('WorkspaceCard 布局（I-11：操作收进 kebab 菜单，命中区 ≥28px）', () => {
  it('置顶 · 上移 · 下移 · 移除 收进 ⋮ 菜单：默认收起，打开后面板在卡片内、顺序不变', async () => {
    mockBase([wsA]);
    renderList();
    const row = await screen.findByTestId('workspace-row-a1');

    const actions = within(row).getByTestId('workspace-card-actions-a1');
    const trigger = within(actions).getByTestId('workspace-card-menu-a1');
    const card = within(row).getByTestId('workspace-card-a1').closest('[data-workspace-card]');

    // 默认收起：面板不在 DOM 里，卡面右上角只留一个 ⋮
    expect(within(row).queryByTestId('workspace-card-menu-panel-a1')).toBeNull();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // 命中区 28×28（h-7 / w-7 = 28px），拖拽把手同样抬到 28px 高
    for (const cls of ['inline-flex', 'h-7', 'w-7']) expect(trigger.className).toContain(cls);
    expect(within(row).getByTestId('workspace-drag-a1').className).toContain('h-7');
    // 控件容器仍 absolute 锚在卡片右上角头部
    for (const cls of ['absolute', 'top-1', 'right-1', 'flex', 'items-center']) {
      expect(actions.className).toContain(cls);
    }

    await openCardMenu('a1');
    const panel = within(row).getByTestId('workspace-card-menu-panel-a1');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('role', 'menu');
    const pin = within(panel).getByTestId('workspace-pin-a1');
    const up = within(panel).getByTestId('workspace-move-up-a1');
    const down = within(panel).getByTestId('workspace-move-down-a1');
    const remove = within(panel).getByRole('menuitem', { name: '移除工作空间 甲项目' });

    // 卡片容器存在，四个菜单项的父链都落在它里面（面板/触发器都是内容按钮的兄弟节点，按钮不嵌套按钮）
    expect(card).not.toBeNull();
    expect(card).toBe(row.querySelector('[data-workspace-card="a1"]'));
    expect(panel.closest('button')).toBeNull();
    expect(actions.closest('button')).toBeNull();
    for (const item of [pin, up, down, remove]) {
      expect(item.closest('[data-workspace-card]')).toBe(card);
      expect(card?.contains(item)).toBe(true);
      // 菜单项命中区 ≥28px（min-h-7），角色是 menuitem / menuitemcheckbox
      expect(item.className).toContain('min-h-7');
      expect(item.getAttribute('role')).toMatch(/^menuitem/);
    }
    // 顺序：置顶 → 上移 → 下移 → 移除
    for (const [left, right] of [[pin, up], [up, down], [down, remove]] as const) {
      expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // 菜单与统计格互不包含
    const closed = within(row).getByTestId('stat-已关闭');
    expect(closed.contains(up)).toBe(false);
    expect(panel.contains(closed)).toBe(false);

    // 统计文案 nowrap + 卡片容器最小高度，窄宽度不折行挤压
    expect(within(closed).getByText('已关闭').className).toContain('whitespace-nowrap');
    expect(card?.className).toContain('min-h-[6.5rem]');
  });

  it('点外部关闭菜单，Esc 关闭并把焦点还给 ⋮（键盘可达）', async () => {
    mockBase([wsA]);
    renderList();
    const row = await screen.findByTestId('workspace-row-a1');
    const trigger = within(row).getByTestId('workspace-card-menu-a1');

    await openCardMenu('a1');
    expect(within(row).getByTestId('workspace-card-menu-panel-a1')).toBeInTheDocument();
    await userEvent.click(document.body);
    await waitFor(() =>
      expect(within(row).queryByTestId('workspace-card-menu-panel-a1')).toBeNull(),
    );

    await openCardMenu('a1');
    // 打开即把焦点送进第一个菜单项
    await waitFor(() => expect(within(row).getByTestId('workspace-pin-a1')).toHaveFocus());
    // 单卡列表：上移/下移禁用，↑↓ 漫游跳过禁用项（置顶 → 移除）
    expect(within(row).getByTestId('workspace-move-up-a1')).toBeDisabled();
    expect(within(row).getByTestId('workspace-move-down-a1')).toBeDisabled();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(row).getByTestId('workspace-remove-a1')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(within(row).getByTestId('workspace-pin-a1')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(within(row).getByTestId('workspace-remove-a1')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(row).queryByTestId('workspace-card-menu-panel-a1')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('相似仓库名可分辨：名称 flex-1 + min-w-0 + truncate 优先，行内只为 ⋮ 让出 pr-10（旧版 pr-32 已移除）', async () => {
    const net: Workspace = { id: 'n1', name: 'Networks-Toolkit', path: 'D:\\WorkSpaces\\Networks-Toolkit', created_at: 1, sort_order: 0 };
    const frame: Workspace = { id: 'f1', name: 'Frameworks-Core', path: 'D:\\WorkSpaces\\Frameworks-Core', created_at: 2, sort_order: 1 };
    mockBase([net, frame]);
    renderList();
    await screen.findByTestId('workspace-row-n1');

    for (const [id, ws] of [['n1', net], ['f1', frame]] as const) {
      const name = screen.getByTestId(`workspace-card-name-${id}`);
      // flex-1 + min-w-0 才让 truncate 真正生效：名称先拿满剩余宽度
      for (const cls of ['min-w-0', 'flex-1', 'truncate']) expect(name.className).toContain(cls);
      expect(name).toHaveAttribute('title', ws.name);
      expect(name).toHaveTextContent(ws.name);
      // 右侧让位从 128px 收到 40px（一个 28px 触发器 + 边距）
      expect(name.parentElement?.className).toContain('pr-10');
      expect(name.parentElement?.className).not.toContain('pr-32');
      // 路径整行截断，完整路径由 title 兜住
      const path = screen.getByTestId(`workspace-card-path-${id}`);
      expect(path.className).toContain('truncate');
      expect(path).toHaveAttribute('title', ws.path);
    }
  });

  it('置顶菜单项是开关项：未置顶「置顶」，点后「取消置顶」并带强调色；卡面同步出徽标', async () => {
    mockBase([wsA, wsB]);
    renderList();
    const row = await screen.findByTestId('workspace-row-b2');

    await openCardMenu('b2');
    const pin = within(row).getByTestId('workspace-pin-b2');

    expect(pin).toHaveTextContent('置顶');
    expect(pin).toHaveAttribute('role', 'menuitemcheckbox');
    expect(pin).toHaveAttribute('aria-checked', 'false');
    expect(pin.className).toContain('text-ink-2');
    expect(within(row).queryByTestId('workspace-pinned-badge-b2')).toBeNull();

    await userEvent.click(pin);

    // 动作后菜单收起，置顶态改由卡面徽标呈现
    await waitFor(() => expect(within(row).getByTestId('workspace-pinned-badge-b2')).toBeInTheDocument());
    await openCardMenu('b2');
    const pinnedItem = within(row).getByTestId('workspace-pin-b2');
    expect(pinnedItem).toHaveTextContent('取消置顶');
    expect(pinnedItem).toHaveAttribute('aria-checked', 'true');
    expect(pinnedItem.className).toContain('text-accent');
    // 与 上移/下移 同一套菜单项尺寸与 hover
    const up = within(row).getByTestId('workspace-move-up-b2');
    for (const cls of ['flex', 'min-h-7', 'rounded-none', 'text-xs']) {
      expect(pinnedItem.className).toContain(cls);
      expect(up.className).toContain(cls);
    }
    expect(up.className).toContain('hover:bg-accent-soft');
  });

  it('抽屉内没有 emoji 字符（置顶按钮不再是 📌）', async () => {
    mockBase([wsA, wsB]);
    renderList();
    await screen.findByTestId('workspace-row-a1');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toContain('📌');
  });
});
