/**
 * S2c：右侧滑出面板（drawer 两态）——行为断言，不依赖真实浏览器。
 *
 * 覆盖：
 * - 打开 `navStore.drawer` → 面板出现、标题正确、内容按 drawer 切换（accounts / settings）；
 * - 宽屏（≥1280）`data-mode='squeeze'`，窄屏 `data-mode='overlay'` 且**锁 body 滚动**、有遮罩；
 * - Escape 关闭、点遮罩关闭都回到 `drawer=null`；关闭后不残留 body 滚动锁。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNavStore } from '../state/navStore';
import { DrawerPanel, DRAWER_SQUEEZE_MIN_WIDTH } from '../components/drawer/DrawerPanel';

/** 让 matchMedia 与 innerWidth 按给定宽度工作（jsdom 没有真实视口） */
function stubViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const matches = min ? width >= Number(min[1]) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

const renderDrawer = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DrawerPanel />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  act(() => useNavStore.setState({ drawer: null }));
  document.body.style.overflow = '';
});

afterEach(() => {
  act(() => useNavStore.setState({ drawer: null }));
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('drawer 两态', () => {
  it('宽屏挤压：data-mode=squeeze，无遮罩、不锁 body 滚动', () => {
    stubViewport(DRAWER_SQUEEZE_MIN_WIDTH);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));
    const panel = screen.getByTestId('drawer-panel');
    expect(panel.getAttribute('data-mode')).toBe('squeeze');
    expect(panel.getAttribute('data-drawer')).toBe('accounts');
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('账号管理');
    expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('中屏 800px：仍是挤压态（本次改动核心，阈值 768）', () => {
    stubViewport(800);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));
    const panel = screen.getByTestId('drawer-panel');
    expect(panel.getAttribute('data-mode')).toBe('squeeze');
    expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    // 宽度单点 400，关闭后归零（主区不留空槽）
    expect(panel.style.width).toBe('400px');
    act(() => useNavStore.getState().closeDrawer());
    expect(screen.getByTestId('drawer-panel').style.width).toBe('0px');
  });
  it('宽屏 ≥920：贴左栏右边缘（left = 8），宽度放宽到 720，不再挤压主区', () => {
    stubViewport(1440);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));
    const panel = screen.getByTestId('drawer-panel');
    expect(panel.getAttribute('data-mode')).toBe('anchored');
    // 独立渲染无左栏时以内容区左缘为锚点（= 相对定位容器的 8px）
    expect(panel.style.left).toBe('8px');
    expect(panel.style.width).toBe('720px');
    expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('窄屏覆盖：data-mode=overlay、有遮罩、锁 body 滚动，关闭后解锁', () => {
    stubViewport(375);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('settings'));
    const panel = screen.getByTestId('drawer-panel');
    expect(panel.getAttribute('data-mode')).toBe('overlay');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('drawer-backdrop')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(useNavStore.getState().drawer).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('Escape 与遮罩点击都能关闭；关闭态面板仍挂 DOM 但 aria-hidden 且不可交互', () => {
    stubViewport(375);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useNavStore.getState().drawer).toBeNull();
    const panel = screen.getByTestId('drawer-panel');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.className).toContain('pointer-events-none');

    act(() => useNavStore.getState().openDrawer('settings'));
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(useNavStore.getState().drawer).toBeNull();
  });

  it('切换 drawer 只换内容，不影响两态判定', () => {
    stubViewport(DRAWER_SQUEEZE_MIN_WIDTH);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));
    expect(useNavStore.getState().drawer).toBe('accounts');
    act(() => useNavStore.getState().openDrawer('settings'));
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('设置');
    expect(screen.getByTestId('drawer-panel').getAttribute('data-mode')).toBe('squeeze');
  });
});

describe('点外部关闭（DRAWER-DISMISS）', () => {
  const renderWithTrigger = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <button
          type="button"
          data-testid="drawer-trigger"
          onClick={() => useNavStore.getState().toggleDrawer('accounts')}
        >
          账号
        </button>
        <DrawerPanel />
      </QueryClientProvider>,
    );
  };

  it('anchored 模式（≥920px）点击面板外任意区域关闭', () => {
    stubViewport(1440);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));
    expect(useNavStore.getState().drawer).toBe('accounts');

    fireEvent.pointerDown(document.body);
    expect(useNavStore.getState().drawer).toBeNull();
  });

  it('点击面板内部（含滚动区/内嵌确认框）不关闭', () => {
    stubViewport(1440);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));

    fireEvent.pointerDown(screen.getByTestId('drawer-body'));
    expect(useNavStore.getState().drawer).toBe('accounts');

    fireEvent.pointerDown(screen.getByTestId('drawer-panel'));
    expect(useNavStore.getState().drawer).toBe('accounts');
  });

  it('点击打开它的触发按钮不会先关再开', () => {
    stubViewport(1440);
    renderWithTrigger();
    const trigger = screen.getByTestId('drawer-trigger');

    trigger.focus();
    fireEvent.click(trigger);
    expect(useNavStore.getState().drawer).toBe('accounts');

    // 触发按钮上的 pointerdown 被排除，不抢先关闭（否则随后的 onClick 会再打开 → 闪一下）
    fireEvent.pointerDown(trigger);
    expect(useNavStore.getState().drawer).toBe('accounts');

    fireEvent.click(trigger);
    expect(useNavStore.getState().drawer).toBeNull();
  });

  it('Esc 关闭并把焦点归还打开它的按钮', () => {
    stubViewport(1440);
    renderWithTrigger();
    const trigger = screen.getByTestId('drawer-trigger');

    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useNavStore.getState().drawer).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('存在 portal 出去的内层模态层时，点击外部不连带关闭外层抽屉', () => {
    stubViewport(1440);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('accounts'));

    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      fireEvent.pointerDown(modal);
      expect(useNavStore.getState().drawer).toBe('accounts');
      fireEvent.pointerDown(document.body);
      expect(useNavStore.getState().drawer).toBe('accounts');
    } finally {
      modal.remove();
    }
  });

  it('窄屏遮罩只走既有 click 一条关闭路径，不重复关闭', () => {
    stubViewport(375);
    renderDrawer();
    act(() => useNavStore.getState().openDrawer('settings'));
    const backdrop = screen.getByTestId('drawer-backdrop');

    // 遮罩自身的 pointerdown 不关闭（否则同一击会先 pointerdown 关一次、再 click 关一次）
    fireEvent.pointerDown(backdrop);
    expect(useNavStore.getState().drawer).toBe('settings');

    fireEvent.click(backdrop);
    expect(useNavStore.getState().drawer).toBeNull();
  });
});
