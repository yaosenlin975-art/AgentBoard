/**
 * STORE-5：工作区文本快照（JSONL + manifest）。
 *
 * 设计口径见知识页 §5.8：库为准，快照是派生物。
 * - 导出：单读事务内按主键升序取固定表 → 确定性 JSONL → 临时目录整体 rename 覆盖 snapshot/ → 回读自校验。
 * - 校验：只读 manifest + 每个文件的 sha256/行数，任何不符都视为「不可导入」。
 * - 导入：只允许同 workspace_id 的空工作区库（或 --replace，先 VACUUM INTO 备份）；
 *   单事务按外键顺序插入 → foreign_key_check 必须为空 → 行数比对 → 提交，失败整体回滚。
 *
 * 不导出：messages（--include-messages 时导出）、attachments / knowledge_attachments 二进制、
 * idempotency_record（临时重放缓存）、FTS 影子表（插入 knowledge_page 时由触发器重建）。
 *
 * 约定：时间列（`*_at` 与 `ts`）以 ISO 字符串落盘，导入时还原为 epoch 毫秒；
 * 其余列保持库内原值。这样同一库重复导出只有 manifest.exported_at 会变。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Db } from '../db/connection.js';
import { workspaceStateDir } from '../db/resolver.js';
import { ApiError } from '../errors.js';
import { vacuumInto } from './dbMigration.js';

/** 快照格式版本：manifest.schema_version，导入时严格比对 */
export const SNAPSHOT_SCHEMA_VERSION = 1;
/** 生成器标识：排障用，不参与导入判断 */
export const SNAPSHOT_GENERATOR_VERSION = 'agentboard-server/1';
export const SNAPSHOT_FORMAT = 'agentboard.workspace-snapshot/1';

interface SnapshotTableSpec {
  /** JSONL 文件名（不含扩展名） */
  file: string;
  /** 实际表名（库内为单数命名） */
  table: string;
  /** messages 默认不导出，需 --include-messages */
  optional?: boolean;
}

/**
 * 固定表清单（导出顺序）：与知识页 §5.8.2 对齐，文件用复数名，表用库内单数名。
 * 插入顺序已按外键依赖排好（被引用表在前）；删除时倒序。
 */
const SNAPSHOT_TABLES: readonly SnapshotTableSpec[] = [
  { file: 'issues', table: 'issue' },
  { file: 'issue_comments', table: 'issue_comment' },
  { file: 'issue_dependencies', table: 'issue_dependency' },
  { file: 'issue_git_baseline', table: 'issue_git_baseline' },
  { file: 'issue_draft_audit', table: 'issue_draft_audit' },
  { file: 'workspace_status', table: 'workspace_status' },
  { file: 'workspace_change_log', table: 'workspace_change_log' },
  { file: 'knowledge_pages', table: 'knowledge_page' },
  { file: 'knowledge_revisions', table: 'knowledge_revision' },
  { file: 'knowledge_links', table: 'knowledge_link' },
  { file: 'sessions', table: 'session' },
  { file: 'messages', table: 'message', optional: true },
];

export interface SnapshotFileEntry {
  file: string;
  table: string;
  rows: number;
  sha256: string;
}

export interface SnapshotManifest {
  format: string;
  workspace_id: string;
  schema_version: number;
  exported_at: string;
  generator_version: string;
  source_db: string;
  included_tables: string[];
  files: SnapshotFileEntry[];
}

export interface ExportSnapshotInput {
  db: Db;
  /** 工作区根目录（快照写到 <root>/.agentboard/snapshot） */
  workspacePath: string;
  /** 仅排障：写入 manifest.source_db */
  sourceDbPath?: string;
  includeMessages?: boolean;
}

export interface ExportSnapshotResult {
  dir: string;
  manifest: SnapshotManifest;
}

