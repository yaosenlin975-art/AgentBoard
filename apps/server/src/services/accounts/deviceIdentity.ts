/**
 * ACC-KB-B6：设备身份（方案 B）——字段读写、一次性回填、`pending` 标记与重试、安全快照。
 *
 * 设计要点（Docs/decisions/2026-11-04-device-identity.md §3 方案 B）：
 * - 新增 `device_identity_ref` 指向**新快照**，**绝不覆盖** `client_snapshot_ref`（数据级可回滚）；
 * - 回填失败不阻断、不回滚：写 `device_identity_status='pending'` + 固定错误码，后续可重试；
 * - 写客户端登录文件前必须先落 `security/<uuid>` 快照（文件清单 + 每个文件 sha256 前 8 位），
 *   禁止无备份直改真实文件；
 * - 本模块不碰路由、不碰 web；捕获/写回动作由调用方注入（便于单测与后续 provider 接入）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../../db/connection.js';

/** 固定错误码（写进 `managed_account.device_identity_error`，不进自由文本） */
export const DEVICE_IDENTITY_ERROR_CODES = {
  /** 还没回填过（老账号默认态） */
  pending: 'DEVICE_IDENTITY_PENDING',
  /** 捕获客户端设备字段失败（文件缺失/不可读/解析失败） */
  captureFailed: 'DEVICE_IDENTITY_CAPTURE_FAILED',
  /** 写安全快照失败（磁盘/权限） */
  snapshotFailed: 'DEVICE_IDENTITY_SNAPSHOT_FAILED',
  /** 快照写回后校验不通过（sha8 清单与实际文件不符） */
  verifyFailed: 'DEVICE_IDENTITY_VERIFY_FAILED',
  /** 该平台没有设备身份字段（MiniMax 等），不需要搬 */
  notApplicable: 'DEVICE_IDENTITY_NOT_APPLICABLE',
} as const;

export type DeviceIdentityStatusCode = (typeof DEVICE_IDENTITY_ERROR_CODES)[keyof typeof DEVICE_IDENTITY_ERROR_CODES];

export type DeviceIdentityStatus = 'pending' | 'ok' | 'not_applicable';

export interface DeviceIdentityRow {
  account_id: string;
  app_id: string;
  status: DeviceIdentityStatus;
  ref: string | null;
  error: string | null;
  updated_at: number | null;
}

/** 一次设备字段捕获的结果：要落盘的文件（相对路径 → 内容） */
export interface DeviceIdentityCapture {
  files: Array<{ path: string; content: Buffer }>;
}

export interface SnapshotManifestEntry {
  path: string;
  bytes: number;
  /** sha256 前 8 位（与卡面口径一致；不落全量哈希便于人眼比对） */
  sha8: string;
}

export interface SnapshotManifest {
  schema: 'agentboard.device-identity.snapshot/1';
  account_id: string;
  created_at: number;
  files: SnapshotManifestEntry[];
}

export const DEVICE_SNAPSHOT_SCHEMA = 'agentboard.device-identity.snapshot/1' as const;

const sha8 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex').slice(0, 8);

/** `security/<uuid>` 快照目录（与 db 同源派生，容器只挂 /data） */
export function securitySnapshotDir(dbPath: string, accountId: string): string {
  return join(dirname(dbPath), 'security', accountId);
}

/**
 * 写安全快照：把捕获到的文件落到 `security/<uuid>/files/...`，并写 `manifest.json`
 * （文件清单 + 字节数 + sha256 前 8 位）。返回 manifest；任何一步失败都抛错（由调用方转成固定码）。
 */
