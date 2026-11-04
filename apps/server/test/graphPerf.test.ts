/**
 * GRAPH-API-PERF：图接口性能回归守卫。
 *
 * 线上实测 `GET /api/knowledge/graph` 24 节点 22–23 秒。分层定位结论：
 * ① 取行 SQL 把 `body_md` 全文拉回（库里有 200 万字符级页）；
 * ② `buildKnowledgeGraph` 的关键词边对**每页全文**做 entityTerms + trigrams；
 * ③ `knowledge_page` 缺 `(status,scope,id)` 索引 → `ORDER BY id` 走 TEMP B-TREE。
 * 本测试钉住三条改法，并用 24 页夹具（含 1 页 200 万字符）守 200ms 预算。
 */
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createTestDb } from './helpers.js';
import { GRAPH_TEXT_EXCERPT, createKnowledgePage, listKnowledgeGraphRows } from '../src/db/repos/knowledge.js';
import { buildKnowledgeGraph } from '../src/services/knowledgeGraph.js';

const scope = { scope: 'common' as const, workspace_id: null };
const SOURCE = { source_id: 'src-1', source_type: 'file' as const, locator: 'samples/g.md', captured_at: 1, content_hash: 'a'.repeat(64) };

function seed(db: ReturnType<typeof createTestDb>['db'], pages: number, bigChars: number): void {
  for (let i = 0; i < pages; i += 1) {
    const body = i === 0 && bigChars > 0
      ? '知识图谱性能测试语料'.repeat(Math.ceil(bigChars / 10)).slice(0, bigChars)
      : `# 页 ${i}\n内容 ${i} alpha${i % 7} beta${i % 5}`;
    createKnowledgePage(db, { domain: 'knowledge', ...scope, title: `图页 ${i}`, body_md: body, slug: `graph-perf-test-${i}`, sources: [SOURCE], evidence: [{ source_id: 'src-1', locator: 'samples/g.md:1' }], actor: 'test' });
  }
}

describe('图查询只取正文摘要（不拉全文）', () => {
  it('200 万字符页的 body_md 被截断到 GRAPH_TEXT_EXCERPT，body_chars 仍是全文长度', () => {
    const t = createTestDb();
    seed(t.db, 3, 2_000_000);
    const { rows } = listKnowledgeGraphRows(t.db, { scope: 'common' }, 5000);
    const big = rows.find((row) => row.body_chars === 2_000_000);
    expect(big, '应能找到 200 万字符那页').toBeTruthy();
    expect(big!.body_md.length).toBe(GRAPH_TEXT_EXCERPT);
    expect(big!.body_chars).toBe(2_000_000);
    t.cleanup();
  });

  it('索引 (status,scope,id) 存在', () => {
    const t = createTestDb();
    const names = (t.db.prepare('PRAGMA index_list(knowledge_page)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toContain('idx_knowledge_page_status_scope_id');
    t.cleanup();
  });
});

describe('性能预算（回归守卫）', () => {
  it('24 页（含 1 页 200 万字符）取行 + 建图 < 200ms', () => {
    const t = createTestDb();
    seed(t.db, 24, 2_000_000);
    const start = performance.now();
    const { rows } = listKnowledgeGraphRows(t.db, { scope: 'common' }, 5000);
    const graph = buildKnowledgeGraph(rows, { edgeKinds: ['link', 'source', 'keyword'], links: [] });
    const elapsed = performance.now() - start;
    expect(graph.nodes.length).toBe(24);
    // 改造前实测 500ms+（线上 HTTP 23s）；改造后 ~22ms，这里留 200ms 预算
    expect(elapsed).toBeLessThan(200);
    t.cleanup();
  });

  it('200 页（含 1 页 200 万字符）< 800ms', () => {
    const t = createTestDb();
    seed(t.db, 200, 2_000_000);
    const start = performance.now();
    const { rows } = listKnowledgeGraphRows(t.db, { scope: 'common' }, 5000);
    const graph = buildKnowledgeGraph(rows, { edgeKinds: ['link', 'source', 'keyword'], links: [] });
    const elapsed = performance.now() - start;
    expect(graph.nodes.length).toBe(200);
    expect(elapsed).toBeLessThan(800);
    t.cleanup();
  });
});
