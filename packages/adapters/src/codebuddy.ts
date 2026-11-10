import type { ModelInfo } from '@agentboard/shared';
import { readFileSync } from 'node:fs';
import {
  collectOutput,
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  spawnLineChild,
  whereCommand,
} from './spawn.js';
import type { AgentAdapter, AskOption, RunTurnOptions, TurnHandle, UnifiedEvent } from './types.js';
import { createTurnRunner } from './turnRunner.js';
import { assertImageInputSupported } from './imageInput.js';
import { probeCliCapabilities, resolvePermissionArgs } from './capabilityProbe.js';

export const CODEBUDDY_CMD = 'codebuddy';
const VERIFIED_IMAGE_CLI_VERSION = '2.179.2';
const VERIFIED_IMAGE_MODEL = 'minimax-m3.1-flash';

/** 精确白名单：只有这些 tool_use 工具名升级为 ask 事件，其余 tool_use 仍走普通 tool 事件 */
export const ASK_TOOL_NAMES: ReadonlySet<string> = new Set(['AskUserQuestion']);
/**
 * CHAT-ASK-DEFER：本机 codebuddy 2.179.2 会把 AskUserQuestion 当「延迟工具」派发，
 * stdout 里 tool_use 名是 DeferExecuteTool，入参 `{toolName:'AskUserQuestion', params:{question,options}}`。
 * 这类块同样归一为 ask 事件（否则真机永远等不到 ask）。
 */
const DEFERRED_TOOL_NAME = 'DeferExecuteTool';

export type AskAnswerErrorCode =
  | 'TURN_ENDED'
  | 'UNKNOWN_ASK'
  | 'ALREADY_ANSWERED'
  | 'STDIN_UNAVAILABLE'
  | 'STDIN_WRITE_FAILED';

/** ask 回答回填被拒的明确错误（code 供调用方分支，message 可直接展示） */
export class AskAnswerError extends Error {
  readonly code: AskAnswerErrorCode;
  constructor(code: AskAnswerErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'AskAnswerError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function supportsCodebuddyImageInput(model: string | undefined, cliVersion?: string | null): boolean {
  return cliVersion === VERIFIED_IMAGE_CLI_VERSION && model === VERIFIED_IMAGE_MODEL;
}

export interface CodebuddyParseState {
  sessionId: string | null;
  /** 当前 assistant 消息是否已通过 stream_event 增量输出过正文（用于抑制末尾完整 assistant 的重复正文） */
  sawTextDelta: boolean;
  /** 本轮已解析出的提问序号：tool_use 无 id 时据此生成稳定 request_id */
  askSeq: number;
}

export function createParseState(): CodebuddyParseState {
  return { sessionId: null, sawTextDelta: false, askSeq: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAskOptions(value: unknown): AskOption[] {
  if (!Array.isArray(value)) return [];
  const options: AskOption[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item !== '') options.push({ label: item });
      continue;
    }
    const rec = asRecord(item);
    if (rec === null || typeof rec.label !== 'string' || rec.label === '') continue;
    const option: AskOption = { label: rec.label };
    if (typeof rec.description === 'string' && rec.description !== '') option.description = rec.description;
    options.push(option);
  }
  return options;
}

/**
 * deferred 形态识别：`DeferExecuteTool{toolName:'AskUserQuestion', params:{question,options}}`
 * → 伪造一个 tool_use 块（id 沿用外层 id，input 换成 params），供 parseAskEvent 复用。
 * 非 deferred 或 toolName 不是提问工具时返回 null（继续走普通 tool 事件）。
 */
function asDeferredAskBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block.name !== DEFERRED_TOOL_NAME) return null;
  const input = asRecord(block.input);
  if (input === null) return null;
  const toolName = typeof input.toolName === 'string' ? input.toolName : '';
  // 兼容 MCP 前缀（mcp__server__AskUserQuestion）与直接裸名两种写法
  const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  if (!ASK_TOOL_NAMES.has(toolName) && !ASK_TOOL_NAMES.has(bare)) return null;
  const params = asRecord(input.params) ?? input;
  return { id: block.id, input: params };
}

