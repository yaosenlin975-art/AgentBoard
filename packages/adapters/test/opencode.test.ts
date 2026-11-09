import { describe, expect, it, vi } from 'vitest';
import { asChild, closeChild, makeAutoChild, makeFakeChild } from './helpers.js';
import { resetSpawnFormCache, resolveSpawnForm, setSpawnFn, type SpawnFn } from '../src/spawn.js';
import {
  OPENCODE_CMD,
  opencodeAdapter,
  createOpencodeParseState,
  parseModelLines,
  parseOpencodeLine,
  tryParseModelsJson,
} from '../src/opencode.js';
import type { TurnResult, UnifiedEvent } from '../src/types.js';

const MOCK_EXE = 'C:\\mock\\bin\\opencode.exe';
const MOCK_SHIM = 'C:\\mock\\bin\\opencode.cmd';
const SESSION_ID = 'ses_e6f3b1824ffetgnU9yCmQENAeL';

// 本机 opencode v2.2.0 实跑 `opencode run ... --format json` 摘录的真实事件行（字段形态逐字保留）
const REAL_STEP_START = `{"type":"step_start","timestamp":1793430188079,"sessionID":"${SESSION_ID}","part":{"id":"prt_190c4f02f001U5HHI2T0biOiXm","sessionID":"${SESSION_ID}","messageID":"msg_190c4e817001JpBrT0S4m8WzcY","type":"step-start"}}`;
const REAL_TOOL_USE = `{"type":"tool_use","timestamp":1793430233217,"sessionID":"${SESSION_ID}","part":{"partID":"prt_190c4f06c002iw75nQRapWxwlP","sessionID":"${SESSION_ID}","messageID":"msg_190c4e817001JpBrT0S4m8WzcY","type":"tool","id":"chatcmpl-tool-b0258bfc464eed0d","tool":"shell","state":{"status":"completed","input":{"command":"ls"},"output":"file-a.txt"}}}`;
const REAL_STEP_FINISH = `{"type":"step_finish","timestamp":1793430233224,"sessionID":"${SESSION_ID}","part":{"id":"prt_190c5a088001h976sIwnYa4moA","sessionID":"${SESSION_ID}","messageID":"msg_190c4e817001JpBrT0S4m8WzcY","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":13173,"output":11,"reasoning":9}}}`;
const REAL_TEXT = `{"type":"text","timestamp":1793430236735,"sessionID":"${SESSION_ID}","part":{"id":"prt_190c5a09e001hqYEAL741s91ZP_text-0","sessionID":"${SESSION_ID}","messageID":"msg_190c5a09e001hqYEAL741s91ZP","type":"text","text":"DONE","time":{"start":1793430233255,"end":1793430236735}}}`;
const REAL_ERROR = `{"type":"error","timestamp":1793430152760,"sessionID":"${SESSION_ID}","error":{"type":"provider.invalid-request","message":"Upstream request failed: upstream 400","status":400,"response":{"body":"{}"}}}`;

