export type IssueStatus = '待规划' | '进行中' | '待验收' | '已关闭';
export type Priority = '低' | '中' | '高';
export type SessionStatus = '运行中' | '已结束' | '失败';
export type CommentAuthor = string; // 'user' | 'agent:<cliId>' | 'system'
export type KnowledgeScope = { scope: 'common'; workspace_id?: null } | { scope: 'workspace'; workspace_id: string };
export interface KnowledgeSource {
  source_id: string; source_type: 'file' | 'url' | 'agent'; locator: string;
  captured_at: number; content_hash: string; snapshot?: string;
}
export interface KnowledgeEvidence { source_id: string; locator: string; snapshot?: string }
export interface KnowledgePage {
  id: string; scope: 'workspace' | 'common'; workspace_id: string | null; slug: string;
  title: string; body_md: string; status: 'active' | 'archived' | 'deleted'; revision: number;
  expires_at: number | null; created_by: string; updated_by: string; created_at: number; updated_at: number;
  sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  /** KB-MODEL 四类内容模型；旧行/未迁移库缺省视为 legacy */
  category?: 'design' | 'solved' | 'pinned' | 'open' | 'legacy';
  /** design 类的落地状态（其他类为 null） */
  landed?: 'landed' | 'partial' | 'proposed' | null;
}
export interface KnowledgeRevision {
  id: string; page_id: string; revision: number; title_snapshot: string; body_snapshot: string;
  sources: KnowledgeSource[]; evidence: KnowledgeEvidence[];
  change_kind: 'create' | 'update' | 'archive' | 'restore' | 'delete';
  status_snapshot: KnowledgePage['status']; expires_at_snapshot: number | null;
  change_note: string; actor: string; created_at: number;
}
export interface TaskKnowledge {
  enabled: boolean; query: string; warning?: 'KNOWLEDGE_UNAVAILABLE';
  items: Array<Pick<KnowledgePage, 'id' | 'scope' | 'workspace_id' | 'revision' | 'title' | 'sources' | 'evidence'> & { snippet: string }>;
}
/**
 * `kb done` / MCP `complete_task` 响应的软提醒：本任务没写过知识页时给出建议，不阻塞、不改退出码。
 * 属于 done 响应契约的一部分（CLI / MCP / 未来 web 都读），因此放在 shared，而不是各自内联。
 */
export interface KnowledgeHint {
  suggested_slug: string;
  scope: 'workspace';
  message: string;
}
export interface PageResult<T> { items: T[]; next_offset: number | null }
export interface TextWindow { content: string; truncated: boolean; next_offset_chars: number | null }
export interface TaskPreview extends Issue { description_truncated: boolean; next_description_offset_chars: number | null }
export type ManagedAppId = 'workbuddy_desktop' | 'codebuddy_desktop' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode';
export interface ManagedAccount {
  id: string; app_id: ManagedAppId; client_instance_id: string; service_region: 'cn' | 'global' | 'unknown';
  identity_hash: string; display_name: string; identity_hint: string | null;
  client_snapshot_ref: string | null; checkin_credential_ref: string | null; client_snapshot_version: number;
  checkin_capability: 'unknown' | 'supported' | 'unsupported'; enabled: boolean;
  last_checkin_day: string | null; last_checkin_status: string | null; last_checkin_at: number | null;
  created_at: number; updated_at: number;
}
export type PublicManagedAccount = Omit<ManagedAccount, 'identity_hash' | 'client_snapshot_ref' | 'checkin_credential_ref'>;
export interface AccountOperation {
  id: string; batch_id: string | null; account_id: string | null; app_id: ManagedAppId; client_instance_id: string;
  operation: 'capture' | 'switch' | 'checkin' | 'restore';
  state: 'queued' | 'running' | 'succeeded' | 'already_done' | 'failed' | 'unknown' | 'recovery_required';
  stage: 'preflight' | 'stop' | 'snapshot' | 'validate_target' | 'write' | 'start' | 'verify' | 'rollback';
  safe_error_code: string | null; recovery_ref: string | null; created_at: number; started_at: number | null; finished_at: number | null;
  recovers_operation_id: string | null;
}
/** ACC-07：签到授权会话状态（凭据只在 vault，响应不含 ref/token） */
export type CheckinAuthorizationStatus = 'pending' | 'authorized' | 'failed' | 'expired';
export interface CheckinAuthorization {
  id: string; account_id: string; app_id: ManagedAppId; status: CheckinAuthorizationStatus;
  authorization_url: string | null; safe_error_code: string | null;
  created_at: number; updated_at: number; expires_at: number;
}
/** ACC-07：批次状态；profile_local_day 为本地时区日，明确不是官方服务日 */
export type CheckinBatchStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
/** ACC-07：逐账号结果；cancelled 表示未发起请求的排队项 */
export type CheckinBatchItemState = 'queued' | 'running' | 'succeeded' | 'already_done' | 'failed' | 'unknown' | 'cancelled';
export interface CheckinBatchItem {
  batch_id: string; account_id: string; seq: number; state: CheckinBatchItemState;
  operation_id: string | null; safe_error_code: string | null; updated_at: number;
}
export interface CheckinBatch {
  id: string; app_id: ManagedAppId; status: CheckinBatchStatus; total: number;
  profile_local_day: string | null; created_at: number; finished_at: number | null;
  items?: CheckinBatchItem[];
}
/**
 * ACC-07 能力矩阵。
 * - `capture_reason_code` / `switch_reason_code` / `checkin_reason_code`：按能力维度给原因，**新字段优先**；
 *   能力可用时为 `'OK'`。服务端恒填这三个字段；声明为可选只为兼容既有测试夹具与旧消费者。
 * - `reason_code`：向后兼容的顶层聚合值；capture 与 switch 均可用时取 `checkin_reason_code`，
 *   否则取 registry 的根因码（例如 CodeBuddy 的 `TARGET_KIND_UNCONFIRMED`）。
 * - `source`：`static` = 全部来自 registry 静态表；`derived` = 至少一项由注入 provider 推导（混合时以 derived 为准）。
 */
