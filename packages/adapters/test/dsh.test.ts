import { describe, expect, it, vi } from 'vitest';
import { asChild, closeChild, makeAutoChild, makeFakeChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import {
  DSH_STATIC_MODELS,
  dshAdapter,
  createDshParseState,
  isSupportedDshVersion,
  parseDshLine,
  parseDshVersion,
} from '../src/dsh.js';
import type { TurnResult, UnifiedEvent } from '../src/types.js';

const MOCK_EXE = 'C:\\mock\\bin\\dsh.exe';
const MOCK_SHIM = 'C:\\mock\\bin\\dsh.cmd';

interface RecordedSpawn {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

/** dsh 探测/主进程 mock 路由：where→.exe 行；--version→给定版本输出；--profile→主进程 manual child。 */
function dshSpawnRouter(
  calls: RecordedSpawn[],
  versionOutput: { source: 'stdout' | 'stderr'; text: string }[],
  mainChild = makeFakeChild(),
): SpawnFn {
  return ((cmd: string, args: string[], options: unknown) => {
    calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
    if (cmd === 'where' || cmd === 'which') {
      return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
    }
    if (args[0] === '--version') {
      return asChild(makeAutoChild(versionOutput, 0));
    }
    return asChild(mainChild);
  }) as unknown as SpawnFn;
}

describe('dsh runTurn', () => {
  it('参数拼装：--profile headless <prompt> --json [--session-id]；model 无 flag 不进参数；版本探测先行', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }]));

    dshAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === '--profile')).toBe(true));
    dshAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第二轮',
      model: 'deepseek-v4-pro',
      adapterSessionId: 'sess-9',
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === '--profile')).toHaveLength(2));

    const mains = calls.filter((c) => c.args[0] === '--profile');
    expect(mains[0]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['--profile', 'headless', '第一轮', '--json'],
    });
    expect(mains[1]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['--profile', 'headless', '第二轮', '--json', '--session-id', 'sess-9'],
    });
    expect(mains[1]!.args.join(' ')).not.toContain('deepseek');
    expect(mains[0]!.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
    // 每轮恰好一次 --version 探测
    expect(calls.filter((c) => c.args[0] === '--version')).toHaveLength(2);
  });

  it('model 非空 → 静默忽略（不发提示 error，不进参数），轮次照常', async () => {
    const child = makeFakeChild();
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }], child));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi', model: 'deepseek-v4-pro' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stdout.emit('data', Buffer.from('{"type":"text","text":"OK"}\n'));
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'text', delta: 'OK' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: null });
  });

  it('版本非 0.2.x → 版本 error 事件 + 非零结束，主进程不 spawn', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.3.1\n' }]));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));

    const result = await handle.result;

    expect(events).toEqual([
      { type: 'error', message: 'dsh 版本 0.3.1 不在已适配范围 0.2.x，接口可能已变更' },
      { type: 'end', exitCode: 1 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 1, adapterSessionId: null });
    expect(calls.some((c) => c.args[0] === '--profile')).toBe(false);
  });

  it('版本探测无输出/解析失败 → 不阻断，照常起轮', async () => {
    const child = makeFakeChild();
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stderr', text: 'boom: not a version\n' }], child));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([{ type: 'end', exitCode: 0 }]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: null });
  });

  it('exit 0 但零事件且无 session id、有 stderr → 发诊断 error 事件（含 stderr），TurnResult 带 stderrTail', async () => {
    const child = makeFakeChild();
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }], child));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stderr.emit('data', Buffer.from('profile headless 不存在\n'));
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: '适配器未捕获到结构化输出；stderr 尾部：\nprofile headless 不存在' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result.stderrTail).toEqual(['profile headless 不存在']);
  });

  it('NDJSON 全事件映射：session 提取、text 增量、thinking→thinking、tool_result 忽略、tool_call→tool、final 完整段去重', async () => {
    const child = makeFakeChild();
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }], child));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stdout.emit(
      'data',
      Buffer.from(
        [
          '这行不是 JSON',
          '{"type":"session","session_id":"sess-abc"}',
          '{"type":"thinking","text":"内部思考"}',
          '{"type":"text","text":"回答"}',
          '{"type":"tool_call","name":"read_file","input":{"path":"a.txt"}}',
          '{"type":"tool_result","name":"read_file","output":"content"}',
          '{"type":"session","session_id":"sess-later"}',
          '{"type":"final","text":"回答","session_id":"sess-abc"}',
          '',
        ].join('\n') + '\n',
      ),
    );
    closeChild(child, 0);

    const result = await resultPromise;
    // 去重策略：流里已有 text 增量，final 完整段不再发（仅提取会话 id）；session 首次生效；
    // thinking 归一为独立事件，不进聊天正文
    expect(events).toEqual([
      { type: 'thinking', delta: '内部思考' },
      { type: 'text', delta: '回答' },
      { type: 'tool', name: 'read_file', input: '{"path":"a.txt"}' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: 'sess-abc' });
  });

  it('全程无 text 增量时，final 完整段兜底为一次 text 事件', async () => {
    const child = makeFakeChild();
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }], child));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stdout.emit(
      'data',
      Buffer.from('{"type":"session","session_id":"sess-1"}\n{"type":"final","text":"完整回复","session_id":"sess-1"}\n'),
    );
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'text', delta: '完整回复' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: 'sess-1' });
  });

  it('kill：prelude 期间 kill → 不 spawn 主进程，end(exitCode=-1)', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(dshSpawnRouter(calls, [{ source: 'stdout', text: 'dsh 0.2.4\n' }]));
    const handle = dshAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));

    await handle.kill();
    const result = await handle.result;

    expect(events).toEqual([{ type: 'end', exitCode: -1 }]);
    expect(result).toEqual({ exitCode: -1, adapterSessionId: null });
    expect(calls.some((c) => c.args[0] === '--profile')).toBe(false);
  });
});

