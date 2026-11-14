/**
 * P2-01（方向 B §7.1/§7.3）：知识文件的服务端 front matter 契约校验与 content_hash。
 *
 * - 契约类型/渲染/解析在 `@agentboard/shared`（knowledgeFile.ts，前后端同源）；本文件只做服务端校验
 *   （词表、写入侧证据规则）与 content_hash 计算。
 * - content_hash = sha256(去掉 content_hash 字段渲染出的完整文档)：正文 + front matter 除本字段。
 *   外部编辑（Obsidian 手改）后重算与存储值不符 → reconcile 报告 + 写前冲突检测 409。
 * - 写入侧校验沿用 `services/knowledge.ts` 的 `validateKnowledgeContent`（证据须引用本版本来源、
 *   file 来源只存路径+hash、非 file 必带 snapshot），改为「解析 front matter 后校验」同一套规则。
 */
import { createHash } from 'node:crypto';
import {
  docFileNameFor,
  renderKnowledgeDocument,
  validateKnowledgeFileMeta,
  type KnowledgeFileMeta,
} from '@agentboard/shared';
import { ApiError, ValidationError } from '../errors.js';
import { KnowledgeErrorCode } from '../api/knowledgeCodes.js';
import { validateKnowledgeContent } from '../services/knowledge.js';

export type { KnowledgeFileMeta };

/** 计算 content_hash：去掉 content_hash 字段渲染完整文档后取 sha256 */
export function computeContentHash(meta: Omit<KnowledgeFileMeta, 'content_hash'> & { content_hash?: string }, bodyMd: string): string {
  const document = renderKnowledgeDocument({ ...(meta as KnowledgeFileMeta), content_hash: '' } as KnowledgeFileMeta, bodyMd, ['content_hash']);
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

/** 校验解析出的 meta 是否满足契约（reconcile 报告与读路径共用）；返回问题清单 */
export function validateMeta(meta: Record<string, unknown>, expected?: { scope?: 'workspace' | 'common'; workspace_id?: string | null }): string[] {
  const issues: string[] = [];
  const structural = validateKnowledgeFileMeta(meta);
  if (structural !== null) issues.push(`${structural.field}: ${structural.issue}`);
  if (structural === null) {
    const candidate = meta as unknown as KnowledgeFileMeta;
    if (expected?.scope !== undefined && candidate.scope !== expected.scope) {
      issues.push(`scope: front matter ${candidate.scope} 与所在目录 ${expected.scope} 不一致`);
    }
    if (expected?.workspace_id !== undefined && candidate.workspace_id !== expected.workspace_id) {
      issues.push(`workspace_id: front matter ${String(candidate.workspace_id)} 与所在目录不符`);
    }
  }
  return issues;
}

/** 写入侧完整校验（复用 services/knowledge.ts 的证据规则 + slug 格式），失败抛 4xx */
export function validateForWrite(input: {
  slug: string; title: string; body_md: string; sources: KnowledgeFileMeta['sources']; evidence: KnowledgeFileMeta['evidence'];
  actor: string; expires_at: number | null;
}): void {
  validateKnowledgeContent({ ...input, expires_at: input.expires_at ?? null });
  // slug 格式与旧仓储一致（N1：文件名 = normalizeLinkTarget(slug)；格式校验管原始 slug）
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(input.slug) || input.slug.split('/').includes('..')) {
    throw new ValidationError('slug 格式不合法');
  }
}

/** 同名 slug 归一冲突（两个不同 slug 清洗成同一文件名）→ 409 */
export function fileNameConflictError(slug: string, fileName: string): ApiError {
  return new ApiError(409, KnowledgeErrorCode.EXISTS, `slug「${slug}」与现有文件 ${fileName} 归一后重名，请换一个 slug`);
}

/** 渲染并填充 content_hash（写入路径唯一出口） */
export function renderDocWithHash(meta: Omit<KnowledgeFileMeta, 'content_hash'>, bodyMd: string): { content: string; meta: KnowledgeFileMeta } {
  const content_hash = computeContentHash(meta, bodyMd);
  const full = { ...meta, content_hash } as KnowledgeFileMeta;
  return { content: renderKnowledgeDocument(full, bodyMd), meta: full };
}

/** 渲染文件名一致性自检（文件名必须等于 docFileNameFor(slug)） */
export function assertFileNameMatchesSlug(slug: string, fileName: string): void {
  if (docFileNameFor(slug) !== fileName) throw new ValidationError(`文件名 ${fileName} 与 slug「${slug}」归一结果不一致`);
}