export interface AccountCapability {
  app_id: ManagedAppId; capture: boolean; switch: boolean; checkin: boolean;
  capture_reason_code?: string; switch_reason_code?: string; checkin_reason_code?: string;
  reason_code: string; source: 'derived' | 'static';
}
/**
 * 工作空间；`sort_order` 为展示顺序（服务端恒返回）。声明为可选：既有测试夹具与旧消费者构造 `Workspace`
 * 时不带该字段仍可编译，前端按 0 兜底。
 */
export interface Workspace { id: string; name: string; path: string; created_at: number; sort_order?: number }
export interface Issue {
  id: string; workspace_id: string; title: string; description: string;
  priority: Priority; labels: string[]; status: IssueStatus; sort_order: number;
  parent_issue_id: string | null;
  claimed_by: string | null; claimed_at: number | null; session_id: string | null;
  /** 截止日期 `YYYY-MM-DD`；无截止为 null（STATUS-1 新增列，服务端恒填） */
  due_date?: string | null;
  /** 截止时间 `HH:mm`（24h）；与 due_date 独立，无时间为 null */
  due_time?: string | null;
  /** 评论总数（查询时由 issue_comment 计数，非落库列） */
  comment_count: number;
  /**
   * 依赖计数（查询期由 issue_dependency 聚合，非落库列；服务端恒填）。
   * 声明为可选：既有测试夹具与旧消费者构造 `Issue` 时不带该字段仍可编译，消费端按 0/true 兜底。
   * `resolved` = 无未解除前置（无前置时为 true），与 `apps/server/src/services/dependency.ts` 的唯一口径一致。
   */
  blocked_by_count?: number;
  blocked_by_open_count?: number;
  resolved?: boolean;
  created_at: number; updated_at: number;
}
/**
 * STATUS-2：工作区状态字典（`workspace_status`）。
 * `kind` 决定行为（关闭类 = `done` | `deprecated`），不靠名字；`is_builtin=1` 的内置状态不可删除、不可改名。
 */
