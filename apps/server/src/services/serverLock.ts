/**
 * SERVER-SINGLETON：后台服务单例保障（原子 lock + 同 DB 重复检测 + 实例标识）。
 *
 * 问题：`pnpm server:ensure` 是「probe → spawn」，没有锁。两个 ensure 同时跑会都探测失败、都 spawn，
 * 其中一个子进程 `EADDRINUSE` 崩掉，而 ensure 只看到健康超时；也没有 pid/锁文件可判断
 * 「端口上的实例是不是指向同一个 DB」。
 *
 * 设计：
 * - 锁文件 `<configDir>/server.lock`，内容是 `{ pid, port, dbPath, startedAt, instanceId }`；
 * - **获取是原子的**：`open(lock, 'wx')`（O_CREAT|O_EXCL），由**服务进程**（不是启动器）持有，
 *   因为锁的生命周期必须等于服务生命周期；
 * - 已有锁时：持有者 pid 存活 → **拒绝启动**并打印持有者（pid/port/dbPath），不静默双开；
 *   持有者已死（陈旧锁）→ 接管并记一行；
 * - 释放在 `process.on('exit')` + 显式 `releaseServerLock()`（只删自己写的那把，pid+instanceId 都要对上）。
 *
 * 与 PROXY-ENV 的协同：两者都改启动器与 index.ts；PROXY-ENV 先交付（`64484cf`），
 * 本文件的 lock 逻辑与 `/api/version` 的 `instance_id/db_path/started_at` 属本卡。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerLockInfo {
  pid: number;
  port: number;
  dbPath: string;
  startedAt: number;
  instanceId: string;
}

export function serverLockPath(configDir: string): string {
  return join(configDir, 'server.lock');
}

/** 读锁；不存在/损坏返回 null（损坏视为陈旧，可接管） */
export function readServerLock(configDir: string): ServerLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(serverLockPath(configDir), 'utf8')) as Partial<ServerLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.dbPath !== 'string') return null;
    return {
      pid: parsed.pid,
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      dbPath: parsed.dbPath,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : '',
    };
  } catch {
    return null;
  }
}

/** pid 是否存活（`process.kill(pid, 0)`：ESRCH = 已死；EPERM = 活着但无权，按活着算） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

export type AcquireResult =
  | { ok: true; info: ServerLockInfo; tookOver: ServerLockInfo | null }
  | { ok: false; holder: ServerLockInfo | null; reason: 'held-by-live' | 'write-failed' };

export interface AcquireOptions {
  configDir: string;
  dbPath: string;
  port: number;
  pid?: number;
  instanceId: string;
  now?: () => number;
  /** 测试注入：判断 pid 存活 */
  alive?: (pid: number) => boolean;
  /**
   * 允许交接受让的前任 pid（`POST /api/system/restart` 的接班进程用）：
   * 旧进程此刻还活着（正在交棒），若按「活持有者」拒绝，重启链会直接失效。
   */
  takeoverFrom?: readonly number[];
}

/**
 * 获取锁。已有活着的持有者 → `ok: false`（调用方必须拒绝启动并打印持有者）；
 * 陈旧锁（pid 已死或文件损坏）→ 接管（删除后重建），`tookOver` 返回旧内容以便记日志。
 */
export function acquireServerLock(options: AcquireOptions): AcquireResult {
  const alive = options.alive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const info: ServerLockInfo = {
    pid: options.pid ?? process.pid,
    port: options.port,
    dbPath: options.dbPath,
    startedAt: now(),
    instanceId: options.instanceId,
  };
  const path = serverLockPath(options.configDir);
  const existing = readServerLock(options.configDir);
  const write = (): void => {
    const fd = openSync(path, 'wx'); // O_CREAT|O_EXCL：原子创建，已存在则抛 EEXIST
    try {
      writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
  };

  if (existing === null) {
    try {
      write();
      return { ok: true, info, tookOver: null };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'EEXIST') {
        // 极端竞态：读的时候没有，写的时候被别人抢先
        const holder = readServerLock(options.configDir);
        if (holder !== null && holder.pid !== info.pid && alive(holder.pid)) {
          return { ok: false, holder, reason: 'held-by-live' };
        }
        try { unlinkSync(path); } catch { /* 忽略 */ }
        try {
          write();
          return { ok: true, info, tookOver: holder };
        } catch {
          return { ok: false, holder, reason: 'write-failed' };
        }
      }
      return { ok: false, holder: existing, reason: 'write-failed' };
    }
  }

  const mayTakeOver = (options.takeoverFrom ?? []).includes(existing.pid);
  if (existing.pid !== info.pid && alive(existing.pid) && !mayTakeOver) {
    return { ok: false, holder: existing, reason: 'held-by-live' };
  }
  // 陈旧锁（或自己上次没清干净）：接管
  try {
    unlinkSync(path);
  } catch { /* 已被别人清掉 */ }
  try {
    write();
    return { ok: true, info, tookOver: existing };
  } catch (error) {
    const holder = readServerLock(options.configDir);
    const code = (error as { code?: string }).code;
    if (code === 'EEXIST' && holder !== null && alive(holder.pid) && holder.pid !== info.pid) {
      return { ok: false, holder, reason: 'held-by-live' };
    }
    return { ok: false, holder, reason: 'write-failed' };
  }
}

/** 释放：只删自己那把（pid 与 instanceId 都对上才删），避免误删接管者的锁 */
export function releaseServerLock(configDir: string, identity: { pid?: number; instanceId: string }): boolean {
  const current = readServerLock(configDir);
  const pid = identity.pid ?? process.pid;
  if (current === null) return false;
  if (current.pid !== pid || current.instanceId !== identity.instanceId) return false;
  try {
    unlinkSync(serverLockPath(configDir));
    return true;
  } catch {
    return false;
  }
}

/** 人类可读的持有者描述（拒绝启动时打印） */
export function describeLockHolder(holder: ServerLockInfo): string {
  const since = holder.startedAt === 0 ? '未知时间' : new Date(holder.startedAt).toISOString();
  return `pid ${holder.pid}，端口 ${holder.port || '未知'}，库 ${holder.dbPath}（自 ${since}，实例 ${holder.instanceId || '未知'}）`;
}
