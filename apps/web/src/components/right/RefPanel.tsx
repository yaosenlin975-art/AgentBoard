/**
 * 软链接浮窗内容（MD-LINKS-1）：知识页 / 日志详情。
 *
 * 只带定位信息（kind + id + title），正文自己按 kind 拉：
 * - knowledge：`GET /api/knowledge/pages/:id?scope=&workspace_id=`（与知识库面板同一端点，客户端不新增接口）
 * - log：`GET /api/workspaces/:id/changelog/:id`（既有 changelog REST）
 *
 * 权限（知识只允许 common + 当前工作区）由子卡 MD-LINKS-2 的解析层把关；
 * 这里对 404/403 统一显示「无权限或不存在」，不把错误当外链或空白。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { ApiError, api } from '../../api/client';
import { changelogApi } from '../../api/changelog';
import { MarkdownView } from '../../lib/markdown';
import { fetchKnowledgePage } from '../../lib/knowledgeRef';
import { useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { PANEL_MOTION_MS, panelMotionStyle, usePanelPresence, usePrefersReducedMotion } from '../overlay/panelMotion';
import { ErrorState } from '../ui/ErrorState';

function messageOf(error: unknown): string {
  if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return '无权限或不存在';
  return error instanceof Error ? error.message : '读取失败';
}

function KnowledgeRef({ id }: { id: string }) {
  const workspaceId = useAppStore((s) => s.workspaceId);
  const query = useQuery({
    queryKey: ['knowledge-page', id, workspaceId],
    queryFn: () => fetchKnowledgePage(id, workspaceId),
  });

  if (query.isPending) return <p className="text-xs text-ink-3" role="status">加载知识页…</p>;
  if (query.isError) {
    return <ErrorState message={messageOf(query.error)} testId="ref-panel-error" className="text-xs" />;
  }
  const page = query.data;
  return (
    <article data-testid="ref-panel-knowledge" className="flex min-h-0 flex-col gap-2">
      <h2 className="break-words text-sm font-semibold">{page.title}</h2>
      <p className="text-xs text-ink-3">
        {page.scope === 'common' ? '公共知识' : '当前工作区'} · {page.slug}
      </p>
      <div data-testid="ref-panel-body" className="min-h-0 overflow-auto break-words rounded border border-hairline p-2">
        <MarkdownView compact>{page.body_md ?? ''}</MarkdownView>
      </div>
    </article>
  );
}

function LogRef({ id }: { id: string }) {
  const workspaceId = useAppStore((s) => s.workspaceId);
  const query = useQuery({
    queryKey: ['changelog-entry', workspaceId, id],
    queryFn: () => changelogApi.get(workspaceId ?? '', id),
    enabled: workspaceId !== null,
  });

  if (workspaceId === null) {
    return <p data-testid="ref-panel-error" className="text-xs text-ink-3">请先选择工作空间</p>;
  }
  if (query.isPending) return <p className="text-xs text-ink-3" role="status">加载日志…</p>;
  if (query.isError) {
    return <ErrorState message={messageOf(query.error)} testId="ref-panel-error" className="text-xs" />;
  }
  const entry = query.data;
  return (
    <article data-testid="ref-panel-log" className="flex min-h-0 flex-col gap-2">
      <h2 className="break-words text-sm font-semibold">{entry.title}</h2>
      <p className="text-xs text-ink-3">
        {entry.change_type} · rev:{entry.revision}
      </p>
      <div data-testid="ref-panel-body" className="min-h-0 overflow-auto break-words rounded border border-hairline p-2">
        <MarkdownView compact>{entry.body_md}</MarkdownView>
      </div>
    </article>
  );
}

/**
 * A1（点击触发面板显隐动画）：引用浮窗内容**进场**过渡。
 *
 * 复用既有 `panelMotion` token（`PANEL_MOTION_MS`/`PANEL_MOTION_EASE`），不引新依赖、不加新 token；
 * 只动 `transform` + `opacity`，不碰 width/height —— 面板宽度语义（FIX-3 的 400px 挤压）不变，
 * 动画期间不会引起内容区回流。`prefers-reduced-motion: reduce` 命中时 `transition: none` 瞬时切换。
 * 每次切换目标（kind + id 变化）重新播一次入场，符合「点击链接 → 该浮窗出现」的交互。
 */
export function RefPanel() {
  const target = usePanelStore((s) => s.refPanel);
  const reducedMotion = usePrefersReducedMotion();
  // 目标变化即重新入场：先 mounted=false 一帧，再用双 rAF 切到 open（与 usePanelPresence 同机制）
  const key = target === null ? '' : `${target.kind}:${target.id}`;
  const { mounted, phase } = usePanelPresence(key !== '', reducedMotion);
  const [shownKey, setShownKey] = useState(key);
  useEffect(() => {
    if (key === '' || key === shownKey) return;
    setShownKey(key);
  }, [key, shownKey]);

  if (target === null) {
    return <p data-testid="ref-panel-empty" className="text-xs text-ink-3">没有可显示的内容</p>;
  }
  return (
    <div
      data-testid="ref-panel-motion"
      data-panel-state={phase}
      data-panel-motion-ms={reducedMotion ? 0 : PANEL_MOTION_MS}
      style={panelMotionStyle('slide-right', mounted ? phase : 'entering', reducedMotion)}
      className="min-h-0"
    >
      {target.kind === 'knowledge' ? <KnowledgeRef id={target.id} /> : <LogRef id={target.id} />}
    </div>
  );
}
