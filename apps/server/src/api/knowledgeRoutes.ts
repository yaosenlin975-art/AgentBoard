import express, { Router } from 'express';
import type { KnowledgeScopeFilter } from '../db/repos/knowledgeScope.js';
import { KnowledgeErrorCode } from './knowledgeCodes.js';
import { zhZodIssue } from './zod.js';
import { z } from 'zod';
import type { KnowledgeScope } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, ValidationError } from '../errors.js';
import { createKnowledgePage, findKnowledgePagesBySource, getKnowledgePage, getKnowledgeRevision, listKnowledgeGraphRows, listKnowledgeRevisions, reviseKnowledgePage, setKnowledgePageStatus } from '../db/repos/knowledge.js';
import { GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_PAGES, buildKnowledgeGraph } from '../services/knowledgeGraph.js';
import {getKnowledgePageLinkStats, listBacklinks, listResolvedLinks, reparseAllPages} from '../services/knowledgeLinks.js';
import { listKnowledgePageRows, listKnowledgePagesAcrossDbs, searchKnowledge, searchKnowledgeAcrossDbs } from '../db/repos/knowledgeSearch.js';
import { migrateKnowledgeLinks } from '../db/migrations/knowledgeLinks.js';
import { commitKnowledgePageRevision, removeKnowledgePageRevision } from '../services/knowledgePageCommit.js';
import { validateKnowledgeScope } from '../services/knowledge.js';
import { createScopedKnowledgeImageStore, KNOWLEDGE_IMAGE_MAX_BYTES, type KnowledgeImageStore } from '../services/knowledgeImages.js';
import { importKnowledgePages } from '../services/knowledgeImport.js';
import { findKnowledgePageOwner, knowledgeLinkFields, resolveKnowledgeRef } from '../services/knowledgeResolve.js';
import { parseMultipart } from '../services/multipart.js';
import { httpMutation } from '../services/idempotency.js';
import {
  defaultFileSystemDeps,
  defaultOpenProcessDeps,
  openLocalFile,
  resolveLocalFile,
  type FileSystemDeps,
  type OpenProcessDeps,
} from '../services/fileOpener.js';
import { knowledgeCreateSchema, knowledgeReviseSchema, knowledgeActionSchema, knowledgeImportSchema, knowledgeScopeFields } from './schemas.js';

/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 * 例：invalid_value → 「取值必须是：a / b」；too_small → 「不能小于 N」。
 */

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
  /** PROV-B：路径安全边界用到的 fs 视图（仅测试注入 fake realpath/stat，用于造 symlink 逃逸） */
  fileSystem?: FileSystemDeps;
  /** PROV-B：打开器用到的进程视图（仅测试注入 fake spawn，绝不在单测里真起编辑器） */
  openProcess?: OpenProcessDeps;
  /**
   * STORE-4a：按请求取工作区库（scope=workspace 时调用；未下沉区由实现回中心库）。
   * 缺省视为「全部走中心库」——既有测试与未装配 resolver 的调用方行为不变。
   */
  getWorkspaceDb?: (workspaceId: string) => Db;
  /** STORE-4a：跨区 owner 探测的 fan-out 候选库（全部已下沉区；缺省只探中心库） */
  listWorkspaceDbs?: () => Db[];
}

/**
 * PROV-B：打开本机文件的请求体（schema 内联在本文件，schemas.ts 属禁改集）。
 * 固定三字段 + strict：没有 root/base/directory 之类的口子，也不接受 page_id 反查。
 */
const knowledgeFileOpenSchema = z.object({
  workspace_id: z.string().min(1).max(64),
  path: z.string().min(1).max(1000),
  line: z.number().int().min(1).max(1_000_000_000).optional(),
}).strict();

