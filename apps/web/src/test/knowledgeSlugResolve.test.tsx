/**
 * KB-PAGE-1 缺陷 1：`knowledge:<slug>` 解析**不得**取搜索第一条兜底。
 *
 * 复现（修复前）：workspace 与 common 各有一页同 slug `dup-slug`，引用写 `knowledge:dup-slug`；
 * 直接按 slug 取页会 404 → 走搜索 → 旧实现 `?? rows[0]` 命中搜索第一条（未必是引用想指的那页，甚至可能是另一 scope 的页），
 * 表现为「链接静默打开错页」。修复后：只接受 slug 完全相等的唯一命中；无命中/歧义一律保持 404 → 渲染为灰文本（denied）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { KnowledgePage } from '@agentboard/shared';
import MarkdownRenderer from '../lib/markdownRenderer';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const wsId = 'ws-current';

function page(overrides: Partial<KnowledgePage>): KnowledgePage {
  return {
    id: 'kp-1', scope: 'common', workspace_id: null, slug: 'dup-slug', title: '页', body_md: '正文',
    status: 'active', revision: 1, created_by: 'user', updated_by: 'user', created_at: 1, updated_at: 1, expires_at: null,
    ...overrides,
  } as KnowledgePage;
}

const renderMarkdown = (text: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MarkdownRenderer>{text}</MarkdownRenderer></QueryClientProvider>);
};

describe('KB-PAGE-1 缺陷 1：slug 解析不再兜底取第一条', () => {
  beforeEach(() => {
    useAppStore.setState({ workspaceId: wsId, wsStatus: 'open' });
  });

  it('搜索命中两条同 slug（不同 scope）→ 降级为 denied，不打开任何一张', async () => {
    server.use(
      // 按 slug 直接取页：不存在（引用用的是 slug，不是 id）
      http.get('/api/knowledge/pages/dup-slug', () => HttpResponse.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '知识页不存在' } }, { status: 404 })),
      // 搜索返回两条同 slug 的页（workspace + common）——旧实现会直接取 rows[0]
      http.get('/api/knowledge/search', () => HttpResponse.json([
        { page_id: 'kp-ws', slug: 'dup-slug', scope: 'workspace', title: '工作区页', status: 'active' },
        { page_id: 'kp-common', slug: 'dup-slug', scope: 'common', title: '公共页', status: 'active' },
      ])),
      http.get('/api/knowledge/pages/kp-ws', () => HttpResponse.json(page({ id: 'kp-ws', scope: 'workspace', workspace_id: wsId, title: '工作区页' }))),
      http.get('/api/knowledge/pages/kp-common', () => HttpResponse.json(page({ id: 'kp-common', title: '公共页' }))),
    );
    renderMarkdown('见 [歧义链接](knowledge:dup-slug)');
    await screen.findByTestId('md-link-knowledge-dup-slug');
    // 组件在状态切换时会换节点（span → button），必须每次重新查节点，不能抓旧引用
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-dup-slug')).toHaveAttribute('data-link-state', 'denied'));
    expect(screen.getByTestId('md-link-knowledge-dup-slug').getAttribute('data-link-state')).not.toBe('ok');
  });

  it('搜索有命中但 slug 与引用不完全相等（子串误命中）→ 也降级为 denied', async () => {
    server.use(
      http.get('/api/knowledge/pages/cache', () => HttpResponse.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '不存在' } }, { status: 404 })),
      // 子串命中：slug 是 cache-policy，引用写的是 cache
      http.get('/api/knowledge/search', () => HttpResponse.json([{ page_id: 'kp-sub', slug: 'cache-policy', scope: 'common', title: '缓存策略', status: 'active' }])),
      http.get('/api/knowledge/pages/kp-sub', () => HttpResponse.json(page({ id: 'kp-sub', slug: 'cache-policy' }))),
    );
    renderMarkdown('见 [子串链接](knowledge:cache)');
    await screen.findByTestId('md-link-knowledge-cache');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-cache')).toHaveAttribute('data-link-state', 'denied'));
  });

  it('搜索唯一且 slug 完全相等 → 正常打开（修复不能把正常路径也打死）', async () => {
    server.use(
      http.get('/api/knowledge/pages/exact-slug', () => HttpResponse.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '不存在' } }, { status: 404 })),
      http.get('/api/knowledge/search', () => HttpResponse.json([{ page_id: 'kp-exact', slug: 'exact-slug', scope: 'common', title: '精确页', status: 'active' }])),
      http.get('/api/knowledge/pages/kp-exact', () => HttpResponse.json(page({ id: 'kp-exact', slug: 'exact-slug', title: '精确页' }))),
    );
    renderMarkdown('见 [精确链接](knowledge:exact-slug)');
    await screen.findByTestId('md-link-knowledge-exact-slug');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-exact-slug')).toHaveAttribute('data-link-state', 'ok'));
  });
});
