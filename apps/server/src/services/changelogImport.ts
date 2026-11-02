/**
 * LOG01｜旧 `Docs/CHANGELOG.md` 导入服务（设计 §8），供 LOG02 的 CLI/自动化复用。
 * - `previewLegacyChangelog` 只读：解析 `## [YYYY-MM-DD] 标题` 条目、计算源 SHA-256、分类新增/已导入/不一致，无副作用；
 * - `applyLegacyChangelog` 必须绑定预览 SHA，应用前重新读取并计算；不可解析或内容不一致一律拒绝；
 * - 日志行与导入回执在同一事务提交，任何一条失败整体回滚；相同 SHA 重放幂等（不产生重复行）。
 * 路径限制：源文件必须位于所选工作区目录之内，避免越界读取其他项目。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { createChangeLog } from '../db/repos/workspaceChangeLog.js';
import { getWorkspace } from '../db/repos/workspace.js';

export interface LegacyChangelogEntry {
  source_key: string;
  occurred_at: number;
  title: string;
  body_md: string;
}

export interface LegacyChangelogUnparsable {
  line: number;
  text: string;
}

export interface LegacyChangelogPreview {
  workspace_id: string;
  source_path: string;
  source_sha256: string;
  entry_count: number;
  parsed: LegacyChangelogEntry[];
  unparsable: LegacyChangelogUnparsable[];
  added: LegacyChangelogEntry[];
  already_imported: LegacyChangelogEntry[];
  conflicting: LegacyChangelogEntry[];
}

export interface LegacyChangelogApplyResult {
  imported: number;
  receipt_id: string;
  source_sha256: string;
}

/** 退役前只读复核结论：can_retire 只是结论，调用方不得据此删除/移动源文件 */
export interface LegacyChangelogRetireVerdict {
  can_retire: boolean;
  reason: string;
  source_sha256: string;
  receipt: { id: string; entry_count: number; imported_at: number } | null;
  entry_count: number;
  added: LegacyChangelogEntry[];
  already_imported: LegacyChangelogEntry[];
  conflicting: LegacyChangelogEntry[];
  unparsable: LegacyChangelogUnparsable[];
}

const HEADING = /^##[ \t]+\[(\d{4})-(\d{2})-(\d{2})\][ \t]+(\S.*)$/;

/** 解析安全路径：必须真实存在于所选工作区目录内 */
function resolveSourcePath(workspacePath: string, sourcePath: string): { absolute: string; key: string } {
  let workspaceRoot: string;
  let absolute: string;
  try {
    workspaceRoot = realpathSync(workspacePath);
    absolute = realpathSync(resolve(sourcePath));
  } catch {
    throw new ValidationError(`源文件不存在或不可读: ${sourcePath}`);
  }
  if (!statSync(absolute).isFile()) throw new ValidationError(`源路径不是文件: ${sourcePath}`);
  const rel = relative(workspaceRoot, absolute);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new ValidationError('源文件必须位于所选工作空间目录内');
  }
  return { absolute, key: resolve(absolute) };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function entryKey(fileSha: string, index: number, occurredAt: number, title: string): string {
  return createHash('sha256').update(`${fileSha}\n${index}\n${occurredAt}\n${title}`).digest('hex');
}

/** 解析 Markdown 条目：`## [YYYY-MM-DD] 标题` + 其下正文；无法判定的内容进 unparsable，不静默丢弃 */
export function parseLegacyChangelog(
  text: string,
  fileSha: string,
): { entries: LegacyChangelogEntry[]; unparsable: LegacyChangelogUnparsable[] } {
  const lines = text.split(/\r?\n/);
  const entries: LegacyChangelogEntry[] = [];
  const unparsable: LegacyChangelogUnparsable[] = [];
  let current: { title: string; occurredAt: number; body: string[] } | null = null;
  let sawEntry = false;

  const flush = (): void => {
    if (current === null) return;
    const body = current.body.join('\n').replace(/\s+$/, '');
    if (body === '') {
      unparsable.push({ line: 0, text: `条目缺少正文: ${current.title}` });
    } else {
      entries.push({
        source_key: entryKey(fileSha, entries.length, current.occurredAt, current.title),
        occurred_at: current.occurredAt,
        title: current.title,
        body_md: body,
      });
    }
    current = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    const match = HEADING.exec(line);
    if (match) {
      const date = `${match[1]}-${match[2]}-${match[3]}`;
      const occurredAt = Date.parse(`${date}T00:00:00.000Z`);
      if (Number.isNaN(occurredAt)) {
        flush();
        unparsable.push({ line: index + 1, text: line });
        return;
      }
      flush();
      sawEntry = true;
      current = { title: match[4]!.trim(), occurredAt, body: [] };
      return;
    }
    if (/^##[ \t]+\[/.test(line)) {
      flush();
      unparsable.push({ line: index + 1, text: line });
      return;
    }
    if (current !== null) {
      current.body.push(raw);
      return;
    }
    // 首个条目前的说明性内容：一级标题与空行忽略，其余视为无法归属的内容
    if (line === '' || /^#[^#]/.test(line)) return;
    if (!sawEntry) unparsable.push({ line: index + 1, text: line });
  });
  flush();
  return { entries, unparsable };
}

