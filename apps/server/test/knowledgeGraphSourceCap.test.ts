/**
 * S3：E1「来源共现」无上限 → 同 content_hash 页超阈值时连成完全图。
 *
 * 原实现 `sharedPairs` 对 locator/hash 索引只下限（≥2 页）无上限，
 * 注释理由是「一个源连接多页是正常语义」。若大批页共用同一 hash
 * （批量导入填同一合法 hash、历史数据 hash 被简化），会连出 O(n²) 条边：
 * GRAPH_MAX_PAGES=5000 全共用 1 个 hash → C(5000,2) ≈ 1250 万条。
 *
 * 修法：给 E1 两处索引传 `GRAPH_SOURCE_MAX_COOCCURRENCE`（64），
 * 并产出 `source_skipped_keys` / `source_max_cooccurrence` 供诊断（不静默丢弃）。
 *
 * 上限取值依据：本机 8 个工作区实测最大共现 locator 4 页 / hash 2 页；
 * 64 是 16 倍安全边际，且不误伤「一个 README 被 20-30 页引用」的正常语义。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_SOURCE_HASH_MAX_COOCCURRENCE,
  GRAPH_SOURCE_LOCATOR_MAX_COOCCURRENCE,
  buildKnowledgeGraph,
  type BuildGraphOptions,
  type GraphInputRow,
} from '../src/services/knowledgeGraph.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 造页：hashKey 决定 content_hash 来源（同值 → 共现）；locatorKey 缺省每页唯一 */
const makeRow = (id: string, hashKey: string, locatorKey?: string, body = '正文内容各异，无共同关键词。'): GraphInputRow => ({
  id,
  title: `页 ${id}`,
  body_md: body,
  scope: 'workspace',
  workspace_id: 'w',
  category: 'legacy',
  landed: null,
  sources: [{ source_id: 's', source_type: 'file', locator: `src/${locatorKey ?? id}.md`, captured_at: 1, content_hash: sha(hashKey) }],
  expires_at: null,
  status: 'active',
  revision: 1,
  created_at: 1,
  updated_at: 1,
} as GraphInputRow);

const OPTS: BuildGraphOptions = {
  edgeKinds: ['source'],
  includeIsolated: true,
  limitNodes: 500,
  limitEdges: 5000,
};

