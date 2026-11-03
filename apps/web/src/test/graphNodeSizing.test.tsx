/**
 * KB-GRAPH-1：节点半径按 degree 缩放 + 标签阈值隐藏。
 * 纯函数在 lib/knowledgeGraph.ts；组件侧断言 data-scale / data-labels-visible / data-radius。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import {
  LABEL_SCALE_THRESHOLD,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
  labelText,
  labelsVisible,
  nodeRadius,
} from '../lib/knowledgeGraph';
import { ZOOM_MAX, ZOOM_MIN, clampZoom, textAlpha } from '../lib/graphVisualFormulas';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import { server } from './server';

describe('nodeRadius（KB-GRAPH-1）', () => {
  it('degree 越大半径越大、单调不减、夹在上下限内', () => {
    const degrees = [0, 1, 2, 3, 5, 8, 13, 40, 200];
    const radii = degrees.map((d) => nodeRadius(d));
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i]!).toBeGreaterThanOrEqual(radii[i - 1]!);
    }
    for (const r of radii) {
      expect(r).toBeGreaterThanOrEqual(NODE_RADIUS_MIN);
      expect(r).toBeLessThanOrEqual(NODE_RADIUS_MAX);
    }
    expect(nodeRadius(0)).toBe(NODE_RADIUS_MIN);
    expect(nodeRadius(1)).toBeGreaterThan(nodeRadius(0));
    expect(nodeRadius(1000)).toBe(NODE_RADIUS_MAX);
  });

  it('非法输入（负数 / NaN）按下限处理，不产生 NaN 半径', () => {
    expect(nodeRadius(-3)).toBe(NODE_RADIUS_MIN);
    expect(nodeRadius(Number.NaN)).toBe(NODE_RADIUS_MIN);
    expect(Number.isNaN(nodeRadius(Number.NaN))).toBe(false);
  });

  it('标签阈值：低于 0.8 隐藏，等于/高于显示', () => {
    expect(labelsVisible(0.5)).toBe(false);
    expect(labelsVisible(LABEL_SCALE_THRESHOLD - 0.01)).toBe(false);
    expect(labelsVisible(LABEL_SCALE_THRESHOLD)).toBe(true);
    expect(labelsVisible(2)).toBe(true);
  });

  it('标签文字超长截断且不超过上限', () => {
    expect(labelText('短标题')).toBe('短标题');
    const long = labelText('一个非常非常非常长的知识页标题', 12);
    expect(long.length).toBeLessThanOrEqual(12);
    expect(long.endsWith('…')).toBe(true);
  });
});

// degree 由边计算：hub 连 3 条边 → degree 3；leaf 连 1 条 → degree 1；isolated 无边 → degree 0
const graphPayload = {
  nodes: [
    { id: 'isolated', scope: 'workspace', workspace_id: 'ws-1', title: '孤立页', revision: 1, degree: 0 },
    { id: 'leaf', scope: 'workspace', workspace_id: 'ws-1', title: '叶子页', revision: 1, degree: 1 },
    { id: 'hub', scope: 'common', workspace_id: null, title: '枢纽页', revision: 1, degree: 3 },
    { id: 'x1', scope: 'workspace', workspace_id: 'ws-1', title: 'X1', revision: 1, degree: 1 },
    { id: 'x2', scope: 'workspace', workspace_id: 'ws-1', title: 'X2', revision: 1, degree: 1 },
  ],
  edges: [
    { id: 'e1', source: 'hub', target: 'leaf', kind: 'keyword', weight: 2 },
    { id: 'e2', source: 'hub', target: 'x1', kind: 'keyword', weight: 2 },
    { id: 'e3', source: 'hub', target: 'x2', kind: 'source', weight: 1 },
  ],
  node_total: 5,
  edge_total: 3,
  truncated_reason: null,
};

function renderGraph() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('KnowledgeGraph 半径与标签渲染（KB-GRAPH-1）', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/knowledge/graph', () => HttpResponse.json(graphPayload)),
    );
  });

  it('节点半径随 degree 变化并写进 DOM（度 0 < 度 2 < 度 6）', async () => {
    renderGraph();
    const isolated = await screen.findByTestId('graph-node-isolated');
    const leaf = screen.getByTestId('graph-node-leaf');
    const hub = screen.getByTestId('graph-node-hub');
    // degree 由边推导：0 / 1 / 3
    expect(isolated.getAttribute('data-degree')).toBe('0');
    expect(leaf.getAttribute('data-degree')).toBe('1');
    expect(hub.getAttribute('data-degree')).toBe('3');
    const r0 = Number(isolated.getAttribute('data-radius'));
    const r1 = Number(leaf.getAttribute('data-radius'));
    const r3 = Number(hub.getAttribute('data-radius'));
    expect(r0).toBe(nodeRadius(0));
    expect(r1).toBe(nodeRadius(1));
    expect(r3).toBe(nodeRadius(3));
    expect(r0).toBe(NODE_RADIUS_MIN);
    expect(r1).toBeGreaterThan(r0);
    expect(r3).toBeGreaterThan(r1);
  });

  it('相机由渲染层自持：无 WebGL 时停在缺省 1，缩放按钮不改组件层状态（KB-GRAPH-P1）', async () => {
    renderGraph();
    const root = await screen.findByTestId('knowledge-graph');
    await waitFor(() => expect(root.getAttribute('data-scale')).toBe('1'));
    expect(root.getAttribute('data-labels-visible')).toBe('true');
    // jsdom 无 WebGL → 前置检测直接降级，没有渲染器接管相机
    await waitFor(() => expect(root.getAttribute('data-renderer')).toBe('no-webgl'));
    await userEvent.click(screen.getByTestId('graph-zoom-out'));
    await userEvent.click(screen.getByTestId('graph-zoom-out'));
    // 缩放不再由组件层维护（旧 canvas 实现的 data-scale 会被按钮改掉，这条就是回归锁）
    expect(root.getAttribute('data-scale')).toBe('1');
  });

  it('缩放上下限与标签淡出改由文档公式决定（1/128–8、log2 阈值）', async () => {
    // 旧实现自持相机并夹在 0.3–3、标签阈值 0.8；文档 A6 是 clampZoom 1/128–8 + textAlpha=log2(scale)+1
    expect(clampZoom(0.0001)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(textAlpha(1)).toBe(1);
    expect(textAlpha(0.5)).toBe(0);
    expect(ZOOM_MIN).toBe(1 / 128);
    expect(ZOOM_MAX).toBe(8);
  });
});


