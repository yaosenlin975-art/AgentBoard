/**
 * markdown 渲染（设计 §7.5）：react-markdown + rehype-highlight 代码高亮（highlight.js）。
 * 聊天 assistant 消息与流式增量共用；样式见 index.css 的 .markdown-body。
 */
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
// highlight.js 主题样式（浅色）；vitest css:false 忽略，vite build 打包
import 'highlight.js/styles/github.css';

export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{children}</ReactMarkdown>
    </div>
  );
}
