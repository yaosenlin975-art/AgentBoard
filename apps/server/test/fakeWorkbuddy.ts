/**
 * fake WorkBuddy Desktop 客户端环境（ACC-05 测试共用）：
 * 临时目录模拟 .info/skeleton/window-state/启动日志，进程/版本/托盘/启动信号经注入探针控制。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/db/connection.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import {
  WorkbuddyDesktopProvider,
  type WorkbuddyClientProbe, type WorkbuddyDesktopPaths,
} from '../src/services/accounts/workbuddyDesktopProvider.js';

export const UID_A = '11111111-1111-1111-1111-111111111111';
export const UID_B = '22222222-2222-2222-2222-222222222222';
export const UID_C = '33333333-3333-3333-3333-333333333333';
export const ENVELOPE_MARK = 'FAKE-ENVELOPE-DO-NOT-LEAK';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function authInfoJson(uid: string, envelope = ENVELOPE_MARK): string {
  return JSON.stringify({
    account: { uid, nickname: { $wbEncrypted: 1, envelope }, phoneNumber: { $wbEncrypted: 1, envelope } },
    auth: { accessToken: { $wbEncrypted: 1, envelope }, refreshToken: { $wbEncrypted: 1, envelope } },
  });
}
function skeletonJson(uid: string): string { return JSON.stringify({ primary: { version: '5.9.3', uid, savedAt: Date.now() } }); }
function setMtime(path: string, epochSeconds: number): void { utimesSync(path, epochSeconds, epochSeconds); }

export class FakeWorkbuddyEnv {
  readonly dir: string;
  readonly paths: WorkbuddyDesktopPaths;
  readonly vaultDir: string;
  pids: number[] = [4242];
  version: string | null = '5.9.3.0';
  /** UIA 托盘退出是否真的让客户端退出（现场观测：菜单自动化未达，默认 false） */
  trayExitWorks = false;
  trayExitAttempts = 0;
  launchCount = 0;
  notices: string[] = [];
  onNotice?: () => void;
  /** 首次启动后 .info 变为该 uid（模拟客户端拒绝目标快照回退旧会话） */
  oneShotLaunchUid?: string;
  /** 每次启动后 .info 变为该 uid（回滚也救不回 → recovery_required） */
  persistLaunchUid?: string;
  startupActive = 0;
  startupMaxActive = 0;

  constructor(uid = UID_A) {
    this.dir = mkdtempSync(join(tmpdir(), 'agentboard-workbuddy-'));
    const data = join(this.dir, 'data');
    this.paths = {
      exePath: join(this.dir, 'exe', 'WorkBuddy.exe'),
      authInfoPath: join(this.dir, 'auth', 'workbuddy-desktop.info'),
      skeletonPath: join(data, 'storage', 'skeleton', 'account-snapshot.json'),
      dataRoot: data,
      windowStatePath: join(data, 'app', 'window-state.json'),
      startupLogDir: join(data, 'logs', 'startup'),
    };
    this.vaultDir = join(this.dir, 'vault');
    for (const file of [this.paths.exePath, this.paths.authInfoPath, this.paths.skeletonPath, this.paths.windowStatePath, join(this.paths.startupLogDir, '2026-11-01')]) {
      mkdirSync(join(file, '..'), { recursive: true });
    }
    writeFileSync(this.paths.exePath, 'fake-exe');
    this.writeAuthInfo(uid);
    this.writeSkeleton(uid);
    // 运行态：auth 写盘晚于 window-state（退出签名判据不成立）
    writeFileSync(this.paths.windowStatePath, '{}');
    const base = Math.floor(Date.now() / 1000);
    setMtime(this.paths.windowStatePath, base);
    setMtime(this.paths.authInfoPath, base + 10);
  }

  writeAuthInfo(uid: string, envelope = ENVELOPE_MARK): void { writeFileSync(this.paths.authInfoPath, authInfoJson(uid, envelope)); }
  writeSkeleton(uid: string): void { writeFileSync(this.paths.skeletonPath, skeletonJson(uid)); }
  authBytes(): Buffer { return readFileSync(this.paths.authInfoPath); }
  authUid(): string | null {
    try { return (JSON.parse(this.authBytes().toString('utf8')) as { account?: { uid?: string } }).account?.uid ?? null; } catch { return null; }
  }

  /** 真实退出：进程清零 + auth 重写 mtime + window-state 滞后 5s（契约退出签名） */
  async fullyExit(): Promise<void> {
    this.pids = [];
    const now = Date.now() / 1000;
    setMtime(this.paths.authInfoPath, now);
    setMtime(this.paths.windowStatePath, now + 5);
  }

  /** 模拟用户在客户端内登录另一账号：退出→写入新身份→重启 */
  async loginAs(uid: string): Promise<void> {
    await this.fullyExit();
    this.writeAuthInfo(uid);
    this.writeSkeleton(uid);
    await this.launch();
  }

  /** 启动：token 轮换重写 .info（uid 不变）+ 新启动日志 + 进程出现 */
  async launch(): Promise<void> {
    this.launchCount++;
    const forced = this.oneShotLaunchUid ?? this.persistLaunchUid;
    if (this.oneShotLaunchUid !== undefined) this.oneShotLaunchUid = undefined;
    if (forced !== undefined) { this.writeAuthInfo(forced); this.writeSkeleton(forced); }
    else if (this.authUid()) this.writeAuthInfo(this.authUid()!, `ENVELOPE-ROTATED-${this.launchCount}`);
    this.pids = [5000 + this.launchCount];
    const dayDir = join(this.paths.startupLogDir, '2026-11-01');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, `${5000 + this.launchCount}-090000.log`), 'startup');
  }

  probe(): WorkbuddyClientProbe {
    return {
      productVersion: async () => this.version,
      instancePids: async () => [...this.pids],
      tryTrayExit: async () => {
        this.trayExitAttempts++;
        if (this.trayExitWorks) await this.fullyExit();
        return this.trayExitWorks;
      },
      launchApp: async () => { await this.launch(); },
      waitForStartupSignal: async () => {
        this.startupActive++;
        this.startupMaxActive = Math.max(this.startupMaxActive, this.startupActive);
        try { await new Promise(resolve => setTimeout(resolve, 5)); return this.pids.length > 0; }
        finally { this.startupActive--; }
      },
    };
  }

  provider(db: Db, options: Partial<{ uiaExitWaitMs: number; manualExitTimeoutMs: number; rollbackExitTimeoutMs: number; startupTimeoutMs: number }> = {}): WorkbuddyDesktopProvider {
    return new WorkbuddyDesktopProvider({
      db, vault: new SecretVault(this.vaultDir), paths: this.paths, probe: this.probe(),
      broadcast: event => { if (event.type === 'account.notice') { this.notices.push(event.message); this.onNotice?.(); } },
      uiaExitWaitMs: options.uiaExitWaitMs ?? 150,
      manualExitTimeoutMs: options.manualExitTimeoutMs ?? 400,
      rollbackExitTimeoutMs: options.rollbackExitTimeoutMs ?? 600,
      startupTimeoutMs: options.startupTimeoutMs ?? 2_000,
    });
  }

  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }); }
}
