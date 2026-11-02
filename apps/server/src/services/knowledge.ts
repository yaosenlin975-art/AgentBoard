import { z } from 'zod';
import type { KnowledgeEvidence, KnowledgeScope, KnowledgeSource } from '@agentboard/shared';
import { ValidationError } from '../errors.js';

const shortText = z.string().trim().min(1).max(2000);
const snapshot = z.string().refine(s => s.trim().length > 0 && Buffer.byteLength(s, 'utf8') <= 2048, '证据摘录必须非空且最多 2 KiB');
export const knowledgeSourceSchema = z.object({
  source_id: shortText, source_type: z.enum(['file', 'url', 'agent']), locator: shortText,
  captured_at: z.number().int().nonnegative(), content_hash: z.string().regex(/^[a-fA-F0-9]{64}$/), snapshot: snapshot.optional(),
}).strict();
export const knowledgeEvidenceSchema = z.object({ source_id: shortText, locator: shortText, snapshot: snapshot.optional() }).strict();
const contentSchema = z.object({
  title: z.string().trim().min(1).max(300), body_md: z.string().min(1).max(100000),
  sources: z.array(knowledgeSourceSchema).min(1).max(100), evidence: z.array(knowledgeEvidenceSchema).min(1).max(100),
  actor: z.string().trim().min(1).max(100), expires_at: z.number().int().nonnegative().nullable(),
});

export function validateKnowledgeScope(scope: KnowledgeScope): void {
  if (!scope || !['workspace', 'common'].includes(scope.scope)
    || (scope.scope === 'workspace' ? !scope.workspace_id : scope.workspace_id != null)) {
    throw new ValidationError('知识范围与 workspace_id 不一致');
  }
}

export function validateKnowledgeContent(input: { title: string; body_md: string; sources: KnowledgeSource[]; evidence: KnowledgeEvidence[]; actor: string; expires_at: number | null }): void {
  const result = contentSchema.safeParse(input);
  if (!result.success) throw new ValidationError(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const sources = new Set(input.sources.map(s => s.source_id));
  if (sources.size !== input.sources.length || input.evidence.some(e => !sources.has(e.source_id))) {
    throw new ValidationError('来源 ID 必须唯一，证据必须引用本版本来源');
  }
  const localSources = new Set(input.sources.filter(s => s.source_type === 'file').map(s => s.source_id));
  if (input.sources.some(s => s.source_type === 'file' && s.snapshot !== undefined)
    || input.evidence.some(e => localSources.has(e.source_id) && e.snapshot !== undefined)) {
    throw new ValidationError('本地代码来源只保存路径和 hash，不复制源码');
  }
  const captured = new Set(input.sources.filter(s => s.snapshot?.trim()).map(s => s.source_id));
  for (const evidence of input.evidence) if (evidence.snapshot?.trim()) captured.add(evidence.source_id);
  if (input.sources.some(s => s.source_type !== 'file' && !captured.has(s.source_id))) throw new ValidationError('外部文本和 agent 来源必须保留本次采集的证据摘录');
}
