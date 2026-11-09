import type { ModelInfo } from '@agentboard/shared';
import { collectOutput, resolveSpawnForm, resolveWindowsSpawnForm, spawnLineChild, whereCommand } from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, UnifiedEvent } from './types.js';
import { createTurnRunner } from './turnRunner.js';
import { assertImageInputSupported } from './imageInput.js';

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

/** 不可用原因里的输出片段上限（避免把整段 loader 堆栈灌进 UI/日志） */
export const DSH_DETECT_REASON_LIMIT = 120;

async function detectDsh(): Promise<{ installed: boolean; version: string | null; message?: string }> {
  const whereLines = await whereCommand(DSH_CMD);
  if (whereLines.length === 0) return { installed: false, version: null, message: '未找到 dsh 命令（where/which 均无结果）' };
  const form = resolveWindowsSpawnForm(whereLines, DSH_CMD) ?? { cmd: DSH_CMD, prefix: [] as string[] };
  const { code, lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
  // 形状校验：只认 `dsh 0.2.x` 这类版本行；loader 报错/空输出一律判不可用，绝不把报错当版本回传
  const version = parseDshVersion(lines);
  if (version) return { installed: true, version };
  const raw = lines.map((l) => l.trim()).filter((l) => l !== '').join(' ').slice(0, DSH_DETECT_REASON_LIMIT);
  const exit = code === null ? '无退出码' : `exit ${code}`;
  const detail = raw === '' ? '无输出' : `输出异常（${raw}）`;
  return {
    installed: false,
    version: null,
    message: `dsh CLI 不可用：${detail}，${exit}；命令 ${[form.cmd, ...form.prefix, '--version'].join(' ')}`,
  };
}

export const dshAdapter: AgentAdapter = {
  id: 'dsh',
  displayName: 'DSH',
  supportsModelSelection: false,
  /**
   * CHAT-IMG-ADAPTER：**保持 false**。本机 `dsh` 只有 asar 打包形态（入口在
   * `.../app.asar/dsh/lib/bin.js`，shim 指向的文件不存在），`--help` 拿不到稳定输出，
   * 无法实测是否存在图片入参；按「探测不到就当不支持」处理，等 dsh 提供可执行的 CLI 入口再开。
   */
  supportsImageInput(): boolean { return false; },
  detect: detectDsh,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectDsh();
    if (!det.installed) return [];
    return DSH_STATIC_MODELS.map((m) => ({ ...m }));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    assertImageInputSupported(opts, this.supportsImageInput);
    // 行为钉死（接口契约）：dsh --profile headless <prompt> --json [--session-id <adapterSessionId>]；
    // 模型只读：model 参数被忽略，由 profile 配置决定（UI 已禁用选择，能力位 supportsModelSelection=false）；
    // 版本门禁：先探 `dsh --version`，主次版本 ≠ 0.2 时发 error 事件并以非零（1）结束，不 spawn 主进程。
    const args: string[] = ['--profile', 'headless', opts.prompt, '--json'];
    if (opts.adapterSessionId) args.push('--session-id', opts.adapterSessionId);

    const state = createDshParseState();
    const runner = createTurnRunner({ sessionId: () => state.sessionId });

    void (async () => {
      await Promise.resolve(); // 让调用方先注册 onEvent
      const form = await resolveSpawnForm(DSH_CMD);
      const probeChild = spawnLineChild(form.cmd, [...form.prefix, '--version'], opts.cwd);
      runner.bindKillTarget(probeChild);
      const vlines: string[] = [];
      probeChild.onLine((_source, line) => {
        vlines.push(line);
      });
      await probeChild.exit;
      if (runner.isKilled()) {
        runner.finish(-1);
        return;
      }
      const version = parseDshVersion(vlines);
      if (version !== null && !isSupportedDshVersion(version)) {
        runner.emit({ type: 'error', message: `dsh 版本 ${version} 不在已适配范围 0.2.x，接口可能已变更` });
        runner.finish(1);
        return;
      }
      const child = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      runner.bindChild(child);
      child.onLine((_source, line) => {
        for (const event of parseDshLine(line, state)) {
          runner.markEvent();
          runner.emit(event);
        }
      });
      child.onClose((code) => runner.finish(code));
    })();

    return {
      onEvent: runner.onEvent,
      kill: () => runner.kill(),
      result: runner.result,
    };
  },
};
