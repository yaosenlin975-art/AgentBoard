/**
 * R4-B1 验收测试：搜索框连打 8 个字符期间 `layoutGraph` 的调用次数。
 *
 * 计数方式：`vi.mock` 整个 `lib/knowledgeGraph` 的 `layoutGraph`（保留其它导出的真实实现），
 * 这样组件内部具名导入拿到的一定是被替换的版本 —— 比 `vi.spyOn` 可靠（ESM live binding
 * 在 vitest 下对「组件从同模块具名 import」不保证可覆盖）。
 *
 * 修前（`normalizeGraph` 在渲染体里）预期约 8 次，修后应为 1 次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { GraphEdge, GraphNode, GraphPayload } from '../lib/knowledgeGraph';

const layoutCalls: { nodes: number; edges: number }[] = [];

vi.mock('../lib/knowledgeGraph', async () => {
  const actual = await vi.importActual<typeof import('../lib/knowledgeGraph')>('../lib/knowledgeGraph');
  return {
    ...actual,
    layoutGraph: (nodes: GraphNode[], edges: GraphEdge[], options?: unknown) => {
      layoutCalls.push({ nodes: nodes.length, edges: edges.length });
      return actual.layoutGraph(nodes, edges, options as never);
    },
  };
});

const { KnowledgeGraph } = await import('../components/knowledge/KnowledgeGraph');

function node(id: string, title: string): GraphNode {
  return { id, title, scope: 'workspace', workspace_id: 'A', revision: 1, degree: 1 };
}

function remoteGraph(nodes: GraphNode[], edges: GraphPayload['edges']): GraphPayload {
  return {
    nodes,
    edges,
    truncated: false,
    truncated_reason: null,
    pages_truncated: false,
    node_total: nodes.length,
    edge_total: edges.length,
    page_total: nodes.length,
    pages_loaded: nodes.length,
  };
}

function mountGraph(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeGraph workspaceId="A" scope="both" onSelect={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  layoutCalls.length = 0;
  // jsdom 未实现 canvas 2d：返回 null，组件跳过绘制（DOM 统计与节点列表仍工作）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R4-B1 布局调用次数', () => {
  it('搜索框连打 8 个字符期间 layoutGraph 只跑 1 次', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(
          remoteGraph(
            [node('p1', '缓存策略'), node('p2', '缓存失效'), node('p3', '缓存穿透')],
            [
              { source: 'p1', target: 'p2', kind: 'source', weight: 1, key: 'k1' },
              { source: 'p2', target: 'p3', kind: 'source', weight: 1, key: 'k2' },
            ],
          ),
        ),
      ),
    );
    mountGraph();
    await screen.findByTestId('knowledge-graph-stats');
    await waitFor(() => expect(layoutCalls.length).toBe(1));

    const input = screen.getByTestId('graph-search') as HTMLInputElement;
    let typed = '';
    for (const ch of '缓存策略啊哈呀') {
      typed += ch;
      fireEvent.change(input, { target: { value: typed } });
      // 让 React 提交 + 可能的 effect 跑完
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    // 该数字会随字符数增长（每个字符一次布局）
    // 修前实测 9（初始取数 1 + 连打 8 个字符各 1）；修后稳定在 1
    expect(layoutCalls.length).toBe(1);
  });

  it('对照：改了会影响 shown 的开关时仍然重新布局（memo 不能把真实变化也吃掉）', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(
          remoteGraph(
            [node('p1', 'A'), node('p2', 'B'), node('p3', 'C')],
            [
              { source: 'p1', target: 'p2', kind: 'source', weight: 1, key: 'k1' },
              { source: 'p2', target: 'p3', kind: 'source', weight: 1, key: 'k2' },
            ],
          ),
        ),
      ),
    );
    mountGraph();
    await screen.findByTestId('knowledge-graph-stats');
    await waitFor(() => expect(layoutCalls.length).toBe(1));

    // 取消「来源」边类型 → applyEdgeKinds 结果变化 → 必须重新布局
    fireEvent.click(screen.getByTestId('graph-edge-source'));
    await waitFor(() => expect(layoutCalls.length).toBeGreaterThan(1));
  });
});

// msw server 来自 setup.ts 的全局 listen
import { server } from './server';
