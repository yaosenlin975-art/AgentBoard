import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asChild, closeChild, makeAutoChild, makeFakeChild, type FakeChild } from './helpers.js';
import {
  resolveSpawnForm,
  resolveWindowsSpawnForm,
  setSpawnFn,
  spawnLineChild,
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
});
