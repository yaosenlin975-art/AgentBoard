/**
 * CHAT-VIS1：工具结果卡 + 文件级 diff。
 *
 * 只在 `message.meta_json` 非空（= CHAT-TURN1 服务端给这条 tool 观测落过元信息）时渲染；
 * 纯思考 / 无产物事件继续走 `EventGroup` 折叠，`meta_json IS NULL` 的历史消息完全走旧渲染（验收 5）。
 *
 * 数据来源与局限（不要在此之上伪造）：
 * - `duration_ms` = 服务端墙钟、`status` = 「该步期间有没有 error / 轮次是否非零退出」，不是 CLI 的工具返回值；
 * - `output_summary` / `diff` 由后续执行器侧卡填真值，本卡读到 null 时显示占位文案，不编造内容；
 * - 没有「打开 git」的端点：footer 的 `在 git 里看 ↗` 退化为复制 `git diff -- <path>`；
 * - CHAT-RETRY2：`failed` 且轮次已收口的步骤卡提供「重试此步」，只调服务端单步重试端点，
 *   不重发整轮；是否真的可重试由服务端 ledger 判定（409 文案原样展示，前端不推断 retryable）。
 */
import { useRef, useState } from 'react';
import type { Message, MessageDiffFile } from '@agentboard/shared';
import { ApiError } from '../../api/client';
import { useRetryFailedStep, useTurnObservation } from '../../state/turnStore';
import {
  classifyDiffLine,
  formatDuration,
  gitDiffCommand,
  retryFailureText,
  retryStepGate,
  retryableAfterAttempt,
  singleLine,
} from '../../lib/turnView';

/** 工具名：event 正文的 `name` 优先，其次 step_id，最后兜底「工具」 */
function toolNameOf(message: Message): string {
  try {
    const parsed = JSON.parse(message.content) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name !== '') return parsed.name;
  } catch {
    // 非 JSON 正文（历史/异常形态）走兜底键
  }
  return message.step_id ?? '工具';
}

/** 工具输入摘要（无 output_summary 时的兜底正文，沿用既有 200 字符口径） */
function toolInputOf(message: Message): string {
  try {
    const parsed = JSON.parse(message.content) as { input?: unknown };
    return typeof parsed.input === 'string' ? parsed.input : '';
  } catch {
    return message.content;
  }
}

const DIFF_LINE_CLASS: Record<ReturnType<typeof classifyDiffLine>, string> = {
  add: 'ab-diff-add',
  del: 'ab-diff-del',
  hunk: 'text-accent',
  meta: 'text-ink-3',
  ctx: 'text-ink-2',
};

export interface DiffBlockProps {
  messageId: string;
  index: number;
  file: MessageDiffFile;
}

