/**
 * P2-01（方向 B §7.3 / M12）：知识文件 reconcile——默认只读报告，`--fix` 只修可判定项。
 *
 * 报告项（§7.3 启动 reconcile 口径）：
 * - front matter 必填/类型（含解析失败）
 * - 文件名 vs slug 不一致（未走 rename 命令直接改文件名）
 * - id 重复（两个文件同一 uuid）
 * - content_hash 不符（外部编辑）
 * - `[[...]]` 目标缺失（unresolved；跨目录解析后仍缺失才报）
 * - 残留 tmp / lock（崩溃残留；lock 持有者已死）
 *
 * `fix` 只做三件事：删残留 tmp、删持有者已死的 lock、删除 .index.json 触发下次请求重建。
 * **绝不自动改写正文、不批量改 wikilink、不修 front matter**（M12 红线，冲突由人裁决）。
 * revision 倒退不可判定（文件层无历史），不在报告内——旧库只读保留由 P2-02 的 export-legacy
 * manifest 兜底比对。
 */
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { docFileNameFor, normalizeDocSlug } from '@agentboard/shared';
import { isProcessAlive } from '../services/serverLock.js';
import { LOCKS_DIR_NAME, assertInsideDocsDir, indexPathFor, lockPathFor } from './paths.js';
import type { DocsIndex } from './index.js';

export interface ReconcileIssue {
  fileName: string;
  kind: 'front_matter' | 'file_name_mismatch' | 'duplicate_id' | 'content_hash' | 'missing_link_target';
  detail: string;
  /** K3：可操作建议（排障入口；只给方向，不自动执行） */
  suggestion?: string;
}

export interface ReconcileReport {
  docsDir: string;
  total_files: number;
  valid_files: number;
  issues: ReconcileIssue[];
  stale_tmp: string[];
  stale_locks: string[];
  index_rebuilt: boolean;
  fixed: string[];
}

/**
 * K3：按 issue 文案给出可操作建议。区分本批次实测到的几类坏因，
 * 避免「content_hash 不符」只有一个笼统说法、排障时无从下手。
 */
function suggestionFor(issue: string): string {
  if (issue.startsWith('content_hash')) {
    return '正文或 front matter 被外部改动：走 API/CLI 重新写入修订即可重算 hash；若正文含 CRLF 应改用 cmd 重定向或已修好的 stdin 通道重写';
  }
  if (issue.startsWith('front matter: missing_field') || issue.startsWith('front matter: bad_type')) {
    return 'front matter 字段缺失或类型不符：核对 19 个必填字段与固定顺序（含 content_hash 必须 64 位 hex 字符串）';
  }
  if (issue.startsWith('front matter')) {
    return 'front matter 无法解析：按知识文件契约逐行核对（只支持受限 YAML 子集，不支持块标量/多行缩进）';
  }
  if (issue.startsWith('scope:') || issue.startsWith('workspace_id:')) {
    return '目录与 front matter 身份不符：页被移动/复制到别的 Docs 目录，改回原目录或修正 front matter 的 scope/workspace_id';
  }
  if (issue.startsWith('读取失败')) {
    return '文件不可读：检查编码（UTF-8 无 BOM）与文件权限';
  }
  return '见 detail 的原始报告';
}

/** 残留 tmp 文件：`*.md.tmp-*` */
function listStaleTmp(docsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(docsDir);
  } catch {
    return [];
  }
  return names.filter(name => name.endsWith('.md') === false && /\.tmp-/.test(name));
}

/** 残留 lock：持有者 pid 已死的锁文件 */
function listStaleLocks(docsDir: string): string[] {
  const lockDir = join(docsDir, LOCKS_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(lockDir);
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const path = join(lockDir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
      if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) stale.push(name);
    } catch {
      stale.push(name); // 损坏锁视为陈旧
    }
  }
  return stale;
}

export function reconcileDocsDir(index: DocsIndex, options: { fix?: boolean; cross?: DocsIndex | null } = {}): ReconcileReport {
  index.ensureFresh();
  const docsDir = index.docsDir;
  const entries = index.allEntries();
  const invalid = index.allInvalid();
  const issues: ReconcileIssue[] = [];
  const fixed: string[] = [];

  for (const file of invalid) {
    const detail = file.issues.join('；');
    // K3：按问题种类分流——hash 不符与 front matter 形变是不同故障，报告里分开列，排障才能对号入座
    const hasHash = file.issues.some(issue => issue.startsWith('content_hash'));
    const first = file.issues[0] ?? '';
    if (hasHash) {
      issues.push({ fileName: file.fileName, kind: 'content_hash', detail, suggestion: suggestionFor('content_hash') });
    } else {
      issues.push({ fileName: file.fileName, kind: 'front_matter', detail, suggestion: suggestionFor(first) });
    }
  }

  const byId = new Map<string, string>();
  for (const entry of entries) {
    const meta = entry.meta;
    if (docFileNameFor(meta.slug) !== entry.fileName) {
      issues.push({ fileName: entry.fileName, kind: 'file_name_mismatch', detail: `slug「${meta.slug}」应落文件 ${docFileNameFor(meta.slug)}` });
    }
    const dup = byId.get(meta.id);
    if (dup !== undefined) {
      issues.push({ fileName: entry.fileName, kind: 'duplicate_id', detail: `id ${meta.id} 与 ${dup} 重复` });
    } else {
      byId.set(meta.id, entry.fileName);
    }
    if (entry.issues.some(issue => issue.startsWith('content_hash'))) {
      issues.push({
        fileName: entry.fileName,
        kind: 'content_hash',
        detail: 'content_hash 与文档不符（外部编辑）',
        suggestion: suggestionFor('content_hash'),
      });
    }
  }

  // [[...]] 目标缺失：跨目录解析后仍未命中（active 页）
  const { unresolved } = index.resolveLinks(options.cross ?? null);
  const seenUnresolved = new Set<string>();
  for (const item of unresolved) {
    if (seenUnresolved.has(item.raw_target)) continue;
    seenUnresolved.add(item.raw_target);
    const sourceEntry = entries.find(entry => entry.meta.id === item.source);
    if (sourceEntry !== undefined) {
      issues.push({ fileName: sourceEntry.fileName, kind: 'missing_link_target', detail: `[[${item.raw_target}]] 无对应文件` });
    }
  }

  const staleTmp = listStaleTmp(docsDir);
  const staleLocks = listStaleLocks(docsDir);

  let indexRebuilt = false;
  if (options.fix === true) {
    for (const name of staleTmp) {
      const path = join(docsDir, name);
      try { assertInsideDocsDir(docsDir, path); unlinkSync(path); fixed.push(`删除残留 tmp: ${name}`); } catch { /* 保留，人工处理 */ }
    }
    for (const name of staleLocks) {
      const path = lockPathFor(docsDir, normalizeDocSlug(name.replace(/\.lock$/, '')));
      try { rmSync(path, { force: true }); fixed.push(`删除陈旧 lock: ${name}`); } catch { /* 保留 */ }
    }
    const indexFile = indexPathFor(docsDir);
    if (existsSync(indexFile)) {
      try { rmSync(indexFile, { force: true }); fixed.push('删除 .index.json（下次请求重建）'); } catch { /* 保留 */ }
    }
    indexRebuilt = true;
    index.ensureFresh();
  }

  return {
    docsDir,
    total_files: entries.length + invalid.length,
    valid_files: entries.length,
    issues,
    stale_tmp: staleTmp,
    stale_locks: staleLocks,
    index_rebuilt: indexRebuilt,
    fixed,
  };
}
