import { randomUUID } from 'node:crypto';
import type { KnowledgeEvidence, KnowledgePage, KnowledgeRevision, KnowledgeScope, KnowledgeSource } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { syncPageLinks } from '../../services/knowledgeLinks.js';
import { ApiError, ValidationError } from '../../errors.js';
import { validateKnowledgeContent, validateKnowledgeScope } from '../../services/knowledge.js';

export type CreateKnowledgePageInput = KnowledgeScope & {
  slug: string; title: string; body_md: string; sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  actor: string; expires_at?: number | null; change_note?: string;
  /** KB-MODEL：四类内容模型；缺省 legacy */
  category?: KnowledgePage['category'];
  landed?: KnowledgePage['landed'];
};
export type KnowledgePagePatch = Partial<Pick<KnowledgePage, 'title' | 'body_md' | 'sources' | 'evidence' | 'expires_at' | 'category' | 'landed'>> & { actor: string; change_note?: string };

/**
 * KB-MODEL 落库规则（与前端 `normalizeCategory` 同语义）：
 * - 缺失/未知 category → `legacy`；
 * - `design` 缺 `landed` → 落 `proposed`（fail-open：字段刚上线，老客户端不传不该 400；「未声明落地」按未落地算，
 *   并在响应里回显，避免被误读成已落地）；
 * - 非 design 类一律把 landed 置 null（solved/pinned/open/legacy 没有落地状态）。
 */
