/**
 * 设置 · 工作区自定义状态（STATUS-3-UI）。
 *
 * - 列表：状态名 + kind + 内置标记 + 该状态下的卡数（卡数取自 ['issues', workspaceId] 缓存，不额外请求）；
 * - 新增：`POST /api/workspaces/:id/statuses`（name + kind）；
 * - 删除：内置不可删（服务端 409 兜底）；自定义删除**必须选迁移目标**，请求
 *   `DELETE /api/workspaces/:id/statuses/:statusId?migrate_to=<name>`；
 * - 成功或失败后都 `invalidateStatuses`：STATUS-2 不推 WS 事件，看板列与卡数要靠 query 失效重拉。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, WorkspaceStatus, WorkspaceStatusKind } from '@agentboard/shared';
import { api } from '../../api/client';
import { useWorkspaceStatuses, invalidateStatuses, statusAccent } from '../../lib/workspaceStatuses';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';

const KIND_OPTIONS: Array<{ value: WorkspaceStatusKind; label: string }> = [
  { value: 'open', label: '开放' },
  { value: 'started', label: '进行中' },
  { value: 'review', label: '待验收' },
  { value: 'done', label: '关闭' },
  { value: 'deprecated', label: '已废弃' },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

export function WorkspaceStatusSettings({ workspaceId }: { workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const dictionary = useWorkspaceStatuses(workspaceId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WorkspaceStatusKind>('open');
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceStatus | null>(null);
  const [migrateTo, setMigrateTo] = useState('');

  // 卡数：复用看板的 issues 查询缓存（同一 key），不额外打接口
  const { data: issues } = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled: workspaceId !== null,
  });
  const countByStatus = new Map<string, number>();
  for (const issue of issues ?? []) {
    const key = issue.status as string;
    countByStatus.set(key, (countByStatus.get(key) ?? 0) + 1);
  }

  const refresh = async (): Promise<void> => {
    if (workspaceId !== null) await invalidateStatuses(queryClient, workspaceId);
  };

  const create = useMutation({
    mutationFn: (body: { name: string; kind: WorkspaceStatusKind }) =>
      api.post<WorkspaceStatus>(`/api/workspaces/${encodeURIComponent(workspaceId ?? '')}/statuses`, body),
    onSuccess: async (_, body) => {
      setNotice(`已新增状态「${body.name}」`);
      setName('');
      await refresh();
    },
    onError: (error) => setNotice(messageOf(error)),
  });

  const remove = useMutation({
    mutationFn: (input: { status: WorkspaceStatus; migrateTo: string }) =>
      api.del<{ migrated: number }>(
        `/api/workspaces/${encodeURIComponent(workspaceId ?? '')}/statuses/${encodeURIComponent(input.status.id)}?migrate_to=${encodeURIComponent(input.migrateTo)}`,
      ),
    onSuccess: async (result, input) => {
      setNotice(`已删除状态「${input.status.name}」，${result.migrated ?? 0} 张卡迁到「${input.migrateTo}」`);
      setDeleteTarget(null);
      setMigrateTo('');
      await refresh();
    },
    onError: (error) => setNotice(messageOf(error)),
  });

  if (workspaceId === null) {
    return <p className="text-xs text-neutral-500 dark:text-neutral-400">请先选择工作空间后再管理状态</p>;
  }

  return (
    <div data-testid="workspace-status-settings" className="space-y-2 text-sm">
      {notice !== null && (
        <p role="status" data-testid="status-settings-notice" className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
          {notice}
        </p>
      )}

      <ul className="space-y-1" aria-label="工作区状态列表">
        {dictionary.statuses.map((item) => (
          <li
            key={item.id}
            data-testid={`status-row-${item.name}`}
            className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 px-2 py-1 dark:border-neutral-700"
          >
            <span className={`font-medium ${statusAccent(item.kind)}`}>{item.name}</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {KIND_OPTIONS.find((option) => option.value === item.kind)?.label ?? item.kind}
              {item.is_builtin ? ' · 内置' : ' · 自定义'}
            </span>
            <span data-testid={`status-count-${item.name}`} className="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
              {countByStatus.get(item.name) ?? 0} 张卡
            </span>
            {!item.is_builtin && (
              <button
                type="button"
                data-testid={`status-delete-${item.name}`}
                aria-label={`删除状态 ${item.name}`}
                onClick={() => {
                  setDeleteTarget(item);
                  setMigrateTo('');
                  setNotice(null);
                }}
                className={BUTTON_DANGER}
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>

      {deleteTarget !== null && (
        <div data-testid="status-delete-confirm" className="space-y-1 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <p>
            删除「{deleteTarget.name}」会把该状态下的 {countByStatus.get(deleteTarget.name) ?? 0} 张卡迁移到目标状态，迁移目标必选：
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              data-testid="status-migrate-target"
              aria-label="迁移目标状态"
              value={migrateTo}
              onChange={(event) => setMigrateTo(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">选择迁移目标…</option>
              {dictionary.statuses
                .filter((item) => item.id !== deleteTarget.id)
                .map((item) => (
                  <option key={item.id} value={item.name}>{item.name}</option>
                ))}
            </select>
            <button
              type="button"
              data-testid="status-delete-confirm-yes"
              className={BUTTON_DANGER}
              disabled={migrateTo === '' || remove.isPending}
              onClick={() => remove.mutate({ status: deleteTarget, migrateTo })}
            >
              {remove.isPending ? '删除中…' : '确认删除并迁移'}
            </button>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setDeleteTarget(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed === '') return;
          create.mutate({ name: trimmed, kind });
        }}
      >
        <label className="text-xs">
          <span className="mb-0.5 block text-neutral-600 dark:text-neutral-300">新状态名称</span>
          <input
            data-testid="status-create-name"
            aria-label="新状态名称"
            value={name}
            maxLength={20}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：等外部确认"
            className={`${FIELD_CLASS} w-36`}
          />
        </label>
        <label className="text-xs">
          <span className="mb-0.5 block text-neutral-600 dark:text-neutral-300">类型</span>
          <select
            data-testid="status-create-kind"
            aria-label="新状态类型"
            value={kind}
            onChange={(event) => setKind(event.target.value as WorkspaceStatusKind)}
            className={FIELD_CLASS}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" data-testid="status-create-submit" className={BUTTON_PRIMARY} disabled={create.isPending || name.trim() === ''}>
          {create.isPending ? '新增中…' : '新增状态'}
        </button>
      </form>
    </div>
  );
}
