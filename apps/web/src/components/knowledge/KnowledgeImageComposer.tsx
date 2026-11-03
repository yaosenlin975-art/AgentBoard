/**
 * 知识页图片编辑区（KB-IMG-2 / design §5）：正文 textarea + 三种入口（粘贴 / 拖拽 / 按钮上传）。
 *
 * - 粘贴：监听 textarea 的 paste 事件里的 image/* 项；
 * - 拖拽：整个编辑区的 dragover/drop；
 * - 按钮：隐藏 file input。
 * 三者统一走「必要时 canvas 压缩 → POST /images → 在光标处插入 `![说明](url)`」。
 * 压缩中显示「压缩中…原始 7.2MB → 3.1MB」；压缩后仍 > 5MiB 直接中止并给中文原因。
 */
import { useRef, useState } from 'react';
import { IMAGE_MAX_BYTES, compressImage, formatBytes } from '../../lib/imageCompress';

interface UploadedImage {
  id: string;
  url: string;
  bytes: number;
  width: number;
  height: number;
}

export interface KnowledgeImageComposerProps {
  scope: 'workspace' | 'common';
  workspaceId: string | null;
  /** 目标知识页 id（上传接口按页归属） */
  pageId: string;
  value: string;
  onChange: (next: string) => void;
  /** 上传成功后回调（便于外部提示/统计） */
  onUploaded?: (image: UploadedImage) => void;
}

const ERROR_TEXT: Record<string, string> = {
  IMAGE_TOO_LARGE: '图片超过 5MB 上限，已中止（压缩后仍超限）',
  IMAGE_TYPE_UNSUPPORTED: '文件不是受支持的图片格式（支持 PNG/JPEG/WebP/GIF）',
  IMAGE_LIMIT_EXCEEDED: '本页图片数量或总量已到上限（20 张 / 50MB）',
  KNOWLEDGE_NOT_FOUND: '知识页不存在或已被删除',
};

const pickErrorCode = (message: string): string | null => {
  for (const code of Object.keys(ERROR_TEXT)) if (message.includes(code)) return code;
  return null;
};

export function KnowledgeImageComposer({ scope, workspaceId, pageId, value, onChange, onUploaded }: KnowledgeImageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 在光标处插入文本；插入后把光标放到插入内容末尾（textarea 原生 undo 可回退） */
  const insertAtCursor = (snippet: string): void => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      onChange(`${value}${snippet}`);
      return;
    }
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = start + snippet.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  const upload = async (file: File): Promise<void> => {
    setError(null);
    setBusy(true);
    const startedAt = performance.now();
    try {
      setStatus(`处理中…原始 ${formatBytes(file.size)}`);
      const result = await compressImage(file);
      const compressNote = result.skipped
        ? ''
        : `压缩中…原始 ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}`;
      if (!result.skipped) setStatus(compressNote);
      if (result.afterBytes > IMAGE_MAX_BYTES) {
        setStatus('');
        setError(ERROR_TEXT.IMAGE_TOO_LARGE ?? '图片超过上限');
        return;
      }
      const form = new FormData();
      // KB-IMG-2-VERIFY：服务端从 multipart **表单字段**读 scope/workspace_id（不是查询串），
      // 只放查询串会走 requireVisiblePage(undefined) → 404 PAGE_NOT_FOUND。
      form.append('scope', scope);
      if (scope === 'workspace' && workspaceId !== null) form.append('workspace_id', workspaceId);
      form.append('original_bytes', String(result.beforeBytes));
      form.append('file', result.blob, file.name || `image-${Date.now()}.${result.mime === 'image/png' ? 'png' : result.mime === 'image/webp' ? 'webp' : 'jpg'}`);
      // KB-IMG-2-VERIFY：api.post 会强制 `Content-Type: application/json` + JSON.stringify，
      // multipart 必须直接用 fetch（让浏览器自己带 boundary），否则服务端报「请求体必须为 multipart/form-data」。
      const response = await fetch(`/api/knowledge/pages/${encodeURIComponent(pageId)}/images`, { method: 'POST', body: form });
      const payload = (await response.json().catch(() => null)) as (UploadedImage & { error?: { code?: string; message?: string } }) | null;
      if (!response.ok || payload === null || payload.error !== undefined) {
        throw new Error(payload?.error?.code ?? payload?.error?.message ?? `HTTP ${response.status}`);
      }
      const uploaded = payload;
      const alt = (file.name || '图片').replace(/\.[^.]+$/u, '').slice(0, 60);
      insertAtCursor(`\n![${alt}](${uploaded.url})\n`);
      const elapsed = Math.round(performance.now() - startedAt);
      setStatus(
        result.skipped
          ? `已插入 ${formatBytes(uploaded.bytes)}（${uploaded.width}×${uploaded.height}，${elapsed}ms）`
          : `已插入：原始 ${formatBytes(result.beforeBytes)} → ${formatBytes(uploaded.bytes)}（${uploaded.width}×${uploaded.height}，${elapsed}ms）`,
      );
      onUploaded?.(uploaded);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = pickErrorCode(message);
      setStatus('');
      setError(code !== null ? (ERROR_TEXT[code] ?? message) : `上传失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = (files: FileList | null): void => {
    const file = files?.[0];
    if (file === undefined) return;
    if (!file.type.startsWith('image/')) {
      setError(ERROR_TEXT.IMAGE_TYPE_UNSUPPORTED ?? '不是图片');
      return;
    }
    void upload(file);
  };

  return (
    <div
      data-testid="knowledge-image-composer"
      className="rounded-md border border-neutral-200 dark:border-neutral-800"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        event.preventDefault();
        handleFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-2 py-1.5 text-xs dark:border-neutral-800">
        <button
          type="button"
          data-testid="knowledge-image-pick"
          className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          插入图片
        </button>
        <input
          ref={fileInputRef}
          data-testid="knowledge-image-input"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <span className="text-neutral-500 dark:text-neutral-400">也可直接粘贴或拖入图片</span>
        {busy && <span data-testid="knowledge-image-busy" className="text-blue-600 dark:text-blue-300">处理中…</span>}
        {status !== '' && <span data-testid="knowledge-image-status" className="text-neutral-600 dark:text-neutral-300">{status}</span>}
        {error !== null && (
          <span role="alert" data-testid="knowledge-image-error" className="text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
      <textarea
        ref={textareaRef}
        data-testid="knowledge-body-editor"
        aria-label="正文编辑"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const items = event.clipboardData.items;
          for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file !== null) {
                event.preventDefault();
                void upload(file);
                return;
              }
            }
          }
        }}
        placeholder="正文（支持 Markdown；粘贴/拖拽图片会自动压缩并插入）"
        className="h-48 w-full resize-y rounded-b-md bg-transparent px-2 py-1.5 font-mono text-xs outline-none"
      />
    </div>
  );
}