interface RecordedSpawn {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

describe('opencode runTurn', () => {
  it('参数拼装：run <prompt> --format json [-m model] [-s sessionId]，win32 .exe 直连', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(((cmd: string, args: string[], options: unknown) => {
      calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    opencodeAdapter.runTurn({ cwd: 'D:\\w', prompt: '第一轮' });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === 'run')).toHaveLength(1));
    opencodeAdapter.runTurn({
      cwd: 'D:\\w',
      prompt: '第二轮',
      model: 'opencode-go/glm-5.3-flash',
      adapterSessionId: SESSION_ID,
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.args[0] === 'run')).toHaveLength(2));

    const runs = calls.filter((c) => c.args[0] === 'run');
    expect(runs[0]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['run', '第一轮', '--format', 'json'],
    });
    expect(runs[1]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['run', '第二轮', '--format', 'json', '-m', 'opencode-go/glm-5.3-flash', '-s', SESSION_ID],
    });
    expect(runs[0]!.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('win32 仅有 .cmd 垫片时经 cmd.exe /d /s /c 包装；where/which 都失败原样 spawn', async () => {
    const calls: RecordedSpawn[] = [];
    let failWhere = false;
    setSpawnFn(((cmd: string, args: string[], options: unknown) => {
      calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
      if (cmd === 'where' || cmd === 'which') {
        if (failWhere) return asChild(makeAutoChild([], 1));
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_SHIM}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'cmd.exe')).toBe(true));
    const wrapped = calls.find((c) => c.cmd === 'cmd.exe')!;
    expect(wrapped.cmd).toBe('cmd.exe');
    expect(wrapped.args.slice(0, 4)).toEqual(['/d', '/s', '/c', MOCK_SHIM]);
    expect(wrapped.args.slice(4)).toEqual(['run', 'hi', '--format', 'json']);

    calls.length = 0;
    failWhere = true;
    // CR2-9：形态探测成功后按命令缓存，模拟「换了一套 where 结果」需显式清缓存
    resetSpawnFormCache();
    opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi2' });
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === OPENCODE_CMD && c.args[0] === 'run')).toBe(true));
    const fallback = calls.find((c) => c.cmd === OPENCODE_CMD && c.args[0] === 'run')!;
    expect(fallback.cmd).toBe(OPENCODE_CMD);
    expect(fallback.args).toEqual(['run', 'hi2', '--format', 'json']);
  });

  // CR2-9：detect/上一轮已预热形态缓存时，本轮 turn 不再起 where 子进程（进程审计）
  it('形态缓存预热后 runTurn 不再 spawn where/which', async () => {
    const calls: string[] = [];
    setSpawnFn(((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(makeAutoChild([], 0));
    }) as unknown as SpawnFn);

    await resolveSpawnForm(OPENCODE_CMD);
    calls.length = 0;
    await opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' }).result;

    expect(calls).not.toContain('where');
    expect(calls).not.toContain('which');
    expect(calls).toContain(MOCK_EXE);
  });

  it('事件归一：真实事件流 → text/tool/error/end，sessionID 首次提取不被覆盖，非法行忽略，exitCode 透传', async () => {
    const child = makeFakeChild();
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(child);
    }) as unknown as SpawnFn);
    const handle = opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stdout.emit(
      'data',
      Buffer.from(
        [
          '这行不是 JSON',
          REAL_STEP_START,
          REAL_ERROR,
          REAL_STEP_FINISH,
          REAL_TOOL_USE,
          `{"type":"step_start","timestamp":2,"sessionID":"ses_another","part":{"id":"p2","sessionID":"ses_another","type":"step-start"}}`,
          REAL_TEXT,
          '',
        ].join('\n') + '\n',
      ),
    );
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: 'Upstream request failed: upstream 400' },
      { type: 'tool', name: 'shell', input: '{"command":"ls"}' },
      { type: 'text', delta: 'DONE' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: SESSION_ID });
  });

  it('exit 0 但零事件且无 session id、有 stderr → 发诊断 error 事件（含 stderr），TurnResult 带 stderrTail', async () => {
    const child = makeFakeChild();
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(child);
    }) as unknown as SpawnFn);
    const handle = opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.stderr.emit('data', Buffer.from('config load failed: invalid json\n'));
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: '适配器未捕获到结构化输出；stderr 尾部：\nconfig load failed: invalid json' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result.stderrTail).toEqual(['config load failed: invalid json']);
  });

  it("spawn 'error'（ENOENT）：stderr 尾部含 spawn 失败信息 → 诊断 error 事件 + end(exitCode=-1)，不崩进程", async () => {
    const child = makeFakeChild();
    setSpawnFn(((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(child);
    }) as unknown as SpawnFn);
    const handle = opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));

    child.emit('error', new Error('spawn opencode ENOENT'));

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: '适配器未捕获到结构化输出；stderr 尾部：\nspawn 失败：spawn opencode ENOENT' },
      { type: 'end', exitCode: -1 },
    ]);
    expect(result).toEqual<TurnResult>({ exitCode: -1, adapterSessionId: null, stderrTail: ['spawn 失败：spawn opencode ENOENT'] });
  });

  it('kill：prelude 期间 kill → 不 spawn，end(exitCode=-1)', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(((cmd: string, args: string[], options: unknown) => {
      calls.push({ cmd, args: [...args], options: options as Record<string, unknown> });
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);
    const handle = opencodeAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));

    await handle.kill();
    const result = await handle.result;

    expect(events).toEqual([{ type: 'end', exitCode: -1 }]);
    expect(result).toEqual({ exitCode: -1, adapterSessionId: null });
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
  });
});

