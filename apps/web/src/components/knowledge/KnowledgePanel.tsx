import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  CATEGORY_STYLES,
  normalizeCategory,
  normalizeLanded,
  type KnowledgeCategory,
  type KnowledgeLanded,
} from '../../lib/knowledgeGraph';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { KnowledgePageDetail } from './KnowledgePageDetail';
import { KnowledgeGraph, prefetchGraphChunk } from './KnowledgeGraph';
import { ViewToolbarShell } from '../ui/ViewToolbarShell';
import { Kbd } from '../ui/Kbd';
import { KnowledgeImportDialog } from './KnowledgeImportDialog';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { persistKnowledgeScope, resolveKnowledgeScope, type KnowledgeScope } from '../../lib/knowledgeScope';

type PageItem = Pick<KnowledgePage, 'id' | 'scope' | 'workspace_id' | 'title' | 'revision' | 'status' | 'expires_at'>;
interface SearchItem extends PageItem { page_id: string; snippet: string }

const STATUS_LABEL: Record<string, string> = { active: '有效', archived: '归档', deleted: '已删除' };
const LANDED_LABEL: Record<KnowledgeLanded, string> = { landed: '已落地', partial: '部分落地', proposed: '未落地' };
const CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  design: CATEGORY_STYLES.design.label,
  solved: CATEGORY_STYLES.solved.label,
  pinned: CATEGORY_STYLES.pinned.label,
  open: CATEGORY_STYLES.open.label,
  legacy: CATEGORY_STYLES.legacy.label,
};

