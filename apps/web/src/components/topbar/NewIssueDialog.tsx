/**
 * 新建 issue 弹窗（§7.6 + NEW-ISSUE-IMAGE）：标题 / 描述 / 优先级 / 标签 / 图片草稿 → POST /api/issues。
 * 图片三条入口（选择、拖拽、粘贴）共用同一 pending 上传与预览流程；提交只传 `attachment_ids`，
 * 不把 base64 写进描述；创建失败保留全部草稿（含已上传图片）可重试，重试复用同一幂等键只建一个任务。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Issue, Priority } from '@agentboard/shared';
import { api, type AttachmentUploadResult } from '../../api/client';
import { MAX_DRAFT_IMAGES, MAX_IMAGE_BYTES, collectDraftImages, filesFromClipboard, filesFromDataTransfer, type ImageMimeType } from '../../lib/imageDraft';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

interface PendingImage {
  localId: number;
  file: File;
  mimeType: ImageMimeType;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  error?: string;
}

function fileSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextLocalId = useRef(0);
  const imagesRef = useRef<PendingImage[]>([]);
  imagesRef.current = images;
  // 同一份草稿的重试复用同一幂等键；成功后换新键，避免下一次新建被当成重放
  const draftKeyRef = useRef<string>(crypto.randomUUID());

  const revokeAll = (items: PendingImage[]): void => {
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
  };

  const clearImages = (): void => {
    revokeAll(imagesRef.current);
    imagesRef.current = [];
    setImages([]);
  };

  useEffect(() => () => revokeAll(imagesRef.current), []);

  // 关闭或切换 workspace：图片草稿属于旧 workspace，立即丢弃（不发删除请求，staged 附件按 TTL 过期）
  useEffect(() => {
    clearImages();
    setError(null);
    draftKeyRef.current = crypto.randomUUID();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, open]);

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
        previewUrl: URL.createObjectURL(file),
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
    URL.revokeObjectURL(item.previewUrl);
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
      clearImages();
      draftKeyRef.current = crypto.randomUUID();
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

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

  return (
    <Modal open={open} title="新建 issue" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" data-testid="new-issue-form" onPaste={onPaste}>
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

        {/* 图片草稿：选择 / 拖拽 / 粘贴三入口共用同一上传与预览流程 */}
        <div
          data-testid="new-issue-dropzone"
          aria-label="新建任务图片草稿"
          className="space-y-2 rounded border border-dashed border-neutral-300 p-2 dark:border-neutral-700"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              data-testid="new-issue-image-input"
              aria-label="选择图片"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                if (event.currentTarget.files) addFiles(Array.from(event.currentTarget.files));
                event.currentTarget.value = '';
              }}
            />
            <button
              type="button"
              data-testid="new-issue-image-picker"
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-neutral-300 px-2.5 py-1.5 text-xs dark:border-neutral-700"
            >
              添加图片
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              支持 PNG、JPEG、WebP；单张不超过 10 MiB，最多 {MAX_DRAFT_IMAGES} 张（单张上限 {fileSize(MAX_IMAGE_BYTES)}）。也可拖入或粘贴。
            </span>
          </div>

          {images.length > 0 && (
            <ul aria-label="待创建任务的图片" className="flex flex-wrap gap-3">
              {images.map((item) => (
                <li
                  key={item.localId}
                  data-testid={`new-issue-image-${item.localId}`}
                  className="w-28 max-w-full rounded border border-neutral-200 p-2 dark:border-neutral-700"
                >
                  <img src={item.previewUrl} alt={item.file.name} className="h-20 w-full rounded object-cover" />
                  <p className="mt-1 truncate text-xs" title={item.file.name}>{item.file.name}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {item.status === 'uploading' ? '上传中…' : item.status === 'ready' ? '已上传' : '上传失败'}
                  </p>
                  {item.error && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{item.error}</p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.status === 'error' && (
                      <button
                        type="button"
                        aria-label={`重试上传 ${item.file.name}`}
                        onClick={() => uploadImage(item)}
                        className="text-xs text-blue-700 underline dark:text-blue-300"
                      >
                        重试
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`移除图片 ${item.file.name}`}
                      disabled={item.status === 'uploading'}
                      onClick={() => removeImage(item)}
                      className="text-xs text-neutral-600 underline disabled:opacity-40 dark:text-neutral-300"
                    >
                      移除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error !== null && (
          <p role="alert" data-testid="new-issue-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="new-issue-submit"
            disabled={!canSubmit}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
