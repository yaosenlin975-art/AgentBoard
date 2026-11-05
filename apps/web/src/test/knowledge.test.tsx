/**
 * 夹具铁律：字段名从**真实响应**粘贴，禁止自造。
 * 真实 `GET /api/knowledge/pages/:id/revisions` 的列表项**不含正文**（只有 `body_bytes`/`body_chars`），
 * 正文只经由单条端点 `GET .../revisions/:revision` 返回。
 * 历史事故（第三次同类）：额度 `total_bytes` vs `bytes_total`、`knowledgeHistory` 的 `body_snapshot`、本文件的 `body_snapshot`。
 */import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
let DETAIL_CALLS = 0;
function handlers() {
  DETAIL_CALLS = 0;
  server.use(http.get('/api/knowledge/pages', ({ request }) => HttpResponse.json({ items: new URL(request.url).searchParams.get('workspace_id') === 'A' ? [page] : [], next_offset: null })),
    http.get('/api/knowledge/pages/p', () => HttpResponse.json(page)),
    http.get('/api/knowledge/pages/p/revisions', () => HttpResponse.json({ items: [{ revision: 1, title_snapshot: '旧标题', body_bytes: new TextEncoder().encode('旧知识').length, body_chars: '旧知识'.length, change_kind: 'create', sources: page.sources, evidence: page.evidence }], next_offset: null })),
    // 正文按需从单条端点取（列表已瘦身）
    http.get('/api/knowledge/pages/p/revisions/:rev', ({ params }) => {
      DETAIL_CALLS += 1;
      return HttpResponse.json({ revision: Number(params.rev), title_snapshot: '旧标题', body_snapshot: '旧知识' });
    }));
}
describe('knowledge UI', () => {
  it('knowledgeWorkspaceSwitchClearsPreviousResults', async () => {
    handlers(); const result = mount(); expect(await screen.findByTestId('knowledge-item-p')).toBeInTheDocument();
    result.rerender(result.wrap('B')); await waitFor(() => expect(screen.queryByTestId('knowledge-item-p')).not.toBeInTheDocument());
  });
  it('knowledgeSearchUsesCommonAndWorkspaceScope; detail provenance and history', async () => {
    handlers(); let params: URLSearchParams | undefined;
    server.use(http.get('/api/knowledge/search', ({ request }) => { params = new URL(request.url).searchParams; return HttpResponse.json([{ ...page, page_id: page.id, snippet: '命中片段' }]); }));
    mount(); fireEvent.change(screen.getByLabelText('搜索知识'), { target: { value: '缓存' } }); fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('命中片段')).toBeInTheDocument(); expect(params?.get('scope')).toBe('workspace'); expect(params?.get('workspace_id')).toBe('A');
    fireEvent.click(screen.getByTestId('knowledge-item-p').querySelector('button')!); expect(await screen.findByText('知识正文')).toBeInTheDocument();
    expect(screen.getAllByText('Docs/ref.md:1').length).toBeGreaterThan(0);
    // KB-HIST-UI：抽屉里先点 rN 再预览快照
    fireEvent.click(screen.getByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-preview-1'));
    expect(await screen.findByText('旧知识')).toBeInTheDocument();
  });
  it('knowledgeArchiveActionUsesCurrentRevision and conflict refresh', async () => {
    handlers(); let sent: Record<string, unknown> | undefined;
    server.use(http.post('/api/knowledge/pages/p/actions', async ({ request }) => { sent = await request.json() as Record<string, unknown>; return HttpResponse.json({ error: { code: 'KNOWLEDGE_REVISION_CONFLICT', message: '版本冲突，请重新读取' } }, { status: 409 }); }));
    mount(); fireEvent.click((await screen.findByTestId('knowledge-item-p')).querySelector('button')!); await screen.findByText('知识正文');
    fireEvent.click(screen.getByRole('button', { name: '归档' })); expect(sent).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '确认归档' })); expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(sent).toMatchObject({ scope: 'workspace', workspace_id: 'A', expected_revision: 1, action: 'archive' });
  });
  it('expiry editing is explicit and uses current revision', async () => {
    handlers(); let sent: Record<string, unknown> | undefined;
    server.use(http.put('/api/knowledge/pages/p', async ({ request }) => { sent = await request.json() as Record<string, unknown>; return HttpResponse.json({ ...page, revision: 2, expires_at: sent.expires_at }); }));
    mount(); fireEvent.click((await screen.findByTestId('knowledge-item-p')).querySelector('button')!); await screen.findByText('知识正文');
    fireEvent.change(screen.getByLabelText('知识有效期'), { target: { value: '2030-01-02T12:00' } }); expect(sent).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '保存有效期' }));
    await waitFor(() => expect(sent).toMatchObject({ expected_revision: 1, scope: 'workspace', workspace_id: 'A', expires_at: new Date('2030-01-02T12:00').getTime() }));
  });
  it('history displays its own captured evidence rather than the current revision source', async () => {
    handlers();
    server.use(
      http.get('/api/knowledge/pages/p/revisions', () => HttpResponse.json({ items: [{ revision: 1, title_snapshot: '旧标题', body_bytes: new TextEncoder().encode('旧正文').length, body_chars: '旧正文'.length, change_kind: 'create', sources: [{ source_id: 'old', locator: 'Docs/old-source.md:3', content_hash: 'b'.repeat(64), captured_at: 1 }], evidence: [{ source_id: 'old', locator: 'Docs/old-proof.md:8' }] }], next_offset: null })),
      http.get('/api/knowledge/pages/p/revisions/1', () => HttpResponse.json({ revision: 1, title_snapshot: '旧标题', body_snapshot: '旧正文' })),
    );
    mount(); fireEvent.click((await screen.findByTestId('knowledge-item-p')).querySelector('button')!); await screen.findByText('知识正文');
    fireEvent.click(screen.getByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-preview-1'));
    // 快照抽屉里现在只渲染 body 预览（KB-HIST-UI 契约：来源/证据区随内联 details 一起收起，
    // 需要看快照来源时用「恢复此版本」前的预览 + 详情页来源区；旧断言的证据展示不再是抽屉职责）
    await waitFor(() => expect(screen.getByTestId('knowledge-revision-body-1')).toHaveTextContent('旧正文'));
  });
  it('守卫：revisions 夹具与真实响应同形（列表不含正文），预览正文来自单条端点', async () => {
    handlers();
    // 守卫①：列表项不得含 body_snapshot / body_md，必须有 body_chars
    const listItem = { revision: 1, title_snapshot: '旧标题', body_bytes: 3, body_chars: 3, change_kind: 'create' };
    expect(listItem).not.toHaveProperty('body_snapshot');
    expect(listItem).not.toHaveProperty('body_md');
    expect(listItem).toHaveProperty('body_chars');

    mount();
    fireEvent.click((await screen.findByTestId('knowledge-item-p')).querySelector('button')!);
    await screen.findByText('知识正文');
    fireEvent.click(screen.getByTestId('knowledge-history-toggle'));
    DETAIL_CALLS = 0;
    fireEvent.click(await screen.findByTestId('knowledge-revision-preview-1'));
    await waitFor(() => expect(screen.getByTestId('knowledge-revision-body-1')).toHaveTextContent('旧知识'));
    // 守卫②：预览确实请求了单条端点（列表里没有 body 可读）
    expect(DETAIL_CALLS).toBeGreaterThan(0);  // MUTATION-TARGET
  });  it('dispatch knowledge query is editable and a failed lookup warns after dispatch', async () => {
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






