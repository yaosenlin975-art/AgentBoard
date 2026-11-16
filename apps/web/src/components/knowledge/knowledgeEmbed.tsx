/**
 * P2-03（§7.4）：详情页正文嵌入渲染（Obsidian 语法）。
 *
 * - `![[page]]` → 页嵌入块：resolve 目标页后渲染其标题 + 正文（**一层**，嵌入块内不再
 *   递归解析嵌入，防循环引用拖死渲染）；
 * - `![[image.png]]` / `![[_attachments/x.png]]` → 图片：附件相对路径转
 *   GET /api/knowledge/attachments/:name（vault 自包含，§8 #3）；
 * - 代码块（``` / ~~~ 围栏）内的 `![[` 不处理，原样随 md 段渲染；
 * - `[[...]]` 普通双链不做替换（链接跳转走 markdownLinks 既有链路，不属本卡）。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { MarkdownView } from '../../lib/markdown';
import type { KnowledgePage } from '@agentboard/shared';

export type BodySegment =
  | { kind: 'md'; text: string }
  | { kind: 'image'; name: string; raw: string }
  | { kind: 'page'; target: string; raw: string };

/** 图片扩展名（与服务端 ATTACHMENT_EXT_PATTERN 同口径） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const EMBED_PATTERN = /!\[\[([^\[\]\n]+)\]\](?!\])/g;

/** 附件名归一：取 basename（`_attachments/x.png` 与 `x.png` 指向同一附件） */
export function attachmentNameOf(target: string): string {
  return target.split(/[\\/]/).pop() ?? target;
}

/**
 * 把正文切成 md / 图片嵌入 / 页嵌入段（fence 感知）。
 * 纯函数、无 React 依赖，便于单测逐段断言。
 */
export function splitKnowledgeBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let mdBuffer = '';
  const flush = (): void => {
    if (mdBuffer !== '') segments.push({ kind: 'md', text: mdBuffer });
    mdBuffer = '';
  };
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence !== null) {
      mdBuffer += `${line}\n`;
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      // 围栏行自身可以带尾内容（```ts 等）：本行仍属于 md；围栏开启后行内不再解析嵌入
      mdBuffer += `${line}\n`;
      fence = fenceMatch[1]!;
      continue;
    }
    let lastIndex = 0;
    let matched = false;
    for (const match of line.matchAll(EMBED_PATTERN)) {
      const inner = match[1] ?? '';
      const pipe = inner.indexOf('|');
      const hash = inner.indexOf('#');
      const splitAt = [pipe, hash].filter(index => index >= 0);
      const cut = splitAt.length === 0 ? inner.length : Math.min(...splitAt);
      const target = inner.slice(0, cut).trim();
      if (target === '') continue;
      const start = match.index ?? 0;
      flush();
      mdBuffer += line.slice(lastIndex, start);
      flush();
      if (IMAGE_EXT.test(target)) segments.push({ kind: 'image', name: attachmentNameOf(target), raw: match[0] });
      else segments.push({ kind: 'page', target, raw: match[0] });
      lastIndex = start + match[0].length;
      matched = true;
    }
    mdBuffer += matched ? `${line.slice(lastIndex)}\n` : `${line}\n`;
  }
  flush();
  return segments;
}

/** 图片段 → 标准 markdown 图片（走附件读取端点，带 scope 鉴权参数） */
export function imageSegmentToMarkdown(name: string, scope: 'workspace' | 'common', workspaceId: string | null): string {
  const query = new URLSearchParams({ scope });
  if (scope === 'workspace' && workspaceId !== null) query.set('workspace_id', workspaceId);
  return `![${name}](/api/knowledge/attachments/${encodeURIComponent(name)}?${query.toString()})`;
}

interface EmbedProps {
  scope: 'workspace' | 'common';
  workspaceId: string | null;
}

/** 页嵌入块：resolve slug → 拉详情渲染（一层，不递归解析嵌入） */
function KnowledgeEmbedBlock({ target, scope, workspaceId }: EmbedProps & { target: string }) {
  const resolveQuery = new URLSearchParams({ ref: target, scope: scope === 'workspace' ? 'both' : 'common' });
  if (scope === 'workspace' && workspaceId !== null) resolveQuery.set('workspace_id', workspaceId);
  const resolved = useQuery({
    queryKey: ['knowledge-embed-resolve', target, scope, workspaceId],
    queryFn: () => api.get<{ state: string; id?: string; scope?: string; workspace_id?: string | null; message?: string }>(`/api/knowledge/resolve?${resolveQuery.toString()}`),
    retry: false,
    staleTime: 15_000,
  });
  const pageId = resolved.data?.state === 'resolved' ? resolved.data.id ?? null : null;
  const pageScope = resolved.data?.state === 'resolved' ? (resolved.data.scope === 'common' ? 'common' : 'workspace') : scope;
  const pageWorkspaceId = resolved.data?.state === 'resolved' ? resolved.data.workspace_id ?? null : workspaceId;
  const detailQuery = new URLSearchParams({ scope: pageScope });
  if (pageScope === 'workspace' && pageWorkspaceId !== null) detailQuery.set('workspace_id', pageWorkspaceId);
  const detail = useQuery({
    queryKey: ['knowledge-embed-detail', pageId, pageScope, pageWorkspaceId],
    enabled: pageId !== null,
    queryFn: () => api.get<KnowledgePage>(`/api/knowledge/pages/${encodeURIComponent(pageId!)}?${detailQuery.toString()}`),
    retry: false,
    staleTime: 15_000,
  });
  if (resolved.isPending) {
    return <div data-testid="kb-embed-loading" className="my-2 rounded-md border border-hairline px-3 py-2 text-xs text-ink-3">嵌入加载中…</div>;
  }
  if (pageId === null || detail.isError) {
    return (
      <div data-testid="kb-embed-missing" className="my-2 inline-flex items-center gap-1.5 rounded border border-dashed border-hairline px-2 py-1 text-xs text-ink-3">
        <span aria-hidden>📎</span>
        <span className="break-all">无法解析嵌入：{target}</span>
      </div>
    );
  }
  const page = detail.data;
  if (page === undefined) {
    return <div data-testid="kb-embed-loading" className="my-2 rounded-md border border-hairline px-3 py-2 text-xs text-ink-3">嵌入加载中…</div>;
  }
  return (
    <div data-testid="kb-embed-block" className="my-2 rounded-md border border-hairline bg-surface-page px-3 py-2">
      <div data-testid="kb-embed-title" className="mb-1 text-xs font-medium text-ink-2">↗ {page.title}</div>
      <div className="max-h-[32rem] overflow-y-auto pr-1 text-sm">
        <MarkdownView compact>{page.body_md}</MarkdownView>
      </div>
    </div>
  );
}

/** 详情页正文：md 段走 MarkdownView，图片/页嵌入段走嵌入渲染 */
export function KnowledgeBodyView({ body, scope, workspaceId }: { body: string; scope: 'workspace' | 'common'; workspaceId: string | null }) {
  const segments = splitKnowledgeBody(body);
  return (
    <div data-testid="knowledge-body-view">
      {segments.map((segment, index) => {
        if (segment.kind === 'md') return <MarkdownView key={index}>{segment.text}</MarkdownView>;
        if (segment.kind === 'image') {
          return <MarkdownView key={index}>{`${imageSegmentToMarkdown(segment.name, scope, workspaceId)}\n`}</MarkdownView>;
        }
        return <KnowledgeEmbedBlock key={index} target={segment.target} scope={scope} workspaceId={workspaceId} />;
      })}
    </div>
  );
}