export function normalizePageCategory(category?: string | null, landed?: string | null): { category: NonNullable<KnowledgePage['category']>; landed: KnowledgePage['landed'] } {
  const allowed = ['design', 'solved', 'pinned', 'open', 'legacy'] as const;
  const normalized = (allowed as readonly string[]).includes(category ?? '') ? (category as (typeof allowed)[number]) : 'legacy';
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
  if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw new ApiError(409, 'KNOWLEDGE_EXISTS', '范围内已存在该 slug');
  throw error;
}
/**
 * KB-PAGE-1 缺陷 2：默认**不返回软删页**（`status='deleted'` 不再被当正常页读出来）。
 * 需要区分「不存在」与「已删除」的调用方（`GET /pages/:id` 要回 410）显式传 `includeDeleted`。
 */
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
export function createKnowledgePage(db: Db, input: CreateKnowledgePageInput): KnowledgePage {
  validateKnowledgeScope(input);
  validateKnowledgeContent({ ...input, expires_at: input.expires_at ?? null });
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(input.slug) || input.slug.split('/').includes('..')) throw new ValidationError('slug 格式不合法');
  if (input.scope === 'workspace' && !db.prepare('SELECT 1 FROM workspace WHERE id=?').get(input.workspace_id)) throw new ValidationError('工作空间不存在');
  const now = Date.now();
  const taxonomy = normalizePageCategory(input.category, input.landed);
  const page: KnowledgePage = { id: randomUUID(), scope: input.scope, workspace_id: input.workspace_id ?? null, slug: input.slug, title: input.title, body_md: input.body_md, sources: input.sources, evidence: input.evidence, status: 'active', revision: 1, expires_at: input.expires_at ?? null, created_by: input.actor, updated_by: input.actor, created_at: now, updated_at: now, ...taxonomy };
  try {
    return db.transaction(() => {
      db.prepare(`INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(page.id, page.scope, page.workspace_id, page.slug, page.title, page.body_md, page.status, page.revision, page.expires_at, page.created_by, page.updated_by, now, now, page.category, page.landed);
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
      if (!old) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
      if (old.revision !== expectedRevision) throw new ApiError(409, 'KNOWLEDGE_REVISION_CONFLICT', '知识页已更新，请重新读取', { current_revision: old.revision });
      if (old.status === 'deleted' || (kind === 'restore' && old.status !== 'archived') || (kind === 'archive' && old.status !== 'active')) throw new ApiError(409, 'KNOWLEDGE_STATE_CONFLICT', '当前状态不允许此操作');
      const taxonomy = normalizePageCategory(
        patch.category !== undefined ? patch.category : old.category,
        patch.landed !== undefined ? patch.landed : old.landed,
      );
      const page: KnowledgePage = { ...old, title: patch.title ?? old.title, body_md: patch.body_md ?? old.body_md, sources: patch.sources ?? old.sources, evidence: patch.evidence ?? old.evidence, expires_at: patch.expires_at === undefined ? old.expires_at : patch.expires_at, updated_by: patch.actor, updated_at: Math.max(Date.now(), old.updated_at + 1), revision: old.revision + 1, status: kind === 'archive' ? 'archived' : kind === 'restore' ? 'active' : kind === 'delete' ? 'deleted' : old.status, ...taxonomy };
      validateKnowledgeContent({ ...page, actor: patch.actor });
      const result = db.prepare(`UPDATE knowledge_page SET title=?,body_md=?,status=?,revision=?,expires_at=?,updated_by=?,updated_at=?,category=?,landed=? WHERE id=? AND scope=? AND workspace_id IS ? AND revision=?`)
        .run(page.title, page.body_md, page.status, page.revision, page.expires_at, page.updated_by, page.updated_at, page.category, page.landed, pageId, scope.scope, scope.workspace_id ?? null, expectedRevision);
      if (result.changes !== 1) {
        const current = db.prepare('SELECT revision FROM knowledge_page WHERE id=? AND scope=? AND workspace_id IS ?').get(pageId, scope.scope, scope.workspace_id ?? null) as { revision: number } | undefined;
        throw new ApiError(409, 'KNOWLEDGE_REVISION_CONFLICT', '知识页已更新，请重新读取', current ? { current_revision: current.revision } : undefined);
      }
      appendRevision(db, page, kind, patch.change_note ?? '');
      // V2-4：新 revision 重建 link 行；旧 revision 的行保留（历史不重算）
      syncPageLinks(db, page);
      return page;
    }).immediate();
  } catch (error) { return duplicate(error); }
}
export function reviseKnowledgePage(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, patch: KnowledgePagePatch): KnowledgePage {
  if (!['title', 'body_md', 'sources', 'evidence', 'expires_at', 'category', 'landed'].some(k => Object.hasOwn(patch, k))) throw new ValidationError('修订必须包含改动字段');
  return changePage(db, pageId, scope, expectedRevision, patch, 'update');
}
export function setKnowledgePageStatus(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, action: 'archive' | 'restore' | 'delete', actor: string): KnowledgePage {
  if (!['archive', 'restore', 'delete'].includes(action)) throw new ValidationError('未知状态操作');
  return changePage(db, pageId, scope, expectedRevision, { actor }, action);
}
/** KB-DIFF-S：列表项**不再带正文**，只给体积/字符数摘要（正文上限已到 200 万字符，20 条全文可达几十 MB） */
export type KnowledgeRevisionSummary = Omit<KnowledgeRevision, 'body_snapshot'> & { body_bytes: number; body_chars: number };

/**
 * 历史列表。
 * 默认 **不返回** `body_snapshot`（只给 `body_bytes` / `body_chars`），避免一次拉 20 份全文；
 * `includeBody=true` 保留旧行为，供兼容调用方显式索取。
 */
export function listKnowledgeRevisions(db: Db, pageId: string, scope: KnowledgeScope, limit = 20, offset = 0, includeBody = false): Array<KnowledgeRevision | KnowledgeRevisionSummary> {
  if (!getKnowledgePage(db, pageId, scope, { includeDeleted: true })) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
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
  if (!getKnowledgePage(db, pageId, scope, { includeDeleted: true })) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
  if (!Number.isInteger(revision) || revision < 1) throw new ValidationError('revision 不合法');
  const row = db.prepare('SELECT * FROM knowledge_revision WHERE page_id=? AND revision=?').get(pageId, revision) as (Omit<KnowledgeRevision, 'sources' | 'evidence'> & { sources_json: string; evidence_json: string }) | undefined;
  if (row === undefined) throw new ApiError(404, 'KNOWLEDGE_REVISION_NOT_FOUND', `版本 ${revision} 不存在`);
  const { sources_json, evidence_json, ...revisionRow } = row;
  return { ...revisionRow, sources: JSON.parse(sources_json), evidence: JSON.parse(evidence_json) };
}

/** KB-GRAPH：一次查询取「活跃页 + 最新 revision 的 sources」，供图聚合使用（只读，不做 N+1） */
export interface KnowledgeGraphRow {
  id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  title: string;
  body_md: string;
  sources: KnowledgeSource[];
  /** KB-MODEL：星图着色用（旧行缺失 → legacy） */
  category?: string | null;
  landed?: string | null;
}

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
  const scopeSql = filter.scope === 'common'
    ? "p.scope='common'"
    : filter.scope === 'workspace'
      ? "(p.scope='workspace' AND p.workspace_id=@workspace)"
      : "(p.scope='common' OR (p.scope='workspace' AND p.workspace_id=@workspace))";
  // 统计与取行共用同一段 WHERE，避免「一条查全库、一条查本空间」的口径不一致
  const where = `p.status='active' AND ${scopeSql}`;
  const scopeParams: Record<string, string> = {};
  if (filter.scope !== 'common') {
    if (!filter.workspace_id) throw new ValidationError('该 scope 必须提供 workspace_id');
    scopeParams.workspace = filter.workspace_id;
  }
  const pageTotal = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_page p WHERE ${where}`).get(scopeParams) as { n: number }).n;
  const rows = db.prepare(
    `SELECT p.id,p.scope,p.workspace_id,p.title,p.body_md,r.sources_json,p.category,p.landed
     FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision
     WHERE ${where} ORDER BY p.id LIMIT @limit`,
  ).all({ ...scopeParams, limit: maxPages + 1 }) as Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; title: string; body_md: string; sources_json: string; category: string | null; landed: string | null }>;
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
      sources: JSON.parse(row.sources_json) as KnowledgeSource[],
    })),
  };
}