describe('opencode detect', () => {
  it('where 命中 + --version 输出存 version', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode v2.2.0\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    await expect(opencodeAdapter.detect()).resolves.toEqual({ installed: true, version: 'opencode v2.2.0' });
  });

  it('where/which 都失败 → installed=false version=null', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(opencodeAdapter.detect()).resolves.toEqual({ installed: false, version: null });
  });
});

describe('opencode listModels', () => {
  it('未安装 → 空数组', async () => {
    setSpawnFn(((cmd: string) => asChild(makeAutoChild([], 1))) as unknown as SpawnFn);

    await expect(opencodeAdapter.listModels()).resolves.toEqual([]);
  });

  it('--format json 输出 JSON 字符串数组 → 解析为 probed（不再回退）', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode v2.2.0\n' }], 0));
      }
      if (args[0] === 'models' && args.includes('--format')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: '["opencode-go/glm-5.3-flash","opencode-go/gpt-6-luna"]\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    const models = await opencodeAdapter.listModels();
    expect(models).toEqual([
      { id: 'opencode-go/glm-5.3-flash', source: 'probed' },
      { id: 'opencode-go/gpt-6-luna', source: 'probed' },
    ]);
  });

  it('实测 v2.2.0：models --format json 打印 help（非 JSON）→ 回退纯文本 provider/model 行', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode v2.2.0\n' }], 0));
      }
      if (args[0] === 'models' && args.includes('--format')) {
        return asChild(
          makeAutoChild([{ source: 'stdout', text: 'DESCRIPTION\n  List all available models\nUSAGE\n  opencode models [flags]\n' }], 0),
        );
      }
      if (args[0] === 'models') {
        return asChild(
          makeAutoChild(
            [
              {
                source: 'stdout',
                text: 'opencode-go/glm-5.3-flash\nopencode-go/gpt-6-luna\nminimax-cn/MiniMax-M3\n',
              },
            ],
            0,
          ),
        );
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    const models = await opencodeAdapter.listModels();
    expect(models).toEqual([
      { id: 'opencode-go/glm-5.3-flash', source: 'probed' },
      { id: 'opencode-go/gpt-6-luna', source: 'probed' },
      { id: 'minimax-cn/MiniMax-M3', source: 'probed' },
    ]);
  });

  it('两步都无模型行 → 空数组', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_EXE}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode v2.2.0\n' }], 0));
      }
      if (args.includes('models')) return asChild(makeAutoChild([{ source: 'stdout', text: 'no models here\n' }], 0));
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    await expect(opencodeAdapter.listModels()).resolves.toEqual([]);
  });

  it('win32 .cmd 垫片：models 两步探测都经解析 form（cmd.exe /d /s /c 包装），不经裸 OPENCODE_CMD', async () => {
    const calls: RecordedSpawn[] = [];
    setSpawnFn(((cmd: string, args: string[]) => {
      calls.push({ cmd, args: [...args], options: {} });
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${MOCK_SHIM}\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode v2.2.0\n' }], 0));
      }
      if (args.includes('models')) {
        // --format json 不被支持（打印 help）→ 回退纯文本行
        if (args.includes('--format')) {
          return asChild(makeAutoChild([{ source: 'stdout', text: 'DESCRIPTION\n  List models\n' }], 0));
        }
        return asChild(makeAutoChild([{ source: 'stdout', text: 'opencode-go/glm-5.3-flash\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    const models = await opencodeAdapter.listModels();
    expect(models).toEqual([{ id: 'opencode-go/glm-5.3-flash', source: 'probed' }]);

    const modelCalls = calls.filter((c) => c.args.includes('models'));
    expect(modelCalls.map((c) => c.args)).toEqual([
      ['/d', '/s', '/c', MOCK_SHIM, 'models', '--format', 'json'],
      ['/d', '/s', '/c', MOCK_SHIM, 'models'],
    ]);
    // 裸 OPENCODE_CMD 直 spawn 的 models 调用不允许出现
    expect(calls.some((c) => c.cmd === OPENCODE_CMD && c.args.includes('models'))).toBe(false);
  });
});

describe('parseOpencodeLine', () => {
  it('非法 JSON / 空行 / 非对象 JSON → 空数组（忽略）', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine('not json', state)).toEqual([]);
    expect(parseOpencodeLine('', state)).toEqual([]);
    expect(parseOpencodeLine('   ', state)).toEqual([]);
    expect(parseOpencodeLine('123', state)).toEqual([]);
    expect(parseOpencodeLine('"str"', state)).toEqual([]);
    expect(parseOpencodeLine('[1,2]', state)).toEqual([]);
  });

  it('顶层 sessionID 存入 state 且只取首次', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine(REAL_STEP_START, state)).toEqual([]);
    expect(state.sessionId).toBe(SESSION_ID);
    parseOpencodeLine(REAL_TEXT, state);
    expect(state.sessionId).toBe(SESSION_ID);
  });

  it('text → part.text 完整段；step_start/step_finish 忽略', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine(REAL_TEXT, state)).toEqual([{ type: 'text', delta: 'DONE' }]);
    expect(parseOpencodeLine(REAL_STEP_START, state)).toEqual([]);
    expect(parseOpencodeLine(REAL_STEP_FINISH, state)).toEqual([]);
  });

  it('行协议无 thinking/reasoning 映射：reasoning 类事件不发事件（仅 text/tool_use/error）', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine('{"type":"reasoning","part":{"text":"思考"}}', state)).toEqual([]);
    expect(parseOpencodeLine('{"type":"reasoning","part":{"text":""}}', state)).toEqual([]);
  });

  it('tool_use → part.tool + part.state.input（对象 JSON 化）', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine(REAL_TOOL_USE, state)).toEqual([{ type: 'tool', name: 'shell', input: '{"command":"ls"}' }]);
  });

  it('error → error.message；error 为字符串取原值；无 message 兜底', () => {
    const state = createOpencodeParseState();
    expect(parseOpencodeLine(REAL_ERROR, state)).toEqual([{ type: 'error', message: 'Upstream request failed: upstream 400' }]);
    expect(parseOpencodeLine('{"type":"error","error":"plain failure"}', state)).toEqual([
      { type: 'error', message: 'plain failure' },
    ]);
    expect(parseOpencodeLine('{"type":"error"}', state)).toEqual([{ type: 'error', message: 'opencode error' }]);
  });
});

describe('parseModelLines / tryParseModelsJson', () => {
  it('parseModelLines：provider/model 行 → probed，其余忽略', () => {
    expect(parseModelLines(['opencode-go/glm-5.3-flash', '', 'random line', 'a/b', '  spaced/x  '])).toEqual([
      { id: 'opencode-go/glm-5.3-flash', source: 'probed' },
      { id: 'a/b', source: 'probed' },
      { id: 'spaced/x', source: 'probed' },
    ]);
    expect(parseModelLines(['no slash'])).toEqual([]);
  });

  it('tryParseModelsJson：字符串数组 → ids；help 文本/空 → null', () => {
    expect(tryParseModelsJson(['["a/b","c/d"]'])).toEqual(['a/b', 'c/d']);
    expect(tryParseModelsJson(['DESCRIPTION', '  List all available models'])).toBeNull();
    expect(tryParseModelsJson([])).toBeNull();
    expect(tryParseModelsJson(['{"models":["a/b"]}'])).toBeNull();
  });
});
