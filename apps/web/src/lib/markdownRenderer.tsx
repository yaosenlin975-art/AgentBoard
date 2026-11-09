/**
 * markdown 渲染重实现（MD-COMMENT）：react-markdown + remark-gfm（表格/任务列表/删除线/自动链接）
 * + rehype-highlight（highlight.js）。**只由 lib/markdown.tsx 动态加载**，不进首屏 chunk。
 * 原始 HTML 不渲染（未装 rehype-raw）：保持字面量是安全默认。
 * 样式见 index.css 的 .markdown-body。
 *
 * MD-LINKS：`a` 走自定义渲染 —— `issue:` / `knowledge:` / `log:` 三种软链接交给 MarkdownSmartLink
 * （点击开右侧浮窗、知识按 common + 当前工作区鉴权）；http(s)/mailto 保持普通外链；
 * 其它未知 scheme 渲染为纯文本，不外链也不静默变成可点内容。
 */
import { memo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { MarkdownSmartLink, isExternalLink, parseMarkdownRef } from './markdownLinks';
import { ImageLightbox } from '../components/ui/ImageLightbox';
// highlight.js 主题样式（浅色）；vitest css:false 忽略，vite build 随本 chunk 打包
import 'highlight.js/styles/github.css';

export interface MarkdownRendererProps {
  children: string;
}

/**
 * KB-IMG-3 / DETAIL-D6：正文图片统一渲染 —— 最大宽度不撑破版面（max-width:100% + height:auto），
 * 加载失败时用 alt 文本 + 占位块兜底；点击打开统一灯箱（描述与评论共用 ImageLightbox）。
 * 站内图片走 `/api/knowledge/images/:id` 或 `/api/workspaces/{ws}/attachments/{id}`，与插入链路同源。
 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const label = alt !== undefined && alt.trim() !== '' ? alt : '图片';
  if (failed) {
    return (
      <span
        data-testid="md-image-fallback"
        role="img"
        aria-label={`图片加载失败：${label}`}
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded border border-dashed border-neutral-300 bg-neutral-50 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400"
      >
        <span aria-hidden>🖼</span>
        <span className="break-all">{label}（加载失败）</span>
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        data-testid="md-image-button"
        aria-label={`放大图片：${label}`}
        onClick={() => setOpen(true)}
        className="my-1 block max-w-full cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          data-testid="md-image"
          onError={() => setFailed(true)}
          className="my-1 h-auto max-w-full rounded"
          style={{ maxWidth: '100%' }}
        />
      </button>
      {open && src !== undefined && (
        <ImageLightbox src={src} alt={label} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const components: Components = {
  img({ src, alt }) {
    return <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={typeof alt === 'string' ? alt : undefined} />;
  },
  a({ href, children }) {
    if (parseMarkdownRef(href) !== null) {
      return <MarkdownSmartLink href={href ?? ''}>{children}</MarkdownSmartLink>;
    }
    if (isExternalLink(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    }
    // 未知 scheme（如 foo:bar）：原样文本，不外链
    return (
      <span data-testid="md-link-unknown" title="不支持的链接类型">
        {children}
      </span>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
// 默认 urlTransform 只放行 http/https/mailto/tel 与相对路径，会把 issue:/knowledge:/log: 抹成空串。
// 原样透传是安全的：未知 scheme 在 components.a 里被渲染成纯文本（不带 href），不会变成可点的危险链接。
const KEEP_URL = (url: string) => url;

/**
 * CR2-5：memo 包住正文渲染——流式增量只让正在变化的那一条消息重解析 markdown，
 * 历史 assistant 消息在父组件重渲时保持原 VDOM（内容不变即跳过整棵 react-markdown 解析）。
 */
export default memo(function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
      urlTransform={KEEP_URL}
    >
      {children}
    </ReactMarkdown>
  );
});
