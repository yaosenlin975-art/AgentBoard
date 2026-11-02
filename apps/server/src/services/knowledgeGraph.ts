/**
 * KB-GRAPH 图聚合（只读）：把知识页按「来源共现」(E1) 与「关键词共现」(E2) 连边。
 *
 * E1（主边）：共享 `locator` 每条权重 3；共享 `content_hash` 每个权重 4 → 边权 = 3×共享locator数 + 4×共享hash数。
 * E2（弱边，默认开）：标题+正文分词后去停用词/单字/纯标点；共享实体词 ≥2 或 trigram 重叠 ≥3 才建边，权重 1。
 * 同一对节点同时命中 E1/E2 → 只保留一条 `kind:"source"`，权重取 E1（较高），E2 不叠加。
 *
 * 截断：按 degree 从高到低（同 degree 按 id 升序，保证稳定）取前 `limitNodes`；边取两端都保留的、按
 * weight 降序（同权重按 source,target 升序）取前 `limitEdges`。`node_total`/`edge_total` 是**截断前**的
 * 真实数量（已按 include_isolated 过滤），用于前端提示「还有多少没显示」。
 */
import type { KnowledgeSource } from '@agentboard/shared';
import type { KnowledgeGraphRow } from '../db/repos/knowledge.js';

/** 单次图聚合最多加载的知识页数；超限时响应 pages_truncated:true 并在日志 warn（不静默） */
export const GRAPH_MAX_PAGES = 5000;
export const GRAPH_MAX_NODES = 150;
export const GRAPH_MAX_EDGES = 500;
export const GRAPH_SOURCE_LOCATOR_WEIGHT = 3;
export const GRAPH_SOURCE_HASH_WEIGHT = 4;
export const GRAPH_KEYWORD_WEIGHT = 1;
export const GRAPH_KEYWORD_MIN_TERMS = 2;
export const GRAPH_KEYWORD_MIN_TRIGRAMS = 3;

export interface KnowledgeGraphNode {
  id: string; title: string; scope: 'workspace' | 'common'; workspace_id: string | null;
  source_count: number; degree: number;
}
export interface KnowledgeGraphEdge { source: string; target: string; kind: 'link' | 'source' | 'keyword'; weight: number }
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  truncated: boolean;
  /** 'pages' 优先（页面集合本身不全），其次 'nodes'，再次 'edges'；未截断为 null */
  truncated_reason: 'pages' | 'nodes' | 'edges' | null;
  /** 单次加载上限被命中：图只覆盖已加载的页面集合 */
  pages_truncated: boolean;
  /** 该 scope/workspace 下活跃页总数（与加载过滤条件一致，不受加载上限影响）：唯一诚实的“全量”信息 */
  page_total: number;
  /** 本次实际加载的页数；`pages_truncated` 为 true 时必然小于 `page_total` */
  pages_loaded: number;
  node_total: number;
  edge_total: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'by',
  'as', 'at', 'it', 'this', 'that', 'from', 'not', 'but', 'if', 'then', 'than', 'so', 'we', 'you', 'they',
  '一个', '我们', '他们', '以及', '并且', '但是', '因为', '所以', '如果', '可以', '需要', '使用', '进行', '通过',
  '对于', '其中', '没有', '已经', '之后', '之前', '这个', '那个', '这些', '那些', '啥', '怎么办',
]);

const WORD_PATTERN = /[a-z0-9][a-z0-9_-]+/g;
const HAN_PATTERN = /\p{Script=Han}+/gu;

/** 实体词：拉丁/数字词（长度 ≥2）+ 汉字段的 2-gram（单字丢弃），去停用词 */
export function entityTerms(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const terms = new Set<string>();
  for (const match of lowered.matchAll(WORD_PATTERN)) {
    if (!STOPWORDS.has(match[0])) terms.add(match[0]);
  }
  for (const run of lowered.match(HAN_PATTERN) ?? []) {
    if (run.length === 2) {
      if (!STOPWORDS.has(run)) terms.add(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOPWORDS.has(bigram)) terms.add(bigram);
    }
  }
  return terms;
}

/** trigram：去掉空白与标点后按 3 字符滑窗 */
export function trigrams(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= compact.length; index += 1) grams.add(compact.slice(index, index + 3));
  return grams;
}

