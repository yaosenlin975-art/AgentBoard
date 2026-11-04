/**
 * KB-WRITE-NUDGE：done 响应的 `knowledge_hint` 软提醒。
 * 判定见 `services/knowledgeNudge.ts`；本文件只验行为。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { KnowledgeHint, KnowledgeScope } from '@agentboard/shared';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';

type DoneBody = { id: string; status: string; knowledge_hint: KnowledgeHint | null };

const hex = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('knowledge nudge on done', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let workspaceId: string;

  const makeIssue = async (title = '写知识提醒的任务'): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title, description: '' });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const claim = async (issueId: string): Promise<void> => {
    const res = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    expect(res.status).toBe(200);
  };
  const done = async (issueId: string): Promise<DoneBody> => {
    const res = await request(app).post(`/api/issues/${issueId}/done`).send({ workspace_id: workspaceId, agent_id: 'fake', notes: '' });
    expect(res.status).toBe(200);
    return res.body as DoneBody;
  };
  const writePage = (scope: KnowledgeScope, slug: string, title: string, actor = 'agent:fake'): string => {
    const source = { source_id: randomUUID(), source_type: 'file' as const, locator: `file:${slug}.ts`, captured_at: 1, content_hash: hex(slug) };
    const page = createKnowledgePage(t.db, { domain: 'knowledge',
      scope: scope.scope, workspace_id: scope.scope === 'workspace' ? scope.workspace_id : null,
      slug, title, body_md: '正文',
      sources: [source], evidence: [{ source_id: source.source_id, locator: source.locator }], actor,
    });
    return page.id;
  };

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-nudge-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: 'nudge', path: root }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('hintsWhenNoKnowledgeWritten', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    const body = await done(issueId);
    expect(body.status).toBe('待验收');
    // KB-SRVMSG N-04：主题 slug（handoff-<主题>-<日期>），不再是一次性 handoff-<uuid>
    expect(body.knowledge_hint).toMatchObject({ scope: 'workspace' });
    expect(body.knowledge_hint!.suggested_slug).toMatch(/^handoff-[\p{L}\p{N}-]+-\d{4}-\d{2}-\d{2}$/u);
    expect(body.knowledge_hint!.suggested_slug).not.toBe(`handoff-${issueId}`);
    expect(body.knowledge_hint!.message).toContain('kb knowledge create');
    expect(body.knowledge_hint!.message).toContain(body.knowledge_hint!.suggested_slug);
  });

  it('suggestedSlugIsLegalAndCategorySupplied', async () => {
    const issueId = await makeIssue('缓存失效方案（B/S 两端）');
    await claim(issueId);
    const body = await done(issueId);
    const hint = body.knowledge_hint!;
    // 照抄即可执行：slug 合法、--category solved 明示（不落 legacy）、来源/证据要求在场
    expect(hint.message).toContain(`--slug ${hint.suggested_slug}`);
    expect(hint.message).toContain('--category solved');
    expect(hint.message).toContain('--domain knowledge');
    expect(hint.message).toContain('--sources-file');
    expect(hint.message).toContain('--evidence-file');
    const page = createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: workspaceId, slug: hint.suggested_slug,
      title: '照抄建页验证', body_md: '正文', category: 'solved',
      sources: [{ source_id: 's1', source_type: 'file', locator: 'file:x.ts', captured_at: 1, content_hash: hex('x') }],
      evidence: [{ source_id: 's1', locator: 'file:x.ts' }], actor: 'agent:fake',
    });
    expect(page.slug).toBe(hint.suggested_slug);
    expect(page.category).toBe('solved');
  });

  it('isSilentWhenHandoffPageExists', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    writePage({ scope: 'workspace', workspace_id: workspaceId }, `handoff-${issueId}`, '本轮交接');
    const body = await done(issueId);
    expect(body.knowledge_hint).toBeNull();
  });

  it('isSilentWhenPageUpdatedByAgentDuringClaim', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    const pageId = writePage({ scope: 'workspace', workspace_id: workspaceId }, 'some-other-slug', '随手写的一页');
    const claimed = (t.db.prepare('SELECT claimed_at FROM issue WHERE id=?').get(issueId) as { claimed_at: number }).claimed_at;
    t.db.prepare('UPDATE knowledge_page SET updated_by=?, updated_at=? WHERE id=?').run('agent:fake', claimed + 1000, pageId);
    const body = await done(issueId);
    expect(body.knowledge_hint).toBeNull();
  });

  it('stillHintsWhenOnlyCommonPageWritten', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    writePage({ scope: 'common' }, `handoff-${issueId}`, '公共页');
    const body = await done(issueId);
    expect(body.knowledge_hint).not.toBeNull();
  });

  it('reclaimUsesLatestClaimTimeSoPreviousRoundPageDoesNotSuppressHint', async () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      const issueId = await makeIssue();
      clock.mockReturnValue(1_000_000);
      await claim(issueId);
      // 第一轮：用非 handoff slug 写页，更新落在第一次 claim 之后
      const pageId = writePage({ scope: 'workspace', workspace_id: workspaceId }, 'round-one-notes', '第一轮记录');
      t.db.prepare('UPDATE knowledge_page SET updated_by=?, updated_at=? WHERE id=?').run('agent:fake', 1_000_500, pageId);
      await request(app).post(`/api/issues/${issueId}/fail`).send({ workspace_id: workspaceId, agent_id: 'fake', reason: '需要重做' });

      // 第二轮重新领取：claimed_at 覆盖为更晚时间，上一轮那页不再算本轮已写
      t.db.prepare("UPDATE issue SET status='待规划' WHERE id=?").run(issueId);
      clock.mockReturnValue(1_020_000);
      await claim(issueId);
      const secondClaim = (t.db.prepare('SELECT claimed_at FROM issue WHERE id=?').get(issueId) as { claimed_at: number }).claimed_at;
      expect(secondClaim).toBe(1_020_000);

      const body = await done(issueId);
      expect(body.knowledge_hint).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('replayReturnsIdenticalBodyIncludingHint', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    const key = randomUUID();
    const payload = { workspace_id: workspaceId, agent_id: 'fake', notes: '' };
    const first = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(200);
    expect((first.body as DoneBody).knowledge_hint).not.toBeNull();
    const replay = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(payload);
    expect(replay.status).toBe(200);
    // 幂等重放必须逐字一致：hint 随首次结果缓存，不因占用已释放而变成 null
    expect(replay.body).toEqual(first.body);
    expect((replay.body as DoneBody).knowledge_hint).not.toBeNull();
  });

  it('doesNotAffectFailOrReleaseResponses', async () => {
    const issueId = await makeIssue();
    await claim(issueId);
    const failed = await request(app).post(`/api/issues/${issueId}/fail`).send({ workspace_id: workspaceId, agent_id: 'fake', reason: '做不了' });
    expect(failed.status).toBe(200);
    expect(failed.body).not.toHaveProperty('knowledge_hint');
  });
});
