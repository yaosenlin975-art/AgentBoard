/**
 * WorkBuddy Desktop 账号 provider（ACC-05）。
 *
 * 契约唯一依据：Docs/evidence/workbuddy-desktop-contract-2026-11-01.md「2026-11-01 授权观测」。
 * 目标实例：D:\Program Files\WorkBuddy\WorkBuddy.exe 5.9.3.0（HKCU 卸载项绑定）；
 * instance_id = sha256("workbuddy_desktop" + NUL + 小写规范 exe 路径)；
 * auth 根 = %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info（固定每用户路径 → 每产品单活跃实例）；
 * 数据根 ~/.workbuddy；stable UID = $.account.uid（36 字符，token 轮换不变）；
 * .info 敏感字段为 {$wbEncrypted:1,envelope} 信封（schema v2），信封值不读不入库不写日志；
 * 真实退出只读签名：进程清零 + window-state.json mtime ≥ auth 写盘；WM_CLOSE=隐藏托盘不退出；
 * busy/unsaved 不可判定 → canCloseSafely 恒 false；绝不 taskkill/强杀。
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AccountOperation, ManagedAccount, WsEvent } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { runAccountOperation } from './operationRunner.js';
import { runSwitchFlow } from './switchFlow.js';
import { updateAccountOperation } from '../../db/repos/accountOperation.js';
import { attachClientSnapshot, createManagedAccount, findManagedAccountByIdentity, getManagedAccount, setCredentialExpiry } from '../../db/repos/managedAccount.js';
import { attachCheckinCredential } from '../../db/repos/checkin.js';
import type { SecretVault } from './secretVault.js';
import { createWorkbuddyCheckinTokenSource, readWorkbuddyAuthExpiresAt, type WorkbuddyCheckinTokenSource } from './workbuddyCheckinSource.js';
import { jwtExpiresAt } from './addAccountProtocol.js';
import { ApiError, ValidationError } from '../../errors.js';

export const WORKBUDDY_APP_ID = 'workbuddy_desktop' as const;
/** 契约验证过的产品版本线（5.9.3.x，schema v2）；其他版本一律 unsupported */
export const WORKBUDDY_SUPPORTED_VERSION = '5.9.3';
export const WORKBUDDY_SNAPSHOT_SCHEMA = 'agentboard.workbuddy-desktop.snapshot/1';
/** 主进程监听端口（启动就绪三信号之一） */
export const WORKBUDDY_HELPER_PORT = 18488;

export interface WorkbuddyDesktopPaths {
  exePath: string;
  authInfoPath: string;
  skeletonPath: string;
  dataRoot: string;
  windowStatePath: string;
  startupLogDir: string;
}

export interface ClientIdentity {
  /** sha256(uid) 前 8 位（展示/比对用摘要，非原文） */
  uid_sha256_8: string;
  /** sha256(uid) 全量 64 hex（vault scope 与 managed_account.identity_hash） */
  identity_hash: string;
}

/** 客户端探针：全部可注入（fake 测试替换；默认实现走 PowerShell 只读探测） */
export interface WorkbuddyClientProbe {
  productVersion(exePath: string): Promise<string | null>;
  instancePids(exePath: string): Promise<number[]>;
  /** UIA 托盘退出尝试（≤10s）；返回值仅作参考，退出与否一律以退出签名为准 */
  tryTrayExit(exePath: string): Promise<boolean>;
  launchApp(exePath: string): Promise<void>;
  /** 启动就绪：三信号（启动日志对 / 18488 监听 / WorkBuddy 主窗口）任一出现 */
  waitForStartupSignal(paths: WorkbuddyDesktopPaths, sinceMs: number, timeoutMs: number): Promise<boolean>;
}

// ---- 契约常量与可注入路径 ----

const CONTRACT_EXE_PATH = 'D:\\Program Files\\WorkBuddy\\WorkBuddy.exe';

export function defaultWorkbuddyPaths(env: NodeJS.ProcessEnv = process.env, home: string = process.env.USERPROFILE ?? ''): WorkbuddyDesktopPaths {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !home) throw new ApiError(503, 'WORKBUDDY_PATHS_UNAVAILABLE', '无法解析本机 WorkBuddy 契约路径');
  const dataRoot = join(home, '.workbuddy');
  return {
    exePath: CONTRACT_EXE_PATH,
    authInfoPath: join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    skeletonPath: join(dataRoot, 'storage', 'skeleton', 'account-snapshot.json'),
    dataRoot,
    windowStatePath: join(dataRoot, 'app', 'window-state.json'),
    startupLogDir: join(dataRoot, 'logs', 'startup'),
  };
}