/**
 * 把 AskUserQuestion 的 tool_use 块归一为 ask 事件。
 * 兼容 `{questions:[{question, options}]}` 与扁平 `{question, options}` 两种入参（取第一问）。
 * request_id 优先用 tool_use 块的 id（回答时据此定位），缺失时用本轮提问序号兜底。
 */
function parseAskEvent(
  block: Record<string, unknown>,
  messageId: string | null,
  askSeq: number,
): UnifiedEvent {
  const input = asRecord(block.input) ?? {};
  const questions = input.questions;
  const first = Array.isArray(questions) && questions.length > 0 ? asRecord(questions[0]) : input;
  const question = first !== null && typeof first.question === 'string' ? first.question : '';
  const options = parseAskOptions((first !== null ? first.options : undefined) ?? input.options);
  const requestId = typeof block.id === 'string' && block.id !== '' ? block.id : `ask-${askSeq}`;
  return { type: 'ask', request_id: requestId, question, options, step_id: messageId };
}

/**
 * 逐行解析 stdout JSON 流：非法 JSON / 空行 / 无法识别的行返回空数组（忽略）；
 * session_id 首次取到即存，后续行不覆盖（vibe-kanban claude.rs extract_session_id 模式）。
 * 两条来源：
 * - `stream_event`（`--output-format stream-json --include-partial-messages`）：content_block_delta 的
 *   text_delta/thinking_delta → 真增量；message_start 重置本消息的增量标记；
 * - `assistant`：整条消息（老格式/无增量时）→ text/tool_use 块；已发过增量时跳过正文，避免同段
 *   正文被服务端聚合两次（sessionManager 按 delta 累加成一条 assistant）。
 */
export function parseCodebuddyLine(line: string, state: CodebuddyParseState): UnifiedEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const rec = obj as Record<string, unknown>;
  if (state.sessionId === null && typeof rec.session_id === 'string' && rec.session_id !== '') {
    state.sessionId = rec.session_id;
  }

  const events: UnifiedEvent[] = [];
  if (rec.type === 'stream_event') {
    const raw = rec.event;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const ev = raw as Record<string, unknown>;
      if (ev.type === 'message_start') {
        state.sawTextDelta = false;
      } else if (ev.type === 'content_block_delta') {
        const rawDelta = ev.delta;
        if (rawDelta !== null && typeof rawDelta === 'object' && !Array.isArray(rawDelta)) {
          const delta = rawDelta as Record<string, unknown>;
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
            state.sawTextDelta = true;
            events.push({ type: 'text', delta: delta.text });
          } else if (
            delta.type === 'thinking_delta' &&
            typeof delta.thinking === 'string' &&
            delta.thinking !== ''
          ) {
            events.push({ type: 'thinking', delta: delta.thinking });
          }
        }
      }
    }
  } else if (rec.type === 'assistant') {
    const message = asRecord(rec.message);
    const content = message?.content;
    const messageId =
      message !== null && typeof message.id === 'string' && message.id !== '' ? message.id : null;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
          if (!state.sawTextDelta) events.push({ type: 'text', delta: b.text });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const deferredAsk = asDeferredAskBlock(b);
          if (deferredAsk !== null) {
            state.askSeq += 1;
            events.push(parseAskEvent(deferredAsk, messageId, state.askSeq));
          } else if (ASK_TOOL_NAMES.has(b.name)) {
            state.askSeq += 1;
            events.push(parseAskEvent(b, messageId, state.askSeq));
          } else {
            const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? null);
            events.push({ type: 'tool', name: b.name, input });
          }
        }
      }
    }
  } else if (rec.type === 'text' && typeof rec.text === 'string' && rec.text !== '') {
    events.push({ type: 'text', delta: rec.text });
  } else if (rec.type === 'error' && typeof rec.message === 'string') {
    events.push({ type: 'error', message: rec.message });
  }
  return events;
}

