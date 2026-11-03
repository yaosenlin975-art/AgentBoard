import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { KnowledgePage, KnowledgeRevision } from '@agentboard/shared';
import { api } from '../../api/client';
import { MarkdownView } from '../../lib/markdown';
import { Badge, type BadgeTone } from '../ui/Badge';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { downloadKnowledgeMarkdown } from '../../lib/knowledgeExport';
import {
  CATEGORY_STYLES,
  normalizeCategory,
  normalizeLanded,
  type KnowledgeCategory,
  type KnowledgeLanded,
} from '../../lib/knowledgeGraph';
import { KnowledgePrintView } from './KnowledgePrintView';

const STATUS_LABEL: Record<string, string> = { active: '有效', archived: '归档', deleted: '已删除' };
const STATUS_TONE: Record<string, BadgeTone> = { active: 'green', archived: 'neutral', deleted: 'red' };
/** KB-MODEL：五类固定 tone（缺失 → legacy 灰，不报错） */
const CATEGORY_TONE: Record<KnowledgeCategory, BadgeTone> = {
  design: 'blue',
  solved: 'green',
  pinned: 'purple',
  open: 'red',
  legacy: 'gray',
};
const LANDED_LABEL: Record<KnowledgeLanded, string> = { landed: '已落地', partial: '部分落地', proposed: '未落地' };

