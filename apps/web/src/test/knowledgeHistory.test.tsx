/**
 * KB-HIST-UI：知识页历史抽屉 —— 列表字段、只读预览、恢复此版本（产生新 revision）、409 并发提示。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** 各 revision 的**完整正文**只经由单条端点返回（KB-DIFF-S 之后列表不再带 body） */
const REV_BODIES = new Map<number, string>();
/** 单条端点被请求的次数（守卫用：证明预览/diff 走按需端点，而不是读列表里不存在的 body） */
let DETAIL_CALLS = 0;

/**
 * 夹具铁律：字段名从**真实响应**粘贴，禁止自造。
 * 真实 `GET /api/knowledge/pages/:id/revisions` 的列表项**不含 body**（只有 `body_bytes` / `body_chars`）；
 * 历史上两次「mock 镜像 bug」（额度 `total_bytes` vs `bytes_total`、此处 `body_snapshot`）都是
 * 夹具凭记忆多写了字段，导致测试全绿而线上空白。
 */
const revision = (rev: number, title: string, body: string, note = '') => {
  REV_BODIES.set(rev, body);
  return {
    id: `r${rev}`,
    page_id: 'p1',
    revision: rev,
    title_snapshot: title,
    body_bytes: new TextEncoder().encode(body).length,
    body_chars: body.length,
    sources: [],
    evidence: [],
    change_kind: rev === 1 ? 'create' : 'update',
    status_snapshot: 'active',
    expires_at_snapshot: null,
    change_note: note,
    actor: rev === 1 ? 'creator' : 'editor',
    created_at: 1_700_000_000_000 + rev * 1000,
  };
};

function mount() {
  DETAIL_CALLS = 0;
  // 单条端点：正文只从这里出（列表已瘦身）。放在 mount 里，确保覆盖各用例自己的 server.use。
  server.use(
    http.get('/api/knowledge/pages/p1/revisions/:rev', ({ params }) => {
      const rev = Number(params.rev);
      DETAIL_CALLS += 1;
      return HttpResponse.json({ revision: rev, body_snapshot: REV_BODIES.get(rev) ?? '' });
    }),
  );
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

  it('点一条 → 按需请求单条端点并渲染该快照正文（列表本身不含 body）', async () => {
    let detailCalls = 0;
    const items = [revision(3, '当前标题', '当前正文'), revision(1, '第一版', '第一版正文内容')];
    // 守卫①：夹具与真实响应同形 —— 列表项不得含 body 字段
    for (const item of items) {
      expect(item).not.toHaveProperty('body_snapshot');
      expect(item).not.toHaveProperty('body_md');
      expect(item).toHaveProperty('body_chars');
    }
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', '当前正文'))),
      http.get('/api/knowledge/pages/p1/revisions', () => HttpResponse.json({ items, next_offset: null })),
      http.get('/api/knowledge/pages/p1/revisions/1', () => {
        detailCalls += 1;
        return HttpResponse.json({ revision: 1, body_snapshot: '第一版正文内容' });
      }),
    );
    mount();
    fireEvent.click(await screen.findByTestId('knowledge-history-toggle'));
    fireEvent.click(await screen.findByTestId('knowledge-revision-preview-1'));
    await waitFor(() => expect(screen.getByTestId('knowledge-revision-body-1')).toHaveTextContent('第一版正文内容'));
    // 守卫②：预览确实走单条端点（而不是读列表里不存在的 body）
    expect(DETAIL_CALLS).toBeGreaterThan(0);
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

describe('知识页创建/最后修改时间展示', () => {
  it('头部元信息显示两个时间，格式与 revision 历史一致（toLocaleString）', async () => {
    const created = 1_700_000_000_000;
    const updated = 1_700_000_006_000;
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json({ ...page(3, '当前标题', '当前正文'), created_at: created, updated_at: updated })),
    );
    mount();
    expect(await screen.findByTestId('knowledge-page-created-at')).toHaveTextContent(`创建时间 ${new Date(created).toLocaleString()}`);
    expect(screen.getByTestId('knowledge-page-updated-at')).toHaveTextContent(`最后修改时间 ${new Date(updated).toLocaleString()}`);
  });
});

