/**
 * WS-DRAWER-01：工作空间抽屉的搜索框、置顶按钮（↑↓ 左侧）、卡片操作行与统计格不重叠的结构断言。
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

    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    await waitFor(() => expect(sent).toEqual([['c3', 'a1', 'b2']]));
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-c3', 'workspace-row-a1', 'workspace-row-b2']));
    expect(screen.getByTestId('workspace-pin-c3')).toHaveAttribute('aria-pressed', 'true');
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
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-pressed', 'true');
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
    expect(within(rowC).getByTestId('workspace-pin-c3')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    await waitFor(() => expect(sent).toEqual([['a1', 'b2', 'c3']]));
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']));
    expect(screen.getByTestId('workspace-pin-c3')).toHaveAttribute('aria-pressed', 'false');
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

    await userEvent.click(within(rowC).getByTestId('workspace-pin-c3'));

    expect(await screen.findByTestId('workspace-order-notice')).toHaveTextContent('写库失败');
    await waitFor(() => expect(rowIds()).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']));
    expect(screen.getByTestId('workspace-pin-c3')).toHaveAttribute('aria-pressed', 'false');
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

describe('WorkspaceCard 布局（操作行在卡片内、防重叠）', () => {
  it('置顶 · 上移 · 下移 三个按钮都被卡片容器包裹，且在统计行下方、不在统计格内', async () => {
    mockBase([wsA]);
    renderList();
    const row = await screen.findByTestId('workspace-row-a1');

    const actions = within(row).getByTestId('workspace-card-actions-a1');
    const pin = within(actions).getByTestId('workspace-pin-a1');
    const up = within(actions).getByTestId('workspace-move-up-a1');
    const down = within(actions).getByTestId('workspace-move-down-a1');
    const card = within(row).getByTestId('workspace-card-a1').closest('[data-workspace-card]');

    // 卡片容器存在，三个按钮的父链都落在它里面（不是卡片外的兄弟节点）
    expect(card).not.toBeNull();
    expect(card).toBe(row.querySelector('[data-workspace-card="a1"]'));
    for (const button of [pin, up, down]) {
      expect(button.closest('[data-workspace-card]')).toBe(card);
      expect(card?.contains(button)).toBe(true);
    }
    // 操作行是普通流布局，不靠 absolute 浮出卡片
    expect(actions.className).not.toContain('absolute');
    // 操作行排在卡片内容按钮之后（统计行下方）
    const content = within(row).getByTestId('workspace-card-a1');
    expect(content.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 置顶按钮在 ↑ 左侧，三者同间距（同一 flex 容器的 gap-1）
    expect(pin.compareDocumentPosition(up) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(up.compareDocumentPosition(down) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.className).toContain('gap-1');

    // 操作行与统计格互不包含（不同行 → 不会压在「已关闭」上）
    const closed = within(row).getByTestId('stat-已关闭');
    expect(closed.contains(up)).toBe(false);
    expect(actions.contains(closed)).toBe(false);

    // 统计文案 nowrap + 卡片容器最小高度，窄宽度不折行挤压
    expect(within(closed).getByText('已关闭').className).toContain('whitespace-nowrap');
    expect(card?.className).toContain('min-h-[6.5rem]');
  });

  it('置顶按钮是文本胶囊：未置顶「置顶」，按下后「已置顶」且有填充底色类名', async () => {
    mockBase([wsA, wsB]);
    renderList();
    const row = await screen.findByTestId('workspace-row-b2');
    const pin = within(row).getByTestId('workspace-pin-b2');

    expect(pin).toHaveTextContent('置顶');
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin.className).toContain('border-neutral-300');
    expect(pin.className).not.toContain('bg-blue-600');

    await userEvent.click(pin);

    await waitFor(() => expect(pin).toHaveTextContent('已置顶'));
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    expect(pin.className).toContain('bg-blue-600');
    expect(pin.className).toContain('text-white');
    // 与 ↑↓ 同一套尺寸/圆角/hover
    const up = within(row).getByTestId('workspace-move-up-b2');
    for (const cls of ['inline-flex', 'h-5', 'rounded', 'text-[11px]']) {
      expect(pin.className).toContain(cls);
      expect(up.className).toContain(cls);
    }
    expect(up.className).toContain('hover:bg-neutral-100');
    expect(pin.className).not.toContain('hover:bg-neutral-100');
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
