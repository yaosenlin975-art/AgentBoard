import { describe, expect, it, vi } from 'vitest';
import { asChild, closeChild, makeAutoChild, makeFakeChild, type FakeChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import {
  CODEBUDDY_CMD,
  codebuddyAdapter,
  createParseState,
  extractStaticModels,
  parseCodebuddyLine,
} from '../src/codebuddy.js';
import type { TurnResult, UnifiedEvent } from '../src/types.js';

// 本机 codebuddy 2.177.0 实跑 --help 摘录的 --model 说明行（静态清单的抽取依据）
const REAL_MODEL_HELP_LINE =
  '  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, step-5-preview, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, space-bunny, minimax-m3.1-flash, minimax-m3, minimax-m2.7, kimi-k3.1-pro, kimi-k3-1, kimi-k2.8-preview, deepseek-v4-pro, mimo-v2.6-pro)';

const MOCK_EXE = 'C:\\mock\\bin\\codebuddy.exe';
const MOCK_SHIM = 'C:\\mock\\bin\\codebuddy.cmd';

interface RecordedSpawn {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

function whereExeChild(): FakeChild {
  return makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0);
}

/** runTurn 探针：拦截 where/which（返回 exe 命中行），其余命令记录并返回挂起假进程 */
function recordSpawns(): { calls: RecordedSpawn[]; spawned: FakeChild[] } {
  const calls: RecordedSpawn[] = [];
  const spawned: FakeChild[] = [];
  setSpawnFn(((cmd: string, args: string[], options: unknown) => {
    calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
    if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
    const child = makeFakeChild();
    spawned.push(child);
    return asChild(child);
  }) as unknown as SpawnFn);
  return { calls, spawned };
}

describe('codebuddy runTurn', () => {
  it('参数拼装：首次无 --resume；续轮 --model 与 --resume 按序；--output-format json 收尾；win32 .exe 直连', async () => {
    const { calls } = recordSpawns();

    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === '-p')).toHaveLength(1));
    codebuddyAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第二轮',
      model: 'glm-5.3',
      adapterSessionId: 'sess-1',
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === '-p')).toHaveLength(2));

    const runs = calls.filter((c) => c.args[0] === '-p');
    expect(runs[0]).toMatchObject({ cmd: MOCK_EXE, args: ['-p', '第一轮', '--output-format', 'json'] });
    expect(runs[1]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['-p', '第二轮', '--model', 'glm-5.3', '--resume', 'sess-1', '--output-format', 'json'],
    });
    expect(runs[0]!.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('win32 仅有 .cmd 垫片时经 cmd.exe /d /s /c 包装', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(((cmd: string, args: string[], options: unknown) => {
      calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_SHIM}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    codebuddyAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'cmd.exe')).toBe(true));

    const wrapped = calls.find((c) => c.cmd === 'cmd.exe')!;
    expect(wrapped.args.slice(0, 4)).toEqual(['/d', '/s', '/c', MOCK_SHIM]);
    expect(wrapped.args.slice(4)).toEqual(['-p', '第一轮', '--output-format', 'json']);
    expect(wrapped.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('事件归一：非法 JSON 行忽略、text/tool 映射、session_id 首次提取不被覆盖、exitCode 透传', async () => {
    const { spawned } = recordSpawns();
    const handle = codebuddyAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;

    child.stdout.emit(
      'data',
      Buffer.from(
        [
          '这行不是 JSON',
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] }, session_id: 'sess-1' }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }] } }),
          JSON.stringify({ type: 'result', result: '完成', session_id: 'sess-2' }),
          '',
        ].join('\n') + '\n',
      ),
    );
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'text', delta: '你好' },
      { type: 'tool', name: 'Bash', input: '{"cmd":"ls"}' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: 'sess-1' });
  });

  it('kill：TurnHandle.kill 停进程，close(null) 归一为 end(exitCode=-1)', async () => {
    const { spawned } = recordSpawns();
    const handle = codebuddyAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    child.kill = vi.fn(() => {
      closeChild(child, null);
      return true;
    });

    await handle.kill();
    const result = await handle.result;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'end', exitCode: -1 }]);
    expect(result).toEqual({ exitCode: -1, adapterSessionId: null });
  });
});

describe('codebuddy detect', () => {
  it('where 命中 + --version 输出 trim 存 version', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: '2.177.0\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    await expect(codebuddyAdapter.detect()).resolves.toEqual({ installed: true, version: '2.177.0' });
  });

  it('where/which 都失败 → installed=false version=null', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], cmd === 'where' ? 1 : 1))) as unknown as SpawnFn);

    await expect(codebuddyAdapter.detect()).resolves.toEqual({ installed: false, version: null });
  });
});

describe('codebuddy listModels', () => {
  it('已安装 → 实跑 --help 抽取静态清单（source=static）', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: '2.177.0\n' }], 0));
      }
      if (cmd === MOCK_EXE && args.includes('--help')) {
        return asChild(
          makeAutoChild(
            [
              {
                source: 'stdout',
                text: '  --model <model>   Model for the current session. Currently supported: (glm-5.3, glm-5.3-flash, deepseek-v4-pro)\n',
              },
            ],
            0,
          ),
        );
      }
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    await expect(codebuddyAdapter.listModels()).resolves.toEqual([
      { id: 'glm-5.3', source: 'static' },
      { id: 'glm-5.3-flash', source: 'static' },
      { id: 'deepseek-v4-pro', source: 'static' },
    ]);
  });

  it('未安装 → 空数组（UI 手输兜底）', async () => {
    setSpawnFn((() => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(codebuddyAdapter.listModels()).resolves.toEqual([]);
  });
});

describe('extractStaticModels', () => {
  it('从真实 --help 的 --model 行提取全部模型 ID（19 个，source=static）', () => {
    const models = extractStaticModels(REAL_MODEL_HELP_LINE);
    const ids = models.map((m) => m.id);
    expect(ids).toHaveLength(19);
    expect(ids).toContain('glm-5.3');
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('mimo-v2.6-pro');
    expect(models.every((m) => m.source === 'static')).toBe(true);
  });

  it('无模型说明 → 空数组', () => {
    expect(extractStaticModels('Usage: codebuddy [options]')).toEqual([]);
  });
});

describe('parseCodebuddyLine', () => {
  it('非法 JSON / 空行 / 非对象 JSON → 空数组（忽略）', () => {
    const state = createParseState();
    expect(parseCodebuddyLine('not json', state)).toEqual([]);
    expect(parseCodebuddyLine('', state)).toEqual([]);
    expect(parseCodebuddyLine('   ', state)).toEqual([]);
    expect(parseCodebuddyLine('123', state)).toEqual([]);
    expect(parseCodebuddyLine('"str"', state)).toEqual([]);
  });

  it('error 行映射 error 事件；session_id 存入 state', () => {
    const state = createParseState();
    expect(parseCodebuddyLine('{"type":"error","message":"boom","session_id":"s1"}', state)).toEqual([
      { type: 'error', message: 'boom' },
    ]);
    expect(state.sessionId).toBe('s1');
  });
});