/** 单个文件的 diff：默认折叠到文件级（路径 + `+N −M`），点开才铺行级 patch */
export function DiffBlock({ messageId, index, file }: DiffBlockProps) {
  const [open, setOpen] = useState(false);
  const lines = (file.patch ?? '').split('\n').filter((line, i, all) => !(line === '' && i === all.length - 1));
  const noPatch = file.patch === null || file.patch === '';

  return (
    <div data-testid={`diff-file-wrap-${messageId}-${index}`} data-file={file.path} className="min-w-0">
      <button
        type="button"
        data-testid={`diff-file-${messageId}-${index}`}
        data-add={file.add}
        data-del={file.del}
        aria-expanded={open}
        aria-controls={`diff-body-${messageId}-${index}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span title={file.path} className="min-w-0 flex-1 truncate text-ink-2">
          {file.path}
        </span>
        {/* data-add / data-del 让「+N −M 与 meta_json.diff.files 一致」可机器判定 */}
        <span data-add={file.add} className="shrink-0 text-ab-add">
          +{file.add}
        </span>
        <span data-del={file.del} className="shrink-0 text-ab-del">
          −{file.del}
        </span>
        <span aria-hidden="true" className="shrink-0 text-ink-3">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open &&
        (noPatch ? (
          <p
            data-testid={`diff-empty-${messageId}-${index}`}
            className="px-2 py-1 text-[11px] text-ink-3"
          >
            无 diff 视图（服务端未落 patch）· 可复制 {gitDiffCommand(file.path)}
          </p>
        ) : (
          <pre
            id={`diff-body-${messageId}-${index}`}
            data-testid={`diff-body-${messageId}-${index}`}
            className="mt-0.5 overflow-x-auto rounded border border-hairline bg-surface-card px-2 py-1 text-[11px] leading-4"
          >
            {lines.map((line, i) => (
              <span key={i} className={`block whitespace-pre ${DIFF_LINE_CLASS[classifyDiffLine(line)]}`}>
                {line === '' ? ' ' : line}
              </span>
            ))}
            {file.truncated === true && (
              <span data-testid={`diff-truncated-${messageId}-${index}`} className="block text-ink-3">
                … patch 已截断，完整内容看 git
              </span>
            )}
          </pre>
        ))}
    </div>
  );
}

export function ToolResultCard({ message }: { message: Message }) {
  // hooks 必须早于任何 return（坏元信息时同样保持调用顺序）
  const [open, setOpen] = useState(true);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  /** 服务端判死的重试原因（409 后置位：按钮变 disabled，直到该卡卸载） */
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  /** 连点护栏：同一张卡上同一时刻只允许一次重试请求（幂等键由服务端兜底，前端不多发一次） */
  const retryInFlight = useRef(false);
  const turn = useTurnObservation(message.turn_id);
  const retry = useRetryFailedStep(message.session_id);
  const meta = message.meta_json;
  // 调用方已保证 meta 非空；这里再兜一层，坏元信息不得炸消息列表
  if (meta === null || meta === undefined) return null;
  const name = toolNameOf(message);
  const files = meta.diff?.files ?? [];
  const summary = singleLine(meta.output_summary ?? '');
  const fallback = singleLine(toolInputOf(message));
  const shownSummary = summary === '' ? (fallback === '' ? '无输出摘要' : `输入：${fallback}`) : summary;
  const ok = meta.status === 'ok';
  const firstPath = files[0]?.path ?? null;
  const gate = retryStepGate(turn, message.step_id);
  const retryDisabled = retry.isPending || blockedReason !== null || !gate.enabled;

  const runRetry = (): void => {
    if (retryInFlight.current || retry.isPending) return;
    if (message.turn_id === null || message.turn_id === undefined) return;
    if (message.step_id === null || message.step_id === undefined) return;
    retryInFlight.current = true;
    setRetryNote(null);
    retry.mutate(
      { turnId: message.turn_id, stepId: message.step_id },
      {
        onSuccess: (result) => {
          // 服务端 ledger 是唯一依据：重试后仍不可重试 → 直接禁用并给原因
          setBlockedReason(retryableAfterAttempt(result.ledger.retryable));
          setRetryNote(
            result.turn.state === 'done'
              ? '该步重试成功'
              : result.turn.awaiting_json?.reason === 'step_retry_incomplete'
                ? '该步已重试成功，但其余步骤未执行'
                : '该步重试后仍失败',
          );
        },
        onError: (error) => {
          const text = retryFailureText(error);
          setRetryNote(text);
          // 409 不静默：可判「不可重试」的机器码同时把按钮置灰
          if (
            error instanceof ApiError &&
            (error.code === 'STEP_NOT_RETRYABLE' ||
              error.code === 'STEP_NOT_FAILED' ||
              error.code === 'STEP_RETRY_IN_FLIGHT')
          ) {
            setBlockedReason(text);
          }
        },
        onSettled: () => {
          retryInFlight.current = false;
        },
      },
    );
  };

  const copyGitCommand = (): void => {
    const command = gitDiffCommand(firstPath);
    try {
      void navigator.clipboard?.writeText(command);
      setCopyHint(`已复制 ${command}`);
    } catch {
      setCopyHint(command);
    }
  };

  return (
    <div
      data-testid={`tool-card-${message.id}`}
      data-status={meta.status}
      className="my-1 max-w-full rounded border border-hairline bg-surface-card"
    >
      <button
        type="button"
        data-testid={`tool-head-${message.id}`}
        aria-expanded={open}
        aria-controls={`tool-body-${message.id}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-wrap items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span
          data-testid={`tool-mark-${message.id}`}
          aria-hidden="true"
          className={`shrink-0 font-medium ${ok ? 'text-ab-add' : 'text-ab-del'}`}
        >
          {ok ? '✓' : '✕'}
        </span>
        <span data-testid={`tool-name-${message.id}`} className="shrink-0 font-medium text-ink">
          {name}
        </span>
        <span data-testid={`tool-duration-${message.id}`} className="shrink-0 text-ink-3">
          {formatDuration(meta.duration_ms)}
        </span>
        <span
          data-testid={`tool-summary-${message.id}`}
          title={shownSummary}
          className="min-w-0 flex-1 truncate text-ink-2"
        >
          {shownSummary}
        </span>
        <span aria-hidden="true" className="shrink-0 text-ink-3">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          id={`tool-body-${message.id}`}
          data-testid={`tool-body-${message.id}`}
          className="min-w-0 space-y-0.5 border-t border-hairline px-1 py-1"
        >
          {files.length > 0 ? (
            files.map((file, index) => (
              <DiffBlock key={`${file.path}-${index}`} messageId={message.id} index={index} file={file} />
            ))
          ) : (
            <pre className="overflow-x-auto rounded border border-hairline bg-surface-page px-2 py-1 text-[11px] whitespace-pre-wrap">
              {singleLine(toolInputOf(message), 200) === '' ? '无产物' : singleLine(toolInputOf(message), 200)}
            </pre>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1 pt-0.5 text-[11px]">
            <span data-testid={`tool-step-${message.id}`} className="shrink-0 text-ink-3">
              步骤 {meta.tool_call_id ?? '—'}
            </span>
            <button
              type="button"
              data-testid={`git-open-${message.id}`}
              onClick={copyGitCommand}
              title={firstPath === null ? '复制 git diff 命令' : `复制 ${gitDiffCommand(firstPath)}`}
              className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-accent hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              在 git 里看 ↗
            </button>
            {copyHint !== null && (
              <span data-testid={`git-hint-${message.id}`} role="status" className="min-w-0 truncate text-ink-3">
                {copyHint}
              </span>
            )}
            {!ok && (
              <button
                type="button"
                data-testid={`retry-step-${message.id}`}
                disabled={retryDisabled}
                aria-disabled={retryDisabled}
                title={gate.reason ?? blockedReason ?? '只重跑该失败步骤，不重发整轮'}
                onClick={runRetry}
                className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-accent hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent"
              >
                {retry.isPending ? '重试中…' : '重试此步'}
              </button>
            )}
            {retryNote !== null && (
              <span
                data-testid={`retry-step-note-${message.id}`}
                role="status"
                className="min-w-0 truncate text-ink-2"
              >
                {retryNote}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
