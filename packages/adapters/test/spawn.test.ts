import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asChild, closeChild, makeFakeChild, type FakeChild } from './helpers.js';
import { setSpawnFn, spawnLineChild, type SpawnFn } from '../src/spawn.js';

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