describe('dsh detect', () => {
  it('where 命中 + --version 解析出 0.2.x 版本', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_SHIM}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'dsh 0.2.4\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    await expect(dshAdapter.detect()).resolves.toEqual({ installed: true, version: '0.2.4' });
  });

  it('version 输出无语义化版本（如垫片损坏的报错文本）→ version 取首个非空行', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_SHIM}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stderr', text: 'Error: Cannot find module bin.js\n' }], 1));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    await expect(dshAdapter.detect()).resolves.toEqual({ installed: true, version: 'Error: Cannot find module bin.js' });
  });

  it('where/which 都失败 → installed=false version=null', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(dshAdapter.detect()).resolves.toEqual({ installed: false, version: null });
  });
});

describe('dsh listModels', () => {
  it('已安装 → 静态清单（source=static）', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args[0] === '--version') {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'dsh 0.2.4\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    await expect(dshAdapter.listModels()).resolves.toEqual(DSH_STATIC_MODELS);
  });

  it('未安装 → 空数组', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(dshAdapter.listModels()).resolves.toEqual([]);
  });
});

describe('parseDshLine', () => {
  it('非法 JSON / 空行 / 非对象 JSON → 空数组（忽略）', () => {
    const state = createDshParseState();
    expect(parseDshLine('not json', state)).toEqual([]);
    expect(parseDshLine('', state)).toEqual([]);
    expect(parseDshLine('   ', state)).toEqual([]);
    expect(parseDshLine('123', state)).toEqual([]);
    expect(parseDshLine('"str"', state)).toEqual([]);
    expect(parseDshLine('[1,2]', state)).toEqual([]);
  });

  it('session/final 的 session_id 存入 state 且只取首次；session 本身无事件', () => {
    const state = createDshParseState();
    expect(parseDshLine('{"type":"session","session_id":"s1"}', state)).toEqual([]);
    expect(state.sessionId).toBe('s1');
    parseDshLine('{"type":"final","text":"x","session_id":"s2"}', state);
    expect(state.sessionId).toBe('s1');
  });

  it('text → delta；thinking → thinking（缺 text 字段忽略）；tool_call → tool（对象 JSON 化，缺 name 回退 tool）', () => {
    const state = createDshParseState();
    expect(parseDshLine('{"type":"text","text":"增量"}', state)).toEqual([{ type: 'text', delta: '增量' }]);
    expect(parseDshLine('{"type":"thinking","text":"思考"}', state)).toEqual([{ type: 'thinking', delta: '思考' }]);
    // 无 text 字段 / 空文本：不发事件
    expect(parseDshLine('{"type":"thinking"}', state)).toEqual([]);
    expect(parseDshLine('{"type":"thinking","text":""}', state)).toEqual([]);
    expect(parseDshLine('{"type":"tool_call","name":"shell","input":{"command":"ls"}}', state)).toEqual([
      { type: 'tool', name: 'shell', input: '{"command":"ls"}' },
    ]);
    expect(parseDshLine('{"type":"tool_call","input":"raw string"}', state)).toEqual([
      { type: 'tool', name: 'tool', input: 'raw string' },
    ]);
    expect(parseDshLine('{"type":"tool_result","name":"shell","output":"out"}', state)).toEqual([]);
  });

  it('final 去重：有增量后 final 不再发；无增量时 final 兜底一次 text；第二个 final 不重复', () => {
    const state = createDshParseState();
    parseDshLine('{"type":"text","text":"增量"}', state);
    expect(parseDshLine('{"type":"final","text":"增量"}', state)).toEqual([]);
    const state2 = createDshParseState();
    expect(parseDshLine('{"type":"final","text":"完整","session_id":"s1"}', state2)).toEqual([
      { type: 'text', delta: '完整' },
    ]);
    expect(parseDshLine('{"type":"final","text":"完整"}', state2)).toEqual([]);
  });
});

describe('parseDshVersion / isSupportedDshVersion', () => {
  it('解析行首 dsh/v 前缀的 X.Y.Z；无命中返回 null', () => {
    expect(parseDshVersion(['dsh 0.2.4'])).toBe('0.2.4');
    expect(parseDshVersion(['v0.2.0-rc.1'])).toBe('0.2.0-rc.1');
    expect(parseDshVersion(['0.2.9'])).toBe('0.2.9');
    expect(parseDshVersion(['', 'dsh version 0.2.1'])).toBeNull(); // 行中间不算
    expect(parseDshVersion(['Error: Cannot find module bin.js'])).toBeNull();
    expect(parseDshVersion(['Node.js v24.11.1'])).toBeNull(); // 非行首版本不误报
  });

  it('主次版本判定 0.2.x；0.3/0.20 不通过', () => {
    expect(isSupportedDshVersion('0.2.0')).toBe(true);
    expect(isSupportedDshVersion('0.2.99')).toBe(true);
    expect(isSupportedDshVersion('0.3.0')).toBe(false);
    expect(isSupportedDshVersion('0.20.1')).toBe(false);
    expect(isSupportedDshVersion('1.0.0')).toBe(false);
  });
});
