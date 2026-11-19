import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asChild, closeChild, makeAutoChild, makeFakeChild, type FakeChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import {
  CODEX_CMD,
  CODEX_STATIC_MODELS,
  fetchProviderModels,
  codexAdapter,
  createCodexParseState,
  parseCodexProviderConfig,
  parseCodexModelCatalog,
  parseCodexLine,
} from '../src/codex.js';
import type { TurnResult, UnifiedEvent } from '../src/types.js';

// 本机 codex-cli 0.165.0 实跑 `codex exec "Reply with just OK" --json --skip-git-repo-check` 摘录的真实事件行
const REAL_THREAD_STARTED = '{"type":"thread.started","thread_id":"01a190bb-7347-76a0-bf51-479da1c12f63"}';
const REAL_TURN_STARTED = '{"type":"turn.started"}';
const REAL_ITEM_ERROR =
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}}';
const REAL_RECONNECT_ERROR = '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}';
const REAL_AGENT_MESSAGE = '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"OK"}}';
const REAL_TURN_COMPLETED =
  '{"type":"turn.completed","usage":{"input_tokens":33732,"cached_input_tokens":13440,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}';
const REAL_TURN_FAILED =
  '{"type":"turn.failed","error":{"message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}';

const MOCK_EXE = 'C:\\mock\\bin\\codex.exe';
const MOCK_SHIM = 'C:\\mock\\bin\\codex.cmd';
const SESSION_ID = '01a190bb-7347-76a0-bf51-479da1c12f63';

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

describe('codex runTurn', () => {
  it('参数拼装：首轮 exec <prompt> --json；续轮走 exec resume <id> <prompt>；--model 与 --skip-git-repo-check 按序；win32 .exe 直连', async () => {
    const { calls } = recordSpawns();

    codexAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === 'exec')).toHaveLength(1));
    codexAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第二轮',
      model: 'gpt-5-codex',
      adapterSessionId: SESSION_ID,
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === 'exec')).toHaveLength(2));

    const runs = calls.filter((c) => c.args[0] === 'exec');
    expect(runs[0]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['exec', '第一轮', '--json', '--skip-git-repo-check'],
    });
    expect(runs[1]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['exec', 'resume', SESSION_ID, '第二轮', '--json', '--model', 'gpt-5-codex', '--skip-git-repo-check'],
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

    codexAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'cmd.exe')).toBe(true));

    const wrapped = calls.find((c) => c.cmd === 'cmd.exe')!;
    expect(wrapped.args.slice(0, 4)).toEqual(['/d', '/s', '/c', MOCK_SHIM]);
    expect(wrapped.args.slice(4)).toEqual(['exec', '第一轮', '--json', '--skip-git-repo-check']);
    expect(wrapped.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('事件归一：真实事件流 → text/tool/error/end，thread_id 首次提取不被覆盖，非法 JSON 行忽略，exitCode 透传', async () => {
    const { spawned } = recordSpawns();
    const handle = codexAdapter.runTurn({ cwd: '.', prompt: 'hi' });
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
          REAL_THREAD_STARTED,
          REAL_ITEM_ERROR,
          REAL_TURN_STARTED,
          REAL_RECONNECT_ERROR,
          '{"type":"thread.started","thread_id":"another-thread-id"}',
          REAL_AGENT_MESSAGE,
          REAL_TURN_COMPLETED,
        ].join('\n') + '\n',
      ),
    );
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' },
      { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' },
      { type: 'text', delta: 'OK' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: SESSION_ID });
  });

  it('exit 0 但零事件且无 session id、有 stderr → 发诊断 error 事件（含 stderr），TurnResult 带 stderrTail', async () => {
    const { spawned } = recordSpawns();
    const handle = codexAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;

    child.stderr.emit('data', Buffer.from('stream error: unexpected EOF\n'));
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: '适配器未捕获到结构化输出；stderr 尾部：\nstream error: unexpected EOF' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result.stderrTail).toEqual(['stream error: unexpected EOF']);
  });

  it('turn.failed → error 事件', async () => {
    const { spawned } = recordSpawns();
    const handle = codexAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;

    child.stdout.emit('data', Buffer.from(`${REAL_TURN_FAILED}\n`));
    closeChild(child, 1);

    const result = await resultPromise;
    expect(events).toEqual([
      {
        type: 'error',
        message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
      { type: 'end', exitCode: 1 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 1, adapterSessionId: null });
  });

  it('kill：TurnHandle.kill 停进程，close(null) 归一为 end(exitCode=-1)', async () => {
    const { spawned } = recordSpawns();
    const handle = codexAdapter.runTurn({ cwd: '.', prompt: 'hi' });
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

describe('codex detect', () => {
  it('where 命中 + --version 输出 trim 存 version', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'codex-cli 0.165.0\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    await expect(codexAdapter.detect()).resolves.toEqual({ installed: true, version: 'codex-cli 0.165.0' });
  });

  it('where/which 都失败 → installed=false version=null', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], cmd === 'where' ? 1 : 1))) as unknown as SpawnFn);

    await expect(codexAdapter.detect()).resolves.toEqual({ installed: false, version: null });
  });
});

