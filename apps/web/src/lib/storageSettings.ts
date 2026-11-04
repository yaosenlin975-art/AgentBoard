/**
 * DB-3B-W：数据存储分区的契约层 —— 接**真端点**（DB-3 已交付，桩已移除）。
 *
 * 端点（服务端实测）：
 * - `GET  /api/settings/storage`              → StorageInfo（路径/来源/占用/附件目录/迁移估算/truncated）
 * - `POST /api/settings/db-path/migrate`      → 202 { migration_id, backup_dir, stages, stage, message }
 * - `GET  /api/settings/db-path/migrate/:id`  → MigrationStatus（阶段序列 + ok/code/message/backup_dir）
 *
 * 阶段映射（服务端 10 个 → UI 五格）：preflight→检查、snapshot→复制、verify→校验、
 * switch/restart→切换、selfcheck/cleanup/done→自检（完成）；rolled_back/failed→失败态。
 * 计数一律由服务端给，前端只格式化；`truncated` 或 usage 缺失时明确写「统计过大已省略」，绝不显示 0。
 */

/** 生效路径的来源：环境变量 / 设置持久化 / 默认 */
export type StoragePathSource = 'env' | 'settings' | 'default';

export interface StorageUsage {
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  attachments_bytes: number;
  attachments_files: number;
  total_bytes: number;
}

export interface MigrationEstimate {
  issue_count: number;
  attachment_count: number;
  estimated_bytes: number;
  required_bytes: number;
}

export interface StorageInfo {
  db_path: string;
  /** DB-3 起服务端必给；老服务端可能缺失 → null（UI 写「来源未知」） */
  db_path_source: StoragePathSource | null;
  attachments_dir: string;
  usage: StorageUsage | null;
  migration_estimate: MigrationEstimate | null;
  /** 统计过大被截断：UI 必须显示「统计过大已省略」而不是 0 */
  truncated: boolean;
}

/** 服务端阶段机（services/dbMigration.ts） */
export type ServerStage =
  | 'preflight' | 'snapshot' | 'verify' | 'switch' | 'restart'
  | 'selfcheck' | 'cleanup' | 'done' | 'rolled_back' | 'failed';

export interface MigrationStatusEntry {
  stage: ServerStage;
  at: number;
  detail?: string;
}

export interface MigrationStatus {
  migration_id: string;
  stage: ServerStage;
  stages: MigrationStatusEntry[];
  /** null = 已切换、等新进程自检 */
  ok: boolean | null;
  code: string | null;
  message: string;
  retryable: boolean;
  backup_dir: string | null;
  from_db_path: string;
  to_db_path: string;
}

/** UI 五格 */
export type UiStage = 'check' | 'copy' | 'verify' | 'switch' | 'selfcheck';

export const STORAGE_MIGRATION_STAGES: readonly { id: UiStage; label: string }[] = [
  { id: 'check', label: '检查' },
  { id: 'copy', label: '复制' },
  { id: 'verify', label: '校验' },
  { id: 'switch', label: '切换' },
  { id: 'selfcheck', label: '自检' },
];

/** 服务端阶段 → UI 五格（restart 归「切换」，cleanup/done 归「自检」完成态） */
export const SERVER_STAGE_TO_UI: Record<ServerStage, UiStage> = {
  preflight: 'check',
  snapshot: 'copy',
  verify: 'verify',
  switch: 'switch',
  restart: 'switch',
  selfcheck: 'selfcheck',
  cleanup: 'selfcheck',
  done: 'selfcheck',
  rolled_back: 'selfcheck',
  failed: 'selfcheck',
};

export function uiStageOf(stage: ServerStage): UiStage {
  return SERVER_STAGE_TO_UI[stage] ?? 'check';
}

export type MigrationOutcome = 'running' | 'succeeded' | 'failed';

export interface StorageMigration {
  migrationId: string | null;
  status: MigrationOutcome;
  /** 当前 UI 阶段 */
  stage: UiStage;
  /** 已到达的 UI 阶段序列（按到达顺序、去重，用于点亮五格） */
  reached: UiStage[];
  targetPath: string | null;
  errorCode: string | null;
  message: string;
  /** 失败但已回滚到原路径 */
  rolledBack: boolean;
  backupDir: string | null;
}

/**
 * 七个指定错误码 + 其余已知码的中文文案。
 * 服务端也返回中文 message；这里保证「即便服务端文案变化，前端对关键码仍有稳定可读文案」。
 */
