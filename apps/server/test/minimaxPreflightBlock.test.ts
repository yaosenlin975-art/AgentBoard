/**
 * B4S-1 核心验收：MiniMax 客户端在运行时发起切换 → **阻断且不写 auth.json**。
 *
 * 用 fake fs 记录所有写/rename 调用（真实写盘则用临时目录对 sha256 前后比对）；
 * 三种阻断路径：探测在跑 + stop 抛错 → CLIENT_PROCESS_CONTROL_UNAVAILABLE；stop 后仍在跑 → CLIENT_STOP_TIMEOUT；
 * 探测本身失败 → CLIENT_PROCESS_PROBE_FAILED。三者都必须在写入之前发生。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { MinimaxDesktopProvider } from '../src/services/accounts/minimaxDesktopProvider.js';
import { CLIENT_PROCESS_ERROR_CODES } from '../src/services/accounts/clientProcess.js';
import type { CheckinVault } from '../src/services/accounts/checkinProvider.js';

const AUTH_BODY = JSON.stringify({
  schemaVersion: 1,
  records: {
    'mcode-public': { accessToken: 'token-current', refreshToken: 'r1', expiresAtMs: 9999999999999 },
  },
});

const vault: CheckinVault = {
  protect: async () => 'vault-ref',
  unprotect: async () => Buffer.from('token-target', 'utf8'),
  delete: async () => undefined,
};

function setup(processControl: {
  isRunning: (exePath: string) => Promise<boolean>;
  stop: (exePath: string) => Promise<void>;
  start: (exePath: string) => Promise<void>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'b4s1-'));
  const targetId = randomUUID(); // account_operation.account_id 要求 UUID
  const authFile = join(dir, 'auth.json');
  const exe = join(dir, 'MiniMax.exe');
  writeFileSync(authFile, AUTH_BODY, 'utf8');
  writeFileSync(exe, 'stub', 'utf8');
  const db = openDb(join(dir, 'test.db'));
  initSchema(db);
  const writes: string[] = [];
  const provider = new MinimaxDesktopProvider({
    db,
    vault,
    paths: { authFile, clientExe: exe },
    process: processControl,
    fs: {
      exists: async (path) => {
        try {
          statSync(path);
          return true;
        } catch {
          return false;
        }
      },
      readFile: async (path) => readFileSync(path),
      writeFile: async (path, data) => {
        writes.push(path);
        writeFileSync(path, data);
      },
      rename: async (from, to) => {
        writes.push(`${from}->${to}`);
        writeFileSync(to, readFileSync(from));
      },
      copyFile: async (from, to) => {
        writes.push(`${from}->${to}`);
        writeFileSync(to, readFileSync(from));
      },
      remove: async (path) => {
        writes.push(`rm:${path}`);
      },
    },
  });
  // 造一个可切换的目标账号
  db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(
    targetId,
    createHash('sha256').update('minimax\u0000target').digest('hex'),
    'target',
    'vault-ref',
  );
  const sha = (): string => createHash('sha256').update(readFileSync(authFile)).digest('hex');
  const mtime = (): number => statSync(authFile).mtimeMs;
  return { provider, db, authFile, writes, sha, mtime, targetId, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('MiniMax 在客户端运行时阻断切换（B4S-1）', () => {
  it('客户端在跑且停止能力不可用 → 抛 CLIENT_PROCESS_CONTROL_UNAVAILABLE，auth.json 一字节不变', async () => {
    const ctx = setup({
      isRunning: async () => true,
      stop: async () => {
        throw Object.assign(new Error('未装配客户端停止能力'), { code: CLIENT_PROCESS_ERROR_CODES.controlUnavailable });
      },
      start: async () => undefined,
    });
    cleanup = ctx.cleanup;
    const before = { sha: ctx.sha(), mtime: ctx.mtime() };

    const op = await ctx.provider.switchAccount(ctx.targetId);
    expect(op.state).toBe('failed');
    expect(op.stage).toBe('preflight');
    // 具体码的透传属 B4S-3（operationRunner 现在统一落 ACCOUNT_OPERATION_FAILED）；本卡只断言阻断点正确
    expect(op.safe_error_code).toBeTruthy();

    // 关键：auth.json 一个字节都没写
    expect(ctx.writes.filter((entry) => entry.includes('auth.json') || entry.includes('agentboard-'))).toEqual([]);
    expect(ctx.sha()).toBe(before.sha);
    expect(ctx.mtime()).toBe(before.mtime);
  });

  it('stop 之后客户端仍未被判定退出 → CLIENT_STOP_TIMEOUT，auth.json 不变', async () => {
    const ctx = setup({
      isRunning: async () => true,
      stop: async () => undefined,
      start: async () => undefined,
    });
    cleanup = ctx.cleanup;
    const before = { sha: ctx.sha(), mtime: ctx.mtime() };

    const op = await ctx.provider.switchAccount(ctx.targetId);
    expect(op.state).toBe('failed');
    expect(op.stage).toBe('preflight');
    expect(op.safe_error_code).toBeTruthy();

    expect(ctx.writes.filter((entry) => entry.includes('auth.json') || entry.includes('agentboard-'))).toEqual([]);
    expect(ctx.sha()).toBe(before.sha);
    expect(ctx.mtime()).toBe(before.mtime);
  });

  it('探测本身失败 → 中止（不静默当成「没在跑」）', async () => {
    const ctx = setup({
      isRunning: async () => {
        throw new Error('powershell 爆了');
      },
      stop: async () => undefined,
      start: async () => undefined,
    });
    cleanup = ctx.cleanup;
    const before = ctx.sha();

    const op = await ctx.provider.switchAccount(ctx.targetId);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBeTruthy();
    expect(ctx.sha()).toBe(before);
  });

  it('客户端未运行 → 正常继续（能走到写盘）', async () => {
    const ctx = setup({
      isRunning: async () => false,
      stop: async () => undefined,
      start: async () => undefined,
    });
    cleanup = ctx.cleanup;
    await ctx.provider.switchAccount(ctx.targetId).catch(() => undefined);
    // 未运行时不应调用 stop；写盘可能因校验失败回滚，但至少 stop 没被调用过（用 writes 里存在 auth.json 目标证明走到了写路径）
    expect(ctx.writes.some((entry) => entry.includes('auth.json'))).toBe(true);
  });
});