export type WorkspaceStatusKind = 'open' | 'started' | 'review' | 'done' | 'deprecated';
export interface WorkspaceStatus {
  id: string; workspace_id: string; name: string; kind: WorkspaceStatusKind;
  sort_order: number; is_builtin: number;
}
export interface IssueTreeItem extends Issue {
  child_count: number;
  descendant_count: number;
  descendants_closed_count: number;
}
export interface IssueTreePage {
  items: IssueTreeItem[];
  ancestors: Issue[];
  next_cursor: string | null;
}
export interface AttachmentMetadata { id: string; file_name: string; mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; size_bytes: number; url: string; delivery_state?: 'pending' | 'sending' | 'unknown' | 'delivered' }
export interface DispatchAttachmentCandidate {
  id: string; comment_id: string; author: CommentAuthor; ts: number; snippet: string;
  file_name: string; mime_type: AttachmentMetadata['mime_type']; size_bytes: number;
  delivery_state: 'pending' | 'unknown';
}
export interface CommentAttachmentRecord { id: string; file_name: string; mime_type: AttachmentMetadata['mime_type']; size_bytes: number; delivery_state: NonNullable<AttachmentMetadata['delivery_state']> }
export interface IssueComment { id: string; issue_id: string; author: CommentAuthor; content: string; ts: number; attachments?: AttachmentMetadata[] }
export interface Session {
  id: string; workspace_id: string; issue_id: string | null; cli: string; model: string | null;
  status: SessionStatus; adapter_session_id: string | null; created_at: number;
  /** 运行时态（不入库）：sessions 接口返回时由服务端合并；WS session.changed 不携带 */
  queued_count?: number;
  waiting_slot?: boolean;
}
export interface Message { id: string; session_id: string; role: 'user' | 'assistant' | 'event' | 'error'; content: string; ts: number }
export interface CliInfo {
  id: string; displayName: string; installed: boolean; version: string | null;
  /** false=模型只读（由 CLI profile 配置决定，UI 禁用选择并标注，如 dsh） */
  supportsModelSelection: boolean;
}
export interface ModelInfo { id: string; source: 'probed' | 'static' | 'manual' }
export type WsEvent =
  | { type: 'issue.changed'; issue: Issue }
  | { type: 'issue.deleted'; issue_id: string; workspace_id: string }
  | { type: 'comment.added'; comment: IssueComment }
  | { type: 'comment.delivery.changed'; issue_id: string; comment_ids: string[] }
  | { type: 'session.changed'; session: Session }
  | { type: 'session.deleted'; session_id: string }
  | { type: 'session.event'; session_id: string; event: { type: 'text' | 'thinking' | 'tool' | 'error' | 'end'; [k: string]: unknown } }
  | { type: 'session.runtime'; session_id: string; queued_count: number; waiting_slot: boolean }
  | { type: 'message.added'; message: Message }
  | { type: 'clis.changed'; clis: CliInfo[] }
  | { type: 'account.notice'; app_id: ManagedAppId; client_instance_id: string; message: string };

/** 工作区变更日志类型；`历史` 仅由旧 CHANGELOG 导入写入，普通 UI/CLI 新增不可选 */
export type WorkspaceChangeType = '新增' | '修复' | '调整' | '历史';

/** 工作区变更日志条目；workspace 删除后 workspace_id 置空、origin 快照保留（归档） */
export interface WorkspaceChangeLog {
  id: string;
  workspace_id: string | null;
  origin_workspace_id: string;
  origin_workspace_name: string;
  origin_workspace_path: string;
  title: string;
  body_md: string;
  change_type: WorkspaceChangeType;
  occurred_at: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  revision: number;
  legacy_source_key: string | null;
}

/** 归档工作区摘要：仍有日志的已移除工作区快照与条数 */
export interface ArchivedWorkspaceChangeLogSummary {
  origin_workspace_id: string;
  origin_workspace_name: string;
  origin_workspace_path: string;
  entry_count: number;
  last_occurred_at: number;
}


// ---------------- 额度 / 余额（ACC-KB-A4：单一事实源） ----------------
// 服务端 `services/quotas/quotaService.ts` 与前端 `components/settings/QuotaCards.tsx` 都从这里取，
// 不再各抄一份字面量 union。新增来源（ACC-KB-B5）时同步更新 `QUOTA_SOURCE_IDS` / `QUOTA_SOURCE_LABEL`。

/** 额度来源 id */
export type QuotaSourceId = 'deepseek' | 'opencode_go' | 'codex';

/** 逐来源结果状态：ok 有数据、unsupported 该来源没有可用额度接口、error 本次取数失败 */
export type QuotaStatus = 'ok' | 'unsupported' | 'error';

/** 一个额度窗口（如 5h / weekly / monthly） */
export interface QuotaWindow {
  /** 窗口名，例如 `5h` / `weekly` / `monthly` */
  name: string;
  /** 剩余额度（与 balance 同单位） */
  remaining: number;
  /** 窗口重置时刻（epoch ms）；无窗口概念时为 null */
  reset_at: number | null;
  /** 已用百分比（0-100）；百分比类窗口才有，其余为 null */
  used_percent?: number | null;
}

/** 单个来源的额度/余额结果 */
export interface QuotaResult {
  source: QuotaSourceId;
  status: QuotaStatus;
  /** 余额/剩余额度；unsupported 或 error 时为 null */
  balance: number | null;
  /** 币种或单位：`CNY` / `USD` / null */
  unit: string | null;
  windows: QuotaWindow[];
  fetched_at: number;
  /** 机器码（前端负责中文文案；未知码进「技术码」） */
  reason_code: string | null;
  /** 服务端给出的中文短说明（不含 token/路径） */
  detail: string | null;
}

/** `GET /api/managed-account-quotas` 的响应体 */
export interface QuotaSnapshot {
  items: QuotaResult[];
  fetched_at: number;
  /** 前端带上工作区时会回显；其余情况缺省 */
  workspace_id?: string | null;
}