import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../../api/client';
import { Badge, type BadgeTone } from '../ui/Badge';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { KnowledgePageDetail } from './KnowledgePageDetail';
import { KnowledgeGraph } from './KnowledgeGraph';
import { ViewSwitcher, type BoardLayout } from '../ui/ViewSwitcher';

type PageItem = Pick<KnowledgePage, 'id' | 'scope' | 'workspace_id' | 'title' | 'revision' | 'status' | 'expires_at'>;
interface SearchItem extends PageItem { page_id: string; snippet: string }

const STATUS_LABEL: Record<string, string> = { active: '有效', archived: '归档', deleted: '已删除' };
const STATUS_TONE: Record<string, BadgeTone> = { active: 'green', archived: 'neutral', deleted: 'red' };

export function KnowledgePanel({
  workspaceId,
  layout,
  onLayout,
  onToggleKnowledge,
}: {
  workspaceId: string | null;
  layout?: BoardLayout;
  onLayout?: (layout: BoardLayout) => void;
  onToggleKnowledge?: () => void;
}) {
  const [internalLayout, setInternalLayout] = useState<BoardLayout>(layout ?? 'board');
  const currentLayout: BoardLayout = layout ?? internalLayout;
  const changeLayout = (next: BoardLayout): void => {
    setInternalLayout(next);
    onLayout?.(next);
  };
  const [scope, setScope] = useState<'both' | 'workspace' | 'common'>(workspaceId ? 'both' : 'common');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [expired, setExpired] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<PageItem | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');
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

  return <section aria-label="共享知识库" className="flex h-full min-h-0 flex-col bg-neutral-50 p-4 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <header className="mb-3 shrink-0">
      {/* 知识库视图也保留视图切换，否则切进来后没有返回任务板的入口（TOPBAR-CLEAN） */}
      <div data-testid="knowledge-toolbar-controls" className="mb-2 flex flex-wrap items-center gap-1 border-b border-neutral-200 pb-2 dark:border-neutral-800">
        <ViewSwitcher
          layout={currentLayout}
          onLayout={changeLayout}
          knowledgeOpen
          onToggleKnowledge={onToggleKnowledge ?? (() => undefined)}
        />
      </div>
      <h1 className="text-base font-semibold">共享知识库</h1>
      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">当前项目与公共经验：标题、正文与标签都可搜索</p>
      <div className="mt-2 flex shrink-0 items-center gap-1.5 text-xs" role="tablist" aria-label="知识视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'list'}
          data-testid="knowledge-view-list"
          onClick={() => setView('list')}
          className={`rounded px-2 py-0.5 ${view === 'list' ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}
        >
          列表
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'graph'}
          data-testid="knowledge-view-graph"
          onClick={() => setView('graph')}
          className={`rounded px-2 py-0.5 ${view === 'graph' ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}
        >
          星图
        </button>
      </div>
    </header>

    <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); setOffset(0); setSelected(null); }}>
      <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300">范围
        <select aria-label="知识范围" value={scope} onChange={e => { setScope(e.target.value as 'both' | 'workspace' | 'common'); setOffset(0); setSelected(null); }} className={FIELD_CLASS}>
          <option value="both" disabled={!workspaceId}>当前项目＋公共</option><option value="workspace" disabled={!workspaceId}>当前项目</option><option value="common">公共经验</option>
        </select>
      </label>
      <input aria-label="搜索知识" value={draft} onChange={e => setDraft(e.target.value)} maxLength={500} placeholder="搜索知识" className={`${FIELD_CLASS} min-w-24 flex-1`} />
      <button className={BUTTON_PRIMARY} type="submit">搜索</button>
      {query && <button type="button" className={BUTTON_SECONDARY} onClick={() => { setQuery(''); setDraft(''); }}>清除搜索</button>}
    </form>

    {!query && <div className="mt-2 flex shrink-0 flex-wrap items-center gap-3 text-xs text-neutral-600 dark:text-neutral-300">
      <label className="flex items-center gap-1">状态
        <select aria-label="知识状态" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setSelected(null); }} className={FIELD_CLASS}>
          <option value="active">有效</option><option value="archived">归档</option><option value="deleted">已删除</option><option value="all">全部</option>
        </select>
      </label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={expired} onChange={e => { setExpired(e.target.checked); setOffset(0); }} className="size-3.5 accent-blue-600" /> 包含过期</label>
    </div>}

    {list.isError && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{list.error.message}</p>}

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
        {list.isPending && <ul data-testid="knowledge-skeleton" aria-hidden className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
          {[0, 1, 2].map(i => <li key={i} className="animate-pulse px-3 py-3">
            <div className="h-3.5 w-2/3 rounded bg-neutral-200 dark:bg-neutral-800" />
            <div className="mt-2 h-3 w-full rounded bg-neutral-100 dark:bg-neutral-800/70" />
            <div className="mt-2 h-3 w-1/3 rounded bg-neutral-100 dark:bg-neutral-800/70" />
          </li>)}
        </ul>}
        {list.isPending && <p className="sr-only">加载中…</p>}

        {!list.isPending && !list.isError && items.length === 0 && <div data-testid="knowledge-empty" className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center dark:border-neutral-700">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{query ? '没有匹配的知识' : '暂无知识'}</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{query ? '换个关键词，或清除搜索后重新浏览' : '调整范围或状态后再试'}</p>
        </div>}

        {items.length > 0 && <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
          {items.map(page => {
            const isSelected = selected?.id === page.id && selected?.scope === page.scope;
            const isExpired = page.expires_at !== null && page.expires_at !== undefined && page.expires_at <= Date.now();
            return <li key={page.id} data-testid={`knowledge-item-${page.id}`} className={`relative px-3 py-2.5 transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'}`}>
              {isSelected && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-blue-500" />}
              <button type="button" aria-current={isSelected ? 'true' : undefined} className="block w-full text-left" onClick={() => setSelected(page)}>
                <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{page.title}</span>
                {page.snippet && <span className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-400">{page.snippet}</span>}
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone={page.scope === 'common' ? 'neutral' : 'blue'}>{page.scope === 'common' ? '公共' : '项目'}</Badge>
                  <Badge tone="neutral">v{page.revision}</Badge>
                  <Badge tone={STATUS_TONE[page.status] ?? 'neutral'}>{STATUS_LABEL[page.status] ?? page.status}</Badge>
                  {isExpired && <Badge tone="red">已过期</Badge>}
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
    </div>
  </section>;
}


