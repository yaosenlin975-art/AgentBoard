/**
 * KBIMP-2：知识库导入对话框。
 *
 * 流程：选文件或拖拽 → 本地解析预览（标题/字符数/前 20 行/识别到的 category 与 labels）
 * → 可改标题/分类/落地状态 → json 数组**逐条列出并可取消**（不允许静默批量建页）→ 确认导入。
 * 错误态：格式不支持 / >1MB / `KNOWLEDGE_EXISTS`（给「改标题」「加后缀」两条建议）/ 网络失败。
 */
import { useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import {
  IMPORT_FORMAT_LABEL,
  PREVIEW_LINES,
  importErrorView,
  parseImportFile,
  previewLines,
  rebuildContent,
  selectedDrafts,
  type ImportDraft,
  type ParsedImport,
} from '../../lib/knowledgeImport';
import { api } from '../../api/client';

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不指定分类' },
  { value: 'design', label: '设计' },
  { value: 'solved', label: '已解决' },
  { value: 'pinned', label: '用户指定' },
  { value: 'open', label: '待决/盲区' },
  { value: 'legacy', label: '旧页' },
];

const LANDED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不指定落地状态' },
  { value: 'landed', label: '已落地' },
  { value: 'partial', label: '部分落地' },
  { value: 'proposed', label: '提议中' },
];

