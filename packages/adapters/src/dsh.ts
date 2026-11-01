import type { ModelInfo } from '@agentboard/shared';
import { collectOutput, resolveSpawnForm, resolveWindowsSpawnForm, spawnLineChild, whereCommand } from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, TurnResult, UnifiedEvent } from './types.js';

export const DSH_CMD = 'dsh';
/** 已适配的主次版本系列；runTurn 前校验，不符首轮明确报错。 */
export const DSH_SUPPORTED_SERIES = '0.2';

/** 计划钉死的静态模型清单（模型无 CLI flag，由 profile 配置决定）。 */
export const DSH_STATIC_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-flash', source: 'static' },
  { id: 'deepseek-v4-pro', source: 'static' },
];

export interface DshParseState {
  sessionId: string | null;
  sawTextDelta: boolean;
}

export function createDshParseState(): DshParseState {
  return { sessionId: null, sawTextDelta: false };
}

function stringifyInput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * 逐行解析 `dsh --profile headless <prompt> --json` 的 NDJSON 事件流
 * （接口契约：session / text / thinking / tool_call / tool_result / final）：
 * - `session` / `final` 的 `session_id` 即会话 id，首次取到即存，后续不覆盖；
 * - `text` 增量 → {type:'text', delta}；
 * - `thinking` 增量 → {type:'thinking', delta}（思考内容，服务端聚合为折叠块，不进聊天正文）；
 * - `tool_call` → {type:'tool', name, input}（input 对象 JSON 化）；`tool_result` 忽略（tool 事件已由 tool_call 发出）；
 * - `final` 完整段与增量去重：流里已有 text 增量则不再发 final 完整段（final 仅用于提取会话 id），
 *   全程无增量时 final 完整段兜底为一次 {type:'text', delta}；
 * - 非法 JSON / 空行 / 非对象 / 未知类型返回空数组（忽略）。
 */
export function parseDshLine(line: string, state: DshParseState): UnifiedEvent[] {
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
  if (rec.type === 'text' && typeof rec.text === 'string' && rec.text !== '') {
    state.sawTextDelta = true;
    events.push({ type: 'text', delta: rec.text });
  } else if (rec.type === 'thinking' && typeof rec.text === 'string' && rec.text !== '') {
    events.push({ type: 'thinking', delta: rec.text });
  } else if (rec.type === 'tool_call') {
    const name = typeof rec.name === 'string' && rec.name !== '' ? rec.name : 'tool';
    events.push({ type: 'tool', name, input: stringifyInput(rec.input) });
  } else if (rec.type === 'final' && typeof rec.text === 'string' && rec.text !== '' && !state.sawTextDelta) {
    state.sawTextDelta = true;
    events.push({ type: 'text', delta: rec.text });
  }
  return events;
}

/** 从 `dsh --version` 输出解析语义化版本号：行首 `dsh`/`v` 前缀可选的 X.Y.Z 段；无命中返回 null。 */
export function parseDshVersion(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.trim().match(/^(?:dsh\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    if (m) return m[1]!;
  }
  return null;
}

/** 主次版本是否在已适配系列（0.2.x）内。 */
export function isSupportedDshVersion(version: string): boolean {
  return version.startsWith(`${DSH_SUPPORTED_SERIES}.`);
}

async function detectDsh(): Promise<{ installed: boolean; version: string | null }> {
  const whereLines = await whereCommand(DSH_CMD);
  if (whereLines.length === 0) return { installed: false, version: null };
  const form = resolveWindowsSpawnForm(whereLines, DSH_CMD) ?? { cmd: DSH_CMD, prefix: [] as string[] };
  const { lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
  const version = parseDshVersion(lines);
  if (version) return { installed: true, version };
  const raw = lines.map((l) => l.trim()).find((l) => l !== '') ?? '';
  return { installed: true, version: raw || null };
}

export const dshAdapter: AgentAdapter = {
  id: 'dsh',
  displayName: 'DSH',
  supportsModelSelection: false,
  detect: detectDsh,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectDsh();
    if (!det.installed) return [];
    return DSH_STATIC_MODELS.map((m) => ({ ...m }));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死（接口契约）：dsh --profile headless <prompt> --json [--session-id <adapterSessionId>]；
    // 模型只读：model 参数被忽略，由 profile 配置决定（UI 已禁用选择，能力位 supportsModelSelection=false）；
    // 版本门禁：先探 `dsh --version`，主次版本 ≠ 0.2 时发 error 事件并以非零（1）结束，不 spawn 主进程。
    const args: string[] = ['--profile', 'headless', opts.prompt, '--json'];
    if (opts.adapterSessionId) args.push('--session-id', opts.adapterSessionId);

    const state = createDshParseState();
    const eventCbs: Array<(e: UnifiedEvent) => void> = [];
    let settled = false;
    let killed = false;
    let sawEvents = false;
    let probeChild: ReturnType<typeof spawnLineChild> | null = null;
    let mainChild: ReturnType<typeof spawnLineChild> | null = null;
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
      const tail = mainChild?.getStderrTail() ?? [];
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
      await Promise.resolve(); // 让调用方先注册 onEvent
      const form = await resolveSpawnForm(DSH_CMD);
      probeChild = spawnLineChild(form.cmd, [...form.prefix, '--version'], opts.cwd);
      const vlines: string[] = [];
      probeChild.onLine((_source, line) => {
        vlines.push(line);
      });
      await probeChild.exit;
      probeChild = null;
      if (killed) {
        finish(-1);
        return;
      }
      const version = parseDshVersion(vlines);
      if (version !== null && !isSupportedDshVersion(version)) {
        emit({ type: 'error', message: `dsh 版本 ${version} 不在已适配范围 0.2.x，接口可能已变更` });
        finish(1);
        return;
      }
      mainChild = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      mainChild.onLine((_source, line) => {
        for (const event of parseDshLine(line, state)) {
          sawEvents = true;
          emit(event);
        }
      });
      mainChild.onClose((code) => finish(code));
    })();

    return {
      onEvent(cb) {
        eventCbs.push(cb);
      },
      async kill() {
        killed = true;
        if (probeChild) await probeChild.kill();
        if (mainChild) await mainChild.kill();
      },
      result,
    };
  },
};
