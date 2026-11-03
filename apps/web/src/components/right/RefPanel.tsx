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
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { ApiError, api } from '../../api/client';
import { changelogApi } from '../../api/changelog';
import { MarkdownView } from '../../lib/markdown';
import { fetchKnowledgePage } from '../../lib/knowledgeRef';
import { useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';

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

  if (query.isPending) return <p className="text-xs text-neutral-500" role="status">加载知识页…</p>;
  if (query.isError) {
    return <p data-testid="ref-panel-error" className="text-xs text-red-600 dark:text-red-400">{messageOf(query.error)}</p>;
  }
  const page = query.data;
  return (
    <article data-testid="ref-panel-knowledge" className="flex min-h-0 flex-col gap-2">
      <h2 className="break-words text-sm font-semibold">{page.title}</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {page.scope === 'common' ? '公共知识' : '当前工作区'} · {page.slug}
      </p>
      <div data-testid="ref-panel-body" className="min-h-0 overflow-auto break-words rounded border border-neutral-200 p-2 dark:border-neutral-800">
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
    return <p data-testid="ref-panel-error" className="text-xs text-neutral-500">请先选择工作空间</p>;
  }
  if (query.isPending) return <p className="text-xs text-neutral-500" role="status">加载日志…</p>;
  if (query.isError) {
    return <p data-testid="ref-panel-error" className="text-xs text-red-600 dark:text-red-400">{messageOf(query.error)}</p>;
  }
  const entry = query.data;
  return (
    <article data-testid="ref-panel-log" className="flex min-h-0 flex-col gap-2">
      <h2 className="break-words text-sm font-semibold">{entry.title}</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {entry.change_type} · rev:{entry.revision}
      </p>
      <div data-testid="ref-panel-body" className="min-h-0 overflow-auto break-words rounded border border-neutral-200 p-2 dark:border-neutral-800">
        <MarkdownView compact>{entry.body_md}</MarkdownView>
      </div>
    </article>
  );
}

export function RefPanel() {
  const target = usePanelStore((s) => s.refPanel);
  if (target === null) {
    return <p data-testid="ref-panel-empty" className="text-xs text-neutral-500 dark:text-neutral-400">没有可显示的内容</p>;
  }
  return target.kind === 'knowledge' ? <KnowledgeRef id={target.id} /> : <LogRef id={target.id} />;
}
