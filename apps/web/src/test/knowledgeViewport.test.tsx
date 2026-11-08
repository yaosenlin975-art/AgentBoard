/**
 * KB-SCROLL / KB-DETAIL-W / KB-DETAIL-ALIGN 回归：视口自适应。
 *
 * jsdom 不做布局，所以断言「决定几何的声明」：
 * - 星图绘制区高度随父容器自适应（stage flex-1 填满剩余空间 + minHeight 360px 下限），
 *   不再写死 480px、也不再依赖 100dvh 固定差值；
 * - 详情正文用 max-w-[min(calc(88ch+100px),100%)] 且左对齐（无 mx-auto），
 *   详情区 article 水平内边距 px-7=28px，正文与下方区块共用同一条左边线。
 * 真实三档数值（1920/1440/1280 → 760/580/400px、中心偏移 0,0）由 CDP 实测保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const STAGE_MIN_HEIGHT = '360px';

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

describe('星图绘制区高度随父容器（KB-SCROLL）', () => {
  it('stage 高度随父容器自适应（flex-1 填满），360px 仅作下限，不再写死 480px / 100dvh', async () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const stage = await screen.findByTestId('knowledge-graph-stage');
    expect(stage.style.height).toBe('');
    expect(stage.style.minHeight).toContain(STAGE_MIN_HEIGHT);
    expect(stage.className).toContain('flex-1');
    expect(stage.className).not.toContain('h-[480px]');
  });

  it('无 WebGL 的列表回退同一套自适应：flex-1 填满 + 360px 下限 + 自滚动', async () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const fallback = await screen.findByTestId('graph-fallback-list');
    const box = fallback.closest('[data-graph-fallback]') as HTMLElement;
    expect(box.style.minHeight).toContain(STAGE_MIN_HEIGHT);
    expect(box.style.maxHeight).toBe('');
    expect(box.className).toContain('flex-1');
    expect(box.className).toContain('overflow-auto');
    expect(box.className).not.toContain('max-h-[480px]');
  });
});

describe('详情正文宽度自适应且有可读上限（KB-DETAIL-W / KB-DETAIL-ALIGN）', () => {
  it('正文容器左对齐、上限 88ch+100px，与下方区块共用 article 的 28px 左边线', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgePanel workspaceId="ws-1" />
      </QueryClientProvider>,
    );
    const item = await screen.findByTestId('knowledge-item-p1');
    fireEvent.click(within(item).getByRole('button'));
    const body = await screen.findByTestId('knowledge-body');
    expect(body.className).toContain('max-w-[min(calc(88ch+100px),100%)]');
    expect(body.className).not.toContain('mx-auto');
    expect(body.className).not.toContain('max-w-[70ch]');
    // 正文列自身不加水平内边距：其左边线由 article px-7 统一决定，编辑/来源/归档区块同源对齐
    const article = screen.getByLabelText('知识详情');
    expect(article.className).toContain('px-7');
    expect(article.className).not.toContain('p-4');
  });
});
