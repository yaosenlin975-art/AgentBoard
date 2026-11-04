/**
 * KB-DIFF-S：知识页历史列表瘦身 + 单条 revision 详情。
 *
 * 背景：`/pages/:id/revisions` 原用 `SELECT *`，把整份 `body_snapshot` 一起返回；正文上限已到 200 万字符，
 * 前端一次拉 20 条 = 最坏几十 MB。本测试钉住三件事：
 *  1. 列表默认**不含** `body_snapshot`，只给 `body_bytes` / `body_chars`；
 *  2. `include_body=true` 仍能拿到全文（兼容旧调用方）；
 *  3. 新增 `GET .../revisions/:revision` 取单条全文快照。
 * 另附体积对比：用 200 万字符的页做样本，量化改造前后 20 条列表的 JSON 字节数。
 */
import { describe, expect, it } from 'vitest';
import { createKnowledgePage, getKnowledgeRevision, listKnowledgeRevisions, reviseKnowledgePage } from '../src/db/repos/knowledge.js';
import { createTestDb, type TestDb } from './helpers.js';

const scope = { scope: 'common' as const, workspace_id: null };
const SOURCE = { source_id: 'kb-diff-s', source_type: 'file' as const, locator: 'samples/kb-diff-s.md', captured_at: 1, content_hash: 'a'.repeat(64) };
const EVIDENCE = [{ source_id: 'kb-diff-s', locator: 'samples/kb-diff-s.md:1' }];

function seedPage(db: TestDb, bodyChars: number, revisions: number) {
  const page = createKnowledgePage(db, { domain: 'knowledge',
    scope: 'common',
    title: 'KB-DIFF-S 样本页',
    body_md: 'A'.repeat(bodyChars),
    slug: 'kb-diff-s-sample',
    sources: [SOURCE],
    evidence: EVIDENCE,
    actor: 'test',
  });
  for (let i = 1; i < revisions; i += 1) {
    reviseKnowledgePage(db, page.id, scope, page.revision + i - 1, {
      body_md: `${'A'.repeat(bodyChars - 1)}${String.fromCharCode(66 + (i % 20))}`,
      change_note: `第 ${i} 次修订`,
      actor: 'test',
    });
  }
  return page;
}

describe('历史列表瘦身（默认不带正文）', () => {
  it('默认列表项不含 body_snapshot，但有 body_bytes / body_chars', () => {
    const t2 = createTestDb();
    const db = t2.db;
    const page = seedPage(t2.db, 1000, 3);
    const items = listKnowledgeRevisions(t2.db, page.id, scope, 20, 0) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).not.toHaveProperty('body_snapshot');
      expect(typeof item.body_bytes).toBe('number');
      expect(typeof item.body_chars).toBe('number');
      expect(item.body_chars).toBe(1000);
      expect(item.body_bytes as number).toBeGreaterThanOrEqual(1000);
      // sources / evidence 仍然给（历史列表本来就要展示来源与证据条数）
      expect(Array.isArray(item.sources)).toBe(true);
      expect(Array.isArray(item.evidence)).toBe(true);
    }
  });

  it('include_body=true 时恢复全文（兼容旧调用方）', () => {
    const t2 = createTestDb();
    const db = t2.db;
    const page = seedPage(t2.db, 500, 2);
    const items = listKnowledgeRevisions(t2.db, page.id, scope, 20, 0, true) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(typeof item.body_snapshot).toBe('string');
      expect((item.body_snapshot as string).length).toBe(500);
    }
  });

  it('单条详情端点取回指定 revision 全文', () => {
    const t2 = createTestDb();
    const db = t2.db;
    const page = seedPage(t2.db, 777, 3);
    const one = getKnowledgeRevision(t2.db, page.id, 2, scope);
    expect(one.revision).toBe(2);
    expect(one.body_snapshot.length).toBe(777);
    expect(Array.isArray(one.sources)).toBe(true);
    expect(Array.isArray(one.evidence)).toBe(true);
  });

  it('体积对比：200 万字符页 × 20 条，列表瘦身后显著变小', { timeout: 60_000 }, () => {
    const t2 = createTestDb();
    const db = t2.db;
    const page = seedPage(t2.db, 2_000_000, 20);
    const slim = JSON.stringify({ items: listKnowledgeRevisions(t2.db, page.id, scope, 20, 0) });
    const full = JSON.stringify({ items: listKnowledgeRevisions(t2.db, page.id, scope, 20, 0, true) });
    const slimBytes = Buffer.byteLength(slim);
    const fullBytes = Buffer.byteLength(full);
    // 瘦身版应比全文版小一个数量级（全文版 ≈ 20 × 2MB = 40MB）
    expect(fullBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(slimBytes).toBeLessThan(200 * 1024);
    expect(slimBytes * 50).toBeLessThan(fullBytes);
  });
});