export interface SnapshotValidation {
  dir: string;
  manifest: SnapshotManifest;
  /** 每个文件的解析结果（导入直接复用，避免二次读盘） */
  rows: Map<string, Array<Record<string, unknown>>>;
}

export interface ImportSnapshotInput {
  db: Db;
  dir: string;
  workspaceId: string;
  workspacePath: string;
  replace?: boolean;
}

export interface ImportSnapshotResult {
  dir: string;
  tables: Array<{ table: string; rows: number }>;
  rows: number;
  backupPath: string | null;
}

interface TableColumnInfo {
  name: string;
  type: string;
  pk: number;
}

interface TableFacts {
  columns: TableColumnInfo[];
  /** 主键列名（按 pk 序号） */
  primaryKey: string[];
}

const isTimeColumn = (column: string): boolean => column === 'ts' || column.endsWith('_at');

/** 导出：时间列 number → ISO；其余原样 */
function exportValue(column: string, value: unknown): unknown {
  if (isTimeColumn(column) && typeof value === 'number') return new Date(value).toISOString();
  return value;
}

/** 导入：时间列 ISO → epoch 毫秒；非时间列/非字符串原样 */
function importValue(column: string, value: unknown): unknown {
  if (!isTimeColumn(column) || typeof value !== 'string') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：列 ${column} 的值不是合法 ISO 时间（${value}）`);
  }
  return ms;
}

function tableFacts(db: Db, table: string): TableFacts {
  const raw = db.pragma(`table_info(${quoteIdent(table)})`) as TableColumnInfo[];
  if (raw.length === 0) {
    throw new ApiError(500, 'SNAPSHOT_SCHEMA_MISSING', `快照导出失败：库中缺少表 ${table}`);
  }
  const primaryKey = raw.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
  return { columns: raw, primaryKey };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function snapshotDirOf(workspacePath: string): string {
  return join(workspaceStateDir(workspacePath), 'snapshot');
}

function fileOf(dir: string, file: string): string {
  return join(dir, `${file}.jsonl`);
}

/** 读清单时拒绝目录逃逸：只认固定表文件名 */
const SPEC_BY_FILE = new Map(SNAPSHOT_TABLES.map(spec => [spec.file, spec]));

function readManifest(dir: string): SnapshotManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：缺少 manifest.json（${path}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest.json 不是合法 JSON（${(error as Error).message}）`);
  }
  const manifest = parsed as Partial<SnapshotManifest>;
  if (manifest.format !== SNAPSHOT_FORMAT) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：format 不支持（${String(manifest.format)}，期望 ${SNAPSHOT_FORMAT}）`);
  }
  if (manifest.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new ApiError(
      422, 'SNAPSHOT_INVALID',
      `快照不可导入：schema_version=${String(manifest.schema_version)}，当前只支持 ${SNAPSHOT_SCHEMA_VERSION}（请用对应版本重新导出）`,
    );
  }
  if (typeof manifest.workspace_id !== 'string' || manifest.workspace_id === '') {
    throw new ApiError(422, 'SNAPSHOT_INVALID', '快照不可导入：manifest.workspace_id 缺失');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.included_tables)) {
    throw new ApiError(422, 'SNAPSHOT_INVALID', '快照不可导入：manifest.files / included_tables 缺失');
  }
  return manifest as SnapshotManifest;
}

function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * 快照自校验/导入前校验：manifest 结构 + 文件哈希 + 行数 + 每行可解析。
 * 任何不符都抛 422 SNAPSHOT_INVALID（明确「不可导入」，不尽量导入）。
 */
export function validateWorkspaceSnapshot(dir: string): SnapshotValidation {
  const manifest = readManifest(dir);
  const required = SNAPSHOT_TABLES.filter(spec => spec.optional !== true);
  const seen = new Set<string>();
  const rows = new Map<string, Array<Record<string, unknown>>>();

  for (const entry of manifest.files) {
    const spec = SPEC_BY_FILE.get(entry.file);
    if (spec === undefined) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest 含未知文件 ${entry.file}`);
    }
    if (seen.has(entry.file)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest 重复登记文件 ${entry.file}`);
    }
    seen.add(entry.file);
    const path = fileOf(dir, entry.file);
    if (!existsSync(path)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：缺少文件 ${entry.file}.jsonl`);
    }
    const content = readFileSync(path, 'utf8');
    const digest = sha256(content);
    if (digest !== entry.sha256) {
      throw new ApiError(
        422, 'SNAPSHOT_INVALID',
        `快照不可导入：${entry.file}.jsonl 哈希不符（manifest ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`,
      );
    }
    const lineCount = countLines(content);
    if (lineCount !== entry.rows) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${entry.file}.jsonl 行数 ${lineCount} 与 manifest ${entry.rows} 不符`);
    }
    const parsed: Array<Record<string, unknown>> = [];
    if (content !== '') {
      const lines = content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const [index, line] of lines.entries()) {
        try {
          const value = JSON.parse(line) as unknown;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是对象');
          parsed.push(value as Record<string, unknown>);
        } catch (error) {
          throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${entry.file}.jsonl 第 ${index + 1} 行不是合法 JSON 对象（${(error as Error).message}）`);
        }
      }
    }
    rows.set(spec.table, parsed);
  }

  for (const spec of required) {
    if (!seen.has(spec.file)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：manifest 缺少必需表 ${spec.file}`);
    }
  }
  for (const table of manifest.included_tables) {
    const spec = SNAPSHOT_TABLES.find(item => item.table === table);
    if (spec === undefined) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：included_tables 含未知表 ${table}`);
    }
    if (!seen.has(spec.file)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：included_tables 声明了 ${table}，但 files 未登记`);
    }
  }
  return { dir, manifest, rows };
}

/** 单读事务内取全表行（保证跨表同一时间点），按主键升序保证确定性 */
function readSnapshotRows(
  db: Db,
  specs: readonly SnapshotTableSpec[],
): Array<{ spec: SnapshotTableSpec; content: string; rows: number }> {
  return db.transaction(() => specs.map(spec => {
    const facts = tableFacts(db, spec.table);
    const columns = facts.columns.map(column => quoteIdent(column.name)).join(', ');
    const order = facts.primaryKey.length > 0
      ? ` ORDER BY ${facts.primaryKey.map(quoteIdent).join(', ')}`
      : ' ORDER BY rowid';
    const rawRows = db.prepare(`SELECT ${columns} FROM ${quoteIdent(spec.table)}${order}`).all() as Array<Record<string, unknown>>;
    const lines = rawRows.map(row => {
      const out: Record<string, unknown> = {};
      for (const column of facts.columns) out[column.name] = exportValue(column.name, row[column.name]);
      return JSON.stringify(out);
    });
    return { spec, content: lines.length === 0 ? '' : `${lines.join('\n')}\n`, rows: lines.length };
  }))();
}

function buildManifest(
  workspaceId: string,
  sourceDb: string,
  entries: SnapshotFileEntry[],
  exportedAt: string,
): SnapshotManifest {
  return {
    format: SNAPSHOT_FORMAT,
    workspace_id: workspaceId,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    exported_at: exportedAt,
    generator_version: SNAPSHOT_GENERATOR_VERSION,
    source_db: sourceDb,
    included_tables: entries.map(entry => entry.table),
    files: entries,
  };
}

/** 临时目录写全量文件后整体 rename 覆盖 snapshot/；失败时旧快照原样保留 */
function writeSnapshotAtomically(dir: string, files: Array<{ name: string; content: string }>): void {
  const parent = resolve(dir, '..');
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.snapshot-tmp-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  const backup = join(parent, `.snapshot-old-${randomUUID()}`);
  let movedOld = false;
  try {
    for (const file of files) writeFileSync(join(tmp, file.name), file.content, 'utf8');
    if (existsSync(dir)) {
      renameSync(dir, backup);
      movedOld = true;
    }
    renameSync(tmp, dir);
  } catch (error) {
    // 覆盖失败：把旧快照挪回原位，临时目录清掉
    if (movedOld && !existsSync(dir) && existsSync(backup)) renameSync(backup, dir);
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  if (movedOld) rmSync(backup, { recursive: true, force: true });
}

export function exportWorkspaceSnapshot(input: ExportSnapshotInput): ExportSnapshotResult {
  const specs = SNAPSHOT_TABLES.filter(spec => spec.optional !== true || input.includeMessages === true);
  const workspaceIdRow = input.db.prepare("SELECT value FROM meta WHERE key='workspace_id'").get() as
    | { value: string }
    | undefined;
  const workspaceId = workspaceIdRow?.value ?? null;
  if (workspaceId === null) {
    throw new ApiError(409, 'SNAPSHOT_NOT_LOCALIZED', '快照导出失败：目标库不是工作区库（meta.workspace_id 缺失），先 kb workspace-db enable');
  }
  const exportedAt = new Date().toISOString();
  const tables = readSnapshotRows(input.db, specs);
  const entries: SnapshotFileEntry[] = tables.map(({ spec, content, rows }) => ({
    file: spec.file,
    table: spec.table,
    rows,
    sha256: sha256(content),
  }));
  const manifest = buildManifest(workspaceId, input.sourceDbPath ?? input.db.name, entries, exportedAt);
  const dir = snapshotDirOf(input.workspacePath);
  writeSnapshotAtomically(dir, [
    ...tables.map(({ spec, content }) => ({ name: `${spec.file}.jsonl`, content })),
    { name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ]);
  // 自校验：回读行数与哈希，不符即失败（旧快照已被新内容替换，此时宁可报错也不静默）
  const checked = validateWorkspaceSnapshot(dir);
  if (checked.manifest.files.length !== manifest.files.length) {
    throw new ApiError(500, 'SNAPSHOT_SELF_CHECK_FAILED', '快照自校验失败：文件数与 manifest 不一致');
  }
  return { dir, manifest };
}

function countTable(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
  return row.n;
}

/** --replace 清理：knowledge_revision 的不可变触发器会拦截 DELETE，先摘后复原；FTS 影子表单独清空 */
function clearSnapshotTables(db: Db, tables: readonly SnapshotTableSpec[]): void {
  const triggers = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='knowledge_revision'",
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)}`);
  try {
    const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_fts'").get() !== undefined;
    if (hasFts) db.exec('DELETE FROM knowledge_fts');
    for (const spec of [...tables].reverse()) db.exec(`DELETE FROM ${quoteIdent(spec.table)}`);
  } finally {
    for (const trigger of triggers) if (trigger.sql !== null) db.exec(trigger.sql);
  }
}

