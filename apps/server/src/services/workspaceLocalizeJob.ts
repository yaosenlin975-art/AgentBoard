/**
 * STORE-2a：localize 任务表（REST jobId 模型，进程内存态）。
 *
 * - POST 建任务立即返回 jobId，八阶段状态机在后台跑（每工作区同一时间只允许一个 running 任务；
 *   跨进程互斥由 localize.json + preflight 的 MIGRATION_BUSY 兜底）；
 * - GET 按 jobId 读阶段/计数/last_error；阶段经 onStage 钩子实时回填；
 * - 任务表不落盘：跨进程事实源是 `<ws>/.agentboard/localize.json` 与工作区库 meta，
 *   进程重启后旧 jobId 查不到 → 404，客户端以 localize.json 为准。
 * - dry-run 走同一 jobId 模型（统一契约），只是任务体换成只读统计。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { WorkspaceLocalizeJobView } from '@agentboard/shared';
import { dryRunLocalize, localizeError, type PreflightLocalizeInput } from './workspaceLocalize.js';
import { localizeWorkspace, type LocalizeDeps } from './workspaceLocalizeRun.js';

const jobs = new Map<string, WorkspaceLocalizeJobView>();

export interface StartLocalizeJobInput {
  workspaceId: string;
  dryRun: boolean;
  overwrite: boolean;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`；测试注入） */
  attachmentsDir?: string;
}

/** 创建并启动一次 localize/dry-run 任务；同步部分只做互斥检查，失败即抛（POST 直接回 4xx/5xx） */
export function startLocalizeJob(centerDb: Db, input: StartLocalizeJobInput): WorkspaceLocalizeJobView {
  for (const job of jobs.values()) {
    if (job.workspaceId === input.workspaceId && job.status === 'running') {
      throw localizeError('MIGRATION_BUSY', `本进程已有任务 ${job.jobId} 在跑`);
    }
  }
  const job: WorkspaceLocalizeJobView = {
    jobId: `loc-${randomUUID().slice(0, 8)}`,
    workspaceId: input.workspaceId,
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
  void runJob(centerDb, job, input).catch(() => { /* runJob 内部已兜底落 failed，这里不再抛 */ });
  return job;
}

/** 按（工作区, jobId）读任务；不存在或不属于该工作区 → null（端点回 404） */
export function getLocalizeJob(workspaceId: string, jobId: string): WorkspaceLocalizeJobView | null {
  const job = jobs.get(jobId);
  if (job === undefined || job.workspaceId !== workspaceId) return null;
  return job;
}

/** 测试用：清空任务表 */
export function resetLocalizeJobs(): void {
  jobs.clear();
}

async function runJob(centerDb: Db, job: WorkspaceLocalizeJobView, input: StartLocalizeJobInput): Promise<void> {
  const deps: PreflightLocalizeInput & LocalizeDeps = {
    workspaceId: input.workspaceId,
    overwrite: input.overwrite,
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
  } finally {
    job.finishedAt = Date.now();
  }
}
