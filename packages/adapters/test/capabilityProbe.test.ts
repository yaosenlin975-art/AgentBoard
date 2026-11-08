import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asChild, makeAutoChild, makeFakeChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import {
  parseCliHelp,
  probeCliCapabilities,
  resetCapabilityProbeCache,
} from '../src/capabilityProbe.js';

const MOCK_EXE = 'C:\\mock\\bin\\probe-cli.exe';

// fixture 1：与 codebuddy 2.179.2 实测 --help 关键行同构（camelCase 工具 flag + kebab persona/权限 flag）
const HELP_WITH_FLAGS = [
  'Usage: probe-cli [options] [command] [prompt]',
  '  --append-system-prompt <prompt>                  Append additional content to the system prompt',
  '  --allowedTools <tools...>                        Comma or space-separated list of tool names to allow',
  '  --disallowedTools <tools...>                     Comma or space-separated list of tool names to deny',
  '  --permission-mode <mode>                         Default permission mode for this process (choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto)',
].join('\n');

// fixture 2：不含任何注入相关 flag 的 help 文本
const HELP_WITHOUT_FLAGS = [
  'Usage: probe-cli [options] [prompt]',
  '  --model <model>                                  Model for the current session.',
  '  --verbose                                        Verbose output',
].join('\n');

describe('parseCliHelp', () => {
  it('含各 flag 的 help 文本 → personaFlag/toolFlags true，permissionFlags 收原始名', () => {
    expect(parseCliHelp(HELP_WITH_FLAGS)).toEqual({
      personaFlag: true,
      toolFlags: true,
      permissionFlags: ['--permission-mode'],
    });
  });

  it('kebab 变体 --allowed-tools/--disallowed-tools 同样命中 toolFlags（camel/kebab 兼容）', () => {
    const kebab = [
      '  --append-system-prompt <prompt>  Append to the system prompt',
      '  --allowed-tools <tools...>       Tools to allow',
      '  --disallowed-tools <tools...>    Tools to deny',
    ].join('\n');
    const caps = parseCliHelp(kebab);
    expect(caps.personaFlag).toBe(true);
    expect(caps.toolFlags).toBe(true);
    expect(caps.permissionFlags).toEqual([]);
  });

  it('不含各 flag 的 help 文本 → 全 false / 空列表', () => {
    expect(parseCliHelp(HELP_WITHOUT_FLAGS)).toEqual({
      personaFlag: false,
      toolFlags: false,
      permissionFlags: [],
    });
  });

  it('权限候选命中多个/部分时按候选顺序原样列出', () => {
    const text = [
      '  --approval-policy <policy>   Approval policy',
      '  --permission-prompt-tool <t> Permission prompt tool',
    ].join('\n');
    expect(parseCliHelp(text).permissionFlags).toEqual(['--approval-policy', '--permission-prompt-tool']);
  });
});

describe('probeCliCapabilities', () => {
  beforeEach(() => resetCapabilityProbeCache());

  /** 探针：where/which 返回 exe 命中行；--help 子进程按给定文本自动输出并退出 */
  function probeSpawns(helpText: string, helpExitCode = 0): { helpSpawnCount: () => number } {
    let helpSpawns = 0;
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args.includes('--help')) {
        helpSpawns += 1;
        return asChild(makeAutoChild([{ source: 'stdout', text: helpText }], helpExitCode));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);
    return { helpSpawnCount: () => helpSpawns };
  }

  it('实跑 --help 解析能力集；TTL 内复用缓存不再 spawn，reset 后重探', async () => {
    const { helpSpawnCount } = probeSpawns(HELP_WITH_FLAGS);

    const caps1 = await probeCliCapabilities('cache-cli');
    expect(caps1).toEqual({ personaFlag: true, toolFlags: true, permissionFlags: ['--permission-mode'] });

    const caps2 = await probeCliCapabilities('cache-cli');
    expect(helpSpawnCount()).toBe(1); // 缓存命中，未再次 spawn --help
    expect(caps2).toBe(caps1); // 缓存返回同一结果对象

    resetCapabilityProbeCache();
    await probeCliCapabilities('cache-cli');
    expect(helpSpawnCount()).toBe(2); // reset 后重新探测
  });

  it('--help 非零退出但有输出 → 仍按输出解析（输出即证据）', async () => {
    probeSpawns(HELP_WITH_FLAGS, 1);
    await expect(probeCliCapabilities('nonzero-cli')).resolves.toEqual({
      personaFlag: true,
      toolFlags: true,
      permissionFlags: ['--permission-mode'],
    });
  });

  it('spawn 失败（ENOENT）→ 全 false', async () => {
    setSpawnFn(((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([], 1)); // where/which 都查不到
      }
      const child = makeFakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return asChild(child);
    }) as unknown as SpawnFn);

    await expect(probeCliCapabilities('broken-cli')).resolves.toEqual({
      personaFlag: false,
      toolFlags: false,
      permissionFlags: [],
    });
  });

  it('子进程挂起不退出 → 5s 超时全 false 并 kill', async () => {
    vi.useFakeTimers();
    try {
      setSpawnFn(((cmd: string) => {
        if (cmd === 'where' || cmd === 'which') {
          return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
        }
        return asChild(makeFakeChild()); // 永不退出
      }) as unknown as SpawnFn);

      const pending = probeCliCapabilities('hang-cli');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toEqual({ personaFlag: false, toolFlags: false, permissionFlags: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