function Provenance({ sources, evidence }: Pick<KnowledgePage, 'sources' | 'evidence'>) {
  return <>
    <ul className="space-y-2 text-sm">{sources.map(s => <li key={s.source_id} className="rounded-md bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800/60">
      <code className="break-all text-xs text-neutral-800 dark:text-neutral-200">{s.locator}</code>
      <div className="mt-0.5 break-all text-xs text-neutral-500 dark:text-neutral-400">SHA-256 {s.content_hash} · {new Date(s.captured_at).toLocaleString()}</div>
      {s.snapshot && <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-neutral-300 pl-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">{s.snapshot}</blockquote>}
    </li>)}</ul>
    {evidence.length > 0 && <ul className="mt-2 space-y-2 text-sm">{evidence.map((e, i) => <li key={i} className="rounded-md bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800/60">
      <code className="break-all text-xs text-neutral-800 dark:text-neutral-200">{e.locator}</code>
      {e.snapshot && <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-neutral-300 pl-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">{e.snapshot}</blockquote>}
    </li>)}</ul>}
  </>;
}

export function KnowledgePageDetail({ pageId, scope, workspaceId, onChanged }: { pageId: string; scope: 'workspace' | 'common'; workspaceId: string | null; onChanged: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | 'delete' | null>(null);
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const scopeData = { scope, ...(scope === 'workspace' ? { workspace_id: workspaceId! } : {}) };
  const query = new URLSearchParams(scopeData).toString();
  const path = `/api/knowledge/pages/${encodeURIComponent(pageId)}`;
  const page = useQuery({ queryKey: ['knowledge-page', pageId, scope, workspaceId], queryFn: () => api.get<KnowledgePage>(`${path}?${query}`) });
  const history = useQuery({ queryKey: ['knowledge-history', pageId, scope, workspaceId, historyOffset, page.data?.revision], enabled: historyOpen,
    queryFn: () => api.get<{ items: KnowledgeRevision[]; next_offset: number | null }>(`${path}/revisions?${query}&offset=${historyOffset}&limit=20`) });
  const action = useMutation({ mutationFn: async (kind: 'archive' | 'restore' | 'delete') => api.post<KnowledgePage>(`${path}/actions`, { ...scopeData, action: kind, expected_revision: page.data!.revision, actor: 'user' }),
    onSuccess: () => { setConfirm(null); void page.refetch(); onChanged(); }, onError: () => { setConfirm(null); void page.refetch(); } });
  const expiry = useMutation({ mutationFn: (expiresAt: number | null) => api.put<KnowledgePage>(path, { ...scopeData, expires_at: expiresAt, expected_revision: page.data!.revision, actor: 'user' }),
    onSuccess: () => { setExpiryDraft(null); void page.refetch(); onChanged(); }, onError: () => { void page.refetch(); } });
  if (page.isPending) return <p className="min-w-0 flex-1 px-1 py-3 text-sm text-neutral-500 dark:text-neutral-400">加载详情…</p>;
  if (page.isError) return <p role="alert" className="min-w-0 flex-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{page.error.message}</p>;
  const p = page.data;
  const labels = { archive: '归档', restore: '恢复', delete: '软删除' };
  const isExpired = p.expires_at !== null && p.expires_at !== undefined && p.expires_at <= Date.now();
  return <article aria-label="知识详情" className="min-w-0 flex-1 overflow-auto rounded-lg border border-neutral-200 bg-white p-4 text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
    <header>
      <h2 className="text-base font-semibold leading-snug">{p.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={scope === 'common' ? 'neutral' : 'blue'}>{scope === 'common' ? '公共经验' : '项目知识'}</Badge>
        <Badge tone="neutral">v{p.revision}</Badge>
        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
        <Badge tone={CATEGORY_TONE[normalizeCategory((p as { category?: unknown }).category)]}>
          {CATEGORY_STYLES[normalizeCategory((p as { category?: unknown }).category)].label}
        </Badge>
        {(() => {
          const landed = normalizeLanded((p as { landed?: unknown }).landed);
          return landed === null ? null : <Badge tone={landed === 'landed' ? 'green' : landed === 'partial' ? 'blue' : 'neutral'}>{LANDED_LABEL[landed]}</Badge>;
        })()}
        {p.expires_at !== null && p.expires_at !== undefined && <Badge tone={isExpired ? 'red' : 'neutral'}>{isExpired ? '已过期 ' : '有效期 '}{new Date(p.expires_at).toLocaleDateString()}</Badge>}
      </div>
    </header>

    <div className="mt-3 max-w-[70ch] text-sm text-neutral-800 dark:text-neutral-200">
      <MarkdownView>{p.body_md}</MarkdownView>
    </div>

    <details data-testid="provenance" className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
        来源与证据（{p.sources.length + p.evidence.length} 条）
      </summary>
      <div className="px-2.5 pb-2.5">
        <Provenance sources={p.sources} evidence={p.evidence} />
      </div>
    </details>

    <div className="my-3 flex flex-wrap items-center gap-2">
      {p.status === 'active' && <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm('archive')}>归档</button>}
      {p.status === 'archived' && <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm('restore')}>恢复</button>}
      {p.status !== 'deleted' && <button type="button" className={BUTTON_DANGER} onClick={() => setConfirm('delete')}>软删除</button>}
      <button type="button" className={BUTTON_SECONDARY} onClick={() => setHistoryOpen(!historyOpen)}>版本历史</button>
      <button
        type="button"
        data-testid="export-markdown"
        className={BUTTON_SECONDARY}
        onClick={() => downloadKnowledgeMarkdown(p)}
      >
        导出 Markdown
      </button>
      <button type="button" data-testid="export-pdf" className={BUTTON_SECONDARY} onClick={() => setPrinting(true)}>
        导出 PDF
      </button>
    </div>

    {/* 打印视图（只读快照，复用同一 MarkdownView；仅打印期间挂载、@media print 可见） */}
    <KnowledgePrintView
      page={p}
      open={printing}
      onAfterPrint={() => setPrinting(false)}
      renderBody={(md) => <MarkdownView>{md}</MarkdownView>}
    />

    {confirm && <div className="rounded-md border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-800 dark:bg-neutral-800/60">
      <p className="text-sm text-neutral-800 dark:text-neutral-200">确认{labels[confirm]}此{scope === 'common' ? '公共' : '项目'}知识？历史仍保留。</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON_SECONDARY} disabled={action.isPending} onClick={() => action.mutate(confirm)}>确认{labels[confirm]}</button>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm(null)}>取消</button>
      </div>
    </div>}
    {action.isError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{action.error.message}</p>}

    {p.status !== 'deleted' && <div className="my-3 flex flex-wrap items-end gap-2 text-xs text-neutral-600 dark:text-neutral-300">
      <label>有效期（本机时间，留空清除）
        <input aria-label="知识有效期" type="datetime-local" className={`${FIELD_CLASS} mt-1 block`} value={expiryDraft ?? (p.expires_at ? new Date(p.expires_at - new Date(p.expires_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')} onChange={e => setExpiryDraft(e.target.value)} />
      </label>
      <button type="button" className={BUTTON_PRIMARY} disabled={expiry.isPending || expiryDraft === null} onClick={() => expiry.mutate(expiryDraft ? new Date(expiryDraft).getTime() : null)}>保存有效期</button>
    </div>}
    {expiry.isError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{expiry.error.message}</p>}

    {historyOpen && <section aria-label="版本历史" className="mt-2 space-y-2">
      {history.isPending && <p className="text-sm text-neutral-500 dark:text-neutral-400">读取历史…</p>}
      {history.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{history.error.message}</p>}
      {history.data?.items.map(r => <details key={r.revision} open className="rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
        <summary className="cursor-pointer text-xs font-medium text-neutral-700 dark:text-neutral-300">v{r.revision} · {r.title_snapshot} · {r.change_kind}</summary>
        <div className="mt-1 max-w-[70ch]"><MarkdownView>{r.body_snapshot}</MarkdownView></div>
        <h4 className="mt-2 text-xs font-semibold text-neutral-700 dark:text-neutral-300">此版本来源与证据</h4>
        <Provenance sources={r.sources} evidence={r.evidence} />
      </details>)}
      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON_SECONDARY} disabled={!historyOffset} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>历史上一页</button>
        <button type="button" className={BUTTON_SECONDARY} disabled={history.data?.next_offset == null} onClick={() => setHistoryOffset(history.data?.next_offset ?? historyOffset)}>历史下一页</button>
      </div>
    </section>}
  </article>;
}