function insertRows(
  db: Db,
  spec: SnapshotTableSpec,
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) return;
  const facts = tableFacts(db, spec.table);
  const known = new Set(facts.columns.map(column => column.name));
  const columns = Object.keys(rows[0]!);
  for (const column of columns) {
    if (!known.has(column)) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${spec.file}.jsonl 含目标库不存在的列 ${column}`);
    }
  }
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length || keys.some((key, index) => key !== columns[index])) {
      throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${spec.file}.jsonl 各行字段不一致`);
    }
  }
  const sql = `INSERT INTO ${quoteIdent(spec.table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const statement = db.prepare(sql);
  for (const row of rows) {
    try {
      statement.run(...columns.map(column => importValue(column, row[column])));
    } catch (error) {
      // 外键在插入时就会拦下断链（foreign_keys = ON），这里补表名与原因，避免用户只看到 SQLITE_CONSTRAINT
      throw new ApiError(
        422, 'SNAPSHOT_INVALID',
        `快照不可导入：${spec.file}.jsonl 写入 ${spec.table} 失败（${(error as Error).message}），快照内部引用不完整`,
      );
    }
  }
}

/**
 * 导入：只允许同 workspace_id 的空工作区库；--replace 先 VACUUM INTO 备份再覆盖。
 * 事务内完成插入 + foreign_key_check + 行数比对；任一失败整体回滚。
 */
export function importWorkspaceSnapshot(input: ImportSnapshotInput): ImportSnapshotResult {
  const validated = validateWorkspaceSnapshot(input.dir);
  const { manifest } = validated;
  if (manifest.workspace_id !== input.workspaceId) {
    throw new ApiError(
      422, 'SNAPSHOT_WORKSPACE_MISMATCH',
      `快照不可导入：manifest.workspace_id=${manifest.workspace_id} 与目标工作区 ${input.workspaceId} 不一致（本版本不做跨工作区 id 重映射）`,
    );
  }

  const includedTables = SNAPSHOT_TABLES.filter(spec => validated.rows.has(spec.table));
  const nonEmpty = includedTables
    .filter(spec => spec.table !== 'workspace_status')
    .map(spec => ({ table: spec.table, rows: countTable(input.db, spec.table) }))
    .filter(item => item.rows > 0);
  if (nonEmpty.length > 0 && input.replace !== true) {
    throw new ApiError(
      409, 'SNAPSHOT_TARGET_NOT_EMPTY',
      `目标工作区库非空（${nonEmpty.map(item => `${item.table} ${item.rows} 行`).join('、')}）：只允许导入到空库；确认覆盖请加 --replace（会先 VACUUM INTO 备份）`,
    );
  }

  let backupPath: string | null = null;
  if (input.replace === true && nonEmpty.length > 0) {
    const backupDir = join(workspaceStateDir(input.workspacePath), 'backup');
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `snapshot-import-${Date.now()}.db`);
    vacuumInto(input.db, backupPath);
  }

  const imported: Array<{ table: string; rows: number }> = [];
  input.db.exec('BEGIN IMMEDIATE');
  try {
    // 状态字典是派生物（enable 时会预置内置状态）：无论空库/覆盖都先清掉，避免主键冲突
    input.db.exec('DELETE FROM workspace_status');
    if (input.replace === true && nonEmpty.length > 0) clearSnapshotTables(input.db, includedTables);
    for (const spec of includedTables) {
      const rows = validated.rows.get(spec.table) ?? [];
      insertRows(input.db, spec, rows);
      imported.push({ table: spec.table, rows: rows.length });
    }
    const violations = input.db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    if (violations.length > 0) {
      const first = violations[0]!;
      throw new ApiError(
        422, 'SNAPSHOT_INVALID',
        `快照不可导入：外键校验不通过（${String(first['table'])} 行 ${String(first['rowid'])} → ${String(first['parent'])}），快照内部引用不完整`,
      );
    }
    for (const item of imported) {
      const actual = countTable(input.db, item.table);
      if (actual !== item.rows) {
        throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${item.table} 导入后行数 ${actual} 与快照 ${item.rows} 不符`);
      }
    }
    input.db.exec('COMMIT');
  } catch (error) {
    try { input.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'SNAPSHOT_INVALID', `快照不可导入：${(error as Error).message}`);
  }

  return {
    dir: input.dir,
    tables: imported,
    rows: imported.reduce((sum, item) => sum + item.rows, 0),
    backupPath,
  };
}

/** 把用户给的目录收敛到工作区内（CLI --file 只允许仓库内路径），缺省 <root>/.agentboard/snapshot */
export function resolveSnapshotDir(workspacePath: string, requested?: string): string {
  const root = resolve(workspacePath);
  const dir = requested === undefined ? snapshotDirOf(workspacePath) : resolve(root, requested);
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
    throw new ApiError(400, 'SNAPSHOT_PATH_OUTSIDE_WORKSPACE', `快照目录必须位于工作区内（${root}），拒绝 ${dir}`);
  }
  return dir;
}