export const MIGRATION_ERROR_TEXT: Record<string, string> = {
  DB_MIGRATION_NO_SPACE: '目标磁盘剩余空间不足（约需 1.2 倍数据量），清理空间后重试',
  DB_MIGRATION_VERIFY_FAILED: '复制校验失败（附件数量/字节/哈希不符），源库与设置未改动，可重试',
  DB_MIGRATION_TARGET_EXISTS: '目标已存在同名数据库；确认覆盖请勾选「覆盖目标文件」后重试',
  DB_MIGRATION_SELFCHECK_FAILED: '新进程自检失败（表数/卡数/附件与迁移前不一致）',
  DB_MIGRATION_ROLLED_BACK: '迁移未完成，已回滚到原路径',
  DB_MIGRATION_BUSY: '已有迁移在进行中（同一时间只允许一个）',
  DB_MIGRATION_ENV_OVERRIDDEN: '数据库位置由环境变量 AGENTBOARD_DB 指定，无法在此修改',
  DB_MIGRATION_TARGET_UNWRITABLE: '目标目录不可写，检查权限后重试',
  DB_MIGRATION_COPY_FAILED: '一致性快照失败，源库与设置均未改动，可直接重试',
  DB_MIGRATION_RESTART_UNAVAILABLE: '当前装配不支持自动重启，迁移不可用',
};

export function migrationErrorText(code: string | null, fallback: string): string {
  if (code === null) return fallback;
  return MIGRATION_ERROR_TEXT[code] ?? fallback;
}

async function readError(response: Response): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return { code: body.error?.code ?? null, message: body.error?.message ?? `HTTP ${response.status}` };
  } catch {
    return { code: null, message: `HTTP ${response.status}` };
  }
}

export class StorageApiError extends Error {
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(migrationErrorText(code, message));
    this.name = 'StorageApiError';
    this.code = code;
  }
}

/** 读存储信息（真实端点） */
export async function fetchStorageInfo(): Promise<StorageInfo> {
  const response = await fetch('/api/settings/storage');
  if (!response.ok) {
    const err = await readError(response);
    throw new StorageApiError(err.code, err.message);
  }
  const data = (await response.json()) as Partial<StorageInfo>;
  return {
    db_path: typeof data.db_path === 'string' ? data.db_path : '',
    db_path_source: (data.db_path_source ?? null) as StoragePathSource | null,
    attachments_dir: typeof data.attachments_dir === 'string' ? data.attachments_dir : '',
    usage: (data.usage ?? null) as StorageUsage | null,
    migration_estimate: (data.migration_estimate ?? null) as MigrationEstimate | null,
    truncated: data.truncated === true,
  };
}

/** 发起迁移（202）→ migration_id；错误码已转中文 */
export async function startStorageMigration(targetPath: string, overwrite = false): Promise<{ migrationId: string | null; message: string }> {
  const response = await fetch('/api/settings/db-path/migrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_db_path: targetPath, ...(overwrite ? { overwrite: true } : {}) }),
  });
  if (!response.ok) {
    const err = await readError(response);
    throw new StorageApiError(err.code, err.message);
  }
  const body = (await response.json()) as { migration_id?: string; message?: string };
  return { migrationId: body.migration_id ?? null, message: body.message ?? '' };
}

/** 查迁移进度（状态落盘，重启后仍可查） */
export async function fetchMigrationStatus(migrationId: string): Promise<MigrationStatus> {
  const response = await fetch(`/api/settings/db-path/migrate/${encodeURIComponent(migrationId)}`);
  if (!response.ok) {
    const err = await readError(response);
    throw new StorageApiError(err.code, err.message);
  }
  return (await response.json()) as MigrationStatus;
}

/** 服务端状态 → UI 迁移状态（阶段映射 + 终态判定） */
export function toMigrationView(status: MigrationStatus): StorageMigration {
  const reached: UiStage[] = [];
  for (const entry of status.stages) {
    const ui = uiStageOf(entry.stage);
    if (!reached.includes(ui)) reached.push(ui);
  }
  const current = uiStageOf(status.stage);
  if (!reached.includes(current)) reached.push(current);
  const rolledBack = status.stage === 'rolled_back' || status.code === 'DB_MIGRATION_ROLLED_BACK';
  const failed = status.ok === false || status.stage === 'failed' || rolledBack;
  const done = status.ok === true && (status.stage === 'done' || status.stage === 'cleanup' || status.stage === 'selfcheck');
  return {
    migrationId: status.migration_id,
    status: failed ? 'failed' : done ? 'succeeded' : 'running',
    stage: current,
    reached,
    targetPath: status.to_db_path,
    errorCode: status.code,
    message: failed ? migrationErrorText(status.code, status.message) : status.message,
    rolledBack,
    backupDir: status.backup_dir,
  };
}

/** 轮询间隔：1s 起，每 5s 翻倍，上限 5s（服务重启期间靠它继续追） */
export function nextPollDelay(elapsedMs: number): number {
  const step = Math.floor(elapsedMs / 1000);
  return Math.min(5000, 1000 * 2 ** Math.min(3, Math.floor(step / 5)));
}

