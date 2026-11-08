import type { SessionToolPolicy } from './types.js';
import { resolveSpawnForm, spawnLineChild } from './spawn.js';

/** CLI 能力探测结果：help 文本中确认的注入相关能力 */
export interface CliCapabilities {
  /** --append-system-prompt 是否存在 */
  personaFlag: boolean;
  /** 工具管控 flag 是否成对存在（--allowedTools/--allowed-tools 与 --disallowedTools/--disallowed-tools，camel/kebab 均算命中） */
  toolFlags: boolean;
  /** 权限类 flag 命中的原始名列表（如 ['--permission-mode']） */
  permissionFlags: string[];
}

/** --help 探测超时（ms）：超时/spawn 失败/无输出一律视为能力全无 */
export const PROBE_TIMEOUT_MS = 5000;

/** 探测结果缓存 TTL（ms） */
const PROBE_CACHE_TTL_MS = 60_000;

const PERSONA_FLAG_RE = /--append-system-prompt\b/;
const ALLOWED_TOOLS_RE = /--allowed-?tools\b/i;
const DISALLOWED_TOOLS_RE = /--disallowed-?tools\b/i;
/** 权限类 flag 候选名：help 文本命中者原样收入 permissionFlags */
const PERMISSION_FLAG_CANDIDATES: readonly string[] = [
  '--permission-mode',
  '--approval-policy',
  '--permission-prompt-tool',
];

const EMPTY_CAPABILITIES: CliCapabilities = { personaFlag: false, toolFlags: false, permissionFlags: [] };

/** 解析 help 文本 → 能力集（纯函数，可单测）；无命中的能力一律 false/空 */
export function parseCliHelp(text: string): CliCapabilities {
  return {
    personaFlag: PERSONA_FLAG_RE.test(text),
    toolFlags: ALLOWED_TOOLS_RE.test(text) && DISALLOWED_TOOLS_RE.test(text),
    permissionFlags: PERMISSION_FLAG_CANDIDATES.filter((flag) => text.includes(flag)),
  };
}

/**
 * approval_mode → 权限 flag 映射；flag 名与 value 均以本机 codebuddy 2.179.2 实测
 * `--permission-mode` choices（acceptEdits, bypassPermissions, default, plan, dontAsk, auto）为据。
 */
const APPROVAL_MODE_PERMISSION_ARGS: Record<
  Exclude<SessionToolPolicy['approval_mode'], 'inherit'>,
  { flag: string; value: string }
> = {
  plan: { flag: '--permission-mode', value: 'plan' },
  acceptEdits: { flag: '--permission-mode', value: 'acceptEdits' },
  bypass: { flag: '--permission-mode', value: 'bypassPermissions' },
};

/** approval_mode → argv 片段；'inherit' 或探测未确认对应权限 flag 名时不传（返回空数组） */
export function resolvePermissionArgs(
  mode: SessionToolPolicy['approval_mode'],
  caps: CliCapabilities,
): string[] {
  if (mode === 'inherit') return [];
  const mapped = APPROVAL_MODE_PERMISSION_ARGS[mode];
  if (!caps.permissionFlags.includes(mapped.flag)) return [];
  return [mapped.flag, mapped.value];
}

interface ProbeCacheEntry {
  caps: CliCapabilities;
  expires: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeUncached(command: string): Promise<CliCapabilities> {
  try {
    // win32 下 npm 垫片须经 resolveSpawnForm 解析（cmd.exe /d /s /c 包装或 node 直跑），否则 ENOENT/EINVAL
    const form = await resolveSpawnForm(command);
    const child = spawnLineChild(form.cmd, [...form.prefix, '--help'], process.cwd());
    const lines: string[] = [];
    child.onLine((_source, line) => lines.push(line));
    const outcome = await Promise.race([
      Promise.race([child.exit, child.failure]).then((settled) => ({ timedOut: false as const, settled })),
      delay(PROBE_TIMEOUT_MS).then(() => ({ timedOut: true as const })),
    ]);
    if (outcome.timedOut) {
      void child.kill();
      return EMPTY_CAPABILITIES;
    }
    // spawn 失败（ENOENT/EACCES）→ 全 false；非零退出但有 help 输出仍按输出解析（输出即证据）
    if (outcome.settled instanceof Error) return EMPTY_CAPABILITIES;
    const text = lines.join('\n');
    return text === '' ? EMPTY_CAPABILITIES : parseCliHelp(text);
  } catch {
    return EMPTY_CAPABILITIES;
  }
}

/** 探测 CLI 能力：spawn `<command> --help`（5s 超时），结果按逻辑命令名缓存 60s */
export async function probeCliCapabilities(command: string): Promise<CliCapabilities> {
  const cached = probeCache.get(command);
  if (cached && cached.expires > Date.now()) return cached.caps;
  const caps = await probeUncached(command);
  probeCache.set(command, { caps, expires: Date.now() + PROBE_CACHE_TTL_MS });
  return caps;
}

/** 测试注入点：清空探测缓存 */
export function resetCapabilityProbeCache(): void {
  probeCache.clear();
}
