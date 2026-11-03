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
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { MarkdownSmartLink, isExternalLink, parseMarkdownRef } from './markdownLinks';
// highlight.js 主题样式（浅色）；vitest css:false 忽略，vite build 随本 chunk 打包
import 'highlight.js/styles/github.css';

export interface MarkdownRendererProps {
  children: string;
}

const components: Components = {
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

export default function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
      // 默认 urlTransform 只放行 http/https/mailto/tel 与相对路径，会把 issue:/knowledge:/log: 抹成空串。
      // 原样透传是安全的：未知 scheme 在 components.a 里被渲染成纯文本（不带 href），不会变成可点的危险链接。
      urlTransform={(url) => url}
    >
      {children}
    </ReactMarkdown>
  );
}