/** instance_id = sha256(app_id + NUL + 小写规范 exe 路径)；realpath 失败退回原路径 */
export function computeWorkbuddyInstanceId(exePath: string): string {
  let canonical = resolve(exePath);
  try { canonical = realpathSync(canonical); } catch { /* 实例不存在时由 preflight 拒绝 */ }
  return createHash('sha256').update(`${WORKBUDDY_APP_ID}\0${canonical.toLowerCase()}`).digest('hex');
}

// ---- 身份读取（只读，信封值不解析） ----

export function detectWorkbuddySchema(info: unknown): 'v2-wbencrypted' | 'v1-plaintext' | 'unknown' {
  const token = (info as { auth?: { accessToken?: unknown } } | null)?.auth?.accessToken;
  if (token !== null && typeof token === 'object' && (token as { $wbEncrypted?: unknown }).$wbEncrypted === 1) return 'v2-wbencrypted';
  if (typeof token === 'string' && token.length > 0) return 'v1-plaintext';
  return 'unknown';
}

/** 只读解析 .info 的 $.account.uid；文件缺失/损坏/uid 缺失 → null；不读取任何信封字段 */
export async function readWorkbuddyIdentity(paths: WorkbuddyDesktopPaths): Promise<ClientIdentity | null> {
  let info: unknown;
  try { info = JSON.parse((await readFile(paths.authInfoPath)).toString('utf8')); } catch { return null; }
  const uid = (info as { account?: { uid?: unknown } } | null)?.account?.uid;
  if (typeof uid !== 'string' || uid.length !== 36) return null;
  const hash = createHash('sha256').update(uid).digest('hex');
  return { uid_sha256_8: hash.slice(0, 8), identity_hash: hash };
}

// ---- 快照结构（落 DPAPI vault 的密文本体） ----

