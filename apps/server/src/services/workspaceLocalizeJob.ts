/**
 * STORE-2a/3a：工作区库操作任务表（REST jobId 模型，进程内存态）。
 *
 * - POST 建任务立即返回 jobId，状态机在后台跑（每工作区同一时间只允许一个 running 任务，
 *   localize/cleanup/revert 共用同一互斥）；GET 按 jobId 读阶段/计数/last_error，阶段经 onStage 实时回填；
 * - 任务表不落盘：跨进程事实源是 `<ws>/.agentboard/localize.json` 与工作区库 meta，
 *   进程重启后旧 jobId 查不到 → 404，客户端以 localize.json 为准（resume 亦以它为落点）；
 * - dry-run 走同一 jobId 模型（统一契约），只是任务体换成只读统计；
 * - STORE-3a：写闸门生命周期兜底——job 到终态时中心库不得残留 localizing
 *   （正常由状态机落 failed/localized；状态机 catch 之外的逃逸在此补刀 failed）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { WorkspaceDbOpJobView, WorkspaceDbOpKind, WorkspaceLocalizeJobView } from '@agentboard/shared';
import { dryRunLocalize, localizeError, type PreflightLocalizeInput } from './workspaceLocalize.js';
import { localizeWorkspace, type LocalizeDeps } from './workspaceLocalizeRun.js';
import { cleanupWorkspaceDbRemnants, revertWorkspace, type WorkspaceDbOpDeps } from './workspaceDbOps.js';

type AnyJob = WorkspaceLocalizeJobView | WorkspaceDbOpJobView;

const jobs = new Map<string, AnyJob>();

export interface StartLocalizeJobInput {
  workspaceId: string;
  dryRun: boolean;
  overwrite: boolean;
  /** STORE-3a：从 localize.json 的 stage 续跑 */
  resume?: boolean;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`；测试注入） */
  attachmentsDir?: string;
}

export interface StartWorkspaceDbOpJobInput {
  workspaceId: string;
  kind: WorkspaceDbOpKind;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`；测试注入） */
  attachmentsDir?: string;
}

const jobKind = (job: AnyJob): string => job.kind ?? 'localize';

/** 每工作区互斥：同一时间只允许一个 running 任务（不分 kind） */
function assertNoRunningJob(workspaceId: string): void {
  for (const job of jobs.values()) {
    if (job.workspaceId === workspaceId && job.status === 'running') {
      throw localizeError('MIGRATION_BUSY', `本进程已有任务 ${job.jobId}（${jobKind(job)}）在跑`);
    }
  }
}

/** 创建并启动一次 localize/dry-run 任务；同步部分只做互斥检查，失败即抛（POST 直接回 4xx/5xx） */
export function startLocalizeJob(centerDb: Db, input: StartLocalizeJobInput): WorkspaceLocalizeJobView {
  assertNoRunningJob(input.workspaceId);
  const job: WorkspaceLocalizeJobView = {
    jobId: `loc-${randomUUID().slice(0, 8)}`,
    workspaceId: input.workspaceId,
    kind: 'localize',
    dryRun: input.dryRun,
    status: 'running',
    stage: 'preflight',
    counts: {},
    lastError: null,
    result: null,
    targetDbPath: null,
    backupPath: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.jobId, job);
  void runLocalizeJob(centerDb, job, input).catch(() => { /* runLocalizeJob 内部已兜底落 failed，这里不再抛 */ });
  return job;
}

/** STORE-3a：创建并启动一次 cleanup/revert 任务（与 localize 同表互斥） */
export function startWorkspaceDbOpJob(centerDb: Db, input: StartWorkspaceDbOpJobInput): WorkspaceDbOpJobView {
  assertNoRunningJob(input.workspaceId);
  const job: WorkspaceDbOpJobView = {
    jobId: `${input.kind}-${randomUUID().slice(0, 8)}`,
    workspaceId: input.workspaceId,
    kind: input.kind,
    status: 'running',
    stage: input.kind === 'cleanup' ? null : 'preflight',
    counts: {},
    lastError: null,
    result: null,
    backupPath: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.jobId, job);
  void runOpJob(centerDb, job, input).catch(() => { /* runOpJob 内部已兜底落 failed */ });
  return job;
}

