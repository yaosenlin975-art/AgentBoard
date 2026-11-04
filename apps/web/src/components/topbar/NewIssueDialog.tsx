/**
 * 新建 issue 弹窗（§7.6 + NEW-ISSUE-IMAGE + SMART-CREATE-UI）：
 * 标题 / 描述 / 优先级 / 标签 / 图片草稿 → POST /api/issues；底部可在「手动创建 / 智能创建」间切换，
 * 切换不丢已填内容。智能创建调 POST /api/issues/draft（不落库）生成**可编辑草稿**，用户确认后才落库；
 * 失败（502/422/504/503）回退手动表单并保留需求原文与已选字段，错误码转中文；
 * warnings 以清单展示不吞掉。取消生成会 abort 请求，不按失败回退。
 * 图片三条入口（选择、拖拽、粘贴）共用同一 pending 上传与预览流程；提交只传 `attachment_ids`。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, Priority } from '@agentboard/shared';
import { api, type AttachmentUploadResult } from '../../api/client';
import { MAX_DRAFT_IMAGES, MAX_IMAGE_BYTES, collectDraftImages, filesFromClipboard, filesFromDataTransfer, type ImageMimeType } from '../../lib/imageDraft';
import {
  ADAPTER_LABEL,
  DRAFT_ADAPTERS,
  DraftAbortError,
  composeRequirementWithImages,
  mapDraftError,
  requestDraft,
  type DraftAdapter,
  type IssueDraft,
} from '../../lib/smartDraft';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

interface PendingImage {
  localId: number;
  file: File;
  mimeType: ImageMimeType;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  error?: string;
}

interface CliInfoLike {
  id: string;
  displayName: string;
  installed: boolean;
}

function fileSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

type CreateMode = 'manual' | 'smart';

export function NewIssueDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('中');
  const [labelsInput, setLabelsInput] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextLocalId = useRef(0);
  const imagesRef = useRef<PendingImage[]>([]);
  imagesRef.current = images;
  // 同一份草稿的重试复用同一幂等键；成功后换新键，避免下一次新建被当成重放
  const draftKeyRef = useRef<string>(crypto.randomUUID());

  // ---- 智能创建（SMART-CREATE-UI）----
  const [mode, setMode] = useState<CreateMode>('manual');
  const [requirement, setRequirement] = useState('');
  const [adapter, setAdapter] = useState<DraftAdapter>('codex');
  /** 可选优先级：空串 = 不传（服务端按不推断处理），选了就原样透传 */
  const [draftPriority, setDraftPriority] = useState<Priority | ''>('');
  const [draft, setDraft] = useState<IssueDraft | null>(null);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [smartMessage, setSmartMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 用户已取消：迟到结果直接丢弃，不按失败回退 */
  const cancelRef = useRef(false);

  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfoLike[]>('/api/clis'),
    enabled: open,
  });

  const clearImages = (): void => {
    imagesRef.current = [];
    setImages([]);
  };

  useEffect(() => () => clearImages(), []);

  // 关闭或切换 workspace：图片草稿属于旧 workspace，立即丢弃（不发删除请求，staged 附件按 TTL 过期）
  useEffect(() => {
    clearImages();
    setError(null);
    draftKeyRef.current = crypto.randomUUID();
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setDraft(null);
    setSmartMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, open]);

  // 生成中的计时：让用户看到「进度」（服务端超时 120s）
  useEffect(() => {
    if (!generating) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [generating]);

  const patchImage = (localId: number, patch: Partial<PendingImage>): void => {
    setImages((current) => {
      const next = current.map((item) => (item.localId === localId ? { ...item, ...patch } : item));
      imagesRef.current = next;
      return next;
    });
  };

  const uploadImage = (item: PendingImage): void => {
    patchImage(item.localId, { status: 'uploading', error: undefined });
    void api
      .uploadAttachment(workspaceId, item.file, item.mimeType)
      .then((result: AttachmentUploadResult) => {
        patchImage(item.localId, { status: 'ready', attachmentId: result.id, error: undefined });
      })
      .catch((e: unknown) => {
        patchImage(item.localId, { status: 'error', error: e instanceof Error ? e.message : '上传失败' });
      });
  };

  const addFiles = (files: File[]): void => {
    const { accepted, rejection } = collectDraftImages(files, imagesRef.current.length, MAX_DRAFT_IMAGES);
    if (accepted.length > 0) {
      const created = accepted.map(({ file, mimeType }) => ({
        localId: ++nextLocalId.current,
        file,
        mimeType,
        status: 'uploading' as const,
      }));
      const next = [...imagesRef.current, ...created];
      imagesRef.current = next;
      setImages(next);
      for (const item of created) uploadImage(item);
    }
    setError(rejection);
  };

  const removeImage = (item: PendingImage): void => {
    const next = imagesRef.current.filter((candidate) => candidate.localId !== item.localId);
    imagesRef.current = next;
    setImages(next);
  };

  const create = useMutation({
    mutationFn: (body: { workspace_id: string; title: string; description: string; priority: Priority; labels: string[]; attachment_ids: string[] }) =>
      api.post<Issue>('/api/issues', body, { headers: { 'Idempotency-Key': draftKeyRef.current } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] });
      setTitle('');
      setDescription('');
      setPriority('中');
      setLabelsInput('');
      setRequirement('');
      setDraft(null);
      setDraftPriority('');
      setSmartMessage(null);
      clearImages();
      draftKeyRef.current = crypto.randomUUID();
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

  /** 当前所选执行方式在本机是否可用（按 /api/clis 实时判断；列表未回来时不判不可用） */
  const selectedCli = (clis ?? []).find((c) => c.id === adapter);
  const adapterUnavailable = selectedCli !== undefined && selectedCli.installed === false;
  const uploading = images.some((item) => item.status === 'uploading');
  const uploadFailed = images.some((item) => item.status === 'error');
  const attachmentIds = images.filter((item) => item.attachmentId !== undefined).map((item) => item.attachmentId!);
  const canSubmit = !create.isPending && !uploading && !uploadFailed && title.trim() !== '';

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!canSubmit) return;
    create.mutate({
      workspace_id: workspaceId,
      title: title.trim(),
      description,
      priority,
      labels: labelsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      // 只传附件 id；描述里不写 base64
      attachment_ids: attachmentIds,
    });
  };

  /** 生成草稿：成功进可编辑草稿表单；失败回退手动表单并保留需求原文 */
  const generate = async (): Promise<void> => {
    const text = requirement.trim();
    if (text === '' || generating) return;
    setSmartMessage(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    cancelRef.current = false;
    setGenerating(true);
    try {
      // KB-SMART-IMG：已粘贴的图片随需求一起交给草稿服务（服务端只收文本 → 前端拼「需求 + 图片说明块」）
      const draftRequirement = composeRequirementWithImages(
        text,
        imagesRef.current.map((item) => ({
          name: item.file.name,
          mimeType: item.mimeType,
          ...(item.attachmentId === undefined ? {} : { attachmentId: item.attachmentId }),
          uploaded: item.status === 'ready',
        })),
      );
      const result = await requestDraft(
        {
          workspace_id: workspaceId,
          requirement: draftRequirement,
          adapter,
          ...(draftPriority === '' ? {} : { priority: draftPriority }),
        },
        { signal: controller.signal },
      );
      if (cancelRef.current) return; // 用户已取消：丢弃迟到结果
      setDraft(result);
      // 草稿进共用字段，用户可直接编辑；优先级只按用户所选（不推断）
      setTitle(result.title);
      setDescription(result.description);
      setLabelsInput(result.labels.join(','));
      if (draftPriority !== '') setPriority(draftPriority);
      setMode('manual');
      setSmartMessage(
        result.sessionReused && result.sessionTurn !== null
          ? `草稿已生成（同一草稿会话 · 第 ${result.sessionTurn} 轮；换工作区或执行方式会开新会话），可编辑后创建任务`
          : '草稿已生成，可编辑后创建任务',
      );
    } catch (e) {
      if (cancelRef.current || e instanceof DraftAbortError) return; // 取消不走失败回退
      setDraft(null);
      setSmartMessage(mapDraftError(e, adapter));
      // 回退手动表单：需求原文灌进描述（不覆盖用户已填的描述），保留已选优先级/标签
      setDescription((current) => (current.trim() === '' ? text : current));
      setMode('manual');
    } finally {
      abortRef.current = null;
      if (!cancelRef.current) setGenerating(false);
    }
  };

  /** 取消：立刻收起进度，迟到结果由 cancelRef 丢弃（不触发失败回退） */
  const cancelGenerate = (): void => {
    cancelRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setSmartMessage('已取消生成，需求原文保留在智能面板');
  };

  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const pasted = filesFromClipboard(event.clipboardData);
    if (pasted.length === 0) return;
    event.preventDefault();
    addFiles(pasted);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    const dropped = filesFromDataTransfer(event.dataTransfer);
    if (dropped.length === 0) return;
    event.preventDefault();
    addFiles(dropped);
  };

  // 视图：草稿已生成且未切到智能面板 → 草稿编辑；否则按 mode 展示
  const showingDraft = draft !== null && mode === 'manual';

  const fieldBlock = (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标题</span>
        <input
          data-testid="new-issue-title"
          aria-label="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className={inputCls}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">描述（markdown）</span>
        <textarea
          data-testid="new-issue-description"
          aria-label="描述"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className={inputCls}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">优先级</span>
        <select
          data-testid="new-issue-priority"
          aria-label="优先级"
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          className={inputCls}
        >
          <option value="低">低</option>
          <option value="中">中</option>
          <option value="高">高</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标签（逗号分隔）</span>
        <input
          data-testid="new-issue-labels"
          aria-label="标签"
          value={labelsInput}
          onChange={(e) => setLabelsInput(e.target.value)}
          placeholder="前端, 性能"
          className={inputCls}
        />
      </label>
    </>
  );

  const smartPanel = (
    <div data-testid="smart-create-panel" className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">需求（一段自然语言，多行）</span>
        <textarea
          data-testid="smart-requirement"
          aria-label="需求"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          rows={4}
          placeholder="例如：把看板列的纵向滚动修好，滚轮能滑动卡片；同时保留横向滚动"
          className={inputCls}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">执行方式</span>
        <select
          data-testid="smart-adapter"
          aria-label="执行方式"
          value={adapter}
          onChange={(e) => setAdapter(e.target.value as DraftAdapter)}
          className={inputCls}
        >
          {DRAFT_ADAPTERS.map((id) => {
            const info = (clis ?? []).find((c) => c.id === id);
            // 可用性按 /api/clis 实时判断：明确 installed=false 才禁用（列表还没回来时不误伤）
            const unavailable = info !== undefined && info.installed === false;
            return (
              <option key={id} value={id} disabled={unavailable}>
                {ADAPTER_LABEL[id]}{unavailable ? '（本机不可用）' : ''}
              </option>
            );
          })}
        </select>
        {(() => {
          const info = (clis ?? []).find((c) => c.id === adapter);
          if (info === undefined || info.installed !== false) return null;
          return (
            <span data-testid="smart-adapter-hint" className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
              {ADAPTER_LABEL[adapter]} 在本机不可用：请先在设置里安装/登录该 CLI，或换一个执行方式。
            </span>
          );
        })()}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">优先级（可选，原样使用，不推断）</span>
        <select
          data-testid="smart-priority"
          aria-label="优先级（可选）"
          value={draftPriority}
          onChange={(e) => setDraftPriority(e.target.value === '' ? '' : (e.target.value as Priority))}
          className={inputCls}
        >
          <option value="">不指定（沿用草稿）</option>
          <option value="低">低</option>
          <option value="中">中</option>
          <option value="高">高</option>
        </select>
      </label>
      {generating && (
        <p data-testid="smart-progress" role="status" className="text-sm text-neutral-600 dark:text-neutral-300">
          正在生成草稿… {elapsed}s（最多 120s）
        </p>
      )}
    </div>
  );

  const warningsBlock = draft !== null && draft.warnings.length > 0 && (
    <div data-testid="draft-warnings" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="font-medium">生成时的提醒（{draft.warnings.length} 条）</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {draft.warnings.map((warning, index) => (
          <li key={`${index}-${warning}`} data-testid={`draft-warning-${index}`}>{warning}</li>
        ))}
      </ul>
    </div>
  );

  return (
    <Modal open={open} title="新建 issue" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" data-testid="new-issue-form" onPaste={onPaste}>
        {/* 状态预填（NEW-ISSUE-PLUS）：服务端创建时固定落「待规划」，这里只展示，不可改 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">状态</span>
          <span
            data-testid="new-issue-status"
            className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
          >
            待规划
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">新建任务固定进入待规划</span>
        </div>

        {mode === 'smart' ? smartPanel : (
          <>
            {draft !== null && (
              <p data-testid="draft-status" role="status" className="text-xs text-blue-700 dark:text-blue-300">
                以下为智能生成的草稿，可直接编辑；确认无误后点「创建任务」才真正落库。
              </p>
            )}
            {warningsBlock}
            {fieldBlock}
          </>
        )}

        {/* 图片草稿：粘贴 / 拖拽两入口共用同一上传与预览流程（SMART-CREATE-IMG：去掉「添加图片」按钮，
            图片以 tag/附件条呈现，可逐条删除） */}
        <div
          data-testid="new-issue-dropzone"
          aria-label="新建任务图片草稿"
          className="space-y-2 rounded-lg border border-hairline bg-surface-card p-2"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <p className="text-xs text-ink-3">
            在需求框粘贴或拖入图片（PNG / JPEG / WebP，单张 ≤ {fileSize(MAX_IMAGE_BYTES)}，最多 {MAX_DRAFT_IMAGES} 张）
          </p>

          {images.length > 0 && (
            <ul aria-label="待创建任务的图片" data-testid="new-issue-image-tags" className="flex flex-wrap items-center gap-1.5">
              {images.map((item) => (
                <li
                  key={item.localId}
                  data-testid={`new-issue-image-${item.localId}`}
                  title={`${item.file.name} · ${fileSize(item.file.size)}`}
                  className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                    item.status === 'error' ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300' : 'border-hairline bg-surface-raised text-ink-2'
                  }`}
                >
                  <span aria-hidden className="text-[10px] text-ink-3">{item.mimeType === 'image/png' ? 'PNG' : item.mimeType === 'image/webp' ? 'WebP' : 'JPEG'}</span>
                  <span className="max-w-[12rem] truncate">{item.file.name}</span>
                  <span className="text-ink-3" data-testid={`new-issue-image-status-${item.localId}`}>
                    {item.status === 'uploading' ? '上传中…' : item.status === 'ready' ? '已上传' : '上传失败'}
                  </span>
                  {item.status === 'error' && (
                    <button
                      type="button"
                      aria-label={`重试上传 ${item.file.name}`}
                      onClick={() => uploadImage(item)}
                      className="underline"
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`new-issue-image-remove-${item.localId}`}
                    aria-label={`移除图片 ${item.file.name}`}
                    disabled={item.status === 'uploading'}
                    onClick={() => removeImage(item)}
                    className="rounded px-1 leading-none text-ink-3 hover:bg-surface-card hover:text-ink disabled:opacity-40"
                  >
                    ×
                  </button>
                  {item.error && (
                    <span role="alert" className="text-[11px]">{item.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {smartMessage !== null && (
          <p
            data-testid="smart-message"
            role={showingDraft ? 'status' : 'alert'}
            className={`text-sm ${showingDraft || smartMessage.startsWith('已取消') ? 'text-neutral-600 dark:text-neutral-300' : 'text-red-600 dark:text-red-400'}`}
          >
            {smartMessage}
          </p>
        )}
        {error !== null && (
          <p role="alert" data-testid="new-issue-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          {/* 底部切换：手动 / 智能，切换不丢已填内容（manual 字段与智能面板状态各自独立保存） */}
          <div className="flex items-center gap-1" role="tablist" aria-label="创建方式">
            <button
              type="button"
              role="tab"
              data-testid="mode-manual"
              aria-selected={mode === 'manual'}
              onClick={() => setMode('manual')}
              className={`rounded px-2 py-1 text-xs ${mode === 'manual' ? 'bg-blue-100 font-medium text-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}
            >
              手动创建
            </button>
            <button
              type="button"
              role="tab"
              data-testid="mode-smart"
              aria-selected={mode === 'smart'}
              onClick={() => setMode('smart')}
              className={`rounded px-2 py-1 text-xs ${mode === 'smart' ? 'bg-blue-100 font-medium text-blue-800 dark:bg-blue-950/40 dark:text-blue-200' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}
            >
              智能创建
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              取消
            </button>
            {mode === 'smart' && generating && (
              <button
                type="button"
                data-testid="smart-cancel"
                onClick={cancelGenerate}
                className="rounded border border-amber-400 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950/40"
              >
                取消生成
              </button>
            )}
            {mode === 'smart' && !generating && (
              <button
                type="button"
                data-testid="smart-generate"
                onClick={() => void generate()}
                disabled={requirement.trim() === '' || adapterUnavailable}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                生成草稿
              </button>
            )}
            {mode === 'manual' && (
              <button
                type="submit"
                data-testid="new-issue-submit"
                disabled={!canSubmit}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {draft !== null ? '创建任务' : '创建'}
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