export function KnowledgePanel({
  workspaceId,
  workspaceName = null,
  deepLinkPageId = null,
}: {
  workspaceId: string | null;
  /** 当前工作区名称，仅用于空态说明「当前范围是项目 X」 */
  workspaceName?: string | null;
  /** BORROW-3.2：深链目标页引用（/k/:id/:slug 与 ?kb=<id> 解析产物），挂载后 resolve 定位一次 */
  deepLinkPageId?: string | null;
}) {
  // KB-SCOPE-DEFAULT：默认落在当前项目；用户显式切范围后由 persistKnowledgeScope 记住
  const [scope, setScope] = useState<KnowledgeScope>(() => resolveKnowledgeScope(workspaceId !== null));
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [expired, setExpired] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<PageItem | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');
  // KBIMP-2：导入对话框开关 + 刚导入页高亮（成功后刷新列表并把新建页标出来）
  const [importOpen, setImportOpen] = useState(false);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const params = new URLSearchParams({ scope, ...(scope !== 'common' && workspaceId ? { workspace_id: workspaceId } : {}) });
  const list = useQuery({
    queryKey: ['knowledge', workspaceId, scope, query, status, expired, offset],
    queryFn: async () => {
      if (query) {
        params.set('q', query); params.set('limit', '20');
        const rows = await api.get<SearchItem[]>(`/api/knowledge/search?${params}`);
        return { items: rows.map(r => ({ ...r, id: r.page_id })), next_offset: null };
      }
      params.set('status', status); params.set('include_expired', String(expired)); params.set('limit', '20'); params.set('offset', String(offset));
      return api.get<{ items: Array<PageItem & { snippet?: string }>; next_offset: number | null }>(`/api/knowledge/pages?${params}`);
    },
  });
  const items = list.data?.items ?? [];

  // BORROW-3.2：深链定位——resolve 拿 scope/workspace 后选中详情；失败原因显式呈现
  // （403 文案由服务端保证不含标题）。同一引用只消费一次，避免列表交互中被重复拉起。
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [deepLinkConsumed, setDeepLinkConsumed] = useState<string | null>(null);
  useEffect(() => {
    if (deepLinkPageId === null || deepLinkConsumed === deepLinkPageId) return;
    setDeepLinkConsumed(deepLinkPageId);
    void (async () => {
      const resolveParams = new URLSearchParams({ ref: deepLinkPageId, scope: workspaceId !== null ? 'both' : 'common' });
      if (workspaceId !== null) resolveParams.set('workspace_id', workspaceId);
      try {
        const res = await api.get<{ id: string; scope: 'common' | 'workspace'; workspace_id: string | null; title: string; revision: number; status: 'active' | 'archived' | 'deleted' }>(`/api/knowledge/resolve?${resolveParams}`);
        // 深链只取定位三要素（id/scope/workspace_id）；expires_at 详情层不消费，置 null
        setSelected({ id: res.id, scope: res.scope, workspace_id: res.workspace_id, title: res.title, revision: res.revision, status: res.status, expires_at: null });
        setDeepLinkError(null);
      } catch (error) {
        setDeepLinkError(error instanceof Error ? error.message : '深链打开失败');
      }
    })();
  }, [deepLinkPageId, workspaceId, deepLinkConsumed]);

  return <section aria-label="共享知识库" className="flex h-full min-h-0 flex-col bg-surface-page text-ink">
    {/* TOOLBAR-BLANK：FIX-2 删掉 ViewSwitcher 后壳内已无控件，空壳会渲染约 40px 空白带 →
        这里不再挂 ViewToolbarShell（它在无可见内容时会自己返回 null），
        knowledge-toolbar-controls 锚点迁到内容区顶部，测试仍可按 testid 定位。 */}
    <span data-testid="knowledge-toolbar-controls" aria-hidden="true" className="sr-only" />
    <div className="flex min-h-0 flex-1 flex-col p-4">
    <header className="mb-2 flex shrink-0 items-center gap-1.5 text-xs" role="tablist" aria-label="知识视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'list'}
          data-testid="knowledge-view-list"
          onClick={() => setView('list')}
          className={`rounded px-2 py-0.5 ${view === 'list' ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 transition-colors hover:bg-accent-soft'}`}
        >
          列表
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'graph'}
          data-testid="knowledge-view-graph"
          // GRAPH-PERF：悬停/聚焦即预取 PIXI chunk，切 tab 时省掉下载+解析
          onMouseEnter={() => prefetchGraphChunk()}
          onFocus={() => prefetchGraphChunk()}
          onClick={() => setView('graph')}
          className={`rounded px-2 py-0.5 ${view === 'graph' ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 transition-colors hover:bg-accent-soft'}`}
        >
          星图
        </button>
    </header>

    <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); setOffset(0); setSelected(null); }}>
      <label className="flex items-center gap-1 text-xs text-ink-2">范围
        <select aria-label="知识范围" value={scope} onChange={e => { const next = e.target.value as KnowledgeScope; setScope(next); persistKnowledgeScope(next); setOffset(0); setSelected(null); }} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
          <option value="both" disabled={!workspaceId}>当前项目＋公共</option><option value="workspace" disabled={!workspaceId}>当前项目</option><option value="common">公共经验</option>
        </select>
      </label>
      <input aria-label="搜索知识" value={draft} onChange={e => setDraft(e.target.value)} maxLength={500} placeholder="搜索知识" className={"h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent min-w-24 flex-1"} />
      <button className="inline-flex h-8 shrink-0 items-center rounded-lg border border-accent bg-accent-soft px-3 text-xs font-medium text-accent transition-colors hover:bg-accent-soft/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" type="submit">搜索</button>
      {/* UNSLOP-5：表单内回车即提交（真实快捷键），用键帽呈现 */}
      <span data-testid="knowledge-search-hint" className="hidden items-center gap-1 text-xs text-ink-3 sm:inline-flex">
        <Kbd>Enter</Kbd>
        <span>搜索</span>
      </span>
      {/* KBIMP-2：导入入口（md/txt/json；json 数组逐条可取消） */}
      <button type="button" data-testid="knowledge-import-open" className={BUTTON_SECONDARY} onClick={() => setImportOpen(true)}>添加</button>
      {query && <button type="button" className={BUTTON_SECONDARY} onClick={() => { setQuery(''); setDraft(''); }}>清除搜索</button>}
      {!query && <label className="flex items-center gap-1 text-xs text-ink-2">状态
        <select aria-label="知识状态" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setSelected(null); }} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
          <option value="active">有效</option><option value="archived">归档</option><option value="deleted">已删除</option><option value="all">全部</option>
        </select>
      </label>}
      {!query && <label className="flex h-8 shrink-0 items-center gap-1 text-xs text-ink-2"><input type="checkbox" checked={expired} onChange={e => { setExpired(e.target.checked); setOffset(0); }} className="size-3.5 accent-[var(--ab-accent)]" /> 包含过期</label>}
    </form>

    {list.isError && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{list.error.message}</p>}
    {deepLinkError && <p role="alert" data-testid="knowledge-deeplink-error" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{deepLinkError}</p>}

    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-auto lg:flex-row">
      {view === 'graph' ? (
        <div className="min-w-0 flex-1">
          <KnowledgeGraph
            workspaceId={workspaceId}
            scope={scope}
            onSelect={(page) => setSelected({ ...page })}
          />
        </div>
      ) : (
      <div className="min-w-0 lg:w-80 lg:flex-none">
        {/* UNSLOP-5 定性：animate-pulse 只用于「真实加载中」的骨架屏（list.isPending），数据到位即卸载；画法统一走 Skeleton 基元 */}
        {list.isPending && <Skeleton testId="knowledge-skeleton" rows={3} />}
        {list.isPending && <p className="sr-only">加载中…</p>}

        {!list.isPending && !list.isError && items.length === 0 && (
          query
            ? <EmptyState testId="knowledge-empty" title="没有匹配的知识" hint="换个关键词，或清除搜索后重新浏览" />
            : scope === 'workspace'
              // KB-SCOPE-DEFAULT：空态要说清「当前范围是项目 X」，别让用户以为库里没东西
              ? <EmptyState testId="knowledge-empty" title="暂无知识" hint={`当前范围是项目「${workspaceName ?? '当前工作区'}」，可切到「当前项目＋公共」查看全部`} />
              : workspaceId === null
                // 未选工作区时退化到公共经验，明确告知而不是静默变空
                ? <EmptyState testId="knowledge-empty" title="暂无知识" hint="未选择工作区，已退化为「公共经验」；选择工作区后可查看项目知识" />
                : <EmptyState testId="knowledge-empty" title="暂无知识" hint="调整范围或状态后再试" />
        )}

        {items.length > 0 && <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface-card">
          {items.map(page => {
            const isSelected = selected?.id === page.id && selected?.scope === page.scope;
            const isExpired = page.expires_at !== null && page.expires_at !== undefined && page.expires_at <= Date.now();
            const category = normalizeCategory((page as { category?: unknown }).category);
            const landed = normalizeLanded((page as { landed?: unknown }).landed);
            return <li key={page.id} data-testid={`knowledge-item-${page.id}`} className={`relative px-3 py-2.5 transition-colors ${isSelected ? 'bg-accent-soft' : 'hover:bg-surface-raised'}`}>
              {isSelected && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
              <button type="button" aria-current={isSelected ? 'true' : undefined} className="block w-full text-left" onClick={() => setSelected(page)}>
                <span className="block truncate text-sm font-medium text-ink">{page.title}</span>
                {page.snippet && <span className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-ink-3">{page.snippet}</span>}
                {/* UNSLOP-4：每行只有一种字号、一种元信息色；类别是唯一有颜色的信息（小圆点），其余用「·」分隔的静默文本 */}
                <span data-testid="knowledge-meta" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: `var(${CATEGORY_STYLES[category].cssVar})` }} />
                  <span className="text-ink-2">{CATEGORY_LABEL[category]}</span>
                  <span aria-hidden>·</span>
                  <span>{page.scope === 'common' ? '公共' : '项目'}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">v{page.revision}</span>
                  <span aria-hidden>·</span>
                  <span>{STATUS_LABEL[page.status] ?? page.status}</span>
                  {landed !== null && <><span aria-hidden>·</span><span>{LANDED_LABEL[landed]}</span></>}
                  {isExpired && <><span aria-hidden>·</span><span>已过期</span></>}
                </span>
              </button>
            </li>;
          })}
        </ul>}

        {!query && items.length > 0 && <div className="mt-3 flex items-center gap-2">
          <button type="button" className={BUTTON_SECONDARY} disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setSelected(null); }}>上一页</button>
          <button type="button" className={BUTTON_SECONDARY} disabled={list.data?.next_offset == null} onClick={() => { setOffset(list.data?.next_offset ?? offset); setSelected(null); }}>下一页</button>
        </div>}
      </div>
      )}

      {selected && <KnowledgePageDetail key={`${selected.scope}:${selected.id}`} pageId={selected.id} scope={selected.scope} workspaceId={selected.workspace_id} onChanged={() => void list.refetch()} />}
      <KnowledgeImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(ids) => {
          // KBIMP-2B：不在这里关窗——部分失败时用户要看逐条状态，关闭由对话框自己决定
          setHighlightIds(ids);
          void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
        }}
      />
      {highlightIds.length > 0 && (
        <p data-testid="knowledge-import-result" className="mt-2 rounded-md border border-hairline bg-accent-soft px-2 py-1 text-xs text-accent">
          已导入 {highlightIds.length} 页：<span className="font-mono">{highlightIds.join(', ')}</span>
        </p>
      )}
    </div>
    </div>
  </section>;
}