const pairKey = (left: string, right: string): string => (left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`);
const TERM_DF_LIMIT = 64; // 词出现在过多页时跳过，避免 O(n²) 爆炸（这些词区分度也低）

type PairState = { linkWeight: number; sourceWeight: number; termHits: number; trigramHits: number };

function addPair(map: Map<string, PairState>, left: string, right: string, apply: (state: PairState) => void): void {
  const key = pairKey(left, right);
  const state = map.get(key) ?? { linkWeight: 0, sourceWeight: 0, termHits: 0, trigramHits: 0 };
  apply(state);
  map.set(key, state);
}

/** maxDf：仅关键词索引限流（词命中页过多时区分度低）；来源 locator/hash 索引不限流，一个源连接多页是正常语义 */
function sharedPairs(index: Map<string, string[]>, visit: (left: string, right: string) => void, maxDf = Number.MAX_SAFE_INTEGER): void {
  for (const pages of index.values()) {
    if (pages.length < 2 || pages.length > maxDf) continue;
    for (let i = 0; i < pages.length; i += 1) {
      for (let j = i + 1; j < pages.length; j += 1) visit(pages[i]!, pages[j]!);
    }
  }
}

function indexBy(rows: KnowledgeGraphRow[], keysOf: (row: KnowledgeGraphRow) => Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const list = index.get(key);
      if (list) list.push(row.id);
      else index.set(key, [row.id]);
    }
  }
  return index;
}

export interface BuildGraphOptions {
  edgeKinds: Array<'link' | 'source' | 'keyword'>;
  /** V2-4：显式 `[[双链]]` 边（由调用方从 knowledge_link 读出）；缺省视为无 */
  links?: Array<{ source: string; target: string; weight: number }>;
  includeIsolated: boolean;
  limitNodes: number;
  limitEdges: number;
  /** 页面集合本身是否被 GRAPH_MAX_PAGES 截断 */
  pagesTruncated?: boolean;
  /** 该 scope 下活跃页总数（调用方用与加载完全相同的过滤条件统计）；缺省按已加载行数处理 */
  pageTotal?: number;
}

export function buildKnowledgeGraph(rows: KnowledgeGraphRow[], options: BuildGraphOptions): KnowledgeGraph {
  const byId = new Map(rows.map(row => [row.id, row]));
  const pairs = new Map<string, PairState>();
  const wantLink = options.edgeKinds.includes('link');
  const wantSource = options.edgeKinds.includes('source');
  const wantKeyword = options.edgeKinds.includes('keyword');

  if (wantLink) {
    for (const link of options.links ?? []) {
      if (!byId.has(link.source) || !byId.has(link.target)) continue;
      addPair(pairs, link.source, link.target, state => { state.linkWeight += link.weight; });
    }
  }

  if (wantSource) {
    const locatorIndex = indexBy(rows, row => row.sources.map((source: KnowledgeSource) => `l:${source.locator}`));
    sharedPairs(locatorIndex, (left, right) => addPair(pairs, left, right, state => { state.sourceWeight += GRAPH_SOURCE_LOCATOR_WEIGHT; }));
    const hashIndex = indexBy(rows, row => row.sources.map((source: KnowledgeSource) => `h:${source.content_hash}`));
    sharedPairs(hashIndex, (left, right) => addPair(pairs, left, right, state => { state.sourceWeight += GRAPH_SOURCE_HASH_WEIGHT; }));
  }

  if (wantKeyword && rows.length > 1) {
    const texts = new Map(rows.map(row => [row.id, `${row.title}\n${row.body_md}`]));
    const termIndex = indexBy(rows, row => entityTerms(`${row.title}\n${row.body_md}`));
    sharedPairs(termIndex, (left, right) => addPair(pairs, left, right, state => { state.termHits += 1; }), TERM_DF_LIMIT);
    const gramIndex = indexBy(rows, row => trigrams(texts.get(row.id)!));
    sharedPairs(gramIndex, (left, right) => addPair(pairs, left, right, state => { state.trigramHits += 1; }), TERM_DF_LIMIT);
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const [key, state] of pairs) {
    const [left, right] = key.split('\u0000') as [string, string];
    if (!byId.has(left) || !byId.has(right)) continue;
    // 合并优先级：显式双链 > 共享来源 > 关键词共现
    if (state.linkWeight > 0) {
      edges.push({ source: left, target: right, kind: 'link', weight: state.linkWeight });
      continue;
    }
    if (state.sourceWeight > 0) {
      edges.push({ source: left, target: right, kind: 'source', weight: state.sourceWeight });
      continue;
    }
    if (wantKeyword && (state.termHits >= GRAPH_KEYWORD_MIN_TERMS || state.trigramHits >= GRAPH_KEYWORD_MIN_TRIGRAMS)) {
      edges.push({ source: left, target: right, kind: 'keyword', weight: GRAPH_KEYWORD_WEIGHT });
    }
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const universe = rows
    .map(row => ({
      id: row.id,
      title: row.title,
      scope: row.scope,
      workspace_id: row.workspace_id,
      source_count: new Set(row.sources.map((source: KnowledgeSource) => source.locator)).size,
      degree: degree.get(row.id) ?? 0,
    }))
    .filter(node => options.includeIsolated || node.degree > 0);

  const nodeTotal = universe.length;
  const edgeTotal = edges.length;
  const keptNodes = [...universe]
    .sort((left, right) => (right.degree - left.degree) || left.id.localeCompare(right.id))
    .slice(0, options.limitNodes);
  const keptIds = new Set(keptNodes.map(node => node.id));
  const keptEdges = edges
    .filter(edge => keptIds.has(edge.source) && keptIds.has(edge.target))
    .sort((left, right) => (right.weight - left.weight) || left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
    .slice(0, options.limitEdges);

  const nodesCut = keptNodes.length < nodeTotal;
  const edgesCut = keptEdges.length < edgeTotal;
  const pagesTruncated = options.pagesTruncated === true;
  const pagesLoaded = rows.length;
  return {
    nodes: keptNodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: keptEdges,
    truncated: pagesTruncated || nodesCut || edgesCut,
    truncated_reason: pagesTruncated ? 'pages' : nodesCut ? 'nodes' : edgesCut ? 'edges' : null,
    pages_truncated: pagesTruncated,
    page_total: options.pageTotal ?? pagesLoaded,
    pages_loaded: pagesLoaded,
    node_total: nodeTotal,
    edge_total: edgeTotal,
  };
}
