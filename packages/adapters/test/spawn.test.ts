import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asChild, closeChild, makeAutoChild, makeFakeChild, type FakeChild } from './helpers.js';
import {
  collectOutput,
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  setSpawnFn,
  spawnLineChild,
  SpawnFailedError,
  whereCommand,
  type SpawnFn,
} from '../src/spawn.js';

describe('spawnLineChild', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('参数数组直传 spawnFn，不经 shell（shell:false + windowsHide:true）', () => {
    const spawnCalls: Array<{ cmd: string; args: string[]; options: unknown }> = [];
    setSpawnFn(((cmd: string, args: string[], options: unknown) => {
      spawnCalls.push({ cmd, args: [...args], options });
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    spawnLineChild('codebuddy', ['-p', 'hi'], 'D:\\w');

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe('codebuddy');
    expect(spawnCalls[0]!.args).toEqual(['-p', 'hi']);
    expect(spawnCalls[0]!.options).toMatchObject({ cwd: 'D:\\w', shell: false, windowsHide: true });
  });

  it('spawn 一律 stdin ignore：stdio = [ignore, pipe, pipe]（防交互模式等待挂死，stdout/stderr 管道不变）', () => {
    const spawnCalls: Array<{ options: { stdio?: string[] } }> = [];
    setSpawnFn(((_cmd: string, _args: string[], options: { stdio?: string[] }) => {
      spawnCalls.push({ options });
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    spawnLineChild('codex', ['exec', 'hi'], '.');

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('keepStdinOpen：写入初稿后不 end，stdin 可继续写入；进程退出后以 STDIN_CLOSED 拒绝', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.', { stdinText: 'one\n', keepStdinOpen: true });

    expect(child.stdin.write.mock.calls[0]![0]).toBe('one\n');
    expect(child.stdin.end).not.toHaveBeenCalled();
    await expect(lc.writeStdin('two\n')).resolves.toBeUndefined();
    expect(child.stdin.write.mock.calls.at(-1)![0]).toBe('two\n');

    closeChild(child, 0);
    await expect(lc.writeStdin('three\n')).rejects.toMatchObject({
      name: 'StdinWriteError',
      code: 'STDIN_CLOSED',
    });
  });

  it('未开放 stdin 管道时 writeStdin 以 STDIN_UNAVAILABLE 拒绝（不抛同步异常）', async () => {
    setSpawnFn(() => asChild(makeFakeChild()));
    const lc = spawnLineChild('x', [], '.');

    await expect(lc.writeStdin('x')).rejects.toMatchObject({
      name: 'StdinWriteError',
      code: 'STDIN_UNAVAILABLE',
    });
  });

  it('stdin 写入回调报错 → STDIN_WRITE_FAILED（明确错误，不吞掉）', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.', { keepStdinOpen: true });

    child.stdin.write.mockImplementationOnce((_chunk: string, cb?: (err?: Error | null) => void) => {
      cb?.(new Error('EPIPE'));
      return true;
    });
    await expect(lc.writeStdin('a')).rejects.toMatchObject({
      name: 'StdinWriteError',
      code: 'STDIN_WRITE_FAILED',
      message: '写入 stdin 失败：EPIPE',
    });
  });

  it('opts.env 合并进 spawn 选项', () => {
    let captured: { env?: Record<string, string> } | undefined;
    setSpawnFn(((_cmd: string, _args: string[], options: { env?: Record<string, string> }) => {
      captured = options;
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    spawnLineChild('x', [], '.', { env: { FOO: 'bar' } });

    expect(captured?.env).toMatchObject({ FOO: 'bar' });
  });

  it('逐行分发 stdout/stderr：跨 chunk 缓冲、CRLF 剥离、末尾无换行行在 close 时补发', () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.');
    const lines: Array<['stdout' | 'stderr', string]> = [];
    lc.onLine((source, line) => lines.push([source, line]));

    child.stdout.emit('data', Buffer.from('a1\na'));
    child.stdout.emit('data', Buffer.from('2\r\nb1\n中文'));
    child.stderr.emit('data', Buffer.from('e1\n'));
    closeChild(child, 0);

    expect(lines).toEqual([
      ['stdout', 'a1'],
      ['stdout', 'a2'],
      ['stdout', 'b1'],
      ['stderr', 'e1'],
      ['stdout', '中文'],
    ]);
  });

  it('getStderrTail：stderr 尾部环形缓冲保留最近 30 行（含 close 补发的末尾行）', () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.');

    const many = Array.from({ length: 35 }, (_, i) => `e${i + 1}`);
    child.stderr.emit('data', Buffer.from(many.join('\n') + '\n尾部残行'));
    closeChild(child, 0);

    expect(lc.getStderrTail()).toEqual([...many.slice(6), '尾部残行']);
    expect(lc.getStderrTail()).toHaveLength(30);
    // 返回拷贝：外部修改不影响内部缓冲
    const tail = lc.getStderrTail();
    tail.length = 0;
    expect(lc.getStderrTail()).toHaveLength(30);
  });

  it('正常退出：onClose 与 exit promise 收到退出码 0', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.');
    const closeCodes: Array<number | null> = [];
    lc.onClose((code) => closeCodes.push(code));

    closeChild(child, 0);

    await expect(lc.exit).resolves.toBe(0);
    expect(closeCodes).toEqual([0]);
  });

  it('非零 exit：退出码透传', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.');
    const closeCodes: Array<number | null> = [];
    lc.onClose((code) => closeCodes.push(code));

    closeChild(child, 3);

    await expect(lc.exit).resolves.toBe(3);
    expect(closeCodes).toEqual([3]);
  });

  it('kill：child.kill() 后进程退出即返回，不再 taskkill', async () => {
    const spawnCalls: Array<{ cmd: string }> = [];
    const child = makeFakeChild();
    setSpawnFn(((cmd: string) => {
      spawnCalls.push({ cmd });
      return asChild(child);
    }) as unknown as SpawnFn);
    const lc = spawnLineChild('sleeper', [], '.');

    const p = lc.kill();
    closeChild(child, 143);
    await p;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(spawnCalls.filter((c) => c.cmd === 'taskkill')).toHaveLength(0);
  });

  it('kill 兜底：1s 未退则 taskkill /PID /T /F（Windows tree-kill）', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const child = makeFakeChild();
    child.kill = vi.fn(() => true); // 假装进程对 kill 无响应
    const taskkillChild: FakeChild = makeFakeChild(999);
    setSpawnFn(((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args: [...args] });
      return asChild(cmd === 'taskkill' ? taskkillChild : child);
    }) as unknown as SpawnFn);
    const lc = spawnLineChild('sleeper', [], '.');

    const p = lc.kill();
    await vi.advanceTimersByTimeAsync(1000);

    expect(spawnCalls).toContainEqual({ cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });

    taskkillChild.emit('exit', 0);
    closeChild(child, 1);
    await p;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

// ---- spawn 'error'（ENOENT 等）防御：异常退出归一，绝不留 unhandled 'error' / unhandledRejection ----

describe('spawnLineChild / collectOutput spawn error（ENOENT 防御）', () => {
  afterEach(() => {
    setSpawnFn(((cmd: string) => {
      throw new Error(`unexpected spawn after test: ${cmd}`);
    }) as unknown as SpawnFn);
  });

  /** 每次被 spawn 都在下一个微任务触发 'error' 事件的假进程（每次 spawn 新建，避免复用后事件流挂起）。 */
  function setErrorSpawningChild(message: string): void {
    setSpawnFn((() => {
      const c = makeFakeChild();
      queueMicrotask(() => c.emit('error', new Error(message)));
      return asChild(c);
    }) as unknown as SpawnFn);
  }

  it("child 'error' 事件：error.message 写入 stderr 尾部、exit 归一 null、onClose 触发一次；迟到的 close 幂等", async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('opencode', [], '.');
    const closeCodes: Array<number | null> = [];
    lc.onClose((code) => closeCodes.push(code));

    child.emit('error', new Error('spawn opencode ENOENT'));

    await expect(lc.exit).resolves.toBeNull();
    expect(closeCodes).toEqual([null]);
    expect(lc.getStderrTail()).toEqual(['spawn 失败：spawn opencode ENOENT']);

    closeChild(child, 0);
    expect(closeCodes).toEqual([null]);
  });

  it('collectOutput：spawn error → 以 SpawnFailedError reject（code SPAWN_FAILED，message 含命令名与原始原因）', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const p = collectOutput('opencode', ['models']);
    child.emit('error', new Error('spawn opencode ENOENT'));

    await expect(p).rejects.toMatchObject({
      name: 'SpawnFailedError',
      code: 'SPAWN_FAILED',
      message: 'spawn opencode 失败：spawn opencode ENOENT',
    });
    await expect(p).rejects.toBeInstanceOf(SpawnFailedError);
  });

  it('只等 exit/onClose、不观察 failure：spawn error 不产生 unhandledRejection（vitest 对 unhandled 默认判失败）', async () => {
    const child = makeFakeChild();
    setSpawnFn(() => asChild(child));
    const lc = spawnLineChild('x', [], '.');

    child.emit('error', new Error('spawn x ENOENT'));

    await expect(lc.exit).resolves.toBeNull();
  });

  it('whereCommand：finder 自身 spawn 失败 → 返回 []（探测不抛错契约）', async () => {
    setErrorSpawningChild('spawn where ENOENT');

    await expect(whereCommand('codex')).resolves.toEqual([]);
  });

  it('kill：spawn error 后进程已异常退出，kill 直接返回不再 taskkill', async () => {
    const spawnCalls: Array<{ cmd: string }> = [];
    const child = makeFakeChild();
    setSpawnFn(((cmd: string) => {
      spawnCalls.push({ cmd });
      return asChild(child);
    }) as unknown as SpawnFn);
    const lc = spawnLineChild('sleeper', [], '.');

    child.emit('error', new Error('spawn sleeper ENOENT'));
    await lc.exit;
    await lc.kill();

    expect(spawnCalls.filter((c) => c.cmd === 'taskkill')).toHaveLength(0);
  });
});

// ---- win32 .cmd/.bat 垫片解析为 node 入口（npm cmd-shim 丢参进 cmd 交互模式的修复） ----

// 标准 npm cmd-shim 形态：SET 行、IF EXIST 分支、"%_prog%" 变量、引号包裹入口、%* 透传
const STANDARD_NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b %dp0%',
  '',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  '',
].join('\r\n');

// 变形垫片：紧凑 IF EXIST/SET 行、无 endLocal 行
const VARIANT_SHIM = [
  '@echo off',
  'SET dp0=%~dp0',
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  '"%_prog%" "%dp0%\\node_modules\\foo\\bin\\cli.js" %*',
  '',
].join('\r\n');

// 变形垫片：node 直写、路径无引号
const BARE_SHIM = '@echo off\r\nnode %dp0%\\node_modules\\foo\\bin\\cli2.js %*\r\n';

// GBK(OEM 码页) 编码垫片：路径含中文段（GBK 字节 0xB2E2 0xCAD4 = "测试"），utf8 解码出替换符后按 GBK 重解码
const GBK_SHIM_BUF = Buffer.concat([
  Buffer.from('@echo off\r\nnode "%dp0%\\node_modules\\', 'utf8'),
  Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
  Buffer.from('\\bin\\cli.js" %*\r\n', 'utf8'),
]);

const hasGbkDecoder = (() => {
  try {
    new TextDecoder('gbk');
    return true;
  } catch {
    return false;
  }
})();

/** 写垫片 fixture：可选同时创建入口 js（垫片解析含入口存在性校验）。 */
function writeShimFixture(root: string, shimName: string, content: string | Buffer, jsRel?: string[]): string {
  if (jsRel) {
    const jsPath = join(root, ...jsRel);
    mkdirSync(dirname(jsPath), { recursive: true });
    writeFileSync(jsPath, '');
  }
  const shimPath = join(root, shimName);
  writeFileSync(shimPath, content);
  return shimPath;
}

describe('resolveWindowsSpawnForm / resolveSpawnForm（win32 .cmd/.bat 垫片）', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adapters-shim-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('标准 npm shim：解析为 node + 绝对 .js 入口', () => {
    const jsRel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
    const shimPath = writeShimFixture(root, 'codex.cmd', STANDARD_NPM_SHIM, jsRel);

    expect(resolveWindowsSpawnForm([shimPath], 'codex')).toEqual({ cmd: 'node', prefix: [join(root, ...jsRel)] });
  });

  it('变形 shim（SET 行/紧凑 IF EXIST、node 直写无引号路径）→ 解析成功', () => {
    const cliJs = ['node_modules', 'foo', 'bin', 'cli.js'];
    writeShimFixture(root, 'variant.cmd', VARIANT_SHIM, cliJs);
    const cli2Js = ['node_modules', 'foo', 'bin', 'cli2.js'];
    const bareShimPath = writeShimFixture(root, 'bare.cmd', BARE_SHIM, cli2Js);

    expect(resolveWindowsSpawnForm([join(root, 'variant.cmd')], 'x')).toEqual({
      cmd: 'node',
      prefix: [join(root, ...cliJs)],
    });
    expect(resolveWindowsSpawnForm([bareShimPath], 'x')).toEqual({
      cmd: 'node',
      prefix: [join(root, ...cli2Js)],
    });
  });

  it.skipIf(!hasGbkDecoder)('GBK(OEM 码页) 编码垫片（路径含中文段）→ 解析成功', () => {
    const cliJs = ['node_modules', '测试', 'bin', 'cli.js'];
    const shimPath = writeShimFixture(root, 'gbk.cmd', GBK_SHIM_BUF, cliJs);

    expect(resolveWindowsSpawnForm([shimPath], 'x')).toEqual({ cmd: 'node', prefix: [join(root, ...cliJs)] });
  });

  it('无法解析（无 node 入口）、垫片不可读、入口 js 不存在 → 回退 cmd.exe /d /s /c 包装', () => {
    const garbageShim = writeShimFixture(root, 'garbage.cmd', '@ECHO off\r\necho hi %*\r\n');
    const noEntryShim = writeShimFixture(root, 'noentry.cmd', '@echo off\r\nnode "%dp0%\\ghost\\missing.js" %*\r\n');
    const missingShim = join(root, 'missing.cmd');

    for (const shimPath of [garbageShim, noEntryShim, missingShim]) {
      expect(resolveWindowsSpawnForm([shimPath], 'x')).toEqual({
        cmd: 'cmd.exe',
        prefix: ['/d', '/s', '/c', shimPath],
      });
    }
  });

  it('resolveSpawnForm 回归：where 命中 .cmd 垫片时返回 node 形态（cmd.exe 包装仅作回退）', async () => {
    const jsRel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
    const shimPath = writeShimFixture(root, 'codex.cmd', STANDARD_NPM_SHIM, jsRel);
    setSpawnFn(((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        return asChild(makeAutoChild([{ source: 'stdout', text: `${shimPath}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    await expect(resolveSpawnForm('codex')).resolves.toEqual({ cmd: 'node', prefix: [join(root, ...jsRel)] });
  });

  // CR2-9：形态探测成功后按命令缓存，避免每轮 turn 都起 where 子进程
  it('resolveSpawnForm 缓存：首测成功后第二次不再起 where 子进程', async () => {
    const jsRel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
    const shimPath = writeShimFixture(root, 'codex.cmd', STANDARD_NPM_SHIM, jsRel);
    const whereCalls: string[] = [];
    setSpawnFn(((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        whereCalls.push(cmd);
        return asChild(makeAutoChild([{ source: 'stdout', text: `${shimPath}\n` }], 0));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    const first = await resolveSpawnForm('codex');
    const second = await resolveSpawnForm('codex');
    expect(second).toEqual(first);
    expect(whereCalls).toHaveLength(1);
  });

  it('resolveSpawnForm 不缓存失败：where 无结果后装好 CLI，下一次仍能探测到形态', async () => {
    const jsRel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
    const shimPath = writeShimFixture(root, 'codex.cmd', STANDARD_NPM_SHIM, jsRel);
    let installed = false;
    setSpawnFn(((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        return installed
          ? asChild(makeAutoChild([{ source: 'stdout', text: `${shimPath}\n` }], 0))
          : asChild(makeAutoChild([], 1));
      }
      return asChild(makeFakeChild());
    }) as unknown as SpawnFn);

    await expect(resolveSpawnForm('codex')).resolves.toEqual({ cmd: 'codex', prefix: [] });
    installed = true;
    await expect(resolveSpawnForm('codex')).resolves.toEqual({ cmd: 'node', prefix: [join(root, ...jsRel)] });
  });
});
