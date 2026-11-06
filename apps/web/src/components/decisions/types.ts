/**
 * DEC-6：待决策视图的本地 DTO。
 *
 * 服务端投影（DEC-1/3）尚未并入 `@agentboard/shared`（DEC-3 卡评论已记录该口径差异），
 * 前端先在本模块声明只读类型，字段名与服务端 `db/repos/decision.ts` 的
 * `DecisionListItem` / `DecisionDetail` / `DecisionCounts` 保持一致。
 */
import type { DecisionCapabilities } from '@agentboard/shared';

export type DecisionState = 'grace' | 'open' | 'answered' | 'withdrawn';

export interface DecisionOptionDto {
  id: string;
  ord: number;
  label: string;
  consequence: string;
  is_default: number;
}

export interface DecisionAnswerDto {
  id: string;
  revision: number;
  option_id: string | null;
  answer_text: string | null;
  answered_by: string;
  source: string;
  /** DEC-V4-UNDO-SERVER：撤销墓碑（有值为已撤销，行仍保留） */
  revoked_at?: number | null;
  revoked_by?: string | null;
  created_at: number;
}

export interface DecisionListItemDto {
  id: string;
  workspace_id: string;
  issue_id: string;
  question: string;
  context_md: string;
  trigger: string;
  state: DecisionState;
  created_by: string;
  grace_seconds: number;
  grace_until: number;
  locked_at: number | null;
  stop_requested_at: number | null;
  stop_ack_at: number | null;
  answer_revision: number;
  created_at: number;
  answered_at: number | null;
  withdrawn_at: number | null;
  withdrawn_by: string | null;
  withdrawn_reason: string | null;
  /** 服务端 join issue 派生 */
  issue_title: string;
  issue_status: string;
  /** PERM-2 服务端 join workspace 派生；跨区视图展示用（旧快照可能缺省） */
  workspace_name?: string;
  /** PERM-2 当前答案回答者（旧快照可能缺省） */
  current_answer_by?: string | null;
  /** PERM-2 服务端按调用者角色计算的 capability 投影；缺省表示旧服务端 */
  capabilities?: DecisionCapabilities;
  /** 服务端 join issue 派生（DEC-V4-API-LIST）：队列排序用 */
  issue_priority: '低' | '中' | '高';
  option_count: number;
  /** 列表内联选项（与详情同形状，按 ord 升序） */
  options: DecisionOptionDto[];
  /** 该卡作为 blocker 的 blocks 边数量；无下游为 0 */
  blocked_downstream_count: number;
  /** grace 期间剩余秒数（其余 null），由服务端按请求时刻计算 */
  remaining_grace_seconds: number | null;
  /** open 已等待秒数（其余 null） */
  waiting_seconds: number | null;
}

export interface DecisionDetailDto extends DecisionListItemDto {
  checkpoint_json: string | null;
  current_answer_id: string | null;
  expires_at: number | null;
  on_expire: string;
  options: DecisionOptionDto[];
  answers: DecisionAnswerDto[];
}

export interface DecisionCounts {
  grace: number;
  open: number;
  stale_open: number;
  answered_recent: number;
}

export interface DecisionListResponse {
  decisions: DecisionListItemDto[];
  counts: DecisionCounts;
  /** PERM-2 响应级能力投影（多区时取最高角色）；旧服务端缺省 */
  capabilities?: DecisionCapabilities;
}
