import type { Db } from '../connection.js';
import { knowledgeScopeWhere, type KnowledgeScopeFilter } from './knowledgeScope.js';
import type { KnowledgePage } from '@agentboard/shared';
import {getKnowledgePagesByIds} from './knowledge.js';
import { ValidationError } from '../../errors.js';

export interface KnowledgeSearchInput {
  scope: 'workspace' | 'common' | 'both'; workspace_id?: string; query: string; limit?: number; now?: number;
}
export interface KnowledgeSearchResult {
  page_id: string; scope: KnowledgePage['scope']; workspace_id: string | null; revision: number; title: string;
  /** KB-PAGE-1：调用方按 slug 精确命中要用它（此前只能模糊匹配标题/slug 子串） */
  slug: string;
  /** KB-PAGE-1：搜索结果的状态（当前 SQL 只出 active，字段为将来放宽留口） */
  status: KnowledgePage['status'];
  snippet: string; sources: KnowledgePage['sources']; evidence: KnowledgePage['evidence']; score: number;
}

function validateSearchInput(input: KnowledgeSearchInput): { query: string; limit: number; now: number } {
  const query = input.query?.trim();
  const limit = input.limit ?? 5;
  if (!query || Array.from(query).length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20
    || !['workspace', 'common', 'both'].includes(input.scope)
    || (input.scope === 'common' ? input.workspace_id != null : !input.workspace_id)
    || (input.now !== undefined && !Number.isSafeInteger(input.now))) throw new ValidationError('知识查询参数不合法');
  return { query, limit, now: input.now ?? Date.now() };
}