describe('codex listModels', () => {
  let previousCodexHome: string | undefined;
  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = `C:\\mock\\missing-codex-home-${Date.now()}`;
  });
  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('已安装 → 优先使用 debug models 的可见模型', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args[0] === 'debug') {
        return asChild(makeAutoChild([{
          source: 'stdout',
          text: JSON.stringify({ models: [
            { slug: 'gpt-6.1-sol', visibility: 'list', supported_in_api: true },
            { slug: 'hidden', visibility: 'hide', supported_in_api: true },
          ] }),
        }], 0));
      }
      if (cmd === MOCK_EXE) return asChild(makeAutoChild([{ source: 'stdout', text: 'codex-cli 0.165.0\n' }], 0));
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    const models = await codexAdapter.listModels();
    expect(models).toEqual([{ id: 'gpt-6.1-sol', source: 'probed' }]);
  });

  it('debug models 无输出或损坏 → 回退静态清单', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args[0] === 'debug') {
        return asChild(makeAutoChild([{ source: 'stderr', text: 'invalid catalog\n' }], 1));
      }
      if (cmd === MOCK_EXE) return asChild(makeAutoChild([{ source: 'stdout', text: 'codex-cli 0.165.0\n' }], 0));
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    await expect(codexAdapter.listModels()).resolves.toEqual(CODEX_STATIC_MODELS);
  });

  it('未安装 → 空数组', async () => {
    setSpawnFn((() => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(codexAdapter.listModels()).resolves.toEqual([]);
  });
});

describe('parseCodexModelCatalog', () => {
  it('只保留可见、可调用的唯一 slug；非法 JSON 返回空数组', () => {
    expect(parseCodexModelCatalog(JSON.stringify({ models: [
      { slug: 'gpt-6', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6', visibility: 'list', supported_in_api: true },
      { slug: 'hidden', visibility: 'hide', supported_in_api: true },
      { slug: 'api-disabled', visibility: 'list', supported_in_api: false },
      { slug: '', visibility: 'list' },
    ] }))).toEqual([{ id: 'gpt-6', source: 'probed' }]);
    expect(parseCodexModelCatalog('not json')).toEqual([]);
    expect(parseCodexModelCatalog('{"models":{}}')).toEqual([]);
  });

  it('兼容 OpenAI /models 的 data[].id', () => {
    expect(parseCodexModelCatalog(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek/deepseek-v4.1-flash', object: 'model' },
        { id: 'deepseek/deepseek-v4.1-flash', object: 'model' },
        { id: 'ignored', object: 'embedding' },
      ],
    }))).toEqual([{ id: 'deepseek/deepseek-v4.1-flash', source: 'probed' }]);
  });
});

describe('Codex provider config', () => {
  it('只读取当前 provider 的 base_url 与 bearer token', () => {
    expect(parseCodexProviderConfig([
      'model_provider = "custom"',
      '[model_providers.custom]',
      'base_url = "http://127.0.0.1:57321/v1"',
      'experimental_bearer_token = "secret"',
      '[model_providers.other]',
      'base_url = "http://127.0.0.1:9999/v1"',
    ].join('\n'))).toEqual({
      baseUrl: 'http://127.0.0.1:57321/v1',
      bearerToken: 'secret',
    });
  });

  it('请求 /models 并发送 Bearer；非 2xx 返回空数组', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = (body: string, status = 200): Response => new Response(body, { status });
    const models = await fetchProviderModels({
      baseUrl: 'http://127.0.0.1:57321/v1/',
      bearerToken: 'secret',
    }, (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response(JSON.stringify({ data: [{ id: 'local-model' }] }));
    }) as typeof fetch);

    expect(models).toEqual([{ id: 'local-model', source: 'probed' }]);
    expect(calls[0]!.url).toBe('http://127.0.0.1:57321/v1/models');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');

    await expect(fetchProviderModels(
      { baseUrl: 'http://127.0.0.1:57321/v1' },
      (async () => response('no', 500)) as typeof fetch,
    )).resolves.toEqual([]);
  });
});

