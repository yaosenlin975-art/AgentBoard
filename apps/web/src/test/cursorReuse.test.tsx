/**
 * CURSOR-REUSE：星图舞台与工作区卡拖拽把手必须复用 lib/cursor 的双色光标
 * （原生 grab 在 Windows 是合成的白手掌位图、无描边，白底不可见）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { GRAB_CURSOR } from '../lib/cursor';
import { WorkspaceCard } from '../components/workspace/WorkspaceCard';
import { useAppStore } from '../state/appStore';
import { server } from './server';

// PIXI 在 jsdom 跑不起来：与既有星图测试同款做法，mock 掉 pixiGraph 模块
vi.mock('../components/knowledge/pixiGraph', () => ({
  createPixiGraph: () => ({
    update: vi.fn(),
    zoomBy: vi.fn(),
    resetView: vi.fn(),
    refreshColors: vi.fn(),
    changed: vi.fn(),
    snapshot: () => ({}),
    destroy: vi.fn(),
  }),
}));

const { KnowledgeGraph } = await import('../components/knowledge/KnowledgeGraph');

const workspace: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function withClient(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  server.use(
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/knowledge/graph', () =>
      HttpResponse.json({ nodes: [{ id: 'p1', title: '缓存策略', scope: 'workspace', workspace_id: 'ws-1', revision: 1, degree: 1 }, { id: 'p2', title: '缓存失效', scope: 'workspace', workspace_id: 'ws-1', revision: 1, degree: 1 }], edges: [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'file:x' }], truncated: false, truncated_reason: null, pages_truncated: false, node_total: 2, edge_total: 1 }),
    ),
  );
});

describe('双色拖拽光标复用（CURSOR-REUSE）', () => {
  it('星图舞台：computed cursor 是 data-URI SVG（含深描边），不再是原生 cursor-grab', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as WebGL2RenderingContext);
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const stage = await screen.findByTestId('knowledge-graph-stage');
    expect(stage.style.cursor).toContain('data:image/svg+xml');
    expect(stage.style.cursor).toContain('%23111111');
    expect(stage.className).not.toContain('cursor-grab');
  });

  it('工作区卡拖拽把手：同款双色光标；禁用/置顶按钮语义不受影响', async () => {
    render(withClient(
      <DndContext>
        <SortableContext items={[workspace.id]}>
          <WorkspaceCard workspace={workspace} onMoveUp={() => undefined} onMoveDown={() => undefined} onTogglePin={() => undefined} pinned={false} />
        </SortableContext>
      </DndContext>,
    ));
    const handle = await screen.findByTestId('workspace-drag-ws-1');
    await waitFor(() => expect(handle.style.cursor).toBe(GRAB_CURSOR));
    expect(handle.style.cursor).toContain('%23111111');
    expect(handle.className).not.toContain('cursor-grab');
    // 置顶按钮仍是普通按钮语义（不被光标改动波及）
    expect(await screen.findByTestId('workspace-pin-ws-1')).toBeInTheDocument();
  });
});
