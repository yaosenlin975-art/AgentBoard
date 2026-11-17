/**
 * P2-02（方向 B §7.7 / M12 / C8 / US-7）：一次性迁移命令 export-legacy 的服务端。
 *
 * 把旧库知识页（knowledge_page JOIN 当前 revision 的 sources_json/evidence_json）一次性导出为
 * 文件事实源 `Docs/*.md`：
 * - **fan-out 数据源（C8 混合态最大的丢页风险点）**：中心库（common 页 + 未下沉工作区的
 *   scope=workspace 页）+ 每个 db_mode=localized 的工作区库（复用 resolver 的 listWorkspaceDbs 注入）
 *   ——枚举的是**全部源库行集**，不用 snapshot/knowledge/ 下的不完整快照；
 * - 目标布局（§7.2）：scope=common → `~/.agentboard/Docs`（可注入覆盖）；scope=workspace →
 *   该工作区 `<工作区>/.agentboard/Docs`（注册表 path 推导）；`--to <dir>` 重定向输出根：
 *   common → `<dir>/Docs`、工作区 → `<dir>/ws-<workspace_id>/Docs`；
 * - front matter 复用 P2-01 契约（@agentboard/shared knowledgeFile + knowledge/frontMatter），
 *   正文原样落盘（回读逐字节一致，零丢失红线）；文件名 = docFileNameFor(slug)；
 * - 幂等：同内容目标文件跳过不重写；冲突（已存在且内容不同）→ **暂停不静默覆盖**：冲突文件
 *   先备份到 `<Docs>/.export-backup/<run>/` 再整体 409（一个都不写入）；
 * - 写后回读校验：逐文件 sha256 + parse 回读，正文与 front matter 字段逐项与源行比对；
 * - manifest（sha256，参考 centerSnapshot/workspaceSnapshot 口径）：`<Docs>/.export-manifest.json`；
 * - 旧库只读保留：只 SELECT，不 DROP 表、不删行、不 UPDATE。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { docFileNameFor, normalizeBodyMd, parseKnowledgeDocument, validateKnowledgeFileMeta, type KnowledgeFileMeta } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, ValidationError } from '../errors.js';
import { KnowledgeErrorCode } from './knowledgeCodes.js';
import { zhZodIssue } from './zod.js';
import { listLegacyKnowledgeRows, type LegacyKnowledgeRow } from '../db/repos/knowledge.js';
import { renderDocWithHash, computeContentHash } from '../knowledge/frontMatter.js';
import { resolveDocsDir, type DocsDirOverrides } from '../knowledge/paths.js';

export const KNOWLEDGE_EXPORT_FORMAT = 'agentboard.knowledge-export/1';
export const KNOWLEDGE_EXPORT_SCHEMA_VERSION = 1;
export const KNOWLEDGE_EXPORT_GENERATOR = 'agentboard-server/1';
/** manifest / 备份都是点前缀（scanner 只认顶层非点 `*.md`，不污染索引与 reconcile） */
export const EXPORT_MANIFEST_NAME = '.export-manifest.json';
export const EXPORT_BACKUP_DIR_NAME = '.export-backup';
/**
 * 事件循环让出粒度（页）。写入阶段每页含 write+fsync+read，单页就够重；
 * 取 32 是「不让 HTTP 等超过一个 fsync 周期」与「让出开销可忽略」的折中。
 */
const YIELD_EVERY = 32;

export interface KnowledgeExportRouterOptions {
  /** 中心库（legacy 行集来源之一 + 工作区注册表） */
  db: Db;
  /** 全部 db_mode=localized 的工作区库（生产由 routes.ts 用 resolver 装配；单个打不开已被装配层跳过） */
  listWorkspaceDbs: () => Db[];
  /** 工作区注册表（workspace_id → path；未注册/无 path 返回 null，该区页跳过并点名） */
  getWorkspaceRow?: (workspaceId: string) => { id: string; path: string } | null;
  /** Docs 目录覆盖（仅测试注入临时目录） */
  docsPaths?: DocsDirOverrides;
}

const exportSchema = z.object({
  scope: z.enum(['all', 'center', 'workspace']).default('all'),
  workspace_id: z.string().max(64).optional(),
  dry_run: z.boolean().default(false),
  to: z.string().min(1).max(1000).optional(),
}).strict();

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError(result.error.issues.map(issue => zhZodIssue(issue)).join('; '));
  return result.data;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 原子替换写：tmp（同目录）→ fsync → renameSync（与 knowledge/fileRepo 同口径） */