describe('parseCodexLine', () => {
  it('非法 JSON / 空行 / 非对象 JSON → 空数组（忽略）', () => {
    const state = createCodexParseState();
    expect(parseCodexLine('not json', state)).toEqual([]);
    expect(parseCodexLine('', state)).toEqual([]);
    expect(parseCodexLine('   ', state)).toEqual([]);
    expect(parseCodexLine('123', state)).toEqual([]);
    expect(parseCodexLine('"str"', state)).toEqual([]);
    expect(parseCodexLine('[1,2]', state)).toEqual([]);
  });

  it('thread.started 的 thread_id 存入 state 且只取首次', () => {
    const state = createCodexParseState();
    expect(parseCodexLine(REAL_THREAD_STARTED, state)).toEqual([]);
    expect(state.sessionId).toBe(SESSION_ID);
    parseCodexLine('{"type":"thread.started","thread_id":"second"}', state);
    expect(state.sessionId).toBe(SESSION_ID);
  });

  it('item.completed：agent_message→text、command_execution→tool', () => {
    const state = createCodexParseState();
    expect(parseCodexLine(REAL_AGENT_MESSAGE, state)).toEqual([{ type: 'text', delta: 'OK' }]);
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git status","aggregated_output":"","exit_code":0,"status":"completed"}}',
        state,
      ),
    ).toEqual([{ type: 'tool', name: 'command_execution', input: 'git status' }]);
  });

  it('item.completed：mcp_tool_call / file_change / web_search → tool（input 字符串透传，对象 JSON 化）', () => {
    const state = createCodexParseState();
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","server":"fs","tool":"read_file","arguments":{"path":"a.txt"},"status":"completed"}}',
        state,
      ),
    ).toEqual([{ type: 'tool', name: 'read_file', input: '{"path":"a.txt"}' }]);
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i3","type":"file_change","changes":{"a.txt":"Add"},"status":"completed"}}',
        state,
      ),
    ).toEqual([{ type: 'tool', name: 'file_change', input: '{"a.txt":"Add"}' }]);
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i4","type":"web_search","query":"codex exec --json"}}',
        state,
      ),
    ).toEqual([{ type: 'tool', name: 'web_search', input: 'codex exec --json' }]);
    // tool 字段缺失时回退 item.type
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i5","type":"mcp_tool_call","status":"completed"}}', state),
    ).toEqual([{ type: 'tool', name: 'mcp_tool_call', input: 'null' }]);
  });

  it('item.completed error → error 事件；reasoning 终值→thinking、中间态/无文本忽略；started/updated/turn.completed/todo_list 忽略', () => {
    const state = createCodexParseState();
    expect(parseCodexLine(REAL_ITEM_ERROR, state)).toEqual([
      { type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' },
    ]);
    expect(parseCodexLine(REAL_TURN_STARTED, state)).toEqual([]);
    expect(parseCodexLine(REAL_TURN_COMPLETED, state)).toEqual([]);
    expect(
      parseCodexLine('{"type":"item.started","item":{"id":"i0","type":"agent_message","text":"部分"}}', state),
    ).toEqual([]);
    expect(
      parseCodexLine('{"type":"item.updated","item":{"id":"i0","type":"agent_message","text":"部分更"}}', state),
    ).toEqual([]);
    // reasoning 终值（item.completed）取 text 摘要 → thinking；与 agent_message 同为终值路径，无重复风险
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i6","type":"reasoning","text":"思考摘要"}}', state),
    ).toEqual([{ type: 'thinking', delta: '思考摘要' }]);
    // reasoning 中间态（started/updated）忽略：终值随 item.completed 到达，再消费会重复
    expect(
      parseCodexLine('{"type":"item.started","item":{"id":"i6","type":"reasoning","text":"部分思考"}}', state),
    ).toEqual([]);
    expect(
      parseCodexLine('{"type":"item.updated","item":{"id":"i6","type":"reasoning","text":"思考中"}}', state),
    ).toEqual([]);
    // reasoning 无 text 字段 / 空文本：不映射不发事件
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i8","type":"reasoning"}}', state),
    ).toEqual([]);
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i9","type":"reasoning","text":""}}', state),
    ).toEqual([]);
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"i7","type":"todo_list","items":[]}}', state),
    ).toEqual([]);
  });

  it('顶层 error 与 turn.failed → error 事件', () => {
    const state = createCodexParseState();
    expect(parseCodexLine(REAL_RECONNECT_ERROR, state)).toEqual([
      { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' },
    ]);
    expect(parseCodexLine(REAL_TURN_FAILED, state)).toEqual([
      {
        type: 'error',
        message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    ]);
  });
});