/** 按（工作区, jobId）读任务；不存在或不属于该工作区 → null（端点回 404） */
export function getLocalizeJob(workspaceId: string, jobId: string): AnyJob | null {
  const job = jobs.get(jobId);
  if (job === undefined || job.workspaceId !== workspaceId) return null;
  return job;
}

/** 该工作区当前活动任务（status 可观测；无 = null） */
export function getActiveWorkspaceDbJob(workspaceId: string): WorkspaceLocalizeJobView | WorkspaceDbOpJobView | null {
  for (const job of jobs.values()) {
    if (job.workspaceId === workspaceId && job.status === 'running') return job;
  }
  return null;
}

/** 测试用：清空任务表 */
export function resetLocalizeJobs(): void {
  jobs.clear();
}

/** STORE-3a 闸门兜底：job 终态后中心库不得残留 localizing（正常由状态机落 failed/localized） */
function releaseGateIfStuck(centerDb: Db, workspaceId: string): void {
  try {
    const row = centerDb.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(workspaceId) as { db_mode?: string } | undefined;
    if (row?.db_mode === 'localizing') centerDb.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(workspaceId);
  } catch { /* 中心库都写不进时无从兜底，保留现场 */ }
}

async function runLocalizeJob(centerDb: Db, job: WorkspaceLocalizeJobView, input: StartLocalizeJobInput): Promise<void> {
  const deps: PreflightLocalizeInput & LocalizeDeps = {
    workspaceId: input.workspaceId,
    overwrite: input.overwrite,
    ...(input.resume === true ? { resume: true } : {}),
    ...(input.attachmentsDir !== undefined ? { attachmentsDir: input.attachmentsDir } : {}),
    // 阶段实时回填（counts 是状态机内部同一对象，copy 阶段起逐步填充）
    onStage: (stage, state) => {
      job.stage = stage;
      job.counts = state.counts;
    },
  };
  try {
    if (input.dryRun) {
      const result = await dryRunLocalize(centerDb, deps);
      job.counts = { ...result.counts };
      job.targetDbPath = result.targetDbPath;
      job.result = 'dry_run';
      job.status = 'done';
      job.stage = null;
    } else {
      const result = await localizeWorkspace(centerDb, deps, deps);
      job.counts = { ...result.counts };
      job.targetDbPath = result.target_db_path;
      job.backupPath = result.backup_path;
      job.result = result.state;
      job.status = result.state === 'already_localized' ? 'already_localized' : 'done';
      // already_localized 没跑任何阶段；正常完成停在 finalize
      job.stage = result.state === 'already_localized' ? null : 'finalize';
    }
  } catch (error) {
    job.status = 'failed';
    job.lastError = error instanceof Error ? error.message : String(error);
    // job.stage 保持 onStage 停下的位置 = 失败所在阶段
    releaseGateIfStuck(centerDb, input.workspaceId);
  } finally {
    job.finishedAt = Date.now();
  }
}

async function runOpJob(centerDb: Db, job: WorkspaceDbOpJobView, input: StartWorkspaceDbOpJobInput): Promise<void> {
  const deps: WorkspaceDbOpDeps = {
    ...(input.attachmentsDir !== undefined ? { attachmentsDir: input.attachmentsDir } : {}),
    onStage: (stage) => { job.stage = stage; },
  };
  try {
    if (input.kind === 'cleanup') {
      const result = cleanupWorkspaceDbRemnants(centerDb, { workspaceId: input.workspaceId }, deps);
      job.counts = { center_rows_before: result.center_rows_before, removed: result.removed.length };
      job.result = 'cleaned';
      job.status = 'done';
      job.stage = null;
    } else {
      const result = await revertWorkspace(centerDb, { workspaceId: input.workspaceId }, deps);
      job.counts = { ...result.counts };
      job.backupPath = result.backup_path;
      job.result = 'reverted';
      job.status = 'done';
      job.stage = 'finalize';
    }
  } catch (error) {
    job.status = 'failed';
    job.lastError = error instanceof Error ? error.message : String(error);
    job.stage = null;
    releaseGateIfStuck(centerDb, input.workspaceId);
  } finally {
    job.finishedAt = Date.now();
  }
}
