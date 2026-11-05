/**
 * STORE-2b：`kb workspace-db enable` —— 工作区库下沉（localize）的 CLI 通道。
 *
 * 只编排与渲染，不自研迁移逻辑：迁移在服务端八阶段状态机（STORE-2a）里跑，CLI 走 jobId 模型——
 * POST /api/workspaces/:id/db/localize 建任务（202 回创建时快照），GET .../localize/:jobId 轮询到终态。
 * 同步迁移会阻塞服务端事件循环，running 阶段轮询要有耐心：2s 间隔、总超时 10 分钟；
 * 超时不算失败（迁移可能仍在跑），提示保留 jobId 重查。
 * 退出码：0 成功（含 dry-run / already_localized 幂等回显）；2 冲突（409：迁移进行中 / 已下沉 / 目标库已存在等，
 * 服务端文案自解释，原样透出）；1 其余（failed job、404、超时、400 参数类——沿用全局口径，400 不单独用 3）。
 */
import { CommanderError } from 'commander';
import type { WorkspaceLocalizeJobView, WorkspaceLocalizeStage } from '@agentboard/shared';
import { WORKSPACE_LOCALIZE_STAGES } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';

/** 默认轮询口径：2s 间隔、总超时 10 分钟（迁移阻塞事件循环时 GET 可能很慢，不能短轮询） */
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** 服务端 WORKSPACE_LOCALIZE_STAGES 词表的中文阶段名（顺序沿用该词表） */
const STAGE_LABELS: Record<WorkspaceLocalizeStage, string> = {
  preflight: '预检',
  backup: '备份中心库',
  create: '创建工作区库',
  copy: '复制数据',
  copy_attachments: '复制附件',
  verify: '校验',
  switch: '切换读写',
  finalize: '收尾',
};

const stageLabel = (stage: WorkspaceLocalizeStage | null): string =>
  stage === null ? '（无）' : `${STAGE_LABELS[stage] ?? stage}（${stage}）`;

const stageIndex = (stage: WorkspaceLocalizeStage | null): number =>
  stage === null ? 0 : WORKSPACE_LOCALIZE_STAGES.indexOf(stage) + 1;

/** 字节人性化（B/KB/MB/GB，1 位小数截尾） */
function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

/** 行类计数键：真实迁移与 dry-run 的 counts 键集不一致（真实跑无 rows_total，且用 workspace_change_log），汇总时兼容两侧 */
const ROW_COUNT_KEYS = [
  'issue', 'issue_comment', 'session', 'message', 'issue_dependency', 'issue_git_baseline', 'issue_draft_audit',
  'attachment', 'knowledge_page', 'knowledge_revision', 'knowledge_link', 'knowledge_attachment',
  'workspace_status', 'change_log', 'workspace_change_log',
] as const;

/** 汇总段：行数合计 / 主要表 / 附件 / 预计数据量；缺失的聚合键（真实迁移无 bytes/estimated）按现状省略不硬编 0 */
function countsLines(job: WorkspaceLocalizeJobView): string[] {
  const c = job.counts;
  const rowsTotal = typeof c['rows_total'] === 'number'
    ? c['rows_total']
    : ROW_COUNT_KEYS.reduce((sum, key) => sum + (typeof c[key] === 'number' ? c[key]! : 0), 0);
  const parts = ([
    ['issue', '卡'], ['issue_comment', '评论'], ['session', '会话'], ['message', '消息'],
  ] as const).flatMap(([key, label]) => (typeof c[key] === 'number' ? [`${label} ${c[key]}`] : []));
  const lines = [`行数合计：${rowsTotal}${parts.length === 0 ? '' : `（${parts.join('、')}）`}`];
  if (typeof c['attachment_files'] === 'number') {
    lines.push(`附件：${c['attachment_files']} 个${typeof c['attachment_bytes'] === 'number' ? `（${formatBytes(c['attachment_bytes'])}）` : ''}`);
  }
  if (typeof c['estimated_bytes'] === 'number') lines.push(`预计迁移数据量：约 ${formatBytes(c['estimated_bytes'])}`);
  if (job.targetDbPath !== null) lines.push(`目标库：${job.targetDbPath}`);
  return lines;
}

