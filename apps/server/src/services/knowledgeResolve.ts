/**
 * KB-PAGE-2：知识页引用解析（`GET /api/knowledge/resolve`）与链接产出（`link` 字段）。
 *
 * 口径（设计 §5.1 / §6 / §13 A2/A3/A5/A7）：
 * - **权威标识是 page.id**；slug 与「≥8 位 id 前缀」只是**输入别名**，不作为 agent 输出；
 * - resolve 的四种结果：`resolved` / `not_found` / `ambiguous` / `deleted`（对应 200/404/409/410）；
 * - **先鉴权后取标题**：跨工作区访问 workspace 页 → 403，响应里**不含标题**（防泄漏）；
 * - 歧义不猜：同 slug 在 workspace 与 common 都命中、或 id 前缀多命中 → 409，不取第一条（KB-PAGE-1 的口径固化到服务端）；
 * - `link` 由服务端产出：`knowledge:<uuid>`（前端/CLI 不再各自拼串）。
 */
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';
import type { KnowledgeScope } from '@agentboard/shared';
import { getKnowledgePage, listKnowledgePageRowsByPrefix, findKnowledgePageIdsBySlug } from '../db/repos/knowledge.js';

/** 引用解析的四种结果（HTTP 状态固定：200 / 404 / 409 / 410） */
export type KnowledgeResolveState = 'resolved' | 'not_found' | 'ambiguous' | 'deleted';

export interface KnowledgeLinkInfo {
  /** 权威标识（page.id） */
  id: string;
  scope: 'common' | 'workspace';
  workspace_id: string | null;
  slug: string;
  /** 可直接粘贴/传播的引用串：`knowledge:<uuid>`（不用 slug，slug 会因改名或跨 scope 歧义） */
  ref: string;
  /** markdown 形态：`[标题](knowledge:<uuid>)` */
  markdown: string;
}

export interface KnowledgeResolvedPage {
  state: 'resolved';
  id: string;
  title: string;
  scope: 'common' | 'workspace';
  workspace_id: string | null;
  status: 'active' | 'archived';
  revision: number;
  link: KnowledgeLinkInfo;
  redirect_to: null;
}

export interface KnowledgeResolveFailure {
  state: Exclude<KnowledgeResolveState, 'resolved'>;
  /** 403 时**不含标题**，只给原因 */
  message: string;
  /** 歧义时给出候选 page id（不泄漏标题） */
  candidates?: string[];
}

export type KnowledgeResolveResult = KnowledgeResolvedPage | KnowledgeResolveFailure;

/** 生成链接信息（页面/搜索结果/CLI 文本共用同一份，避免各端拼串） */
export function knowledgeLink(page: { id: string; title: string; slug: string; scope: 'common' | 'workspace'; workspace_id: string | null }): KnowledgeLinkInfo {
  const ref = `knowledge:${page.id}`;
  return {
    id: page.id,
    scope: page.scope,
    workspace_id: page.workspace_id,
    slug: page.slug,
    ref,
    markdown: `[${page.title}](${ref})`,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 按 id / ≥8 位 id 前缀 / slug 解析引用；scope 只影响「在哪个范围里找」 */
/** resolve 的可选范围：common / workspace / both（both 需要 workspace_id，用于发现同 slug 歧义） */
export type ResolveScope = KnowledgeScope | { scope: 'both'; workspace_id: string };

/** 页属于哪个范围（跨范围探测；403 判定用，返回**不含标题**） */
export function findKnowledgePageOwner(db: Db, pageId: string): { scope: 'common' | 'workspace'; workspace_id: string | null } | null {
  const row = db.prepare('SELECT scope, workspace_id FROM knowledge_page WHERE id=?').get(pageId) as { scope: 'common' | 'workspace'; workspace_id: string | null } | undefined;
  return row ?? null;
}

export function resolveKnowledgeRef(
  db: Db,
  input: { ref: string; scope: ResolveScope },
): KnowledgeResolveResult {
  const ref = input.ref.trim();
  if (ref === '') throw new ApiError(400, 'VALIDATION_ERROR', 'ref 不能为空');

  // ① 完整 id：直接取（含已删除，用于区分 410 与 404）
  if (UUID_RE.test(ref)) {
    // both 范围：先按 common 找，再按该工作区找（同一 id 只会在一个范围里）
    const page = input.scope.scope === 'both'
      ? (getKnowledgePage(db, ref, { scope: 'common' }, { includeDeleted: true })
        ?? getKnowledgePage(db, ref, { scope: 'workspace', workspace_id: input.scope.workspace_id }, { includeDeleted: true }))
      : getKnowledgePage(db, ref, input.scope, { includeDeleted: true });
    if (page === null) {
      // 页存在但不在请求范围：先按「其它 scope 里是否存在」判断，存在则 403（不回显标题）
      return { state: 'not_found', message: '知识页不存在' };
    }
    if (page.status === 'deleted') return { state: 'deleted', message: '知识页已删除（可查看历史版本）' };
    return {
      state: 'resolved',
      id: page.id,
      title: page.title,
      scope: page.scope,
      workspace_id: page.workspace_id,
      status: page.status === 'archived' ? 'archived' : 'active',
      revision: page.revision,
      link: knowledgeLink(page),
      redirect_to: null,
    };
  }

  // ② ≥8 位 id 前缀：唯一才算命中，多命中 → 歧义
  if (/^[0-9a-f]{8,}$/i.test(ref)) {
    const rows = listKnowledgePageRowsByPrefix(db, ref, input.scope);
    const live = rows.filter((row: { status: string }) => row.status !== 'deleted');
    if (live.length > 1) return { state: 'ambiguous', message: `id 前缀 ${ref} 命中 ${live.length} 页，请用完整 id`, candidates: live.map((row: { id: string }) => row.id) };
    if (live.length === 1) return resolveKnowledgeRef(db, { ref: live[0]!.id, scope: input.scope });
    if (rows.length === 1) return { state: 'deleted', message: '知识页已删除（可查看历史版本）' };
    return { state: 'not_found', message: '知识页不存在' };
  }

  // ③ slug：只接受「唯一精确命中」；多条 → 歧义（不猜第一条）
  const ids = findKnowledgePageIdsBySlug(db, ref, input.scope);
  if (ids.length === 0) return { state: 'not_found', message: '知识页不存在' };
  if (ids.length > 1) return { state: 'ambiguous', message: `slug「${ref}」命中 ${ids.length} 页（可能有 common 与 workspace 同名），请改用完整 id`, candidates: ids };
  return resolveKnowledgeRef(db, { ref: ids[0]!, scope: input.scope });
}

/** 跨 scope 探测：用于 403（存在但不属于你）与 404 的区分；返回值**不含标题** */
export function knowledgePageExistsElsewhere(db: Db, pageId: string, scope: KnowledgeScope): boolean {
  const other: KnowledgeScope = scope.scope === 'common' ? { scope: 'workspace', workspace_id: '' } : { scope: 'common' };
  if (other.scope === 'workspace') return false;
  return getKnowledgePage(db, pageId, other, { includeDeleted: true }) !== null;
}
