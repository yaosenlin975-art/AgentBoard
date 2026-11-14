/**
 * P2-01（方向 B §7.3）：知识文件仓储的写协议与 CRUD。
 *
 * 三层并发策略（§7.3 L1/L2/L3）：
 * - L1 进程内：本仓储全部 fs 操作为同步 IO，单线程事件循环内同路径写天然串行
 *   （per-path 串行队列的同步等价实现；锁的粒度即 per-path——slug 归一后的文件名）。
 * - L2 跨进程锁：`<Docs>/.locks/<slug-norm>.lock`（`O_EXCL` 原子创建，内容 `pid + instanceId + ts`；
 *   持有者 pid 存活且 instanceId 不同 → 等待重试，超时 409；持有者已死 → 接管。
 *   口径复用 services/serverLock.ts 的 pid 存活判定）。锁只覆盖 API/CLI 写，不锁 Obsidian。
 * - L3 外部编辑检测：写前重算 content_hash 与 front matter 存储值比对，不符 → 不覆盖，
 *   抛 409 `KNOWLEDGE_FILE_CONFLICT`（CLI 409 → exit 2），提示先 reconcile，由人裁决。
 * - 原子替换：写同目录 `<name>.tmp-<rand>` → fsync → `renameSync`（沿用 config.ts writeSettings 口径）。
 *   崩溃可能残留 `.tmp-*`（reconcile 清理，绝不自动改写正文）。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  docFileNameFor,
  type KnowledgeFileMeta,
} from '@agentboard/shared';
import type { KnowledgeEvidence, KnowledgePage, KnowledgeSource } from '@agentboard/shared';
import { ApiError, ValidationError } from '../errors.js';
import { KnowledgeErrorCode } from '../api/knowledgeCodes.js';
import { isProcessAlive } from '../services/serverLock.js';
import { normalizeKnowledgeDomain, normalizePageCategory, requireKnowledgeDomain } from '../db/repos/knowledge.js';
import { computeContentHash, renderDocWithHash, validateForWrite } from './frontMatter.js';
import { docFilePathFor, lockPathFor } from './paths.js';
import { readDocFile } from './scanner.js';
import type { DocsIndex } from './index.js';

const LOCK_RETRY_INTERVAL_MS = 50;

export interface KnowledgeRepoOptions {
  /** 实例标识（锁内容；用于区分同机多实例与崩溃残留） */
  instanceId?: string;
  now?: () => number;
  /** 跨进程锁等待上限（毫秒）；默认 3000，测试可调 0 立即冲突 */
  lockTimeoutMs?: number;
}

export type CreateKnowledgePageInput = {
  scope: 'workspace' | 'common';
  workspace_id?: string | null;
  slug: string; title: string; body_md: string; sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  actor: string; expires_at?: number | null; change_note?: string;
  category?: KnowledgePage['category'];
  landed?: KnowledgePage['landed'];
  domain?: string | null;
};

export type KnowledgePagePatch = Partial<Pick<KnowledgePage, 'title' | 'body_md' | 'sources' | 'evidence' | 'expires_at' | 'category' | 'landed'>> & { actor: string; change_note?: string; domain?: string | null };

/** 仓储侧页面形状（对齐 shared KnowledgePage；软删页文件已撤，无 deleted 形态） */
export type RepoPage = KnowledgePage;

export class KnowledgeFileRepo {
  readonly docsDir: string;
  readonly index: DocsIndex;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;

  constructor(docsDir: string, index: DocsIndex, options: KnowledgeRepoOptions = {}) {
    this.docsDir = docsDir;
    this.index = index;
    this.instanceId = options.instanceId ?? `kb-${randomUUID().slice(0, 8)}`;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 3000;
  }

  // ---- 读 ----