export interface WorkspaceDbEnableArgs {
  dryRun?: boolean;
  overwrite?: boolean;
  /** 测试注入：轮询间隔（缺省 2s） */
  pollMs?: number;
  /** 测试注入：轮询总超时（缺省 10 分钟） */
  timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 轮询到终态；running 阶段逐次渲染进度行（阶段变化才打一行），超时抛错并保留 jobId */
async function waitForTerminal(
  ctx: Ctx,
  started: WorkspaceLocalizeJobView,
  pollMs: number,
  timeoutMs: number,
): Promise<WorkspaceLocalizeJobView> {
  let job = started;
  if (job.status !== 'running') return job;
  const path = `/api/workspaces/${encodeURIComponent(job.workspaceId)}/db/localize/${encodeURIComponent(job.jobId)}`;
  const progress = (text: string): void => { (ctx.json ? ctx.io.writeErr : ctx.io.write)(`${text}\n`); };
  progress(`迁移已受理（jobId ${job.jobId}），轮询进度中（每 ${Math.round(pollMs / 100) / 10}s 一次，最长 ${Math.round(timeoutMs / 60000)} 分钟）…`);
  let lastStage: WorkspaceLocalizeStage | null = null;
  // 同步迁移阻塞服务端事件循环时轮询会慢；网络层偶发抖动容忍连续重试，连不上才算失败
  let transientErrors = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `迁移超时：已等待 ${Math.round(timeoutMs / 60000)} 分钟仍未见终态（最后阶段：${stageLabel(lastStage)}）。`
        + `迁移可能仍在服务端进行；jobId ${job.jobId} 可用 GET ${ctx.base}${path} 重查，完成后重跑本命令会回显 already_localized`,
      );
    }
    await sleep(pollMs);
    try {
      job = await request<WorkspaceLocalizeJobView>(ctx.base, 'GET', path);
      transientErrors = 0;
    } catch (error) {
      // CliHttpError 是服务端明确应答（404 任务表丢失等）直接上抛；其余当网络抖动容忍
      if (error instanceof CliHttpError) throw error;
      transientErrors += 1;
      if (transientErrors > 15) {
        throw new Error(`迁移进度查询连续失败（jobId ${job.jobId}）：${error instanceof Error ? error.message : String(error)}；请确认服务端存活后用 GET ${ctx.base}${path} 重查`);
      }
      continue;
    }
    if (job.status !== 'running') return job;
    if (job.stage !== lastStage) {
      progress(`迁移进行中 [${stageIndex(job.stage)}/${WORKSPACE_LOCALIZE_STAGES.length}] ${stageLabel(job.stage)}`);
      lastStage = job.stage;
    }
  }
}

/** 终态渲染 + 退出码；--json 模式统一输出 JobView 原文 */
function renderTerminal(ctx: Ctx, job: WorkspaceLocalizeJobView): number {
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(job, null, 2)}\n`);
  } else if (job.status === 'failed') {
    ctx.io.writeErr(`迁移失败（失败阶段：${stageLabel(job.stage)}）：${job.lastError ?? '服务端未给出原因'}\n`);
    ctx.io.writeErr(`jobId ${job.jobId}；排查后重跑请评估是否需要 --overwrite\n`);
  } else if (job.status === 'already_localized') {
    ctx.io.write('该工作区已启用工作区库（already_localized），未做任何变更，无需重复启用\n');
  } else if (job.dryRun) {
    ctx.io.write('dry-run 完成：未产生任何变更（中心库未动、未创建任何文件）\n');
    ctx.io.write(`${countsLines(job).join('\n')}\n`);
  } else {
    ctx.io.write('迁移完成：该工作区已启用工作区库（db_mode=localized），此后该工作区读写走独享库\n');
    ctx.io.write(`${countsLines(job).join('\n')}\n`);
    if (job.backupPath !== null) ctx.io.write(`中心库一致性快照（回滚备用）：${job.backupPath}\n`);
  }
  return job.status === 'failed' ? 1 : 0;
}

/** kb workspace-db enable <workspace> [--dry-run] [--overwrite] */
export async function workspaceDbEnable(ctx: Ctx, workspace: string, args: WorkspaceDbEnableArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const body: Record<string, boolean> = {};
  if (args.dryRun === true) body.dryRun = true;
  if (args.overwrite === true) body.overwrite = true;
  const started = await request<WorkspaceLocalizeJobView>(
    ctx.base, 'POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/db/localize`, body,
  ).catch((error: unknown) => {
    // 文本模式下 409 冲突原样透出退出 2（--json 交给全局出口）
    if (!ctx.json && error instanceof CliHttpError && error.status === 409) {
      ctx.io.writeErr(`${error.message}\n`);
      throw new CommanderError(2, 'agentboard.workspace_db', '');
    }
    throw error;
  });
  const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = args.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const final = await waitForTerminal(ctx, started, pollMs, timeoutMs);
  const exitCode = renderTerminal(ctx, final);
  if (exitCode !== 0) throw new CommanderError(exitCode, 'agentboard.workspace_db', '');
}
