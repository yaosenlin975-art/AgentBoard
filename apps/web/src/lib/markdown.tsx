/**
 * markdown 渲染唯一入口（设计 §7.5；MD 批次统一）。
 * 两级加载：
 *  1) React.lazy 动态加载重实现（react-markdown + remark-gfm + rehype-highlight，见 markdownRenderer.tsx）→ 不进首屏 chunk；
 *  2) 再叠加可见性门控：容器进入视口才真正渲染（右侧面板收起时两个视图仍挂载但被 translate 到视口外，
 *     不门控就会在首屏就拉 chunk）。门控期间渲染纯文本 fallback，无空白闪烁。
 * jsdom/无 IntersectionObserver 环境直接渲染，测试无需额外 mock。
 * 原始 HTML 保持字面量（未装 rehype-raw）是安全默认。
 * 消费方：聊天 assistant 消息、详情描述、评论、工作区日志（时间轴与归档只读）。
 */
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';

const MarkdownRenderer = lazy(() => import('./markdownRenderer'));

export interface MarkdownViewProps {
  children: string;
  /** 追加在 .markdown-body 后的容器类名（宽度/边框/内边距等场景差异） */
  className?: string;
  /** 紧凑档：评论、日志条目这类小字号场景 */
  compact?: boolean;
}

function containerClass(compact: boolean, className: string): string {
  return `markdown-body${compact ? ' markdown-body-compact' : ''}${className === '' ? '' : ` ${className}`}`;
}

/** 加载中/未进入视口时的纯文本兜底：保留换行、继承容器样式 */
function MarkdownFallback({ children, compact = false, className = '' }: MarkdownViewProps): ReactNode {
  return (
    <div className={containerClass(compact, className)} data-testid="markdown-fallback">
      <p className="whitespace-pre-wrap">{children}</p>
    </div>
  );
}

/** 容器是否已进入视口（无 IntersectionObserver 的环境视为可见） */
function useVisibleOnce(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, visible];
}

export function MarkdownView({ children, className = '', compact = false }: MarkdownViewProps) {
  const [ref, visible] = useVisibleOnce();
  return (
    <div ref={ref} className={containerClass(compact, className)}>
      {visible ? (
        <Suspense fallback={<MarkdownFallback compact={compact}>{children}</MarkdownFallback>}>
          <MarkdownRenderer>{children}</MarkdownRenderer>
        </Suspense>
      ) : (
        <MarkdownFallback compact={compact}>{children}</MarkdownFallback>
      )}
    </div>
  );
}
