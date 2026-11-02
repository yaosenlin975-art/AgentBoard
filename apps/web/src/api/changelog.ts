/**
 * 工作区变更日志客户端（LOG03）：只做 REST 薄封装，数据形状直接复用 LOG01 在 `@agentboard/shared` 交付的 DTO。
 * 活动日志：/api/workspaces/:id/changelog（CRUD + CAS）；归档只读：/api/changelog/archived-workspaces…
 * `actor` 固定 'user'（设计 §4：Web 不承担身份认证）。
 */
import type {
  ArchivedWorkspaceChangeLogSummary,
  PageResult,
  WorkspaceChangeLog,
  WorkspaceChangeType,
} from '@agentboard/shared';
import { api } from './client';

export type { ArchivedWorkspaceChangeLogSummary, WorkspaceChangeLog, WorkspaceChangeType };

/** `历史` 只由旧 CHANGELOG 导入写入，Web 端不可选 */
export type EditableChangeType = Exclude<WorkspaceChangeType, '历史'>;

export interface ChangelogQuery {
  limit?: number;
  offset?: number;
  change_type?: WorkspaceChangeType;
  q?: string;
}

export interface ChangelogCreateBody {
  title: string;
  body_md: string;
  change_type: EditableChangeType;
  occurred_at?: number;
}

export interface ChangelogPatchBody {
  title?: string;
  body_md?: string;
  change_type?: EditableChangeType;
  occurred_at?: number;
  expected_revision: number;
}

function queryString(params: Record<string, string | number | undefined>): string {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

const entriesPath = (workspaceId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/changelog`;

export const changelogApi = {
  list(workspaceId: string, query: ChangelogQuery = {}): Promise<PageResult<WorkspaceChangeLog>> {
    return api.get<PageResult<WorkspaceChangeLog>>(`${entriesPath(workspaceId)}?${queryString({ ...query })}`);
  },

  get(workspaceId: string, id: string): Promise<WorkspaceChangeLog> {
    return api.get<WorkspaceChangeLog>(`${entriesPath(workspaceId)}/${encodeURIComponent(id)}`);
  },

  create(workspaceId: string, body: ChangelogCreateBody): Promise<WorkspaceChangeLog> {
    return api.post<WorkspaceChangeLog>(entriesPath(workspaceId), { ...body, actor: 'user' });
  },

  update(workspaceId: string, id: string, body: ChangelogPatchBody): Promise<WorkspaceChangeLog> {
    return api.patch<WorkspaceChangeLog>(`${entriesPath(workspaceId)}/${encodeURIComponent(id)}`, {
      ...body,
      actor: 'user',
    });
  },

  remove(workspaceId: string, id: string, expectedRevision: number): Promise<void> {
    return api.delWithBody<void>(`${entriesPath(workspaceId)}/${encodeURIComponent(id)}`, {
      expected_revision: expectedRevision,
      actor: 'user',
    });
  },

  archivedWorkspaces(query: { limit?: number; offset?: number } = {}): Promise<PageResult<ArchivedWorkspaceChangeLogSummary>> {
    return api.get<PageResult<ArchivedWorkspaceChangeLogSummary>>(
      `/api/changelog/archived-workspaces?${queryString({ ...query })}`,
    );
  },

  archivedEntries(
    originWorkspaceId: string,
    query: ChangelogQuery = {},
  ): Promise<PageResult<WorkspaceChangeLog>> {
    return api.get<PageResult<WorkspaceChangeLog>>(
      `/api/changelog/archived-workspaces/${encodeURIComponent(originWorkspaceId)}/entries?${queryString({ ...query })}`,
    );
  },

  archivedEntry(originWorkspaceId: string, id: string): Promise<WorkspaceChangeLog> {
    return api.get<WorkspaceChangeLog>(
      `/api/changelog/archived-workspaces/${encodeURIComponent(originWorkspaceId)}/entries/${encodeURIComponent(id)}`,
    );
  },
};
