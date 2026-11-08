/**
 * 任务详情视图（§7.4）：
 * - 字段区：标题 / 描述（markdown 预览与编辑切换）/ 标签（逗号分隔），
 *   onChange 防抖 500ms 合并 PATCH（占用中也可编辑，agent 经 kb show 拉取最新）；
 * - 操作区：D4 起收进底部吸底条（ActionBar，1 主 + ⋯ 溢出；危险操作在 ⋯ 内做行内确认）；
 * - 关联会话列表（点击切聊天）与评论区。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '../../lib/markdown';
import type { Issue, Priority, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  deleteIssue,
  getIssue,
  getIssueDependencies,
  listIssues,
  patchIssue,
  releaseIssue,
} from '../../api/endpoints';
import { ISSUE_STATUSES, manualStatusBlockedReason } from '../../lib/issueStatus';
import { attachmentIdsFromText, collectDraftImages, filesFromClipboard, filesFromDataTransfer } from '../../lib/imageDraft';
import { openBlockerCount } from '../../lib/dependency';
import { usePanelStore } from '../../state/panelStore';
import { ActionBar } from './ActionBar';
import { AttachmentsSection } from './AttachmentsSection';
import { CommentThread } from './CommentThread';
import { LabelChipsEditor } from './LabelChipsEditor';
import { readCommentDraft, writeCommentDraft } from '../../lib/commentDraft';
import { DependencySection } from './DependencySection';
import { DispatchDialog } from './DispatchDialog';
import { DecisionSection } from '../decisions/DecisionSection';
import { FoldSection } from './FoldSection';
import { MetaRow, type DueDraft } from './MetaRow';
import { SessionList } from './SessionList';
import { TitleInlineEditor } from './TitleInlineEditor';

const inputCls =
  'w-full rounded border border-hairline bg-surface-card px-2 py-1.5 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

const DEBOUNCE_MS = 500;

/** DETAIL-CREATED：创建时间的本地展示格式（YYYY-MM-DD HH:MM），不引第三方日期库 */
function formatCreatedAt(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '未知';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DetailPanel() {
  const issueId = usePanelStore((s) => s.issueId);
  const openChat = usePanelStore((s) => s.openChat);
  const closeRight = usePanelStore((s) => s.closeRight);
  const queryClient = useQueryClient();

  const { data: issue, error: issueError } = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => getIssue(issueId!),
    enabled: issueId !== null,
  });
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
    enabled: issue !== undefined,
  });
  const { data: workspaceIssues } = useQuery({
    queryKey: ['issues', issue?.workspace_id],
    queryFn: () => listIssues(issue!.workspace_id),
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
    queryFn: () => getIssueDependencies(issueId!, issue!.workspace_id),
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
  /** DETAIL-DESC-EXPAND：描述默认展开全文（用户口径）；长描述保留「收起」，descLong 判据不变 */
  const [descCollapsed, setDescCollapsed] = useState(false);
  /** 顶栏标题槽位（由 RightPanel 表头提供；独立渲染 DetailPanel 时为空，标题回落正文顶部） */
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  /** 标题编辑工具条槽位（表头下方独立一行，避免撑高 h-10 表头） */
  const [editBarSlot, setEditBarSlot] = useState<HTMLElement | null>(null);
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
    setDescCollapsed(false);
    setClaimBlocked(false);
    // 仅在切换 issue 时重置本地编辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id]);

  // DETAIL-LAYOUT：标题块投影到 RightPanel 表头槽位（与关闭按钮同一行）；槽位缺失时回落正文顶部
  useLayoutEffect(() => {
    setTitleSlot(document.getElementById('detail-title-slot'));
    setEditBarSlot(document.getElementById('detail-edit-slot'));
  }, []);

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
        patchIssue(issueId, body)
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
    mutationFn: () => releaseIssue(issueId!),
    onSuccess: refreshIssue,
    onError: (e) => setActionError(e instanceof Error ? e.message : '释放失败'),
  });

  const remove = useMutation({
    mutationFn: () => deleteIssue(issueId!),
    onSuccess: () => {
      // 不再 invalidate ['issues']：refetch 若拿到落后快照会把刚写入的真值覆盖回去（用户报障的成因）
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      closeRight();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '删除失败'),
  });

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
      const updated = await patchIssue(issueId, body);
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
  const directChildCount = workspaceIssues?.filter((candidate) => candidate.parent_issue_id === issue.id).length ?? 0;
  const dispatchable = !claimed && (issue.status === '待规划' || issue.status === '进行中');
  const issueSessions = (allSessions ?? []).filter((s) => s.issue_id === issue.id);
  const workspacePath = (workspaces ?? []).find((w) => w.id === issue.workspace_id)?.path ?? '';
  // F-07：标签联想取本工作区已有标签（去重）
  const allLabels = [...new Set((workspaceIssues ?? []).flatMap((item) => item.labels))];
  // DETAIL-DESC-EXPAND：默认展开全文；超过 3 行或 140 字才给「收起 / 展开全文」入口（短描述不给按钮）
  const descLong = description.trim() !== '' && (description.length > 140 || description.split('\n').length > 3);

  /** 顶栏标题块：标题 + ✎（编辑态原地展开），第二行为占用/进行中的状态维护提示 */
  const titleBlock = (
    <div data-testid="detail-title-block" className="w-full min-w-0">
      <TitleInlineEditor title={issue.title} onSave={saveTitle} editBarSlot={editBarSlot} />
      {statusBlocked !== null && (
        <p data-testid="status-blocked-hint" role="alert" className="mt-0.5 break-words text-[10.5px] leading-4 text-ink-3">
          {statusBlocked}
        </p>
      )}
    </div>
  );

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
      {/* DETAIL-LAYOUT：标题（+ ✎）投影到卡片顶栏，与关闭按钮同一行 */}
      {titleSlot !== null && createPortal(titleBlock, titleSlot)}

      {/* 滚动区：右侧留 16px（> 15px 经典滚动条宽度），避免滚动条压住标题与首个字段 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3 pl-3 pr-4">
        {/* 字段区 */}
        <section aria-label="字段" className="space-y-2">
          {/* 无顶栏槽位（独立渲染 DetailPanel）时标题回落正文顶部 */}
          {titleSlot === null && titleBlock}

          {/* D2：状态 / 优先级 / 截止 / 负责人 四 chip 同排；明细收进 popover */}
          <MetaRow
            issue={issue}
            priority={priority}
            dueDate={dueDate}
            dueTime={dueTime}
            statusBlocked={statusBlocked}
            onPriorityChange={(next) => {
              setPriority(next);
              schedulePatch('priority', next);
            }}
            onDueChange={(next) => applyDue(next)}
          />

          {/* DETAIL-CREATED：创建时间只读展示（title 给完整本地时间；不发任何写请求） */}
          <p
            data-testid="detail-created-at"
            title={new Date(issue.created_at).toLocaleString()}
            className="text-[10.5px] text-ink-3"
          >
            创建于 {formatCreatedAt(issue.created_at)}
          </p>

          {/* DEC-6：卡有在途/最近决策时展示问题、选项、答案时间线与断点摘要 */}
          <DecisionSection issue={issue} />

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
                {/* DETAIL-DESC-EXPAND：默认展开全文，点「收起」才 3 行 clamp */}
                <div data-testid="desc-preview" className={descCollapsed ? 'line-clamp-3' : ''}>
                  <MarkdownView>{description.trim() === '' ? '（无描述）' : description}</MarkdownView>
                </div>
                {descLong && (
                  <button
                    type="button"
                    data-testid="desc-expand"
                    aria-expanded={!descCollapsed}
                    onClick={() => setDescCollapsed((value) => !value)}
                    className="mt-0.5 text-[11px] text-ink-3 underline underline-offset-2 hover:text-accent"
                  >
                    {descCollapsed ? '展开全文' : '收起'}
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

        {/* D7：附件路径索引——该卡全部附件（文件名+完整路径），复制路径/置灰的 reveal 占位 */}
        <FoldSection title="附件" testId="fold-attachments">
          <AttachmentsSection issueId={issue.id} />
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
        directChildCount={directChildCount}
        actionError={actionError}
        claimBlocked={claimBlocked}
        blockers={dependencies?.blockers ?? []}
        dependenciesLoaded={dependencies !== undefined}
        releasePending={release.isPending}
        deletePending={remove.isPending}
        onDispatch={() => {
          // claim 入口前端先拦：有未解除前置时列出 blocker 清单，不开派发弹窗（服务端 409 仍是唯一防线）
          if (openBlockerCount(issue) > 0) {
            setClaimBlocked(true);
            return;
          }
          setDispatchOpen(true);
        }}
        onRelease={() => release.mutate()}
        onDelete={() => remove.mutate()}
        onDismissClaimBlocked={() => setClaimBlocked(false)}
      />

      {dispatchOpen && workspacePath !== '' && (
        <DispatchDialog issue={issue} workspacePath={workspacePath} onClose={() => setDispatchOpen(false)} />
      )}
    </div>
  );
}