export function searchKnowledge(db: Db, input: KnowledgeSearchInput): KnowledgeSearchResult[] {
  const { query, limit, now } = validateSearchInput(input);
  const scopeSql = knowledgeScopeWhere(input as KnowledgeScopeFilter, 'p.');
  const params: Record<string, string | number> = { now, limit };
  if (input.scope !== 'common') params.workspace = input.workspace_id!;
  const long = Array.from(query).length >= 3;
  let sql: string;
  if (long) {
    params.query = `"${query.replaceAll('"', '""')}"`;
    sql = `SELECT p.id,p.scope,p.workspace_id,bm25(knowledge_fts,0,5,1) AS score FROM knowledge_fts JOIN knowledge_page p ON p.id=knowledge_fts.page_id
      WHERE knowledge_fts MATCH @query AND ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now)
      ORDER BY score,p.scope='workspace' DESC,p.updated_at DESC,p.id LIMIT @limit`;
  } else {
    // ponytail: 1–2 code-point queries scan only eligible scope rows; trigram cannot index them.
    params.query = `%${query.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    sql = `SELECT p.id,p.scope,p.workspace_id,CASE WHEN p.title LIKE @query ESCAPE '!' THEN -1 ELSE 0 END AS score FROM knowledge_page p
      WHERE ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now) AND (p.title LIKE @query ESCAPE '!' OR p.body_md LIKE @query ESCAPE '!')
      ORDER BY score,p.scope='workspace' DESC,p.updated_at DESC,p.id LIMIT @limit`;
  }
  const rows = db.prepare(sql).all(params) as Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; score: number }>;
  // PERF-2（F4）：批量取页——检索 1 条 + 批量 1 条 = 2 查询（原为 1+N）
  const pagesById = new Map(getKnowledgePagesByIds(db, rows.map(row => row.id)).map(page => [page.id, page]));
  return rows.map(row => {
    const page = pagesById.get(row.id)!;
    const position = page.body_md.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, position - 100);
    return { page_id: page.id, scope: page.scope, workspace_id: page.workspace_id, revision: page.revision, title: page.title,
      slug: page.slug, status: page.status,
      snippet: page.body_md.slice(start, start + 1200), sources: page.sources, evidence: page.evidence, score: row.score };
  });
}

/**
 * STORE-4c：scope=both 的跨库检索——中心库 common 一路 + 工作区库该工作区一路，应用层合并。
 *
 * 排序口径（父卡定死）：合并后统一按 `(updated_at desc, id asc)` 排序切片——bm25 分数是各库
 * FTS 索引内的相对值（词频/文档频率不同库不可比），跨库按分数排序不诚实；单库检索
 * （`searchKnowledge`）保留原 score 排序不变。
 * 无漏页：每路按同一排序键取前 `limit+1` 条（全局前 limit 必在两路各自前 limit 的并集内）。
 * truncated：任一路命中数超过 limit（返回集之外还有命中）即置位——两路合并后拿不到精确总数，
 * 不报假总数。
 */
export interface KnowledgeSearchAcrossResult {
  items: KnowledgeSearchResult[];
  truncated: boolean;
}

export function searchKnowledgeAcrossDbs(center: Db, workspaceDb: Db, input: KnowledgeSearchInput): KnowledgeSearchAcrossResult {
  const { query, limit, now } = validateSearchInput(input);
  const long = Array.from(query).length >= 3;
  type SideRow = { id: string; score: number; updated_at: number };
  const fetchSide = (db: Db, filter: { scope: 'common' } | { scope: 'workspace'; workspace_id: string }): SideRow[] => {
    const scopeSql = knowledgeScopeWhere(filter as KnowledgeScopeFilter, 'p.');
    const params: Record<string, string | number> = { now, limit: limit + 1 };
    if (filter.scope !== 'common') params.workspace = filter.workspace_id;
    let sql: string;
    if (long) {
      params.query = `"${query.replaceAll('"', '""')}"`;
      sql = `SELECT p.id,p.updated_at,bm25(knowledge_fts,0,5,1) AS score FROM knowledge_fts JOIN knowledge_page p ON p.id=knowledge_fts.page_id
        WHERE knowledge_fts MATCH @query AND ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now)
        ORDER BY p.updated_at DESC,p.id LIMIT @limit`;
    } else {
      params.query = `%${query.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
      sql = `SELECT p.id,p.updated_at,CASE WHEN p.title LIKE @query ESCAPE '!' THEN -1 ELSE 0 END AS score FROM knowledge_page p
        WHERE ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now) AND (p.title LIKE @query ESCAPE '!' OR p.body_md LIKE @query ESCAPE '!')
        ORDER BY p.updated_at DESC,p.id LIMIT @limit`;
    }
    return db.prepare(sql).all(params) as SideRow[];
  };
  const commonSide = fetchSide(center, { scope: 'common' });
  const workspaceSide = fetchSide(workspaceDb, { scope: 'workspace', workspace_id: input.workspace_id! });
  // 两路批量取页（各一次 IN 查询；行数 ≤ limit+1，无 N+1），合并排序后再展开结果字段
  const pagesById = new Map([
    ...getKnowledgePagesByIds(center, commonSide.map(row => row.id)),
    ...getKnowledgePagesByIds(workspaceDb, workspaceSide.map(row => row.id)),
  ].map(page => [page.id, page]));
  const scoreById = new Map([...commonSide, ...workspaceSide].map(row => [row.id, row.score]));
  const merged = mergeKnowledgeRowsByRecency([commonSide, workspaceSide]).slice(0, limit);
  return {
    items: merged.map(row => {
      const page = pagesById.get(row.id)!;
      const position = page.body_md.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, position - 100);
      return { page_id: page.id, scope: page.scope, workspace_id: page.workspace_id, revision: page.revision, title: page.title,
        slug: page.slug, status: page.status,
        snippet: page.body_md.slice(start, start + 1200), sources: page.sources, evidence: page.evidence, score: scoreById.get(row.id)! };
    }),
    truncated: commonSide.length > limit || workspaceSide.length > limit,
  };
}

/**
 * STORE-4c：跨库行合并的统一排序键 `(updated_at desc, id asc)`（跨库可比；同键两次调用结果一致）。
 * /search、/pages 两路合并共用。
 */
export function mergeKnowledgeRowsByRecency<T extends { id: string; updated_at: number }>(lists: readonly (readonly T[])[]): T[] {
  return lists.flat().sort((left, right) => (right.updated_at - left.updated_at) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** /pages 列表行（路由原内联 SQL 下沉到 repo，单库与跨库两路共用同一份列/过滤/排序口径） */
export interface KnowledgePageListRow {
  id: string; scope: 'common' | 'workspace'; workspace_id: string | null; slug: string; title: string;
  status: string; revision: number; expires_at: number | null; created_by: string; updated_by: string;
  created_at: number; updated_at: number; category: string; landed: string | null; domain: string | null;
}

export interface KnowledgePageListFilter {
  scope: 'common' | 'workspace' | 'both';
  workspace_id?: string;
  status: string;
  include_expired: boolean;
  offset: number;
  limit: number;
}

/** 单库 /pages 查询（scope 过滤 + 状态/过期过滤 + (updated_at desc, id) 排序分页） */
export function listKnowledgePageRows(db: Db, input: KnowledgePageListFilter): KnowledgePageListRow[] {
  const scopeSql = knowledgeScopeWhere(input as KnowledgeScopeFilter);
  const params: Record<string, number | string> = { limit: input.limit, offset: input.offset };
  if (input.scope !== 'common') params.workspace = input.workspace_id!;
  if (input.status !== 'all') params.status = input.status;
  if (!input.include_expired) params.now = Date.now();
  return db.prepare(`SELECT id,scope,workspace_id,slug,title,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed,domain FROM knowledge_page WHERE ${scopeSql} ${input.status !== 'all' ? 'AND status=@status' : ''} ${input.include_expired ? '' : 'AND (expires_at IS NULL OR expires_at>@now)'} ORDER BY updated_at DESC,id LIMIT @limit OFFSET @offset`).all(params) as KnowledgePageListRow[];
}

/**
 * STORE-4c：scope=both 的 /pages 跨库合并——中心库 common 一路 + 工作区库该工作区一路。
 * 每路取前 `offset+limit+1` 条（窗口法），合并排序后切 `[offset, offset+limit)` 窗口；
 * `next_offset` 由合并窗口外是否还有行精确判定（两路各自计数，不报假总数）。
 */
export function listKnowledgePagesAcrossDbs(center: Db, workspaceDb: Db, input: KnowledgePageListFilter): { items: KnowledgePageListRow[]; next_offset: number | null } {
  const window = input.offset + input.limit + 1;
  const commonSide = listKnowledgePageRows(center, { ...input, scope: 'common', offset: 0, limit: window });
  const workspaceSide = listKnowledgePageRows(workspaceDb, { ...input, scope: 'workspace', workspace_id: input.workspace_id, offset: 0, limit: window });
  const merged = mergeKnowledgeRowsByRecency([commonSide, workspaceSide]);
  const end = input.offset + input.limit;
  return {
    items: merged.slice(input.offset, end),
    next_offset: merged.length > end ? end : null,
  };
}