function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/** 只在内容变化时写（重复跑字节不变 → 文件不动，幂等） */
function atomicWriteIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) return false;
  atomicWrite(filePath, content);
  return true;
}

// ---- 报告形状（CLI --json 直接透出） ----

export type ExportPageAction = 'create' | 'skip-unchanged' | 'conflict' | 'skip-deleted' | 'skip-invalid' | 'skip-duplicate';

export interface ExportPageEntry {
  id: string;
  slug: string;
  title: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  status: string;
  revision: number;
  source_db: string;
  target_dir: string;
  file: string;
  action: ExportPageAction;
  reason?: string;
}

export interface ExportSourceEntry {
  source_db: string;
  path: string | null;
  pages: number;
}

export interface ExportTargetEntry {
  dir: string;
  create: number;
  unchanged: number;
  conflicts: number;
  skipped: number;
}

export interface ExportConflictEntry {
  dir: string;
  file: string;
  page_id: string;
  source_db: string;
  existing_sha256: string;
  incoming_sha256: string;
  backup_path?: string;
}

export interface ExportReport {
  format: string;
  dry_run: boolean;
  scope: 'all' | 'center' | 'workspace';
  workspace_id: string | null;
  exported_at: string;
  sources: ExportSourceEntry[];
  targets: ExportTargetEntry[];
  pages: ExportPageEntry[];
  conflicts: ExportConflictEntry[];
  manifests: Array<{ dir: string; file: string; files: number; written: boolean }>;
  summary: { total: number; create: number; unchanged: number; conflicts: number; skipped: number };
}

interface PlannedPage {
  row: LegacyKnowledgeRow;
  sourceDb: string;
  meta: KnowledgeFileMeta;
  targetDir: string;
  fileName: string;
  action: ExportPageAction;
  reason?: string;
  /** 目标文件当前内容 sha256（conflict 时用于备份与报告） */
  existingSha256: string | null;
}

/** 旧库行 → 文件契约 meta（原值保真：category/landed/domain 缺失按契约缺省，不改写业务值） */
function metaOf(row: LegacyKnowledgeRow): KnowledgeFileMeta {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    revision: row.revision,
    scope: row.scope,
    workspace_id: row.workspace_id,
    status: row.status === 'archived' ? 'archived' : 'active',
    domain: row.domain ?? '',
    category: (row.category ?? 'legacy') as KnowledgeFileMeta['category'],
    landed: (row.landed ?? null) as KnowledgeFileMeta['landed'],
    sources: row.sources,
    evidence: row.evidence,
    content_hash: '',
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by ?? '',
    updated_by: row.updated_by ?? '',
    change_note: row.change_note ?? '',
  };
}

/** 契约校验（含 slug 归一可落盘）：不过 → skip-invalid（点名原因，不静默丢） */
function metaIssues(meta: KnowledgeFileMeta): string[] {
  const issues: string[] = [];
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(meta.slug) || meta.slug.split('/').includes('..')) {
    issues.push(`slug 格式不合法（${meta.slug}）`);
  }
  const structural = validateKnowledgeFileMeta({ ...meta, content_hash: '0'.repeat(64) } as unknown as Record<string, unknown>);
  if (structural !== null) issues.push(`${structural.field}: ${structural.issue}`);
  return issues;
}

