/**
 * STORE-2a：workspace localize（库下沉）REST 契约类型。
 * 消费方：apps/server（端点装配）与 packages/cli（2b）。字段名即契约；改字段先改这里。
 */

/** 固定阶段顺序（设计 §6.3）；`failed` 只作为伴随态出现在 lastError / localize.json */
export const WORKSPACE_LOCALIZE_STAGES = ['preflight', 'backup', 'create', 'copy', 'copy_attachments', 'verify', 'switch', 'finalize'] as const;
export type WorkspaceLocalizeStage = (typeof WORKSPACE_LOCALIZE_STAGES)[number];

/** job 生命周期：running → done | failed | already_localized（job 表只在内存，进程重启即失） */
export type WorkspaceLocalizeJobStatus = 'running' | 'done' | 'failed' | 'already_localized';

/** 终态语义：real run = localized | already_localized；dry-run = dry_run */
export type WorkspaceLocalizeJobResult = 'localized' | 'already_localized' | 'dry_run';

/** POST /api/workspaces/:id/db/localize 请求体 */
export interface WorkspaceLocalizeRequest {
  /** 只统计行数/附件/预计字节；不产生文件、不改中心库 */
  dryRun?: boolean;
  /** 目标库已存在或上次中断未 finalize 时，清理后重来 */
  overwrite?: boolean;
  /**
   * STORE-3a：从 `<ws>/.agentboard/localize.json` 记录的阶段继续上次中断的迁移。
   * dryRun=true 时忽略 resume；resume=true 时忽略 overwrite。
   */
  resume?: boolean;
}

/** GET /api/workspaces/:id/db/localize/:jobId 响应（POST 响应为其创建时快照） */
export interface WorkspaceLocalizeJobView {
  jobId: string;
  workspaceId: string;
  /** STORE-3a：任务类别；缺省 = localize（2a 响应向后兼容） */
  kind?: 'localize';
  dryRun: boolean;
  status: WorkspaceLocalizeJobStatus;
  /** running=当前阶段；done=finalize；failed=失败所在阶段；already_localized / dry-run 完成 = null */
  stage: WorkspaceLocalizeStage | null;
  /** 各表行数与附件统计（copy 阶段起逐步填充；dry-run 完成即全量计数） */
  counts: Record<string, number>;
  lastError: string | null;
  result: WorkspaceLocalizeJobResult | null;
  targetDbPath: string | null;
  /** 中心库一致性快照（VACUUM INTO）路径；dry-run / already_localized = null */
  backupPath: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** STORE-3a：cleanup / revert 共用的任务类别 */
export type WorkspaceDbOpKind = 'cleanup' | 'revert';

export type WorkspaceDbOpJobStatus = 'running' | 'done' | 'failed';

/** 终态语义：cleanup = cleaned；revert = reverted */
export type WorkspaceDbOpJobResult = 'cleaned' | 'reverted';

/** STORE-3a：POST /api/workspaces/:id/db/localize/{cleanup,revert} 响应（jobId 模型，与 localize 同一注册表） */
export interface WorkspaceDbOpJobView {
  jobId: string;
  workspaceId: string;
  kind: WorkspaceDbOpKind;
  status: WorkspaceDbOpJobStatus;
  /** cleanup = null；revert running=当前阶段，done=finalize，failed=失败所在阶段 */
  stage: string | null;
  counts: Record<string, number>;
  lastError: string | null;
  result: WorkspaceDbOpJobResult | null;
  /** revert 成功后工作区库移入 `<ws>/.agentboard/backup/` 的路径；cleanup = null */
  backupPath: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** STORE-3a：GET /api/workspaces/:id/db 响应（工作区库状态只读汇总） */
export interface WorkspaceDbStatusView {
  workspaceId: string;
  /** 中心库 workspace.db_mode（期望态） */
  dbMode: 'center' | 'localizing' | 'localized' | 'failed';
  /** 写闸门：frozen = 该区写请求当前会 409 WORKSPACE_DB_MIGRATING */
  writeGate: 'open' | 'frozen';
  /** AGENTBOARD_WORKSPACE_DB=disabled 紧急开关当前生效 */
  disabled: boolean;
  /** disabled 且 db_mode=localized：已下沉区被临时回退中心库，需 revert 收口（不静默回退） */
  needsRevert: boolean;
  centerDbPath: string;
  /** `<ws>/.agentboard/agentboard.db`；工作区 path 缺失时为 null */
  workspaceDbPath: string | null;
  workspaceDbExists: boolean;
  /** 解析层判定后请求实际落库的路径（含 disabled 语义） */
  effectiveDbPath: string;
  /** 数据所在库的逐表行数 + rows_total（当前数据归属：已下沉且可打开 → 工作区库，否则中心库） */
  counts: Record<string, number>;
  /** 附件：rows=attachment 行数；files/bytes=该区 storage_key 在数据归属侧附件目录的实际文件 */
  attachments: { rows: number; files: number; bytes: number; dir: string };
  /**
   * 快照落后条数（分模式语义，均为「中心库与工作区库快照的分叉行数」）：
   * localized = 中心库该区残留行数（干净态 0；>0 即 disabled/回写类分叉，revert 会拒绝）；
   * localizing/failed = Σ max(0, 中心−工作区库)（快照未拷齐的部分）；
   * 工作区库不可打开或不存在（未下沉）= null。
   */
  snapshotLagRows: number | null;
  /** `<ws>/.agentboard/localize.json` 中间态（排障/resume 依据）；无 = null */
  localizeState: {
    migrationId: string;
    stage: string;
    lastError: string | null;
    backupPath: string | null;
    startedAt: number;
  } | null;
  /** 本进程内该工作区活动任务（localize/cleanup/revert）；无 = null */
  activeJob: { jobId: string; kind: string; status: string; stage: string | null } | null;
  /** 解析层判定错误码（WORKSPACE_DB_MISSING / UNREADABLE / ID_MISMATCH / MIGRATING）；无 = null */
  error: string | null;
  /** 解析层一句话依据（排障） */
  reason: string;
}
