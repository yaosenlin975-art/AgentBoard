/**
 * markdown 渲染重实现（MD-COMMENT）：react-markdown + remark-gfm（表格/任务列表/删除线/自动链接）
 * + rehype-highlight（highlight.js）。**只由 lib/markdown.tsx 动态加载**，不进首屏 chunk。
 * 原始 HTML 不渲染（未装 rehype-raw）：保持字面量是安全默认。
 * 样式见 index.css 的 .markdown-body。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
// highlight.js 主题样式（浅色）；vitest css:false 忽略，vite build 随本 chunk 打包
import 'highlight.js/styles/github.css';

export interface MarkdownRendererProps {
  children: string;
}

export default function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {children}
    </ReactMarkdown>
  );
}