export function createKnowledgeRouter(db: Db, options: KnowledgeRouterOptions = {}): Router {
  /** KB-IMG-1：图片存储；STORE-4c：默认装配按 page.scope 路由的 store（common→中心目录、workspace→工作区目录），测试注入单一 store 时行为不变 */
  const images = options.imageStore ?? createScopedKnowledgeImageStore({
    center: db,
    getWorkspaceDb: options.getWorkspaceDb,
    listWorkspaceDbs: options.listWorkspaceDbs,
  });

  // ---- STORE-4a：按请求取库 ----
  /**
   * scope → 库：common 走中心库；workspace 走该工作区的解析库（未下沉区由 getWorkspaceDb 实现回中心库）；
   * both 的两路合并见各端点（未装配 getWorkspaceDb 时整体回中心库单库查询——旧测试/最小装配行为不变）。
   */
  const dbForScope = (scope: 'common' | 'workspace' | 'both', workspaceId: string | null | undefined): Db => {
    if (scope === 'workspace') {
      const wsDb = workspaceDbFor(workspaceId);
      if (wsDb !== null) return wsDb;
    }
    return db;
  };
  /**
   * STORE-4c：工作区库句柄补一次 knowledge_link 外键松绑迁移（幂等）。
   * 升级前已 localize 的工作区库不跑 initSchema（openDb 不建结构），旧 target 外键会挡住跨库
   * 目标写入；首个使用该句柄的知识请求处补齐，句柄缓存期间只跑一次。
   */
  const fkEnsured = new WeakSet<Db>();
  const ensureLinkFk = (target: Db): Db => {
    if (target !== db && !fkEnsured.has(target)) {
      fkEnsured.add(target);
      try { migrateKnowledgeLinks(target); } catch { /* 结构保障失败不阻塞读；跨库写入按未解析降级，reparse 补齐 */ }
    }
    return target;
  };
  const workspaceDbFor = (workspaceId: string | null | undefined): Db | null => {
    if (options.getWorkspaceDb === undefined || !workspaceId) return null;
    return ensureLinkFk(options.getWorkspaceDb(workspaceId));
  };
  /**
   * 跨区 owner 探测：页不在当前范围时判断「它到底在哪」——中心库（common + 未下沉区 workspace 页）
   * 先探，再 fan-out 已下沉区。只回 owner 元数据，不回标题（403 文案不得泄露他区标题）。
   */
  const probePageOwner = (pageId: string): { scope: 'common' | 'workspace'; workspace_id: string | null } | null => {
    const inCenter = findKnowledgePageOwner(db, pageId);
    if (inCenter !== null) return inCenter;
    for (const wsDb of options.listWorkspaceDbs?.() ?? []) {
      const owner = findKnowledgePageOwner(wsDb, pageId);
      if (owner !== null) return owner;
    }
    return null;
  };

  /** 图片可见性：common 页对所有工作区可读；workspace 页只对同工作区可读，跨区 → 403 */
  function requireVisiblePage(pageId: string, rawScope: unknown, rawWorkspaceId: unknown) {
    const page = getKnowledgePage(db, pageId, { scope: 'common' });
    const workspaceId = typeof rawWorkspaceId === 'string' && rawWorkspaceId !== '' ? rawWorkspaceId : null;
    if (page) return page; // common 页
    if (workspaceId === null) throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
    const scoped = getKnowledgePage(dbForScope('workspace', workspaceId), pageId, { scope: 'workspace', workspace_id: workspaceId });
    if (scoped) return scoped;
    if (probePageOwner(pageId) !== null) throw new ApiError(403, KnowledgeErrorCode.SCOPE_FORBIDDEN, '该知识页属于其它工作区，无权访问其图片');
    throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
  }

  const maxGraphPages = options.maxGraphPages ?? GRAPH_MAX_PAGES;
  const router = Router();
  router.get('/search', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), q: z.string(), limit: integerQuery(5, 20).refine(n => n > 0) }).strict(), req.query);
    // KB-PAGE-2：每条结果附 link（服务端产出，前端/CLI 不再拼串）；STORE-4a：workspace scope 按请求取库
    const withLink = (row: ReturnType<typeof searchKnowledge>[number]) => ({
      ...row,
      ...knowledgeLinkFields({ id: row.page_id, title: row.title, slug: row.slug, scope: row.scope, workspace_id: row.workspace_id, revision: row.revision }),
    });
    // STORE-4c：both 且装配了取库 → 中心 common + 工作区库两路合并，统一 (updated_at desc, id asc) 排序切片；
    // 命中数超过 limit 时 X-Knowledge-Truncated:true（合并后无精确总数，不报假总数；响应体仍是数组，客户端兼容）
    if (input.scope === 'both' && options.getWorkspaceDb !== undefined) {
      const wsDb = workspaceDbFor(input.workspace_id);
      if (wsDb === null) throw new ValidationError('both 必须提供 workspace_id');
      const { items, truncated } = searchKnowledgeAcrossDbs(db, wsDb, { ...input, query: input.q });
      res.set('X-Knowledge-Truncated', truncated ? 'true' : 'false');
      res.json(items.map(withLink));
      return;
    }
    const rdb = dbForScope(input.scope, input.workspace_id);
    res.json(searchKnowledge(rdb, { ...input, query: input.q }).map(withLink));
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
    const uniqueKinds = [...new Set(kinds)] as Array<'link' | 'source' | 'keyword'>;
    let graphRows: ReturnType<typeof listKnowledgeGraphRows>['rows'];
    let pagesTruncated: boolean;
    let pageTotal: number;
    let links: Array<{ source: string; target: string; weight: number }>;
    if (input.scope === 'both' && options.getWorkspaceDb !== undefined) {
      // STORE-4c：both 两路加载——中心 common + 工作区库该工作区（未下沉区两路同库，scope 过滤不相交不会重复）
      const wsDb = workspaceDbFor(input.workspace_id)!;
      const centerSide = listKnowledgeGraphRows(db, { scope: 'common' }, pageLimit);
      const wsSide = listKnowledgeGraphRows(wsDb, { scope: 'workspace', workspace_id: input.workspace_id }, pageLimit);
      const merged = [...centerSide.rows, ...wsSide.rows];
      pageTotal = centerSide.pageTotal + wsSide.pageTotal;
      pagesTruncated = centerSide.pagesTruncated || wsSide.pagesTruncated || merged.length > pageLimit;
      graphRows = merged
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .filter((row, index, all) => index === 0 || all[index - 1]!.id !== row.id)
        .slice(0, pageLimit);
      // 双链行与源页同库：两路各查各的，跨库目标（resolved=1 存外库 id）自然并入
      links = uniqueKinds.includes('link')
        ? [...listResolvedLinks(db, centerSide.rows.map(row => row.id)), ...listResolvedLinks(wsDb, wsSide.rows.map(row => row.id))]
        : [];
    } else {
      const rdb = dbForScope(input.scope, input.workspace_id);
      const single = listKnowledgeGraphRows(rdb, { scope: input.scope, workspace_id: input.workspace_id ?? null }, pageLimit);
      graphRows = single.rows;
      pagesTruncated = single.pagesTruncated;
      pageTotal = single.pageTotal;
      // V2-4：默认包含 link 时注入显式双链边（同对节点由 buildKnowledgeGraph 按 link > source > keyword 合并）
      links = uniqueKinds.includes('link') ? listResolvedLinks(rdb, graphRows.map(row => row.id)) : [];
    }
    const rows = graphRows;
    if (pagesTruncated) {
      console.warn('[knowledge-graph] 页面集合被上限截断：图只覆盖已加载页', {
        scope: input.scope, workspace_id: input.workspace_id ?? null, loaded: rows.length, limit: pageLimit,
      });
    }
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
    // STORE-4c：both 且装配了取库 → 中心 common + 工作区库两路合并（窗口法精确 next_offset，不报假总数）
    if (input.scope === 'both' && options.getWorkspaceDb !== undefined) {
      const wsDb = workspaceDbFor(input.workspace_id)!;
      const { items, next_offset } = listKnowledgePagesAcrossDbs(db, wsDb, { ...input, include_expired: input.include_expired === 'true' });
      res.json({
        items: items.map(row => ({ ...row, ...knowledgeLinkFields(row) })),
        next_offset,
      });
      return;
    }
    const rdb = dbForScope(input.scope, input.workspace_id);
    const rows = listKnowledgePageRows(rdb, { ...input, include_expired: input.include_expired === 'true', limit: input.limit + 1 });
    // KB-PAGE-2b（A7）：列表项同样带 link，CLI/前端不再自己拼串
    res.json({
      items: rows.slice(0, input.limit).map(row => ({ ...row, ...knowledgeLinkFields(row) })),
      next_offset: rows.length > input.limit ? input.offset + input.limit : null,
    });
  });
  // KB-DIFF-S：列表默认**不带正文**（只给 body_bytes / body_chars 摘要）；include_body=true 保留旧行为。
  router.get('/pages/:id/revisions', (req, res) => {
    const scope = scopeOf(req.query);
    const { limit, offset, include_body } = parse(z.object({
      limit: integerQuery(20, 50).refine(n => n > 0),
      offset: integerQuery(0, Number.MAX_SAFE_INTEGER),
      include_body: z.enum(['true', 'false']).optional(),
    }), req.query);
    const items = listKnowledgeRevisions(dbForScope(scope.scope, scope.workspace_id), req.params.id!, scope, limit, offset, include_body === 'true');
    res.json({ items, next_offset: items.length === limit ? offset + limit : null });
  });

  // KB-DIFF-S：单条 revision 全文快照（点某版本看 diff 时按需取，必在 /pages/:id 之前注册以免歧义）
  router.get('/pages/:id/revisions/:revision', (req, res) => {
    const scope = scopeOf(req.query);
    const revision = Number(req.params.revision);
    res.json(getKnowledgeRevision(dbForScope(scope.scope, scope.workspace_id), req.params.id!, revision, scope));
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

    // STORE-4c：both 两库解析——common 侧查中心库，workspace 侧查工作区库（跨库同 slug 歧义照常 409）
    const result = resolveKnowledgeRef(dbForScope(scope.scope, workspaceId), { ref, scope },
      scope.scope === 'both' ? { workspaceDb: workspaceDbFor(workspaceId) ?? db } : {});
    if (result.state === 'resolved') { res.json(result); return; }
    if (result.state === 'deleted') throw new ApiError(410, KnowledgeErrorCode.DELETED, result.message);
    if (result.state === 'ambiguous') {
      throw new ApiError(409, KnowledgeErrorCode.REF_AMBIGUOUS, result.message, result.candidates === undefined ? undefined : { candidates: result.candidates });
    }
    // not_found：若该 id 存在但属于别的范围/别的工作区 → 403（**不回显标题**）
    // STORE-4a：owner 探测含已下沉工作区库（页可能已搬出中心库）
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim())) {
      const owner = probePageOwner(ref.trim());
      if (owner !== null) {
        throw new ApiError(403, KnowledgeErrorCode.SCOPE_FORBIDDEN, owner.scope === 'common'
          ? '该知识页属于 common 范围，请用 --scope common 解析'
          : '该知识页属于另一个工作区，当前范围无权读取');
      }
    }
    throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, result.message);
  });

  /**
   * KB-PAGE-2b：只读反查「哪些知识页的 sources 引用了这个文件」。
   * 按当前 revision 的 sources_json 扫描（不建表、不反序列化历史版本），term 精确匹配 locator / content_hash / source_id。
   */
  router.get('/find-source', (req, res) => {
    const input = parse(z.object({
      path: z.string().min(1),
      scope: z.enum(['common', 'workspace', 'both']).default('both'),
      workspace_id: z.string().min(1).optional(),
    }).strict(), req.query);
    if (input.scope !== 'common' && !input.workspace_id) throw new ValidationError('scope=workspace/both 时必须提供 workspace_id');
    const items = findKnowledgePagesBySource(dbForScope(input.scope, input.workspace_id), { term: input.path, scope: input.scope, workspace_id: input.workspace_id ?? null })
      .map(item => ({ ...item, ...knowledgeLinkFields(item) }));
    res.json({ path: input.path, items });
  });

  /**
   * PROV-B：把知识页证据条目指向的**本工作区内**文件交给本机打开器（编辑器 / 资源管理器 / 默认程序）。
   * 边界与降级见 services/fileOpener.ts 头注释；这里只负责契约：
   *  · 根路径只能由 workspace_id 从库取（④），调用方传任何 root/base 都会被 strict schema 拒；
   *  · 响应 { opened_with, path(工作区相对) }——不回传文件内容、不列目录，越界与 symlink 逃逸都是 4xx 结构化 JSON；
   *  · 打开全失败 → 500 OPEN_FAILED（details.attempts），前端据此降级为「已复制路径」。
   */
  router.post('/files/open', async (req, res) => {
    const input = parse(knowledgeFileOpenSchema, req.body ?? {});
    const file = resolveLocalFile(db, input, options.fileSystem ?? defaultFileSystemDeps);
    const opened = await openLocalFile(file, options.openProcess ?? defaultOpenProcessDeps);
    res.json({ ok: true, opened_with: opened.opened_with, path: file.relativePath, line: input.line ?? null });
  });

  router.get('/pages/:id', (req, res) => {
    const scope = scopeOf(req.query);
    const rdb = dbForScope(scope.scope, scope.workspace_id);
    const page = getKnowledgePage(rdb, req.params.id!, scope);
    if (!page) {
      // KB-PAGE-1：软删页与「不存在」分开——deleted → 410（前端显示「已删除 + 可看历史」），其它 → 404
      const deleted = getKnowledgePage(rdb, req.params.id!, scope, { includeDeleted: true });
      if (deleted !== null && deleted.status === 'deleted') {
        throw new ApiError(410, KnowledgeErrorCode.DELETED, '知识页已删除（可查看历史版本）', { revision: deleted.revision });
      }
      throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    }
    // V2-4：只加字段，不删既有字段；KB-PAGE-2：再加 link（引用串由服务端产出）
    res.json({
      ...page,
      ...knowledgeLinkFields(page),
      ...getKnowledgePageLinkStats(rdb, page.id),
    });
  });

  /**
   * V2-4 反链：指向该页的当前 revision 链接；排序键固定 (created_at, id) 保证翻页稳定。
   * STORE-4c：scope 支持 both——中心库 + 工作区库两路合并（工作区页双链到 common 页的反链行
   * 存在源页所在库，跨库目标靠 target_page_id 精确匹配）；page_total 两路精确求和，
   * 窗口法取每路前 offset+limit+1 条后合并排序切片，翻页与单库语义一致。
   */
  router.get('/pages/:id/backlinks', (req, res) => {
    const scope = parse(z.object({
      scope: z.enum(['workspace', 'common', 'both']),
      workspace_id: z.string().min(1).optional(),
    }), req.query);
    const workspaceId = scope.scope === 'common' ? null : scope.workspace_id;
    if (scope.scope !== 'common' && !workspaceId) throw new ValidationError('scope=workspace/both 时必须提供 workspace_id');
    const wsDb = workspaceDbFor(workspaceId);
    const wsLookup = () => (wsDb !== null ? getKnowledgePage(wsDb, req.params.id!, { scope: 'workspace', workspace_id: workspaceId! }) : null);
    const page = scope.scope === 'common'
      ? getKnowledgePage(db, req.params.id!, { scope: 'common' })
      : scope.scope === 'workspace'
        ? wsLookup()
        : (getKnowledgePage(db, req.params.id!, { scope: 'common' }) ?? wsLookup());
    if (!page) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    const input = parse(z.object({
      scope: z.enum(['common', 'workspace', 'both']).optional(),
      workspace_id: z.string().min(1).optional(),
      offset: integerQuery(0, Number.MAX_SAFE_INTEGER),
      limit: integerQuery(20, 100),
    }).strict(), req.query);
    if (scope.scope === 'both' && wsDb !== null && wsDb !== db) {
      const window = input.offset + input.limit + 1;
      const centerSide = listBacklinks(db, page.id, { limit: window, offset: 0 });
      const wsSide = listBacklinks(wsDb, page.id, { limit: window, offset: 0 });
      const merged = [...centerSide.items, ...wsSide.items]
        .sort((left, right) => (left.created_at - right.created_at) || (left.page_id < right.page_id ? -1 : left.page_id > right.page_id ? 1 : 0))
        .slice(input.offset, input.offset + input.limit);
      res.json({ items: merged, page_total: centerSide.page_total + wsSide.page_total });
      return;
    }
    const rdb = dbForScope(scope.scope === 'both' ? 'workspace' : scope.scope, scope.workspace_id);
    res.json(listBacklinks(rdb, page.id, { limit: input.limit, offset: input.offset }));
  });

  /** V2-4 存量回填：显式触发（不做启动扫描），可重跑。STORE-4a：中心库 + 全部已下沉区各自回填，计数求和。STORE-4c：工作区库回填显式带中心库（跨库目标解析）+ 补外键松绑 */
  router.post('/reparse', (req, res) => {
    const body = parse(z.object({ batch_size: z.number().int().min(1).max(2000).optional() }).strict(), req.body ?? {});
    const run = (rdb: Db) => reparseAllPages(ensureLinkFk(rdb), { batchSize: body.batch_size, ...(rdb !== db ? { centerDb: db } : {}) });
    const center = run(db);
    const perWorkspaceDb = options.listWorkspaceDbs?.() ?? [];
    if (perWorkspaceDb.length === 0) { res.json(center); return; }
    const totals = perWorkspaceDb.reduce((acc, rdb) => {
      const result = run(rdb);
      return { pages: acc.pages + result.pages, links: acc.links + result.links, duration_ms: acc.duration_ms + result.duration_ms };
    }, { pages: center.pages, links: center.links, duration_ms: center.duration_ms });
    res.json(totals);
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
    // STORE-4a：整批同一 scope，按请求取库（workspace 页进已下沉区落工作区库）
    const result = importKnowledgePages(dbForScope(body.scope, body.workspace_id), body, { actor: body.actor });
    res.json(result);
  });
  router.post('/pages', (req, res) => {
    const body = parse(knowledgeCreateSchema, req.body);
    const scope = scopeOf(body);
    const { scope: _scope, workspace_id: _workspace, ...content } = body;
    const rdb = dbForScope(scope.scope, scope.workspace_id);
    // KB-PAGE-2b：create/revise 响应同样带 link（A7），CLI 文本输出补一行 link
    const result = httpMutation(rdb, req, () => createKnowledgePage(rdb, { ...content, ...scope })).result;
    // BORROW-5.1：新建同样落一份每页快照并只提交该页路径（派生物，失败不影响本次写入）
    const pageCommit = commitKnowledgePageRevision(db, scope.workspace_id ?? result.workspace_id, result);
    res.json({ ...result, ...knowledgeLinkFields(result), page_commit: pageCommit });
  });
  router.put('/pages/:id', (req, res) => {
    const { expected_revision, scope: _scope, workspace_id: _workspace, ...patch } = parse(knowledgeReviseSchema, req.body);
    const scope = scopeOf(req.body);
    const rdb = dbForScope(scope.scope, scope.workspace_id);
    const result = httpMutation(rdb, req, () => reviseKnowledgePage(rdb, req.params.id!, scope, expected_revision, patch)).result;
    // BORROW-5.1：每次 revise 落一份每页快照并只提交该页路径（派生物，失败不影响本次 revise）
    const pageCommit = commitKnowledgePageRevision(db, scope.workspace_id ?? result.workspace_id, result);
    res.json({ ...result, ...knowledgeLinkFields(result), page_commit: pageCommit });
  });
  router.post('/pages/:id/actions', (req, res) => {
    const body = parse(knowledgeActionSchema, req.body);
    const scope = scopeOf(body);
    const rdb = dbForScope(scope.scope, scope.workspace_id);
    const result = httpMutation(rdb, req, () => setKnowledgePageStatus(rdb, req.params.id!, scope, body.expected_revision, body.action, body.actor)).result;
    // KB-IMG-1：页面「删除」是软删（status='deleted'），CASCADE 不会触发，因此这里显式清掉该页图片行 + 文件。
    // 硬删（如工作区删除时的级联）仍由 knowledge_attachment 的 ON DELETE CASCADE 兜底。
    if (body.action === 'delete') {
      rdb.prepare('DELETE FROM knowledge_attachment WHERE page_id=?').run(req.params.id!);
      void images.removePageFiles(req.params.id!);
    }
    // BORROW-5.1：归档/恢复重写该页快照（front matter 带 status），软删则撤掉快照并提交删除
    const pageCommit = body.action === 'delete'
      ? removeKnowledgePageRevision(db, scope.workspace_id ?? result.workspace_id, result)
      : commitKnowledgePageRevision(db, scope.workspace_id ?? result.workspace_id, result);
    res.json({ ...result, page_commit: pageCommit });
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
      // STORE-4c：按页所在库选目录（common→中心、workspace→工作区库目录；未下沉区随数据回中心）
      scope: page.scope,
      workspace_id: page.workspace_id,
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
    // STORE-6：工作区库模式的图片落在 `<ws>/.agentboard/attachments`，路径含点目录；
    // sendFile 默认 dotfiles:'ignore' 会把它当 404，必须显式放开（与附件下载路由一致）。
    res.sendFile(found.path, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片文件不存在'); });
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
