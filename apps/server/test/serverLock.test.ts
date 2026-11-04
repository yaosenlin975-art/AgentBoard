/**
 * SERVER-SINGLETON：单例锁（原子创建 / 活持有者拒绝 / 陈旧锁接管 / 只释放自己那把）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireServerLock,
  describeLockHolder,
  isProcessAlive,
  readServerLock,
  releaseServerLock,
  serverLockPath,
} from '../src/services/serverLock.js';

describe('server singleton lock (SERVER-SINGLETON)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-lock-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const acquire = (over: Partial<Parameters<typeof acquireServerLock>[0]> = {}) => acquireServerLock({
    configDir: dir,
    dbPath: join(dir, 'agentboard.db'),
    port: 8787,
    instanceId: 'inst-a',
    now: () => 1_700_000_000_000,
    alive: () => false,
    ...over,
  });

  it('空目录：原子创建成功，写入 pid/port/dbPath/startedAt/instanceId', () => {
    const result = acquire({ pid: 4242 });
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(serverLockPath(dir), 'utf8'));
    expect(written).toEqual({ pid: 4242, port: 8787, dbPath: join(dir, 'agentboard.db'), startedAt: 1_700_000_000_000, instanceId: 'inst-a' });
  });

  it('活持有者（同 DB）→ 拒绝并给出持有者，不覆盖锁', () => {
    acquire({ pid: 1111, instanceId: 'inst-holder' });
    const second = acquire({ pid: 2222, instanceId: 'inst-b', alive: (pid) => pid === 1111 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('held-by-live');
    expect(second.holder).toMatchObject({ pid: 1111, instanceId: 'inst-holder' });
    // 原锁未被改写
    expect(readServerLock(dir)).toMatchObject({ pid: 1111, instanceId: 'inst-holder' });
  });

  it('活持有者（另一个端口也算占着同一 configDir/DB）→ 仍然拒绝', () => {
    acquire({ pid: 1111, port: 8787 });
    const second = acquire({ pid: 2222, port: 9999, alive: (pid) => pid === 1111 });
    expect(second.ok).toBe(false);
  });

  it('陈旧锁（pid 已死）→ 接管并回报旧持有者', () => {
    acquire({ pid: 1111, instanceId: 'inst-dead' });
    const second = acquire({ pid: 2222, instanceId: 'inst-new', alive: () => false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tookOver).toMatchObject({ pid: 1111, instanceId: 'inst-dead' });
    expect(readServerLock(dir)).toMatchObject({ pid: 2222, instanceId: 'inst-new' });
  });

  it('损坏的锁文件按陈旧处理（可接管）', () => {
    writeFileSync(serverLockPath(dir), 'not-json', 'utf8');
    const result = acquire({ pid: 3333, instanceId: 'inst-c' });
    expect(result.ok).toBe(true);
    expect(readServerLock(dir)).toMatchObject({ pid: 3333 });
  });

  it('释放只删自己那把：pid 或 instanceId 不匹配都不删', () => {
    acquire({ pid: 4444, instanceId: 'inst-d' });
    expect(releaseServerLock(dir, { pid: 4444, instanceId: 'other' })).toBe(false);
    expect(releaseServerLock(dir, { pid: 9999, instanceId: 'inst-d' })).toBe(false);
    expect(existsSync(serverLockPath(dir))).toBe(true);
    expect(releaseServerLock(dir, { pid: 4444, instanceId: 'inst-d' })).toBe(true);
    expect(existsSync(serverLockPath(dir))).toBe(false);
  });

  it('isProcessAlive：当前进程存活、不存在的 pid 已死', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });

  it('describeLockHolder：打印 pid/端口/库/实例，可读', () => {
    const text = describeLockHolder({ pid: 7, port: 8787, dbPath: 'D:/db/a.db', startedAt: 1_700_000_000_000, instanceId: 'inst-x' });
    expect(text).toContain('pid 7');
    expect(text).toContain('端口 8787');
    expect(text).toContain('D:/db/a.db');
    expect(text).toContain('inst-x');
  });
});
