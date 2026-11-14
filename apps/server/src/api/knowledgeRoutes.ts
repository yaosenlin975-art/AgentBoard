/**
 * P2-01（方向 B §7.2）：知识路由——数据源从 SQLite 换成 `Docs/*.md` 文件仓储。
 *
 * 签名变更：`createKnowledgeRouter(options)` 不再接收 `Db` 与跨库注入（getWorkspaceDb/listWorkspaceDbs
 * 已删，知识数据不再走任何 SQLite）；工作区路径来自中心库注册表的注入 `getWorkspaceRow`（M13：
 * 中心库只存注册表/成员/账号元数据），旧库只读探测仅在图片兼容读取时注入。
 *
 * 端点契约（路径与响应形状尽量不变，Docs/api.md 由 P2-04 同步）：
 * - 页面 CRUD / 列表 / 检索 / 图 / 反链 / resolve / find-source 全部走文件仓储（knowledge/* 层）；
 * - `page_commit` 每页 git 快照随文件事实源退出：响应带 `committed=false + skipped=true` 的显式标记
 *   （文件写成功即命令成功，写文件成败即端点成败）；
 * - `/pages/:id/revisions` 返回空集（§8 #5 已定：放弃单页历史；旧库历史走 export-legacy 只读导出）；
 * - `/reparse` 语义改为「重建两目录扫描索引 + reconcile 只读报告」（响应形状向后兼容，报告为附加字段）；
 * - 新增 409 `KNOWLEDGE_FILE_CONFLICT`（外部编辑/锁冲突；CLI 409 → exit 2）。
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { KnowledgePage, KnowledgeScope } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, ValidationError } from '../errors.js';
import { KnowledgeErrorCode } from './knowledgeCodes.js';
import { zhZodIssue } from './zod.js';
import { GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_PAGES, buildKnowledgeGraph, type GraphInputRow } from '../services/knowledgeGraph.js';
import { knowledgeLinkFields } from '../services/knowledgeResolve.js';
import type { KnowledgeResolveResult, ResolveScope } from '../services/knowledgeResolve.js';
import { KNOWLEDGE_IMAGE_MAX_BYTES, type KnowledgeImageStore } from '../services/knowledgeImages.js';
import {
  defaultFileSystemDeps,
  defaultOpenProcessDeps,
  openLocalFile,
  resolveLocalFile,
  type FileSystemDeps,
  type OpenProcessDeps,
} from '../services/fileOpener.js';
import { httpMutation } from '../services/idempotency.js';
import { parseMultipart } from '../services/multipart.js';
import { knowledgeCreateSchema, knowledgeReviseSchema, knowledgeActionSchema, knowledgeImportSchema, knowledgeScopeFields } from './schemas.js';
import { planImport, buildSources, slugifyTitle } from '../services/knowledgeImport.js';
import { validateKnowledgeScope } from '../services/knowledge.js';
import { parseKnowledgeRefs } from '../services/knowledgeLinks.js';
import type { KnowledgePageListRow } from '../db/repos/knowledgeSearch.js';
import { knowledgeDocsStore, type ScopeSelector } from '../knowledge/store.js';
import { reconcileDocsDir } from '../knowledge/reconcile.js';
import { ATTACHMENTS_DIR_NAME, assertInsideDocsDir } from '../knowledge/paths.js';
import { docFileNameFor, type KnowledgeFileMeta } from '@agentboard/shared';
import type { DocsDirOverrides } from '../knowledge/paths.js';
import type { DocsIndex } from '../knowledge/index.js';

/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
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
  /** KB-IMG-1：知识页图片存储（legacy 兼容存储；测试注入；生产由 routes.ts 按解析器装配） */
  imageStore?: KnowledgeImageStore;
  /** 单次图聚合可加载的最大页数；默认 GRAPH_MAX_PAGES */
  maxGraphPages?: number;
  /** PROV-B：路径安全边界用到的 fs 视图（仅测试注入） */
  fileSystem?: FileSystemDeps;
  /** PROV-B：打开器用到的进程视图（仅测试注入） */
  openProcess?: OpenProcessDeps;
  /** M13：工作区注册表读取（中心库；返回注册行的 name/path），未知工作区返回 null */
  getWorkspaceRow?: (workspaceId: string) => { id: string; name: string; path: string } | null;
  /** /reparse 重扫候选：全部已注册工作区（中心库注册表；M13） */
  listWorkspaceRows?: () => Array<{ id: string; path: string }>;
  /** P2-01：Docs 目录覆盖（测试注入临时目录） */
  docsPaths?: DocsDirOverrides;
  /** P2-01：写锁实例标识（多实例区分） */
  instanceId?: string;
  /** 写幂等记录库（idempotency 表属服务基础设施，非知识数据；缺省不做幂等记录） */
  mutationDb?: Db;
  /** 旧库只读探测（图片兼容读取的 403/404 区分；页不在 Docs 时按旧库行判断归属） */
  legacyPageOwner?: (pageId: string) => { scope: 'common' | 'workspace'; workspace_id: string | null } | null;
}

