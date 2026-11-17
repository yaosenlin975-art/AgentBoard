/**
 * `task_id` 前缀解析（P4-C5）。
 *
 * 判定与骨架在 `idRef.ts`（S6 抽出，与 `decisionRef.ts` 共用同一份实现，不复制）。
 * 本文件只负责 task 族的差异：候选从 `/issues` 拉、404 码是 `TASK_NOT_FOUND`、
 * 候选描述带状态与标题。
 */
import type { Issue, PageResult } from '@agentboard/shared';
import type { AgentBoardApiClient } from '../apiClient.js';
import { resolveIdByRef } from './idRef.js';

export { MIN_ID_PREFIX as MIN_TASK_PREFIX } from './idRef.js';

/** 只为前缀匹配而拉的最小字段集 */
const PREFIX_FIELDS = 'id,title,status,workspace_id';
const PAGE_LIMIT = 100;

type IssueRefRow = Pick<Issue, 'id' | 'title' | 'status' | 'workspace_id'>;

async function listAllIssueIds(api: AgentBoardApiClient, workspaceId: string): Promise<IssueRefRow[]> {
  const out: IssueRefRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await api.get<PageResult<Issue>>('/issues', {
      workspace: workspaceId,
      fields: PREFIX_FIELDS,
      limit: PAGE_LIMIT,
      offset,
    });
    for (const item of page.items) out.push({ id: item.id, title: item.title, status: item.status, workspace_id: item.workspace_id });
    if (page.next_offset === null || page.items.length === 0) break;
    offset = page.next_offset;
  }
  return out;
}

/** `ref` → 真实任务 id（完整 UUID / 非十六进制引用零成本透传） */
export async function resolveTaskId(
  api: AgentBoardApiClient,
  workspaceId: string,
  ref: string,
): Promise<string> {
  return resolveIdByRef<IssueRefRow>(ref, {
    fieldName: 'task_id',
    notFoundCode: 'TASK_NOT_FOUND',
    listAll: () => listAllIssueIds(api, workspaceId),
    idOf: item => item.id,
    describe: item => `${item.id} · ${item.status} · ${item.title}`,
  });
}