const snapshotFileSchema = z.object({
  key: z.string().min(1).max(100),
  role: z.enum(['credential', 'identity-skeleton']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_base64: z.string().max(7_000_000),
});
const snapshotSchema = z.object({
  schema: z.literal(WORKBUDDY_SNAPSHOT_SCHEMA),
  app_id: z.literal(WORKBUDDY_APP_ID),
  client_instance_id: z.string().regex(/^[a-f0-9]{64}$/),
  identity: z.object({ uid_sha256_8: z.string().regex(/^[a-f0-9]{8}$/) }).strict(),
  version: z.object({ product: z.string().min(1).max(40), schema: z.literal('v2-wbencrypted'), captured_at: z.number().int().nonnegative() }).strict(),
  files: z.array(snapshotFileSchema).min(1).max(10),
}).strict();
type WorkbuddySnapshot = z.infer<typeof snapshotSchema>;

interface BackupBundle {
  files: Array<{ dest: string; bytes: Buffer | null }>;
  identity: ClientIdentity;
}

export interface WorkbuddyProviderDeps {
  db: Db;
  vault: SecretVault;
  paths: WorkbuddyDesktopPaths;
  probe: WorkbuddyClientProbe;
  broadcast: (event: WsEvent) => void;
  /** ACC-GET：捕获时解析当前账号的签到 token（缺省读插件线明文 JWT / 导出脚本兜底） */
  checkinTokenSource?: WorkbuddyCheckinTokenSource;
  /** UIA 退出后等待退出签名的窗口（默认 15s） */
  uiaExitWaitMs?: number;
  /** UIA 失败降级后等待用户手动退出的窗口（默认 120s） */
  manualExitTimeoutMs?: number;
  /** 回滚阶段等待退出的窗口（默认 60s） */
  rollbackExitTimeoutMs?: number;
  /** 重启后等待启动就绪信号的窗口（默认 20s） */
  startupTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class WorkbuddyDesktopProvider {
  private readonly db: Db;
  private readonly vault: SecretVault;
  private readonly paths: WorkbuddyDesktopPaths;
  private readonly probe: WorkbuddyClientProbe;
  private readonly broadcastFn: (event: WsEvent) => void;
  private readonly checkinTokenSource: WorkbuddyCheckinTokenSource;
  private readonly uiaExitWaitMs: number;
  private readonly manualExitTimeoutMs: number;
  private readonly rollbackExitTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: WorkbuddyProviderDeps) {
    this.db = deps.db; this.vault = deps.vault; this.paths = deps.paths; this.probe = deps.probe;
    this.broadcastFn = deps.broadcast;
    this.checkinTokenSource = deps.checkinTokenSource ?? createWorkbuddyCheckinTokenSource();
    this.uiaExitWaitMs = deps.uiaExitWaitMs ?? 15_000;
    this.manualExitTimeoutMs = deps.manualExitTimeoutMs ?? 120_000;
    this.rollbackExitTimeoutMs = deps.rollbackExitTimeoutMs ?? 60_000;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 20_000;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  get instanceId(): string { return computeWorkbuddyInstanceId(this.paths.exePath); }

  /** busy/unsaved 契约上不可判定：恒报不安全，不假装 safe */
  canCloseSafely(): { safe: boolean; reason: string } {
    return { safe: false, reason: 'busy/未保存状态不可判定' };
  }

  getCurrentIdentity(): Promise<ClientIdentity | null> { return readWorkbuddyIdentity(this.paths); }

  // ---- 捕获 ----

  async captureCurrent(options: { display_name?: string } = {}): Promise<ManagedAccount> {
    if (options.display_name !== undefined && (options.display_name.trim().length < 1 || options.display_name.trim().length > 100)) throw new ValidationError('display_name 不合法');
    let captured: ManagedAccount | null = null;
    const operation = await runAccountOperation(this.db, {
      app_id: WORKBUDDY_APP_ID, client_instance_id: this.instanceId, operation: 'capture',
    }, async op => {
      const pre = await this.preflight();
      if (pre.pids.length === 0) throw new ApiError(409, 'CLIENT_NOT_RUNNING', 'WorkBuddy 未在运行，无法捕获当前登录态');
      const identity = await this.requireV2Identity();
      this.setStage(op, 'snapshot');
      const snapshot: WorkbuddySnapshot = {
        schema: WORKBUDDY_SNAPSHOT_SCHEMA, app_id: WORKBUDDY_APP_ID, client_instance_id: pre.instanceId,
        identity: { uid_sha256_8: identity.uid_sha256_8 },
        version: { product: pre.version, schema: 'v2-wbencrypted', captured_at: this.now() },
        files: [
          { key: 'auth_info', role: 'credential', ...(await this.snapshotFile(this.paths.authInfoPath)) },
          { key: 'skeleton', role: 'identity-skeleton', ...(await this.snapshotFile(this.paths.skeletonPath)) },
        ],
      };
      const ref = await this.vault.protect(Buffer.from(JSON.stringify(snapshot), 'utf8'), this.vaultScope(identity.identity_hash));
      // 保存成功后再次读取当前身份；身份变化或格式不支持 → 放弃保存并清理临时快照（设计 §6）
      this.setStage(op, 'verify');
      const after = await readWorkbuddyIdentity(this.paths);
      if (!after || after.identity_hash !== identity.identity_hash) {
        await this.vault.delete(ref).catch(() => {});
        throw new ApiError(409, 'IDENTITY_CHANGED', '捕获期间登录身份变化，已放弃保存');
      }
      // ACC-GET：捕获必须同时落签到凭据，否则账号会「抓到了但签不了到」；取不到就让捕获失败。
      const token = await this.checkinTokenSource.find(identity).catch(() => null);
      if (token === null || token.trim() === '') {
        await this.vault.delete(ref).catch(() => {});
        throw new ApiError(409, 'CHECKIN_CREDENTIAL_UNAVAILABLE', '未能从本机获取签到凭据，请改用授权添加或导入本机凭据');
      }
      const checkinRef = await this.vault.protect(Buffer.from(token, 'utf8'), this.checkinScope(identity.identity_hash));
      // ACC-TOKEN-2：到期来源优先桌面线 info 文件 auth.expiresAt（明文毫秒，无需解密）；兜底插件线 JWT exp
      const expiresAt = (await readWorkbuddyAuthExpiresAt(this.paths.authInfoPath)) ?? jwtExpiresAt(token);
      try {

        const existing = findManagedAccountByIdentity(this.db, WORKBUDDY_APP_ID, pre.instanceId, identity.identity_hash);
        if (existing) {
          captured = attachClientSnapshot(this.db, existing.id, { client_snapshot_ref: ref, client_snapshot_version: 1 });
          captured = attachCheckinCredential(this.db, existing.id, checkinRef);
          if (existing.client_snapshot_ref && existing.client_snapshot_ref !== ref) await this.vault.delete(existing.client_snapshot_ref).catch(() => {});
          if (existing.checkin_credential_ref && existing.checkin_credential_ref !== checkinRef) await this.vault.delete(existing.checkin_credential_ref).catch(() => {});
        } else {
          captured = createManagedAccount(this.db, {
            app_id: WORKBUDDY_APP_ID, client_instance_id: pre.instanceId, service_region: 'unknown',
            identity_hash: identity.identity_hash, display_name: (options.display_name ?? `WorkBuddy-${identity.uid_sha256_8}`).trim(),
            identity_hint: identity.uid_sha256_8, client_snapshot_ref: ref, client_snapshot_version: 1,
            checkin_credential_ref: checkinRef,
          });
          captured = attachCheckinCredential(this.db, captured.id, checkinRef);
        }
        // ACC-TOKEN-2：捕获写入点——落到期列（workbuddy refresh_method 固定 recapture）
        if (captured) setCredentialExpiry(this.db, captured.id, { expiresAt, refreshMethod: 'recapture' });
      } catch (error) {
        await this.vault.delete(ref).catch(() => {});
        await this.vault.delete(checkinRef).catch(() => {});
        throw error;
      }
      return 'succeeded';
    });
    if (operation.state !== 'succeeded' || !captured) throw new ApiError(409, operation.safe_error_code ?? 'CAPTURE_FAILED', '捕获当前账号失败');
    return captured;
  }

  /**
   * ACC-FIX-4：客户端未运行时的签到凭据回填。桌面捕获需要 WorkBuddy 进程在线，但插件线
   * `Tencent-Cloud.coding-copilot.info` 是文件级明文 JWT（readPluginToken 已做 sha256(sub)==identity_hash 校验），
   * 无需进程即可读取。对库内既有 workbuddy_desktop 账号行逐行试匹配，命中即回填 checkin_credential_ref
   * （不建新行、不分裂身份体系）；任一行命中返回该行，全部未命中返回 null（调用方维持原 409）。
   */
  async backfillCheckinCredentialFromPlugin(): Promise<ManagedAccount | null> {
    const rows = this.db.prepare(
      'SELECT id, identity_hash, identity_hint, checkin_credential_ref FROM managed_account WHERE app_id=? AND identity_hash IS NOT NULL',
    ).all(WORKBUDDY_APP_ID) as Array<{ id: string; identity_hash: string; identity_hint: string | null; checkin_credential_ref: string | null }>;
    for (const row of rows) {
      const identity: ClientIdentity = { uid_sha256_8: row.identity_hint ?? '', identity_hash: row.identity_hash };
      const token = await this.checkinTokenSource.find(identity).catch(() => null);
      if (token === null || token.trim() === '') continue;
      const ref = await this.vault.protect(Buffer.from(token, 'utf8'), this.checkinScope(row.identity_hash));
      attachCheckinCredential(this.db, row.id, ref);
      // ACC-TOKEN-2：回填写入点——插件线是明文 JWT，到期从 exp claim 落列
      setCredentialExpiry(this.db, row.id, { expiresAt: jwtExpiresAt(token), refreshMethod: 'recapture' });
      if (row.checkin_credential_ref && row.checkin_credential_ref !== ref) await this.vault.delete(row.checkin_credential_ref).catch(() => undefined);
      return getManagedAccount(this.db, row.id);
    }
    return null;
  }

  // ---- 切换 ----

  /**
   * 切换：走**共用骨架**（B4S-4），本类只提供各步回调。
   * 步序与既有行为一一对应：preflight → stop → snapshot → validate_target → write → start → verify →（失败）rollback。
   */
  async switchAccount(accountId: string, hooks: { onOperationCreated?: (id: string) => void } = {}): Promise<AccountOperation> {
    // ACC-SW-VALID：操作创建的库级校验要求 账号.app_id+client_instance_id 与入参三元组一致（本类恒传当前实例哈希），
    // 协议授权/导入线的账号 instance 是字面量（protocol/imported），不预检会被兜成 400 VALIDATION_ERROR「参数不合法」；
    // 这里按 preflight 同语义提前给 409 TARGET_INSTANCE_MISMATCH（前端已有中文映射），不建操作行、不触碰客户端。
    const target = getManagedAccount(this.db, accountId);
    if (target && target.app_id === WORKBUDDY_APP_ID && target.client_instance_id !== this.instanceId) {
      throw new ApiError(409, 'TARGET_INSTANCE_MISMATCH', '目标账号与当前客户端实例不一致，无法切换（授权/导入添加或客户端重装后的账号没有本机快照）');
    }
    return runAccountOperation(this.db, {
      account_id: accountId, app_id: WORKBUDDY_APP_ID, client_instance_id: this.instanceId, operation: 'switch',
    }, async op => {
      if (hooks.onOperationCreated) hooks.onOperationCreated(op.id);
      const account = getManagedAccount(this.db, accountId);
      if (!account || account.app_id !== WORKBUDDY_APP_ID) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '目标账号不存在');

      // 骨架回调之间要传递的中间产物（各自步产出、后续步消费）
      let pre: { exePath: string; version: string; instanceId: string; pids: number[] } | null = null;
      let currentIdentity: ClientIdentity | null = null;

      await runSwitchFlow({
        setStage: stage => this.setStage(op, stage),
        callbacks: {
          // S0：实例/版本 + 目标快照的三元组前置检查（不符 → 未触碰客户端）
          preflight: async () => {
            pre = await this.preflight();
            if (account.client_instance_id !== pre.instanceId) throw new ApiError(409, 'TARGET_INSTANCE_MISMATCH', '目标快照与当前安装实例不一致，拒绝写入');
            if (!account.client_snapshot_ref) throw new ApiError(409, 'SNAPSHOT_MISSING', '目标账号没有客户端快照');
            currentIdentity = await this.requireV2Identity();
          },
          // S1：safe-exit（两段式）：UIA 托盘退出 → 失败降级 WS 提示手动退出 + 轮询退出签名；绝不强杀
          stop: async () => { await this.ensureExited('stop'); },
          // S2：backup（真实退出后读盘——退出时客户端会重写 .info）；这就是回滚依据
          snapshot: async () => await this.readBackup(currentIdentity!),
          // S3：解密目标快照，app/instance/identity 三元组匹配本机，不符不写
          validateTarget: async () => await this.loadValidatedSnapshot(account, pre!),
          // S4：atomic-write（临时文件 + rename）；仅进程确认退出后执行
          write: async (target) => { await this.writeSnapshotFiles(target); },
          // S5：启动并等三信号任一
          start: async () => {
            const startedAt = this.now();
            await this.probe.launchApp(pre!.exePath);
            if (!(await this.probe.waitForStartupSignal(this.paths, startedAt, this.startupTimeoutMs))) {
              throw new ApiError(409, 'STARTUP_TIMEOUT', 'WorkBuddy 启动未就绪');
            }
          },
          // S5：identity-verify —— 读回 uid == 目标
          verify: async () => {
            const actual = await readWorkbuddyIdentity(this.paths);
            if (!actual || actual.identity_hash !== account.identity_hash) {
              throw new ApiError(409, 'IDENTITY_VERIFY_FAILED', '切换后身份核验失败');
            }
          },
          // 回滚：写回 backup + 重启 + 核验原账号（以抛错收尾：SWITCH_ROLLED_BACK / RECOVERY_REQUIRED）
          rollback: async (backup, cause) => { await this.rollbackAndRestore(backup, cause); },
        },
      });
      return 'succeeded';
    });
  }

  // ---- 内部流程 ----

  private setStage(op: AccountOperation, stage: AccountOperation['stage']): void {
    updateAccountOperation(this.db, op.id, { stage });
  }

  private vaultScope(identityHash: string) {
    return { app_id: WORKBUDDY_APP_ID, client_instance_id: this.instanceId, identity_hash: identityHash, purpose: 'client_snapshot' as const };
  }

  /** ACC-GET：签到凭据 scope 必须与 checkinRunner 解包时一致（client_instance_id = 本实例） */
  private checkinScope(identityHash: string) {
    return { app_id: WORKBUDDY_APP_ID, client_instance_id: this.instanceId, identity_hash: identityHash, purpose: 'checkin' as const };
  }

  private async preflight(): Promise<{ exePath: string; version: string; instanceId: string; pids: number[] }> {
    const exePath = this.paths.exePath;
    const version = await this.probe.productVersion(exePath).catch(() => null);
    if (version === null || !existsSync(exePath)) throw new ApiError(409, 'CLIENT_INSTANCE_NOT_FOUND', '未找到受支持的 WorkBuddy 安装实例');
    if (!version.startsWith(WORKBUDDY_SUPPORTED_VERSION)) throw new ApiError(409, 'CLIENT_VERSION_UNSUPPORTED', `WorkBuddy 版本 ${version} 不受支持（仅支持 ${WORKBUDDY_SUPPORTED_VERSION}.x）`);
    return { exePath, version, instanceId: this.instanceId, pids: await this.probe.instancePids(exePath) };
  }

  private async requireV2Identity(): Promise<ClientIdentity> {
    let info: unknown;
    try { info = JSON.parse((await readFile(this.paths.authInfoPath)).toString('utf8')); }
    catch { throw new ApiError(409, 'IDENTITY_UNAVAILABLE', '无法读取 WorkBuddy 登录身份'); }
    const uid = (info as { account?: { uid?: unknown } } | null)?.account?.uid;
    if (typeof uid !== 'string' || uid.length !== 36) throw new ApiError(409, 'IDENTITY_UNAVAILABLE', '登录身份缺少稳定 uid，不可保存');
    if (detectWorkbuddySchema(info) !== 'v2-wbencrypted') throw new ApiError(409, 'CLIENT_SCHEMA_UNSUPPORTED', '客户端凭据 schema 版本不受支持（需 v2 信封格式）');
    const hash = createHash('sha256').update(uid).digest('hex');
    return { uid_sha256_8: hash.slice(0, 8), identity_hash: hash };
  }

  private async snapshotFile(path: string): Promise<{ sha256: string; content_base64: string }> {
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { throw new ApiError(409, 'SNAPSHOT_FILE_MISSING', '快照源文件缺失'); }
    return { sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
  }

  /** 完全退出只读判据：本实例进程清零 且 window-state.json mtime ≥ auth 写盘 */
  private async isFullyExited(): Promise<boolean> {
    if ((await this.probe.instancePids(this.paths.exePath)).length > 0) return false;
    try {
      const [windowState, auth] = await Promise.all([stat(this.paths.windowStatePath), stat(this.paths.authInfoPath)]);
      return windowState.mtimeMs >= auth.mtimeMs;
    } catch { return false; }
  }

  private async ensureExited(phase: 'stop' | 'rollback'): Promise<void> {
    if (await this.isFullyExited()) return;
    await this.probe.tryTrayExit(this.paths.exePath).catch(() => false);
    const uiaDeadline = this.now() + this.uiaExitWaitMs;
    while (this.now() < uiaDeadline) {
      if (await this.isFullyExited()) return;
      await this.sleep(200);
    }
    // UIA 失败降级：WS 广播提示手动退出 + 轮询退出签名（契约 §8 解除条件 1 的用户授权方案）
    this.broadcastFn({
      type: 'account.notice', app_id: WORKBUDDY_APP_ID, client_instance_id: this.instanceId,
      message: phase === 'stop'
        ? '请手动退出 WorkBuddy（托盘图标右键 → 退出）；AgentBoard 检测到完全退出后将继续账号切换'
        : '账号切换失败，正在回滚；请手动退出 WorkBuddy（托盘图标右键 → 退出）以完成恢复',
    });
    const deadline = this.now() + (phase === 'rollback' ? this.rollbackExitTimeoutMs : this.manualExitTimeoutMs);
    while (this.now() < deadline) {
      if (await this.isFullyExited()) return;
      await this.sleep(300);
    }
    throw new ApiError(409, 'EXIT_NOT_CONFIRMED', 'WorkBuddy 未确认完全退出，已中止（未写入任何客户端数据）');
  }

  private async readBackup(identity: ClientIdentity): Promise<BackupBundle> {
    const files: BackupBundle['files'] = [];
    for (const dest of [this.paths.authInfoPath, this.paths.skeletonPath]) {
      files.push({ dest, bytes: await readFile(dest).catch(() => null) });
    }
    return { files, identity };
  }

  private async loadValidatedSnapshot(account: ManagedAccount, pre: { version: string; instanceId: string }): Promise<WorkbuddySnapshot> {
    const cipher = await this.vault.unprotect(account.client_snapshot_ref!, this.vaultScope(account.identity_hash));
    let snapshot: WorkbuddySnapshot;
    try { snapshot = snapshotSchema.parse(JSON.parse(cipher.toString('utf8'))); }
    catch { throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '目标快照结构不合法，拒绝写入'); }
    if (snapshot.client_instance_id !== pre.instanceId) throw new ApiError(409, 'TARGET_INSTANCE_MISMATCH', '目标快照与当前安装实例不一致，拒绝写入');
    if (snapshot.identity.uid_sha256_8 !== account.identity_hash.slice(0, 8)) throw new ApiError(409, 'TARGET_IDENTITY_MISMATCH', '目标快照身份与账号不一致，拒绝写入');
    if (snapshot.version.product !== pre.version) throw new ApiError(409, 'SNAPSHOT_VERSION_MISMATCH', `客户端版本（${pre.version}）与快照版本（${snapshot.version.product}）不一致，拒绝写入`);
    const roles = new Set(snapshot.files.map(f => f.role));
    if (!roles.has('credential') || !roles.has('identity-skeleton')) throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '目标快照文件集不完整，拒绝写入');
    for (const file of snapshot.files) {
      if (createHash('sha256').update(Buffer.from(file.content_base64, 'base64')).digest('hex') !== file.sha256) {
        throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '目标快照完整性校验失败，拒绝写入');
      }
    }
    return snapshot;
  }

  /** 目标文件地址一律取当前契约路径（按 role 映射），不信任快照内记录的历史路径 */
  private async writeSnapshotFiles(snapshot: WorkbuddySnapshot): Promise<void> {
    const destinations: Record<'credential' | 'identity-skeleton', string> = {
      credential: this.paths.authInfoPath, 'identity-skeleton': this.paths.skeletonPath,
    };
    for (const file of snapshot.files) {
      await atomicWrite(destinations[file.role], Buffer.from(file.content_base64, 'base64'));
    }
  }

  private async rollbackAndRestore(backup: BackupBundle, causeCode: string): Promise<never> {
    try {
      await this.ensureExited('rollback');
      for (const file of backup.files) {
        if (file.bytes === null) continue;
        await atomicWrite(file.dest, file.bytes);
      }
      const startedAt = this.now();
      await this.probe.launchApp(this.paths.exePath);
      if (!(await this.probe.waitForStartupSignal(this.paths, startedAt, this.startupTimeoutMs))) throw new Error('startup');
      const restored = await readWorkbuddyIdentity(this.paths);
      if (!restored || restored.identity_hash !== backup.identity.identity_hash) throw new Error('identity');
    } catch {
      // 回滚未能核验恢复原账号 → recovery_required + 实例冻结（后续操作经 operationRunner 拒绝）
      throw new ApiError(409, 'RECOVERY_REQUIRED', '回滚后未能核验恢复原账号，该实例已冻结等待人工恢复');
    }
    // 原账号已恢复并独立核验：可安全收尾为 failed（非 recovery_required）
    throw new ApiError(409, 'SWITCH_ROLLED_BACK', `切换失败已回滚并核验原账号（失败原因: ${causeCode}）`);
  }
}

