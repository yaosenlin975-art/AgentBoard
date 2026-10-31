import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';

/** 惰性 WS 桩：App 挂载即 connectWs，测试环境不建立真实连接 */
class InertWebSocket {
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App 布局容器', () => {
  it('根容器固定视口高度且整体不滚动（h-screen overflow-hidden）', () => {
    vi.stubGlobal('WebSocket', InertWebSocket);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, unmount } = render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );

    const root = container.firstElementChild as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root!.className).toContain('h-screen');
    expect(root!.className).toContain('overflow-hidden');
    expect(root!.className).not.toContain('min-h-screen');

    // 左栏工作空间列表自身内部滚动
    const workspaceAside = root!.querySelector('aside');
    expect(workspaceAside?.className).toContain('overflow-y-auto');

    unmount();
  });
});
