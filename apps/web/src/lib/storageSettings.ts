/**
 * DB-3：数据存储分区的**契约层**（真实端点接线点集中在这里）。
 *
 * 为什么单独一层：卡片明确要求「先用 mock/契约桩驱动 UI，等 DB-2B（`4719248b`）落地再切真端点，
 * 切换时只改一个调用点」。所以 UI 只依赖本模块导出的 `fetchStorageInfo` / `startStorageMigration`，
 * 桩与真实的差异被 `STORAGE_API` 这一个开关收口。
 *
 * 契约（按 DB-2B 编排端点预期形状起草，落地后以服务端为准微调）：
 * - `GET  /api/settings/storage`          → StorageInfo（当前路径/来源/占用/附件目录/迁移前置计数）
 * - `POST /api/settings/storage/migrate`  → StorageMigration（阶段机 + 完成/失败信息）
 * 计数字段一律由**服务端**给（卡片数、附件数、预计字节数），前端只做展示与格式化，绝不自己算。
 */

/** 生效路径的来源：环境变量 / 设置持久化 / 默认 */
export type StoragePathSource = 'env' | 'settings' | 'default';

export interface StorageUsage {
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  attachments_bytes: number;
  total_bytes: number;
}

export interface StorageInfo {
  db_path: string;
  /** 契约来源；DB-2B 前服务端可能不返回 → null（UI 显示「待接口」占位） */
  db_path_source: StoragePathSource | null;
  attachments_dir: string;
  /** 服务端统计；未实现时为 null（UI 明确写「服务端未提供」，不自己扫描/估算） */
  usage: StorageUsage | null;
  /** 迁移前置计数同样由服务端给（卡片数 / 附件数 / 预计字节） */
  migration_estimate: { issues: number; attachments: number; bytes: number } | null;
}

export type StorageMigrationStage = 'check' | 'copy' | 'verify' | 'switch' | 'selfcheck';
export type StorageMigrationStatus = 'running' | 'succeeded' | 'failed';

export interface StorageMigration {
  status: StorageMigrationStatus;
  stage: StorageMigrationStage;
  target_path: string;
  /** 失败时：固定错误码 + 是否已回滚到原路径 */
  error_code: string | null;
  rolled_back: boolean;
}

export const STORAGE_MIGRATION_STAGES: readonly { id: StorageMigrationStage; label: string }[] = [
  { id: 'check', label: '检查' },
  { id: 'copy', label: '复制' },
  { id: 'verify', label: '校验' },
  { id: 'switch', label: '切换' },
  { id: 'selfcheck', label: '自检' },
];

/**
 * 桩开关：`true` = 用本文件的桩数据（DB-2B 未落地）；`false` = 打真实端点。
 * **切换点就在这两行 fetch 实现里**，UI 不需要改。
 */
export const STORAGE_API = { stub: true } as const;

/** 桩数据明确标注：真机截图与测试里都要能看出「不是真实统计」 */
export const STUB_NOTICE = '桩数据（真实统计待 DB-2B 编排端点）';

const STUB_INFO: StorageInfo = {
  db_path: 'C:\\Users\\31633\\AppData\\Roaming\\AgentBoard\\agentboard.db',
  db_path_source: null, // 服务端尚未返回来源 → UI 走「来源：待接口」占位
  attachments_dir: 'C:\\Users\\31633\\AppData\\Roaming\\AgentBoard\\attachments',
  usage: { db_bytes: 18_874_368, wal_bytes: 2_097_152, shm_bytes: 32_768, attachments_bytes: 64_487_424, total_bytes: 85_491_712 },
  migration_estimate: { issues: 214, attachments: 37, bytes: 85_491_712 },
};

export async function fetchStorageInfo(): Promise<StorageInfo> {
  if (STORAGE_API.stub) return STUB_INFO;
  const response = await fetch('/api/settings/storage');
  if (!response.ok) throw new Error(`读取存储信息失败：${response.status}`);
  return (await response.json()) as StorageInfo;
}

export async function startStorageMigration(targetPath: string): Promise<StorageMigration> {
  if (STORAGE_API.stub) {
    return { status: 'running', stage: 'copy', target_path: targetPath, error_code: null, rolled_back: false };
  }
  const response = await fetch('/api/settings/storage/migrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_path: targetPath }),
  });
  if (!response.ok) throw new Error(`迁移请求失败：${response.status}`);
  return (await response.json()) as StorageMigration;
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

/** 来源文案（null = 服务端还没返回来源） */
export function storageSourceLabel(source: StoragePathSource | null): string {
  if (source === 'env') return '环境变量 AGENTBOARD_DB';
  if (source === 'settings') return '设置（持久化到 config.json）';
  if (source === 'default') return '默认位置';
  return '待接口（服务端未返回来源）';
}

export type PathValidation = { ok: true } | { ok: false; message: string };

/**
 * 路径校验（前端能做的那部分）：非空、绝对路径、不像“把 db 塞进别人目录”的冲突提示。
 * 真实可写性/锁冲突由服务端在迁移前检查——前端不假装知道。
 */
export function validateTargetPath(input: string, currentPath: string): PathValidation {
  const value = input.trim();
  if (value === '') return { ok: false, message: '路径不能为空' };
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
  if (!isAbsolute) return { ok: false, message: '需要绝对路径（例如 D:\\AgentBoard\\agentboard.db）' };
  if (!/\.(db|sqlite|sqlite3)$/i.test(value)) return { ok: false, message: '目标应是 .db 文件路径（不是目录）' };
  if (value.toLowerCase() === currentPath.trim().toLowerCase()) return { ok: false, message: '与当前路径相同，无需迁移' };
  // 同目录已有另一个 db：多半是选错了文件，提示但不阻断（服务端会再校）
  const slash = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  const fileName = value.slice(slash + 1);
  if (!/^agentboard.*\.(db|sqlite|sqlite3)$/i.test(fileName)) {
    return { ok: false, message: `目标文件名建议保持 agentboard.db 前缀（当前：${fileName}），以免与同目录其它数据库混淆` };
  }
  return { ok: true };
}

/** 确认框文案：所有数字都来自服务端（`migration_estimate`），缺失时明确写「未知」 */
export function migrationConfirmText(estimate: StorageInfo['migration_estimate'], targetPath: string): string {
  if (estimate === null) return `将把数据库迁移到 ${targetPath}；服务端未提供卡片/附件/体积统计。迁移期间服务会重启。`;
  return `将把数据库迁移到 ${targetPath}：迁移 ${estimate.issues} 张卡 / ${estimate.attachments} 个附件 / 预计 ${formatBytes(estimate.bytes)}，迁移期间服务会重启。`;
}
