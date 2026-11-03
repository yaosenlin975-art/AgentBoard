import { Router } from 'express';
import { z } from 'zod';
import type { KnowledgeScope } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, ValidationError } from '../errors.js';
import { createKnowledgePage, getKnowledgePage, listKnowledgeGraphRows, listKnowledgeRevisions, reviseKnowledgePage, setKnowledgePageStatus } from '../db/repos/knowledge.js';
import { GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_PAGES, buildKnowledgeGraph } from '../services/knowledgeGraph.js';
import { countBacklinks, countOutgoingLinks, listBacklinks, listResolvedLinks, listUnresolvedLinks, reparseAllPages } from '../services/knowledgeLinks.js';
import { searchKnowledge } from '../db/repos/knowledgeSearch.js';
import { validateKnowledgeScope } from '../services/knowledge.js';
import { httpMutation } from '../services/idempotency.js';
import { knowledgeCreateSchema, knowledgeReviseSchema, knowledgeActionSchema, knowledgeScopeFields } from './schemas.js';

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
const integerQuery = (fallback: number, max: number) => z.coerce.number().int().min(0).max(max).default(fallback);
function scopeOf(raw: unknown): KnowledgeScope {
  const value = parse(z.object(knowledgeScopeFields), raw) as KnowledgeScope;
  validateKnowledgeScope(value);
  return value;
}
export interface KnowledgeRouterOptions {
  /** 单次图聚合可加载的最大页数；默认 GRAPH_MAX_PAGES（测试可调小以验证截断标志） */
  maxGraphPages?: number;
}

