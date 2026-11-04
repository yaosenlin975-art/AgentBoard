import express, { Router } from 'express';
import { z } from 'zod';
import type { KnowledgeScope } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, ValidationError } from '../errors.js';
import { createKnowledgePage, getKnowledgePage, getKnowledgeRevision, listKnowledgeGraphRows, listKnowledgeRevisions, reviseKnowledgePage, setKnowledgePageStatus } from '../db/repos/knowledge.js';
import { GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_PAGES, buildKnowledgeGraph } from '../services/knowledgeGraph.js';
import { countBacklinks, countOutgoingLinks, listBacklinks, listResolvedLinks, listUnresolvedLinks, reparseAllPages } from '../services/knowledgeLinks.js';
import { searchKnowledge } from '../db/repos/knowledgeSearch.js';
import { validateKnowledgeScope } from '../services/knowledge.js';
import { createKnowledgeImageStore, KNOWLEDGE_IMAGE_MAX_BYTES, type KnowledgeImageStore } from '../services/knowledgeImages.js';
import { importKnowledgePages } from '../services/knowledgeImport.js';
import { findKnowledgePageOwner, knowledgeLink, resolveKnowledgeRef } from '../services/knowledgeResolve.js';
import { parseMultipart } from '../services/multipart.js';
import { httpMutation } from '../services/idempotency.js';
import { knowledgeCreateSchema, knowledgeReviseSchema, knowledgeActionSchema, knowledgeImportSchema, knowledgeScopeFields } from './schemas.js';

/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 * 例：invalid_value → 「取值必须是：a / b」；too_small → 「不能小于 N」。
 */
function zhZodIssue(rawIssue: unknown): string {
  const issue = (rawIssue ?? {}) as { code?: string; path?: Array<string | number>; message?: string; minimum?: unknown; maximum?: unknown; options?: unknown[]; expected?: unknown };
  const where = issue.path && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  const raw = (issue as { options?: unknown[]; values?: unknown[] });
  const list = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.values) ? raw.values : [];
  const options = list.map(String);
  switch (issue.code) {
    case 'invalid_value':
    case 'invalid_enum_value':
      return options.length > 0 ? `${where}取值必须是：${options.join(' / ')}` : `${where}${issue.message ?? '取值不合法'}`;
    case 'too_small':
      return `${where}不能小于 ${String(issue.minimum ?? '')}`.trim();
    case 'too_big':
      return `${where}不能大于 ${String(issue.maximum ?? '')}`.trim();
    case 'invalid_type':
      return `${where}类型不对（期望 ${String(issue.expected ?? '')}）`;
    case 'unrecognized_keys':
    case 'custom':
      return `${where}${issue.message ?? '参数不合法'}`;
    default:
      return `${where}${issue.message ?? '参数不合法'}`;
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError(result.error.issues.map(issue => zhZodIssue(issue)).join('; '));
  return result.data;
}
const integerQuery = (fallback: number, max: number) => z.coerce.number().int().min(0).max(max).default(fallback);
function scopeOf(raw: unknown): KnowledgeScope {
  const value = parse(z.object(knowledgeScopeFields), raw) as KnowledgeScope;
  validateKnowledgeScope(value);
  return value;
}
export interface KnowledgeRouterOptions {
  /** KB-IMG-1：知识页图片存储（仅测试注入；生产按 db 路径派生） */
  imageStore?: KnowledgeImageStore;
  /** 单次图聚合可加载的最大页数；默认 GRAPH_MAX_PAGES（测试可调小以验证截断标志） */
  maxGraphPages?: number;
}

