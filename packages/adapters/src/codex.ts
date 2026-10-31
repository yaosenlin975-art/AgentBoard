import type { ModelInfo } from '@agentboard/shared';
import {
  collectOutput,
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  spawnLineChild,
  whereCommand,
} from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, TurnResult, UnifiedEvent } from './types.js';

export const CODEX_CMD = 'codex';

/**
 * codex-cli 0.165.0 无模型枚举子命令（models 管理器为内部模块，`codex --help` 无 models 列表），
 * 故为纯静态清单兜底；计划钉死至少含 gpt-5-codex。
 */
export const CODEX_STATIC_MODELS: ModelInfo[] = [
  { id: 'gpt-5-codex', source: 'static' },
  { id: 'gpt-5', source: 'static' },
];

export interface CodexParseState {
  sessionId: string | null;
}

export function createCodexParseState(): CodexParseState {
  return { sessionId: null };
}

function stringifyInput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * 逐行解析 `codex exec --json` 的 JSONL 事件流（codex-cli 0.165.0 实测形态）：
 * - `thread.started` 的 `thread_id` 即会话 id，首次取到即存，后续行不覆盖；
 * - `item.completed` 按 `item.type` 归一：agent_message→text、error→error、
 *   command_execution / mcp_tool_call / file_change / web_search→tool；
 * - `turn.started` / `turn.completed`、`item.started` / `item.updated`、reasoning、todo_list 忽略
 *   （agent_message 终值随 item.completed 到达，若再消费 updated 会造成重复增量）；
 * - 顶层 `error`（含重连提示等瞬态消息）与 `turn.failed` 归一为 error 事件；
 * - 非法 JSON / 空行 / 非对象 JSON 返回空数组（忽略）。
 */
export function parseCodexLine(line: string, state: CodexParseState): UnifiedEvent[] {
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
  if (
    state.sessionId === null &&
    rec.type === 'thread.started' &&
    typeof rec.thread_id === 'string' &&
    rec.thread_id !== ''
  ) {
    state.sessionId = rec.thread_id;
  }

  const events: UnifiedEvent[] = [];
  if (rec.type === 'error' && typeof rec.message === 'string') {
    events.push({ type: 'error', message: rec.message });
    return events;
  }
  if (rec.type === 'turn.failed') {
    const err = rec.error;
    const message =
      err !== null &&
      typeof err === 'object' &&
      !Array.isArray(err) &&
      typeof (err as Record<string, unknown>).message === 'string'
        ? ((err as Record<string, unknown>).message as string)
        : 'codex turn failed';
    events.push({ type: 'error', message });
    return events;
  }
  if (rec.type !== 'item.completed') return events;
  const item = rec.item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return events;
  const it = item as Record<string, unknown>;
  if (it.type === 'agent_message' && typeof it.text === 'string' && it.text !== '') {
    events.push({ type: 'text', delta: it.text });
  } else if (it.type === 'error' && typeof it.message === 'string') {
    events.push({ type: 'error', message: it.message });
  } else if (it.type === 'command_execution') {
    events.push({ type: 'tool', name: 'command_execution', input: stringifyInput(it.command) });
  } else if (it.type === 'mcp_tool_call') {
    events.push({
      type: 'tool',
      name: typeof it.tool === 'string' && it.tool !== '' ? it.tool : 'mcp_tool_call',
      input: stringifyInput(it.arguments),
    });
  } else if (it.type === 'file_change') {
    events.push({ type: 'tool', name: 'file_change', input: stringifyInput(it.changes) });
  } else if (it.type === 'web_search') {
    events.push({ type: 'tool', name: 'web_search', input: stringifyInput(it.query) });
  }
  return events;
}

async function detectCodex(): Promise<{ installed: boolean; version: string | null }> {
  const whereLines = await whereCommand(CODEX_CMD);
  if (whereLines.length === 0) return { installed: false, version: null };
  const form = resolveWindowsSpawnForm(whereLines, CODEX_CMD) ?? { cmd: CODEX_CMD, prefix: [] as string[] };
  const { lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
  const version = lines.map((l) => l.trim()).find((l) => l !== '') ?? '';
  return { installed: true, version: version || null };
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  detect: detectCodex,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectCodex();
    if (!det.installed) return [];
    return CODEX_STATIC_MODELS.map((m) => ({ ...m }));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死（codex-cli 0.165.0 实测）：codex exec <prompt> --json [--model <model>]；
    // resume 走子命令 `codex exec resume <adapterSessionId> <prompt>`。
    // 追加 --skip-git-repo-check：工作空间可为任意目录，非 git 仓库时 exec 默认直接报错退出；
    // win32 下 .cmd/.bat 垫片经 resolveSpawnForm 解析为 cmd.exe /d /s /c 包装（与 opencode/dsh 一致）。
    const args: string[] = ['exec'];
    if (opts.adapterSessionId) args.push('resume', opts.adapterSessionId);
    args.push(opts.prompt, '--json');
    if (opts.model) args.push('--model', opts.model);
    args.push('--skip-git-repo-check');

    const state = createCodexParseState();
    const eventCbs: Array<(e: UnifiedEvent) => void> = [];
    let settled = false;
    let killed = false;
    let child: ReturnType<typeof spawnLineChild> | null = null;
    let resolveResult!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
      resolveResult = resolve;
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? -1; // 被 kill（信号终止）无退出码，归一为 -1
      for (const cb of eventCbs) cb({ type: 'end', exitCode });
      resolveResult({ exitCode, adapterSessionId: state.sessionId });
    };

    void (async () => {
      const form = await resolveSpawnForm(CODEX_CMD);
      if (killed) {
        finish(-1);
        return;
      }
      child = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      child.onLine((_source, line) => {
        for (const event of parseCodexLine(line, state)) {
          for (const cb of eventCbs) cb(event);
        }
      });
      child.onClose((code) => finish(code));
    })();

    return {
      onEvent(cb) {
        eventCbs.push(cb);
      },
      async kill() {
        killed = true;
        await child?.kill();
      },
      result,
    };
  },
};
