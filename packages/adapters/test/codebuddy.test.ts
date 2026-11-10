import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('参数拼装：首次无 --resume；续轮 --model 与 --resume 按序；stream-json + 增量 flag 收尾；win32 .exe 直连', async () => {
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
    expect(runs[0]).toMatchObject({
      cmd: MOCK_EXE,
      args: ['-p', '第一轮', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
    });
    expect(runs[1]).toMatchObject({
      cmd: MOCK_EXE,
      args: [
        '-p', '第二轮', '--model', 'glm-5.3', '--resume', 'sess-1',
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ],
    });
    expect(runs[0]!.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('verified model receives native image blocks on first and resumed turns', async () => {
    const { calls, spawned } = recordSpawns();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-codebuddy-image-'));
    const path = join(dir, 'proof.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(path, bytes);

    try {
      expect((codebuddyAdapter.supportsImageInput as (model: string | undefined, cliVersion?: string | null) => boolean)('minimax-m3.1-flash', '2.179.2')).toBe(true);
      expect((codebuddyAdapter.supportsImageInput as (model: string | undefined, cliVersion?: string | null) => boolean)('minimax-m3.1-flash', '2.179.3')).toBe(false);
      expect((codebuddyAdapter.supportsImageInput as (model: string | undefined, cliVersion?: string | null) => boolean)('minimax-m3.1-flash', null)).toBe(false);
      expect((codebuddyAdapter.supportsImageInput as (model: string | undefined, cliVersion?: string | null) => boolean)('glm-5.3', '2.179.2')).toBe(false);

      const first = codebuddyAdapter.runTurn({
        cwd: 'D:\\w',
        model: 'minimax-m3.1-flash',
        detectedCliVersion: '2.179.2',
        prompt: '请识别图中形状',
        attachments: [{ path, mimeType: 'image/png' }],
      });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      let runs = calls.filter((call) => call.args[0] === '-p');
      expect(runs[0]!.args).toEqual([
        '-p', '--model', 'minimax-m3.1-flash', '--output-format', 'stream-json',
        '--input-format', 'stream-json', '--verbose',
      ]);
      expect(runs[0]!.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      const firstInput = (spawned[0] as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin.write.mock.calls[0]![0] as string;
      expect(JSON.parse(firstInput)).toEqual({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '请识别图中形状' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
          ],
        },
      });
      spawned[0]!.stdout.emit('data', Buffer.from(`${JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'text', text: '4 orange squares' }] }, session_id: 'session-image',
      })}\n`));
      closeChild(spawned[0]!, 0);
      expect((await first.result).exitCode).toBe(0);

      const resumed = codebuddyAdapter.runTurn({
        cwd: 'D:\\w',
        model: 'minimax-m3.1-flash',
        detectedCliVersion: '2.179.2',
        prompt: '继续识别',
        adapterSessionId: 'session-image',
        attachments: [{ path, mimeType: 'image/png' }],
      });
      await vi.waitFor(() => expect(spawned).toHaveLength(2));
      runs = calls.filter((call) => call.args[0] === '-p');
      expect(runs[1]!.args).toEqual([
        '-p', '--model', 'minimax-m3.1-flash', '--resume', 'session-image',
        '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      ]);
      const resumeInput = (spawned[1] as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin.write.mock.calls[0]![0] as string;
      expect(JSON.parse(resumeInput).message.content[1]).toEqual({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
      });
      spawned[1]!.stdout.emit('data', Buffer.from(`${JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'text', text: '6 purple squares' }] }, session_id: 'session-image',
      })}\n`));
      closeChild(spawned[1]!, 0);
      expect((await resumed.result).exitCode).toBe(0);

      expect(() => codebuddyAdapter.runTurn({
        cwd: 'D:\\w', model: 'glm-5.3', prompt: '不要静默降级', attachments: [{ path, mimeType: 'image/png' }],
      })).toThrow('IMAGE_DELIVERY_UNVERIFIED');
      expect(() => codebuddyAdapter.runTurn({
        cwd: 'D:\\w', model: 'minimax-m3.1-flash', prompt: '缺少CLI版本', attachments: [{ path, mimeType: 'image/png' }],
      })).toThrow('IMAGE_DELIVERY_UNVERIFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report successful image delivery when the CLI exits without assistant text', async () => {
    const { spawned } = recordSpawns();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-codebuddy-empty-image-'));
    const path = join(dir, 'proof.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      const handle = codebuddyAdapter.runTurn({
        cwd: 'D:\\w', model: 'minimax-m3.1-flash', detectedCliVersion: '2.179.2', prompt: '识别合成图',
        attachments: [{ path, mimeType: 'image/png' }],
      });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      closeChild(spawned[0]!, 0);
      expect((await handle.result).exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(wrapped.args.slice(4)).toEqual([
      '-p', '第一轮', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]);
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

  it('exit 0 但零事件且无 session id、有 stderr → 发诊断 error 事件（含 stderr），TurnResult 带 stderrTail', async () => {
    const { spawned } = recordSpawns();
    const handle = codebuddyAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;

    child.stderr.emit('data', Buffer.from('FATAL: 权限被拒绝\n第二行错误\n'));
    closeChild(child, 0);

    const result = await resultPromise;
    expect(events).toEqual([
      { type: 'error', message: '适配器未捕获到结构化输出；stderr 尾部：\nFATAL: 权限被拒绝\n第二行错误' },
      { type: 'end', exitCode: 0 },
    ]);
    expect(result.stderrTail).toEqual(['FATAL: 权限被拒绝', '第二行错误']);
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

  it('--version 非零退出时保留 installed 但丢弃不可信版本', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') return asChild(whereExeChild());
      if (cmd === MOCK_EXE && args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: '2.179.2\n' }], 1));
      }
      throw new Error(`unexpected spawn: ${cmd}`);
    }) as unknown as SpawnFn);

    await expect(codebuddyAdapter.detect()).resolves.toEqual({ installed: true, version: null });
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

  it('行协议无 thinking/reasoning 映射：assistant thinking 内容块不发事件（仅 text/tool_use）', () => {
    const state = createParseState();
    expect(
      parseCodebuddyLine(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"内部思考"}]}}',
        state,
      ),
    ).toEqual([]);
    expect(parseCodebuddyLine('{"type":"reasoning","text":"思考"}', state)).toEqual([]);
  });
});

// 以下 fixture 行取自本机 codebuddy 2.179.2 实跑
// `codebuddy -p ... --output-format stream-json --verbose --include-partial-messages` 的原始 stdout。
const REAL_MESSAGE_START =
  '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant"}},"session_id":"s1"}';
const REAL_TEXT_DELTA_FIRST =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"先"}},"session_id":"s1"}';
const REAL_TEXT_DELTA_SECOND =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"说答案"}},"session_id":"s1"}';
const REAL_THINKING_DELTA =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user wants a Chinese answer."}},"session_id":"s1"}';
const REAL_ASSISTANT_FULL =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"先说答案"}]},"session_id":"s1"}';

