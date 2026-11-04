/**
 * ACC-KB-B4S-2：客户端账号域快照（`ClientSnapshotManifest`）与 Trae 明文残留清理。
 *
 * 命名边界（已与 B4S-1 / B6 对齐）：
 * - 本文件的 `ClientSnapshotManifest` 属**客户端账号域**（客户端的登录文件与其 sidecar）；
 * - B6 的 `SnapshotManifest` / `writeSecuritySnapshot` 属**设备身份域**（`services/accounts/deviceIdentity.ts`）；
 * - 两边**不复用类型、不互相 import**，避免把两个域的演化绑在一起。
 *
 * 关键约束：
 * - **成对抓取**：SQLite 类文件的 `-wal` / `-shm` / `-journal` 必须与主文件一起抓。只抓主文件会得到
 *   一个「看起来完整、恢复后数据不一致」的快照（WAL 里还有未 checkpoint 的事务），所以这里把
 *   sidecar 单列一份清单，`verifyClientSnapshot` 也会检查它们。
 * - 快照只记录**清单**（path/bytes/sha8）；真正落盘/加密由调用方（B4S-4 接线）负责。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const CLIENT_SNAPSHOT_SCHEMA = 'agentboard.client-account.snapshot/1' as const;

/** 必须与主文件成对出现的 sidecar 后缀 */
export const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type ClientSnapshotErrorCode =
  /** 清单里列了文件，但磁盘上找不到 */
  | 'CLIENT_SNAPSHOT_FILE_MISSING'
  /** 字节数不符（被截断/追加） */
  | 'CLIENT_SNAPSHOT_SIZE_MISMATCH'
  /** sha256 前 8 位不符（内容被改） */
  | 'CLIENT_SNAPSHOT_SHA_MISMATCH'
  /** 主文件在、sidecar 全丢（成对抓取被破坏） */
  | 'CLIENT_SNAPSHOT_SIDECAR_MISSING'
  /** 清单本身缺失/损坏 */
  | 'CLIENT_SNAPSHOT_MANIFEST_INVALID';

export interface ClientSnapshotFileEntry {
  path: string;
  bytes: number;
  /** sha256 前 8 位（与 B6 的设备身份清单同口径，便于人眼比对） */
  sha8: string;
}

export interface ClientSnapshotManifest {
  schema: typeof CLIENT_SNAPSHOT_SCHEMA;
  /** 主文件（客户端登录文件 / sqlite db 等） */
  files: ClientSnapshotFileEntry[];
  /** 与主文件成对的 sidecar（`-wal` / `-shm` / `-journal`） */
  sidecars: ClientSnapshotFileEntry[];
  createdAt: number;
}

export interface ClientSnapshotVerifyResult {
  ok: boolean;
  /** 固定错误码（去重后按出现顺序） */
  codes: ClientSnapshotErrorCode[];
  /** 可读明细，逐条对应一个文件 */
  problems: string[];
}

const sha8Of = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex').slice(0, 8);

const entryFor = (path: string, content: Buffer): ClientSnapshotFileEntry => ({
  path,
  bytes: content.length,
  sha8: sha8Of(content),
});

/** 某主文件对应的 sidecar 路径（存在才返回；不存在返回空数组） */
export function sqliteSidecarsOf(mainPath: string): string[] {
  const dir = dirname(mainPath);
  const name = basename(mainPath);
  return SQLITE_SIDECAR_SUFFIXES
    .map(suffix => join(dir, `${name}${suffix}`))
    .filter(path => existsSync(path));
}

export interface BuildClientSnapshotOptions {
  /** 要快照的主文件绝对路径 */
  files: string[];
  now?: number;
}

/**
 * 生成清单：主文件 + 它们的 sidecar（成对抓取）。
 * 主文件缺失直接抛错（不允许生成「少文件」的清单）。
 */
export function buildClientSnapshotManifest(options: BuildClientSnapshotOptions): ClientSnapshotManifest {
  const now = options.now ?? Date.now();
  const files: ClientSnapshotFileEntry[] = [];
  const sidecars: ClientSnapshotFileEntry[] = [];
  for (const path of options.files) {
    if (!existsSync(path)) throw new Error(`快照主文件不存在：${path}`);
    files.push(entryFor(path, readFileSync(path)));
    for (const sidecar of sqliteSidecarsOf(path)) sidecars.push(entryFor(sidecar, readFileSync(sidecar)));
  }
  return {
    schema: CLIENT_SNAPSHOT_SCHEMA,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    sidecars: sidecars.sort((a, b) => a.path.localeCompare(b.path)),
    createdAt: now,
  };
}

/**
 * 校验清单与磁盘是否一致。
 * - 缺文件 → `CLIENT_SNAPSHOT_FILE_MISSING`（sidecar 缺失额外补 `CLIENT_SNAPSHOT_SIDECAR_MISSING`）
 * - 字节数不符 → `CLIENT_SNAPSHOT_SIZE_MISMATCH`
 * - sha8 不符 → `CLIENT_SNAPSHOT_SHA_MISMATCH`
 */
