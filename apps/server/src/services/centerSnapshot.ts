/**
 * STORE-6：中心库文本快照（JSONL + manifest）。
 *
 * 与工作区快照（workspaceSnapshot.ts）互补：
 * - 工作区快照：一个工作区的业务数据（库为准），可进该工作区仓库的 `.agentboard/`；
 * - 中心库快照：**全局**元数据——工作区注册表、成员、账号/签到元数据、scope=common 知识页及
 *   历史版本。它落在中心库同级的 `center-snapshot/`，不随单个工作区仓库走。
 *
 * 安全：账号凭据/快照引用一律脱敏（`***`），导出后自校验会再扫一遍，防止把密钥写进 git。
 * 本版本只导出 + 校验，不提供导入（中心库重建仍走库备份；避免半吊子合并）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';

export const CENTER_SNAPSHOT_SCHEMA_VERSION = 1;
export const CENTER_SNAPSHOT_FORMAT = 'agentboard.center-snapshot/1';
export const CENTER_SNAPSHOT_GENERATOR_VERSION = 'agentboard-server/1';
/** 脱敏占位：既证明字段存在，又不泄露任何引用路径 */
export const REDACTED = '***';

interface CenterTableSpec {
  file: string;
  table: string;
  sql: string;
  /** 这些列的值统一替换为 *** */
  redact?: string[];
}

/** 导出顺序按外键：workspace → member → account → operation → 知识页 → revision */
const CENTER_TABLES: readonly CenterTableSpec[] = [
  { file: 'workspaces', table: 'workspace', sql: 'SELECT * FROM workspace' },
  { file: 'workspace_members', table: 'workspace_member', sql: 'SELECT * FROM workspace_member' },
  {
    file: 'managed_accounts',
    table: 'managed_account',
    sql: 'SELECT * FROM managed_account',
    redact: ['client_snapshot_ref', 'checkin_credential_ref'],
  },
  {
    file: 'account_operations',
    table: 'account_operation',
    sql: 'SELECT * FROM account_operation',
    redact: ['recovery_ref'],
  },
  { file: 'common_knowledge_pages', table: 'knowledge_page', sql: "SELECT * FROM knowledge_page WHERE scope='common'" },
  {
    file: 'common_knowledge_revisions',
    table: 'knowledge_revision',
    sql: "SELECT r.* FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.scope='common'",
  },
];

export interface CenterSnapshotFileEntry {
  file: string;
  table: string;
  rows: number;
  sha256: string;
}

export interface CenterSnapshotManifest {
  format: string;
  scope: 'center';
  schema_version: number;
  exported_at: string;
  generator_version: string;
  source_db: string;
  included_tables: string[];
  files: CenterSnapshotFileEntry[];
}

export interface ExportCenterSnapshotResult {
  dir: string;
  manifest: CenterSnapshotManifest;
}

export interface CenterSnapshotValidation {
  dir: string;
  manifest: CenterSnapshotManifest;
  tables: Array<{ table: string; rows: number }>;
}

const isTimeColumn = (column: string): boolean => column === 'ts' || column.endsWith('_at');
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 中心快照固定落在中心库同级的 center-snapshot/（不跟随工作区仓库） */
export function centerSnapshotDir(centerDbPath: string): string {
  return join(dirname(centerDbPath), 'center-snapshot');
}

function tableColumns(db: Db, table: string): Array<{ name: string; pk: number }> {
  const columns = db.pragma(`table_info(${quoteIdent(table)})`) as Array<{ name: string; pk: number }>;
  if (columns.length === 0) {
    throw new ApiError(500, 'SNAPSHOT_SCHEMA_MISSING', `中心快照导出失败：库中缺少表 ${table}`);
  }
  return columns;
}

function readCenterRows(db: Db): Array<{ spec: CenterTableSpec; content: string; rows: number }> {
  return db.transaction(() => CENTER_TABLES.map(spec => {
    const columns = tableColumns(db, spec.table);
    const redact = new Set(spec.redact ?? []);
    const order = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const orderBy = order.length > 0 ? ` ORDER BY ${order.map(column => quoteIdent(column.name)).join(', ')}` : ' ORDER BY rowid';
    const rawRows = db.prepare(`${spec.sql}${orderBy}`).all() as Array<Record<string, unknown>>;
    const lines = rawRows.map(row => {
      const out: Record<string, unknown> = {};
      for (const column of columns) {
        const value = row[column.name];
        if (redact.has(column.name)) out[column.name] = value === null || value === undefined ? value : REDACTED;
        else out[column.name] = isTimeColumn(column.name) && typeof value === 'number' ? new Date(value).toISOString() : value;
      }
      return JSON.stringify(out);
    });
    return { spec, content: lines.length === 0 ? '' : `${lines.join('\n')}\n`, rows: lines.length };
  }))();
}