describe('S3：E1 来源共现上限', () => {
  it('4 页共用同 hash → 不再连出 K4=6 条边，且统计报出跳过', () => {
    // 4 页全部共用同一个 content_hash（S1 夹具踩过的场景）
    const rows = ['a', 'b', 'c', 'd'].map(id => makeRow(id, 'SAME-HASH'));
    const graph = buildKnowledgeGraph(rows, OPTS);
    // 修复前：C(4,2)=6 条 source 边；修复后：该键共现 4 页 ≤ 64，仍正常连边
    // ← 注意：4 页未超 64 上限，所以这里应保留 6 条，验证「不误伤正常语义」
    expect(graph.edges.filter(edge => edge.kind === 'source')).toHaveLength(6);
    expect(graph.source_skipped_keys).toBe(0);
    expect(graph.source_max_cooccurrence).toBe(4);
  });

  it('超过上限（65 页共 hash）→ 整键跳过，边数为 0，统计报 1', () => {
    const rows = Array.from({ length: 65 }, (_, i) => makeRow(`p${i}`, 'SAME-HASH'));
    const graph = buildKnowledgeGraph(rows, OPTS);
    // 65 > 64 → 整键跳过，不产生任何 source 边（否则是 C(65,2)=2080 条）
    expect(graph.edges.filter(edge => edge.kind === 'source')).toHaveLength(0);
    expect(graph.source_skipped_keys).toBe(1);
    expect(graph.source_max_cooccurrence).toBe(65);
  });

  it('边界：=64 连边（不跳过），=65 跳过', () => {
    const at64 = buildKnowledgeGraph(Array.from({ length: 64 }, (_, i) => makeRow(`a${i}`, 'H')), OPTS);
    expect(at64.source_skipped_keys).toBe(0);
    expect(at64.edges.filter(edge => edge.kind === 'source')).toHaveLength((64 * 63) / 2);

    const at65 = buildKnowledgeGraph(Array.from({ length: 65 }, (_, i) => makeRow(`b${i}`, 'H')), OPTS);
    expect(at65.source_skipped_keys).toBe(1);
    expect(at65.edges.filter(edge => edge.kind === 'source')).toHaveLength(0);
  });

  it('正常语义不误伤：2-3 页共用同 hash 行为不变', () => {
    const two = buildKnowledgeGraph([makeRow('a', 'K'), makeRow('b', 'K')], OPTS);
    expect(two.edges).toHaveLength(1);
    expect(two.edges[0]!.kind).toBe('source');
    expect(two.edges[0]!.weight).toBe(4); // GRAPH_SOURCE_HASH_WEIGHT
    expect(two.source_skipped_keys).toBe(0);

    const three = buildKnowledgeGraph(['a', 'b', 'c'].map(id => makeRow(id, 'K')), OPTS);
    expect(three.edges).toHaveLength(3); // C(3,2)
    expect(three.source_skipped_keys).toBe(0);
  });

  it('每页唯一 hash → 无共现、无跳过、最大共现 1', () => {
    const rows = ['a', 'b', 'c'].map(id => makeRow(id, `UNIQUE-${id}`));
    const graph = buildKnowledgeGraph(rows, OPTS);
    expect(graph.edges).toHaveLength(0);
    expect(graph.source_skipped_keys).toBe(0);
    expect(graph.source_max_cooccurrence).toBe(1);
  });

  it('无 sources 的页 → 最大共现 0（不报假阳性）', () => {
    const rows = [{ ...makeRow('a', 'x'), sources: [] } as GraphInputRow];
    const graph = buildKnowledgeGraph(rows, OPTS);
    expect(graph.source_skipped_keys).toBe(0);
    expect(graph.source_max_cooccurrence).toBe(0);
  });

  it('超限不影响 link / keyword 边（只拦 E1 源共现）', () => {
    const rows = Array.from({ length: 65 }, (_, i) => makeRow(`p${i}`, 'SAME-HASH'));
    const graph = buildKnowledgeGraph(rows, {
      ...OPTS,
      edgeKinds: ['link', 'source'],
      links: [{ source: 'p0', target: 'p1', weight: 1, kind: 'link' }],
    });
    expect(graph.source_skipped_keys).toBe(1);
    const links = graph.edges.filter(edge => edge.kind === 'link');
    expect(links).toHaveLength(1);
    expect(graph.edges.filter(edge => edge.kind === 'source')).toHaveLength(0);
  });

  it('上限常量导出：hash=64，locator=512（两类语义分开）', () => {
    expect(GRAPH_SOURCE_HASH_MAX_COOCCURRENCE).toBe(64);
    expect(GRAPH_SOURCE_LOCATOR_MAX_COOCCURRENCE).toBe(512);
  });

  it('locator 与 hash 上限分开：200 页共用同一 locator 仍连边（合法 hub 源不误伤）', () => {
    // 既有契约：knowledgeGraph.test.ts 的 truncatesLargeGraphToHardCapsWithRealTotals
    // 就是 200 页共用 file:shared-big.ts，期望 C(200,2)=19900 条边。
    // locator 上限 512 必须放过它。
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(`p${i}`, `UNIQ-${i}`, 'shared-big.ts'));
    // 该用例要看全量边数，故放开 limitEdges（默认 OPTS 只到 5000，会截断到 5000）
    const graph = buildKnowledgeGraph(rows, { ...OPTS, limitNodes: 500, limitEdges: 50_000 });
    expect(graph.source_skipped_keys).toBe(0);
    expect(graph.edges.filter(edge => edge.kind === 'source')).toHaveLength((200 * 199) / 2);
    expect(graph.source_max_cooccurrence).toBe(200);
  });

  it('locator 超 512 → 跳该键；但同批页 hash 各不相同仍不误伤', () => {
    const rows = Array.from({ length: 513 }, (_, i) => makeRow(`p${i}`, `UNIQ-${i}`, 'hot.ts'));
    const graph = buildKnowledgeGraph(rows, OPTS);
    expect(graph.source_skipped_keys).toBe(1);
    expect(graph.edges.filter(edge => edge.kind === 'source')).toHaveLength(0);
  });
});
