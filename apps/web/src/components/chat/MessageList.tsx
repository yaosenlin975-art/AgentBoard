/**
 * 消息流渲染（设计 §7.5）：
 * - user 右侧蓝色气泡；assistant 无泡泡正文（直接铺排 markdown：无背景/边框/圆角容器，
 *   保留代码高亮）；event/error 折叠块（<details>）；
 *   event 按 content JSON 归类：kind==='thinking' → 「思考」折叠块（纯文本正文）；
 *   含 name/input → tool 块（摘要行显示工具名，正文 input 截断到 200 字符）；都不匹配按原文展示；
 * - 流式增量（streaming 非空）与历史 assistant 共用同一套正文容器（类名一致 → 落定不闪变）；
 * - 运行中底部三个跳动点；新内容自动滚到底。
 */
import { useEffect, useRef } from 'react';
import type { Message, SessionStatus } from '@agentboard/shared';
import { MarkdownView } from '../../lib/markdown';
import { useSessionTurns } from '../../state/turnStore';
import { PlanBar } from './PlanBar';
import { ToolResultCard } from './ToolResultCard';

/**
 * 用户消息里的 markdown 图片（CHAT-PASTE-IMAGE）：气泡仍按纯文本渲染，
 * 但 `![alt](url)` 要显示成缩略图——粘贴截图上传后插入的就是这种形态。
 */