export function verifyClientSnapshot(manifest: ClientSnapshotManifest): ClientSnapshotVerifyResult {
  const codes: ClientSnapshotErrorCode[] = [];
  const problems: string[] = [];
  const push = (code: ClientSnapshotErrorCode, detail: string): void => {
    if (!codes.includes(code)) codes.push(code);
    problems.push(detail);
  };
  if (manifest.schema !== CLIENT_SNAPSHOT_SCHEMA) {
    push('CLIENT_SNAPSHOT_MANIFEST_INVALID', `schema 不符：${String(manifest.schema)}`);
    return { ok: false, codes, problems };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    push('CLIENT_SNAPSHOT_MANIFEST_INVALID', 'manifest.files 为空（拒绝把空清单当有效快照）');
    return { ok: false, codes, problems };
  }
  const check = (entry: ClientSnapshotFileEntry, isSidecar: boolean): void => {
    if (!existsSync(entry.path)) {
      push('CLIENT_SNAPSHOT_FILE_MISSING', `缺文件：${entry.path}`);
      if (isSidecar) push('CLIENT_SNAPSHOT_SIDECAR_MISSING', `sidecar 丢失：${entry.path}`);
      return;
    }
    const bytes = statSync(entry.path).size;
    if (bytes !== entry.bytes) push('CLIENT_SNAPSHOT_SIZE_MISMATCH', `字节数不符：${entry.path}（期望 ${entry.bytes}，实际 ${bytes}）`);
    const actual = sha8Of(readFileSync(entry.path));
    if (actual !== entry.sha8) push('CLIENT_SNAPSHOT_SHA_MISMATCH', `sha256 前 8 位不符：${entry.path}（期望 ${entry.sha8}，实际 ${actual}）`);
  };
  for (const entry of manifest.files) check(entry, false);
  for (const entry of manifest.sidecars) check(entry, true);
  // 成对性：清单里声明了主文件但一个 sidecar 都没有，且磁盘上确实存在 sidecar → 视为清单不完整
  for (const main of manifest.files) {
    const onDisk = sqliteSidecarsOf(main.path);
    if (onDisk.length > 0 && manifest.sidecars.every(sidecar => !onDisk.includes(sidecar.path))) {
      push(
        'CLIENT_SNAPSHOT_SIDECAR_MISSING',
        `成对抓取被破坏：${basename(main.path)} 在磁盘上有 ${onDisk.map(path => basename(path)).join(' / ')}，但清单里没有登记`,
      );
    }
  }
  return { ok: codes.length === 0, codes, problems };
}

// ─────────────────────────── Trae 明文残留清理 ───────────────────────────

export type TraeResidualCleanupErrorCode =
  | 'TRAE_RESIDUAL_NOT_FOUND'
  | 'TRAE_RESIDUAL_DELETE_FAILED'
  | 'TRAE_RESIDUAL_DISABLED';

export interface TraeResidualCleanupResult {
  ok: boolean;
  removed: string[];
  code: TraeResidualCleanupErrorCode | null;
  message: string;
}

/**
 * 清理 Trae 的**已知明文残留**：`logs/trae.ai-code-completion/completion.log`。
 *
 * 口径：
 * - 只清这一个已知路径（不扫目录、不按通配符删），避免误删用户数据；
 * - `enabled=false` 时直接返回 `TRAE_RESIDUAL_DISABLED`（可配置关闭）；
 * - 文件本来就不存在 → `TRAE_RESIDUAL_NOT_FOUND`（不是错误，调用方可忽略）；
 * - 删除失败 → `TRAE_RESIDUAL_DELETE_FAILED`（带原因）。
 */
export const TRAE_RESIDUAL_LOG_RELATIVE_PATH = join('logs', 'trae.ai-code-completion', 'completion.log');

export function traeResidualLogPath(traeDataDir: string): string {
  return join(traeDataDir, TRAE_RESIDUAL_LOG_RELATIVE_PATH);
}

export function cleanupTraeResidualLog(options: { traeDataDir: string; enabled?: boolean }): TraeResidualCleanupResult {
  if (options.enabled === false) {
    return { ok: false, removed: [], code: 'TRAE_RESIDUAL_DISABLED', message: '清理已按配置关闭（enabled=false）' };
  }
  const target = traeResidualLogPath(options.traeDataDir);
  if (!existsSync(target)) {
    return { ok: false, removed: [], code: 'TRAE_RESIDUAL_NOT_FOUND', message: `没有需要清理的残留：${target}` };
  }
  try {
    rmSync(target, { force: true });
    return { ok: true, removed: [target], code: null, message: `已删除残留：${target}` };
  } catch (error) {
    return {
      ok: false,
      removed: [],
      code: 'TRAE_RESIDUAL_DELETE_FAILED',
      message: `删除失败（${target}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
