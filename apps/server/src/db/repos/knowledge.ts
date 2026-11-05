import { randomUUID } from 'node:crypto';
import { KnowledgeErrorCode } from '../../api/knowledgeCodes.js';
import { knowledgeScopeWhere, type KnowledgeScopeFilter } from './knowledgeScope.js';
import type { KnowledgeEvidence, KnowledgePage, KnowledgeRevision, KnowledgeScope, KnowledgeSource } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { syncPageLinks } from '../../services/knowledgeLinks.js';
import { ApiError, ValidationError } from '../../errors.js';
import { KNOWLEDGE_DOMAINS, KNOWLEDGE_DOMAIN_HINT, isKnowledgeDomain, type KnowledgeDomain } from '@agentboard/shared';
import { validateKnowledgeContent, validateKnowledgeScope } from '../../services/knowledge.js';

export type CreateKnowledgePageInput = KnowledgeScope & {
  slug: string; title: string; body_md: string; sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  actor: string; expires_at?: number | null; change_note?: string;
  /** KB-MODEL：四类内容模型；缺省 legacy */
  category?: KnowledgePage['category'];
  landed?: KnowledgePage['landed'];
  /** KB-CR-1（P5/P7）：创建时必填（运行时由 requireKnowledgeDomain 校验并收窄为词表值） */
  domain?: string | null;
};
export type KnowledgePagePatch = Partial<Pick<KnowledgePage, 'title' | 'body_md' | 'sources' | 'evidence' | 'expires_at' | 'category' | 'landed'>> & { actor: string; change_note?: string; domain?: string | null };

/**
 * KB-MODEL 落库规则（与前端 `normalizeCategory` 同语义）：
 * - 缺失/未知 category → `open`（KB-CR-1：不再落 legacy，新页必须有明确归属）；
 * - `design` 缺 `landed` → 落 `proposed`（fail-open：字段刚上线，老客户端不传不该 400；「未声明落地」按未落地算，
 *   并在响应里回显，避免被误读成已落地）；
 * - 非 design 类一律把 landed 置 null（solved/pinned/open/legacy 没有落地状态）。
 */
/**
 * KB-CR-1（P5/P7）：domain 强制归域。
 * - 创建：缺省/空/非法一律中文 4xx 并列出词表（禁止新页再落 NULL）；
 * - 修订：不传表示「不改」（返回 undefined），传 null/空串表示显式清空（保留给既有页）。
 */
export function requireKnowledgeDomain(domain: unknown): KnowledgeDomain {
  if (domain === undefined || domain === null || domain === '') {
    throw new ValidationError(`创建知识页必须指定 domain，可选：${KNOWLEDGE_DOMAIN_HINT}`);
  }
  if (!isKnowledgeDomain(domain)) {
    throw new ValidationError(`domain 只能是：${KNOWLEDGE_DOMAIN_HINT}（当前：${String(domain)}）`);
  }
  return domain;
}

/** 修订路径：undefined = 不改；null/空串 = 显式清空；非法 = 4xx */
export function normalizeKnowledgeDomain(domain?: string | null): string | null | undefined {
  if (domain === undefined) return undefined;
  if (domain === null || domain === '') return null;
  if (!isKnowledgeDomain(domain)) {
    throw new ValidationError(`domain 只能是：${KNOWLEDGE_DOMAIN_HINT}（当前：${domain}）`);
  }
  return domain;
}

