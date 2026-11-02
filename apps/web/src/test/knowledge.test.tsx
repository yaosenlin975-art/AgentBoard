import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { DispatchDialog } from '../components/detail/DispatchDialog';
import type { Issue } from '@agentboard/shared';
const page = { id: 'p', scope: 'workspace', workspace_id: 'A', slug: 'cache', title: '缓存策略', body_md: '知识正文', revision: 1, status: 'active', expires_at: null, sources: [{ source_id: 's', locator: 'Docs/ref.md:1', content_hash: 'a'.repeat(64), captured_at: 1 }], evidence: [{ source_id: 's', locator: 'Docs/ref.md:1' }], created_at: 1, updated_at: 1 };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (id: string) => <QueryClientProvider client={client}><KnowledgePanel key={id} workspaceId={id} /></QueryClientProvider>;
  return { ...render(wrap('A')), wrap };
}
function handlers() {
  server.use(http.get('/api/knowledge/pages', ({ request }) => HttpResponse.json({ items: new URL(request.url).searchParams.get('workspace_id') === 'A' ? [page] : [], next_offset: null })),
    http.get('/api/knowledge/pages/p', () => HttpResponse.json(page)),
    http.get('/api/knowledge/pages/p/revisions', () => HttpResponse.json({ items: [{ revision: 1, body_snapshot: '旧知识', title_snapshot: '旧标题', sources: page.sources, evidence: page.evidence }], next_offset: null })));
}
describe('knowledge UI', () => {
  it('knowledgeWorkspaceSwitchClearsPreviousResults', async () => {
    handlers(); const result = mount(); expect(await screen.findByText('缓存策略')).toBeInTheDocument();
    result.rerender(result.wrap('B')); await waitFor(() => expect(screen.queryByText('缓存策略')).not.toBeInTheDocument());
  });
  it('knowledgeSearchUsesCommonAndWorkspaceScope; detail provenance and history', async () => {
    handlers(); let params: URLSearchParams | undefined;
    server.use(http.get('/api/knowledge/search', ({ request }) => { params = new URL(request.url).searchParams; return HttpResponse.json([{ ...page, page_id: page.id, snippet: '命中片段' }]); }));
    mount(); fireEvent.change(screen.getByLabelText('搜索知识'), { target: { value: '缓存' } }); fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('命中片段')).toBeInTheDocument(); expect(params?.get('scope')).toBe('both'); expect(params?.get('workspace_id')).toBe('A');
    fireEvent.click(screen.getByRole('button', { name: /缓存策略/ })); expect(await screen.findByText('知识正文')).toBeInTheDocument();
    expect(screen.getAllByText('Docs/ref.md:1').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '版本历史' })); expect(await screen.findByText('旧知识')).toBeInTheDocument();
  });
  it('knowledgeArchiveActionUsesCurrentRevision and conflict refresh', async () => {
    handlers(); let sent: Record<string, unknown> | undefined;
    server.use(http.post('/api/knowledge/pages/p/actions', async ({ request }) => { sent = await request.json() as Record<string, unknown>; return HttpResponse.json({ error: { code: 'KNOWLEDGE_REVISION_CONFLICT', message: '版本冲突，请重新读取' } }, { status: 409 }); }));
    mount(); fireEvent.click(await screen.findByRole('button', { name: /缓存策略/ })); await screen.findByText('知识正文');
    fireEvent.click(screen.getByRole('button', { name: '归档' })); expect(sent).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '确认归档' })); expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(sent).toMatchObject({ scope: 'workspace', workspace_id: 'A', expected_revision: 1, action: 'archive' });
  });
  it('expiry editing is explicit and uses current revision', async () => {
    handlers(); let sent: Record<string, unknown> | undefined;
    server.use(http.put('/api/knowledge/pages/p', async ({ request }) => { sent = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...page, revision: 2, expires_at: sent.expires_at }); }));
    mount(); fireEvent.click(await screen.findByRole('button', { name: /缓存策略/ })); await screen.findByText('知识正文');
    fireEvent.change(screen.getByLabelText('知识有效期'), { target: { value: '2030-01-02T12:00' } }); expect(sent).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '保存有效期' }));
    await waitFor(() => expect(sent).toMatchObject({ expected_revision: 1, scope: 'workspace', workspace_id: 'A', expires_at: new Date('2030-01-02T12:00').getTime() }));
  });
  it('history displays its own captured evidence rather than the current revision source', async () => {
    handlers();
    server.use(http.get('/api/knowledge/pages/p/revisions', () => HttpResponse.json({ items: [{ revision: 1, title_snapshot: '旧标题', body_snapshot: '旧正文', change_kind: 'create', sources: [{ source_id: 'old', locator: 'Docs/old-source.md:3', content_hash: 'b'.repeat(64), captured_at: 1 }], evidence: [{ source_id: 'old', locator: 'Docs/old-proof.md:8' }] }], next_offset: null })));
    mount(); fireEvent.click(await screen.findByRole('button', { name: /缓存策略/ })); await screen.findByText('知识正文'); fireEvent.click(screen.getByRole('button', { name: '版本历史' }));
    expect(await screen.findByText('Docs/old-source.md:3')).toBeInTheDocument(); expect(screen.getByText('Docs/old-proof.md:8')).toBeInTheDocument();
  });
  it('dispatch knowledge query is editable and a failed lookup warns after dispatch', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(http.get('/api/clis', () => HttpResponse.json([{ id: 'codebuddy', installed: true, displayName: 'CodeBuddy', supportsModelSelection: true }])),
      http.get('/api/clis/codebuddy/models', () => HttpResponse.json([])), http.get('/api/issues/task/comments', () => HttpResponse.json([])),
      http.post('/api/sessions', async ({ request }) => { sent = await request.json() as Record<string, unknown>; return HttpResponse.json({ id: 'session', workspace_id: 'A', issue_id: 'task', cli: 'codebuddy', status: '运行中', knowledge: { enabled: true, query: '缓存', items: [], warning: 'KNOWLEDGE_UNAVAILABLE' } }); }));
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DispatchDialog issue={{ id: 'task', workspace_id: 'A', title: '缓存', description: '', labels: [] } as unknown as Issue} workspacePath="A" onClose={onClose} /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText('知识查询'), { target: { value: '缓存失效' } });
    const submit = screen.getByRole('button', { name: '确认派发' });
    await waitFor(() => expect(submit).not.toBeDisabled()); fireEvent.click(submit);
    expect(await screen.findByText('任务已派发，但知识检索不可用；本次沿用原任务上下文。')).toBeInTheDocument();
    expect(sent).toMatchObject({ knowledge_enabled: true, knowledge_query: '缓存失效' }); expect(onClose).not.toHaveBeenCalled();
  });
});
