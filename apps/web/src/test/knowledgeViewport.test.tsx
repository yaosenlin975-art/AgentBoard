/**
 * KB-GRAPH-H / KB-DETAIL-W 回归：视口自适应。
 *
 * jsdom 不做布局，所以断言「决定几何的声明」：
 * - 星图绘制区高度用 clamp(360px, calc(100dvh - 320px), 900px)，不再写死 480px；
 * - 详情正文用 max-w-[min(88ch,100%)] + mx-auto（自适应但保留可读上限并居中）。
 * 真实三档数值（1920/1440/1280 → 760/580/400px、中心偏移 0,0、每行 88 字符）由 CDP 实测保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const STAGE_HEIGHT = 'clamp(360px, calc(100dvh - 320px), 900px)';

function withClient(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const page = {
  id: 'p1',
  scope: 'workspace',
  workspace_id: 'ws-1',
  slug: 'graph-h',
  title: '视口自适应正文',
  body_md: '正文内容'.repeat(200),
  revision: 1,
  status: 'active',
  expires_at: null,
  sources: [],
  evidence: [],
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  server.use(
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [page], next_offset: null })),
    http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page)),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
    http.get('/api/knowledge/graph', () =>
      HttpResponse.json({
        nodes: [
          { id: 'p1', title: '视口自适应正文', scope: 'workspace', category: 'design', degree: 1 },
          { id: 'p2', title: '另一个知识页', scope: 'workspace', category: 'solved', degree: 1 },
        ],
        edges: [{ key: 'link:p1-p2', source: 'p1', target: 'p2', kind: 'link', weight: 1 }],
      }),
    ),
  );
});

describe('星图绘制区高度随视口（KB-GRAPH-H）', () => {
  it('stage 用 clamp 高度，不再写死 480px', async () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const stage = await screen.findByTestId('knowledge-graph-stage');
    // jsdom 会把 clamp() 重新序列化，所以按片段断言（真实值由 CDP 实测）
    expect(stage.style.height).toContain('clamp');
    expect(stage.style.height).toContain('360px');
    expect(stage.style.height).toContain('100dvh');
    expect(stage.style.height).toContain('900px');
    expect(stage.className).not.toContain('h-[480px]');
  });

  it('无 WebGL 的列表回退也用同一套高度上限', async () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const fallback = await screen.findByTestId('graph-fallback-list');
    const box = fallback.closest('[data-graph-fallback]') as HTMLElement;
    expect(box.style.maxHeight).toContain('clamp');
    expect(box.style.maxHeight).toContain('100dvh');
    expect(box.className).not.toContain('max-h-[480px]');
  });
});

describe('详情正文宽度自适应且有可读上限（KB-DETAIL-W）', () => {
  it('正文容器 max-w-[min(88ch,100%)] + mx-auto，不再是 max-w-[70ch]', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgePanel workspaceId="ws-1" />
      </QueryClientProvider>,
    );
    const item = await screen.findByTestId('knowledge-item-p1');
    fireEvent.click(within(item).getByRole('button'));
    const body = await screen.findByTestId('knowledge-body');
    expect(body.className).toContain('max-w-[min(88ch,100%)]');
    expect(body.className).toContain('mx-auto');
    expect(body.className).not.toContain('max-w-[70ch]');
  });
});
