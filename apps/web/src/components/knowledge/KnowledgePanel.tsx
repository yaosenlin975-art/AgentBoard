import { Fragment, useEffect, useMemo, useState } from 'react';
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
import { Kbd } from '../ui/Kbd';
import { KnowledgeImportDialog } from './KnowledgeImportDialog';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { persistKnowledgeScope, resolveKnowledgeScope, type KnowledgeScope } from '../../lib/knowledgeScope';
// BORROW-3.3：列表显示偏好复用看板 DisplayOptions 形状，但走独立存储键（改一个不影响另一个）
import { KNOWLEDGE_DISPLAY_KEY, readDisplayOptions, writeDisplayOptions, type DisplayOptions } from '../../lib/displayOptions';
import { KnowledgeDeepLinkHistory } from './KnowledgeDeepLinkHistory';

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
  // BORROW-3.3（D8）：深链落到已删除页（resolve 410）→ 从提示一键进入历史版本列表
  const [deepLinkHistoryOpen, setDeepLinkHistoryOpen] = useState(false);
  // BORROW-3.3（局部图 IA）：详情「在星图中查看」→ 图内聚焦该页；「返回原页」回列表详情
  const [graphFocus, setGraphFocus] = useState<{ id: string } | null>(null);
  // BORROW-3.3：知识列表显示偏好（独立键，与看板互不影响）
  const [display, setDisplay] = useState<DisplayOptions>(() => readDisplayOptions(undefined, KNOWLEDGE_DISPLAY_KEY));
  const setDisplayOptions = (next: DisplayOptions): void => {
    setDisplay(next);
    writeDisplayOptions(next, undefined, KNOWLEDGE_DISPLAY_KEY);
  };
  const deepLinkDeleted = deepLinkError !== null && deepLinkPageId !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deepLinkPageId)
    && deepLinkError.includes('已删除');
  // BORROW-3.3：列表分组（顺序扫描遇 category 变化分段，不重排——视觉顺序仍等于接口顺序）
  const grouped = useMemo(() => {
    if (display.grouping === 'none') return null;
    const groups: Array<{ category: ReturnType<typeof normalizeCategory>; items: typeof items }> = [];
    for (const page of items) {
      const category = normalizeCategory((page as { category?: unknown }).category);
      const last = groups[groups.length - 1];
      if (last && last.category === category) last.items.push(page);
      else groups.push({ category, items: [page] });
    }
    return groups;
  }, [items, display.grouping]);
  // AUDIT-KB（I-06）：未选中详情空态的「最近更新 3 条」（无搜索/状态过滤，跟随当前范围）
  const recent = useQuery({
    queryKey: ['knowledge-recent', workspaceId, scope],
    enabled: selected === null,
    queryFn: () => {
      const recentParams = new URLSearchParams({ scope, ...(scope !== 'common' && workspaceId ? { workspace_id: workspaceId } : {}) });
      recentParams.set('status', 'active');
      recentParams.set('limit', '3');
      return api.get<{ items: PageItem[] }>(`/api/knowledge/pages?${recentParams}`);
    },
  });
  // AUDIT-KB（F-14）：选中项不在当前列表页（翻页后）→ 保持旧内容并标注，不清空
  const selectedOutside = selected !== null && !items.some(item => item.id === selected.id);
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

    {/* KB-TOOLBAR-ONE-LINE：9 个控件同属一个容器、顺序不变。
        单行约需 800px 内容宽：≥1024px（实测可用 816px）稳定单行；搜索框最先收缩，Enter 提示在 <1280px 退让；
        宽度不足时「密度/分组」整组换行，<900px 由零高整行断点固定成两行（筛选组 / 显示偏好组）。
        全档只用 flex-wrap，不出现横向滚动，也不压扁控件。 */}
    <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); setOffset(0); setSelected(null); }}>
      <label className="flex shrink-0 items-center gap-1 text-xs text-ink-2">范围
        <select aria-label="知识范围" value={scope} onChange={e => { const next = e.target.value as KnowledgeScope; setScope(next); persistKnowledgeScope(next); setOffset(0); setSelected(null); }} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
          <option value="both" disabled={!workspaceId}>当前项目＋公共</option><option value="workspace" disabled={!workspaceId}>当前项目</option><option value="common">公共经验</option>
        </select>
      </label>
      <input aria-label="搜索知识" value={draft} onChange={e => setDraft(e.target.value)} maxLength={500} placeholder="搜索知识" className={"h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent min-w-20 flex-1"} />
      <button className="inline-flex h-8 shrink-0 items-center rounded-lg border border-accent bg-accent-soft px-3 text-xs font-medium text-accent transition-colors hover:bg-accent-soft/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" type="submit">搜索</button>
      {/* UNSLOP-5：表单内回车即提交（真实快捷键），用键帽呈现 */}
      <span data-testid="knowledge-search-hint" className="hidden items-center gap-1 text-xs text-ink-3 xl:inline-flex" title="按 Enter 搜索">
        <Kbd>Enter</Kbd>
        <span>搜索</span>
      </span>
      {/* KBIMP-2：导入入口（md/txt/json；json 数组逐条可取消） */}
      <button type="button" data-testid="knowledge-import-open" className={BUTTON_SECONDARY} onClick={() => setImportOpen(true)}>添加</button>
      {query && <button type="button" className={BUTTON_SECONDARY} onClick={() => { setQuery(''); setDraft(''); }}>清除搜索</button>}
      {!query && <label className="flex shrink-0 items-center gap-1 text-xs text-ink-2">状态
        <select aria-label="知识状态" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setSelected(null); }} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
          <option value="active">有效</option><option value="archived">归档</option><option value="deleted">已删除</option><option value="all">全部</option>
        </select>
      </label>}
      {!query && <label className="flex h-8 shrink-0 items-center gap-1 text-xs text-ink-2"><input type="checkbox" checked={expired} onChange={e => { setExpired(e.target.checked); setOffset(0); }} className="size-3.5 accent-[var(--ab-accent)]" /> 包含过期</label>}
      {/* <900px 的整行断点：零高、铺满整行，把「密度/分组」压到下一行，形成固定的两行降级 */}
      <span aria-hidden="true" data-testid="knowledge-toolbar-break" className="hidden h-0 w-full basis-full max-[900px]:block" />
      {/* BORROW-3.3：列表显示偏好（独立键；density 作用于行内边距，grouping 按分类分段不重排）。
          两项成组作为一个 flex 项，宽度不足时整组换行，不会只掉一个到下一行。 */}
      <span className="flex shrink-0 items-center gap-2">
        <label className="flex shrink-0 items-center gap-1 text-xs text-ink-2">密度
          <select aria-label="知识列表密度" value={display.density} onChange={e => setDisplayOptions({ ...display, density: e.target.value as DisplayOptions['density'] })} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
            <option value="comfortable">舒适</option>
            <option value="compact">紧凑</option>
          </select>
        </label>
        <label className="flex shrink-0 items-center gap-1 text-xs text-ink-2">分组
          <select aria-label="知识列表分组" value={display.grouping} onChange={e => setDisplayOptions({ ...display, grouping: e.target.value as DisplayOptions['grouping'] })} className="h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
            <option value="none">不分组</option>
            <option value="label">按分类</option>
          </select>
        </label>
      </span>
    </form>

    {list.isError && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{list.error.message}</p>}
    {deepLinkError && <div className="mt-3 flex flex-wrap items-center gap-2">
      <p role="alert" data-testid="knowledge-deeplink-error" className="flex-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{deepLinkError}</p>
      {deepLinkDeleted && <button type="button" data-testid="knowledge-deeplink-history-open" className={`${BUTTON_SECONDARY} shrink-0`} onClick={() => setDeepLinkHistoryOpen(true)}>查看历史版本</button>}
    </div>}

    {/* KB-SCROLL：容器不再整体滚（去 overflow-auto）。lg+ 两栏各自 h-full 独立滚；
        <lg 纵向堆叠回退整页滚动（App main scroller 接管）。 */}
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      {view === 'graph' ? (
        // KB-SCROLL：星图列固定视口（h-full 不滚），stage 高度随列自适应
        <div className="min-h-0 min-w-0 flex-1 lg:h-full">
          <KnowledgeGraph
            workspaceId={workspaceId}
            scope={scope}
            onSelect={(page) => setSelected({ ...page })}
            initialFocusPageId={graphFocus?.id ?? null}
            onExitFocus={() => { setGraphFocus(null); setView('list'); }}
          />
        </div>
      ) : deepLinkHistoryOpen && deepLinkPageId !== null ? (
        <div className="min-h-0 min-w-0 lg:h-full lg:w-80 lg:flex-none lg:overflow-y-auto">
          <KnowledgeDeepLinkHistory pageId={deepLinkPageId} workspaceId={workspaceId} onBack={() => setDeepLinkHistoryOpen(false)} />
        </div>
      ) : (
      <div className="min-h-0 min-w-0 lg:h-full lg:w-80 lg:flex-none lg:overflow-y-auto">
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
          {(grouped ?? items.map(page => ({ category: null as ReturnType<typeof normalizeCategory> | null, items: [page] }))).map((group, groupIndex) => (
            <Fragment key={group.category ?? `flat:${groupIndex}`}>
              {group.category !== null && (
                <li aria-hidden className="px-3 py-1 text-xs font-medium text-ink-2">
                  <span className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: `var(${CATEGORY_STYLES[group.category].cssVar})` }} />
                  {CATEGORY_LABEL[group.category]}
                </li>
              )}
              {group.items.map(page => {
                const isSelected = selected?.id === page.id && selected?.scope === page.scope;
                const isExpired = page.expires_at !== null && page.expires_at !== undefined && page.expires_at <= Date.now();
                const category = normalizeCategory((page as { category?: unknown }).category);
                const landed = normalizeLanded((page as { landed?: unknown }).landed);
                return <li key={page.id} data-testid={`knowledge-item-${page.id}`} className={`relative px-3 transition-colors ${display.density === 'compact' ? 'py-1.5' : 'py-2.5'} ${isSelected ? 'bg-accent-soft' : 'hover:bg-surface-raised'}`}>
                  {isSelected && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
                  <button type="button" aria-current={isSelected ? 'true' : undefined} className="block w-full text-left" onClick={() => setSelected(page)}>
                    <span className="block truncate text-sm font-medium text-ink">{page.title}</span>
                    {display.density === 'comfortable' && page.snippet && <span className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-ink-3">{page.snippet}</span>}
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
            </Fragment>
          ))}
        </ul>}

        {!query && items.length > 0 && <div className="mt-3 flex items-center gap-2">
          {/* AUDIT-KB（F-14）：翻页不清空选中——阅读中的详情保持 */}
          <button type="button" className={BUTTON_SECONDARY} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button>
          <button type="button" className={BUTTON_SECONDARY} disabled={list.data?.next_offset == null} onClick={() => setOffset(list.data?.next_offset ?? offset)}>下一页</button>
        </div>}
      </div>
      )}

      {/* AUDIT-KB（I-06）：未选中不空白——引导 + 最近更新 3 条 + 新建入口 */}
      {selected === null && <div data-testid="knowledge-detail-empty" className="min-h-0 min-w-0 flex-1 rounded-lg border border-hairline bg-surface-card px-5 py-4 lg:h-full lg:overflow-y-auto">
        <p className="text-sm font-medium text-ink">从左侧选择知识页</p>
        <div className="mt-3">
          <p className="text-xs text-ink-3">最近更新</p>
          {recent.isPending && <p className="mt-2 text-xs text-ink-3">加载中…</p>}
          {(recent.data?.items ?? []).map(item => (
            <button key={item.id} type="button" aria-label={`最近更新：${item.title}`} className="mt-1 block w-full truncate text-left text-sm text-accent hover:underline" onClick={() => setSelected(item)}>
              {item.title}
            </button>
          ))}
        </div>
        <button type="button" className={`${BUTTON_PRIMARY} mt-4`} onClick={() => setImportOpen(true)}>新建知识页</button>
      </div>}
      {selected && <div className="min-h-0 min-w-0 flex-1 lg:h-full lg:overflow-y-auto">
        {selectedOutside && <p data-testid="knowledge-selected-stale" className="mb-1 text-xs text-ink-3">选中项来自上一页，此处仍显示其内容</p>}
        <KnowledgePageDetail key={`${selected.scope}:${selected.id}`} pageId={selected.id} scope={selected.scope} workspaceId={selected.workspace_id} onChanged={() => void list.refetch()} onViewInGraph={selected.status !== 'deleted' ? () => { setGraphFocus({ id: selected.id }); setView('graph'); } : undefined} />
      </div>}
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



