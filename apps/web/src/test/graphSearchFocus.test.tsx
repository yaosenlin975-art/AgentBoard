/**
 * KB-GRAPH-3：搜索命中、「只看命中」、聚焦 N 跳（含跳数上限保护）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import {
  MAX_FOCUS_HOPS,
  filterGraphForView,
  highlightAround,
  neighborsWithin,
  searchMatches,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
} from '../lib/knowledgeGraph';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import { server } from './server';

const node = (id: string, title = id): GraphNode => ({
  id,
  scope: 'workspace',
  workspace_id: 'ws-1',
  title,
  revision: 1,
  degree: 1,
});
const edge = (source: string, target: string): GraphEdge => ({
  source,
  target,
  kind: 'keyword',
  weight: 1,
  key: `${source}->${target}`,
});

// a—b—c—d 链 + 孤立点 z
const chain: GraphPayload = {
  nodes: [node('a', '知识 A'), node('b', '知识 B'), node('c', '知识 C'), node('d', '知识 D'), node('z', '孤立 Z')],
  edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
  node_total: 5,
  edge_total: 3,
  truncated: false,
  pages_truncated: false,
  truncated_reason: null,
};

describe('neighborsWithin（聚焦 N 跳）', () => {
  it('1 跳 = 自身 + 直接邻居', () => {
    expect([...neighborsWithin(chain, 'b', 1)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('2 跳 = 再外一层', () => {
    expect([...neighborsWithin(chain, 'b', 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('跳数上限保护：>2 夹到 2，0/负数夹到 1', () => {
    expect(MAX_FOCUS_HOPS).toBe(2);
    expect([...neighborsWithin(chain, 'b', 5)].sort()).toEqual([...neighborsWithin(chain, 'b', 2)].sort());
    expect([...neighborsWithin(chain, 'b', 0)].sort()).toEqual([...neighborsWithin(chain, 'b', 1)].sort());
    expect([...neighborsWithin(chain, 'b', -3)].sort()).toEqual([...neighborsWithin(chain, 'b', 1)].sort());
  });

  it('孤立节点只有自己', () => {
    expect([...neighborsWithin(chain, 'z', 2)]).toEqual(['z']);
  });
});

describe('highlightAround 支持跳数', () => {
  it('1 跳只点亮相邻边，2 跳点亮更远的边', () => {
    const one = highlightAround(chain, 'b', 1);
    expect([...one.edges].sort()).toEqual(['a->b', 'b->c']);
    const two = highlightAround(chain, 'b', 2);
    expect([...two.edges].sort()).toEqual(['a->b', 'b->c', 'c->d']);
  });
});

describe('searchMatches', () => {
  it('大小写不敏感、去首尾空白；空串不命中', () => {
    const nodes = [node('a', 'Handoff UI'), node('b', 'handoff server'), node('c', '其他')];
    expect([...searchMatches(nodes, 'HANDOFF')].sort()).toEqual(['a', 'b']);
    expect([...searchMatches(nodes, '  handoff ')].sort()).toEqual(['a', 'b']);
    expect(searchMatches(nodes, '   ').size).toBe(0);
    expect(searchMatches(nodes, '').size).toBe(0);
  });
});

describe('filterGraphForView', () => {
  it('只看命中：只保留命中节点与它们之间的边，并给出隐藏计数', () => {
    const matches = new Set(['a', 'b']);
    const result = filterGraphForView(chain, { focusId: null, hops: 1, matches, onlyMatches: true });
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.hiddenNodes).toBe(3);
    expect(result.hiddenEdges).toBe(2);
  });

  it('聚焦 + 只看命中取交集', () => {
    const result = filterGraphForView(chain, { focusId: 'b', hops: 2, matches: new Set(['c']), onlyMatches: true });
    expect(result.graph.nodes.map((n) => n.id)).toEqual(['c']);
    expect(result.graph.edges).toHaveLength(0);
  });

  it('都未启用时原样返回', () => {
    const result = filterGraphForView(chain, { focusId: null, hops: 1, matches: new Set<string>(), onlyMatches: false });
    expect(result.graph).toBe(chain);
    expect(result.hiddenNodes).toBe(0);
  });
});

function renderGraph() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('KnowledgeGraph 搜索与聚焦（KB-GRAPH-3）', () => {
  beforeEach(() => {
    server.use(http.get('/api/knowledge/graph', () => HttpResponse.json(chain)));
  });

  it('搜索高亮命中计数；「只看命中」筛掉非命中节点', async () => {
    renderGraph();
    const root = await screen.findByTestId('knowledge-graph');
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('5'));

    await userEvent.type(screen.getByTestId('graph-search'), '知识 B');
    await waitFor(() => expect(root.getAttribute('data-matches')).toBe('1'));
    // 只看命中未勾选 → 节点数不变
    expect(root.getAttribute('data-visible-nodes')).toBe('5');

    await userEvent.click(screen.getByTestId('graph-only-matches'));
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('1'));
    expect(root.getAttribute('data-visible-edges')).toBe('0');
  });

  it('清空搜索后「只看命中」失效（不筛节点）', async () => {
    renderGraph();
    const root = await screen.findByTestId('knowledge-graph');
    await userEvent.type(screen.getByTestId('graph-search'), '知识');
    await waitFor(() => expect(root.getAttribute('data-matches')).toBe('4'));
    await userEvent.click(screen.getByTestId('graph-only-matches'));
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('4'));
    await userEvent.clear(screen.getByTestId('graph-search'));
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('5'));
  });

  it('聚焦 1 跳 → 3 个节点，切 2 跳 → 4 个，回全图 → 5 个', async () => {
    renderGraph();
    const root = await screen.findByTestId('knowledge-graph');
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('5'));

    await userEvent.click(screen.getByTestId('graph-focus-b'));
    await waitFor(() => expect(root.getAttribute('data-focus-id')).toBe('b'));
    expect(root.getAttribute('data-visible-nodes')).toBe('3');
    expect(root.getAttribute('data-focus-hops')).toBe('1');
    expect(screen.getByTestId('graph-focus-bar')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('graph-focus-hops-2'));
    await waitFor(() => expect(root.getAttribute('data-visible-nodes')).toBe('4'));

    await userEvent.click(screen.getByTestId('graph-focus-exit'));
    await waitFor(() => expect(root.getAttribute('data-focus-id')).toBe(''));
    expect(root.getAttribute('data-visible-nodes')).toBe('5');
  });
});