export function normalizePageCategory(category?: string | null, landed?: string | null): { category: NonNullable<KnowledgePage['category']>; landed: KnowledgePage['landed'] } {
  const allowed = ['design', 'solved', 'pinned', 'open', 'legacy'] as const;
  const normalized = (allowed as readonly string[]).includes(category ?? '') ? (category as (typeof allowed)[number]) : 'open';
  if (normalized !== 'design') return { category: normalized, landed: null };
  const landedAllowed = ['landed', 'partial', 'proposed'] as const;
  const nextLanded = (landedAllowed as readonly string[]).includes(landed ?? '') ? (landed as (typeof landedAllowed)[number]) : 'proposed';
  return { category: normalized, landed: nextLanded };
}
const selectPage = `SELECT p.*,r.sources_json,r.evidence_json FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision`;
type PageRow = Omit<KnowledgePage, 'sources' | 'evidence'> & { sources_json: string; evidence_json: string };
function parsePage(row: PageRow): KnowledgePage {
  const { sources_json, evidence_json, ...page } = row;
  return { ...page, sources: JSON.parse(sources_json), evidence: JSON.parse(evidence_json) };
}
function appendRevision(db: Db, page: KnowledgePage, kind: KnowledgeRevision['change_kind'], note: string): void {
  if (note.length > 2000) throw new ValidationError('变更说明过长');
  db.prepare(`INSERT INTO knowledge_revision (id,page_id,revision,title_snapshot,body_snapshot,sources_json,evidence_json,change_kind,status_snapshot,expires_at_snapshot,change_note,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), page.id, page.revision, page.title, page.body_md, JSON.stringify(page.sources), JSON.stringify(page.evidence), kind, page.status, page.expires_at, note, page.updated_by, page.updated_at);
}
function duplicate(error: unknown): never {
  if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw new ApiError(409, KnowledgeErrorCode.EXISTS, '范围内已存在该 slug');
  throw error;
}
/**
 * KB-PAGE-1 缺陷 2：默认**不返回软删页**（`status='deleted'` 不再被当正常页读出来）。
 * 需要区分「不存在」与「已删除」的调用方（`GET /pages/:id` 要回 410）显式传 `includeDeleted`。
 */
/**
 * PERF-2（F4）：按 id 集合批量取页（单条 IN 查询），替代检索结果逐条 getKnowledgePage 的 N+1。
 * 行形状与 getKnowledgePage 一致（selectPage + parsePage）；不在此做 scope 校验——调用方
 * （knowledgeSearch）已在检索 SQL 里做过 scope/状态过滤。
 */
export function getKnowledgePagesByIds(db: Db, ids: readonly string[]): KnowledgePage[] {
  if (ids.length === 0) return [];
  const params: Record<string, string> = {};
  const placeholders = ids.map((id, i) => {
    params[`id${i}`] = id;
    return `@id${i}`;
  }).join(',');
  const rows = db.prepare(`${selectPage} WHERE p.id IN (${placeholders})`).all(params) as PageRow[];
  return rows.map(parsePage);
}

export function getKnowledgePage(
  db: Db,
  pageId: string,
  scope: KnowledgeScope,
  options: { includeDeleted?: boolean } = {},
): KnowledgePage | null {
  validateKnowledgeScope(scope);
  const statusFilter = options.includeDeleted === true ? '' : " AND p.status<>'deleted'";
  const row = db.prepare(`${selectPage} WHERE p.id=? AND p.scope=? AND p.workspace_id IS ?${statusFilter}`)
    .get(pageId, scope.scope, scope.workspace_id ?? null) as PageRow | undefined;
  return row ? parsePage(row) : null;
}
/**
 * KB-PAGE-2：resolve 用的候选查询。
 * - 前缀查询只回 id/status/slug/scope/workspace_id（歧义判定不需要正文）；
 * - scope 传 'both' 时同时看 common 与当前工作区。
 */
export function listKnowledgePageRowsByPrefix(
  db: Db,
  prefix: string,
  scope: { scope: 'common' | 'workspace' } | { scope: 'both'; workspace_id: string },
): Array<{ id: string; status: string; slug: string; scope: 'common' | 'workspace'; workspace_id: string | null }> {
  const where = knowledgeScopeWhere(scope);
  const params: Record<string, string> = { prefix: `${prefix.toLowerCase()}%` };
  if (scope.scope !== 'common') params.workspace = (scope as { workspace_id: string }).workspace_id;
  return db.prepare(`SELECT id,status,slug,scope,workspace_id FROM knowledge_page WHERE lower(id) LIKE @prefix AND ${where}`)
    .all(params) as Array<{ id: string; status: string; slug: string; scope: 'common' | 'workspace'; workspace_id: string | null }>;
}

/** KB-PAGE-2：同 slug 的候选 id（resolve 判定歧义用；不含已删除，除非只有已删除） */
export function findKnowledgePageIdsBySlug(
  db: Db,
  slug: string,
  scope: { scope: 'common' | 'workspace' } | { scope: 'both'; workspace_id: string },
): string[] {
  const where = knowledgeScopeWhere(scope);
  const params: Record<string, string> = { slug };
  if (scope.scope !== 'common') params.workspace = (scope as { workspace_id: string }).workspace_id;
  const live = db.prepare(`SELECT id FROM knowledge_page WHERE slug=@slug AND status<>'deleted' AND ${where}`).all(params) as Array<{ id: string }>;
  if (live.length > 0) return live.map((row) => row.id);
  const all = db.prepare(`SELECT id FROM knowledge_page WHERE slug=@slug AND ${where}`).all(params) as Array<{ id: string }>;
  return all.map((row) => row.id);
}

export function createKnowledgePage(db: Db, input: CreateKnowledgePageInput): KnowledgePage {
  validateKnowledgeScope(input);
  validateKnowledgeContent({ ...input, expires_at: input.expires_at ?? null });
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(input.slug) || input.slug.split('/').includes('..')) throw new ValidationError('slug 格式不合法');
  if (input.scope === 'workspace' && !db.prepare('SELECT 1 FROM workspace WHERE id=?').get(input.workspace_id)) throw new ValidationError('工作空间不存在');
  const now = Date.now();
  const taxonomy = normalizePageCategory(input.category, input.landed);
  // KB-CR-1（P5/P7）：创建强制归域（不再强转 input，domain 已在 CreateKnowledgePageInput 声明）
  const domain = requireKnowledgeDomain(input.domain);
  const page: KnowledgePage = { id: randomUUID(), scope: input.scope, workspace_id: input.workspace_id ?? null, slug: input.slug, title: input.title, body_md: input.body_md, sources: input.sources, evidence: input.evidence, status: 'active', revision: 1, expires_at: input.expires_at ?? null, created_by: input.actor, updated_by: input.actor, created_at: now, updated_at: now, ...taxonomy, domain } as KnowledgePage & { domain: string | null };
  try {
    return db.transaction(() => {
      db.prepare(`INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed,domain) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(page.id, page.scope, page.workspace_id, page.slug, page.title, page.body_md, page.status, page.revision, page.expires_at, page.created_by, page.updated_by, now, now, page.category, page.landed, domain);
      appendRevision(db, page, 'create', input.change_note ?? '');
      // V2-4：写入时解析 `[[双链]]`，与该页 revision 绑定（同一事务）
      syncPageLinks(db, page);
      return page;
    })();
  } catch (error) { return duplicate(error); }
}
function changePage(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, patch: KnowledgePagePatch, kind: KnowledgeRevision['change_kind']): KnowledgePage {
  validateKnowledgeScope(scope);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ValidationError('expected_revision 必须为正整数');
  try {
    return db.transaction(() => {
      const old = getKnowledgePage(db, pageId, scope, { includeDeleted: true });
      if (!old) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
      if (old.revision !== expectedRevision) throw new ApiError(409, KnowledgeErrorCode.REVISION_CONFLICT, '知识页已更新，请重新读取', { current_revision: old.revision });
      if (old.status === 'deleted' || (kind === 'restore' && old.status !== 'archived') || (kind === 'archive' && old.status !== 'active')) throw new ApiError(409, KnowledgeErrorCode.STATE_CONFLICT, '当前状态不允许此操作');
      const taxonomy = normalizePageCategory(
        patch.category !== undefined ? patch.category : old.category,
        patch.landed !== undefined ? patch.landed : old.landed,
      );
      const page: KnowledgePage = { ...old, title: patch.title ?? old.title, body_md: patch.body_md ?? old.body_md, sources: patch.sources ?? old.sources, evidence: patch.evidence ?? old.evidence, expires_at: patch.expires_at === undefined ? old.expires_at : patch.expires_at, updated_by: patch.actor, updated_at: Math.max(Date.now(), old.updated_at + 1), revision: old.revision + 1, status: kind === 'archive' ? 'archived' : kind === 'restore' ? 'active' : kind === 'delete' ? 'deleted' : old.status, ...taxonomy };
      validateKnowledgeContent({ ...page, actor: patch.actor });
      // KB-PAGE-3：domain 也走 CAS 更新（未传则保持原值）
      const nextDomain: string | null = patch.domain === undefined ? ((old as { domain?: string | null }).domain ?? null) : (normalizeKnowledgeDomain(patch.domain) ?? null);
      const result = db.prepare(`UPDATE knowledge_page SET title=?,body_md=?,status=?,revision=?,expires_at=?,updated_by=?,updated_at=?,category=?,landed=?,domain=? WHERE id=? AND scope=? AND workspace_id IS ? AND revision=?`)
        .run(page.title, page.body_md, page.status, page.revision, page.expires_at, page.updated_by, page.updated_at, page.category, page.landed, nextDomain, pageId, scope.scope, scope.workspace_id ?? null, expectedRevision);
      // 响应要反映本次写入的 domain（page 由 ...old 展开，需回填）
      (page as unknown as { domain: string | null }).domain = nextDomain;
      if (result.changes !== 1) {
        const current = db.prepare('SELECT revision FROM knowledge_page WHERE id=? AND scope=? AND workspace_id IS ?').get(pageId, scope.scope, scope.workspace_id ?? null) as { revision: number } | undefined;
        throw new ApiError(409, KnowledgeErrorCode.REVISION_CONFLICT, '知识页已更新，请重新读取', current ? { current_revision: current.revision } : undefined);
      }
      appendRevision(db, page, kind, patch.change_note ?? '');
      // V2-4：新 revision 重建 link 行；旧 revision 的行保留（历史不重算）
      syncPageLinks(db, page);
      return page;
    }).immediate();
  } catch (error) { return duplicate(error); }
}
export function reviseKnowledgePage(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, patch: KnowledgePagePatch): KnowledgePage {
  // KB-PAGE-3：domain 也是可修订字段
    if (!['title', 'body_md', 'sources', 'evidence', 'expires_at', 'category', 'landed', 'domain'].some(k => Object.hasOwn(patch, k))) throw new ValidationError('修订必须包含改动字段');
  return changePage(db, pageId, scope, expectedRevision, patch, 'update');
}
export function setKnowledgePageStatus(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, action: 'archive' | 'restore' | 'delete', actor: string): KnowledgePage {
  if (!['archive', 'restore', 'delete'].includes(action)) throw new ValidationError('未知状态操作');
  return changePage(db, pageId, scope, expectedRevision, { actor }, action);
}

