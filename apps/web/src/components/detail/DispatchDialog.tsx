/**
 * 派发设置弹窗（§5.2）：
 * - CLI select：未安装项禁用标"未安装"，默认第一个已安装；
 * - 模型：select（默认该 CLI 上次使用的模型，localStorage 记录，无则第一项）+ 手输切换（datalist）；
 *   CLI supportsModelSelection=false（如 dsh）→ 控件禁用、不预填、提交不带 model，标注"由 profile 配置决定"；
 * - 会话选择：该 issue 有历史会话时单选——新建（默认）/ 续用最近（reuse_session:'last'）；
 * - prompt textarea 预填前端渲染后的默认模板全文；打开时拉取评论，最近 10 条 ts 升序渲染为
 *   `## 历史备注\n- [author] content` 追加到预填末尾（与服务端 renderHistoryNotes 逐字符一致），
 *   用户可自由删改，提交原样上传；服务端检测已含该段时跳过追加（防双份）；
 * - 确认 → POST /api/sessions {cli, model, issue_id, prompt, reuse_session} → openChat 切聊天视图。
 */
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_DISPATCH_IMAGE_BYTES, MAX_DISPATCH_IMAGE_COUNT, MAX_DISPATCH_SELECTED_ID_COUNT, selectDispatchBatch, type CliInfo, type DispatchAttachmentCandidate, type Issue, type IssueComment, type ModelInfo, type PageResult, type Session, type TaskKnowledge } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';
import {
  DISPATCH_PROMPT_TEMPLATE,
  loadLastModel,
  renderDispatchPrompt,
  renderHistoryNotes,
  saveLastModel,
} from '../../lib/dispatchTemplate';
import { usePanelStore } from '../../state/panelStore';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

function createRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function DispatchDialog({
  issue,
  workspacePath,
  onClose,
}: {
  issue: Issue;
  workspacePath: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const openChat = usePanelStore((s) => s.openChat);

  const [cliId, setCliId] = useState('');
  const [model, setModel] = useState('');
  const [manual, setManual] = useState(false);
  const [reuse, setReuse] = useState<'new' | 'last'>('new');
  // 打开时预填渲染后的默认模板全文；评论加载后追加历史备注段，此后用户编辑即整体替换（后端仍渲染 4 变量）
  const [prompt, setPrompt] = useState(() =>
    renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, {
      issue_id: issue.id,
      title: issue.title,
      description: issue.description,
      workspace_path: workspacePath,
      workspace_id: issue.workspace_id,
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(true);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [retryUnknownImages, setRetryUnknownImages] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [dispatched, setDispatched] = useState(false);
  const dispatchRequestIds = useRef(new Map<string, string>());

  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const { data: models } = useQuery({
    queryKey: ['clis', cliId, 'models'],
    queryFn: () => api.get<ModelInfo[]>(`/api/clis/${cliId}/models`),
    enabled: cliId !== '',
  });
  const { data: allSessions } = useQuery({
    queryKey: ['sessions', issue.workspace_id],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(issue.workspace_id)}`),
  });
  const issueSessions = (allSessions ?? []).filter((s) => s.issue_id === issue.id);
  // 模型只读：所选 CLI supportsModelSelection=false（如 dsh，模型由 CLI profile 配置决定）
  const modelReadOnly = (clis ?? []).find((c) => c.id === cliId)?.supportsModelSelection === false;
  // 打开时拉取评论渲染历史备注段（queryKey 与 CommentThread 一致，缓存复用）
  const { data: comments } = useQuery({
    queryKey: ['comments', issue.id],
    queryFn: () => api.get<IssueComment[]>(`/api/issues/${issue.id}/comments`),
  });
  const historyNotes = comments === undefined ? null : renderHistoryNotes(comments);
  const pendingAttachments = useInfiniteQuery({
    queryKey: ['pending-attachments', issue.id],
    queryFn: ({ pageParam }) => api.get<PageResult<DispatchAttachmentCandidate>>(
      `/api/issues/${encodeURIComponent(issue.id)}/pending-attachments?limit=20&offset=${pageParam}`,
    ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  });
  const candidates = pendingAttachments.data?.pages.flatMap((page) => page.items) ?? [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIdSet = new Set(selectedAttachmentIds);
  const selectedCandidates = candidates.filter((candidate) => selectedIdSet.has(candidate.id));
  const selectedBatch = selectDispatchBatch(selectedCandidates);
  const selectedBytes = selectedCandidates.reduce((total, candidate) => total + candidate.size_bytes, 0);
  const hasUnknownImages = selectedBatch.some((candidate) => candidate.delivery_state === 'unknown');
  const candidateIdsKey = candidates.map((candidate) => candidate.id).join('\u0000');

  useEffect(() => {
    const firstPage = pendingAttachments.data?.pages[0];
    if (selectionInitialized || firstPage === undefined) return;
    const defaultIds: string[] = [];
    let totalBytes = 0;
    for (const candidate of firstPage.items) {
      if (defaultIds.length >= MAX_DISPATCH_IMAGE_COUNT) break;
      if (totalBytes + candidate.size_bytes > MAX_DISPATCH_IMAGE_BYTES) continue;
      defaultIds.push(candidate.id);
      totalBytes += candidate.size_bytes;
    }
    setSelectedAttachmentIds(defaultIds);
    setSelectionInitialized(true);
    if (firstPage.items.length > defaultIds.length || firstPage.next_offset !== null) {
      setSelectionNotice('默认已选最早的可发送图片；未选图片会保持待读，可加载更多并调整本批。');
    }
  }, [pendingAttachments.data, selectionInitialized]);

  useEffect(() => {
    if (!selectionInitialized) return;
    setSelectedAttachmentIds((current) => {
      const next = current.filter((id) => candidateById.has(id));
      return next.length === current.length ? current : next;
    });
  }, [candidateIdsKey, selectionInitialized]);

  const toggleAttachment = (id: string, checked: boolean): void => {
    setSelectionNotice(null);
    if (!checked) {
      setSelectedAttachmentIds((current) => current.filter((selectedId) => selectedId !== id));
      if (candidateById.get(id)?.delivery_state === 'unknown') setRetryUnknownImages(false);
      return;
    }
    const candidate = candidateById.get(id);
    if (!candidate || selectedAttachmentIds.includes(id)) return;
    if (selectedAttachmentIds.length >= MAX_DISPATCH_SELECTED_ID_COUNT) {
      setSelectionNotice(`一次最多选择 ${MAX_DISPATCH_SELECTED_ID_COUNT} 张；请先取消图片后再选。`);
      return;
    }
    const nextIds = [...selectedAttachmentIds, id];
    setSelectedAttachmentIds(nextIds);
    const nextSet = new Set(nextIds);
    const nextCandidates = candidates.filter((item) => nextSet.has(item.id));
    if (selectDispatchBatch(nextCandidates).length < nextCandidates.length) {
      setSelectionNotice(`所选图片超出单批上限；派发将按最旧顺序附上最多 ${MAX_DISPATCH_IMAGE_COUNT} 张且合计不超过 20 MiB，未附图片继续待读。`);
    }
  };

  const modelTouchedRef = useRef(false);
  const historyNotesAppendedRef = useRef(false);

  // 评论加载完成后一次性把历史备注段追加到预填 prompt 末尾（仅一次，保留用户已做的编辑）；无评论不追加
  useEffect(() => {
    if (comments === undefined || historyNotesAppendedRef.current) return;
    historyNotesAppendedRef.current = true;
    if (historyNotes !== null) setPrompt((p) => `${p}\n${historyNotes}`);
  }, [comments, historyNotes]);

  // CLI 默认第一个已安装项
  useEffect(() => {
    if (clis === undefined) return;
    if (cliId !== '') return;
    const firstInstalled = clis.find((c) => c.installed);
    if (firstInstalled !== undefined) setCliId(firstInstalled.id);
  }, [clis, cliId]);

  // 切换 CLI：重置模型与手输态
  useEffect(() => {
    if (cliId === '') return;
    setModel('');
    setManual(false);
    modelTouchedRef.current = false;
  }, [cliId]);

  // 默认模型：上次使用（在清单内），否则第一项；用户已手动选择/输入则不覆盖；模型只读（dsh）不预填
  useEffect(() => {
    if (cliId === '' || models === undefined || modelTouchedRef.current || model !== '') return;
    if (modelReadOnly) return;
    const last = loadLastModel(cliId);
    const restored = last !== null && models.some((m) => m.id === last) ? last : (models[0]?.id ?? '');
    if (restored !== '') setModel(restored);
  }, [cliId, models, model, modelReadOnly]);

  const changeModel = (value: string): void => {
    modelTouchedRef.current = true;
    setModel(value);
  };

  const dispatch = useMutation({
    mutationFn: () => {
      const body = {
        cli: cliId,
        // 模型只读（dsh）：不传 model（由 CLI profile 配置决定）
        model: modelReadOnly ? null : model.trim() === '' ? null : model.trim(),
        issue_id: issue.id,
        prompt,
        reuse_session: reuse,
        knowledge_enabled: knowledgeEnabled,
        retry_unknown_images: retryUnknownImages,
        selected_attachment_ids: selectedAttachmentIds,
        ...(knowledgeQuery.trim() ? { knowledge_query: knowledgeQuery.trim() } : {}),
      };
      const serialized = JSON.stringify(body);
      let requestId = dispatchRequestIds.current.get(serialized);
      if (requestId === undefined) {
        requestId = createRequestId();
        dispatchRequestIds.current.set(serialized, requestId);
      }
      return api.post<Session & { knowledge?: TaskKnowledge; remaining_attachment_count?: number }>('/api/sessions', body, {
        headers: reuse === 'last' ? { 'Idempotency-Key': requestId } : undefined,
      });
    },
    onSuccess: async (session) => {
      const m = modelReadOnly ? '' : model.trim();
      if (m !== '') saveLastModel(cliId, m);
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      void queryClient.invalidateQueries({ queryKey: ['issue', issue.id] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      const remaining = session.remaining_attachment_count ?? 0;
      if (session.knowledge?.warning) {
        setDispatched(true);
        setError('任务已派发，但知识检索不可用；本次沿用原任务上下文。');
        if (remaining > 0) setBatchNotice(`另有 ${remaining} 张未附，仍保持待读。`);
      } else if (remaining > 0) {
        setDispatched(true);
        await queryClient.invalidateQueries({ queryKey: ['pending-attachments', issue.id], exact: true });
        setSelectedAttachmentIds([]);
        setRetryUnknownImages(false);
        setReuse('last');
        setSelectionInitialized(true);
        setSelectionNotice(null);
        setBatchNotice(`本批已派发；另有 ${remaining} 张未附，仍保持待读。可选择下一批继续派发。`);
        setDispatched(false);
      } else onClose();
      openChat(session.id, session);
    },
    onError: (e) => setError(e instanceof Error ? e.message : '派发失败'),
  });

  const modelIds = (models ?? []).map((m) => m.id);
  const selectOptions =
    model !== '' && !modelIds.includes(model) ? [model, ...modelIds] : modelIds;

  const submit = (): void => {
    if (dispatch.isPending || dispatched || cliId === '' || !selectionInitialized || pendingAttachments.isError ||
        (hasUnknownImages && !retryUnknownImages) || selectedCandidates.length !== selectedAttachmentIds.length) return;
    setError(null);
    dispatch.mutate();
  };

  return (
    <Modal open title="派发设置" onClose={onClose} scrollable>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="启用知识参考" checked={knowledgeEnabled} disabled={dispatched} onChange={e => setKnowledgeEnabled(e.target.checked)} />启用当前项目＋公共知识参考</label>
        {knowledgeEnabled && <label className="block text-sm">知识查询<input aria-label="知识查询" className={inputCls} maxLength={500} value={knowledgeQuery} disabled={dispatched} placeholder="自动使用任务标题、标签和描述；可自定义" onChange={e => setKnowledgeQuery(e.target.value)} /></label>}
        {hasUnknownImages && <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="确认重试未知投递图片" checked={retryUnknownImages} disabled={dispatched} onChange={e => setRetryUnknownImages(e.target.checked)} /><span>所选图片中有投递结果未知的图片。确认后，本批会再次发送这些图片。</span></label>}
        <fieldset className="space-y-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-700" aria-label="历史图片派发批次">
          <legend className="px-1">历史图片（已选 {selectedAttachmentIds.length} 张，{(selectedBytes / (1024 * 1024)).toFixed(2)} MiB）</legend>
          {pendingAttachments.isPending && <p>正在读取待派发图片…</p>}
          {pendingAttachments.isError && <p role="alert">待派发图片读取失败，请关闭后重试。</p>}
          {candidates.map((candidate) => (
            <label key={candidate.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800">
              <input
                type="checkbox"
                aria-label={`选择图片 ${candidate.file_name}`}
                checked={selectedAttachmentIds.includes(candidate.id)}
                disabled={dispatched}
                onChange={(event) => toggleAttachment(candidate.id, event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block break-all">{candidate.file_name} · {(candidate.size_bytes / (1024 * 1024)).toFixed(2)} MiB · {candidate.delivery_state === 'unknown' ? '结果未知' : '待读'}</span>
                <span className="block truncate text-xs text-neutral-500">{candidate.author}: {candidate.snippet}</span>
              </span>
            </label>
          ))}
          {candidates.length === 0 && !pendingAttachments.isPending && !pendingAttachments.isError && <p className="text-neutral-500">没有待读图片。</p>}
          {pendingAttachments.hasNextPage && (
            <button type="button" onClick={() => void pendingAttachments.fetchNextPage()} disabled={pendingAttachments.isFetchingNextPage || dispatched} className="rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-950/40">
              {pendingAttachments.isFetchingNextPage ? '加载中…' : '加载更多历史图片'}
            </button>
          )}
          {selectionNotice && <p role="status" data-testid="attachment-selection-notice">{selectionNotice}</p>}
          {batchNotice && <p role="status" data-testid="attachment-batch-notice">{batchNotice}</p>}
          <p className="text-xs text-neutral-500">每批最多 {MAX_DISPATCH_IMAGE_COUNT} 张、合计 20 MiB；超出所选图片留待读，并在派发提示中标注剩余数。</p>
        </fieldset>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">CLI</span>
          <select
            data-testid="cli-select"
            aria-label="CLI"
            value={cliId}
            onChange={(e) => setCliId(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              选择 CLI
            </option>
            {(clis ?? []).map((c) => (
              <option key={c.id} value={c.id} disabled={!c.installed}>
                {c.displayName}
                {c.installed ? '' : '（未安装）'}
              </option>
            ))}
          </select>
        </label>

        <div className="text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">模型</span>
          <div className="flex items-center gap-2">
            {manual ? (
              <input
                data-testid="model-manual-input"
                aria-label="模型（手动输入）"
                list="dispatch-model-options"
                value={model}
                onChange={(e) => changeModel(e.target.value)}
                placeholder="输入模型 id"
                disabled={modelReadOnly}
                className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
              />
            ) : (
              <select
                data-testid="model-select"
                aria-label="模型"
                value={model}
                onChange={(e) => changeModel(e.target.value)}
                disabled={cliId === '' || modelIds.length === 0 || modelReadOnly}
                className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {modelIds.length === 0 && <option value="">（无可用模型，可手输）</option>}
                {selectOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              <input
                type="checkbox"
                data-testid="model-mode-toggle"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
                disabled={modelReadOnly}
              />
              手输
            </label>
          </div>
          {modelReadOnly && (
            <p data-testid="model-readonly-hint" className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
              由 profile 配置决定
            </p>
          )}
          <datalist id="dispatch-model-options">
            {modelIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </div>

        {issueSessions.length > 0 && (
          <fieldset className="text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">会话</legend>
            <div data-testid="reuse-group" className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reuse-session"
                  value="new"
                  checked={reuse === 'new'}
                  onChange={() => setReuse('new')}
                />
                新建会话（默认，干净上下文）
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reuse-session"
                  value="last"
                  checked={reuse === 'last'}
                  onChange={() => setReuse('last')}
                />
                续用最近会话（保留 agent 已有进度）
              </label>
            </div>
          </fieldset>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">Prompt 模板</span>
          <textarea
            data-testid="dispatch-prompt"
            aria-label="Prompt 模板"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={12}
            className={`${inputCls} font-mono text-xs`}
          />
          {historyNotes !== null && (
            <span data-testid="history-note" className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
              历史备注（最近10条评论，可自由删改；服务端检测到该段时不再追加）
            </span>
          )}
        </label>

        {error !== null && (
          <p role="alert" data-testid="dispatch-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="dispatch-confirm"
            onClick={submit}
            disabled={cliId === '' || dispatch.isPending || !selectionInitialized || pendingAttachments.isError || (hasUnknownImages && !retryUnknownImages) || selectedCandidates.length !== selectedAttachmentIds.length}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {dispatch.isPending ? '派发中…' : '确认派发'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

