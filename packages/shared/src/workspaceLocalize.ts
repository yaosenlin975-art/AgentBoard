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
}

/** GET /api/workspaces/:id/db/localize/:jobId 响应（POST 响应为其创建时快照） */
export interface WorkspaceLocalizeJobView {
  jobId: string;
  workspaceId: string;
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