  /** 页面按 id（archived 默认不可见，对齐旧 getKnowledgePage；软删 = 文件已撤 = 不存在） */
  getPage(id: string, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }, options: { includeArchived?: boolean } = {}): RepoPage | null {
    this.index.ensureFresh();
    const entry = this.index.getByIdIncludeArchived(id);
    if (entry === null) return null;
    if (entry.issues.length > 0) return null; // 坏文件不参与读取（reconcile 报告）
    if (!this.scopeMatches(entry.meta, scope)) return null;
    if (entry.meta.status === 'archived' && options.includeArchived !== true) return null;
    return this.toPage(entry);
  }

  /** 按 slug 精确取（唯一性由文件系统保证；返回 null 或唯一页） */
  getBySlug(slug: string, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }): RepoPage | null {
    this.index.ensureFresh();
    const bucket = this.index.getBySlug(slug).filter(entry => entry.issues.length === 0 && this.scopeMatches(entry.meta, scope) && entry.meta.status !== 'archived');
    if (bucket.length === 0) return null;
    return this.toPage(bucket[0]!);
  }

  scopeMatches(meta: KnowledgeFileMeta, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }): boolean {
    if (scope.scope === 'common') return meta.scope === 'common' && meta.workspace_id === null;
    return meta.scope === 'workspace' && meta.workspace_id === scope.workspace_id;
  }

  private toPage(entry: { meta: KnowledgeFileMeta; body: string }): RepoPage {
    return {
      id: entry.meta.id,
      scope: entry.meta.scope,
      workspace_id: entry.meta.workspace_id,
      slug: entry.meta.slug,
      title: entry.meta.title,
      body_md: entry.body,
      status: entry.meta.status,
      revision: entry.meta.revision,
      expires_at: entry.meta.expires_at,
      created_by: entry.meta.created_by,
      updated_by: entry.meta.updated_by,
      created_at: entry.meta.created_at,
      updated_at: entry.meta.updated_at,
      sources: entry.meta.sources,
      evidence: entry.meta.evidence,
      category: entry.meta.category,
      landed: entry.meta.landed,
      domain: entry.meta.domain,
    } as RepoPage;
  }

  // ---- 写协议 ----

  /**
   * L1+L2 串行执行：锁粒度 = slug 归一后的锁文件。
   * 全同步执行 → 单线程内无交错；跨进程由 O_EXCL 锁互斥。
   */
  private withLock<T>(slug: string, fn: () => T): T {
    const lockPath = lockPathFor(this.docsDir, slug);
    mkdirSync(dirname(lockPath), { recursive: true });
    const acquired = this.acquireLock(lockPath);
    try {
      return fn();
    } finally {
      try { unlinkSync(lockPath); } catch { /* 已被接管者删除 */ }
    }
  }

  private acquireLock(lockPath: string): void {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lockPath, 'wx');
        try {
          writeFileSync(fd, `${JSON.stringify({ pid: process.pid, instanceId: this.instanceId, ts: Date.now() })}\n`, 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
      // 已有锁：持有者存活且非本实例 → 等待；否则（陈旧）接管
      const holder = this.readLock(lockPath);
      const blocking = holder !== null && isProcessAlive(holder.pid) && holder.instanceId !== this.instanceId;
      if (!blocking || Date.now() >= deadline) {
        if (blocking) {
          throw new ApiError(409, KnowledgeErrorCode.FILE_CONFLICT, '该知识页正被其它进程写入（锁等待超时），请稍后重试或先 reconcile');
        }
        try { unlinkSync(lockPath); } catch { /* 竞态删除：下轮重试 */ }
        continue;
      }
      const waitEnd = Date.now() + LOCK_RETRY_INTERVAL_MS;
      while (Date.now() < waitEnd) { /* 自旋等待（同步实现；间隔远小于写耗时） */ }
    }
  }

  private readLock(lockPath: string): { pid: number; instanceId: string; ts: number } | null {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; instanceId?: unknown; ts?: unknown };
      if (typeof parsed.pid !== 'number' || typeof parsed.instanceId !== 'string') return null;
      return { pid: parsed.pid, instanceId: parsed.instanceId, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 };
    } catch {
      return null;
    }
  }

  /** 原子替换写：tmp（同目录）→ fsync → renameSync */
  private atomicWrite(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* 忽略 */ }
      try { unlinkSync(tmp); } catch { /* 忽略 */ }
      throw error;
    }
    closeSync(fd);
    renameSync(tmp, filePath);
  }

  /** L3 外部编辑检测：重算 content_hash 与 front matter 存储值比对 */
  private assertNotExternallyEdited(meta: KnowledgeFileMeta, body: string): void {
    const recomputed = computeContentHash({ ...meta, content_hash: '' } as never, body);
    if (recomputed !== meta.content_hash) {
      throw new ApiError(409, KnowledgeErrorCode.FILE_CONFLICT,
        `知识页文件已被外部修改（content_hash 与 front matter 不符），为避免覆盖外部编辑已拒绝写入；请先运行 reconcile 处理冲突（slug: ${meta.slug}）`);
    }
  }

  private readFresh(scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }, slug: string): { meta: KnowledgeFileMeta; body: string; fileName: string; filePath: string } {
    const filePath = docFilePathFor(this.docsDir, slug);
    if (!existsSync(filePath)) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    const parsed = readDocFile(this.docsDir, filePath);
    if (!this.scopeMatches(parsed.meta, scope)) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    return { meta: parsed.meta, body: parsed.body_md, fileName: docFileNameFor(slug), filePath };
  }

  // ---- CRUD ----

  create(input: CreateKnowledgePageInput): RepoPage {
    const now = this.now();
    const domain = requireKnowledgeDomain(input.domain);
    const taxonomy = normalizePageCategory(input.category, input.landed);
    const scopeMeta = input.scope === 'workspace'
      ? { scope: 'workspace' as const, workspace_id: input.workspace_id ?? null }
      : { scope: 'common' as const, workspace_id: null };
    if (input.scope === 'workspace' && (input.workspace_id === undefined || input.workspace_id === '')) {
      throw new ValidationError('scope=workspace 时必须提供 workspace_id');
    }
    validateForWrite({
      slug: input.slug, title: input.title, body_md: input.body_md, sources: input.sources, evidence: input.evidence,
      actor: input.actor, expires_at: input.expires_at ?? null,
    });
    const baseMeta: Omit<KnowledgeFileMeta, 'content_hash'> = {
      id: randomUUID(),
      slug: input.slug,
      title: input.title,
      revision: 1,
      scope: scopeMeta.scope,
      workspace_id: scopeMeta.workspace_id,
      status: 'active',
      domain,
      category: taxonomy.category,
      landed: taxonomy.landed ?? null,
      sources: input.sources,
      evidence: input.evidence,
      expires_at: input.expires_at ?? null,
      created_at: now,
      updated_at: now,
      created_by: input.actor,
      updated_by: input.actor,
      change_note: input.change_note ?? '',
    };
    return this.withLock(input.slug, () => {
      this.index.ensureFresh();
      const filePath = docFilePathFor(this.docsDir, input.slug);
      if (existsSync(filePath)) throw new ApiError(409, KnowledgeErrorCode.EXISTS, '范围内已存在该 slug');
      const { content } = renderDocWithHash(baseMeta, input.body_md);
      this.atomicWrite(filePath, content);
      this.index.notifyChanged(docFileNameFor(input.slug));
      this.index.persist();
      return this.toPage({ meta: { ...baseMeta, content_hash: computeContentHash(baseMeta, input.body_md) }, body: input.body_md });
    });
  }

  revise(pageId: string, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }, expectedRevision: number, patch: KnowledgePagePatch): RepoPage {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ValidationError('expected_revision 必须为正整数');
    if (!['title', 'body_md', 'sources', 'evidence', 'expires_at', 'category', 'landed', 'domain'].some(k => Object.hasOwn(patch, k))) {
      throw new ValidationError('修订必须包含改动字段');
    }
    return this.withLockByPage(pageId, scope, (fresh) => {
      const old = fresh.meta;
      if (!this.scopeMatches(old, scope)) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
      this.assertNotExternallyEdited(old, fresh.body);
      if (old.revision !== expectedRevision) {
        throw new ApiError(409, KnowledgeErrorCode.REVISION_CONFLICT, '知识页已更新，请重新读取', { current_revision: old.revision });
      }
      const taxonomy = normalizePageCategory(
        patch.category !== undefined ? patch.category : old.category,
        patch.landed !== undefined ? patch.landed : old.landed,
      );
      const nextDomain: string = patch.domain === undefined ? old.domain : (normalizeKnowledgeDomain(patch.domain) ?? '');
      const nextMeta: KnowledgeFileMeta = {
        ...old,
        title: patch.title ?? old.title,
        revision: old.revision + 1,
        status: old.status,
        category: taxonomy.category,
        landed: taxonomy.landed ?? null,
        domain: nextDomain,
        sources: patch.sources ?? old.sources,
        evidence: patch.evidence ?? old.evidence,
        expires_at: patch.expires_at === undefined ? old.expires_at : patch.expires_at,
        updated_by: patch.actor,
        updated_at: Math.max(this.now(), old.updated_at + 1),
        change_note: patch.change_note ?? '',
      };
      const body = patch.body_md ?? fresh.body;
      validateForWrite({ slug: nextMeta.slug, title: nextMeta.title, body_md: body, sources: nextMeta.sources, evidence: nextMeta.evidence, actor: patch.actor, expires_at: nextMeta.expires_at });
      const { content, meta } = renderDocWithHash(nextMeta, body);
      this.atomicWrite(fresh.filePath, content);
      this.index.notifyChanged(fresh.fileName);
      this.index.persist();
      return this.toPage({ meta, body });
    });
  }

  setStatus(pageId: string, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }, expectedRevision: number, action: 'archive' | 'restore' | 'delete', actor: string): RepoPage {
    if (!['archive', 'restore', 'delete'].includes(action)) throw new ValidationError('未知状态操作');
    return this.withLockByPage(pageId, scope, (fresh) => {
      const old = fresh.meta;
      if (!this.scopeMatches(old, scope)) throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
      this.assertNotExternallyEdited(old, fresh.body);
      if (old.revision !== expectedRevision) {
        throw new ApiError(409, KnowledgeErrorCode.REVISION_CONFLICT, '知识页已更新，请重新读取', { current_revision: old.revision });
      }
      if (action === 'restore' && old.status !== 'archived') throw new ApiError(409, KnowledgeErrorCode.STATE_CONFLICT, '当前状态不允许此操作');
      if (action === 'archive' && old.status !== 'active') throw new ApiError(409, KnowledgeErrorCode.STATE_CONFLICT, '当前状态不允许此操作');
      if (action === 'delete') {
        // 软删撤文件（N5 / §8 #5）：删掉即不可寻址，无 deleted 形态落盘
        rmSync(fresh.filePath, { force: true });
        this.index.notifyChanged(fresh.fileName);
        this.index.persist();
        return { ...this.toPage({ meta: old, body: fresh.body }), status: 'deleted' as const };
      }
      const nextMeta: KnowledgeFileMeta = {
        ...old,
        revision: old.revision + 1,
        status: action === 'archive' ? 'archived' : 'active',
        updated_by: actor,
        updated_at: Math.max(this.now(), old.updated_at + 1),
      };
      const { content, meta } = renderDocWithHash(nextMeta, fresh.body);
      this.atomicWrite(fresh.filePath, content);
      this.index.notifyChanged(fresh.fileName);
      this.index.persist();
      return this.toPage({ meta, body: fresh.body });
    });
  }

  /**
   * 按 id 定位 slug 后加锁执行（软删后文件已撤 → 404）。
   * `fn` 收到的 fresh 是**锁内直读磁盘**的结果（不经索引缓存），保证 CAS 基线是文件真值。
   */
  private withLockByPage<T>(pageId: string, scope: { scope: 'workspace' | 'common'; workspace_id?: string | null }, fn: (fresh: { meta: KnowledgeFileMeta; body: string; fileName: string; filePath: string }) => T): T {
    this.index.ensureFresh();
    const entry = this.index.getByIdAny(pageId);
    // 写路径不因 issues 短路 404：外部编辑/坏 front matter 要走到锁内直读，
    // 由 assertNotExternallyEdited / 解析错误显式报 409（冲突由人裁决，不伪装成「不存在」）
    if (entry === null || entry.meta === undefined || !this.scopeMatches(entry.meta, scope)) {
      throw new ApiError(404, KnowledgeErrorCode.NOT_FOUND, '知识页不存在');
    }
    const slug = entry.meta.slug;
    return this.withLock(slug, () => {
      let fresh: { meta: KnowledgeFileMeta; body: string; fileName: string; filePath: string };
      try {
        fresh = this.readFresh(scope, slug);
      } catch (error) {
        // 文件解析失败（外部改坏 front matter）→ 与外部编辑同口径：409 冲突，请先 reconcile
        if (error instanceof Error && error.name === 'KnowledgeFileParseError') {
          throw new ApiError(409, KnowledgeErrorCode.FILE_CONFLICT, `知识页文件无法解析（${error.message}）；请先运行 reconcile 处理，冲突由人裁决`);
        }
        throw error;
      }
      return fn(fresh);
    });
  }

  /** 建议 slug（import 冲突时；`x` → `x-2`…；最多 20 次） */
  suggestSlug(slug: string): string | null {
    this.index.ensureFresh();
    for (let i = 2; i <= 20; i += 1) {
      const candidate = `${slug}-${i}`.slice(0, 200);
      if (this.index.getBySlug(candidate).length === 0) return candidate;
    }
    return null;
  }

  /** 附件目录（<Docs>/_attachments/，vault 自包含布局；本卡只保证目录约定，节点/渲染归 P2-03） */
  ensureAttachmentsDir(): string {
    const dir = join(this.docsDir, '_attachments');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