/**
 * KB-DEL（N-03）：`DELETE /api/workspaces/:id` 用的「知识占用」口径。
 *
 * 为什么不能照抄图查询：图/搜索只看 `status='active'`，而删空间的判据要更宽一点——
 * - `status='deleted'`（已软删）的页对用户不可见、也不可再编辑，继续计入会让 delete-space 永远过不去
 *   （`knowledge_page.workspace_id` 是 `ON DELETE RESTRICT`，路由随后会把这些行硬删，见 services/workspaceKnowledgePurge.ts）；
 * - `status='archived'` 仍可 restore、仍是该空间的实际资产，必须继续阻断，避免「归档页被静默销毁」。
 *
 * revision 与页面同口径：只统计**未软删页**的历史，已删页的 revision 不再计入占用、也不出现在拒绝原因里。
 * `pageIds` 按 updated_at 倒序返回未软删页 id，供拒绝信息点名「还剩哪几页」，`pages` 与 `pageIds.length` 恒等。
 */
export interface WorkspaceKnowledgeOccupancy {
  pages: number;
  revisions: number;
  pageIds: string[];
}

export function getWorkspaceKnowledgeOccupancy(db: Db, workspaceId: string): WorkspaceKnowledgeOccupancy {
  const pageIds = (db.prepare(
    `SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id=@workspace AND status<>'deleted' ORDER BY updated_at DESC, id`,
  ).all({ workspace: workspaceId }) as Array<{ id: string }>).map(row => row.id);
  const revisions = (db.prepare(
    `SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id
      WHERE p.scope='workspace' AND p.workspace_id=@workspace AND p.status<>'deleted'`,
  ).get({ workspace: workspaceId }) as { n: number }).n;
  return { pages: pageIds.length, revisions, pageIds };
}
/** KB-DIFF-S：列表项**不再带正文**，只给体积/字符数摘要（正文上限已到 200 万字符，20 条全文可达几十 MB） */
export type KnowledgeRevisionSummary = Omit<KnowledgeRevision, 'body_snapshot'> & { body_bytes: number; body_chars: number };

