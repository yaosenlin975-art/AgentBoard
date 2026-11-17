/**
 * `decision_id` 前缀解析（S6）。
 *
 * 与 `taskRef.ts` 共用 `idRef.ts` 的判定骨架（不复制一份）。
 * 差异点：候选从 `/decisions` 拉、404 码是 `DECISION_NOT_FOUND`。
 *
 * 服务端 `findDecision`（`apps/server/src/api/decisionRoutes.ts:322-331`）直接透传
 * `req.params.id` 给 `getDecisionDetail` → `getDecision` 精确查，所以前缀必然 404。
 * `/decisions` 列表接口无 `next_offset`（按 limit 截断），故这里用大 limit 一次拉取；
 * 若返回条数等于 limit 说明可能被截断，继续翻倍重试到上限为止。
 */
import type { AgentBoardApiClient } from '../apiClient.js';
import { resolveIdByRef, assertPrefixLength } from './idRef.js';

interface DecisionRow { id: string; state?: string; question?: string }

const LIST_LIMIT = 100;
/** 决策列表单次最多拉多少（足够覆盖单工作区在飞决策；超出则前缀解析对极老决策失效） */
const MAX_SCAN = 1000;

async function listAllDecisionIds(api: AgentBoardApiClient, workspaceId: string): Promise<DecisionRow[]> {
  const out: DecisionRow[] = [];
  let limit = LIST_LIMIT;
  for (;;) {
    const page = await api.get<{ decisions: Array<Record<string, unknown>> }>('/decisions', {
      workspace_id: workspaceId,
      limit,
    });
    out.length = 0;
    for (const raw of page.decisions) {
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (id === '') continue;
      out.push({
        id,
        ...(typeof raw.state === 'string' ? { state: raw.state } : {}),
        ...(typeof raw.question === 'string' ? { question: raw.question } : {}),
      });
    }
    // 未打满 → 已拿到全部；打满且还没到上限 → 翻倍再试
    if (page.decisions.length < limit || limit >= MAX_SCAN) return out;
    limit = Math.min(limit * 2, MAX_SCAN);
  }
}

/**
 * `ref` → 真实决策 id（完整 UUID / 非十六进制引用零成本透传）。
 *
 * `workspaceId` 为 null 表示本进程未绑定工作区（`get_decision` / `answer_decision` /
 * `withdraw_decision` 三个工具没有 workspace_id 参数，只能用 `config.workspaceId`）。
 * 未绑定时无法列出候选，按 P4-C7 的口径**不去猜 id 有效性**：直接把原始引用透传给服务端，
 * 由服务端报 `DECISION_NOT_FOUND`（描述里已写明前缀解析需要绑定工作区）。
 */
export async function resolveDecisionId(
  api: AgentBoardApiClient,
  workspaceId: string | null,
  ref: string,
): Promise<string> {
  if (workspaceId === null) {
    const raw = ref.trim();
    // 未绑定时仍要保留「<8 位本地拒绝」这条一致行为，避免把明显过短的引用发出去
    assertPrefixLength(raw, 'decision_id');
    return raw;
  }
  return resolveIdByRef<DecisionRow>(ref, {
    fieldName: 'decision_id',
    notFoundCode: 'DECISION_NOT_FOUND',
    listAll: () => listAllDecisionIds(api, workspaceId),
    idOf: item => item.id,
    describe: item => `${item.id}${item.state === undefined ? '' : ` · ${item.state}`}${item.question === undefined ? '' : ` · ${item.question}`}`,
  });
}