export function createKnowledgeExportRouter(options: KnowledgeExportRouterOptions): Router {
  const router = Router();
  const getWorkspaceRow = options.getWorkspaceRow ?? ((): null => null);

  /**
   * export-legacy：一次性迁移。
   *
   * 性能（OCR C1）：整个处理器此前**没有一处 await**，2000 页 ×（write+fsync+read+parse）
   * ≈ 4–20 s 事件循环完全停摆，期间所有 HTTP 请求挂起。现在写盘阶段每 `YIELD_EVERY` 页
   * `await setImmediate` 让出一次；索引/计划阶段是纯 CPU，同样按批让出。
   */
  router.post('/export-legacy', async (req, res) => {
    const yes = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };
    const body = parseBody(exportSchema, req.body ?? {});
    if (body.scope === 'workspace' && (body.workspace_id === undefined || body.workspace_id === '')) {
      throw new ValidationError('--scope workspace 必须提供 workspace_id');
    }
    if (body.scope !== 'workspace' && body.workspace_id !== undefined) {
      throw new ValidationError('workspace_id 只在 --scope workspace 时接受');
    }
    const toDir = body.to !== undefined ? resolvePath(body.to) : null;
    const exportedAt = new Date().toISOString();

    // ---- 1) fan-out 枚举源库行集（localized 工作区库先入册；center 后到，同 id 去重防 C8 双写） ----
    const sources: ExportSourceEntry[] = [];
    const byId = new Map<string, { row: LegacyKnowledgeRow; sourceDb: string }>();
    let duplicates = 0;
    const collect = (db: Db, sourceDb: string): number => {
      let rows: LegacyKnowledgeRow[] = [];
      let dbPath: string | null = typeof db.name === 'string' && db.name !== '' ? db.name : null;
      try {
        rows = listLegacyKnowledgeRows(db);
      } catch (error) {
        throw new ApiError(500, 'KNOWLEDGE_EXPORT_SOURCE_FAILED', `读取源库 ${sourceDb} 的知识页行集失败：${error instanceof Error ? error.message : String(error)}`);
      }
      for (const row of rows) {
        if (byId.has(row.id)) { duplicates += 1; continue; }
        byId.set(row.id, { row, sourceDb });
      }
      sources.push({ source_db: sourceDb, path: dbPath, pages: rows.length });
      return rows.length;
    };
    const includeWorkspaces = body.scope !== 'center';
    const wsDbs = includeWorkspaces ? options.listWorkspaceDbs() : [];
    wsDbs.forEach((db, index) => collect(db, `workspace#${index + 1}`));
    // 中心库：all/center 全量；scope=workspace 只取该工作区未下沉的行（C8 混合态中心残留）
    const centerRowsRaw = listLegacyKnowledgeRows(options.db);
    const centerRows = body.scope === 'workspace'
      ? centerRowsRaw.filter(row => row.scope === 'workspace' && row.workspace_id === body.workspace_id)
      : centerRowsRaw;
    let centerAdded = 0;
    for (const row of centerRows) {
      if (byId.has(row.id)) { duplicates += 1; continue; }
      byId.set(row.id, { row, sourceDb: 'center' });
      centerAdded += 1;
    }
    sources.push({
      source_db: 'center',
      path: typeof options.db.name === 'string' && options.db.name !== '' ? options.db.name : null,
      pages: centerRows.length,
    });
    void centerAdded;

    // ---- 2) 逐页计划（目标目录 / 动作 / 冲突检测；不写任何东西） ----
    const dirOf = (row: LegacyKnowledgeRow): { dir: string; identity: { scope: 'workspace' | 'common'; workspace_id: string | null } } => {
      if (row.scope === 'common') {
        return { dir: toDir !== null ? join(toDir, 'Docs') : resolveDocsDir(options.docsPaths, 'common', null), identity: { scope: 'common', workspace_id: null } };
      }
      const wsRow = row.workspace_id === null ? null : getWorkspaceRow(row.workspace_id);
      if (wsRow === null || wsRow.path === '' || wsRow.path === undefined) {
        throw new ApiError(422, KnowledgeErrorCode.NOT_FOUND, `知识页 ${row.id}（${row.slug}）归属的工作区 ${row.workspace_id ?? '（空）'} 未注册或无 path，无法推导 Docs 目录`);
      }
      return {
        dir: toDir !== null ? join(toDir, `ws-${wsRow.id}`, 'Docs') : resolveDocsDir(options.docsPaths, 'workspace', wsRow.path),
        identity: { scope: 'workspace', workspace_id: wsRow.id },
      };
    };

    const planned: PlannedPage[] = [];
    const plannedFiles = new Map<string, { pageId: string; slug: string; sourceDb: string }>(); // `${dir}\0${fileName}` → 首个占用者
    let plannedSinceYield = 0;
    for (const { row, sourceDb } of [...byId.values()].sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))) {
      // 计划阶段也是纯 CPU（existsSync + readFileSync + sha256 + render），大库同样会阻塞
      plannedSinceYield += 1;
      if (plannedSinceYield >= YIELD_EVERY) { plannedSinceYield = 0; await yes(); }
      if (row.status === 'deleted') {
        planned.push({ row, sourceDb, meta: metaOf(row), targetDir: '', fileName: '', action: 'skip-deleted', reason: '软删页不落盘（撤文件语义，N5）；旧行保留不动', existingSha256: null });
        continue;
      }
      let dir: string;
      try {
        dir = dirOf(row).dir;
      } catch (error) {
        planned.push({ row, sourceDb, meta: metaOf(row), targetDir: '', fileName: '', action: 'skip-invalid', reason: error instanceof Error ? error.message : String(error), existingSha256: null });
        continue;
      }
      const meta = metaOf(row);
      const issues = metaIssues(meta);
      if (issues.length > 0) {
        planned.push({ row, sourceDb, meta, targetDir: dir, fileName: docFileNameFor(row.slug), action: 'skip-invalid', reason: `不符合文件契约：${issues.join('; ')}`, existingSha256: null });
        continue;
      }
      const fileName = docFileNameFor(row.slug);
      const filePath = join(dir, fileName);
      const key = `${dir}\0${fileName}`;
      const occupant = plannedFiles.get(key);
      if (occupant !== undefined && occupant.pageId !== row.id) {
        planned.push({ row, sourceDb, meta, targetDir: dir, fileName, action: 'conflict', reason: `slug 冲突：${fileName} 已被行集内另一页占用（${occupant.pageId} / ${occupant.slug}，源库 ${occupant.sourceDb}）`, existingSha256: null });
        continue;
      }
      plannedFiles.set(key, { pageId: row.id, slug: row.slug, sourceDb });
      const existingSha256 = existsSync(filePath) ? sha256(readFileSync(filePath, 'utf8')) : null;
      let action: ExportPageAction = 'create';
      let reason: string | undefined;
      // CRLF 归一记为 reason（不是失败）：写入侧 renderDocWithHash 恒把 CRLF → LF，
      // 旧库 30/37 页含 CRLF，若不标记，用户会以为正文被悄悄改动。
      if (normalizeBodyMd(row.body_md) !== row.body_md) reason = '正文含 CRLF，已按契约归一为 LF 落盘（内容未丢失）';
      if (existingSha256 !== null) {
        const incoming = renderDocWithHash(meta, row.body_md).content;
        if (sha256(incoming) === existingSha256) {
          action = 'skip-unchanged';
          reason = '目标文件已存在且逐字节一致（幂等跳过）';
        } else {
          action = 'conflict';
          reason = '目标文件已存在且内容不同（不静默覆盖，暂停导出）';
        }
      }
      planned.push({ row, sourceDb, meta, targetDir: dir, fileName, action, reason, existingSha256 });
    }

    // 备份只需对「目标已存在且内容不同」的冲突做（existingSha256 非空才有文件可备份）
    const conflicts: ExportConflictEntry[] = planned
      .filter(page => page.action === 'conflict' && page.existingSha256 !== null)
      .map(page => ({
        dir: page.targetDir,
        file: page.fileName,
        page_id: page.row.id,
        source_db: page.sourceDb,
        existing_sha256: page.existingSha256!,
        incoming_sha256: sha256(renderDocWithHash(page.meta, page.row.body_md).content),
      }));
    /**
     * 零丢失护栏：**任何** conflict 都必须阻止整体写入，包括行集内 slug 冲突
     * （`existingSha256 === null`，磁盘上无文件可备份）。
     * 原实现只用 `conflicts`（磁盘冲突）做门禁，行集内 slug 冲突时会照写其它页 →
     * 半迁移。这里把闸门放宽到「planned 中存在任意 conflict」。
     */
    const allConflicts = planned.filter(page => page.action === 'conflict');
    if (allConflicts.length > 0 && !body.dry_run && conflicts.length === 0) {
      throw new ApiError(409, KnowledgeErrorCode.EXPORT_CONFLICT,
        `export-legacy 检测到 ${allConflicts.length} 处行集内冲突（同 slug 归一后重名或同 id 重复），未写入任何文件；请先在旧库中区分这些页的 slug 再重跑`,
        { conflicts: allConflicts.map(page => ({ dir: page.targetDir, file: page.fileName, page_id: page.row.id, source_db: page.sourceDb, reason: page.reason })) },
      );
    }

    // ---- 3) 冲突：备份现有文件后暂停（一个都不写入，不静默覆盖） ----
    if (conflicts.length > 0 && !body.dry_run) {
      const stamp = exportedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace(/T/, '-');
      for (const conflict of conflicts) {
        const backupDir = join(conflict.dir, EXPORT_BACKUP_DIR_NAME, stamp);
        mkdirSync(backupDir, { recursive: true });
        const backupPath = join(backupDir, conflict.file);
        copyFileSync(join(conflict.dir, conflict.file), backupPath);
        conflict.backup_path = backupPath;
      }
      throw new ApiError(409, KnowledgeErrorCode.EXPORT_CONFLICT,
        `export-legacy 检测到 ${conflicts.length} 个目标文件冲突（已备份到 <Docs>/.export-backup/${stamp}/，未写入任何文件）；请人工核对后删除或改名的冲突文件再重跑`,
        { conflicts },
      );
    }

    // ---- 4) 两阶段：先全量内存内 render→parse→比较，全通过后才写盘（零丢失红线）----
    // 原实现「写一页→回读→校验」在第 N 页炸时前 N-1 页已落盘，留下无 manifest 的半迁移。
    // 红线要求「要么全成，要么全不动」，故校验前移，写盘阶段只做 IO。
    const manifests: ExportReport['manifests'] = [];
    if (!body.dry_run) {
      const writes = planned.filter(page => page.action === 'create');

      // 4a) 内存内校验（不碰磁盘）
      type VerifiedPage = { page: PlannedPage; content: string };
      const verified: VerifiedPage[] = [];
      let sinceYield = 0;
      for (const page of writes) {
        const { content } = renderDocWithHash(page.meta, page.row.body_md);
        let parsed: ReturnType<typeof parseKnowledgeDocument>;
        try {
          parsed = parseKnowledgeDocument(content);
        } catch (error) {
          throw new ApiError(500, KnowledgeErrorCode.EXPORT_VERIFY_FAILED, `导出前校验失败：${page.fileName} 渲染结果无法解析（${error instanceof Error ? error.message : String(error)}）；未写入任何文件`, { page_id: page.row.id, file: page.fileName });
        }
        // 正文比较用归一后的旧值：写入侧 renderDocWithHash 会把 CRLF 归一为 LF，
        // 拿原值（含 CRLF）比必炸（真实库 30/37 页含 CRLF）。归一不是丢失，是契约口径。
        const expectedBody = normalizeBodyMd(page.row.body_md);
        if (parsed.body_md !== expectedBody) {
          throw new ApiError(500, KnowledgeErrorCode.EXPORT_VERIFY_FAILED, `导出前校验失败：${page.fileName} 正文与旧库行不一致（零丢失红线）；未写入任何文件`, { page_id: page.row.id, file: page.fileName });
        }
        const expected = page.meta;
        const drifted = (Object.keys(expected) as Array<keyof KnowledgeFileMeta>)
          .filter(key => key !== 'content_hash')
          .filter(key => JSON.stringify(parsed.meta[key]) !== JSON.stringify(expected[key]));
        if (drifted.length > 0 || computeContentHash({ ...parsed.meta, content_hash: '' } as KnowledgeFileMeta, parsed.body_md) !== parsed.meta.content_hash) {
          throw new ApiError(500, KnowledgeErrorCode.EXPORT_VERIFY_FAILED, `导出前校验失败：${page.fileName} front matter 字段漂移（${drifted.join(', ') || 'content_hash'}）；未写入任何文件`, { page_id: page.row.id, file: page.fileName });
        }
        verified.push({ page, content });
        sinceYield += 1;
        if (sinceYield >= YIELD_EVERY) { sinceYield = 0; await yes(); }
      }

      // 4b) 写盘 + 回读（校验已过，这里只确认 IO 没出错）
      sinceYield = 0;
      for (const { page, content } of verified) {
        const filePath = join(page.targetDir, page.fileName);
        atomicWrite(filePath, content);
        const readback = readFileSync(filePath, 'utf8');
        if (sha256(readback) !== sha256(content)) {
          throw new ApiError(500, KnowledgeErrorCode.EXPORT_VERIFY_FAILED, `回读校验失败：${filePath} 内容与写入不一致`, { page_id: page.row.id, file: filePath });
        }
        sinceYield += 1;
        if (sinceYield >= YIELD_EVERY) { sinceYield = 0; await yes(); }
      }
      // manifest：每个「有产出」的目录写一份（create 或既有 skip-unchanged 都登记）。
      // 幂等：本次没有 create 且 manifest 已存在 → 不重写（exported_at 会变，重写必 diff）。
      const dirsTouched = new Set<string>();
      for (const page of planned) {
        if (page.targetDir === '') continue;
        if (page.action === 'create' || page.action === 'skip-unchanged' || page.action === 'conflict') dirsTouched.add(page.targetDir);
      }
      const anyCreate = planned.some(page => page.action === 'create');
      for (const dir of [...dirsTouched].sort()) {
        const manifestPath = join(dir, EXPORT_MANIFEST_NAME);
        if (!anyCreate && existsSync(manifestPath)) {
          manifests.push({ dir, file: EXPORT_MANIFEST_NAME, files: planned.filter(page => page.targetDir === dir && (page.action === 'create' || page.action === 'skip-unchanged')).length, written: false });
          continue;
        }
        const entries = planned
          .filter(page => page.targetDir === dir && (page.action === 'create' || page.action === 'skip-unchanged'))
          .sort((a, b) => a.fileName.localeCompare(b.fileName))
          .map(page => {
            const filePath = join(dir, page.fileName);
            const digest = existsSync(filePath) ? sha256(readFileSync(filePath, 'utf8')) : '';
            return { file: page.fileName, page_id: page.row.id, slug: page.row.slug, revision: page.row.revision, scope: page.row.scope, workspace_id: page.row.workspace_id, sha256: digest };
          });
        const manifest = {
          format: KNOWLEDGE_EXPORT_FORMAT,
          schema_version: KNOWLEDGE_EXPORT_SCHEMA_VERSION,
          exported_at: exportedAt,
          generator_version: KNOWLEDGE_EXPORT_GENERATOR,
          dir,
          pages_total: entries.length,
          files: entries,
        };
        const written = atomicWriteIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        manifests.push({ dir, file: EXPORT_MANIFEST_NAME, files: entries.length, written });
      }
    }

    // ---- 5) 报告 ----
    const pages: ExportPageEntry[] = planned.map(page => ({
      id: page.row.id, slug: page.row.slug, title: page.row.title, scope: page.row.scope,
      workspace_id: page.row.workspace_id, status: page.row.status, revision: page.row.revision,
      source_db: page.sourceDb, target_dir: page.targetDir, file: page.fileName,
      action: page.action, ...(page.reason === undefined ? {} : { reason: page.reason }),
    }));
    const countOf = (action: ExportPageAction): number => pages.filter(page => page.action === action).length;
    const targets: ExportTargetEntry[] = [...new Set(pages.map(page => page.target_dir).filter(dir => dir !== ''))].sort().map(dir => ({
      dir,
      create: pages.filter(page => page.target_dir === dir && page.action === 'create').length,
      unchanged: pages.filter(page => page.target_dir === dir && page.action === 'skip-unchanged').length,
      conflicts: pages.filter(page => page.target_dir === dir && page.action === 'conflict').length,
      skipped: pages.filter(page => page.target_dir === dir && (page.action === 'skip-deleted' || page.action === 'skip-invalid' || page.action === 'skip-duplicate')).length,
    }));
    const create = countOf('create');
    const unchanged = countOf('skip-unchanged');
    const conflictCount = countOf('conflict');
    const skipped = countOf('skip-deleted') + countOf('skip-invalid') + countOf('skip-duplicate');
    if (duplicates > 0) {
      pages.push({
        id: '', slug: '', title: '', scope: 'common', workspace_id: null, status: '', revision: 0,
        source_db: '', target_dir: '', file: '', action: 'skip-duplicate',
        reason: `${duplicates} 个同 id 页在多个源库出现（C8 混合态）：以 localized 工作区库副本为准，中心库重复副本跳过`,
      });
    }
    const report: ExportReport = {
      format: KNOWLEDGE_EXPORT_FORMAT,
      dry_run: body.dry_run,
      scope: body.scope,
      workspace_id: body.workspace_id ?? null,
      exported_at: exportedAt,
      sources,
      targets,
      pages,
      conflicts,
      manifests,
      summary: { total: byId.size, create, unchanged, conflicts: conflictCount, skipped },
    };
    res.json(report);
  });

  return router;
}
