/**
 * KB-HIST-UI：知识页历史抽屉 —— 列表字段、只读预览、恢复此版本（产生新 revision）、409 并发提示。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { KnowledgePageDetail } from '../components/knowledge/KnowledgePageDetail';

const SCOPE = { scope: 'workspace' as const, workspace_id: 'A' };

const page = (revision: number, title: string, body: string) => ({
  id: 'p1',
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'p1',
  title,
  body_md: body,
  status: 'active',
  revision,
  expires_at: null,
  created_by: 'u',
  updated_by: 'u',
  created_at: 1,
  updated_at: 1,
  sources: [],
  evidence: [],
});

const revision = (rev: number, title: string, body: string, note = '') => ({
  id: `r${rev}`,
  page_id: 'p1',
  revision: rev,
  title_snapshot: title,
  body_snapshot: body,
  sources: [],
  evidence: [],
  change_kind: rev === 1 ? 'create' : 'update',
  status_snapshot: 'active',
  expires_at_snapshot: null,
  change_note: note,
  actor: rev === 1 ? 'creator' : 'editor',
  created_at: 1_700_000_000_000 + rev * 1000,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgePageDetail pageId="p1" scope="workspace" workspaceId="A" onChanged={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('KB-HIST-UI 历史抽屉', () => {
  it('顶部按钮显示「历史（N）」，抽屉列表 rev 降序且带 kind/actor/时间/note', async () => {
    let current = page(3, '当前标题', '当前正文');
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(current)),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({
          items: [
            revision(3, '当前标题', '当前正文', '第三次改动'),
            revision(2, '第二版', '第二版正文', '第二次改动'),
            revision(1, '第一版', '第一版正文'),
          ],
          next_offset: null,
        }),
      ),
    );
    mount();
    const toggle = await screen.findByTestId('knowledge-history-toggle');
    expect(toggle).toHaveTextContent('历史（3）');
    fireEvent.click(toggle);

    const drawer = await screen.findByTestId('knowledge-history-drawer');
    expect(drawer).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('knowledge-history-list').querySelectorAll('li')).toHaveLength(3));
    const items = screen.getByTestId('knowledge-history-list').querySelectorAll('li');
    expect(items).toHaveLength(3);
    // 降序：r3 在前
    expect(screen.getByTestId('knowledge-revision-preview-3')).toHaveTextContent('r3');
    expect(screen.getByTestId('knowledge-revision-kind-2')).toHaveTextContent('update');
    expect(screen.getByTestId('knowledge-revision-actor-1')).toHaveTextContent('creator');
    expect(screen.getByTestId('knowledge-revision-time-3')).not.toBeEmptyDOMElement();
    expect(screen.getByTestId('knowledge-revision-note-2')).toHaveTextContent('第二次改动');
    // 当前版本不提供「恢复」
    expect(screen.queryByTestId('knowledge-revision-restore-3')).toBeNull();
    expect(screen.getByTestId('knowledge-revision-restore-1')).toBeInTheDocument();
  });

  it('点一条 → 只读预览内容等于该快照', async () => {
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', '当前正文'))),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', '当前正文'), revision(1, '第一版', '第一版正文内容')], next_offset: null }),
      ),
    );
    mount();
    fireEvent.click(await screen.findByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-preview-1'));
    const preview = screen.getByTestId('knowledge-revision-body-1');
    expect(preview).toHaveTextContent('第一版');
    expect(preview).toHaveTextContent('第一版正文内容');
  });

  it('恢复此版本：二次确认后才 PUT，带 change_note「恢复自 rN」与当前 expected_revision', async () => {
    let current = page(3, '当前标题', '当前正文');
    const puts: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(current)),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', '当前正文'), revision(1, '第一版', '第一版正文')], next_offset: null }),
      ),
      http.put('/api/knowledge/pages/p1', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        current = page(4, body.title as string, body.body_md as string);
        return HttpResponse.json(current);
      }),
    );
    mount();
    fireEvent.click(await screen.findByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-restore-1'));

    // 二次确认：点「恢复」还没发请求
    const confirmBox = screen.getByTestId('knowledge-restore-confirm-1');
    expect(confirmBox).toHaveTextContent('会生成');
    expect(puts).toHaveLength(0);

    fireEvent.click(screen.getByTestId('knowledge-restore-confirm-yes-1'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ title: '第一版', body_md: '第一版正文', change_note: '恢复自 r1', expected_revision: 3, scope: 'workspace', workspace_id: 'A' });
  });

  it('409 并发冲突 → 提示「他人已更新，请刷新后再试」', async () => {
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', '当前正文'))),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', '当前正文'), revision(1, '第一版', '第一版正文')], next_offset: null }),
      ),
      http.put('/api/knowledge/pages/p1', () =>
        HttpResponse.json({ error: { code: 'KNOWLEDGE_REVISION_CONFLICT', message: '知识页已更新，请重新读取' } }, { status: 409 }),
      ),
    );
    mount();
    fireEvent.click(await screen.findByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-restore-1'));
    fireEvent.click(screen.getByTestId('knowledge-restore-confirm-yes-1'));
    const alert = await screen.findByTestId('knowledge-restore-error');
    expect(alert).toHaveTextContent('他人已更新，请刷新后再试');
  });
});