export function writeSecuritySnapshot(dir: string, accountId: string, capture: DeviceIdentityCapture, now = Date.now()): SnapshotManifest {
  if (capture.files.length === 0) throw new Error('捕获结果为空，拒绝写空快照');
  const filesDir = join(dir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const entries: SnapshotManifestEntry[] = [];
  for (const file of capture.files) {
    const target = join(filesDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    entries.push({ path: file.path, bytes: file.content.length, sha8: sha8(file.content) });
  }
  const manifest: SnapshotManifest = {
    schema: DEVICE_SNAPSHOT_SCHEMA,
    account_id: accountId,
    created_at: now,
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * 校验快照：manifest 存在、schema 对、每个文件都在且 sha256 前 8 位一致。
 * 返回问题清单（空数组 = 通过）。
 */
export function verifySecuritySnapshot(dir: string): string[] {
  const problems: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [`缺少 manifest.json：${manifestPath}`];
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  } catch (error) {
    return [`manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`];
  }
  if (manifest.schema !== DEVICE_SNAPSHOT_SCHEMA) problems.push(`schema 不符：${String(manifest.schema)}`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) problems.push('manifest.files 为空');
  for (const entry of manifest.files ?? []) {
    const target = join(dir, 'files', entry.path);
    if (!existsSync(target)) {
      problems.push(`缺文件：${entry.path}`);
      continue;
    }
    const content = readFileSync(target);
    if (content.length !== entry.bytes) problems.push(`字节数不符：${entry.path}（期望 ${entry.bytes}，实际 ${content.length}）`);
    const actual = sha8(content);
    if (actual !== entry.sha8) problems.push(`sha256 前 8 位不符：${entry.path}（期望 ${entry.sha8}，实际 ${actual}）`);
  }
  return problems;
}

/** 读某账号的设备身份状态 */
export function getDeviceIdentity(db: Db, accountId: string): DeviceIdentityRow | null {
  const row = db.prepare(
    'SELECT id AS account_id, app_id, device_identity_status AS status, device_identity_ref AS ref, device_identity_error AS error, device_identity_updated_at AS updated_at FROM managed_account WHERE id=?',
  ).get(accountId) as DeviceIdentityRow | undefined;
  return row ?? null;
}

/** 标记 pending（回填失败/未回填），带固定错误码 */
export function markDeviceIdentityPending(db: Db, accountId: string, code: DeviceIdentityStatusCode, now = Date.now()): void {
  db.prepare("UPDATE managed_account SET device_identity_status='pending', device_identity_error=?, device_identity_updated_at=? WHERE id=?")
    .run(code, now, accountId);
}

/** 标记 ok（回填成功），写入新 ref */
export function markDeviceIdentityOk(db: Db, accountId: string, ref: string, now = Date.now()): void {
  db.prepare("UPDATE managed_account SET device_identity_status='ok', device_identity_ref=?, device_identity_error=NULL, device_identity_updated_at=? WHERE id=?")
    .run(ref, now, accountId);
}

/** 标记 not_applicable（该平台无设备字段） */
export function markDeviceIdentityNotApplicable(db: Db, accountId: string, now = Date.now()): void {
  db.prepare("UPDATE managed_account SET device_identity_status='not_applicable', device_identity_ref=NULL, device_identity_error=?, device_identity_updated_at=? WHERE id=?")
    .run(DEVICE_IDENTITY_ERROR_CODES.notApplicable, now, accountId);
}

export interface BackfillDeps {
  /** 捕获某账号的设备字段；抛错 = 捕获失败 */
  capture: (account: { id: string; app_id: string; client_snapshot_ref: string | null }) => Promise<DeviceIdentityCapture | null>;
  /** 写快照并返回 ref（缺省用 securitySnapshotDir + writeSecuritySnapshot + verify） */
  writeSnapshot?: (account: { id: string; app_id: string }, capture: DeviceIdentityCapture) => Promise<string>;
  /** 无设备字段的平台（缺省 minimax） */
  notApplicableApps?: string[];
  /** 只回填这些账号（缺省：所有 pending 的账号） */
  onlyAccountIds?: string[];
  now?: () => number;
}

export interface BackfillSummary {
  scanned: number;
  ok: number;
  pending: number;
  notApplicable: number;
  /** account_id → 固定错误码（仅失败项） */
  failures: Record<string, string>;
}

interface AccountRow { id: string; app_id: string; client_snapshot_ref: string | null; device_identity_status: string }

/**
 * 一次性回填（可重试：只处理 `pending` 的账号；`onlyAccountIds` 可强制重试指定账号）。
 * 失败不抛错、不阻断：写 pending + 固定码，并把失败项汇总返回。
 */
export async function backfillDeviceIdentity(db: Db, deps: BackfillDeps): Promise<BackfillSummary> {
  const notApplicable = new Set(deps.notApplicableApps ?? ['minimax']);
  const now = deps.now ?? (() => Date.now());
  const rows = (deps.onlyAccountIds === undefined
    ? db.prepare("SELECT id, app_id, client_snapshot_ref, device_identity_status FROM managed_account WHERE device_identity_status='pending'").all()
    : db.prepare(`SELECT id, app_id, client_snapshot_ref, device_identity_status FROM managed_account WHERE id IN (${deps.onlyAccountIds.map(() => '?').join(',')})`).all(...deps.onlyAccountIds)) as AccountRow[];
  const summary: BackfillSummary = { scanned: rows.length, ok: 0, pending: 0, notApplicable: 0, failures: {} };
  for (const row of rows) {
    if (notApplicable.has(row.app_id)) {
      markDeviceIdentityNotApplicable(db, row.id, now());
      summary.notApplicable += 1;
      continue;
    }
    let capture: DeviceIdentityCapture | null;
    try {
      capture = await deps.capture({ id: row.id, app_id: row.app_id, client_snapshot_ref: row.client_snapshot_ref });
    } catch (error) {
      markDeviceIdentityPending(db, row.id, DEVICE_IDENTITY_ERROR_CODES.captureFailed, now());
      summary.pending += 1;
      summary.failures[row.id] = DEVICE_IDENTITY_ERROR_CODES.captureFailed;
      void error;
      continue;
    }
    if (capture === null || capture.files.length === 0) {
      markDeviceIdentityPending(db, row.id, DEVICE_IDENTITY_ERROR_CODES.captureFailed, now());
      summary.pending += 1;
      summary.failures[row.id] = DEVICE_IDENTITY_ERROR_CODES.captureFailed;
      continue;
    }
    try {
      const ref = deps.writeSnapshot === undefined
        ? `security/${row.id}`
        : await deps.writeSnapshot({ id: row.id, app_id: row.app_id }, capture);
      markDeviceIdentityOk(db, row.id, ref, now());
      summary.ok += 1;
    } catch {
      markDeviceIdentityPending(db, row.id, DEVICE_IDENTITY_ERROR_CODES.snapshotFailed, now());
      summary.pending += 1;
      summary.failures[row.id] = DEVICE_IDENTITY_ERROR_CODES.snapshotFailed;
    }
  }
  return summary;
}