/**
 * 历史列表。
 * 默认 **不返回** `body_snapshot`（只给 `body_bytes` / `body_chars`），避免一次拉 20 份全文；
 * `includeBody=true` 保留旧行为，供兼容调用方显式索取。
 */
export function listKnowledgeRevisions(db: Db, pageId: string, scope: KnowledgeScope, limit = 20, offset = 0, includeBody = false): Array<KnowledgeRevision | KnowledgeRevisionSummary> {
  if (!getKnowledgePage(db, pageId, scope, { includeDeleted: true })) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new ValidationError('历史分页参数不合法');
  // 字节数按 UTF-8 计（CAST 成 BLOB 再 length），字符数按 UTF-16 码点近似（SQLite length 对 TEXT 即字符数）
  const columns = includeBody
    ? '*, length(CAST(body_snapshot AS BLOB)) AS body_bytes, length(body_snapshot) AS body_chars'
    : 'id, page_id, revision, title_snapshot, change_kind, status_snapshot, expires_at_snapshot, change_note, actor, created_at, sources_json, evidence_json, length(CAST(body_snapshot AS BLOB)) AS body_bytes, length(body_snapshot) AS body_chars';
  return (db.prepare(`SELECT ${columns} FROM knowledge_revision WHERE page_id=? ORDER BY revision DESC LIMIT ? OFFSET ?`).all(pageId, limit, offset) as Array<Record<string, unknown>>).map(row => {
    const { sources_json, evidence_json, body_bytes, body_chars, ...rest } = row as Record<string, unknown> & { sources_json: string; evidence_json: string; body_bytes: number; body_chars: number };
    return {
      ...rest,
      ...(includeBody ? {} : {}),
      body_bytes,
      body_chars,
      sources: JSON.parse(sources_json),
      evidence: JSON.parse(evidence_json),
    } as unknown as KnowledgeRevision | KnowledgeRevisionSummary;
  });
}

