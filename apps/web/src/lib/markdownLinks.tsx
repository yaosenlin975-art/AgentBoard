/**
 * markdown 软链接（MD-LINKS-2）：`issue:<uuid>` / `knowledge:<slug|id>` / `log:<id>`。
 *
 * 只在渲染层做（客户端解析，不改服务端）：
 * - `issue:`：任务链接，点击用 panelStore.openDetail 打开任务详情浮窗；
 * - `knowledge:`：知识链接，只解析 common + 当前工作区；跨区/不存在 → 不可点 + tooltip「无权限或不存在」；
 * - `log:`：当前工作区的日志，按 id 拉 changelog 详情，不存在 → 同一文案；
 * - `http(s)` / `mailto`：保持普通外链；
 * - 其它未知 scheme：调用方（markdownRenderer）渲染为纯文本，不外链、不静默。
 *
 * 解析用 `useEffect` + 显式取消，不用 react-query：这里是 markdown 渲染回调里挂载的小组件，
 * 每个链接一条独立解析，生命周期与文档流一致，显式管理比共享缓存更好推理（也免得 query 键空间被链接撑爆）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { KnowledgePage, WorkspaceChangeLog } from '@agentboard/shared';
import { ApiError, api } from '../api/client';
import { fetchKnowledgePage as fetchPage, isKnowledgeAllowed } from './knowledgeRef';
import { changelogApi } from '../api/changelog';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';

export type MarkdownRefKind = 'issue' | 'knowledge' | 'log';

export interface MarkdownRef {
  kind: MarkdownRefKind;
  ref: string;
}

const SCHEME = /^(issue|knowledge|log):(.+)$/i;
const EXTERNAL = /^(https?:|mailto:)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 解析软链接 scheme；不是这三种之一返回 null */
export function parseMarkdownRef(href: string | undefined): MarkdownRef | null {
  if (typeof href !== 'string') return null;
  const match = SCHEME.exec(href.trim());
  if (match === null) return null;
  const kind = match[1]!.toLowerCase() as MarkdownRefKind;
  const ref = match[2]!.trim();
  return ref === '' ? null : { kind, ref };
}

/** 是否普通外链（http/https/mailto），保持既有行为 */
export function isExternalLink(href: string | undefined): boolean {
  return typeof href === 'string' && EXTERNAL.test(href.trim());
}

const DENIED = '无权限或不存在';

const KIND_STYLE: Record<MarkdownRefKind, { icon: string; className: string; label: string }> = {
  issue: { icon: '◆', className: 'text-accent ', label: '任务' },
  knowledge: { icon: '▤', className: 'text-emerald-700 dark:text-emerald-400', label: '知识' },
  log: { icon: '▦', className: 'text-amber-700 dark:text-amber-400', label: '日志' },
};

/** 按 id 取知识页（共享实现）；404 且形如 slug 时再用搜索定位一次 */
async function resolveKnowledgePage(ref: string, workspaceId: string | null): Promise<KnowledgePage> {
  try {
    return await fetchPage(ref, workspaceId);
  } catch (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    if (!notFound || UUID.test(ref)) throw error;
    const search = new URLSearchParams({ scope: 'both', q: ref, limit: '10' });
    if (workspaceId !== null) search.set('workspace_id', workspaceId);
    const rows = await api.get<Array<{ page_id: string; slug?: string }>>(`/api/knowledge/search?${search.toString()}`);
    // KB-PAGE-1 缺陷 1：**不得**用 `?? rows[0]` 兜底——搜索是子串匹配，取第一条会静默打开错页
    // （典型：workspace 与 common 同 slug 时第一条未必是引用想指的那页）。
    // 只接受 slug **完全相等**的命中；无命中或多条歧义时保持原错误，由渲染层降级为灰文本。
    const exact = rows.filter((row) => row.slug === ref);
    if (exact.length !== 1) throw error;
    return fetchPage(exact[0]!.page_id, workspaceId);
  }
}

type LinkState =
  | { phase: 'loading' }
  | { phase: 'denied' }
  | { phase: 'ok'; title: string; open: () => void };

/**
 * 软链接渲染：可点 → button（点击开浮窗）；不可点 → span + tooltip「无权限或不存在」。
 * `data-link-state` 暴露状态（ok / denied / loading），便于测试与 CDP 断言。
 */
export function MarkdownSmartLink({ href, children }: { href: string; children: ReactNode }) {
  const parsed = parseMarkdownRef(href);
  const kind: MarkdownRefKind = parsed?.kind ?? 'issue';
  const ref = parsed?.ref ?? href;
  const style = KIND_STYLE[kind];
  const workspaceId = useAppStore((s) => s.workspaceId);
  const label = typeof children === 'string' ? children : ref;

  const [state, setState] = useState<LinkState>(() => {
    if (parsed === null) return { phase: 'denied' };
    if (parsed.kind === 'issue') {
      const id = parsed.ref;
      return { phase: 'ok', title: `任务：${label}`, open: () => usePanelStore.getState().openDetail(id) };
    }
    return { phase: 'loading' };
  });

  const kindKey = parsed?.kind ?? null;
  const refKey = parsed?.ref ?? null;

  useEffect(() => {
    if (kindKey === null || kindKey === 'issue' || refKey === null) return;
    let alive = true;
    const decide = (next: LinkState): void => {
      if (alive) setState(next);
    };

    if (kindKey === 'knowledge') {
      void resolveKnowledgePage(refKey, workspaceId)
        .then((page) => {
          const allowed = isKnowledgeAllowed(page, workspaceId);
          if (!allowed) {
            decide({ phase: 'denied' });
            return;
          }
          decide({
            phase: 'ok',
            title: `知识：${page.title}`,
            open: () => usePanelStore.getState().openRef({ kind: 'knowledge', id: page.id, title: page.title }),
          });
        })
        .catch(() => decide({ phase: 'denied' }));
      return () => {
        alive = false;
      };
    }

    if (workspaceId === null) {
      decide({ phase: 'denied' });
      return () => {
        alive = false;
      };
    }
    void changelogApi
      .get(workspaceId, refKey)
      .then((entry: WorkspaceChangeLog) => {
        decide({
          phase: 'ok',
          title: `日志：${entry.title}`,
          open: () => usePanelStore.getState().openRef({ kind: 'log', id: entry.id, title: entry.title }),
        });
      })
      .catch(() => decide({ phase: 'denied' }));
    return () => {
      alive = false;
    };
  }, [kindKey, refKey, workspaceId]);

  if (state.phase !== 'ok') {
    return (
      <span
        data-testid={`md-link-${kind}-${ref}`}
        data-link-state={state.phase}
        title={state.phase === 'denied' ? DENIED : '解析中…'}
        aria-disabled="true"
        className="cursor-not-allowed text-ink-3 underline decoration-dotted "
      >
        <span aria-hidden="true" className="mr-0.5">{style.icon}</span>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid={`md-link-${kind}-${ref}`}
      data-link-state="ok"
      title={state.title}
      onClick={state.open}
      className={`inline-flex items-center gap-0.5 rounded underline decoration-dotted hover:decoration-solid focus-visible:outline-2 focus-visible:outline-accent ${style.className}`}
    >
      <span aria-hidden="true">{style.icon}</span>
      {children}
    </button>
  );
}
