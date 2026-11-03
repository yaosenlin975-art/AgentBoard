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