/** PROV-B 请求体（schema 内联，schemas.ts 属禁改集） */
const knowledgeFileOpenSchema = z.object({
  workspace_id: z.string().min(1).max(64),
  path: z.string().min(1).max(1000),
  line: z.number().int().min(1).max(1_000_000_000).optional(),
}).strict();

/** 文件事实源下的 page_commit 显式标记（committed=false + skipped=true = 不是失败） */
function fileCommitMarker(page: KnowledgePage, docsDir: string, workspacePath: string | null): { path: string; relative_path: string; committed: boolean; commit: string | null; reason: string; skipped?: boolean } {
  const filePath = `${docsDir.replace(/\\/g, '/')}/${docFileNameFor(page.slug)}`;
  const relativePath = workspacePath !== null
    ? relative(workspacePath, filePath).replace(/\\/g, '/')
    : relative(process.cwd(), filePath).replace(/\\/g, '/');
  return {
    path: filePath,
    relative_path: relativePath,
    committed: false,
    commit: null,
    reason: '知识页已是文件事实源（Docs/*.md），落盘即提交，不再产生每页 git 快照（BORROW-5.1 随文件仓储退役）',
    skipped: true,
  };
}

export function createKnowledgeRouter(options: KnowledgeRouterOptions = {}): Router {
  const maxGraphPages = options.maxGraphPages ?? GRAPH_MAX_PAGES;
  const images = options.imageStore;
  const getWorkspaceRow = options.getWorkspaceRow ?? ((): null => null);
  const requireWorkspaceRow = (workspaceId: string | null | undefined): { id: string; name: string; path: string } => {
    if (workspaceId === undefined || workspaceId === null || workspaceId === '') throw new ValidationError('该 scope 必须提供 workspace_id');
    const row = getWorkspaceRow(workspaceId);
    if (row === null) throw new ApiError(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在');
    return row;
  };

  /** scope selector + 两目录视图（索引按目录缓存；ensureFresh 在每次读前差量刷新） */
  const viewFor = (selector: ScopeSelector, workspaceId?: string | null) => {
    const workspacePath = selector.scope === 'common' ? null : requireWorkspaceRow(workspaceId ?? selector.workspace_id ?? undefined).path;
    return knowledgeDocsStore.view(selector, workspacePath, options.docsPaths);
  };
  /** scope 对应的目录与仓储（写路径用；identity 与目录一一对应） */
  const targetFor = (scope: 'workspace' | 'common', workspaceId?: string | null): { repo: ReturnType<typeof knowledgeDocsStore.repoFor>; workspacePath: string | null; docsDir: string } => {
    const identity = scope === 'workspace'
      ? { scope: 'workspace' as const, workspace_id: workspaceId ?? null }
      : { scope: 'common' as const, workspace_id: null };
    const workspacePath = scope === 'workspace' ? requireWorkspaceRow(workspaceId ?? undefined).path : null;
    const docsDir = knowledgeDocsStore.resolveDir(identity, workspacePath, options.docsPaths);
    return { repo: knowledgeDocsStore.repoFor(docsDir, identity, options.instanceId === undefined ? {} : { instanceId: options.instanceId }), workspacePath, docsDir };
  };

  const mutation = <T>(req: { headers: Record<string, unknown>; body?: unknown; query?: unknown; method: string; path: string }, perform: () => T): T => {
    if (options.mutationDb === undefined) return perform();
    return httpMutation(options.mutationDb, req as Parameters<typeof httpMutation>[1], perform).result;
  };

  /** 图片可见性：common 页对所有工作区可读；workspace 页只对同工作区可读；跨区/旧库行 → 403/404 区分 */
  function requireVisiblePage(pageId: string, rawScope: unknown, rawWorkspaceId: unknown) {
    const page = viewFor({ scope: 'common' }).pageById(pageId);
    const workspaceId = typeof rawWorkspaceId === 'string' && rawWorkspaceId !== '' ? rawWorkspaceId : null;
    if (page) return page.page;
    if (workspaceId === null) throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
    const scoped = viewFor({ scope: 'workspace', workspace_id: workspaceId }).pageById(pageId);
    if (scoped) return scoped.page;
    // 旧库兼容：页不在 Docs（未导出），按旧库行判断归属以区分 403/404
    const owner = options.legacyPageOwner?.(pageId) ?? null;
    if (owner !== null) throw new ApiError(403, KnowledgeErrorCode.SCOPE_FORBIDDEN, '该知识页属于其它工作区，无权访问其图片');
    throw new ApiError(404, 'PAGE_NOT_FOUND', '知识页不存在');
  }

  /** 页面出链统计（详情页 linkStats；从索引取，不落库。embed 未命中也计入 unresolved，P2-03） */
  function linkStatsOf(page: KnowledgePage, view: ReturnType<typeof viewFor>): { backlinks_count: number; links_out_count: number; unresolved_links: Array<{ raw_target: string; alias: string | null; heading: string | null }> } {
    const index = page.scope === 'common' ? view.common : view.requireWorkspace();
    const entry = index.getByIdIncludeArchived(page.id);
    const parsed = entry !== null ? parseKnowledgeRefs(entry.body, entry.meta.slug) : null;
    const pageRefs = parsed === null ? [] : [...parsed.links, ...parsed.embeds];
    const unresolved = pageRefs
      .filter(link => index.lookupTarget(link.target_slug_norm) === null
        && (page.scope === 'common' || view.common.lookupTarget(link.target_slug_norm) === null))
      .map(link => ({ raw_target: link.raw_target, alias: link.alias, heading: 'heading' in link ? (link.heading as string | null) : null }))
      .sort((a, b) => a.raw_target.localeCompare(b.raw_target));
    return {
      backlinks_count: view.backlinks(page.id).length,
      links_out_count: pageRefs.length,
      unresolved_links: unresolved,
    };
  }

  const router = Router();

  // ---- 检索（bm25 排序 + 1–2 字符子串 + snippet，由 .index.json/内存索引承载）----
  router.get('/search', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), q: z.string(), limit: integerQuery(5, 20).refine(n => n > 0) }).strict(), req.query);
    const withLink = (row: { page_id: string; title: string; slug: string; scope: string; workspace_id: string | null; revision: number }) => ({
      ...row,
      ...knowledgeLinkFields({ id: row.page_id, title: row.title, slug: row.slug, scope: row.scope as 'common' | 'workspace', workspace_id: row.workspace_id, revision: row.revision }),
    });
    // 未知工作区：与旧「库内无行」一致，返回空集（不 404）
    const workspacePath = input.scope === 'common' ? null : (input.workspace_id !== undefined ? getWorkspaceRow(input.workspace_id)?.path ?? null : null);
    if (input.scope !== 'common' && workspacePath === null && input.workspace_id !== undefined) {
      res.json([]);
      return;
    }
    const view = knowledgeDocsStore.view(
      input.scope === 'common' ? { scope: 'common' } : { scope: input.scope, workspace_id: input.workspace_id ?? null },
      workspacePath,
      options.docsPaths,
    );
    const { items, truncated } = view.search({ query: input.q, limit: input.limit, now: Date.now() });
    if (input.scope === 'both') res.set('X-Knowledge-Truncated', truncated ? 'true' : 'false');
    res.json(items.map(withLink));
  });

  // ---- 图聚合（rows 从索引；links/embeds 由正文引用解析，tag/attachment/unresolved 合成节点，P2-03）----
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
    const allowedKinds = ['link', 'source', 'keyword', 'embed'] as const;
    if (kinds.length === 0 || kinds.some(kind => !allowedKinds.includes(kind as typeof allowedKinds[number]))) throw new ValidationError('edge_kinds 仅支持 link,source,keyword,embed');
    const uniqueKinds = [...new Set(kinds)] as Array<'link' | 'source' | 'keyword' | 'embed'>;
    const view = viewFor({ scope: input.scope, workspace_id: input.workspace_id ?? null }, input.workspace_id);
    // rows：两目录合并去重（按 id 排序，对齐旧跨库合并口径），pageTotal 求和
    const workspaceRows = input.scope === 'common' ? null : view.requireWorkspace().graphRows(maxGraphPages);
    const commonRows = input.scope === 'workspace' ? null : view.common.graphRows(maxGraphPages);
    const mergedRows = [...(workspaceRows?.rows ?? []), ...(commonRows?.rows ?? [])]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .filter((row, index, all) => index === 0 || all[index - 1]!.id !== row.id)
      .slice(0, maxGraphPages);
    const pageTotal = (workspaceRows?.pageTotal ?? 0) + (commonRows?.pageTotal ?? 0);
    const pagesTruncated = (workspaceRows?.pagesTruncated ?? false) || (commonRows?.pagesTruncated ?? false) || mergedRows.length > maxGraphPages;
    if (pagesTruncated) {
      console.warn('[knowledge-graph] 页面集合被上限截断：图只覆盖已加载页', {
        scope: input.scope, workspace_id: input.workspace_id ?? null, loaded: mergedRows.length, limit: maxGraphPages,
      });
    }
    // P2-03：合成节点（tag/attachment/unresolved）与 tag/attachment 边；unresolved 边并入 links（kind:'link'）
    const { links, unresolved, tags, attachments } = view.graphLinks();
    const unresolvedById = new Map<string, { ref: string; raw_target: string }>();
    const unresolvedEdges: Array<{ source: string; target: string; weight: number; kind: 'link' }> = [];
    for (const item of unresolved) {
      const nodeId = `unresolved:${item.ref}`;
      const existing = unresolvedById.get(nodeId);
      if (existing === undefined) unresolvedById.set(nodeId, { ref: item.ref, raw_target: item.raw_target });
      unresolvedEdges.push({ source: item.source, target: nodeId, weight: item.weight, kind: 'link' });
    }
    const tagRows: GraphInputRow[] = tags.map(tag => ({
      id: `tag:${tag.tag_norm}`,
      title: `#${tag.raw_tag}`,
      scope: 'common' as const,
      workspace_id: null,
      body_md: '',
      body_chars: 0,
      sources: [],
      category: null,
      landed: null,
      node_type: 'tag' as const,
    }));
    const attachmentRows: GraphInputRow[] = attachments.map(attachment => ({
      id: attachment.node_id,
      title: attachment.name,
      scope: attachment.scope,
      workspace_id: attachment.workspace_id,
      body_md: '',
      body_chars: 0,
      sources: [],
      category: null,
      landed: null,
      node_type: 'attachment' as const,
    }));
    const unresolvedRows: GraphInputRow[] = [...unresolvedById.entries()].map(([id, value]) => ({
      id,
      title: value.raw_target,
      scope: 'common' as const,
      workspace_id: null,
      body_md: '',
      body_chars: 0,
      sources: [],
      category: null,
      landed: null,
      node_type: 'unresolved' as const,
    }));
    const tagEdges = tags.flatMap(tag => tag.refs.map(ref => ({ source: ref.source, target: `tag:${tag.tag_norm}`, weight: ref.weight, kind: 'link' as const })));
    const attachmentEdges = attachments.flatMap(attachment => attachment.refs.map(ref => ({ source: ref.source, target: attachment.node_id, weight: ref.weight, kind: 'embed' as const })));
    const syntheticRows: GraphInputRow[] = [...tagRows, ...attachmentRows, ...unresolvedRows];
    res.json(buildKnowledgeGraph([...mergedRows, ...syntheticRows], {
      pagesTruncated,
      pageTotal,
      edgeKinds: uniqueKinds,
      links: [
        ...links.map(({ source, target, weight, kind }) => ({ source, target, weight, kind })),
        ...unresolvedEdges,
        ...tagEdges,
        ...attachmentEdges,
      ],
      includeIsolated: input.include_isolated === 'true',
      limitNodes: Math.min(input.limit_nodes, GRAPH_MAX_NODES),
      limitEdges: Math.min(input.limit_edges, GRAPH_MAX_EDGES),
    }));
  });

  // ---- 列表 ----
  router.get('/pages', (req, res) => {
    const input = parse(z.object({ scope: z.enum(['common', 'workspace', 'both']), workspace_id: z.string().min(1).optional(), status: z.enum(['active', 'archived', 'deleted', 'all']).default('active'), include_expired: z.enum(['true', 'false']).default('false'), offset: integerQuery(0, Number.MAX_SAFE_INTEGER), limit: integerQuery(20, 100).refine(n => n > 0) }).strict(), req.query);
    if (input.scope !== 'both') validateKnowledgeScope(input as KnowledgeScope);
    else if (!input.workspace_id) throw new ValidationError('both 必须提供 workspace_id');
    const includeExpired = input.include_expired === 'true';
    const now = Date.now();
    const statusFilter = (meta: { status: string; expires_at: number | null }): boolean => {
      if (input.status !== 'all' && meta.status !== input.status) return false;
      if (!includeExpired && meta.expires_at !== null && meta.expires_at <= now) return false;
      return true;
    };
    const workspacePath = input.scope === 'common' ? null : (input.workspace_id !== undefined ? getWorkspaceRow(input.workspace_id)?.path ?? null : null);
    if (input.scope !== 'common' && workspacePath === null && input.workspace_id !== undefined) {
      res.json({ items: [], next_offset: null });
      return;
    }
    const view = knowledgeDocsStore.view(
      input.scope === 'common' ? { scope: 'common' } : { scope: input.scope, workspace_id: input.workspace_id ?? null },
      workspacePath,
      options.docsPaths,
    );
    const fetch = (index: DocsIndex) => index.allEntries()
      .filter(entry => entry.issues.length === 0 && statusFilter(entry.meta))
      .map(entryToRow)
      .sort((left, right) => (right.updated_at - left.updated_at) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const { items, next_offset } = view.listPages(fetch, input.offset, input.limit);
    res.json({
      items: items.map(row => ({ ...row, ...knowledgeLinkFields(row) })),
      next_offset,
    });
  });

  // ---- 历史（§8 #5：放弃单页历史；旧库历史走 export-legacy 只读导出）----
  router.get('/pages/:id/revisions', (_req, res) => {
    res.json({ items: [], next_offset: null });
  });
  router.get('/pages/:id/revisions/:revision', () => {
    throw new ApiError(404, KnowledgeErrorCode.REVISION_NOT_FOUND, '文件事实源不保留单页历史；旧库历史可通过 export-legacy 只读导出');
  });

  // ---- 引用解析（四态；uuid/短前缀/slug）----
  router.get('/resolve', (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    if (ref.trim() === '') throw new ValidationError('ref 不能为空');
    const rawScope = typeof req.query.scope === 'string' ? req.query.scope : 'both';
    if (!['common', 'workspace', 'both'].includes(rawScope)) throw new ValidationError('scope 取值必须是：workspace / common / both');
    const workspaceId = typeof req.query.workspace_id === 'string' ? req.query.workspace_id : undefined;
    if (rawScope === 'workspace' || rawScope === 'both') {
      requireWorkspaceRow(workspaceId);
    }
    const scope: ResolveScope = rawScope === 'common'
      ? { scope: 'common' }
      : rawScope === 'workspace'
        ? { scope: 'workspace', workspace_id: workspaceId! }
        : { scope: 'both', workspace_id: workspaceId! };
    const view = viewFor(scope, workspaceId);
    const result = resolveRefInFiles(ref, scope, view, options.legacyPageOwner ?? null);
    if (result.state === 'resolved') { res.json(result); return; }
    if (result.state === 'deleted') throw new ApiError(410, KnowledgeErrorCode.DELETED, result.message);
    if (result.state === 'ambiguous') {
      throw new ApiError(409, KnowledgeErrorCode.REF_AMBIGUOUS, result.message, result.candidates === undefined ? undefined : { candidates: result.candidates });
    }
    // not_found：uuid 引用若存在但属于别的范围/别的工作区 → 403（**不回显标题**）
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim())) {
      const id = ref.trim();
      const crossEntry = scope.scope === 'workspace' ? view.common.getByIdIncludeArchived(id) : null;
      const legacy = options.legacyPageOwner?.(id) ?? null;
      if (crossEntry !== null) {
        throw new ApiError(403, KnowledgeErrorCode.SCOPE_FORBIDDEN, '该知识页属于 common 范围，请用 --scope common 解析');
      }
      if (legacy !== null) {
        throw new ApiError(403, KnowledgeErrorCode.SCOPE_FORBIDDEN, legacy.scope === 'common'
          ? '该知识页属于 common 范围，请用 --scope common 解析'
          : '该知识页属于另一个工作区，当前范围无权读取');
      }
    }
    throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, result.message);
  });

  // ---- 来源反查（扫 front matter sources[]）----
  router.get('/find-source', (req, res) => {
    const input = parse(z.object({
      path: z.string().min(1),
      scope: z.enum(['common', 'workspace', 'both']).default('both'),
      workspace_id: z.string().min(1).optional(),
    }).strict(), req.query);
    if (input.scope !== 'common' && !input.workspace_id) throw new ValidationError('scope=workspace/both 时必须提供 workspace_id');
    const view = viewFor({ scope: input.scope, workspace_id: input.workspace_id ?? null }, input.workspace_id);
    const term = input.path.trim();
    const indexes = input.scope === 'common' ? [view.common] : input.scope === 'workspace' ? [view.requireWorkspace()] : [view.requireWorkspace(), view.common];
    const items = indexes.flatMap(index => index.allEntries()
      .filter(entry => entry.issues.length === 0 && entry.meta.status !== 'archived')
      .filter(entry => entry.meta.sources.some(source => source.locator === term || source.content_hash === term || source.source_id === term))
      .map(entry => ({
        id: entry.meta.id, slug: entry.meta.slug, title: entry.meta.title,
        scope: entry.meta.scope, workspace_id: entry.meta.workspace_id, revision: entry.meta.revision, status: entry.meta.status,
      })))
      .sort((left, right) => (right.id < left.id ? 1 : right.id > left.id ? -1 : 0))
      .map(item => ({ ...item, ...knowledgeLinkFields(item) }));
    res.json({ path: input.path, items });
  });

  // ---- PROV-B 打开本机文件（工作区根只能来自注册表）----
  router.post('/files/open', async (req, res) => {
    const input = parse(knowledgeFileOpenSchema, req.body ?? {});
    const row = requireWorkspaceRow(input.workspace_id);
    // fileOpener.resolveLocalFile 以 getWorkspace(db, id) 取根；最小 shim 复用同一实现，不引入 Db 注入
    const shimDb = { prepare: () => ({ get: () => row }) } as unknown as Db;
    const file = resolveLocalFile(shimDb, input, options.fileSystem ?? defaultFileSystemDeps);
    const opened = await openLocalFile(file, options.openProcess ?? defaultOpenProcessDeps);
    res.json({ ok: true, opened_with: opened.opened_with, path: file.relativePath, line: input.line ?? null });
  });

  // ---- 详情 ----
  router.get('/pages/:id', (req, res) => {
    const scope = scopeOf(req.query);
    const view = viewFor(scope, scope.workspace_id);
    const found = view.pageById(req.params.id!);
    if (!found) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    res.json({
      ...found.page,
      ...knowledgeLinkFields(found.page),
      ...linkStatsOf(found.page, view),
    });
  });

  // ---- 反链 ----
  router.get('/pages/:id/backlinks', (req, res) => {
    const scope = parse(z.object({
      scope: z.enum(['workspace', 'common', 'both']),
      workspace_id: z.string().min(1).optional(),
    }), req.query);
    const workspaceId = scope.scope === 'common' ? null : scope.workspace_id;
    if (scope.scope !== 'common' && !workspaceId) throw new ValidationError('scope=workspace/both 时必须提供 workspace_id');
    const view = viewFor(scope, workspaceId);
    const found = scope.scope === 'common'
      ? view.common.getById(req.params.id!)
      : scope.scope === 'workspace'
        ? view.requireWorkspace().getById(req.params.id!)
        : (view.common.getById(req.params.id!) ?? view.requireWorkspace().getById(req.params.id!));
    if (!found || found.issues.length > 0) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    const input = parse(z.object({
      scope: z.enum(['common', 'workspace', 'both']).optional(),
      workspace_id: z.string().min(1).optional(),
      offset: integerQuery(0, Number.MAX_SAFE_INTEGER),
      limit: integerQuery(20, 100),
    }).strict(), req.query);
    const all = view.backlinks(found.meta.id);
    res.json({
      items: all.slice(input.offset, input.offset + input.limit),
      page_total: all.length,
    });
  });

  // ---- 未解析出链（S-5：unresolved 端点返回未命中目标；与详情端点 unresolved_links 同口径）----
  router.get('/pages/:id/unresolved', (req, res) => {
    const scope = scopeOf(req.query);
    const view = viewFor(scope, scope.workspace_id);
    const found = scope.scope === 'common'
      ? view.common.getById(req.params.id!)
      : scope.scope === 'workspace'
        ? view.requireWorkspace().getById(req.params.id!)
        : (view.common.getById(req.params.id!) ?? view.requireWorkspace().getById(req.params.id!));
    if (!found || found.issues.length > 0) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    const index = found.meta.scope === 'common' ? view.common : view.requireWorkspace();
    const parsed = parseKnowledgeRefs(found.body, found.meta.slug);
    const items = [...parsed.links, ...parsed.embeds]
      .filter(link => index.lookupTarget(link.target_slug_norm) === null
        && (found.meta.scope === 'common' || view.common.lookupTarget(link.target_slug_norm) === null))
      .map(link => ({ raw_target: link.raw_target, alias: link.alias, heading: 'heading' in link ? (link.heading as string | null) : null }))
      .sort((a, b) => a.raw_target.localeCompare(b.raw_target));
    res.json({ items });
  });

  // ---- P2-03：vault 附件上传（本体落 <Docs>/_attachments/，正文用相对路径 ![[_attachments/x.png]]，§8 #3）----
  router.post('/pages/:id/attachments', express.raw({ type: () => true, limit: KNOWLEDGE_IMAGE_MAX_BYTES + 7 * 1024 * 1024 }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('附件请求体必须为 multipart/form-data');
    const parts = parseMultipart(req.body, req.get('Content-Type'));
    const file = parts.files[0];
    if (!file) throw new ValidationError('multipart 里没有附件文件（字段名任意，需带 filename）');
    const page = requireVisiblePage(req.params.id!, parts.fields.scope, parts.fields.workspace_id);
    const { repo, docsDir } = targetFor(page.scope, page.workspace_id);
    const attachmentsDir = repo.ensureAttachmentsDir();
    const base = attachmentFileNameFor(file.filename ?? 'attachment');
    // 重名自动加序号（x.png → x-2.png，最多 20 次；vault 内不覆盖既有文件）
    let fileName = base;
    for (let i = 2; i <= 20 && existsSync(join(attachmentsDir, fileName)); i += 1) {
      const dot = base.lastIndexOf('.');
      fileName = dot <= 0 ? `${base}-${i}` : `${base.slice(0, dot)}-${i}${base.slice(dot)}`;
    }
    writeFileSync(join(attachmentsDir, fileName), file.data);
    const query = new URLSearchParams({ scope: page.scope, ...(page.scope === 'workspace' && page.workspace_id !== null ? { workspace_id: page.workspace_id } : {}) }).toString();
    res.status(201).json({
      file_name: fileName,
      bytes: file.data.length,
      mime: file.contentType,
      path: `${ATTACHMENTS_DIR_NAME}/${fileName}`,
      url: `/api/knowledge/attachments/${encodeURIComponent(fileName)}?${query}`,
    });
  });

  // ---- P2-03：附件读取（相对路径正文渲染的数据源；仅认 <Docs>/_attachments/ 内文件，防路径逃逸）----
  router.get('/attachments/:fileName', (req, res) => {
    const rawScope = typeof req.query.scope === 'string' ? req.query.scope : '';
    if (rawScope !== 'workspace' && rawScope !== 'common') throw new ValidationError('scope 取值必须是：workspace / common');
    const workspaceId = typeof req.query.workspace_id === 'string' && req.query.workspace_id !== '' ? req.query.workspace_id : null;
    if (rawScope === 'workspace' && workspaceId === null) throw new ValidationError('scope=workspace 时必须提供 workspace_id');
    const { docsDir } = targetFor(rawScope, workspaceId);
    const fileName = attachmentFileNameFor(req.params.fileName ?? '');
    const filePath = join(docsDir, ATTACHMENTS_DIR_NAME, fileName);
    assertInsideDocsDir(docsDir, filePath);
    let data: Buffer;
    try {
      data = readFileSync(filePath);
    } catch {
      throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
    }
    res.type(attachmentMimeOf(fileName));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  });

  // ---- 重扫（语义改为：重建两目录扫描索引 + reconcile 只读报告）----
  router.post('/reparse', (req, res) => {
    parse(z.object({ batch_size: z.number().int().min(1).max(2000).optional() }).strict(), req.body ?? {});
    const started = Date.now();
    const reports: unknown[] = [];
    let pages = 0;
    let links = 0;
    const rebuild = (selector: ScopeSelector, workspaceId?: string | null) => {
      const view = viewFor(selector, workspaceId);
      const indexes = selector.scope === 'common'
        ? [view.common]
        : selector.scope === 'workspace'
          ? [view.requireWorkspace()]
          : [view.requireWorkspace(), view.common];
      for (const index of indexes) {
        index.hydrateOrRebuild();
        pages += index.allEntries().length;
        const { links: resolvedLinks } = view.resolvedLinks();
        links += resolvedLinks.length;
        reports.push(reconcileDocsDir(index, { cross: index === view.common ? null : view.common }));
      }
    };
    for (const row of options.listWorkspaceRows?.() ?? []) {
      rebuild({ scope: 'workspace', workspace_id: row.id }, row.id);
    }
    rebuild({ scope: 'common' });
    res.json({ pages, links, duration_ms: Date.now() - started, ...(reports.length > 0 ? { reconcile: reports } : {}) });
  });

  // ---- 导入 ----
  router.post('/pages/import', express.json({ limit: '2mb' }), (req, res) => {
    const body = parse(knowledgeImportSchema, req.body);
    const planned = planImport(body);
    const scope = body.scope === 'workspace' ? { scope: 'workspace' as const, workspace_id: body.workspace_id } : { scope: 'common' as const };
    const { repo } = targetFor(scope.scope, scope.scope === 'workspace' ? scope.workspace_id : null);
    const { sources, evidence } = buildSources(body.content, body.filename, body.format, Date.now());
    const actor = body.actor ?? 'importer';
    const pages: KnowledgePage[] = [];
    for (const draft of planned.drafts) {
      const slug = draft.slug ?? slugifyTitle(draft.title, `${body.format}:${draft.title}`);
      try {
        pages.push(repo.create({
          ...scope,
          slug,
          title: draft.title,
          body_md: draft.body_md,
          domain: draft.domain,
          sources,
          evidence,
          actor,
          ...(draft.category === undefined ? {} : { category: draft.category }),
          ...(draft.landed === undefined ? {} : { landed: draft.landed }),
          ...(body.change_note === undefined ? {} : { change_note: body.change_note }),
        }));
      } catch (error) {
        if (error instanceof ApiError && error.code === KnowledgeErrorCode.EXISTS) {
          const suggestion = repo.suggestSlug(slug);
          throw new ApiError(409, KnowledgeErrorCode.EXISTS,
            `范围内已存在 slug「${slug}」（${scope.scope === 'workspace' ? `工作区 ${scope.workspace_id}` : '公共库'}）`
            + (suggestion === null ? '；请换一个 slug' : `；可改用「${suggestion}」或先归档同 slug 的旧页`));
        }
        throw error;
      }
    }
    res.json({
      pages: pages.map(page => ({ ...page, ...knowledgeLinkFields(page) })),
      warnings: planned.warnings,
      page_commit: { path: '', relative_path: '', committed: false, commit: null, reason: '文件事实源：导入落盘即提交，不再产生每页 git 快照', skipped: true },
    });
  });

  // ---- 创建 ----
  router.post('/pages', (req, res) => {
    const body = parse(knowledgeCreateSchema, req.body);
    const scope = scopeOf(body);
    const { scope: _scope, workspace_id: _workspace, ...content } = body;
    const { repo, workspacePath, docsDir } = targetFor(scope.scope, scope.workspace_id);
    const result = mutation(req, () => repo.create({ ...content, scope: scope.scope, workspace_id: scope.workspace_id }));
    res.json({
      ...result,
      ...knowledgeLinkFields(result),
      ...(result.scope === 'workspace' ? { page_commit: fileCommitMarker(result, docsDir, workspacePath) } : { page_commit: null }),
    });
  });

  // ---- 修订（expected_revision CAS；外部编辑 → 409 FILE_CONFLICT）----
  router.put('/pages/:id', (req, res) => {
    const { expected_revision, scope: _scope, workspace_id: _workspace, ...patch } = parse(knowledgeReviseSchema, req.body);
    const scope = scopeOf(req.body);
    const { repo, workspacePath, docsDir } = targetFor(scope.scope, scope.workspace_id);
    const result = mutation(req, () => repo.revise(req.params.id!, scope, expected_revision, patch));
    res.json({
      ...result,
      ...knowledgeLinkFields(result),
      ...(result.scope === 'workspace' ? { page_commit: fileCommitMarker(result, docsDir, workspacePath) } : { page_commit: null }),
    });
  });

  // ---- 状态操作（archive/restore 重写 front matter；delete 撤文件）----
  router.post('/pages/:id/actions', async (req, res) => {
    const body = parse(knowledgeActionSchema, req.body);
    const scope = scopeOf(body);
    const { repo, workspacePath, docsDir } = targetFor(scope.scope, scope.workspace_id);
    const result = mutation(req, () => repo.setStatus(req.params.id!, scope, body.expected_revision, body.action, body.actor));
    if (body.action === 'delete' && images !== undefined) {
      try { await images.removePageFiles(req.params.id!); } catch { /* legacy 清理失败不影响删除 */ }
    }
    res.json({
      ...result,
      ...(result.scope === 'workspace' && body.action !== 'delete' ? { page_commit: fileCommitMarker(result, docsDir, workspacePath) } : { page_commit: null }),
    });
  });

  // ---- KB-IMG-1：知识页图片（legacy 兼容存储；vault 自包含布局 <Docs>/_attachments/ 由 P2-03 接管）----
  router.post('/pages/:id/images', express.raw({ type: () => true, limit: KNOWLEDGE_IMAGE_MAX_BYTES + 7 * 1024 * 1024 }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('图片请求体必须为 multipart/form-data');
    if (images === undefined) throw new ApiError(503, 'IMAGE_STORE_UNAVAILABLE', '图片存储未装配（文件事实源下旧图片端点仅供兼容读取）');
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
      scope: page.scope,
      workspace_id: page.workspace_id,
    });
    res.status(201).json(saved);
  });

  router.get('/images/:attachmentId', (req, res) => {
    if (images === undefined) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    const found = images.locate(req.params.attachmentId!);
    if (!found) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    requireVisiblePage(found.row.page_id, req.query.scope, req.query.workspace_id);
    res.type(found.row.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(found.path, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片文件不存在'); });
  });

  router.delete('/images/:attachmentId', async (req, res) => {
    if (images === undefined) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    const found = images.locate(req.params.attachmentId!);
    if (!found) throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片不存在');
    requireVisiblePage(found.row.page_id, req.query.scope, req.query.workspace_id);
    await images.remove(req.params.attachmentId!);
    res.status(204).end();
  });

  return router;
}

// ---- 模块级辅助 ----

/** 附件文件名清洗：取 basename、去路径成分与非法字符（防逃逸；Windows 保留字符替换为 `-`） */
function attachmentFileNameFor(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f<>:"|?*]/g, '-').trim();
  if (base === '' || base === '.' || base === '..') throw new ValidationError('附件文件名不能为空');
  return base.slice(0, 120);
}

/** 附件 Content-Type（按扩展名；未知 → application/octet-stream） */
function attachmentMimeOf(fileName: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  };
  return table[ext] ?? 'application/octet-stream';
}

