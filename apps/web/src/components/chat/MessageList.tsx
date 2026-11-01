/**
 * 消息流渲染（设计 §7.5）：
 * - user 右侧气泡；assistant 左侧 markdown（代码高亮）；event/error 折叠块（<details>）；
 *   event 按 content JSON 归类：kind==='thinking' → 「思考」折叠块（纯文本正文）；
 *   含 name/input → tool 块（摘要行显示工具名，正文 input 截断到 200 字符）；都不匹配按原文展示；
 * - 流式增量（streaming 非空）渲染为左侧临时气泡；
 * - 运行中底部三个跳动点；新内容自动滚到底。
 */
import { useEffect, useRef } from 'react';
import type { Message } from '@agentboard/shared';
import { MarkdownView } from '../../lib/markdown';

const INPUT_TRUNCATE = 200;

interface EventPayload {
  kind?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
}

/** 解析 event 消息内容：kind==='thinking' → 思考块；name 缺失否则 → 工具块；解析失败两者皆 null（按原文展示） */
function parseEventContent(content: string): {
  thinking: { text: string } | null;
  tool: { name: string; input: string } | null;
} {
  let thinking: { text: string } | null = null;
  let tool: { name: string; input: string } | null = null;
  try {
    const parsed = JSON.parse(content) as EventPayload;
    if (parsed.kind === 'thinking' && typeof parsed.text === 'string') {
      thinking = { text: parsed.text };
    } else if (typeof parsed.name === 'string') {
      tool = { name: parsed.name, input: typeof parsed.input === 'string' ? parsed.input : '' };
    }
  } catch {
    // 保留 null：调用方按原文展示
  }
  return { thinking, tool };
}

function truncate(text: string, max = INPUT_TRUNCATE): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function EventBlock({ message }: { message: Message }) {
  const { thinking, tool } = parseEventContent(message.content);
  if (thinking !== null) {
    return (
      <details data-testid={`thinking-block-${message.id}`} className="my-1 max-w-full text-xs">
        <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
          思考
        </summary>
        <pre className="mt-1 overflow-x-auto rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] whitespace-pre-wrap dark:border-neutral-800 dark:bg-neutral-950">
          {thinking.text}
        </pre>
      </details>
    );
  }
  if (tool !== null) {
    return (
      <details data-testid={`event-block-${message.id}`} className="my-1 max-w-full text-xs">
        <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
          工具 · {tool.name}
        </summary>
        <pre className="mt-1 overflow-x-auto rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] whitespace-pre-wrap dark:border-neutral-800 dark:bg-neutral-950">
          {truncate(tool.input)}
        </pre>
      </details>
    );
  }
  return (
    <details data-testid={`event-block-${message.id}`} className="my-1 max-w-full text-xs">
      <summary className="cursor-pointer select-none text-neutral-500 dark:text-neutral-400">事件</summary>
      <pre className="mt-1 overflow-x-auto rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] whitespace-pre-wrap dark:border-neutral-800 dark:bg-neutral-950">
        {truncate(message.content)}
      </pre>
    </details>
  );
}

function ErrorBlock({ message }: { message: Message }) {
  return (
    <details data-testid={`error-block-${message.id}`} className="my-1 max-w-full text-xs">
      <summary className="cursor-pointer select-none text-red-600 dark:text-red-400">错误</summary>
      <pre className="mt-1 overflow-x-auto rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] whitespace-pre-wrap text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {message.content}
      </pre>
    </details>
  );
}

export function MessageList({
  messages,
  streaming,
  running,
}: {
  messages: Message[];
  streaming: string;
  running: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bottomRef.current;
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'end' });
    }
  }, [messages.length, streaming, running]);

  const empty = messages.length === 0 && streaming === '';

  return (
    <div
      data-testid="message-list"
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
      aria-label="消息流"
    >
      {empty && (
        <p data-testid="messages-empty" className="pt-6 text-center text-xs text-neutral-400 dark:text-neutral-600">
          发送第一条消息开始对话
        </p>
      )}
      {messages.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} data-testid={`msg-${m.id}`} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg rounded-br-sm bg-blue-600 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-white">
                {m.content}
              </div>
            </div>
          );
        }
        if (m.role === 'assistant') {
          return (
            <div key={m.id} data-testid={`msg-${m.id}`} className="flex justify-start">
              <div className="max-w-[92%] rounded-lg rounded-bl-sm border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-800/60">
                <MarkdownView>{m.content}</MarkdownView>
              </div>
            </div>
          );
        }
        if (m.role === 'event') return <EventBlock key={m.id} message={m} />;
        return <ErrorBlock key={m.id} message={m} />;
      })}

      {streaming !== '' && (
        <div className="flex justify-start">
          <div
            data-testid="streaming-bubble"
            className="max-w-[92%] rounded-lg rounded-bl-sm border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-800/60"
          >
            <MarkdownView>{streaming}</MarkdownView>
          </div>
        </div>
      )}

      {running && (
        <div data-testid="running-indicator" role="status" aria-label="会话运行中" className="flex items-center gap-1 px-1 py-0.5">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:300ms]" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
