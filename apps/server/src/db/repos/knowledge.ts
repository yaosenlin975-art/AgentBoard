import { randomUUID } from 'node:crypto';
import type { KnowledgeEvidence, KnowledgePage, KnowledgeRevision, KnowledgeScope, KnowledgeSource } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ValidationError } from '../../errors.js';
import { validateKnowledgeContent, validateKnowledgeScope } from '../../services/knowledge.js';

export type CreateKnowledgePageInput = KnowledgeScope & {
  slug: string; title: string; body_md: string; sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  actor: string; expires_at?: number | null; change_note?: string;
};
export type KnowledgePagePatch = Partial<Pick<KnowledgePage, 'title' | 'body_md' | 'sources' | 'evidence' | 'expires_at'>> & { actor: string; change_note?: string };
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
export function getKnowledgePage(db: Db, pageId: string, scope: KnowledgeScope): KnowledgePage | null {
  validateKnowledgeScope(scope);
  const row = db.prepare(`${selectPage} WHERE p.id=? AND p.scope=? AND p.workspace_id IS ?`).get(pageId, scope.scope, scope.workspace_id ?? null) as PageRow | undefined;
  return row ? parsePage(row) : null;
}
export function createKnowledgePage(db: Db, input: CreateKnowledgePageInput): KnowledgePage {
  validateKnowledgeScope(input);
  validateKnowledgeContent({ ...input, expires_at: input.expires_at ?? null });
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(input.slug) || input.slug.split('/').includes('..')) throw new ValidationError('slug 格式不合法');
  if (input.scope === 'workspace' && !db.prepare('SELECT 1 FROM workspace WHERE id=?').get(input.workspace_id)) throw new ValidationError('工作空间不存在');
  const now = Date.now();
  const page: KnowledgePage = { id: randomUUID(), scope: input.scope, workspace_id: input.workspace_id ?? null, slug: input.slug, title: input.title, body_md: input.body_md, sources: input.sources, evidence: input.evidence, status: 'active', revision: 1, expires_at: input.expires_at ?? null, created_by: input.actor, updated_by: input.actor, created_at: now, updated_at: now };
  try {
    return db.transaction(() => {
      db.prepare(`INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(page.id, page.scope, page.workspace_id, page.slug, page.title, page.body_md, page.status, page.revision, page.expires_at, page.created_by, page.updated_by, now, now);
      appendRevision(db, page, 'create', input.change_note ?? '');
      return page;
    })();
  } catch (error) { return duplicate(error); }
}
function changePage(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, patch: KnowledgePagePatch, kind: KnowledgeRevision['change_kind']): KnowledgePage {
  validateKnowledgeScope(scope);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ValidationError('expected_revision 必须为正整数');
  try {
    return db.transaction(() => {
      const old = getKnowledgePage(db, pageId, scope);
      if (!old) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
      if (old.revision !== expectedRevision) throw new ApiError(409, 'KNOWLEDGE_REVISION_CONFLICT', '知识页已更新，请重新读取', { current_revision: old.revision });
      if (old.status === 'deleted' || (kind === 'restore' && old.status !== 'archived') || (kind === 'archive' && old.status !== 'active')) throw new ApiError(409, 'KNOWLEDGE_STATE_CONFLICT', '当前状态不允许此操作');
      const page: KnowledgePage = { ...old, title: patch.title ?? old.title, body_md: patch.body_md ?? old.body_md, sources: patch.sources ?? old.sources, evidence: patch.evidence ?? old.evidence, expires_at: patch.expires_at === undefined ? old.expires_at : patch.expires_at, updated_by: patch.actor, updated_at: Math.max(Date.now(), old.updated_at + 1), revision: old.revision + 1, status: kind === 'archive' ? 'archived' : kind === 'restore' ? 'active' : kind === 'delete' ? 'deleted' : old.status };
      validateKnowledgeContent({ ...page, actor: patch.actor });
      const result = db.prepare(`UPDATE knowledge_page SET title=?,body_md=?,status=?,revision=?,expires_at=?,updated_by=?,updated_at=? WHERE id=? AND scope=? AND workspace_id IS ? AND revision=?`)
        .run(page.title, page.body_md, page.status, page.revision, page.expires_at, page.updated_by, page.updated_at, pageId, scope.scope, scope.workspace_id ?? null, expectedRevision);
      if (result.changes !== 1) {
        const current = db.prepare('SELECT revision FROM knowledge_page WHERE id=? AND scope=? AND workspace_id IS ?').get(pageId, scope.scope, scope.workspace_id ?? null) as { revision: number } | undefined;
        throw new ApiError(409, 'KNOWLEDGE_REVISION_CONFLICT', '知识页已更新，请重新读取', current ? { current_revision: current.revision } : undefined);
      }
      appendRevision(db, page, kind, patch.change_note ?? '');
      return page;
    }).immediate();
  } catch (error) { return duplicate(error); }
}
export function reviseKnowledgePage(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, patch: KnowledgePagePatch): KnowledgePage {
  if (!['title', 'body_md', 'sources', 'evidence', 'expires_at'].some(k => Object.hasOwn(patch, k))) throw new ValidationError('修订必须包含改动字段');
  return changePage(db, pageId, scope, expectedRevision, patch, 'update');
}
export function setKnowledgePageStatus(db: Db, pageId: string, scope: KnowledgeScope, expectedRevision: number, action: 'archive' | 'restore' | 'delete', actor: string): KnowledgePage {
  if (!['archive', 'restore', 'delete'].includes(action)) throw new ValidationError('未知状态操作');
  return changePage(db, pageId, scope, expectedRevision, { actor }, action);
}
export function listKnowledgeRevisions(db: Db, pageId: string, scope: KnowledgeScope, limit = 20, offset = 0): KnowledgeRevision[] {
  if (!getKnowledgePage(db, pageId, scope)) throw new ApiError(404, 'KNOWLEDGE_NOT_FOUND', '知识页不存在');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new ValidationError('历史分页参数不合法');
  return (db.prepare('SELECT * FROM knowledge_revision WHERE page_id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(pageId, limit, offset) as Array<Omit<KnowledgeRevision, 'sources' | 'evidence'> & { sources_json: string; evidence_json: string }>).map(row => {
    const { sources_json, evidence_json, ...revision } = row;
    return { ...revision, sources: JSON.parse(sources_json), evidence: JSON.parse(evidence_json) };
  });
}

/** KB-GRAPH：一次查询取「活跃页 + 最新 revision 的 sources」，供图聚合使用（只读，不做 N+1） */
export interface KnowledgeGraphRow {
  id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  title: string;
  body_md: string;
  sources: KnowledgeSource[];
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
    `SELECT p.id,p.scope,p.workspace_id,p.title,p.body_md,r.sources_json
     FROM knowledge_page p JOIN knowledge_revision r ON r.page_id=p.id AND r.revision=p.revision
     WHERE ${where} ORDER BY p.id LIMIT @limit`,
  ).all({ ...scopeParams, limit: maxPages + 1 }) as Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; title: string; body_md: string; sources_json: string }>;
  const pagesTruncated = rows.length > maxPages;
  return {
    pagesTruncated,
    pageTotal,
    rows: rows.slice(0, maxPages).map(row => ({
      id: row.id,
      scope: row.scope,
      workspace_id: row.workspace_id,
      title: row.title,
      body_md: row.body_md,
      sources: JSON.parse(row.sources_json) as KnowledgeSource[],
    })),
  };
}
