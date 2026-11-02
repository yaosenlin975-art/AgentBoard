import type { Db } from '../connection.js';
import type { KnowledgePage } from '@agentboard/shared';
import { getKnowledgePage } from './knowledge.js';
import { ValidationError } from '../../errors.js';

export interface KnowledgeSearchInput {
  scope: 'workspace' | 'common' | 'both'; workspace_id?: string; query: string; limit?: number; now?: number;
}
export interface KnowledgeSearchResult {
  page_id: string; scope: KnowledgePage['scope']; workspace_id: string | null; revision: number; title: string;
  snippet: string; sources: KnowledgePage['sources']; evidence: KnowledgePage['evidence']; score: number;
}
export function searchKnowledge(db: Db, input: KnowledgeSearchInput): KnowledgeSearchResult[] {
  const query = input.query?.trim();
  const limit = input.limit ?? 5;
  if (!query || Array.from(query).length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20
    || !['workspace', 'common', 'both'].includes(input.scope)
    || (input.scope === 'common' ? input.workspace_id != null : !input.workspace_id)
    || (input.now !== undefined && !Number.isSafeInteger(input.now))) throw new ValidationError('知识查询参数不合法');
  const scopeSql = input.scope === 'common' ? "p.scope='common'"
    : input.scope === 'workspace' ? "(p.scope='workspace' AND p.workspace_id=@workspace)"
      : "(p.scope='common' OR (p.scope='workspace' AND p.workspace_id=@workspace))";
  const params: Record<string, string | number> = { now: input.now ?? Date.now(), limit };
  if (input.scope !== 'common') params.workspace = input.workspace_id!;
  const long = Array.from(query).length >= 3;
  let sql: string;
  if (long) {
    params.query = `"${query.replaceAll('"', '""')}"`;
    sql = `SELECT p.id,p.scope,p.workspace_id,bm25(knowledge_fts,0,5,1) AS score FROM knowledge_fts JOIN knowledge_page p ON p.id=knowledge_fts.page_id
      WHERE knowledge_fts MATCH @query AND ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now)
      ORDER BY score,p.scope='workspace' DESC,p.updated_at DESC,p.id LIMIT @limit`;
  } else {
    // ponytail: 1–2 code-point queries scan only eligible scope rows; trigram cannot index them.
    params.query = `%${query.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
    sql = `SELECT p.id,p.scope,p.workspace_id,CASE WHEN p.title LIKE @query ESCAPE '!' THEN -1 ELSE 0 END AS score FROM knowledge_page p
      WHERE ${scopeSql} AND p.status='active' AND (p.expires_at IS NULL OR p.expires_at>@now) AND (p.title LIKE @query ESCAPE '!' OR p.body_md LIKE @query ESCAPE '!')
      ORDER BY score,p.scope='workspace' DESC,p.updated_at DESC,p.id LIMIT @limit`;
  }
  return (db.prepare(sql).all(params) as Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; score: number }>).map(row => {
    const page = getKnowledgePage(db, row.id, row.scope === 'common' ? { scope: 'common' } : { scope: 'workspace', workspace_id: row.workspace_id! })!;
    const position = page.body_md.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, position - 100);
    return { page_id: page.id, scope: page.scope, workspace_id: page.workspace_id, revision: page.revision, title: page.title,
      snippet: page.body_md.slice(start, start + 1200), sources: page.sources, evidence: page.evidence, score: row.score };
  });
}