async function detectCodebuddy(): Promise<{ installed: boolean; version: string | null }> {
  const whereLines = await whereCommand(CODEBUDDY_CMD);
  if (whereLines.length === 0) return { installed: false, version: null };
  const form = resolveWindowsSpawnForm(whereLines, CODEBUDDY_CMD) ?? { cmd: CODEBUDDY_CMD, prefix: [] as string[] };
  const { code, lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
  if (code !== 0) return { installed: true, version: null };
  const version = lines.map((l) => l.trim()).find((l) => l !== '') ?? '';
  return { installed: true, version: version || null };
}

const MODEL_LIST_RE = /--model\s+<model>[^\n]*?\(([^)]*)\)/;

/** 从 `codebuddy --help` 的 --model 说明行提取静态模型清单；查不到返回空数组（UI 手输兜底）。 */
export function extractStaticModels(helpText: string): ModelInfo[] {
  const match = helpText.match(MODEL_LIST_RE);
  if (!match) return [];
  const list = match[1] ?? '';
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((id) => ({ id, source: 'static' as const }));
}

export const codebuddyAdapter: AgentAdapter = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  supportsModelSelection: true,
  supportsImageInput(model: string | undefined, cliVersion?: string | null): boolean {
    return supportsCodebuddyImageInput(model, cliVersion);
  },
  detect: detectCodebuddy,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectCodebuddy();
    if (!det.installed) return [];
    const form = await resolveSpawnForm(CODEBUDDY_CMD);
    const { lines } = await collectOutput(form.cmd, [...form.prefix, '--help']);
    return extractStaticModels(lines.join('\n'));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死：codebuddy -p <prompt> [--model <model>] [--resume <adapterSessionId>]
    //   --output-format stream-json --verbose --include-partial-messages（无图片）
    //   --output-format stream-json --input-format stream-json --verbose（有图片；stdin 保持可写以便 ask 回填）
    // 参数数组直传不经 shell（spawnLineChild 内 shell:false）；
    // win32 下 .cmd/.bat 垫片经 resolveSpawnForm 解析为 cmd.exe /d /s /c 包装（与 opencode/dsh 一致）。
    // 非图片轮次必须走 stream-json：`--output-format json` 输出的是 pretty-print 的整段 JSON 数组，
    // 逐行解析取不到任何事件（正文静默丢失）；--include-partial-messages 提供真增量 text_delta。
    // persona/工具管控注入（flag 名以本机 codebuddy 2.179.2 --help 实测为准，camel/kebab 经 CLI 解析器验证）：
    //   persona：personaInjection 非 off/file（含未设置，按 auto 语义）→ --append-system-prompt <body>（单 argv 直传）；
    //   工具管控与 persona 注入解耦：非 off（含 file）→ allow 非空 --allowedTools <逗号清单>，deny 非空 --disallowedTools；
    //   权限档位：approval_mode 非 inherit 且注入未全关 → 经 capabilityProbe 确认 --permission-mode 后按映射追加（见下）。
    const hasImages = (opts.attachments?.length ?? 0) > 0;
    assertImageInputSupported(opts, supportsCodebuddyImageInput);
    const stdinText = hasImages
      ? `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              ...opts.attachments!.map((attachment) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: attachment.mimeType,
                  data: readFileSync(attachment.path).toString('base64'),
                },
              })),
            ],
          },
        })}\n`
      : undefined;
    const args: string[] = ['-p'];
    if (!hasImages) args.push(opts.prompt);
    if (opts.model) args.push('--model', opts.model);
    if (opts.adapterSessionId) args.push('--resume', opts.adapterSessionId);
    if (opts.persona && opts.personaInjection !== 'off' && opts.personaInjection !== 'file') {
      args.push('--append-system-prompt', opts.persona.body);
    }
    if (opts.toolPolicy && opts.personaInjection !== 'off') {
      if (opts.toolPolicy.allow.length > 0) args.push('--allowedTools', opts.toolPolicy.allow.join(','));
      if (opts.toolPolicy.deny.length > 0) args.push('--disallowedTools', opts.toolPolicy.deny.join(','));
    }
    if (hasImages) {
      args.push('--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose');
    } else {
      args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    }

    const state = createParseState();
    // 提问回填只在 stream-json 输入模式（--input-format stream-json）可用；其余轮次 stdin 未开放
    const streamJsonInput = hasImages;
    const pendingAsks = new Set<string>();
    const answeredAsks = new Set<string>();
    let sawAssistantText = false;
    const runner = createTurnRunner({
      sessionId: () => state.sessionId,
      onFinish: ({ code }) => {
        // 图片轮次 exit 0 但无模型文本 → 视为失败，并给出可读原因
        const noImageResult = hasImages && code === 0 && !sawAssistantText;
        if (!noImageResult) return;
        return { exitCode: -1, errors: ['图片输入轮次未返回模型文本结果'] };
      },
    });

    void (async () => {
      const form = await resolveSpawnForm(CODEBUDDY_CMD);
      if (runner.isKilled()) {
        runner.finish(-1);
        return;
      }
      // 权限档位注入（探测 5s 超时/失败=不传）：approval_mode 非 inherit 且注入未全关才探测，
      // help 未确认权限 flag 名时映射返回空数组（不猜 flag）
      if (
        opts.toolPolicy &&
        opts.personaInjection !== 'off' &&
        opts.toolPolicy.approval_mode !== 'inherit'
      ) {
        const caps = await probeCliCapabilities(CODEBUDDY_CMD);
        args.push(...resolvePermissionArgs(opts.toolPolicy.approval_mode, caps));
      }
      if (runner.isKilled()) {
        runner.finish(-1);
        return;
      }
      const child = spawnLineChild(
        form.cmd,
        [...form.prefix, ...args],
        opts.cwd,
        stdinText === undefined ? undefined : { stdinText, keepStdinOpen: streamJsonInput },
      );
      runner.bindChild(child);
      child.onLine((_source, line) => {
        for (const event of parseCodebuddyLine(line, state)) {
          runner.markEvent();
          if (event.type === 'text') sawAssistantText = true;
          // 提问只登记一次；轮次已结束时不再登记（回填入口以 TURN_ENDED 拒绝）
          if (event.type === 'ask' && !runner.isSettled()) pendingAsks.add(event.request_id);
          runner.emit(event);
        }
      });
      child.onClose((code) => runner.finish(code));
    })();

    return {
      onEvent: runner.onEvent,
      async answer(requestId: string, answer: string): Promise<void> {
        if (runner.isSettled()) {
          throw new AskAnswerError('TURN_ENDED', `本轮已结束，无法回填提问 ${requestId} 的回答`);
        }
        if (!streamJsonInput) {
          throw new AskAnswerError(
            'STDIN_UNAVAILABLE',
            '当前轮次未开启 stream-json stdin 输入，无法回填回答',
          );
        }
        if (answeredAsks.has(requestId)) {
          throw new AskAnswerError('ALREADY_ANSWERED', `提问 ${requestId} 已回填过，不能重复回答`);
        }
        if (!pendingAsks.has(requestId)) {
          throw new AskAnswerError('UNKNOWN_ASK', `未知或已过期的提问 request_id：${requestId}`);
        }
        const child = runner.getChild();
        if (child === null) {
          throw new AskAnswerError('STDIN_UNAVAILABLE', '子进程尚未就绪，无法回填回答');
        }
        // 客户端协议：回答以 user 消息的 tool_result 块写回 stdin（与提问 tool_use 的 id 对应）
        const payload = `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: requestId, content: answer }],
          },
        })}\n`;
        try {
          await child.writeStdin(payload);
        } catch (err) {
          const cause = err instanceof Error ? err : new Error(String(err));
          throw new AskAnswerError('STDIN_WRITE_FAILED', `回答写入子进程 stdin 失败：${cause.message}`, cause);
        }
        pendingAsks.delete(requestId);
        answeredAsks.add(requestId);
      },
      kill: () => runner.kill(),
      result: runner.result,
    };
  },
};
