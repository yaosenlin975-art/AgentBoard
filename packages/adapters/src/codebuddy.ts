import type { ModelInfo } from '@agentboard/shared';
import {
  collectOutput,
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  spawnLineChild,
  whereCommand,
} from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, TurnResult, UnifiedEvent } from './types.js';

export const CODEBUDDY_CMD = 'codebuddy';

export interface CodebuddyParseState {
  sessionId: string | null;
}

export function createParseState(): CodebuddyParseState {
  return { sessionId: null };
}

/**
 * 逐行解析 stdout JSON 流：非法 JSON / 空行 / 无法识别的行返回空数组（忽略）；
 * session_id 首次取到即存，后续行不覆盖（vibe-kanban claude.rs extract_session_id 模式）。
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
  if (rec.type === 'assistant') {
    const message = rec.message;
    const content =
      message !== null && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
          events.push({ type: 'text', delta: b.text });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? null);
          events.push({ type: 'tool', name: b.name, input });
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
  const { lines } = await collectOutput(form.cmd, [...form.prefix, '--version']);
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
  detect: detectCodebuddy,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectCodebuddy();
    if (!det.installed) return [];
    const form = await resolveSpawnForm(CODEBUDDY_CMD);
    const { lines } = await collectOutput(form.cmd, [...form.prefix, '--help']);
    return extractStaticModels(lines.join('\n'));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死：codebuddy -p <prompt> [--model <model>] [--resume <adapterSessionId>] --output-format json
    // 参数数组直传不经 shell（spawnLineChild 内 shell:false）；
    // win32 下 .cmd/.bat 垫片经 resolveSpawnForm 解析为 cmd.exe /d /s /c 包装（与 opencode/dsh 一致）。
    const args: string[] = ['-p', opts.prompt];
    if (opts.model) args.push('--model', opts.model);
    if (opts.adapterSessionId) args.push('--resume', opts.adapterSessionId);
    args.push('--output-format', 'json');

    const state = createParseState();
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
      const form = await resolveSpawnForm(CODEBUDDY_CMD);
      if (killed) {
        finish(-1);
        return;
      }
      child = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      child.onLine((_source, line) => {
        for (const event of parseCodebuddyLine(line, state)) {
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
