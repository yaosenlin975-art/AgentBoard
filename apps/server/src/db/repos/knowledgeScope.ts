/**
 * KB-CR-2：knowledge scope WHERE 单点构造（P1）。
 * 此前 6 处重复（knowledgeRoutes 2 / repos/knowledge 3 / knowledgeSearch 1），口径漂移风险。
 * 列前缀：'' = 裸列名（路由层 / 表内查询），'p.' = 表别名限定（JOIN 查询）。
 */
export type KnowledgeScopeFilter = { scope: 'common' | 'workspace' } | { scope: 'both'; workspace_id: string };

export function knowledgeScopeWhere(filter: KnowledgeScopeFilter, prefix = ''): string {
  const c = prefix === '' ? '' : (prefix.endsWith('.') ? prefix : `${prefix}.`);
  if (filter.scope === 'common') return `${c}scope='common'`;
  if (filter.scope === 'workspace') return `(${c}scope='workspace' AND ${c}workspace_id=@workspace)`;
  return `(${c}scope='common' OR (${c}scope='workspace' AND ${c}workspace_id=@workspace))`;
}

/** 配套参数：scope ≠ common 时补 @workspace（与 knowledgeScopeWhere 成对使用） */
export function knowledgeScopeParams(filter: KnowledgeScopeFilter, params: Record<string, unknown> = {}): Record<string, unknown> {
  // 调用方保证 both/workspace 形态已带 workspace_id（判别联合在 !=='common' 后无法自动收窄，这里显式断言）
  if (filter.scope !== 'common') params.workspace = (filter as { workspace_id: string }).workspace_id;
  return params;
}