/** 轮询到终态；服务重启期间的请求失败被忽略（继续追） */
export async function pollMigration(
  migrationId: string,
  onUpdate: (view: StorageMigration) => void,
  options: { maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<StorageMigration | null> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const maxMs = options.maxMs ?? 180_000;
  const started = now();
  let view: StorageMigration | null = null;
  while (now() - started < maxMs) {
    try {
      view = toMigrationView(await fetchMigrationStatus(migrationId));
      onUpdate(view);
      if (view.status !== 'running') return view;
    } catch {
      // 服务正在重启：忽略，继续轮询
    }
    await sleep(nextPollDelay(now() - started));
  }
  return view;
}

/** 字节数 → 人类可读（只格式化，不做任何统计） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 来源文案 */
export function storageSourceLabel(source: StoragePathSource | null): string {
  if (source === 'env') return '环境变量 AGENTBOARD_DB';
  if (source === 'settings') return '设置（持久化到 config.json）';
  if (source === 'default') return '默认位置';
  return '来源未知';
}

/** 占用汇总：truncated 或 usage 缺失 → 「统计过大已省略」，不显示 0 */
export function usageSummary(info: StorageInfo): string {
  if (info.usage === null) return info.truncated ? '统计过大已省略' : '服务端未提供统计';
  const u = info.usage;
  return `数据库 ${formatBytes(u.db_bytes)}（WAL ${formatBytes(u.wal_bytes)}）· 附件 ${formatBytes(u.attachments_bytes)}（${u.attachments_files} 个文件）· 合计 ${formatBytes(u.total_bytes)}`;
}

/**
 * FOLDER-PICK：调服务端原生目录选择端点（`POST /api/system/pick-folder`，Windows `FolderBrowserDialog`）。
 * 返回选中的绝对路径；**用户取消时服务端返回 `{ path: null }`** → 这里也返回 null，
 * 调用方据此「不改输入、不报错」。服务端有单例守卫（同时只允许一个窗口），故请求期间前端必须禁用按钮。
 */
export async function pickFolder(): Promise<string | null> {
  const response = await fetch('/api/system/pick-folder', { method: 'POST' });
  if (!response.ok) {
    // 服务端失败文案是中文且可读（如「打开文件夹选择窗口失败: …」），原样抛给调用方展示
    let message = `选择文件夹失败（HTTP ${response.status}）`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (typeof payload?.error?.message === 'string' && payload.error.message !== '') message = payload.error.message;
    } catch { /* 非 JSON 响应：保留状态码文案 */ }
    throw new Error(message);
  }
  const payload = (await response.json()) as { path?: string | null };
  const picked = typeof payload?.path === 'string' ? payload.path.trim() : '';
  return picked === '' ? null : picked;
}
export type PathValidation = { ok: true } | { ok: false; message: string };

/**
 * 路径校验（前端能做的那部分）：非空、绝对路径、文件名建议。
 * 真实可写性/剩余空间/锁冲突由服务端在迁移前检查——前端不假装知道。
 */
export function validateTargetPath(input: string, currentPath: string): PathValidation {
  const value = input.trim();
  if (value === '') return { ok: false, message: '路径不能为空' };
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
  if (!isAbsolute) return { ok: false, message: '需要绝对路径（例如 D:\\AgentBoard\\agentboard.db）' };
  if (!/\.(db|sqlite|sqlite3)$/i.test(value)) return { ok: false, message: '目标应是 .db 文件路径（不是目录）' };
  const normalize = (p: string): string => p.trim().replace(/\//g, '\\').toLowerCase();
  if (normalize(value) === normalize(currentPath)) return { ok: false, message: '与当前路径相同，无需迁移' };
  const slash = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  const fileName = value.slice(slash + 1);
  if (!/^agentboard.*\.(db|sqlite|sqlite3)$/i.test(fileName)) {
    return { ok: false, message: `目标文件名建议保持 agentboard.db 前缀（当前：${fileName}），以免与同目录其它数据库混淆` };
  }
  return { ok: true };
}

/** 确认框文案：数字全部来自服务端（`migration_estimate`），缺失时明确写「未知」 */
export function migrationConfirmText(estimate: MigrationEstimate | null, targetPath: string): string {
  if (estimate === null) return `将把数据库迁移到 ${targetPath}；服务端未提供卡片/附件/体积统计。迁移期间服务会重启。`;
  return `将把数据库迁移到 ${targetPath}：迁移 ${estimate.issue_count} 张卡 / ${estimate.attachment_count} 个附件 / 预计 ${formatBytes(estimate.estimated_bytes)}（需 ${formatBytes(estimate.required_bytes)} 可用空间），迁移期间服务会重启。`;
}