/** KBIMP-2B：单条导入结果（成功/失败都保留，失败不静默丢弃） */
export interface ImportRowResult {
  key: string;
  title: string;
  status: 'ok' | 'failed';
  pageId: string | null;
  code: string | null;
  message: string | null;
}
export function KnowledgeImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** 导入成功后回调（调用方刷新列表并高亮新建页） */
  onImported: (pageIds: string[]) => void;
}) {
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [cancelled, setCancelled] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<{ text: string; suggestions: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('');
  const [landed, setLanded] = useState('');
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState(false);
  // KBIMP-2B：逐条导入结果（成功带页 id / 失败带 error_code 与服务端 message）
  const [results, setResults] = useState<ImportRowResult[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const activeDrafts = useMemo(
    () => (parsed === null ? [] : selectedDrafts(parsed, cancelled)),
    [parsed, cancelled],
  );

  const reset = (): void => {
    setParsed(null); setCancelled([]); setFailure(null); setErrorView(null); setTitle(''); setCategory(''); setLanded(''); setResults([]);
  };

  const readFile = async (file: File): Promise<void> => {
    reset();
    const content = await file.text();
    const result = parseImportFile(file.name, content);
    if (!result.ok) {
      setFailure(result.failure.message);
      return;
    }
    setParsed(result.value);
    setTitle(result.value.drafts[0]?.title ?? '');
  };

  /**
   * KBIMP-2B：逐条提交以获得**逐条状态**。
   * 服务端 `ImportResult` 只有 `{ pages, warnings }`，没有逐条失败信息（KBIMP-1B2 那条也归 server），
   * 所以前端按条发请求：每条的成功/失败与其错误码都能归属到自己，失败不会被静默吞掉，
   * 也不做整批回滚（服务端本来就是逐条建页）。DB-2B 之外若服务端补上 `failures[]`，只需把这里换回单请求。
   */
  const submit = async (): Promise<void> => {
    if (parsed === null || activeDrafts.length === 0) return;
    setBusy(true);
    setErrorView(null);
    setFailure(null);
    setResults([]);
    const drafts = activeDrafts.map((draft) => ({
      ...draft,
      ...(title.trim() !== '' && parsed.format !== 'json' ? { title: title.trim() } : {}),
      ...(category === '' ? {} : { category }),
      ...(landed === '' ? {} : { landed }),
    })) as ImportDraft[];

    const collected: ImportRowResult[] = [];
    for (const draft of drafts) {
      try {
        const content = rebuildContent(parsed, [draft]);
        const response = await api.post<{ pages?: Array<{ id: string }>; id?: string; warnings?: string[] }>(
          '/api/knowledge/pages/import',
          {
            scope: 'common',
            format: parsed.format,
            content,
            filename: parsed.filename,
            ...(title.trim() !== '' && parsed.format !== 'json' ? { title: title.trim() } : {}),
            ...(category === '' ? {} : { category }),
            ...(landed === '' ? {} : { landed }),
          },
        );
        const pageId = response.pages?.[0]?.id ?? response.id ?? null;
        collected.push({ key: draft.key, title: draft.title, status: 'ok', pageId, code: null, message: null });
      } catch (error) {
        collected.push({
          key: draft.key,
          title: draft.title,
          status: 'failed',
          pageId: null,
          code: (error as { code?: string }).code ?? null,
          message: error instanceof Error ? error.message : '导入失败',
        });
      }
      setResults([...collected]);
    }
    setBusy(false);

    const okIds = collected.filter((row) => row.status === 'ok' && row.pageId !== null).map((row) => row.pageId!);
    if (okIds.length > 0) onImported(okIds);
    // KBIMP-2B：全成功也不自动关闭——结果区要留给用户看逐条状态，关闭由用户点「关闭」
  };

  return (
    <Modal open={open} title="导入知识页" onClose={onClose} size="lg" scrollable>
      <div data-testid="kb-import-dialog" className="space-y-3 text-sm">
        <div
          data-testid="kb-import-drop"
          data-dragging={dragging ? 'true' : 'false'}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void readFile(file);
          }}
          className={`rounded-lg border border-dashed px-3 py-4 text-center text-xs ${dragging ? 'border-accent bg-accent-soft text-accent' : 'border-hairline text-ink-3'}`}
        >
          把 .md / .txt / .json 文件拖到这里，或
          <button type="button" data-testid="kb-import-pick" onClick={() => fileRef.current?.click()} className="ml-1 text-accent underline">选择文件</button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.json"
            data-testid="kb-import-file"
            className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }}
          />
          <p className="mt-1">单文件上限 1 MB；JSON 支持单对象或数组（≤100 条）</p>
        </div>

        {failure !== null && (
          <p role="alert" data-testid="kb-import-failure" className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {failure}
          </p>
        )}

        {parsed !== null && (
          <div className="space-y-2">
            <p data-testid="kb-import-meta" className="text-xs text-ink-3">
              {IMPORT_FORMAT_LABEL[parsed.format]} · {(parsed.bytes / 1024).toFixed(1)} KB · 识别到 {parsed.drafts.length} 页
              {cancelled.length > 0 ? `（已取消 ${cancelled.length} 页）` : ''}
            </p>

            {parsed.format === 'json' ? (
              <ul data-testid="kb-import-items" className="space-y-1">
                {parsed.drafts.map((draft) => {
                  const off = cancelled.includes(draft.key);
                  return (
                    <li key={draft.key} data-testid={`kb-import-item-${draft.key}`} data-cancelled={off ? 'true' : 'false'}
                      className={`rounded-md border px-2 py-1 text-xs ${off ? 'border-hairline text-ink-3 line-through' : 'border-hairline text-ink'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{draft.title}</span>
                        <button type="button" data-testid={`kb-import-cancel-${draft.key}`}
                          onClick={() => setCancelled((current) => off ? current.filter((key) => key !== draft.key) : [...current, draft.key])}
                          className="shrink-0 rounded border border-hairline px-1.5 py-0.5">
                          {off ? '恢复' : '取消'}
                        </button>
                      </div>
                      <p className="mt-0.5 text-ink-3">{draft.body_md.length} 字符</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="space-y-1">
                <label className="block text-xs text-ink-2">
                  标题
                  <input data-testid="kb-import-title" value={title} onChange={(event) => setTitle(event.target.value)}
                    className="mt-1 w-full rounded-md border border-hairline bg-surface-card px-2 py-1 text-xs text-ink outline-none focus:border-accent" />
                </label>
                <pre data-testid="kb-import-preview" className="max-h-40 overflow-auto rounded-md bg-surface-raised px-2 py-1 text-[11px] leading-relaxed text-ink-2">
                  {previewLines(parsed.drafts[0]?.body_md ?? '', PREVIEW_LINES).join('\n')}
                </pre>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <label className="flex items-center gap-1 text-ink-2">分类
                <select data-testid="kb-import-category" value={category} onChange={(event) => setCategory(event.target.value)}
                  className="rounded-md border border-hairline bg-surface-card px-1.5 py-0.5 text-xs text-ink">
                  {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1 text-ink-2">落地
                <select data-testid="kb-import-landed" value={landed} onChange={(event) => setLanded(event.target.value)}
                  className="rounded-md border border-hairline bg-surface-card px-1.5 py-0.5 text-xs text-ink">
                  {LANDED_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>

            {parsed.warnings.length > 0 && (
              <ul data-testid="kb-import-warnings" className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                {parsed.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}

            <div className="flex items-center gap-2">
              <button type="button" data-testid="kb-import-submit" disabled={busy || activeDrafts.length === 0} onClick={() => void submit()}
                className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink disabled:opacity-40">
                {busy ? '导入中…' : `确认导入${parsed.format === 'json' ? `（${activeDrafts.length} 页）` : ''}`}
              </button>
              <button type="button" data-testid="kb-import-reset" onClick={reset} className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink">重选文件</button>
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div data-testid="kb-import-results" data-ok={results.filter((row) => row.status === 'ok').length} data-failed={results.filter((row) => row.status === 'failed').length} className="rounded-md border border-hairline p-2 text-xs">
            <p data-testid="kb-import-summary" className="text-ink-2">
              成功 <span className="tabular-nums text-ink">{results.filter((row) => row.status === 'ok').length}</span> / 失败{' '}
              <span className={`tabular-nums ${results.some((row) => row.status === 'failed') ? 'text-accent' : 'text-ink'}`}>{results.filter((row) => row.status === 'failed').length}</span>
            </p>
            <ul className="mt-1 space-y-1">
              {results.map((row) => {
                const view = row.status === 'failed' ? importErrorView(row.code, row.message ?? '导入失败') : null;
                return (
                  <li key={row.key} data-testid={`kb-import-result-row-${row.key}`} data-status={row.status}>
                    {row.status === 'ok' ? (
                      <span className="text-ink">{row.title} <span className="text-ink-3">已建页 </span><span className="font-mono text-ink-3">{row.pageId ?? '—'}</span></span>
                    ) : (
                      <details data-testid={`kb-import-result-detail-${row.key}`} className="text-red-600 dark:text-red-400">
                        <summary className="cursor-pointer select-none">
                          {row.title} <span className="text-ink-3">失败</span>
                          {row.code !== null && <code className="ml-1 rounded bg-surface-raised px-1 font-mono text-[10px] text-ink-3">{row.code}</code>}
                        </summary>
                        <p data-testid={`kb-import-result-message-${row.key}`} className="mt-1 text-ink-2">{view?.text ?? row.message}</p>
                        {view !== null && view.suggestions.length > 0 && (
                          <ul data-testid={`kb-import-result-suggestions-${row.key}`} className="mt-1 list-disc pl-4 text-ink-3">
                            {view.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
                          </ul>
                        )}
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {errorView !== null && (
          <div role="alert" data-testid="kb-import-error" className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <p>{errorView.text}</p>
            {errorView.suggestions.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {errorView.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
