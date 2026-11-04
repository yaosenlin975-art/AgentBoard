/**
 * 知识页按 id 读取（MD-LINKS 公共实现）。
 *
 * 服务端 `GET /api/knowledge/pages/:id` 的 `scope` 只接受 `workspace` / `common`（不是 `both`）：
 * - 先按 `scope=workspace&workspace_id=<当前>` 取（当前工作区的页）；
 * - 失败再按 `scope=common` 取（公共知识）；
 * - 都失败抛最后一次错误（调用方把 404 显示成「无权限或不存在」）。
 *
 * markdown 软链接（MarkdownSmartLink）与右侧浮窗（RefPanel）共用，避免两处各写一套 scope 组合。
 */
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../api/client';

/** KB-PAGE-2 的 resolve 响应（服务端统一解析 id / 前缀 / slug，并保证 403 不回显标题） */
export interface ResolvedKnowledgeRef {
  id: string;
  title: string;
  scope: 'common' | 'workspace';
  workspace_id: string | null;
  status: 'active' | 'archived';
  revision: number;
  link: { ref: string; markdown: string };
}

/**
 * 统一引用解析：一次请求拿到 id/title/status，避免「先按 workspace、再按 common」两次往返与客户端 slug 兜底。
 * 错误语义由服务端固化：404 not_found / 409 ambiguous / 410 deleted / 403 跨区（不含标题）。
 */
export async function resolveKnowledgeRef(ref: string, workspaceId: string | null): Promise<ResolvedKnowledgeRef> {
  const params = new URLSearchParams({ ref, scope: workspaceId === null ? 'common' : 'both' });
  if (workspaceId !== null) params.set('workspace_id', workspaceId);
  return api.get<ResolvedKnowledgeRef>(`/api/knowledge/resolve?${params.toString()}`);
}

export async function fetchKnowledgePage(id: string, workspaceId: string | null): Promise<KnowledgePage> {
  const attempts: string[] = [];
  if (workspaceId !== null) {
    attempts.push(`scope=workspace&workspace_id=${encodeURIComponent(workspaceId)}`);
  }
  attempts.push('scope=common');

  let lastError: unknown = new Error('读取知识页失败');
  for (const query of attempts) {
    try {
      return await api.get<KnowledgePage>(`/api/knowledge/pages/${encodeURIComponent(id)}?${query}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 是否是 common 或当前工作区的知识页（MD-LINKS 权限口径） */
export function isKnowledgeAllowed(page: KnowledgePage, workspaceId: string | null): boolean {
  return page.scope === 'common' || (workspaceId !== null && page.workspace_id === workspaceId);
}
