import type { ModelInfo } from '@agentboard/shared';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  collectOutput,
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  spawnLineChild,
  whereCommand,
} from './spawn.js';
import type { AgentAdapter, RunTurnOptions, TurnHandle, UnifiedEvent } from './types.js';
import { createTurnRunner } from './turnRunner.js';
import { cachedImageFlag, helpMentionsFlag, imageFlagKey, rememberImageFlag } from './imageFlags.js';
import { assertImageInputSupported } from './imageInput.js';

export const CODEX_CMD = 'codex';

/**
 * codex-cli 0.165.0 无模型枚举子命令（models 管理器为内部模块，`codex --help` 无 models 列表），
 * 故为纯静态清单兜底；计划钉死至少含 gpt-5-codex。
 */
export const CODEX_STATIC_MODELS: ModelInfo[] = [
  { id: 'gpt-5-codex', source: 'static' },
  { id: 'gpt-5', source: 'static' },
];

/** Codex 模型目录直接取 `models`；OpenAI 兼容 provider 取 `data`。 */
export function parseCodexModelCatalog(text: string): ModelInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const root = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const models = Array.isArray(root?.models)
    ? root.models
    : Array.isArray(root?.data)
      ? root.data
      : undefined;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const result: ModelInfo[] = [];
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const model = item as Record<string, unknown>;
    const providerModel =
      typeof model.id === 'string' &&
      (model.object === undefined || model.object === 'model') &&
      (model.visibility === undefined || model.visibility === 'list') &&
      model.supported_in_api !== false;
    if (model.visibility !== undefined && model.visibility !== 'list') continue;
    if (model.supported_in_api === false) continue;
    const id = providerModel
      ? (model.id as string).trim()
      : typeof model.slug === 'string'
        ? model.slug.trim()
        : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, source: 'probed' });
  }
  return result;
}

