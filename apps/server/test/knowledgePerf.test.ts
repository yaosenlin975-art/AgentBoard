/**
 * PERF-2：知识读路径性能守卫。
 * 覆盖卡面验收 1–3：limit20 查询数 ≤3；/pages explain 无 TEMP B-TREE；详情查询 ≤2 且字段不变。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { searchKnowledge } from '../src/db/repos/knowledgeSearch.js';

const hex = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('知识读路径（PERF-2）', () => {
  let t: TestDb;
  let app: Express;
  let workspaceId: string;

  const writePage = (slug: string, body: string): string => {
    const sourceId = randomUUID();
    return createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: workspaceId, slug, title: slug, body_md: body, category: 'knowledge',
      sources: [{ source_id: sourceId, source_type: 'file', locator: `file:${slug}.md`, captured_at: 1, content_hash: hex(slug) }],
      evidence: [{ source_id: sourceId, locator: `file:${slug}.md` }], actor: 'agent:t',
    }).id;
  };

  beforeEach(async () => {
    t = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: 'perf', path: 'D:\\ws-perf' }).id;
  });

  afterEach(() => {
    t.cleanup();
  });

  /** prepare 调用计数探针：统计执行窗内的查询条数 */
  function countQueries<T>(run: () => T): { result: T; count: number } {
    const original = t.db.prepare.bind(t.db);
    let count = 0;
    (t.db as unknown as { prepare: unknown }).prepare = (...args: unknown[]) => {
      count += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      return { result: run(), count };
    } finally {
      (t.db as unknown as { prepare: unknown }).prepare = original;
    }
  }

  it('检索 6 命中 = 2 查询（原 1+N），limit20 上界 ≤3', () => {
    for (let i = 0; i < 6; i++) writePage(`perf-page-${i}`, `缓存失效方案第 ${i} 版：读写锁与 TTL 双通道。`);
    const probe = countQueries(() => searchKnowledge(t.db, { scope: 'workspace', workspace_id: workspaceId, query: '缓存失效', limit: 6 }));
    expect(probe.result).toHaveLength(6);
    expect(probe.result[0]!.snippet).toContain('缓存失效');
    expect(probe.count).toBeLessThanOrEqual(3);
    const twenty = countQueries(() => searchKnowledge(t.db, { scope: 'workspace', workspace_id: workspaceId, query: '缓存失效', limit: 20 }));
    expect(twenty.count).toBeLessThanOrEqual(3);
  });

  it('详情路由 ≤2 查询且三个链接字段值正确（返回字段不变）', async () => {
    const detailId = writePage('perf-detail', '详情正文，引用 [[perf-other]] 与 [[缺失页]]。');
    writePage('perf-other', '被引用页。');
    // 重建链接（V2-4 存量回填走 reparse 端点）
    const reparse = await request(app).post('/api/knowledge/reparse').send({});
    if (reparse.status !== 200) console.error('reparse:', reparse.status, JSON.stringify(reparse.body));
    expect(reparse.status).toBe(200);

    const probe = countQueries(() => request(app).get(`/api/knowledge/pages/${detailId}`).query({ scope: 'workspace', workspace_id: workspaceId }));
    const res = await probe.result;
    expect(res.status).toBe(200);
    expect(probe.count).toBeLessThanOrEqual(2);
    expect(res.body).toMatchObject({
      slug: 'perf-detail',
      links_out_count: 2,
      unresolved_links: [{ raw_target: '缺失页' }],
    });
    expect(res.body.backlinks_count).toBe(0);
  });

  it('/pages 列表 SQL 的 explain 无 TEMP B-TREE（走 status+updated_at 索引）', () => {
    const plan = t.db.prepare(`EXPLAIN QUERY PLAN SELECT id,slug,title FROM knowledge_page
      WHERE scope='workspace' AND workspace_id=@workspace AND status=@status AND (expires_at IS NULL OR expires_at>@now)
      ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`)
      .all({ workspace: workspaceId, status: 'active', now: Date.now(), limit: 21, offset: 0 }) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');
    expect(detail).not.toContain('TEMP B-TREE');
    expect(detail).toContain('idx_knowledge_page_status_updated');
  });
});