export function createKnowledgeRouter(db: Db, options: KnowledgeRouterOptions = {}): Router {
  const maxGraphPages = options.maxGraphPages ?? GRAPH_MAX_PAGES;
  const router = Router();
  router.get('/search', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), q: z.string(), limit: integerQuery(5, 20).refine(n => n > 0) }).strict(), req.query);
    res.json(searchKnowledge(db, { ...input, query: input.q }));
  });
  /**
   * KB-GRAPH 图聚合（只读）。
   * 强制上限：节点 ≤150、边 ≤500（请求值超过按硬上限裁剪），超出后按 degree 降序截断并置 	runcated。
   */
  router.get('/graph', (req, res) => {
    const input = parse(z.object({
      scope: z.enum(['common', 'workspace', 'both']).default('both'),
      workspace_id: z.string().min(1).optional(),
      limit_nodes: integerQuery(GRAPH_MAX_NODES, 5000).refine(n => n > 0),
      limit_edges: integerQuery(GRAPH_MAX_EDGES, 20000).refine(n => n > 0),
      edge_kinds: z.string().default('link,source,keyword'),
      include_isolated: z.enum(['true', 'false']).default('false'),
    }).strict(), req.query);
    if (input.scope !== 'common' && !input.workspace_id) throw new ValidationError('该 scope 必须提供 workspace_id');
    const kinds = input.edge_kinds.split(',').map(kind => kind.trim()).filter(kind => kind !== '');
    const allowedKinds = ['link', 'source', 'keyword'] as const;
    if (kinds.length === 0 || kinds.some(kind => !allowedKinds.includes(kind as typeof allowedKinds[number]))) throw new ValidationError('edge_kinds 仅支持 link,source,keyword');
    const pageLimit = maxGraphPages;
    const { rows, pagesTruncated, pageTotal } = listKnowledgeGraphRows(db, { scope: input.scope, workspace_id: input.workspace_id ?? null }, pageLimit);
    if (pagesTruncated) {
      console.warn('[knowledge-graph] 页面集合被上限截断：图只覆盖已加载页', {
        scope: input.scope, workspace_id: input.workspace_id ?? null, loaded: rows.length, limit: pageLimit,
      });
    }
    const uniqueKinds = [...new Set(kinds)] as Array<'link' | 'source' | 'keyword'>;
    // V2-4：默认包含 link 时注入显式双链边（同对节点由 buildKnowledgeGraph 按 link > source > keyword 合并）
    const links = uniqueKinds.includes('link') ? listResolvedLinks(db, rows.map(row => row.id)) : [];
    res.json(buildKnowledgeGraph(rows, {
      pagesTruncated,
      pageTotal,
      edgeKinds: uniqueKinds,
      links,
      includeIsolated: input.include_isolated === 'true',
      limitNodes: Math.min(input.limit_nodes, GRAPH_MAX_NODES),
      limitEdges: Math.min(input.limit_edges, GRAPH_MAX_EDGES),
    }));
  });
  router.get('/pages', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), status: z.enum(['active', 'archived', 'deleted', 'all']).default('active'), include_expired: z.enum(['true', 'false']).default('false'), offset: integerQuery(0, Number.MAX_SAFE_INTEGER), limit: integerQuery(20, 100).refine(n => n > 0) }).strict(), req.query);
    if (input.scope !== 'both') validateKnowledgeScope(input as KnowledgeScope);
    else if (!input.workspace_id) throw new ValidationError('both 必须提供 workspace_id');
    const scopeSql = input.scope === 'common' ? "scope='common'" : input.scope === 'workspace' ? "(scope='workspace' AND workspace_id=@workspace)" : "(scope='common' OR (scope='workspace' AND workspace_id=@workspace))";
    const params: Record<string, number | string> = { limit: input.limit + 1, offset: input.offset };
    if (input.scope !== 'common') params.workspace = input.workspace_id!;
    if (input.status !== 'all') params.status = input.status;
    if (input.include_expired === 'false') params.now = Date.now();
    const rows = db.prepare(`SELECT id,scope,workspace_id,slug,title,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed FROM knowledge_page WHERE ${scopeSql} ${input.status !== 'all' ? 'AND status=@status' : ''} ${input.include_expired === 'false' ? 'AND (expires_at IS NULL OR expires_at>@now)' : ''} ORDER BY updated_at DESC,id LIMIT @limit OFFSET @offset`).all(params);
    res.json({ items: rows.slice(0, input.limit), next_offset: rows.length > input.limit ? input.offset + input.limit : null });
  });
  router.get('/pages/:id/revisions', (req, res) => {
    const scope = scopeOf(req.query);
    const { limit, offset } = parse(z.object({ limit: integerQuery(20, 50).refine(n => n > 0), offset: integerQuery(0, Number.MAX_SAFE_INTEGER) }), req.query);
    const items = listKnowledgeRevisions(db, req.params.id!, scope, limit, offset);
    res.json({ items, next_offset: items.length === limit ? offset + limit : null });
  });
  router.get('/pages/:id', (req, res) => {
    const page = getKnowledgePage(db, req.params.id!, scopeOf(req.query));
    if (!page) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
    // V2-4：只加字段，不删既有字段
    res.json({
      ...page,
      backlinks_count: countBacklinks(db, page.id),
      links_out_count: countOutgoingLinks(db, page.id),
      unresolved_links: listUnresolvedLinks(db, page.id),
    });
  });

  /** V2-4 反链：指向该页的当前 revision 链接；排序键固定 (created_at, id) 保证翻页稳定 */
  router.get('/pages/:id/backlinks', (req, res) => {
    const page = getKnowledgePage(db, req.params.id!, scopeOf(req.query));
    if (!page) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
    const input = parse(z.object({
      scope: z.enum(['common', 'workspace', 'both']).optional(),
      workspace_id: z.string().min(1).optional(),
      offset: integerQuery(0, Number.MAX_SAFE_INTEGER),
      limit: integerQuery(20, 100),
    }).strict(), req.query);
    res.json(listBacklinks(db, page.id, { limit: input.limit, offset: input.offset }));
  });

  /** V2-4 存量回填：显式触发（不做启动扫描），可重跑 */
  router.post('/reparse', (req, res) => {
    const body = parse(z.object({ batch_size: z.number().int().min(1).max(2000).optional() }).strict(), req.body ?? {});
    res.json(reparseAllPages(db, { batchSize: body.batch_size }));
  });
  router.post('/pages', (req, res) => {
    const body = parse(knowledgeCreateSchema, req.body);
    const scope = scopeOf(body);
    const { scope: _scope, workspace_id: _workspace, ...content } = body;
    res.json(httpMutation(db, req, () => createKnowledgePage(db, { ...content, ...scope })).result);
  });
  router.put('/pages/:id', (req, res) => {
    const { expected_revision, scope: _scope, workspace_id: _workspace, ...patch } = parse(knowledgeReviseSchema, req.body);
    res.json(httpMutation(db, req, () => reviseKnowledgePage(db, req.params.id!, scopeOf(req.body), expected_revision, patch)).result);
  });
  router.post('/pages/:id/actions', (req, res) => {
    const body = parse(knowledgeActionSchema, req.body);
    res.json(httpMutation(db, req, () => setKnowledgePageStatus(db, req.params.id!, scopeOf(body), body.expected_revision, body.action, body.actor)).result);
  });
  return router;
}