export function createKnowledgeRouter(db: Db, options: KnowledgeRouterOptions = {}): Router {
  /** KB-IMG-1：图片存储（目录 = <db 目录>/attachments/knowledge） */
  const images = options.imageStore ?? createKnowledgeImageStore({ db });

  /** 图片可见性：common 页对所有工作区可读；workspace 页只对同工作区可读，跨区 → 403 */
  function requireVisiblePage(pageId: string, rawScope: unknown, rawWorkspaceId: unknown) {
    const page = getKnowledgePage(db, pageId, { scope: 'common' });
    const workspaceId = typeof rawWorkspaceId === 'string' && rawWorkspaceId !== '' ? rawWorkspaceId : null;
    if (page) return page; // common 页
    if (workspaceId === null) throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
    const scoped = getKnowledgePage(db, pageId, { scope: 'workspace', workspace_id: workspaceId });
    if (scoped) return scoped;
    const exists = db.prepare('SELECT workspace_id FROM knowledge_page WHERE id=?').get(pageId) as { workspace_id: string } | undefined;
    if (exists) throw new ApiError(403, 'KNOWLEDGE_SCOPE_FORBIDDEN', '该知识页属于其它工作区，无权访问其图片');
    throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
  }

  const maxGraphPages = options.maxGraphPages ?? GRAPH_MAX_PAGES;
  const router = Router();
  router.get('/search', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), q: z.string(), limit: integerQuery(5, 20).refine(n => n > 0) }).strict(), req.query);
    // KB-PAGE-2：每条结果附 link（服务端产出，前端/CLI 不再拼串）
    res.json(searchKnowledge(db, { ...input, query: input.q }).map((row) => ({
      ...row,
      link: knowledgeLink({ id: row.page_id, title: row.title, slug: row.slug, scope: row.scope, workspace_id: row.workspace_id }),
    })));
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
  // KB-DIFF-S：列表默认**不带正文**（只给 body_bytes / body_chars 摘要）；include_body=true 保留旧行为。
  router.get('/pages/:id/revisions', (req, res) => {
    const scope = scopeOf(req.query);
    const { limit, offset, include_body } = parse(z.object({
      limit: integerQuery(20, 50).refine(n => n > 0),
      offset: integerQuery(0, Number.MAX_SAFE_INTEGER),
      include_body: z.enum(['true', 'false']).optional(),
    }), req.query);
    const items = listKnowledgeRevisions(db, req.params.id!, scope, limit, offset, include_body === 'true');
    res.json({ items, next_offset: items.length === limit ? offset + limit : null });
  });

  // KB-DIFF-S：单条 revision 全文快照（点某版本看 diff 时按需取，必在 /pages/:id 之前注册以免歧义）
  router.get('/pages/:id/revisions/:revision', (req, res) => {
    const scope = scopeOf(req.query);
    const revision = Number(req.params.revision);
    res.json(getKnowledgeRevision(db, req.params.id!, revision, scope));
  });
  /**
   * KB-PAGE-2：统一引用解析。四态固定为 200(resolved) / 404(not_found) / 409(ambiguous) / 410(deleted)。
   * 鉴权在取标题之前：跨 scope 的 workspace 页 → 403 且**不回显标题**。
   */
  router.get('/resolve', (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    if (ref.trim() === '') throw new ValidationError('ref 不能为空');
    // scope 可选：缺省 both（跨 common + 当前工作区），这样才能发现「同 slug 两份」的歧义（A5）。
    const rawScope = typeof req.query.scope === 'string' ? req.query.scope : 'both';
    if (!['common', 'workspace', 'both'].includes(rawScope)) throw new ValidationError('scope 取值必须是：workspace / common / both');
    const workspaceId = typeof req.query.workspace_id === 'string' ? req.query.workspace_id : undefined;
    if (rawScope === 'workspace' || rawScope === 'both') {
      if (workspaceId === undefined || workspaceId === '') throw new ValidationError('scope=workspace/both 时必须提供 workspace_id');
      if (db.prepare('SELECT 1 AS hit FROM workspace WHERE id=?').get(workspaceId) === undefined) {
        throw new ApiError(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在');
      }
    }
    const scope = rawScope === 'common'
      ? ({ scope: 'common' } as const)
      : rawScope === 'workspace'
        ? ({ scope: 'workspace', workspace_id: workspaceId! } as const)
        : ({ scope: 'both', workspace_id: workspaceId! } as const);

    const result = resolveKnowledgeRef(db, { ref, scope });
    if (result.state === 'resolved') { res.json(result); return; }
    if (result.state === 'deleted') throw new ApiError(410, 'KNOWLEDGE_DELETED', result.message);
    if (result.state === 'ambiguous') {
      throw new ApiError(409, 'KNOWLEDGE_REF_AMBIGUOUS', result.message, result.candidates === undefined ? undefined : { candidates: result.candidates });
    }
    // not_found：若该 id 存在但属于别的范围/别的工作区 → 403（**不回显标题**）
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim())) {
      const owner = findKnowledgePageOwner(db, ref.trim());
      if (owner !== null) {
        throw new ApiError(403, 'KNOWLEDGE_SCOPE_FORBIDDEN', owner.scope === 'common'
          ? '该知识页属于 common 范围，请用 --scope common 解析'
          : '该知识页属于另一个工作区，当前范围无权读取');
      }
    }
    throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', result.message);
  });

  router.get('/pages/:id', (req, res) => {
    const scope = scopeOf(req.query);
    const page = getKnowledgePage(db, req.params.id!, scope);
    if (!page) {
      // KB-PAGE-1：软删页与「不存在」分开——deleted → 410（前端显示「已删除 + 可看历史」），其它 → 404
      const deleted = getKnowledgePage(db, req.params.id!, scope, { includeDeleted: true });
      if (deleted !== null && deleted.status === 'deleted') {
        throw new ApiError(410, 'KNOWLEDGE_DELETED', '知识页已删除（可查看历史版本）', { revision: deleted.revision });
      }
      throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
    }
    // V2-4：只加字段，不删既有字段；KB-PAGE-2：再加 link（引用串由服务端产出）
    res.json({
      ...page,
      link: knowledgeLink(page),
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
  /**
   * KBIMP-1：从 md / txt / json 文本导入知识页。
   * 单条（md/txt/json 对象）或批量（json 数组）都返回 `{ pages, warnings }`；
   * 来源与证据自动构造（file 来源只存路径 + sha256，不写 snapshot），落库走既有事务路径。
   */
  /**
   * KBIMP-1B：导入端点**路由级** json parser（2mb），不动全局 `express.json()` 的 100kb。
   * 注意：parser 是幂等的（req.body 已解析时跳过），但「超限拒绝」发生在**先执行的那个 parser**；
   * 全局 parser 挂在 app 层（index.ts:154）且先于本路由运行，因此 >100kb 仍会被它先拒——见卡评论的实测与结论。
   */
  router.post('/pages/import', express.json({ limit: '2mb' }), (req, res) => {
    const body = parse(knowledgeImportSchema, req.body);
    const result = importKnowledgePages(db, body, { actor: body.actor });
    res.json(result);
  });  router.post('/pages', (req, res) => {
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
    const result = httpMutation(db, req, () => setKnowledgePageStatus(db, req.params.id!, scopeOf(body), body.expected_revision, body.action, body.actor)).result;
    // KB-IMG-1：页面「删除」是软删（status='deleted'），CASCADE 不会触发，因此这里显式清掉该页图片行 + 文件。
    // 硬删（如工作区删除时的级联）仍由 knowledge_attachment 的 ON DELETE CASCADE 兜底。
    if (body.action === 'delete') {
      db.prepare('DELETE FROM knowledge_attachment WHERE page_id=?').run(req.params.id!);
      void images.removePageFiles(req.params.id!);
    }
    res.json(result);
  });
  // ---- KB-IMG-1：知识页图片（设计 §3/§4）----
  // 原始体上限留足 multipart 头部开销：真正的 5 MiB 限额由 images.save() 判，保证错误码是 IMAGE_TOO_LARGE
  router.post('/pages/:id/images', express.raw({ type: () => true, limit: KNOWLEDGE_IMAGE_MAX_BYTES + 7 * 1024 * 1024 }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('图片请求体必须为 multipart/form-data');
    const parts = parseMultipart(req.body, req.get('Content-Type'));
    const file = parts.files[0];
    if (!file) throw new ValidationError('multipart 里没有图片文件（字段名任意，需带 filename）');
    const page = requireVisiblePage(req.params.id!, parts.fields.scope, parts.fields.workspace_id);
    const originalBytes = Number(parts.fields.original_bytes ?? '');
    const saved = await images.save({
      page_id: page.id,
      bytes: file.data,
      declared_mime: file.contentType,
      original_bytes: Number.isSafeInteger(originalBytes) && originalBytes > 0 ? originalBytes : null,
      created_by: 'user',
    });
    res.status(201).json(saved);
  });

  router.get('/images/:attachmentId', (req, res) => {
    const found = images.locate(req.params.attachmentId!);
    if (!found) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    requireVisiblePage(found.row.page_id, req.query.scope, req.query.workspace_id);
    res.type(found.row.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(found.path, (error) => { if (error && !res.headersSent) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片文件不存在'); });
  });

  router.delete('/images/:attachmentId', async (req, res) => {
    const found = images.locate(req.params.attachmentId!);
    if (!found) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    requireVisiblePage(found.row.page_id, req.query.scope, req.query.workspace_id);
    await images.remove(req.params.attachmentId!);
    // 不自动改写 body_md：正文里的引用留给作者处理，避免误删内容
    res.status(204).end();
  });

  return router;
}
