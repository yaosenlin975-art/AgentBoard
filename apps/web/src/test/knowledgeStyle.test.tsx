import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from './server';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';

/** KB-STYLE01 结构契约：折叠来源、选中态可访问、骨架/空态、元信息可读文本 */

const basePage = {
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'cache',
  revision: 1,
  status: 'active',
  expires_at: null,
  sources: [{ source_id: 's', locator: 'Docs/ref.md:1', content_hash: 'a'.repeat(64), captured_at: 1 }],
  evidence: [{ source_id: 's', locator: 'Docs/proof.md:9' }],
  created_at: 1,
  updated_at: 1,
};
const pageOne = { ...basePage, id: 'p1', title: '缓存策略', body_md: '知识正文' };
const pageTwo = { ...basePage, id: 'p2', title: '限流策略', body_md: '限流正文', scope: 'common', revision: 2, status: 'archived' };

function mount(workspaceId = 'A') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KnowledgePanel workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

function mockPages(items: unknown[]) {
  server.use(http.get('/api/knowledge/pages', () => HttpResponse.json({ items, next_offset: null })));
}

describe('知识库页面结构（KB-STYLE01）', () => {
  it('来源与证据默认折叠并标注条数，展开后才显示 locator 与 SHA-256', async () => {
    mockPages([pageOne]);
    server.use(http.get('/api/knowledge/pages/p1', () => HttpResponse.json(pageOne)));
    const { container } = mount();

    fireEvent.click(await screen.findByRole('button', { name: /缓存策略/ }));
    await screen.findByText('知识正文');

    const details = container.querySelector('[data-testid="provenance"]') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')).toHaveTextContent('来源与证据（2 条）');

    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(await screen.findByText('Docs/ref.md:1')).toBeInTheDocument();
    expect(screen.getByText(/SHA-256/)).toBeInTheDocument();
  });

  it('列表项选中态可访问（aria-current 随选择转移）', async () => {
    mockPages([pageOne, pageTwo]);
    server.use(http.get('/api/knowledge/pages/p1', () => HttpResponse.json(pageOne)));
    mount();

    const first = await screen.findByRole('button', { name: /缓存策略/ });
    const second = screen.getByRole('button', { name: /限流策略/ });
    expect(first).not.toHaveAttribute('aria-current');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');
  });

  it('列表项用可读文本呈现范围/版本/状态（Badge 语义）', async () => {
    mockPages([pageOne, pageTwo]);
    mount();

    const item = await screen.findByTestId('knowledge-item-p1');
    expect(item).toHaveTextContent('项目');
    expect(item).toHaveTextContent('v1');
    expect(item).toHaveTextContent('有效');
    const common = screen.getByTestId('knowledge-item-p2');
    expect(common).toHaveTextContent('公共');
    expect(common).toHaveTextContent('v2');
    expect(common).toHaveTextContent('归档');
  });

  it('UNSLOP-4：元信息收敛成一行静默文本，只有类别是小圆点（不再每行 5 个 pill）', async () => {
    mockPages([{ ...pageOne, category: 'design', landed: 'landed', expires_at: 1 }]);
    mount();

    const item = await screen.findByTestId('knowledge-item-p1');
    const meta = within(item).getByTestId('knowledge-meta');
    // 单一字号（text-xs）承载整行元信息
    expect(meta.className).toContain('text-xs');
    expect(meta.className).toContain('text-ink-3');
    // 全行只允许一个小圆点（类别色），pill 标签全部消失
    expect(item.querySelectorAll('[class*="rounded-full"]').length).toBe(1);
    const dot = item.querySelector('[class*="rounded-full"]') as HTMLElement;
    expect(dot.getAttribute('style')).toContain('var(--kb-cat-design)');
    // 元信息文本仍完整（收敛样式不丢信息）
    expect(meta).toHaveTextContent('设计方案');
    expect(meta).toHaveTextContent('项目');
    expect(meta).toHaveTextContent('v1');
    expect(meta).toHaveTextContent('有效');
    expect(meta).toHaveTextContent('已落地');
    expect(meta).toHaveTextContent('已过期');
  });

  it('加载中显示骨架，空结果显示空态文案（搜索无命中给出清除提示）', async () => {
    server.use(http.get('/api/knowledge/pages', () => new Promise(() => {})));
    const pending = mount();
    expect(await screen.findByTestId('knowledge-skeleton')).toBeInTheDocument();
    pending.unmount();

    server.use(http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })));
    mount();
    expect(await screen.findByTestId('knowledge-empty')).toHaveTextContent('暂无知识');
  });

  it('搜索无命中显示「没有匹配的知识」并保留清除搜索入口', async () => {
    server.use(http.get('/api/knowledge/search', () => HttpResponse.json([])));
    mockPages([pageOne]);
    mount();

    fireEvent.change(await screen.findByLabelText('搜索知识'), { target: { value: '不存在' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(screen.getByTestId('knowledge-empty')).toHaveTextContent('没有匹配的知识'));
    expect(screen.getByRole('button', { name: '清除搜索' })).toBeInTheDocument();
  });
});
