/**
 * markdown 软链接（MD-LINKS-2）：`issue:<uuid>` / `knowledge:<slug|id>` / `log:<id>`。
 *
 * 只在渲染层做（知识引用走服务端 `GET /api/knowledge/resolve`，各端同一套错误语义）：
 * - `issue:`：任务链接，点击用 panelStore.openDetail 打开任务详情浮窗；
 * - `knowledge:`：知识链接，只解析 common + 当前工作区；跨区/不存在/歧义/已删除 → 不可点 + 对应 tooltip；
 * - `log:`：当前工作区的日志，按 id 拉 changelog 详情，不存在 → 同一文案；
 * - `http(s)` / `mailto`：保持普通外链；
 * - 其它未知 scheme：调用方（markdownRenderer）渲染为纯文本，不外链、不静默。
 *
 * 解析用 `useEffect` + 显式取消，不用 react-query：这里是 markdown 渲染回调里挂载的小组件，
 * 每个链接一条独立解析，生命周期与文档流一致，显式管理比共享缓存更好推理（也免得 query 键空间被链接撑爆）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { ApiError } from '../api/client';
import { resolveKnowledgeRef } from './knowledgeRef';
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

/** 软链接降级文案：四态与设计 §2.4 一致（歧义不猜、已删除不冒充正常卡片） */
const FALLBACK_TEXT: Record<'denied' | 'ambiguous' | 'deleted', string> = {
  denied: '无权限或不存在',
  ambiguous: '链接有歧义，请用完整 id',
  deleted: '已删除（可查看历史版本）',
};

const KIND_STYLE: Record<MarkdownRefKind, { icon: string; className: string; label: string }> = {
  issue: { icon: '◆', className: 'text-accent ', label: '任务' },
  knowledge: { icon: '▤', className: 'text-emerald-700 dark:text-emerald-400', label: '知识' },
  log: { icon: '▦', className: 'text-amber-700 dark:text-amber-400', label: '日志' },
};

type LinkState =
  | { phase: 'loading' }
  | { phase: 'denied' }
  | { phase: 'ambiguous' }
  | { phase: 'deleted' }
  | { phase: 'ok'; title: string; open: () => void };

/**
 * 软链接渲染：可点 → button（点击开浮窗）；不可点 → span + 降级 tooltip。
 * `data-link-state` 暴露状态（ok / denied / ambiguous / deleted / loading），便于测试与 CDP 断言。
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
      void resolveKnowledgeRef(refKey, workspaceId)
        .then((page) => {
          decide({
            phase: 'ok',
            title: `知识：${page.title}${page.status === 'archived' ? '（已归档）' : ''}`,
            open: () => usePanelStore.getState().openRef({ kind: 'knowledge', id: page.id, title: page.title }),
          });
        })
        .catch((error: unknown) => {
          const status = error instanceof ApiError ? error.status : 0;
          decide(status === 410 ? { phase: 'deleted' } : status === 409 ? { phase: 'ambiguous' } : { phase: 'denied' });
        });
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
        title={state.phase === 'loading' ? '解析中…' : FALLBACK_TEXT[state.phase]}
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
