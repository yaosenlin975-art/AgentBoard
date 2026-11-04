/**
 * GRAPH-API-PERF：`EXPLAIN QUERY PLAN` 前后对照（索引前 / 索引后）。
 * 跑法：npx tsx scripts/verify/graph-explain.ts
 */
import { createTestDb } from '../../apps/server/test/helpers.js';
import { createKnowledgePage } from '../../apps/server/src/db/repos/knowledge.js';

const scope = { scope: 'common' as const, workspace_id: null };
const SOURCE = { source_id: 's', source_type: 'file' as const, locator: 'x', captured_at: 1, content_hash: 'a'.repeat(64) };

const t = createTestDb();
for (let i = 0; i < 50; i += 1) {
  createKnowledgePage(t.db, { ...scope, title: `t${i}`, body_md: 'x'.repeat(100), slug: `p-${i}`, sources: [SOURCE], evidence: [{ source_id: 's', locator: 'x:1' }], actor: 'bench' });
}

const sql = `SELECT p.id,p.scope,p.workspace_id,p.title,substr(p.body_md,1,2000) AS body_md,length(p.body_md) AS body_chars,r.sources_json,p.category,p.landed
  FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision
  WHERE p.status='active' AND p.scope='common' ORDER BY p.id LIMIT 5001`;

const plan = (label: string) => {
  const rows = t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<Record<string, unknown>>;
  console.log(`=== ${label} ===`);
  for (const row of rows) console.log(`- ${String(row.detail)}`);
  return rows.map((row) => String(row.detail));
};

const before = plan('BEFORE（无 status/scope 索引）');
t.db.prepare('CREATE INDEX IF NOT EXISTS idx_knowledge_page_status_scope_id ON knowledge_page(status, scope, id)').run();
const after = plan('AFTER（idx_knowledge_page_status_scope_id）');
console.log(JSON.stringify({ before, after }, null, 1));
t.cleanup();
