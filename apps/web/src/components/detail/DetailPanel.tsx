/**
 * 任务详情视图（§7.4）：
 * - 字段区：标题 / 描述（markdown 预览与编辑切换）/ 优先级 / 标签（逗号分隔），
 *   onChange 防抖 500ms 合并 PATCH（占用中也可编辑，agent 经 kb show 拉取最新）；
 * - 操作区按状态条件化：派发（状态∈{待规划,进行中}且未占用）/ 会话进行中（禁用）+
 *   强制释放 + 标记待验收（占用中）/ 删除（非占用中，二次确认 → DELETE → 关面板）；
 * - 关联会话列表（点击切聊天）与评论区。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '../../lib/markdown';
import type { Issue, IssueStatus, Priority, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  ISSUE_STATUSES,
  invalidateIssueStatusCaches,
  manualStatusBlockedReason,
  patchIssueStatus,
} from '../../lib/issueStatus';
import { getIssueDescendantIds } from '../../lib/issueTree';
import { openBlockerCount, type DependencyView } from '../../lib/dependency';
import { usePanelStore } from '../../state/panelStore';
import { CommentThread } from './CommentThread';
import { DependencySection } from './DependencySection';
import { DispatchDialog } from './DispatchDialog';
import { isOverdue, overdueDays } from '../../lib/planningSort';
import { SessionList } from './SessionList';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

const DEBOUNCE_MS = 500;

export function DetailPanel() {
  const issueId = usePanelStore((s) => s.issueId);
  const openChat = usePanelStore((s) => s.openChat);
  const closeRight = usePanelStore((s) => s.closeRight);
  const queryClient = useQueryClient();

  const { data: issue, error: issueError } = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => api.get<Issue>(`/api/issues/${issueId}`),
    enabled: issueId !== null,
  });
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
    enabled: issue !== undefined,
  });
  const { data: workspaceIssues } = useQuery({
    queryKey: ['issues', issue?.workspace_id],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(issue!.workspace_id)}`),
    enabled: issue !== undefined,
  });
  const { data: allSessions } = useQuery({
    queryKey: ['sessions', issue?.workspace_id],
    queryFn: () =>
      api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(issue!.workspace_id)}`),
    enabled: issue !== undefined,
  });
  // 依赖清单：与详情「依赖」区共用同一 queryKey（同一份缓存），claim/派发前用来列 blocker
  const { data: dependencies } = useQuery({
    queryKey: ['dependencies', issueId],
    queryFn: () =>
      api.get<DependencyView>(
        `/api/issues/${issueId}/dependencies?workspace_id=${encodeURIComponent(issue!.workspace_id)}`,
      ),
    enabled: issueId !== null && issue !== undefined,
  });

  // ---- 字段本地态 + 防抖 PATCH ----
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('中');
  const [labelsInput, setLabelsInput] = useState('');
  /** DUE-DATE：日期与时间分别可空，各自走防抖 PATCH */
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [descEditing, setDescEditing] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [claimBlocked, setClaimBlocked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!issue) return;
    setTitle(issue.title);
    setDescription(issue.description);
    setPriority(issue.priority);
    setLabelsInput(issue.labels.join(','));
    setDueDate(issue.due_date ?? '');
    setDueTime(issue.due_time ?? '');
    setDescEditing(false);
    setConfirmingDelete(false);
    setClaimBlocked(false);
    // 仅在切换 issue 时重置本地编辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id]);

  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePatch = useCallback(
    (field: string, value: unknown) => {
      if (issueId === null) return;
      pendingRef.current[field] = value;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const body = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(body).length === 0) return;
        api
          .patch<Issue>(`/api/issues/${issueId}`, body)
          .then((updated) => {
            queryClient.setQueryData(['issue', issueId], updated);
            void queryClient.invalidateQueries({ queryKey: ['issues'] });
          })
          .catch((e: unknown) => setActionError(e instanceof Error ? e.message : '保存失败'));
      }, DEBOUNCE_MS);
    },
    [issueId, queryClient],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const refreshIssue = (updated: Issue): void => {
    queryClient.setQueryData(['issue', updated.id], updated);
    void queryClient.invalidateQueries({ queryKey: ['issues'] });
  };

  const release = useMutation({
    mutationFn: () => api.post<Issue>(`/api/issues/${issueId}/release`),
    onSuccess: refreshIssue,
    onError: (e) => setActionError(e instanceof Error ? e.message : '释放失败'),
  });

  const markDone = useMutation({
    mutationFn: () => api.post<Issue>(`/api/issues/${issueId}/done`, { agent_id: 'user' }),
    onSuccess: refreshIssue,
    onError: (e) => setActionError(e instanceof Error ? e.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: () => api.del<void>(`/api/issues/${issueId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      closeRight();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '删除失败'),
  });

  // 手动改状态：与树节点下拉、看板拖动同一契约（workspace_id + expected_updated_at CAS）。
  // 不做乐观更新：失败时下拉值仍是服务端现值（issue.status），只显示原因。
  const changeStatus = useMutation({
    mutationFn: (nextStatus: IssueStatus) =>
      patchIssueStatus({
        issueId: issueId as string,
        workspaceId: issue!.workspace_id,
        expectedUpdatedAt: issue!.updated_at,
        status: nextStatus,
      }),
    onSuccess: (updated) => {
      setActionError(null);
      queryClient.setQueryData(['issue', updated.id], updated);
      invalidateIssueStatusCaches(queryClient, { workspaceId: updated.workspace_id });
    },
    onError: (e) => {
      setActionError(e instanceof Error ? e.message : '修改状态失败');
      // 冲突后回到服务端当前状态
      void queryClient.invalidateQueries({ queryKey: ['issue', issueId] });
    },
  });

  if (issueId === null) return null;
  if (issueError !== null) {
    return (
      <div className="p-4 text-sm text-red-600 dark:text-red-400" data-testid="detail-error">
        {issueError instanceof Error ? issueError.message : '加载失败'}
      </div>
    );
  }
  if (issue === undefined) {
    return (
      <div className="p-4 text-sm text-neutral-400 dark:text-neutral-500" data-testid="detail-loading">
        加载中…
      </div>
    );
  }

  const claimed = issue.claimed_by !== null;
  const statusBlocked = manualStatusBlockedReason(issue);
  // 「已关闭」与树节点下拉同规则：后代全部关闭前不可选
  const descendantIds = getIssueDescendantIds(workspaceIssues ?? [], issue.id);
  const closeBlocked = issue.status !== '已关闭'
    && [...descendantIds].some((id) => (workspaceIssues ?? []).find((candidate) => candidate.id === id)?.status !== '已关闭');
  const directChildCount = workspaceIssues?.filter((candidate) => candidate.parent_issue_id === issue.id).length ?? 0;
  const dispatchable = !claimed && (issue.status === '待规划' || issue.status === '进行中');
  const issueSessions = (allSessions ?? []).filter((s) => s.issue_id === issue.id);
  const workspacePath = (workspaces ?? []).find((w) => w.id === issue.workspace_id)?.path ?? '';

  const onLabelsChange = (value: string): void => {
    setLabelsInput(value);
    const labels = value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    schedulePatch('labels', labels);
  };

  return (
    <div data-testid="detail-panel" className="flex h-full min-h-0 flex-col">
      {/* 滚动区：右侧留 16px（> 15px 经典滚动条宽度），避免滚动条压住标题与首个字段 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3 pl-3 pr-4">
        {/* 字段区 */}
        <section aria-label="字段" className="space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标题</span>
            <input
              data-testid="title-input"
              aria-label="标题"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                schedulePatch('title', e.target.value);
              }}
              className={inputCls}
            />
          </label>

          <div className="text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-neutral-600 dark:text-neutral-300">描述</span>
              <button
                type="button"
                data-testid="desc-toggle"
                onClick={() => setDescEditing((v) => !v)}
                className="rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
              >
                {descEditing ? '预览' : '编辑'}
              </button>
            </div>
            {descEditing ? (
              <textarea
                data-testid="desc-input"
                aria-label="描述（markdown）"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  schedulePatch('description', e.target.value);
                }}
                rows={6}
                className={inputCls}
              />
            ) : (
              <div data-testid="desc-preview">
                <MarkdownView className="rounded border border-neutral-200 px-2.5 py-2 dark:border-neutral-800">{description.trim() === '' ? '（无描述）' : description}</MarkdownView>
              </div>
            )}
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">优先级</span>
            <select
              data-testid="priority-select"
              aria-label="优先级"
              value={priority}
              onChange={(e) => {
                const v = e.target.value as Priority;
                setPriority(v);
                schedulePatch('priority', v);
              }}
              className={inputCls}
            >
              <option value="低">低</option>
              <option value="中">中</option>
              <option value="高">高</option>
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">状态</span>
            <select
              data-testid="status-select"
              aria-label="状态"
              value={issue.status}
              disabled={statusBlocked !== null || changeStatus.isPending}
              title={statusBlocked ?? undefined}
              onChange={(e) => {
                // 双保险：disabled 之外再拦一层，任何路径都不发手动状态更新
                if (statusBlocked !== null) return;
                changeStatus.mutate(e.target.value as IssueStatus);
              }}
              className={inputCls}
            >
              {ISSUE_STATUSES.map((value) => (
                <option key={value} value={value} disabled={value === '已关闭' && closeBlocked}>
                  {value}
                </option>
              ))}
            </select>
            {statusBlocked !== null && (
              <span data-testid="status-blocked-hint" className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
                {statusBlocked}
              </span>
            )}
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">
              截止日期（可选；不填 = 不设截止）
              {dueDate !== '' && isOverdue({ due_date: dueDate, due_time: dueTime === '' ? null : dueTime }, Date.now()) && (
                <span data-testid="detail-due-overdue" className="ml-2 rounded bg-red-100 px-1 text-xs font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300">
                  已逾期 {overdueDays({ due_date: dueDate, due_time: dueTime === '' ? null : dueTime }, Date.now())} 天
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <input
                type="date"
                data-testid="detail-due-date"
                aria-label="截止日期"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  schedulePatch('due_date', e.target.value === '' ? null : e.target.value);
                  if (e.target.value === '') {
                    setDueTime('');
                    schedulePatch('due_time', null);
                  }
                }}
                className={inputCls}
              />
              <input
                type="time"
                data-testid="detail-due-time"
                aria-label="截止时间"
                value={dueTime}
                disabled={dueDate === ''}
                onChange={(e) => {
                  setDueTime(e.target.value);
                  schedulePatch('due_time', e.target.value === '' ? null : e.target.value);
                }}
                className={inputCls}
              />
              <button
                type="button"
                data-testid="detail-due-clear"
                disabled={dueDate === '' && dueTime === ''}
                onClick={() => {
                  setDueDate('');
                  setDueTime('');
                  schedulePatch('due_date', null);
                  schedulePatch('due_time', null);
                }}
                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300"
              >
                清除
              </button>
            </span>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标签（逗号分隔）</span>
            <input
              data-testid="labels-input"
              aria-label="标签（逗号分隔）"
              value={labelsInput}
              onChange={(e) => onLabelsChange(e.target.value)}
              placeholder="前端, 性能"
              className={inputCls}
            />
          </label>
        </section>

        {/* 操作区（状态条件化） */}
        <section data-testid="detail-actions" aria-label="操作" className="space-y-2">
          <h3 className="text-sm font-semibold">操作</h3>
          <div className="flex flex-wrap items-center gap-2">
            {dispatchable && (
              <button
                type="button"
                data-testid="dispatch-btn"
                onClick={() => {
                  // claim 入口前端先拦：有未解除前置时列出 blocker 清单，不开派发弹窗（服务端 409 仍是唯一防线）
                  if (openBlockerCount(issue) > 0) {
                    setClaimBlocked(true);
                    return;
                  }
                  setDispatchOpen(true);
                }}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                派发
              </button>
            )}
            {claimed && (
              <>
                <button
                  type="button"
                  data-testid="session-active-btn"
                  disabled
                  title={`占用者：${issue.claimed_by}`}
                  className="rounded bg-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-500 disabled:cursor-not-allowed dark:bg-neutral-800 dark:text-neutral-400"
                >
                  会话进行中
                </button>
                <button
                  type="button"
                  data-testid="release-btn"
                  onClick={() => release.mutate()}
                  disabled={release.isPending}
                  className="rounded border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40 dark:border-amber-600 dark:text-amber-400 dark:hover:bg-amber-950/40"
                >
                  强制释放
                </button>
                <button
                  type="button"
                  data-testid="done-btn"
                  onClick={() => markDone.mutate()}
                  disabled={markDone.isPending}
                  className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-40"
                >
                  标记待验收
                </button>
              </>
            )}
            {!claimed &&
              (confirmingDelete ? (
                <>
                  <span data-testid="delete-confirm-text" className="text-xs text-red-600 dark:text-red-400">
                    {directChildCount > 0
                      ? `该任务有 ${directChildCount} 个直接子任务；先移动或删除子任务后才能删除此任务`
                      : '确认删除？关联会话与消息将一并删除'}
                  </span>
                  <button
                    type="button"
                    data-testid="delete-confirm"
                    onClick={() => remove.mutate()}
                    disabled={remove.isPending || directChildCount > 0}
                    className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    data-testid="delete-cancel"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="delete-btn"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  删除
                </button>
              ))}
          </div>
          {actionError !== null && (
            <p role="alert" data-testid="detail-action-error" className="text-xs text-red-600 dark:text-red-400">
              {actionError}
            </p>
          )}
          {claimBlocked && (
            <div
              data-testid="claim-blocked-panel"
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <p className="font-medium">存在 {openBlockerCount(issue)} 项未解除的前置任务，已拦住本次领取（派发）：</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {(dependencies?.blockers ?? [])
                  .filter((blocker) => !blocker.resolved)
                  .map((blocker) => (
                    <li key={blocker.issue_id} data-testid={`claim-blocked-${blocker.issue_id}`}>
                      {blocker.title}（{blocker.status}）
                    </li>
                  ))}
              </ul>
              {dependencies === undefined && (
                <p data-testid="claim-blocked-loading" className="mt-1">正在加载前置清单…</p>
              )}
              <button
                type="button"
                data-testid="claim-blocked-dismiss"
                onClick={() => setClaimBlocked(false)}
                className="mt-2 rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900/40"
              >
                知道了
              </button>
            </div>
          )}
        </section>

        {/* 依赖 */}
        <DependencySection issue={issue} />

        {/* 关联会话 */}
        <SessionList sessions={issueSessions} currentSessionId={issue.session_id} onSelect={(s) => openChat(s.id, s)} />

        {/* 评论 */}
        <CommentThread issue={issue} />
      </div>

      {dispatchOpen && workspacePath !== '' && (
        <DispatchDialog issue={issue} workspacePath={workspacePath} onClose={() => setDispatchOpen(false)} />
      )}
    </div>
  );
}

