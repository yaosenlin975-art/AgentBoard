import type { ModelInfo } from '@agentboard/shared';
import { collectOutput, resolveSpawnForm, resolveWindowsSpawnForm, spawnLineChild, whereCommand } from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, TurnResult, UnifiedEvent } from './types.js';

export const OPENCODE_CMD = 'opencode';

export interface OpencodeParseState {
  sessionId: string | null;
}

export function createOpencodeParseState(): OpencodeParseState {
  return { sessionId: null };
}

function stringifyInput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * 逐行解析 `opencode run --format json` 的 JSONL 事件流（opencode v2.2.0 实测形态）：
 * 每行 `{type, timestamp, sessionID, part}`；顶层 `sessionID` 即会话 id，首次取到即存，后续行不覆盖；
 * - `text` → part.text（每个 part 一次性输出完整文本，非流式增量），归一为 {type:'text', delta}；
 * - `tool_use` → part.tool + part.state.input，归一为 {type:'tool', name, input}（input 对象 JSON 化）；
 * - `error` → error.message（error 为字符串时取原值），归一为 {type:'error', message}；
 * - `step_start` / `step_finish` 等其余类型忽略；
 * - 非法 JSON / 空行 / 非对象 JSON 返回空数组（忽略）。
 */
export function parseOpencodeLine(line: string, state: OpencodeParseState): UnifiedEvent[] {
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
  if (state.sessionId === null && typeof rec.sessionID === 'string' && rec.sessionID !== '') {
    state.sessionId = rec.sessionID;
  }

  const events: UnifiedEvent[] = [];
  const part = rec.part;
  const p =
    part !== null && typeof part === 'object' && !Array.isArray(part)
      ? (part as Record<string, unknown>)
      : undefined;
  if (rec.type === 'text' && p && typeof p.text === 'string' && p.text !== '') {
    events.push({ type: 'text', delta: p.text });
  } else if (rec.type === 'tool_use' && p) {
    const name = typeof p.tool === 'string' && p.tool !== '' ? p.tool : 'tool';
    const st = p.state;
    const input =
      st !== null && typeof st === 'object' && !Array.isArray(st)
        ? (st as Record<string, unknown>).input
        : undefined;
    events.push({ type: 'tool', name, input: stringifyInput(input) });
  } else if (rec.type === 'error') {
    const err = rec.error;
    const message =
      typeof err === 'string'
        ? err
        : err !== null &&
            typeof err === 'object' &&
            !Array.isArray(err) &&
            typeof (err as Record<string, unknown>).message === 'string'
          ? ((err as Record<string, unknown>).message as string)
          : 'opencode error';
    events.push({ type: 'error', message });
  }
  return events;
}

async function detectOpencode(): Promise<{ installed: boolean; version: string | null }> {
  const whereLines = await whereCommand(OPENCODE_CMD);
  if (whereLines.length === 0) return { installed: false, version: null };
  const form = resolveWindowsSpawnForm(whereLines, OPENCODE_CMD) ?? { cmd: OPENCODE_CMD, prefix: [] as string[] };
  const { lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
  const version = lines.map((l) => l.trim()).find((l) => l !== '') ?? '';
  return { installed: true, version: version || null };
}

/** `opencode models` 纯文本行解析：provider/model 形态的行 → source:'probed'；无命中返回空数组。 */
export function parseModelLines(lines: string[]): ModelInfo[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => /^[^\s]+\/[^\s]+$/.test(l))
    .map((id) => ({ id, source: 'probed' as const }));
}

/** `opencode models --format json` 输出为 JSON 字符串数组时提取 id；否则 null（回退纯文本解析）。 */
export function tryParseModelsJson(lines: string[]): string[] | null {
  const text = lines.join('\n').trim();
  if (text === '') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(obj) && obj.every((x) => typeof x === 'string')) return obj as string[];
  return null;
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  detect: detectOpencode,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectOpencode();
    if (!det.installed) return [];
    // 与 detectOpencode/runTurn 一致：先解析 spawn 形态再调 collectOutput
    // （win32 .cmd/.bat 垫片必须走解析后的 cmd/prefix，裸 'opencode' 直接 spawn 必 ENOENT）。
    const form = await resolveSpawnForm(OPENCODE_CMD);
    // 计划钉死先试 `opencode models --format json`；实测 v2.2.0 该 flag 不被 models 支持（打印 help，exit 0），
    // JSON 解析失败回退纯文本 `opencode models` 的 provider/model 行；两步都无命中返回空数组（UI 手输兜底）。
    const jsonRes = await collectOutput(form.cmd, [...form.prefix, 'models', '--format', 'json']);
    const fromJson = tryParseModelsJson(jsonRes.lines);
    if (fromJson && fromJson.length > 0) {
      return fromJson.map((id) => ({ id, source: 'probed' as const }));
    }
    const plain = await collectOutput(form.cmd, [...form.prefix, 'models']);
    return parseModelLines(plain.lines);
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死（opencode v2.2.0 实测）：opencode run <prompt> --format json [-m <provider/model>] [-s <sessionId>]；
    // resume flag 以 `opencode run --help` 实测为准：--session, -s（实测 -s <id> 续接上下文有效）；
    // 模型格式 provider/model（#variant 可选）。参数数组直传不经 shell；win32 下 .cmd 垫片经 cmd.exe /d /s /c 包装。
    const args: string[] = ['run', opts.prompt, '--format', 'json'];
    if (opts.model) args.push('-m', opts.model);
    if (opts.adapterSessionId) args.push('-s', opts.adapterSessionId);

    const state = createOpencodeParseState();
    const eventCbs: Array<(e: UnifiedEvent) => void> = [];
    let settled = false;
    let killed = false;
    let sawEvents = false;
    let child: ReturnType<typeof spawnLineChild> | null = null;
    let resolveResult!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
      resolveResult = resolve;
    });

    const emit = (e: UnifiedEvent) => {
      for (const cb of eventCbs) cb(e);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? -1; // 被 kill（信号终止）无退出码，归一为 -1
      const tail = child?.getStderrTail() ?? [];
      // 排障诊断：非零退出，或 exit 0 但零事件且无 session id（stderr 有内容才发），
      // 在 end 之前发一条 error 事件，避免真实 CLI 静默失败无法定位
      if (
        tail.length > 0 &&
        (exitCode !== 0 || (!sawEvents && state.sessionId === null))
      ) {
        emit({ type: 'error', message: `适配器未捕获到结构化输出；stderr 尾部：\n${tail.join('\n')}` });
      }
      emit({ type: 'end', exitCode });
      const turnResult: TurnResult = { exitCode, adapterSessionId: state.sessionId };
      if (tail.length > 0) turnResult.stderrTail = tail;
      resolveResult(turnResult);
    };

    void (async () => {
      const form = await resolveSpawnForm(OPENCODE_CMD);
      if (killed) {
        finish(-1);
        return;
      }
      child = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      child.onLine((_source, line) => {
        for (const event of parseOpencodeLine(line, state)) {
          sawEvents = true;
          emit(event);
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
