/**
 * KB-GRAPH-P1 挂载契约：WebGL 前置检测、降级列表、数据映射。
 * PIXI 本体在 jsdom 里跑不起来，这里 mock 掉 `pixiGraph` 模块，只验「什么时候 import」与「传了什么数据」。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import type { PixiGraphData } from '../components/knowledge/pixiGraph';
import type { GraphNode, GraphPayload } from '../lib/knowledgeGraph';

interface MountRecord {
  host: HTMLElement;
  updates: PixiGraphData[];
  zoomBy: ReturnType<typeof vi.fn>;
  resetView: ReturnType<typeof vi.fn>;
  refreshColors: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const { mounts } = vi.hoisted(() => ({ mounts: [] as MountRecord[] }));

vi.mock('../components/knowledge/pixiGraph', () => ({
  createPixiGraph: (host: HTMLElement) => {
    const record: MountRecord = {
      host,
      updates: [],
      zoomBy: vi.fn(),
      resetView: vi.fn(),
      refreshColors: vi.fn(),
      destroy: vi.fn(),
    };
    mounts.push(record);
    return {
      host,
      update: (data: PixiGraphData) => record.updates.push(data),
      zoomBy: record.zoomBy,
      resetView: record.resetView,
      refreshColors: record.refreshColors,
      changed: vi.fn(),
      snapshot: () => ({}),
      destroy: record.destroy,
    };
  },
}));

const { KnowledgeGraph } = await import('../components/knowledge/KnowledgeGraph');

const node = (id: string, title: string, degree = 1): GraphNode => ({
  id,
  title,
  scope: 'workspace',
  workspace_id: 'A',
  revision: 1,
  degree,
});

const payload = (nodes: GraphNode[], edges: GraphPayload['edges']): GraphPayload => ({
  nodes,
  edges,
  truncated: false,
  truncated_reason: null,
  pages_truncated: false,
  node_total: nodes.length,
  edge_total: edges.length,
});

function mockGraph(): void {
  server.use(
    http.get('/api/knowledge/graph', () =>
      HttpResponse.json(
        payload(
          [node('p1', '缓存策略'), node('p2', '缓存失效')],
          [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'file:x' }],
        ),
      ),
    ),
  );
}

function mountGraph(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KnowledgeGraph workspaceId="A" scope="both" onSelect={onSelect} />
    </QueryClientProvider>,
  );
}

describe('星图 WebGL 前置检测与降级（KB-GRAPH-P1）', () => {
  beforeEach(() => {
    mounts.length = 0;
  });

  it('拿不到 WebGL context ⇒ 不 import PIXI，降级列表带 data-graph-fallback="no-webgl"', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as WebGL2RenderingContext);
    mockGraph();
    mountGraph();
    const fallback = await screen.findByTestId('knowledge-graph-stage');
    expect(fallback).toBeInTheDocument();
    const block = await waitFor(() => {
      const found = document.querySelector('[data-graph-fallback]');
      if (found === null) throw new Error('降级钩子还没出现');
      return found as HTMLElement;
    });
    expect(block.getAttribute('data-graph-fallback')).toBe('no-webgl');
    expect(block).toHaveTextContent('当前环境不支持 WebGL，已切换为列表视图');
    // 列表项可点（不是空白/纯报错）
    expect(screen.getByTestId('graph-fallback-p1')).toHaveTextContent('缓存策略');
    expect(screen.getByTestId('graph-fallback-p2')).toHaveTextContent('缓存失效');
    // 关键：没有调用 PIXI 工厂
    expect(mounts).toHaveLength(0);
  });

  it('有 WebGL ⇒ 挂载渲染层，并把映射后的节点/边/布局坐标传下去', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as WebGL2RenderingContext);
    mockGraph();
    const onSelect = vi.fn();
    mountGraph(onSelect);
    await waitFor(() => expect(mounts).toHaveLength(1));
    const record = mounts[0]!;
    await waitFor(() => expect(record.updates.length).toBeGreaterThan(0));
    const data = record.updates.at(-1)!;
    expect(data.nodes.map((item) => item.id).sort()).toEqual(['p1', 'p2']);
    // weight = 正向 ∪ 反向邻居数（getSize 的入参），不是服务端 degree
    expect(data.nodes.every((item) => item.weight === 1)).toBe(true);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]!.key).toBe('file:x');
    expect(data.positions.has('p1')).toBe(true);
    expect(data.positions.has('p2')).toBe(true);
    // 挂了 WebGL 就不该再出现降级钩子
    expect(document.querySelector('[data-graph-fallback]')).toBeNull();
    // 工具栏缩放/适应视图透传到渲染层
    fireEvent.click(screen.getByTestId('graph-zoom-in'));
    expect(record.zoomBy).toHaveBeenCalledWith(1.25);
    fireEvent.click(screen.getByTestId('graph-fit'));
    expect(record.resetView).toHaveBeenCalled();
  });

  it('数据变化只 update 不重建；卸载时销毁渲染器（避免 rAF/WebGL 上下文泄漏）', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as WebGL2RenderingContext);
    mockGraph();
    const view = mountGraph();
    await waitFor(() => expect(mounts).toHaveLength(1));
    const record = mounts[0]!;
    await waitFor(() => expect(record.updates.length).toBeGreaterThan(0));
    const before = record.updates.length;
    fireEvent.click(screen.getByTestId('graph-isolated'));
    await waitFor(() => expect(record.updates.length).toBeGreaterThan(before));
    expect(mounts).toHaveLength(1);
    expect(record.destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(record.destroy).toHaveBeenCalled();
  });
});