function entryToRow(entry: { meta: KnowledgeFileMeta }): KnowledgePageListRow {
  const meta = entry.meta;
  return {
    id: meta.id, scope: meta.scope, workspace_id: meta.workspace_id, slug: meta.slug, title: meta.title,
    status: meta.status, revision: meta.revision, expires_at: meta.expires_at, created_by: meta.created_by,
    updated_by: meta.updated_by, created_at: meta.created_at, updated_at: meta.updated_at,
    category: meta.category, landed: meta.landed, domain: meta.domain,
  };
}

/** 文件事实源下的四态 resolve（uuid / ≥8 位短前缀 / slug；歧义不猜第一条） */
function resolveRefInFiles(
  ref: string,
  scope: ResolveScope,
  view: ReturnType<typeof knowledgeDocsStore.view>,
  legacyOwner: KnowledgeRouterOptions['legacyPageOwner'] | null,
): KnowledgeResolveResult {
  const trimmed = ref.trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const indexes = scope.scope === 'common'
    ? [view.common]
    : scope.scope === 'workspace'
      ? [view.requireWorkspace()]
      : [view.requireWorkspace(), view.common];
  const findIn = (id: string) => {
    for (const index of indexes) {
      const entry = index.getByIdIncludeArchived(id);
      if (entry !== null) return entry;
    }
    return null;
  };
  if (UUID_RE.test(trimmed)) {
    const entry = findIn(trimmed);
    if (entry === null) return { state: 'not_found', message: '知识页不存在' };
    return resolvedFromEntry(entry);
  }
  if (/^[0-9a-f]{8,}$/i.test(trimmed)) {
    const matches: Array<{ id: string; status: string }> = [];
    for (const index of indexes) {
      for (const entry of index.allEntries()) {
        if (entry.meta.id.toLowerCase().startsWith(trimmed.toLowerCase())) matches.push({ id: entry.meta.id, status: entry.meta.status });
      }
    }
    const live = matches.filter(row => row.status !== 'deleted');
    if (live.length > 1) return { state: 'ambiguous', message: `id 前缀 ${trimmed} 命中 ${live.length} 页，请用完整 id`, candidates: live.map(row => row.id) };
    if (live.length === 1) return resolveRefInFiles(live[0]!.id, scope, view, legacyOwner);
    if (matches.length === 1) return { state: 'deleted', message: '知识页已删除（可查看历史版本）' };
    return { state: 'not_found', message: '知识页不存在' };
  }
  // slug：范围内唯一精确命中；跨目录同名 → 歧义（C11）
  const ids: string[] = [];
  for (const index of indexes) {
    for (const entry of index.getBySlug(trimmed)) {
      if (entry.issues.length === 0 && !ids.includes(entry.meta.id)) ids.push(entry.meta.id);
    }
  }
  if (ids.length === 0) return { state: 'not_found', message: '知识页不存在' };
  if (ids.length > 1) return { state: 'ambiguous', message: `slug「${trimmed}」命中 ${ids.length} 页（可能有 common 与 workspace 同名），请改用完整 id`, candidates: ids };
  return resolveRefInFiles(ids[0]!, scope, view, legacyOwner);
}

function resolvedFromEntry(entry: { meta: KnowledgeFileMeta }): KnowledgeResolveResult {
  const page = {
    id: entry.meta.id,
    title: entry.meta.title,
    scope: entry.meta.scope,
    workspace_id: entry.meta.workspace_id,
    slug: entry.meta.slug,
    revision: entry.meta.revision,
  };
  return {
    state: 'resolved',
    ...page,
    status: entry.meta.status === 'archived' ? 'archived' : 'active',
    ...knowledgeLinkFields(page),
    redirect_to: null,
  };
}