function writeAtomically(dir: string, files: Array<{ name: string; content: string }>): void {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.center-snapshot-tmp-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  const backup = join(parent, `.center-snapshot-old-${randomUUID()}`);
  let movedOld = false;
  try {
    for (const file of files) writeFileSync(join(tmp, file.name), file.content, 'utf8');
    if (existsSync(dir)) {
      renameSync(dir, backup);
      movedOld = true;
    }
    renameSync(tmp, dir);
  } catch (error) {
    if (movedOld && !existsSync(dir) && existsSync(backup)) renameSync(backup, dir);
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  if (movedOld) rmSync(backup, { recursive: true, force: true });
}

function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** 脱敏自检：manifest 声明的脱敏列，非空值必须是 ***（防止未来改列名后悄悄泄露） */
function assertRedacted(dir: string, files: CenterSnapshotFileEntry[]): void {
  for (const spec of CENTER_TABLES) {
    if (spec.redact === undefined) continue;
    const entry = files.find(file => file.file === spec.file);
    if (entry === undefined) continue;
    const content = readFileSync(join(dir, `${spec.file}.jsonl`), 'utf8');
    for (const line of content.split('\n')) {
      if (line === '') continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const column of spec.redact) {
        const value = row[column];
        if (value !== null && value !== undefined && value !== REDACTED) {
          throw new ApiError(500, 'CENTER_SNAPSHOT_SECRET_LEAK', `中心快照含未脱敏字段 ${spec.table}.${column}`);
        }
      }
    }
  }
}

export function exportCenterSnapshot(input: { db: Db; centerDbPath: string; now?: () => number }): ExportCenterSnapshotResult {
  const dir = centerSnapshotDir(input.centerDbPath);
  const tables = readCenterRows(input.db);
  const files: CenterSnapshotFileEntry[] = tables.map(({ spec, content, rows }) => ({
    file: spec.file,
    table: spec.table,
    rows,
    sha256: sha256(content),
  }));
  const manifest: CenterSnapshotManifest = {
    format: CENTER_SNAPSHOT_FORMAT,
    scope: 'center',
    schema_version: CENTER_SNAPSHOT_SCHEMA_VERSION,
    exported_at: new Date(input.now?.() ?? Date.now()).toISOString(),
    generator_version: CENTER_SNAPSHOT_GENERATOR_VERSION,
    source_db: input.centerDbPath,
    included_tables: files.map(file => file.table),
    files,
  };
  writeAtomically(dir, [
    ...tables.map(({ spec, content }) => ({ name: `${spec.file}.jsonl`, content })),
    { name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ]);
  assertRedacted(dir, files);
  return { dir, manifest };
}

/**
 * 只读校验中心快照：manifest 结构 + 文件哈希/行数 + 脱敏自检。
 * 任何不符都抛 422 SNAPSHOT_INVALID（与工作区快照同一错误码，CLI 无需分支）。
 */
export function validateCenterSnapshot(dir: string): CenterSnapshotValidation {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：缺少 manifest.json（${path}）`);
  }
  let manifest: CenterSnapshotManifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as CenterSnapshotManifest;
  } catch (error) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest.json 不是合法 JSON（${(error as Error).message}）`);
  }
  if (manifest.format !== CENTER_SNAPSHOT_FORMAT) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：format 不支持（${String(manifest.format)}，期望 ${CENTER_SNAPSHOT_FORMAT}）`);
  }
  if (manifest.schema_version !== CENTER_SNAPSHOT_SCHEMA_VERSION) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：schema_version=${String(manifest.schema_version)}，当前只支持 ${CENTER_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.included_tables)) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', '快照不可导入：manifest.files / included_tables 缺失');
  }
  const known = new Map(CENTER_TABLES.map(spec => [spec.file, spec]));
  const tables: Array<{ table: string; rows: number }> = [];
  for (const entry of manifest.files) {
    const spec = known.get(entry.file);
    if (spec === undefined) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest 含未知文件 ${entry.file}`);
    }
    const file = join(dir, `${entry.file}.jsonl`);
    if (!existsSync(file)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：缺少文件 ${entry.file}.jsonl`);
    }
    const content = readFileSync(file, 'utf8');
    if (sha256(content) !== entry.sha256) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${entry.file}.jsonl 哈希不符`);
    }
    if (countLines(content) !== entry.rows) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${entry.file}.jsonl 行数与 manifest 不符`);
    }
    tables.push({ table: spec.table, rows: entry.rows });
  }
  for (const spec of CENTER_TABLES) {
    if (!manifest.files.some(file => file.file === spec.file)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest 缺少必需表 ${spec.file}`);
    }
  }
  assertRedacted(dir, manifest.files);
  return { dir, manifest, tables };
}