describe('parseCodebuddyLine 增量（--include-partial-messages）', () => {
  it('content_block_delta 的 text_delta 逐条解析为 text 事件，顺序与原文一致', () => {
    const state = createParseState();
    expect(parseCodebuddyLine(REAL_MESSAGE_START, state)).toEqual([]);
    expect(parseCodebuddyLine(REAL_TEXT_DELTA_FIRST, state)).toEqual([{ type: 'text', delta: '先' }]);
    expect(parseCodebuddyLine(REAL_TEXT_DELTA_SECOND, state)).toEqual([{ type: 'text', delta: '说答案' }]);
  });

  it('thinking_delta 映射 thinking 事件（与正文分开）', () => {
    const state = createParseState();
    expect(parseCodebuddyLine(REAL_THINKING_DELTA, state)).toEqual([
      { type: 'thinking', delta: 'The user wants a Chinese answer.' },
    ]);
  });

  it('已发过增量的完整 assistant 不再重复正文（正文不翻倍）', () => {
    const state = createParseState();
    parseCodebuddyLine(REAL_MESSAGE_START, state);
    parseCodebuddyLine(REAL_TEXT_DELTA_FIRST, state);
    parseCodebuddyLine(REAL_TEXT_DELTA_SECOND, state);
    // 末尾整条 assistant 与增量同文：不得再发 text
    expect(parseCodebuddyLine(REAL_ASSISTANT_FULL, state)).toEqual([]);
  });

  it('message_start 重置增量标记：下一条无增量的 assistant 仍输出正文（回退不退化）', () => {
    const state = createParseState();
    parseCodebuddyLine(REAL_MESSAGE_START, state);
    parseCodebuddyLine(REAL_TEXT_DELTA_FIRST, state);
    parseCodebuddyLine(REAL_ASSISTANT_FULL, state);
    // 新消息开始后没有 delta（老格式/无增量），assistant 正文必须照常输出
    parseCodebuddyLine(REAL_MESSAGE_START, state);
    expect(parseCodebuddyLine(REAL_ASSISTANT_FULL, state)).toEqual([{ type: 'text', delta: '先说答案' }]);
  });

  it('未知/残缺 stream_event 结构 → 空数组，不抛错', () => {
    const state = createParseState();
    expect(parseCodebuddyLine('{"type":"stream_event"}', state)).toEqual([]);
    expect(parseCodebuddyLine('{"type":"stream_event","event":null}', state)).toEqual([]);
    expect(parseCodebuddyLine('{"type":"stream_event","event":"text"}', state)).toEqual([]);
    expect(parseCodebuddyLine('{"type":"stream_event","event":{"type":"content_block_delta"}}', state)).toEqual([]);
    expect(
      parseCodebuddyLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}', state),
    ).toEqual([]);
    expect(
      parseCodebuddyLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":""}}}', state),
    ).toEqual([]);
  });
});

