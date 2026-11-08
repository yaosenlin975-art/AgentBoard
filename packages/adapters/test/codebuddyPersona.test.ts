import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asChild, makeAutoChild, makeFakeChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import { codebuddyAdapter } from '../src/codebuddy.js';
import { resetCapabilityProbeCache } from '../src/capabilityProbe.js';
import type { RunTurnOptions, SessionPersona, SessionToolPolicy } from '../src/types.js';

const MOCK_EXE = 'C:\\mock\\bin\\codebuddy.exe';

// help fixture 关键行取自本机 codebuddy 2.179.2 实跑 --help（camelCase 工具 flag、kebab persona/权限 flag）
const HELP_WITH_PERMISSION_LINES = [
  'Usage: codebuddy [options] [command] [prompt]',
  '  --append-system-prompt <prompt>                  Append additional content to the system prompt',
  '  --allowedTools <tools...>                        Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")',
  '  --disallowedTools <tools...>                     Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")',
  '  --permission-mode <mode>                         Default permission mode for this process (choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto)',
];
const HELP_WITH_PERMISSION_MODE = HELP_WITH_PERMISSION_LINES.join('\n');
const HELP_WITHOUT_PERMISSION_MODE = HELP_WITH_PERMISSION_LINES.filter(
  (l) => !l.includes('--permission-mode'),
).join('\n');

interface RecordedSpawn {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

/** runTurn 探针：where/which 返回 exe 命中行；--help 输出给定 help 文本；其余记录并返回挂起假进程 */
function recordSpawns(helpText: string): { calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  setSpawnFn(((cmd: string, args: string[], options: unknown) => {
    calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
    if (cmd === 'where' || cmd === 'which') {
      return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
    }
    if (args.includes('--help')) {
      return asChild(makeAutoChild([{ source: 'stdout', text: helpText }], 0));
    }
    return asChild(makeFakeChild());
  }) as unknown as SpawnFn);
  return { calls };
}

const turnSpawns = (calls: RecordedSpawn[]) => calls.filter((c) => c.args[0] === '-p');
const waitForTurn = async (calls: RecordedSpawn[], count: number) => {
  await vi.waitFor(() => expect(turnSpawns(calls)).toHaveLength(count));
};

const PERSONA: SessionPersona = { id: 'persona-1', body: '你是资深代码审查员', source: 'user' };
const TOOL_POLICY_INHERIT: SessionToolPolicy = {
  approval_mode: 'inherit',
  allow: ['Bash', 'Edit'],
  deny: ['Write'],
};

describe('codebuddy runTurn persona/toolPolicy/权限档位装配', () => {
  beforeEach(() => resetCapabilityProbeCache());

  it('persona 注入：未设置 personaInjection（auto 语义）与显式 flag 均追加 --append-system-prompt <body>（单 argv）', async () => {
    const { calls } = recordSpawns(HELP_WITH_PERMISSION_MODE);

    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮', persona: PERSONA });
    await waitForTurn(calls, 1);
    expect(turnSpawns(calls)[0]!.args).toEqual([
      '-p', '第一轮', '--append-system-prompt', '你是资深代码审查员',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]);

    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第二轮', persona: PERSONA, personaInjection: 'flag' });
    await waitForTurn(calls, 2);
    expect(turnSpawns(calls)[1]!.args).toContain('你是资深代码审查员');
  });

  it('toolPolicy：allow/deny 逗号拼接传 --allowedTools/--disallowedTools；approval_mode=inherit 不追加权限 flag', async () => {
    const { calls } = recordSpawns(HELP_WITH_PERMISSION_MODE);

    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第三轮', toolPolicy: TOOL_POLICY_INHERIT });
    await waitForTurn(calls, 1);
    expect(turnSpawns(calls)[0]!.args).toEqual([
      '-p', '第三轮', '--allowedTools', 'Bash,Edit', '--disallowedTools', 'Write',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]);
  });

  it("personaInjection='off' 全无：persona/toolPolicy/权限 flag 一个都不传", async () => {
    const { calls } = recordSpawns(HELP_WITH_PERMISSION_MODE);

    codebuddyAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第四轮',
      persona: PERSONA,
      toolPolicy: { approval_mode: 'bypass', allow: ['Bash'], deny: ['Write'] },
      personaInjection: 'off',
    });
    await waitForTurn(calls, 1);
    const args = turnSpawns(calls)[0]!.args;
    expect(args).toEqual(['-p', '第四轮', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain('--permission-mode');
  });

  it("personaInjection='file'：不传 persona flag，但 toolPolicy flags 照传（工具管控与 persona 注入解耦）", async () => {
    const { calls } = recordSpawns(HELP_WITH_PERMISSION_MODE);

    codebuddyAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第五轮',
      persona: PERSONA,
      toolPolicy: TOOL_POLICY_INHERIT,
      personaInjection: 'file',
    });
    await waitForTurn(calls, 1);
    const args = turnSpawns(calls)[0]!.args;
    expect(args).toEqual([
      '-p', '第五轮', '--allowedTools', 'Bash,Edit', '--disallowedTools', 'Write',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it("approval_mode='bypass' 且探测未确认权限 flag → 不传；确认后按映射传 --permission-mode bypassPermissions", async () => {
    const bypassPolicy: SessionToolPolicy = { approval_mode: 'bypass', allow: [], deny: [] };

    // 探测 help 无 --permission-mode → 不传权限 flag
    const noPerm = recordSpawns(HELP_WITHOUT_PERMISSION_MODE);
    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第六轮', toolPolicy: bypassPolicy });
    await waitForTurn(noPerm.calls, 1);
    expect(turnSpawns(noPerm.calls)[0]!.args).toEqual([
      '-p', '第六轮', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]);

    // 探测确认 --permission-mode → bypass 映射为 bypassPermissions 追加在参数尾部
    resetCapabilityProbeCache();
    const withPerm = recordSpawns(HELP_WITH_PERMISSION_MODE);
    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第七轮', toolPolicy: bypassPolicy });
    await waitForTurn(withPerm.calls, 1);
    expect(turnSpawns(withPerm.calls)[0]!.args).toEqual([
      '-p', '第七轮', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('plan/acceptEdits 档位按映射传 --permission-mode <对应值>（同命令探测缓存复用）', async () => {
    const { calls } = recordSpawns(HELP_WITH_PERMISSION_MODE);

    codebuddyAdapter.runTurn({
      cwd: 'D:\\w', prompt: 'plan', toolPolicy: { approval_mode: 'plan', allow: [], deny: [] },
    });
    await waitForTurn(calls, 1);
    expect(turnSpawns(calls)[0]!.args.slice(-2)).toEqual(['--permission-mode', 'plan']);

    codebuddyAdapter.runTurn({
      cwd: 'D:\\w', prompt: 'acceptEdits', toolPolicy: { approval_mode: 'acceptEdits', allow: [], deny: [] },
    });
    await waitForTurn(calls, 2);
    expect(turnSpawns(calls)[1]!.args.slice(-2)).toEqual(['--permission-mode', 'acceptEdits']);
  });
});