describe('KB-DIFF-W 版本 diff 展开', () => {
  const openHistory = async (): Promise<void> => {
    fireEvent.click(await screen.findByTestId('knowledge-history-toggle'));
    await screen.findByTestId('knowledge-history-drawer');
  };

  it('点「查看 diff」展开 r2→当前：aria-expanded 翻转、行首 +/- 与 3 行上下文、折叠行文案', async () => {
    const body = (lines: string[]): string => lines.join('\n');
    const base = Array.from({ length: 12 }, (_, i) => `line-${i}`);
    const r2Body = body(base);
    const currentBody = body([...base.slice(0, 5), 'line-CHANGED', ...base.slice(6)]);
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', currentBody))),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', currentBody), revision(2, '旧标题', r2Body), revision(1, '初版', r2Body)], next_offset: null })),
      http.get('/api/knowledge/pages/p1/revisions/2', () => HttpResponse.json({ revision: 2, body_md: r2Body })),
      http.get('/api/knowledge/pages/p1/revisions/1', () => HttpResponse.json({ revision: 1, body_md: r2Body })),
    );
    mount();
    await openHistory();

    const toggle = await screen.findByTestId('knowledge-revision-diff-toggle-2');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    const panel = await screen.findByTestId('revision-diff-2');
    expect(panel).toBeInTheDocument();
    // 行首 +/- 与统计
    expect(screen.getByTestId('revision-diff-stats-2')).toHaveTextContent('+1 / −1 行');
    expect(panel.querySelector('[data-kind="del"]')?.textContent).toBe('-line-5');
    expect(panel.querySelector('[data-kind="add"]')?.textContent).toBe('+line-CHANGED');
    // 3 行上下文 + 折叠行（变更在第 6 行，前面 5 行未变 → 折叠 2 行）
    expect(panel.textContent).toContain('… 共 2 行未变 …');
    const sameLines = panel.querySelectorAll('[data-kind="same"]');
    expect(sameLines.length).toBeGreaterThanOrEqual(6);
    // 再点收起
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('revision-diff-2')).toBeNull());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('当前版本那行不给展开；两版内容相同显示「无差异」', async () => {
    const same = 'a\nb\nc';
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', same))),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', same), revision(2, '旧标题', same)], next_offset: null })),
      http.get('/api/knowledge/pages/p1/revisions/2', () => HttpResponse.json({ revision: 2, body_md: same })),
    );
    mount();
    await openHistory();
    await screen.findByTestId('knowledge-revision-diff-toggle-2');
    expect(screen.queryByTestId('knowledge-revision-diff-toggle-3')).toBeNull();
    expect(within(screen.getByTestId('knowledge-revision-3')).getByText('当前版本')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('knowledge-revision-diff-toggle-2'));
    await waitFor(() => expect(screen.getByTestId('revision-diff-empty-2')).toHaveTextContent('两版内容相同'));
  });

  it('切「与上一版对比」→ diff 目标变为 r1→r2（内容随基准变化）', async () => {
    const v1 = 'x\ny';
    const v2 = 'x\nz';
    const v3 = 'x\nz\nw';
    server.use(
      http.get('/api/knowledge/pages/p1', () => HttpResponse.json(page(3, '当前标题', v3))),
      http.get('/api/knowledge/pages/p1/revisions', () =>
        HttpResponse.json({ items: [revision(3, '当前标题', v3), revision(2, '第二版', v2), revision(1, '初版', v1)], next_offset: null })),
      http.get('/api/knowledge/pages/p1/revisions/2', () => HttpResponse.json({ revision: 2, body_md: v2 })),
      http.get('/api/knowledge/pages/p1/revisions/1', () => HttpResponse.json({ revision: 1, body_md: v1 })),
    );
    mount();
    await openHistory();
    fireEvent.click(await screen.findByTestId('knowledge-revision-diff-toggle-2'));
    await waitFor(() => expect(screen.getByTestId('revision-diff-stats-2')).toHaveTextContent('+1 / −0 行'));
    const switchBtn = screen.getByTestId('revision-diff-baseline-2');
    expect(switchBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(switchBtn);
    await waitFor(() => expect(screen.getByTestId('revision-diff-baseline-2')).toHaveAttribute('aria-pressed', 'true'));
    // r1→r2 的差异：y → z
    await waitFor(() => expect(screen.getByTestId('revision-diff-stats-2')).toHaveTextContent('+1 / −1 行'));
  });
});