const IMAGE_MD = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function renderUserContent(content: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  IMAGE_MD.lastIndex = 0;
  while ((match = IMAGE_MD.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before !== '') nodes.push(<span key={`t-${match.index}`}>{before}</span>);
    const url = match[1] ?? '';
    nodes.push(
      <img
        key={`img-${match.index}`}
        data-testid="msg-image"
        src={url}
        alt="粘贴的图片"
        className="max-h-40 max-w-full rounded border border-white/30 object-contain"
      />,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex === 0) return content;
  const tail = content.slice(lastIndex);
  if (tail !== '') nodes.push(<span key="t-tail">{tail}</span>);
  return nodes;
}

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

/**
 * AUDIT-3（F-05）：同一轮 assistant 回复的连续事件聚合成一个折叠块，
 * 汇总行只显示计数（「工具 12 次 · 思考 8 段」），默认收起，点开才逐条列明细。
 */
function EventGroup({ messages }: { messages: Message[] }) {
  let tools = 0;
  let thinking = 0;
  let raw = 0;
  for (const m of messages) {
    const parsed = parseEventContent(m.content);
    if (parsed.thinking !== null) thinking += 1;
    else if (parsed.tool !== null) tools += 1;
    else raw += 1;
  }
  const parts: string[] = [];
  if (tools > 0) parts.push(`工具 ${tools} 次`);
  if (thinking > 0) parts.push(`思考 ${thinking} 段`);
  if (raw > 0) parts.push(`事件 ${raw} 条`);
  return (
    <details
      data-testid={`event-group-${messages[0]!.id}`}
      className="my-1 max-w-full rounded border border-hairline bg-surface-raised px-2 py-1 text-xs"
    >
      <summary
        data-testid={`event-group-summary-${messages[0]!.id}`}
        className="cursor-pointer select-none text-ink-3 hover:text-ink"
      >
        {parts.join(' · ')}
      </summary>
      <div className="mt-1 space-y-0.5">
        {messages.map((m) => (
          <EventBlock key={m.id} message={m} />
        ))}
      </div>
    </details>
  );
}

/** AUDIT-SRV（F-04）：错误码 → 中文原因（服务端归类，前端只做展示映射） */
const ERROR_LABELS: Record<string, string> = {
  QUOTA_EXCEEDED: '额度已用尽',
  RATE_LIMITED: '请求被限流',
  AUTH_FAILED: '鉴权失败',
  CONTEXT_OVERFLOW: '上下文超限',
  UNKNOWN_ERROR: '未知错误',
};

/** 链接过长时截断显示（完整地址留在 title 悬浮层，避免把一段 OAuth/日志 URL 铺满卡片） */
const URL_RE = /https?:\/\/[^\s<>"'）)\]]+/g;

function truncateUrls(text: string, max = 64): string {
  return text.replace(URL_RE, (url) =>
    url.length <= max ? url : `${url.slice(0, max - 14)}…${url.slice(-12)}`,
  );
}

/** 整轮兜底文案：取该错误之前最近的一条 user 消息（原样再发一次，会重跑全部步骤） */
function findRetryText(messages: Message[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = messages[i]!;
    if (prev.role === 'user') return prev.content;
  }
  return null;
}

interface ErrorBlockProps {
  message: Message;
  retryText: string | null;
  onRetry?: (text: string) => void;
  onOpenModel?: () => void;
  onOpenUsage?: () => void;
}

function ErrorBlock({ message, retryText, onRetry, onOpenModel, onOpenUsage }: ErrorBlockProps) {
  const code = message.error_code ?? 'UNKNOWN_ERROR';
  const label = ERROR_LABELS[code] ?? ERROR_LABELS.UNKNOWN_ERROR!;
  const retryable = message.retryable === true;
  const isQuota = code === 'QUOTA_EXCEEDED';
  // 额度/限流/未知才给「换模型」入口；用量入口只对额度类有意义（其余错误看用量无帮助）
  const showModel = isQuota || code === 'RATE_LIMITED' || code === 'UNKNOWN_ERROR';
  return (
    <div
      data-testid={`error-block-${message.id}`}
      className="my-1 max-w-full rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs dark:border-red-900 dark:bg-red-950/40"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-red-600 px-1 py-0.5 text-[10px] font-medium text-white dark:bg-red-700">错误</span>
        <span data-testid={`error-code-${message.id}`} className="font-medium text-red-700 dark:text-red-300">
          {label}
        </span>
        {!retryable && (
          <span className="text-[10px] text-red-600/80 dark:text-red-400/80">重试前需先处理（额度/鉴权/上下文）</span>
        )}
      </div>
      <pre
        data-testid={`error-body-${message.id}`}
        title={message.content}
        className="mt-1 overflow-x-auto text-[11px] whitespace-pre-wrap text-red-700 dark:text-red-300"
      >
        {truncateUrls(message.content)}
      </pre>
      {(retryable || showModel || isQuota) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {retryable && retryText !== null && onRetry !== undefined && (
            <button
              type="button"
              data-testid={`error-retry-${message.id}`}
              onClick={() => onRetry(retryText)}
              title="整轮重试：重新发送上一条消息（会重新执行全部步骤）"
              className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              重发整轮
            </button>
          )}
          {retryable && (
            <span data-testid={`error-retry-hint-${message.id}`} className="text-[10px] text-red-600/80 dark:text-red-400/80">
              只想重跑失败的一步？在下方失败的步骤卡点「重试此步」
            </span>
          )}
          {showModel && onOpenModel !== undefined && (
            <button
              type="button"
              data-testid="error-switch-model"
              onClick={onOpenModel}
              title="修改当前会话模型（下一轮生效）"
              className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              切换模型
            </button>
          )}
          {isQuota && onOpenUsage !== undefined && (
            <button
              type="button"
              data-testid="error-open-usage"
              onClick={onOpenUsage}
              title="打开账号面板查看额度/用量"
              className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              查看用量
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** AUDIT-SRV（F-06）：原始编码在写入前就已损坏（U+FFFD / 连续 ???），清洗不可逆，只做标记 */
function EncodingLostBadge({ messageId }: { messageId: string }) {
  return (
    <span
      data-testid={`encoding-lost-${messageId}`}
      title="正文含替换字符或连续问号，原始编码在入库前已不可用，无法还原"
      className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
    >
      原始编码不可用
    </span>
  );
}

export function MessageList({
  messages,
  streaming,
  running,
  sessionStatus = null,
  onRetry,
  onOpenModel,
  onOpenUsage,
}: {
  messages: Message[];
  streaming: string;
  running: boolean;
  /** CHAT-VIS1：会话状态只用于推导计划条 chip（`session_turn.state` 没有前端出口） */
  sessionStatus?: SessionStatus | null;
  /** AUDIT-SRV：错误卡片动作——重发上一条 user 消息 / 打开模型修改 / 打开账号用量面板 */
  onRetry?: (text: string) => void;
  onOpenModel?: () => void;
  onOpenUsage?: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bottomRef.current;
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'end' });
    }
  }, [messages.length, streaming, running]);

  const empty = messages.length === 0 && streaming === '';

  // CHAT-VIS1：轮次观测（只读投影）。只有收到过 `session.plan` 且 plan 非空的轮次才有计划条；
  // 历史轮次 / 无 tool 事件的轮次没有条目 → 不出条（与「无 turn 行」同降级）。
  const turns = useSessionTurns();

  /**
   * AUDIT-3（F-05）：连续 event 归入同一轮聚合块；user/assistant/error 仍各自独立成块。
   * CHAT-VIS1 在其**上层**加「一轮容器」：同一 `turn_id` 的连续消息包进一个容器，
   * 容器顶部挂该轮唯一的计划条（sticky 贴顶）；`turn_id` 为空或无观测条目的消息保持既有平铺结构
   * （验收 5：老消息零结构变化）。
   */
  const rows: React.ReactNode[] = [];
  let eventRun: Message[] = [];
  let turnCells: React.ReactNode[] = [];
  let turnId: string | null = null;
  const barRendered = new Set<string>();
  // 同一 turn 被别的 turn 打断后可能分成多段渲染：容器 key 必须带段序号，否则 React 报 duplicate key
  const turnSegments = new Map<string, number>();

  const pushCell = (node: React.ReactNode): void => {
    (turnId === null ? rows : turnCells).push(node);
  };
  const flushEvents = (): void => {
    if (eventRun.length === 0) return;
    pushCell(<EventGroup key={`evt-${eventRun[0]!.id}`} messages={eventRun} />);
    eventRun = [];
  };
  const closeTurn = (): void => {
    flushEvents();
    if (turnId !== null && turnCells.length > 0) {
      const id = turnId;
      const obs = turns.get(id);
      const bar =
        obs !== undefined && obs.plan.length > 0 && !barRendered.has(id) ? (
          <PlanBar
            key={`plan-${id}`}
            turnId={id}
            plan={obs.plan}
            currentIndex={obs.current_index}
            sessionStatus={sessionStatus}
          />
        ) : null;
      if (bar !== null) barRendered.add(id);
      const segment = turnSegments.get(id) ?? 0;
      turnSegments.set(id, segment + 1);
      rows.push(
        <div key={`turn-${id}-${segment}`} data-testid={`turn-group-${id}`} className="min-w-0 space-y-2">
          {bar}
          {turnCells}
        </div>,
      );
    }
    turnCells = [];
  };

  messages.forEach((m, index) => {
    const observed = m.turn_id !== undefined && m.turn_id !== null ? turns.get(m.turn_id) : undefined;
    const groupKey = observed !== undefined && observed.plan.length > 0 ? (m.turn_id as string) : null;
    if (groupKey !== turnId) {
      closeTurn();
      turnId = groupKey;
    }

    if (m.role === 'event') {
      // CHAT-VIS1：带产物元信息的工具事件 → 工具结果卡；纯思考/无元信息仍归 EventGroup 折叠（验收 3/5）
      if (m.meta_json !== undefined && m.meta_json !== null) {
        flushEvents();
        pushCell(<ToolResultCard key={`tool-${m.id}`} message={m} />);
      } else {
        eventRun.push(m);
      }
      return;
    }
    flushEvents();
    if (m.role === 'user') {
      pushCell(
        <div key={m.id} data-testid={`msg-${m.id}`} className="flex justify-end">
          <div className="max-w-[85%] space-y-1 rounded-lg rounded-br-sm bg-accent-soft px-2.5 py-1.5 text-xs text-ink whitespace-pre-wrap">
            {m.encoding_lost === true && <EncodingLostBadge messageId={m.id} />}
            {renderUserContent(m.content)}
          </div>
        </div>,
      );
      return;
    }
    if (m.role === 'assistant') {
      pushCell(
        <div key={m.id} data-testid={`msg-${m.id}`} className="flex min-w-0 justify-start">
          <div className="min-w-0 max-w-full flex-1">
            {m.encoding_lost === true && <EncodingLostBadge messageId={m.id} />}
            <MarkdownView>{m.content}</MarkdownView>
          </div>
        </div>,
      );
      return;
    }
    pushCell(
      <ErrorBlock
        key={m.id}
        message={m}
        retryText={findRetryText(messages, index)}
        onRetry={onRetry}
        onOpenModel={onOpenModel}
        onOpenUsage={onOpenUsage}
      />,
    );
  });
  closeTurn();

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
      {rows}

      {streaming !== '' && (
        <div data-testid="streaming-bubble" className="flex min-w-0 justify-start">
          <div className="min-w-0 max-w-full flex-1">
            <MarkdownView>{streaming}</MarkdownView>
          </div>
        </div>
      )}

      {running && (
        <div data-testid="running-indicator" role="status" aria-label="会话运行中" className="flex items-center gap-1 px-1 py-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-3/70" />
          <span className="h-1.5 w-1.5 rounded-full bg-ink-3/45" />
          <span className="h-1.5 w-1.5 rounded-full bg-ink-3/25" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