export function previewLegacyChangelog(db: Db, input: { workspace_id: string; source_path: string }): LegacyChangelogPreview {
  const workspace = getWorkspace(db, input.workspace_id);
  if (!workspace) throw new NotFoundError('工作空间不存在');
  const source = resolveSourcePath(workspace.path, input.source_path);
  const buffer = readFileSync(source.absolute);
  const fileSha = sha256(buffer);
  const { entries, unparsable } = parseLegacyChangelog(buffer.toString('utf8'), fileSha);

  const existingByKey = new Map<string, { title: string; body_md: string; occurred_at: number }>();
  const lookup = db.prepare('SELECT title,body_md,occurred_at FROM workspace_change_log WHERE legacy_source_key=?');
  for (const entry of entries) {
    const row = lookup.get(entry.source_key) as { title: string; body_md: string; occurred_at: number } | undefined;
    if (row) existingByKey.set(entry.source_key, row);
  }

  const added: LegacyChangelogEntry[] = [];
  const alreadyImported: LegacyChangelogEntry[] = [];
  const conflicting: LegacyChangelogEntry[] = [];
  for (const entry of entries) {
    const row = existingByKey.get(entry.source_key);
    if (!row) added.push(entry);
    else if (row.title === entry.title && row.body_md === entry.body_md && row.occurred_at === entry.occurred_at) alreadyImported.push(entry);
    else conflicting.push(entry);
  }

  return {
    workspace_id: workspace.id,
    source_path: source.key,
    source_sha256: fileSha,
    entry_count: entries.length,
    parsed: entries,
    unparsable,
    added,
    already_imported: alreadyImported,
    conflicting,
  };
}

export function applyLegacyChangelog(
  db: Db,
  input: { workspace_id: string; source_path: string; preview_sha256: string; actor: string },
): LegacyChangelogApplyResult {
  const workspace = getWorkspace(db, input.workspace_id);
  if (!workspace) throw new NotFoundError('工作空间不存在');
  const preview = previewLegacyChangelog(db, { workspace_id: input.workspace_id, source_path: input.source_path });
  if (preview.source_sha256 !== input.preview_sha256) {
    throw new ApiError(409, 'CHANGELOG_SOURCE_CHANGED', '源文件已变化，请重新预览后再应用', { source_sha256: preview.source_sha256 });
  }
  if (preview.unparsable.length > 0) {
    throw new ApiError(409, 'CHANGELOG_PARSE_FAILED', `存在 ${preview.unparsable.length} 处无法解析的内容，修正后重新预览`, {
      unparsable: preview.unparsable,
    });
  }
  if (preview.conflicting.length > 0) {
    throw new ApiError(409, 'CHANGELOG_IMPORT_CONFLICT', `存在 ${preview.conflicting.length} 条与已导入内容不一致的记录，需先对账`, {
      conflicting: preview.conflicting.map((entry) => entry.title),
    });
  }

  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT id FROM workspace_change_log_import WHERE source_path=? AND origin_workspace_id=? AND source_sha256=?')
        .get(preview.source_path, workspace.id, preview.source_sha256) as { id: string } | undefined;
      if (existing) return { imported: 0, receipt_id: existing.id, source_sha256: preview.source_sha256 };

      for (const entry of preview.added) {
        createChangeLog(db, workspace, {
          title: entry.title,
          body_md: entry.body_md,
          change_type: '历史',
          occurred_at: entry.occurred_at,
          actor: input.actor,
          legacy_source_key: entry.source_key,
        });
      }
      const receiptId = randomUUID();
      db.prepare(
        'INSERT INTO workspace_change_log_import (id,source_path,origin_workspace_id,source_sha256,entry_count,imported_at) VALUES (?,?,?,?,?,?)',
      ).run(receiptId, preview.source_path, workspace.id, preview.source_sha256, preview.entry_count, Date.now());
      return { imported: preview.added.length, receipt_id: receiptId, source_sha256: preview.source_sha256 };
    })
    .immediate();
}

/**
 * 退役前只读复核（LOG02）：重新 hash 当前源文件并对照成功导入回执。
 * 只返回结论与差异明细；**不删除、不移动、不改写**源文件，也不写库。
 * 判定顺序：无法解析 → 无匹配回执 → 内容不一致 → 仍有未导入条目 → 回执条目数不符 → 可退役。
 */
export function verifyLegacyChangelogRetire(
  db: Db,
  input: { workspace_id: string; source_path: string },
): LegacyChangelogRetireVerdict {
  const preview = previewLegacyChangelog(db, { workspace_id: input.workspace_id, source_path: input.source_path });
  const row = db
    .prepare('SELECT id,entry_count,imported_at FROM workspace_change_log_import WHERE source_path=? AND origin_workspace_id=? AND source_sha256=?')
    .get(preview.source_path, input.workspace_id, preview.source_sha256) as
    | { id: string; entry_count: number; imported_at: number }
    | undefined;
  const base = {
    source_sha256: preview.source_sha256,
    receipt: row ?? null,
    entry_count: preview.entry_count,
    added: preview.added,
    already_imported: preview.already_imported,
    conflicting: preview.conflicting,
    unparsable: preview.unparsable,
  };

  if (preview.unparsable.length > 0) {
    return { can_retire: false, reason: `存在 ${preview.unparsable.length} 处无法解析的内容`, ...base };
  }
  if (!row) {
    return { can_retire: false, reason: '未找到与该源文件 SHA-256 匹配的成功导入回执，需重新预览并应用', ...base };
  }
  if (preview.conflicting.length > 0) {
    return { can_retire: false, reason: `存在 ${preview.conflicting.length} 条内容与已导入记录不一致，需先对账`, ...base };
  }
  if (preview.added.length > 0) {
    return { can_retire: false, reason: `仍有 ${preview.added.length} 条条目未导入`, ...base };
  }
  if (row.entry_count !== preview.entry_count) {
    return { can_retire: false, reason: `导入回执条目数 ${row.entry_count} 与当前源文件条目数 ${preview.entry_count} 不一致`, ...base };
  }
  return { can_retire: true, reason: '源文件 SHA-256 与成功导入回执一致，全部条目已完成对账', ...base };
}
