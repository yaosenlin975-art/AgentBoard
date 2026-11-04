/**
 * GRAPH-INIT-FAIL：星图渲染器初始化失败的可诊断化 / 尺寸守卫 / 有限重试。
 *
 * 三条路径分别覆盖：
 * - create 抛错 → data-graph-fallback="create-failed" + data-graph-error 非空 + 兜底文案带原因；
 * - 容器零尺寸 → "no-size"（不是 failed），尺寸恢复后自动重试转 "webgl"；
 * - 连续失败 → 自动重试 1 次后落兜底，手动「重试」最多再加 2 次（合计 3 次）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { server } from './server';

const h = vi.hoisted(() => ({
  createCalls: 0,
  mode: 'ok' as 'ok' | 'throw',
  handle: {
    host: null as unknown as HTMLElement,
    update: () => undefined,
    zoomBy: () => undefined,
    resetView: () => undefined,
    refreshColors: () => undefined,
    changed: () => undefined,
    snapshot: () => ({ nodeCount: 0, createdEdges: 0 }),
    destroy: () => undefined,
  },
}));

vi.mock('../components/knowledge/pixiGraph', () => ({
  createPixiGraph: (host: HTMLElement) => {
    h.createCalls += 1;
    if (h.mode === 'throw') throw new Error('WebGL context creation failed: 模拟上下文耗尽');
    h.handle.host = host;
    return h.handle;
  },
}));

const { KnowledgeGraph } = await import('../components/knowledge/KnowledgeGraph');

const page = (id: string, title: string) => ({
  id, scope: 'workspace', workspace_id: 'A', slug: id, title, revision: 1, status: 'active',
  expires_at: null, sources: [], evidence: [], created_at: 1, updated_at: 1,
});

function mockGraph(): void {
  server.use(
    http.get('/api/knowledge/graph', () =>
      HttpResponse.json({
        nodes: [
          { id: 'p1', title: '缓存策略', scope: 'workspace', category: 'design', degree: 1 },
          { id: 'p2', title: '缓存失效', scope: 'workspace', category: 'solved', degree: 1 },
        ],
        edges: [{ key: 'file:x', source: 'p1', target: 'p2', kind: 'source', weight: 1 }],
      }),
    ),
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [page('p1', '缓存策略'), page('p2', '缓存失效')], next_offset: null })),
  );
}

function mount(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <KnowledgeGraph workspaceId="A" scope="both" onSelect={() => undefined} />
    </QueryClientProvider>,
  );
}

function setSize(width: number, height: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
}

beforeEach(() => {
  h.createCalls = 0;
  h.mode = 'ok';
  mockGraph();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as WebGL2RenderingContext);
  setSize(900, 520);
});

describe('初始化失败可诊断（GRAPH-INIT-FAIL）', () => {
  it('createPixiGraph 抛错 → create-failed + data-graph-error 带真实原因 + 兜底列出节点', async () => {
    h.mode = 'throw';
    mount();
    const block = await waitFor(() => {
      const found = document.querySelector('[data-graph-fallback="create-failed"]');
      if (found === null) throw new Error('还没落到 create-failed');
      return found as HTMLElement;
    }, { timeout: 5000 });
    expect(block.getAttribute('data-graph-error')).toContain('create-failed');
    expect(block.getAttribute('data-graph-error')).toContain('模拟上下文耗尽');
    expect(block).toHaveTextContent('星图渲染器初始化失败，已切换到列表视图');
    expect(await screen.findByTestId('graph-error-detail')).toHaveTextContent('模拟上下文耗尽');
    // 兜底列表仍可点
    expect(screen.getByTestId('graph-fallback-p1')).toHaveTextContent('缓存策略');
    // 自动重试 1 次（首次 + 自动重试 = 2 次 create 调用）
    await waitFor(() => expect(h.createCalls).toBe(2));
  });

  it('手动重试最多再加 2 次（合计 3 次），到上限后按钮禁用', async () => {
    h.mode = 'throw';
    mount();
    await waitFor(() => expect(h.createCalls).toBe(2), { timeout: 5000 });
    const retry = await screen.findByTestId('graph-retry');
    fireEvent.click(retry);
    await waitFor(() => expect(h.createCalls).toBe(3));
    await waitFor(() => expect(screen.getByTestId('graph-retry')).toBeDisabled());
    // 再点也不会超过上限
    fireEvent.click(screen.getByTestId('graph-retry'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.createCalls).toBe(3);
  });
});

describe('尺寸守卫（GRAPH-INIT-FAIL）', () => {
  it('容器零尺寸 → no-size（不是 create-failed），尺寸恢复后自动重试并转 webgl', async () => {
    setSize(0, 0);
    mount();
    const block = await waitFor(() => {
      const found = document.querySelector('[data-graph-fallback="no-size"]');
      if (found === null) throw new Error('还没落到 no-size');
      return found as HTMLElement;
    }, { timeout: 5000 });
    expect(block).toHaveTextContent('星图区域暂时没有尺寸');
    // 零尺寸时不应调用 PIXI 工厂
    expect(h.createCalls).toBe(0);

    // 尺寸恢复：ResizeObserver 触发自动重试
    setSize(900, 520);
    const graph = screen.getByTestId('knowledge-graph');
    fireEvent(window, new Event('resize'));
    // 直接触发 RO：jsdom 没有 RO 实现时用尺寸变化后的重挂载兜底
    await waitFor(() => {
      expect(graph.getAttribute('data-renderer')).toBe('webgl');
    }, { timeout: 8000 });
    expect(h.createCalls).toBeGreaterThan(0);
  });
});