export interface CodexProviderConfig {
  baseUrl: string;
  bearerToken?: string;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 只读当前 `model_provider` 指向的本机 provider；完整 TOML 解析交给 Codex。 */
export function parseCodexProviderConfig(text: string): CodexProviderConfig | null {
  const provider = /^\s*model_provider\s*=\s*([^\r\n#]+)/m.exec(text)?.[1];
  if (provider === undefined) return null;
  const providerName = unquoteToml(provider);
  const section = new RegExp(`^\\s*\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'm');
  const start = section.exec(text)?.index;
  if (start === undefined) return null;
  const rest = text.slice(start).split(/\r?\n/).slice(1);
  const body: string[] = [];
  for (const line of rest) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  const baseUrl = /^\s*base_url\s*=\s*([^\r\n#]+)/m.exec(body.join('\n'))?.[1];
  if (baseUrl === undefined) return null;
  const bearer = /^\s*(?:experimental_bearer_token|api_key)\s*=\s*([^\r\n#]+)/m.exec(body.join('\n'))?.[1];
  return {
    baseUrl: unquoteToml(baseUrl),
    ...(bearer === undefined ? {} : { bearerToken: unquoteToml(bearer) }),
  };
}

function isLocalProviderUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      url.protocol === 'http:' &&
      (host === 'localhost' ||
        host === '::1' ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host))
    );
  } catch {
    return false;
  }
}

async function readCodexProviderConfig(env: NodeJS.ProcessEnv = process.env): Promise<CodexProviderConfig | null> {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  let text: string;
  try {
    text = await readFile(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const config = parseCodexProviderConfig(text);
  return config !== null && isLocalProviderUrl(config.baseUrl) ? config : null;
}

export async function fetchProviderModels(
  config: CodexProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.bearerToken === undefined ? {} : { Authorization: `Bearer ${config.bearerToken}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return parseCodexModelCatalog(await response.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

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
 * - `item.completed` 按 `item.type` 归一：agent_message→text、reasoning→thinking（text 摘要字段，
 *   与 agent_message 同为终值路径，无重复风险；无文本字段不映射）、error→error、
 *   command_execution / mcp_tool_call / file_change / web_search→tool；
 * - `turn.started` / `turn.completed`、`item.started` / `item.updated`（含 reasoning 中间态）、
 *   `item.completed` 的 todo_list 忽略
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
  } else if (it.type === 'reasoning' && typeof it.text === 'string' && it.text !== '') {
    events.push({ type: 'thinking', delta: it.text });
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
  // CHAT-IMG-ADAPTER：图片能力靠 `codex exec --help` 实测（本机 0.166.0 有 `-i, --image <FILE>...`），
  // 探测不到 `--image` 就按不支持处理——不写死 true，也不猜版本区间。
  try {
    const help = await collectOutput(form.cmd, [...form.prefix, 'exec', '--help']);
    rememberImageFlag(imageFlagKey('codex', version || null), helpMentionsFlag(help.lines.join('\n'), '--image'));
  } catch {
    rememberImageFlag(imageFlagKey('codex', version || null), false);
  }
  return { installed: true, version: version || null };
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  supportsModelSelection: true,
  /** `codex exec --json` JSONL 按 item 整段输出，块级非逐字 */
  streaming: 'block',
  /** 只有 `codex exec --help` 实测到 `--image` 才为真（见 detectCodex 的探测与缓存） */
  supportsImageInput(_model: string | undefined, cliVersion?: string | null): boolean {
    return cachedImageFlag(imageFlagKey('codex', cliVersion));
  },
  detect: detectCodex,
  async listModels(): Promise<ModelInfo[]> {
    const det = await detectCodex();
    if (!det.installed) return [];
    const provider = await readCodexProviderConfig();
    if (provider !== null) {
      const models = await fetchProviderModels(provider);
      if (models.length > 0) return models;
    }
    const form = resolveWindowsSpawnForm(await whereCommand(CODEX_CMD), CODEX_CMD) ?? { cmd: CODEX_CMD, prefix: [] as string[] };
    try {
      const result = await collectOutput(form.cmd, [...form.prefix, 'debug', 'models']);
      const models = result.code === 0 ? parseCodexModelCatalog(result.lines.join('\n')) : [];
      if (models.length > 0) return models;
    } catch {
      // Keep the adapter usable when a custom catalog is broken or this Codex build has no debug command.
    }
    return CODEX_STATIC_MODELS.map((m) => ({ ...m }));
  },
  runTurn(opts: RunTurnOptions): TurnHandle {
    assertImageInputSupported(opts, this.supportsImageInput);
    // 行为钉死（codex-cli 0.165.0 实测）：codex exec <prompt> --json [--model <model>]；
    // resume 走子命令 `codex exec resume <adapterSessionId> <prompt>`。
    // 追加 --skip-git-repo-check：工作空间可为任意目录，非 git 仓库时 exec 默认直接报错退出；
    // win32 下 .cmd/.bat 垫片经 resolveSpawnForm 解析为 cmd.exe /d /s /c 包装（与 opencode/dsh 一致）。
    const args: string[] = ['exec'];
    if (opts.adapterSessionId) args.push('resume', opts.adapterSessionId);
    args.push(opts.prompt, '--json');
    if (opts.model) args.push('--model', opts.model);
    args.push('--skip-git-repo-check');
    // CHAT-IMG-ADAPTER：图片走 `-i <FILE>`（`codex exec --help` 实测），每张一个 -i
    for (const attachment of opts.attachments ?? []) args.push('-i', attachment.path);

    const state = createCodexParseState();
    const runner = createTurnRunner({ sessionId: () => state.sessionId });

    void (async () => {
      const form = await resolveSpawnForm(CODEX_CMD);
      if (runner.isKilled()) {
        runner.finish(-1);
        return;
      }
      const child = spawnLineChild(form.cmd, [...form.prefix, ...args], opts.cwd);
      runner.bindChild(child);
      child.onLine((_source, line) => {
        for (const event of parseCodexLine(line, state)) {
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
