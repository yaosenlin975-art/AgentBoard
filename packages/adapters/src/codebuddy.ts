import type { ModelInfo } from '@agentboard/shared';
import { spawnLineChild } from './spawn.js';
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

async function collectOutput(cmd: string, args: string[]): Promise<{ code: number | null; lines: string[] }> {
  const child = spawnLineChild(cmd, args, process.cwd());
  const lines: string[] = [];
  child.onLine((_source, line) => {
    lines.push(line);
  });
  const code = await child.exit;
  return { code, lines };
}

async function commandExists(cmd: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const primary = await collectOutput(finder, [cmd]);
  if (primary.code === 0) return true;
  if (process.platform === 'win32') {
    // where 失败回退 which（Git Bash 环境）
    const fallback = await collectOutput('which', [cmd]);
    return fallback.code === 0;
  }
  return false;
}

async function detectCodebuddy(): Promise<{ installed: boolean; version: string | null }> {
  if (!(await commandExists(CODEBUDDY_CMD))) return { installed: false, version: null };
  const { lines } = await collectOutput(CODEBUDDY_CMD, ['--version']);
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
    const { lines } = await collectOutput(CODEBUDDY_CMD, ['--help']);
    return extractStaticModels(lines.join('\n'));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    // 行为钉死：codebuddy -p <prompt> [--model <model>] [--resume <adapterSessionId>] --output-format json
    // 参数数组直传不经 shell（spawnLineChild 内 shell:false）
    const args: string[] = ['-p', opts.prompt];
    if (opts.model) args.push('--model', opts.model);
    if (opts.adapterSessionId) args.push('--resume', opts.adapterSessionId);
    args.push('--output-format', 'json');

    const child = spawnLineChild(CODEBUDDY_CMD, args, opts.cwd);
    const state = createParseState();
    const eventCbs: Array<(e: UnifiedEvent) => void> = [];
    let settled = false;
    let resolveResult!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
      resolveResult = resolve;
    });

    child.onLine((_source, line) => {
      for (const event of parseCodebuddyLine(line, state)) {
        for (const cb of eventCbs) cb(event);
      }
    });
    child.onClose((code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? -1; // 被 kill（信号终止）无退出码，归一为 -1
      for (const cb of eventCbs) cb({ type: 'end', exitCode });
      resolveResult({ exitCode, adapterSessionId: state.sessionId });
    });

    return {
      onEvent(cb) {
        eventCbs.push(cb);
      },
      kill: () => child.kill(),
      result,
    };
  },
};