/** KB-DIFF-S：单条 revision 全文快照（「点某版本看 diff」按需取，不进列表） */
export function getKnowledgeRevision(db: Db, pageId: string, revision: number, scope: KnowledgeScope): KnowledgeRevision {
  if (!getKnowledgePage(db, pageId, scope, { includeDeleted: true })) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
  if (!Number.isInteger(revision) || revision < 1) throw new ValidationError('revision 不合法');
  const row = db.prepare('SELECT * FROM knowledge_revision WHERE page_id=? AND revision=?').get(pageId, revision) as (Omit<KnowledgeRevision, 'sources' | 'evidence'> & { sources_json: string; evidence_json: string }) | undefined;
  if (row === undefined) throw new ApiError(404, KnowledgeErrorCode.REVISION_NOT_FOUND, `版本 ${revision} 不存在`);
  const { sources_json, evidence_json, ...revisionRow } = row;
  return { ...revisionRow, sources: JSON.parse(sources_json), evidence: JSON.parse(evidence_json) };
}

/** KB-GRAPH：一次查询取「活跃页 + 最新 revision 的 sources」，供图聚合使用（只读，不做 N+1） */
export interface KnowledgeGraphRow {
  id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  title: string;
  /** GRAPH-API-PERF：正文**摘要**（前 GRAPH_TEXT_EXCERPT 字符），不是全文 */
  body_md: string;
  /** 正文全文的字符数（展示「正文长度」用，不必取全文） */
  body_chars: number;
  sources: KnowledgeSource[];
  /** KB-MODEL：星图着色用（旧行缺失 → legacy） */
  category?: string | null;
  landed?: string | null;
}

/**
 * GRAPH-API-PERF：图节点关键词/三元组只用正文**前 N 字符**参与，不把整篇正文拉进内存。
 * 依据：24 页里只要有 1 页 200 万字符，三元组抽取就会吃掉数百毫秒到数十秒（线上实测接口 22s）；
 * 图谱边只表达「主题相近」，标题 + 前 2000 字符已足够，全文不带来额外边质量。
 */
