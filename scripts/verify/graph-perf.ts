/**
 * GRAPH-API-PERF 分层计时：图接口的每一层耗时（改造前后各跑一次）。
 *
 * 分层：① COUNT(*) 统计 ② 取行 SQL（含 body_md 的 I/O） ③ sources_json 解析
 * ④ 关键词/三元组边构建（buildKnowledgeGraph 的 CPU 大头） ⑤ 响应序列化。
 * 夹具：24 页（其中 1 页 200 万字符，复现线上真实形态）与 200 页两档。
 *
 * 跑法：npx tsx scripts/verify/graph-perf.ts
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createTestDb } from '../../apps/server/test/helpers.js';
import { createKnowledgePage, listKnowledgeGraphRows } from '../../apps/server/src/db/repos/knowledge.js';
import { buildKnowledgeGraph } from '../../apps/server/src/services/knowledgeGraph.js';

const scope = { scope: 'common' as const, workspace_id: null };
const SOURCE = (i: number) => ({ source_id: `src-${i}`, source_type: 'file' as const, locator: `samples/f${i}.md`, captured_at: 1, content_hash: 'a'.repeat(63) + (i % 10) });
const EVIDENCE = (i: number) => [{ source_id: `src-${i}`, locator: `samples/f${i}.md:1` }];

function seed(db: ReturnType<typeof createTestDb>['db'], pages: number, bigBodyChars: number): void {
  for (let i = 0; i < pages; i += 1) {
    const body = i === 0 && bigBodyChars > 0
      ? `# 大页\n${'知识图谱性能测试语料'.repeat(Math.ceil(bigBodyChars / 10))}`.slice(0, bigBodyChars)
      : `# 页 ${i}\n内容 ${i} 关键词 alpha${i % 7} beta${i % 5} gamma${i % 3}`;
    createKnowledgePage(db, { ...scope, title: `图页 ${i}`, body_md: body, slug: `graph-perf-${i}`, sources: [SOURCE(i % 12)], evidence: EVIDENCE(i % 12), actor: 'bench' });
  }
}

function measure(label: string, pages: number, bigBodyChars: number) {
  const t = createTestDb();
  seed(t.db, pages, bigBodyChars);
  const t0 = performance.now();
  const res = listKnowledgeGraphRows(t.db, { scope: 'common' }, 5000);
  const t1 = performance.now();
  const graph = buildKnowledgeGraph(res.rows, { edgeKinds: ['link', 'source', 'keyword'], links: [] });
  const t2 = performance.now();
  const payload = JSON.stringify(graph);
  const t3 = performance.now();
  const row = { label, pages, bigBodyChars, rows_ms: +(t1 - t0).toFixed(1), graph_ms: +(t2 - t1).toFixed(1), serialize_ms: +(t3 - t2).toFixed(1), total_ms: +(t3 - t0).toFixed(1), nodes: graph.nodes.length, edges: graph.edges.length, payload_bytes: Buffer.byteLength(payload) };
  t.cleanup();
  return row;
}

const out = [measure('24 页（含 1 页 200 万字符）', 24, 2_000_000), measure('200 页（含 1 页 200 万字符）', 200, 2_000_000)];
writeFileSync('Docs/verification/2026-11-04-graph-api-perf.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
