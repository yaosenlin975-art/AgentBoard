/**
 * 任务详情视图（§7.4）：
 * - 字段区：标题 / 描述（markdown 预览与编辑切换）/ 标签（逗号分隔），
 *   onChange 防抖 500ms 合并 PATCH（占用中也可编辑，agent 经 kb show 拉取最新）；
 * - 操作区：D4 起收进底部吸底条（ActionBar，1 主 + ⋯ 溢出；危险操作在 ⋯ 内做行内确认）；
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
import { useWorkspaceStatuses } from '../../lib/workspaceStatuses';
import { getIssueDescendantIds } from '../../lib/issueTree';
import { attachmentIdsFromText, collectDraftImages, filesFromClipboard, filesFromDataTransfer } from '../../lib/imageDraft';
import { openBlockerCount, type DependencyView } from '../../lib/dependency';
import { usePanelStore } from '../../state/panelStore';
import { ActionBar } from './ActionBar';
import { CommentThread } from './CommentThread';
import { LabelChipsEditor } from './LabelChipsEditor';
import { readCommentDraft, writeCommentDraft } from '../../lib/commentDraft';
import { DependencySection } from './DependencySection';
import { DispatchDialog } from './DispatchDialog';
import { FoldSection } from './FoldSection';
import { MetaRow, type DueDraft } from './MetaRow';
import { SessionList } from './SessionList';
import { TitleInlineEditor } from './TitleInlineEditor';

const inputCls =
  'w-full rounded border border-hairline bg-surface-card px-2 py-1.5 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

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
  const [description, setDescription] = useState('');
  /** 描述编辑器异步插图时读取最新文本（上传期间用户可能继续输入，不能用过期闭包覆盖） */
  const descriptionRef = useRef('');
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descFileInputRef = useRef<HTMLInputElement>(null);
  const descUploadSeq = useRef(0);
  const [descPendingImages, setDescPendingImages] = useState<
    Array<{ id: number; name: string; status: 'uploading' | 'error'; error?: string }>
  >([]);
  const [descImageError, setDescImageError] = useState<string | null>(null);
  const [descDragOver, setDescDragOver] = useState(false);
  const [priority, setPriority] = useState<Priority>('中');
  const [labels, setLabels] = useState<string[]>([]);
  /** I-04：评论草稿提到面板层，既能落 localStorage，也能被「通过验收并关闭」预填 */
  const [commentDraft, setCommentDraft] = useState('');
  /** DUE-DATE：日期与时间分别可空，各自走防抖 PATCH */
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [descEditing, setDescEditing] = useState(false);
  /** D3：描述长文本默认 3 行 clamp，点展开后完整显示 */
  const [descExpanded, setDescExpanded] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [claimBlocked, setClaimBlocked] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!issue) return;
    setDescription(issue.description);
    descriptionRef.current = issue.description;
    setDescPendingImages([]);
    setDescImageError(null);
    setDescDragOver(false);
    setPriority(issue.priority);
    setLabels(issue.labels);
    setCommentDraft(readCommentDraft(issue.id));
    setDueDate(issue.due_date ?? '');
    setDueTime(issue.due_time ?? '');
    setDescEditing(false);
    setDescExpanded(false);
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
            // 不再 invalidate ['issues']：refetch 若拿到落后快照会把刚写入的真值覆盖回去（用户报障的成因）
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

  /**
   * RELEASE-REFRESH：release/done 的响应体是 `{ ...issue, comment }`。
   * 修复两点：
   * 1. 详情缓存只写 issue 字段（不再把 `comment` 混进去）；
   * 2. **就地把列表缓存里该项换掉**——卡片立刻离开「进行中」、占用徽标立刻消失；
   *    之前只 `invalidateQueries(['issues'])`，在 WS 帧丢失（重连窗口）时要等下一次 refetch 才归位。
   */
  const refreshIssue = (updated: Issue & { comment?: unknown }): void => {
    const { comment: _comment, ...issue } = updated;
    queryClient.setQueryData(['issue', issue.id], issue);
    queryClient.setQueryData<Issue[]>(['issues', issue.workspace_id], (list) =>
      list === undefined ? list : list.map((item) => (item.id === issue.id ? issue : item)),
    );
    // 不再 invalidate ['issues']：refetch 若拿到落后快照会把刚写入的真值覆盖回去（用户报障的成因）
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
      // 不再 invalidate ['issues']：refetch 若拿到落后快照会把刚写入的真值覆盖回去（用户报障的成因）
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

  // STATUS-3-UI：状态下拉取工作区状态字典（含自定义状态）；关闭项按 kind=done 判定。
  // hook 必须在下面所有 early return 之前调用（否则 hook 数量随加载状态变化，React 会直接崩）。
  const statusDictionary = useWorkspaceStatuses(issue?.workspace_id ?? null);

  /**
   * D1：标题就地编辑提交。
   * - 默认带 workspace_id + expected_updated_at（CAS），409 交给 TitleInlineEditor 展示并提供「仍然保存」；
   * - force=true 表示冲突后仍要写入：不带 CAS 字段（服务端允许无 CAS 的普通 PATCH）。
   */
  const saveTitle = useCallback(
    async (value: string, options: { force: boolean }): Promise<void> => {
      if (issueId === null || issue === undefined) return;
      const body: Record<string, unknown> = { title: value };
      if (!options.force) {
        body.workspace_id = issue.workspace_id;
        body.expected_updated_at = issue.updated_at;
      }
      const updated = await api.patch<Issue>(`/api/issues/${issueId}`, body);
      queryClient.setQueryData(['issue', issueId], updated);
    },
    [issueId, issue, queryClient],
  );

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
  // F-07：标签联想取本工作区已有标签（去重）
  const allLabels = [...new Set((workspaceIssues ?? []).flatMap((item) => item.labels))];
  // D3：长描述默认 3 行 clamp（按长度/行数启发式判定是否显示「展开全文」）
  const descLong = description.trim() !== '' && (description.length > 140 || description.split('\n').length > 3);

  const changeLabels = (next: string[]): void => {
    setLabels(next);
    schedulePatch('labels', next);
  };
  /** D2：截止 popover 的「应用 / 清除」统一落库；日期为空时同时清时间（沿用旧语义） */
  const applyDue = (next: DueDraft): void => {
    setDueDate(next.date);
    setDueTime(next.time);
    schedulePatch('due_date', next.date === '' ? null : next.date);
    schedulePatch('due_time', next.time === '' ? null : next.time);
  };
  const updateDraft = (value: string): void => {
    setCommentDraft(value);
    writeCommentDraft(issue.id, value);
  };
  /** F-01：通过验收并关闭 —— 与状态下拉同一 PATCH 口径（workspace_id + expected_updated_at） */
  const acceptAndClose = (): void => {
    const acceptance = `验收通过：按验收标准逐条核对，未发现阻塞问题。（${new Date().toLocaleString()}）`;
    updateDraft(acceptance);
    changeStatus.mutate('已关闭');
  };

  /**
   * DETAIL-D6：描述编辑器的图片入口（粘贴为主、拖拽/选择为辅）。
   * - 与评论同一套校验：PNG/JPEG/WebP、单张 ≤10 MiB、整条描述最多 5 张（复用 imageDraft，不新写规则）；
   * - 只把上传成功的附件以固定 URL `![alt](/api/workspaces/{ws}/attachments/{id})` 插到光标处；
   *   失败不写坏 markdown，只留可见的失败状态；
   * - 串行 await 保证「按接收顺序插入」；插入时读 descriptionRef 的最新值，避免覆盖上传期间的新输入。
   */
  const addDescriptionImages = (files: File[]): void => {
    if (files.length === 0 || issue === undefined) return;
    const existing = attachmentIdsFromText(descriptionRef.current).length
      + descPendingImages.filter((item) => item.status === 'uploading').length;
    const { accepted, rejection } = collectDraftImages(files, existing);
    setDescImageError(rejection);
    if (accepted.length === 0) return;

    const textarea = descTextareaRef.current;
    let insertAt = textarea !== null ? textarea.selectionStart : descriptionRef.current.length;
    void (async () => {
      for (const { file, mimeType } of accepted) {
        const localId = ++descUploadSeq.current;
        setDescPendingImages((list) => [...list, { id: localId, name: file.name, status: 'uploading' }]);
        try {
          const result = await api.uploadAttachment(issue.workspace_id, file, mimeType);
          const url = `/api/workspaces/${issue.workspace_id}/attachments/${result.id}`;
          const alt = file.name.replace(/[[\]]/g, '').trim() || '图片';
          const markdown = `![${alt}](${url})`;
          const base = descriptionRef.current;
          const at = Math.min(Math.max(insertAt, 0), base.length);
          const before = base.slice(0, at);
          const after = base.slice(at);
          const prefix = before === '' || before.endsWith('\n') ? '' : '\n';
          const inserted = `${prefix}${markdown}\n`;
          const next = before + inserted + after;
          descriptionRef.current = next;
          insertAt = before.length + inserted.length;
          setDescription(next);
          schedulePatch('description', next);
          setDescPendingImages((list) => list.filter((item) => item.id !== localId));
        } catch (e) {
          setDescPendingImages((list) => list.map((item) => (
            item.id === localId
              ? { ...item, status: 'error', error: e instanceof Error ? e.message : '上传失败' }
              : item
          )));
          setDescImageError(e instanceof Error ? e.message : '上传失败');
        }
      }
    })();
  };

  descriptionRef.current = description;

  return (
    <div data-testid="detail-panel" className="flex h-full min-h-0 flex-col">
      {/* 滚动区：右侧留 16px（> 15px 经典滚动条宽度），避免滚动条压住标题与首个字段 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3 pl-3 pr-4">
        {/* 字段区 */}
        <section aria-label="字段" className="space-y-2">
          {/* D1：标题顶掉「任务详情」标题行；阅读态 + ✎ 就地编辑 */}
          <TitleInlineEditor title={issue.title} onSave={saveTitle} />

          {/* D2：状态 / 优先级 / 截止 / 负责人 四 chip 同排；明细收进 popover */}
          <MetaRow
            issue={issue}
            priority={priority}
            dueDate={dueDate}
            dueTime={dueTime}
            statuses={statusDictionary.statuses}
            statusBlocked={statusBlocked}
            closeBlocked={closeBlocked}
            statusPending={changeStatus.isPending}
            onStatusChange={(next) => changeStatus.mutate(next)}
            onPriorityChange={(next) => {
              setPriority(next);
              schedulePatch('priority', next);
            }}
            onDueChange={(next) => applyDue(next)}
          />

          <div className="text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-neutral-600 dark:text-neutral-300">描述</span>
              <button
                type="button"
                data-testid="desc-toggle"
                onClick={() => setDescEditing((v) => !v)}
                className="rounded px-1.5 py-0.5 text-xs text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
              >
                {descEditing ? '预览' : '编辑'}
              </button>
            </div>
            {descEditing ? (
              <div>
                <textarea
                  ref={descTextareaRef}
                  data-testid="desc-input"
                  aria-label="描述（markdown）"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    schedulePatch('description', e.target.value);
                  }}
                  onPaste={(event) => {
                    const files = filesFromClipboard(event.clipboardData);
                    if (files.length === 0) return;
                    event.preventDefault();
                    addDescriptionImages(files);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDescDragOver(true);
                  }}
                  onDragLeave={() => setDescDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDescDragOver(false);
                    addDescriptionImages(filesFromDataTransfer(event.dataTransfer));
                  }}
                  rows={6}
                  className={`${inputCls} ${descDragOver ? 'ring-2 ring-accent ring-offset-1' : ''}`}
                />
                {/* D6：与评论一致的图片入口（粘贴为主、拖拽/选择为辅） */}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    ref={descFileInputRef}
                    data-testid="desc-image-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      addDescriptionImages(files);
                    }}
                  />
                  <button
                    type="button"
                    data-testid="desc-image-picker"
                    onClick={() => descFileInputRef.current?.click()}
                    className="rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    添加图片
                  </button>
                  <span className="text-[11px] text-ink-3">可直接粘贴或拖入；PNG / JPEG / WebP，单张 ≤10 MiB，整条描述最多 5 张</span>
                </div>
                {descPendingImages.length > 0 && (
                  <ul data-testid="desc-image-uploads" className="mt-1 space-y-0.5">
                    {descPendingImages.map((item) => (
                      <li
                        key={item.id}
                        data-testid={`desc-image-upload-${item.id}`}
                        className={item.status === 'error' ? 'text-[11px] text-red-600 dark:text-red-400' : 'text-[11px] text-ink-3'}
                      >
                        {item.name} · {item.status === 'uploading' ? '上传中…' : `上传失败：${item.error ?? '未知错误'}`}
                      </li>
                    ))}
                  </ul>
                )}
                {descImageError !== null && (
                  <p role="alert" data-testid="desc-image-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {descImageError}
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* D3：去掉预览外层边框容器，正文直接铺在纸面上；长文本默认 3 行 clamp */}
                <div data-testid="desc-preview" className={descExpanded ? '' : 'line-clamp-3'}>
                  <MarkdownView>{description.trim() === '' ? '（无描述）' : description}</MarkdownView>
                </div>
                {descLong && (
                  <button
                    type="button"
                    data-testid="desc-expand"
                    aria-expanded={descExpanded}
                    onClick={() => setDescExpanded((value) => !value)}
                    className="mt-0.5 text-[11px] text-ink-3 underline underline-offset-2 hover:text-accent"
                  >
                    {descExpanded ? '收起' : '展开全文'}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标签</span>
            {/* F-07：chips 编辑器 —— 回车成 chip、去重、逐枚删除，视觉与任务卡 chips 一致 */}
            <LabelChipsEditor labels={labels} suggestions={allLabels} onChange={changeLabels} />
          </div>
        </section>

        {/* D4：操作区已迁出滚动区，收进底部吸底条（见 scroll 容器之后的 ActionBar） */}

        {/* 依赖：D3 起默认只占一行摘要，点开后才显示三组明细与添加入口 */}
        <DependencySection issue={issue} />

        {/* 评论：D3 起默认只显示最新 2 条，可「查看全部」 */}
        <CommentThread issue={issue} draft={commentDraft} onDraftChange={updateDraft} />

        {/* D3 折叠区：关联会话 / 附件 / 原始 JSON / 审计证据 */}
        <FoldSection title="关联会话" testId="fold-sessions" count={issueSessions.length}>
          {/* SessionList 自带 h3，折叠标题已经承担分组名，这里隐藏重复标题 */}
          <div className="[&_h3]:hidden">
            <SessionList sessions={issueSessions} currentSessionId={issue.session_id} onSelect={(s) => openChat(s.id, s)} />
          </div>
        </FoldSection>

        <FoldSection title="附件" testId="fold-attachments">
          <p data-testid="fold-attachments-empty" className="text-[11px] text-ink-3">
            暂无附件索引；粘贴截图会随评论一起上传（DETAIL-D6），路径索引在 DETAIL-D7 接入。
          </p>
        </FoldSection>

        <FoldSection title="原始 JSON" testId="fold-raw-json">
          <pre
            data-testid="fold-raw-json-pre"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-hairline bg-surface-raised p-1.5 text-[10.5px] text-ink-3"
          >
            {JSON.stringify(issue, null, 2)}
          </pre>
        </FoldSection>

        <FoldSection title="审计证据" testId="fold-audit">
          <p data-testid="detail-audit-note" className="text-[11px] text-ink-3">
            活动记录需要服务端 issue 级历史接口（未落地）；本区暂不展示伪造数据。
          </p>
        </FoldSection>
      </div>

      {/* D4：吸底操作条（flex 末位子项，贴面板底边；不随滚动区内容滚走） */}
      <ActionBar
        issue={issue}
        dispatchable={dispatchable}
        claimed={claimed}
        closeBlocked={closeBlocked}
        directChildCount={directChildCount}
        actionError={actionError}
        claimBlocked={claimBlocked}
        blockers={dependencies?.blockers ?? []}
        dependenciesLoaded={dependencies !== undefined}
        statusPending={changeStatus.isPending}
        releasePending={release.isPending}
        donePending={markDone.isPending}
        deletePending={remove.isPending}
        onDispatch={() => {
          // claim 入口前端先拦：有未解除前置时列出 blocker 清单，不开派发弹窗（服务端 409 仍是唯一防线）
          if (openBlockerCount(issue) > 0) {
            setClaimBlocked(true);
            return;
          }
          setDispatchOpen(true);
        }}
        onAcceptClose={acceptAndClose}
        onReopenRunning={() => changeStatus.mutate('进行中')}
        // 已关闭→重新打开：回到「待规划」（可再派发）；进行中 只能由 claim/done 流转，不能手动跳过去
        onReopenClosed={() => changeStatus.mutate('待规划')}
        onRelease={() => release.mutate()}
        onDone={() => markDone.mutate()}
        onDelete={() => remove.mutate()}
        onDismissClaimBlocked={() => setClaimBlocked(false)}
      />

      {dispatchOpen && workspacePath !== '' && (
        <DispatchDialog issue={issue} workspacePath={workspacePath} onClose={() => setDispatchOpen(false)} />
      )}
    </div>
  );
}