export const GRAPH_TEXT_EXCERPT = 2000;
export interface KnowledgeGraphRowsResult {
  rows: KnowledgeGraphRow[];
  /** 命中 maxPages 上限且可能还有更多页：调用方必须把「页面集合被截断」暴露出来，不得静默 */
  pagesTruncated: boolean;
  /** 该 scope/workspace 下活跃页总数（与 rows 的过滤条件完全一致，不受 maxPages 影响） */
  pageTotal: number;
}

export function listKnowledgeGraphRows(
  db: Db,
  filter: { scope: 'workspace' | 'common' | 'both'; workspace_id?: string | null },
  maxPages = 5000,
): KnowledgeGraphRowsResult {
  const scopeSql = knowledgeScopeWhere(filter as KnowledgeScopeFilter, 'p.');
  // 统计与取行共用同一段 WHERE，避免「一条查全库、一条查本空间」的口径不一致
  const where = `p.status='active' AND ${scopeSql}`;
  const scopeParams: Record<string, string> = {};
  if (filter.scope !== 'common') {
    if (!filter.workspace_id) throw new ValidationError('该 scope 必须提供 workspace_id');
    scopeParams.workspace = filter.workspace_id;
  }
  const pageTotal = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_page p WHERE ${where}`).get(scopeParams) as { n: number }).n;
  const rows = db.prepare(
    `SELECT p.id,p.scope,p.workspace_id,p.title,substr(p.body_md,1,@excerpt) AS body_md,length(p.body_md) AS body_chars,r.sources_json,p.category,p.landed
     FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision
     WHERE ${where} ORDER BY p.id LIMIT @limit`,
  ).all({ ...scopeParams, limit: maxPages + 1, excerpt: GRAPH_TEXT_EXCERPT }) as Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; title: string; body_md: string; body_chars: number; sources_json: string; category: string | null; landed: string | null }>;
  const pagesTruncated = rows.length > maxPages;
  return {
    pagesTruncated,
    pageTotal,
    rows: rows.slice(0, maxPages).map(row => ({
      id: row.id,
      scope: row.scope,
      workspace_id: row.workspace_id,
      title: row.title,
      category: row.category,
      landed: row.landed,
      body_md: row.body_md,
      // GRAPH-API-PERF：body_md 是截断摘要（≤ GRAPH_TEXT_EXCERPT），body_chars 才是全文长度
      body_chars: row.body_chars,
      sources: JSON.parse(row.sources_json) as KnowledgeSource[],
    })),
  };
}

/** KB-PAGE-2b：按 sources 的 locator / content_hash / source_id 反查引用文件的知识页（只读，不建表、不扫历史 revision） */
export interface KnowledgeSourceHit {
  id: string;
  slug: string;
  title: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  revision: number;
  status: KnowledgePage['status'];
}

export function findKnowledgePagesBySource(
  db: Db,
  input: { term: string; scope: 'common' | 'workspace' | 'both'; workspace_id?: string | null },
): KnowledgeSourceHit[] {
  const term = input.term.trim();
  if (term === '') throw new ValidationError('path 不能为空');
  const scopeSql = knowledgeScopeWhere(input as KnowledgeScopeFilter, 'p.');
  const params: Record<string, string> = { needle: `%${term.replace(/[\\%_]/g, ch => `\\${ch}`)}%` };
  if (input.scope !== 'common') {
    if (!input.workspace_id) throw new ValidationError('该 scope 必须提供 workspace_id');
    params.workspace = input.workspace_id;
  }
  // 先用 LIKE 缩小候选（只扫页面当前 revision，历史版本不参与），再按 sources 精确匹配，避免反序列化全表
  const rows = db.prepare(
    `SELECT p.id,p.slug,p.title,p.scope,p.workspace_id,p.revision,p.status,r.sources_json
     FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision
     WHERE p.status<>'deleted' AND ${scopeSql} AND r.sources_json LIKE @needle ESCAPE '\\'
     ORDER BY p.updated_at DESC,p.id`,
  ).all(params) as Array<KnowledgeSourceHit & { sources_json: string }>;
  return rows
    .filter(row => {
      const sources = JSON.parse(row.sources_json) as KnowledgeSource[];
      return Array.isArray(sources) && sources.some(source => source.locator === term || source.content_hash === term || source.source_id === term);
    })
    .map(({ sources_json: _sourcesJson, ...hit }) => hit);
}