/** 同目录临时文件 + rename 原子替换 */
async function atomicWrite(dest: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.agentboard-tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, dest);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    throw new ApiError(500, 'SNAPSHOT_WRITE_FAILED', '快照写入失败');
  }
}

// ---- 默认探针（Windows PowerShell 只读探测 + UIA 尝试 + 启动信号轮询） ----

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function runPowerShell(script: string, timeoutMs: number): Promise<string | null> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

function localDateStamp(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function portOpen(port: number, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** UIA 托盘退出尝试（≤10s）：找托盘 WorkBuddy 图标 → 右键 → 点「退出/Exit」；观测记录显示菜单可能无法定位，失败由退出签名轮询兜底 */
const TRAY_EXIT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try{Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes}catch{}
function Find-El($nameLike,$controlType){
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$controlType)
  foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)){ if($e.Current.Name -like $nameLike){ return $e } }
  return $null
}
foreach($n in @('显示隐藏的图标','Show Hidden Icons')){
  $b=Find-El "*$n*" ([System.Windows.Automation.ControlType]::Button)
  if($b){ try{ $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 600 }catch{} }
}
$icon=Find-El '*WorkBuddy*' ([System.Windows.Automation.ControlType]::Button)
if(-not $icon){ [Console]::Out.Write('NO_ICON'); exit 0 }
try{ $icon.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 400 }catch{}
try{
  Add-Type -Namespace Win32 -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);'
  $pt=$icon.GetClickablePoint()
  [Win32.User32]::SetCursorPos([int]$pt.X,[int]$pt.Y) | Out-Null
  [Win32.User32]::mouse_event(8,0,0,0,[UIntPtr]::Zero)
  [Win32.User32]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
}catch{}
Start-Sleep -Milliseconds 1200
$menu=$null
foreach($n in @('退出*','Exit*','*退出')){ $menu=Find-El $n ([System.Windows.Automation.ControlType]::MenuItem); if($menu){ break } }
if(-not $menu){ [Console]::Out.Write('NO_MENU'); exit 0 }
try{ $menu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); [Console]::Out.Write('CLICKED') }catch{ [Console]::Out.Write('NO_MENU') }
`;

export const defaultWorkbuddyProbe: WorkbuddyClientProbe = {
  async productVersion(exePath) {
    const out = await runPowerShell(`$p=${psQuote(exePath)}; if(Test-Path -LiteralPath $p){ (Get-Item -LiteralPath $p).VersionInfo.ProductVersion } else { 'MISSING' }`, 10_000);
    return out && out !== 'MISSING' && out !== '' ? out : null;
  },
  async instancePids(exePath) {
    const name = basename(exePath);
    const out = await runPowerShell(
      `$exe=${psQuote(exePath)}.ToLower(); Get-CimInstance Win32_Process -Filter ${psQuote(`Name='${name}'`)} | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $exe } | ForEach-Object { $_.ProcessId }`, 15_000);
    if (!out) return [];
    return out.split(/\r?\n/).map(line => Number.parseInt(line.trim(), 10)).filter(pid => Number.isInteger(pid) && pid > 0);
  },
  async tryTrayExit(_exePath) {
    const out = await runPowerShell(TRAY_EXIT_SCRIPT, 12_000);
    return out === 'CLICKED';
  },
  async launchApp(exePath) {
    const { spawn } = await import('node:child_process');
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  },
  async waitForStartupSignal(paths, sinceMs, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      // ① 启动日志对：logs/startup/<今天>/<pid>-<HHMMSS>.{log,jsonl}
      try {
        const dir = join(paths.startupLogDir, localDateStamp());
        const { readdirSync, statSync } = await import('node:fs');
        for (const name of readdirSync(dir)) {
          if (statSync(join(dir, name)).mtimeMs >= sinceMs) return true;
        }
      } catch { /* 目录不存在继续 */ }
      // ② 主进程监听 127.0.0.1:18488
      if (await portOpen(WORKBUDDY_HELPER_PORT)) return true;
      // ③ 主窗口标题 WorkBuddy*
      const window = await runPowerShell(
        `$exe=${psQuote(paths.exePath)}; Get-Process -Name ${psQuote(basename(paths.exePath, '.exe'))} -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'WorkBuddy*' } | Select-Object -First 1 -ExpandProperty Id`, 8000);
      if (window && /^\d+$/.test(window)) return true;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return false;
  },
};

/** 供路由/冒烟只读使用：当前身份（不构造 provider 实例） */
export async function readCurrentWorkbuddyIdentity(): Promise<{ identity: ClientIdentity | null; instance_id: string }> {
  const paths = defaultWorkbuddyPaths();
  return { identity: await readWorkbuddyIdentity(paths), instance_id: computeWorkbuddyInstanceId(paths.exePath) };
}