describe('ask 事件与回答回填', () => {
  it('AskUserQuestion 只升级为 ask 事件（不再产出同名 tool），其余 tool_use 仍走 tool 事件', () => {
    const state = createParseState();
    const events = parseCodebuddyLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_ask',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: '选哪个图？',
                    options: [{ label: '方形', description: '4 个' }, { label: '圆形' }],
                  },
                ],
              },
            },
            { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: 'ask',
        request_id: 'toolu_1',
        question: '选哪个图？',
        options: [{ label: '方形', description: '4 个' }, { label: '圆形' }],
        step_id: 'msg_ask',
      },
      { type: 'tool', name: 'Bash', input: '{"cmd":"ls"}' },
    ]);
  });

  it('CHAT-ASK-DEFER：真实 stdout 的 DeferExecuteTool{toolName:"AskUserQuestion"} 归一为 ask（codebuddy 2.179.2）', () => {
    const state = createParseState();
    // 整行取自本机 codebuddy 2.179.2 实跑（-p 触发提问，--output-format stream-json --verbose）
    const events = parseCodebuddyLine(
      '{"type":"assistant","uuid":"01a1c32e-97e4-7dd8-b28d-1a5a3fdb16a6","message":{"id":"01a1c32e83717a919e26c514b43d79d2","content":[{"type":"tool_use","id":"call_ff2718d553bf0778f3cdf71f","name":"DeferExecuteTool","input":{"params":{"options":["继续","停止"],"question":"继续吗？"},"toolName":"AskUserQuestion"}}],"model":"minimax-m3.1-flash","role":"assistant","stop_reason":"tool_use","type":"message"}}',
      state,
    );
    expect(events).toEqual([
      {
        type: 'ask',
        request_id: 'call_ff2718d553bf0778f3cdf71f',
        question: '继续吗？',
        options: [{ label: '继续' }, { label: '停止' }],
        step_id: '01a1c32e83717a919e26c514b43d79d2',
      },
    ]);
  });

  it('deferred 形态只认提问工具：其他 toolName 与缺 params 仍走普通 tool 事件', () => {
    const state = createParseState();
    const events = parseCodebuddyLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_def',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'DeferExecuteTool', input: { toolName: 'Bash', params: { cmd: 'ls' } } },
            { type: 'tool_use', id: 'call_b', name: 'DeferExecuteTool', input: { toolName: 'AskUserQuestion' } },
          ],
        },
      }),
      state,
    );
    expect(events[0]).toEqual({ type: 'tool', name: 'DeferExecuteTool', input: '{"toolName":"Bash","params":{"cmd":"ls"}}' });
    expect(events[1]?.type).toBe('ask');
  });

  it('扁平入参 {question, options} 与缺字段兜底；无 tool_use id 时用本轮序号生成 request_id', () => {
    const state = createParseState();
    const first = parseCodebuddyLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: '继续吗？', options: ['继续'] } }] },
      }),
      state,
    );
    expect(first).toEqual([
      { type: 'ask', request_id: 'ask-1', question: '继续吗？', options: [{ label: '继续' }], step_id: null },
    ]);
    const second = parseCodebuddyLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }),
      state,
    );
    expect(second).toEqual([{ type: 'ask', request_id: 'ask-2', question: '', options: [], step_id: null }]);
    // 非白名单工具不受影响（大小写/近似名都不算提问）
    expect(
      parseCodebuddyLine(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'askuserquestion', input: {} }] } }),
        state,
      ),
    ).toEqual([{ type: 'tool', name: 'askuserquestion', input: '{}' }]);
  });

  it('stream-json 输入轮次：回答以 tool_result 写入 stdin，同一提问只能回填一次；子进程可继续产出', async () => {
    const { spawned } = recordSpawns();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-codebuddy-ask-'));
    const path = join(dir, 'proof.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      const handle = codebuddyAdapter.runTurn({
        cwd: 'D:\\w',
        model: 'minimax-m3.1-flash',
        detectedCliVersion: '2.179.2',
        prompt: '识别图中形状',
        attachments: [{ path, mimeType: 'image/png' }],
      });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      const child = spawned[0]!;
      const events: UnifiedEvent[] = [];
      handle.onEvent((e) => events.push(e));

      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'assistant',
            session_id: 's1',
            message: {
              id: 'msg_ask',
              content: [
                { type: 'text', text: '先问一句' },
                {
                  type: 'tool_use',
                  id: 'toolu_ask',
                  name: 'AskUserQuestion',
                  input: { questions: [{ question: '继续吗？', options: [{ label: '继续' }] }] },
                },
              ],
            },
          })}\n`,
        ),
      );
      await vi.waitFor(() => expect(events.some((e) => e.type === 'ask')).toBe(true));

      await handle.answer!('toolu_ask', '继续');
      const written = child.stdin.write.mock.calls.at(-1)![0] as string;
      expect(JSON.parse(written)).toEqual({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: '继续' }],
        },
      });
      expect(written.endsWith('\n')).toBe(true);

      await expect(handle.answer!('toolu_ask', '继续')).rejects.toMatchObject({
        name: 'AskAnswerError',
        code: 'ALREADY_ANSWERED',
      });
      await expect(handle.answer!('toolu_missing', 'x')).rejects.toMatchObject({ code: 'UNKNOWN_ASK' });

      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'assistant',
            session_id: 's1',
            message: { content: [{ type: 'text', text: '已继续' }] },
          })}\n`,
        ),
      );
      closeChild(child, 0);
      const result = await handle.result;
      expect(result.exitCode).toBe(0);
      expect(events.filter((e) => e.type === 'text')).toHaveLength(2);

      await expect(handle.answer!('toolu_ask', '再来')).rejects.toMatchObject({ code: 'TURN_ENDED' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非 stream-json 输入轮次：ask 事件照常发出（不再降级为 tool），但回填以 STDIN_UNAVAILABLE 拒绝且不崩进程', async () => {
    const { spawned } = recordSpawns();
    const handle = codebuddyAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));

    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'AskUserQuestion', input: { question: '?' } }] },
        })}\n`,
      ),
    );
    await vi.waitFor(() => expect(events.some((e) => e.type === 'ask')).toBe(true));
    expect(events.some((e) => e.type === 'tool')).toBe(false);

    await expect(handle.answer!('toolu_x', '好')).rejects.toMatchObject({
      name: 'AskAnswerError',
      code: 'STDIN_UNAVAILABLE',
    });
    closeChild(child, 0);
    await expect(handle.result).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe('codebuddy runTurn 增量落定（无重复、结束后无残留）', () => {
  it('多条 text_delta 逐条下发，末尾完整 assistant 不重复，end 之后不再有事件', async () => {
    const { spawned } = recordSpawns();
    const handle = codebuddyAdapter.runTurn({ cwd: '.', prompt: 'hi' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const events: UnifiedEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const resultPromise = handle.result;

    child.stdout.emit(
      'data',
      Buffer.from([REAL_MESSAGE_START, REAL_TEXT_DELTA_FIRST, REAL_TEXT_DELTA_SECOND, REAL_ASSISTANT_FULL, ''].join('\n') + '\n'),
    );
    closeChild(child, 0);
    const result = await resultPromise;

    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta);
    expect(texts).toEqual(['先', '说答案']);
    expect(texts.join('')).toBe('先说答案'); // 增量拼接 == 完整正文，且只出现一次
    expect(events[events.length - 1]).toEqual({ type: 'end', exitCode: 0 });
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1);
    expect(result).toEqual<TurnResult>({ exitCode: 0, adapterSessionId: 's1' });
  });
});
