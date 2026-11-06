/**
 * STORE-2b/3b：`kb workspace-db enable|status|cleanup|revert` —— 工作区库下沉（localize）的 CLI 通道。
 *
 * 只编排与渲染，不自研迁移逻辑：迁移 / 清理 / 回迁都在服务端状态机里跑，CLI 走 jobId 模型——
 * POST 建任务（202 回创建时快照），GET /api/workspaces/:id/db/localize/:jobId 轮询到终态（三类任务同一张任务表）。
 * 同步迁移会阻塞服务端事件循环，running 阶段轮询要有耐心：2s 间隔、总超时 10 分钟；
 * 超时不算失败（任务可能仍在跑），提示保留 jobId 重查。
 * 退出码：0 成功（含 dry-run / already_localized 幂等回显、status 查询）；2 冲突（POST 409：任务进行中等，
 * 服务端文案自解释，原样透出；cleanup 无可清理的半成品）；1 其余（failed job、404、超时、400 参数类——沿用全局口径，400 不单独用 3）。
 * STORE-4e：失败判定一律按 JobView.errorCode（机器可读）判定，不再依赖服务端文案（如 NOTHING_TO_CLEAN）；文本失败行附错误码。
 */
import { CommanderError } from 'commander';
import type { WorkspaceDbOpJobView, WorkspaceDbStatusView, WorkspaceLocalizeJobView } from '@agentboard/shared';
import { WORKSPACE_LOCALIZE_STAGES } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';

/** 默认轮询口径：2s 间隔、总超时 10 分钟（迁移阻塞事件循环时 GET 可能很慢，不能短轮询） */
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** 一类任务的渲染口径：动作名、进度词表（[i/N]）、中文阶段名、超时后的补充指引 */
interface JobProfile {
  action: string;
  stages: readonly string[];
  labels: Readonly<Record<string, string>>;
  timeoutHint: (workspaceId: string) => string;
}

const statusHint = (workspaceId: string): string => `完成后用 kb workspace-db status --workspace ${workspaceId} 核对模式`;

/** localize：服务端 WORKSPACE_LOCALIZE_STAGES 词表的中文阶段名（顺序沿用该词表） */
const LOCALIZE: JobProfile = {
  action: '迁移',
  stages: WORKSPACE_LOCALIZE_STAGES,
  labels: {
    preflight: '预检',
    backup: '备份中心库',
    create: '创建工作区库',
    copy: '复制数据',
    copy_attachments: '复制附件',
    verify: '校验',
    switch: '切换读写',
    finalize: '收尾',
  },
  timeoutHint: () => '完成后重跑本命令会回显 already_localized',
};

/** revert：服务端 REVERT_STAGES 四阶段（shared 未导出该词表，按契约固定） */
const REVERT: JobProfile = {
  action: '回迁',
  stages: ['preflight', 'copy_attachments_back', 'copy_back', 'finalize'],
  labels: { preflight: '预检', copy_attachments_back: '回拷附件', copy_back: '回拷数据', finalize: '收尾' },
  timeoutHint: statusHint,
};

/** cleanup：无阶段（stage 恒为 null） */
const CLEANUP: JobProfile = { action: '清理', stages: [], labels: {}, timeoutHint: statusHint };

const stageLabel = (profile: JobProfile, stage: string | null): string =>
  stage === null ? '（无）' : `${profile.labels[stage] ?? stage}（${stage}）`;

const stageIndex = (profile: JobProfile, stage: string | null): number =>
  stage === null ? 0 : profile.stages.indexOf(stage) + 1;

/** STORE-4e：failed 文本行的错误码段（errorCode 缺省 / null 时不渲染，兼容旧服务端） */
const errorCodeTag = (code: string | null | undefined): string => (code ? `，错误码 ${code}` : '');

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

/** 行类计数键：STORE-4e 起两侧键集已统一（workspace_change_log）；change_log 为旧服务端兼容保留 */
const ROW_COUNT_KEYS = [
  'issue', 'issue_comment', 'session', 'message', 'issue_dependency', 'issue_git_baseline', 'issue_draft_audit',
  'attachment', 'knowledge_page', 'knowledge_revision', 'knowledge_link', 'knowledge_attachment',
  'workspace_status', 'change_log', 'workspace_change_log',
] as const;

/** 行数合计行：优先 rows_total，缺省按行类键求和；附主要表明细（缺键省略不硬编 0） */
function rowsTotalLine(label: string, c: Record<string, number>): string {
  const rowsTotal = typeof c['rows_total'] === 'number'
    ? c['rows_total']
    : ROW_COUNT_KEYS.reduce((sum, key) => sum + (typeof c[key] === 'number' ? c[key]! : 0), 0);
  const parts = ([
    ['issue', '卡'], ['issue_comment', '评论'], ['session', '会话'], ['message', '消息'],
  ] as const).flatMap(([key, name]) => (typeof c[key] === 'number' ? [`${name} ${c[key]}`] : []));
  return `${label}：${rowsTotal}${parts.length === 0 ? '' : `（${parts.join('、')}）`}`;
}

/** 汇总段：行数合计 / 主要表 / 附件 / 数据量；键集已统一（STORE-4e），缺键（旧服务端 / already_localized 补账）省略不硬编 0 */
function countsLines(job: WorkspaceLocalizeJobView): string[] {
  const c = job.counts;
  const lines = [rowsTotalLine('行数合计', c)];
  if (typeof c['attachment_files'] === 'number') {
    lines.push(`附件：${c['attachment_files']} 个${typeof c['attachment_bytes'] === 'number' ? `（${formatBytes(c['attachment_bytes'])}）` : ''}`);
  }
  if (typeof c['estimated_bytes'] === 'number') {
    lines.push(`${job.dryRun ? '预计迁移数据量' : '迁移落盘数据量'}：约 ${formatBytes(c['estimated_bytes'])}`);
  }
  if (job.targetDbPath !== null) lines.push(`目标库：${job.targetDbPath}`);
  return lines;
}

/** 测试注入：轮询间隔（缺省 2s）/ 轮询总超时（缺省 10 分钟） */
export interface WorkspaceDbPollArgs {
  pollMs?: number;
  timeoutMs?: number;
}

export interface WorkspaceDbEnableArgs extends WorkspaceDbPollArgs {
  dryRun?: boolean;
  overwrite?: boolean;
  /** STORE-3b：从 localize.json 记录的阶段续跑（dry-run 时服务端忽略 resume；resume 时服务端忽略 overwrite） */
  resume?: boolean;
}

/** 三类任务视图（localize / cleanup / revert）共有的轮询面 */
interface PolledJob {
  jobId: string;
  workspaceId: string;
  status: string;
  stage: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const dbPath = (workspaceId: string): string => `/api/workspaces/${encodeURIComponent(workspaceId)}/db`;

/** 进度/提示行：文本模式写 stdout，--json 模式写 stderr（不污染 stdout 的 JSON） */
const progressWriter = (ctx: Ctx) => (text: string): void => { (ctx.json ? ctx.io.writeErr : ctx.io.write)(`${text}\n`); };

const writeJson = (ctx: Ctx, value: unknown): void => { ctx.io.write(`${JSON.stringify(value, null, 2)}\n`); };

const exitWith = (code: number): void => {
  if (code !== 0) throw new CommanderError(code, 'agentboard.workspace_db', '');
};

/** POST 建任务；文本模式下 409 冲突写 stderr 退出 2（默认原样透出服务端自解释文案），--json 交给全局出口 */
async function postJob<T>(
  ctx: Ctx,
  path: string,
  body: Record<string, unknown>,
  conflictText: (error: CliHttpError) => string = error => error.message,
): Promise<T> {
  try {
    return await request<T>(ctx.base, 'POST', path, body);
  } catch (error) {
    if (!ctx.json && error instanceof CliHttpError && error.status === 409) {
      ctx.io.writeErr(`${conflictText(error)}\n`);
      throw new CommanderError(2, 'agentboard.workspace_db', '');
    }
    throw error;
  }
}

/** 轮询到终态；running 阶段逐次渲染进度行（阶段变化才打一行），超时抛错并保留 jobId */
async function waitForTerminal<T extends PolledJob>(
  ctx: Ctx,
  started: T,
  profile: JobProfile,
  pollMs: number,
  timeoutMs: number,
): Promise<T> {
  let job = started;
  if (job.status !== 'running') return job;
  const path = `${dbPath(job.workspaceId)}/localize/${encodeURIComponent(job.jobId)}`;
  const progress = progressWriter(ctx);
  progress(`${profile.action}已受理（jobId ${job.jobId}），轮询进度中（每 ${Math.round(pollMs / 100) / 10}s 一次，最长 ${Math.round(timeoutMs / 60000)} 分钟）…`);
  let lastStage: string | null = null;
  // 同步任务阻塞服务端事件循环时轮询会慢；网络层偶发抖动容忍连续重试，连不上才算失败
  let transientErrors = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${profile.action}超时：已等待 ${Math.round(timeoutMs / 60000)} 分钟仍未见终态（最后阶段：${stageLabel(profile, lastStage)}）。`
        + `${profile.action}可能仍在服务端进行；jobId ${job.jobId} 可用 GET ${ctx.base}${path} 重查，${profile.timeoutHint(job.workspaceId)}`,
      );
    }
    await sleep(pollMs);
    try {
      job = await request<T>(ctx.base, 'GET', path);
      transientErrors = 0;
    } catch (error) {
      // CliHttpError 是服务端明确应答（404 任务表丢失等）直接上抛；其余当网络抖动容忍
      if (error instanceof CliHttpError) throw error;
      transientErrors += 1;
      if (transientErrors > 15) {
        throw new Error(`${profile.action}进度查询连续失败（jobId ${job.jobId}）：${error instanceof Error ? error.message : String(error)}；请确认服务端存活后用 GET ${ctx.base}${path} 重查`);
      }
      continue;
    }
    if (job.status !== 'running') return job;
    if (job.stage !== lastStage) {
      if (job.stage !== null && profile.stages.length > 0) {
        progress(`${profile.action}进行中 [${stageIndex(profile, job.stage)}/${profile.stages.length}] ${stageLabel(profile, job.stage)}`);
      }
      lastStage = job.stage;
    }
  }
}

/** localize 终态渲染 + 退出码；--json 模式统一输出 JobView 原文 */
function renderLocalize(ctx: Ctx, job: WorkspaceLocalizeJobView): number {
  if (ctx.json) {
    writeJson(ctx, job);
  } else if (job.status === 'failed') {
    ctx.io.writeErr(`迁移失败（失败阶段：${stageLabel(LOCALIZE, job.stage)}${errorCodeTag(job.errorCode)}）：${job.lastError ?? '服务端未给出原因'}\n`);
    ctx.io.writeErr(job.dryRun
      ? `jobId ${job.jobId}；dry-run 未产生任何变更，排查后可直接重跑\n`
      : `jobId ${job.jobId}；先 kb workspace-db status --workspace ${job.workspaceId} 查看中间态，再选：enable --resume 从中断阶段继续 / cleanup --workspace ${job.workspaceId} 清理半成品 / enable --overwrite 清理后重来\n`);
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

/**
 * --resume 的续跑落点：读 localize.json 中间态（GET .../db 的 localizeState.stage）。
 * 不取 job 视图的 stage：POST 快照恒为 preflight，同步段可能在首轮轮询前已跑完；
 * 读不到按 null（无中间态时服务端会以 NO_LOCALIZE_STATE 失败，由终态渲染透出）。
 */
async function readResumeStage(base: string, workspaceId: string): Promise<string | null> {
  try {
    const status = await request<WorkspaceDbStatusView>(base, 'GET', dbPath(workspaceId));
    return status.localizeState?.stage ?? null;
  } catch {
    return null;
  }
}

/** kb workspace-db enable <workspace> [--dry-run] [--overwrite] [--resume] */
export async function workspaceDbEnable(ctx: Ctx, workspace: string, args: WorkspaceDbEnableArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const body: Record<string, boolean> = {};
  if (args.dryRun === true) body.dryRun = true;
  if (args.overwrite === true) body.overwrite = true;
  if (args.resume === true) body.resume = true;
  // dry-run 优先于 resume（服务端忽略 resume），此时不提示续跑阶段
  const resumeStage = args.resume === true && args.dryRun !== true ? await readResumeStage(ctx.base, workspaceId) : null;
  const started = await postJob<WorkspaceLocalizeJobView>(ctx, `${dbPath(workspaceId)}/localize`, body);
  if (resumeStage !== null) progressWriter(ctx)(`从${stageLabel(LOCALIZE, resumeStage)}阶段继续（localize.json 记录的中断点）`);
  const final = await waitForTerminal(ctx, started, LOCALIZE, args.pollMs ?? DEFAULT_POLL_MS, args.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  exitWith(renderLocalize(ctx, final));
}

const MODE_LABELS: Readonly<Record<string, string>> = { center: '中心库', localizing: '迁移中', localized: '已下沉', failed: '失败' };

/** 紧急开关 + 已下沉：数据只在工作区库里，服务端不静默回退，必须 revert 收口 */
const NEEDS_REVERT_TEXT = '紧急开关已启用：该工作区数据在工作区库中，需 revert 才能回中心库';

function statusLines(s: WorkspaceDbStatusView): string[] {
  const id = s.workspaceId;
  const lines: string[] = [];
  if (s.disabled && s.needsRevert) lines.push(`【警告】${NEEDS_REVERT_TEXT}（kb workspace-db revert --workspace ${id}）`);
  lines.push(`工作区：${id}`);
  lines.push(`模式：${MODE_LABELS[s.dbMode] ?? s.dbMode}（${s.dbMode}）`);
  lines.push(s.writeGate === 'frozen' ? '写闸门：冻结（frozen，该区写请求返回 409 WORKSPACE_DB_MIGRATING）' : `写闸门：开放（${s.writeGate}）`);
  if (s.disabled) lines.push('紧急开关：已启用（AGENTBOARD_WORKSPACE_DB=disabled）');
  lines.push(`生效库：${s.effectiveDbPath}`);
  lines.push(`中心库：${s.centerDbPath}`);
  lines.push(s.workspaceDbPath === null
    ? '工作区库：无（工作区目录缺失）'
    : `工作区库：${s.workspaceDbPath}（${s.workspaceDbExists ? '存在' : '不存在'}）`);
  lines.push(rowsTotalLine('行数合计（数据所在库）', s.counts));
  lines.push(`附件：${s.attachments.rows} 行，文件 ${s.attachments.files} 个（${formatBytes(s.attachments.bytes)}），目录 ${s.attachments.dir}`);
  const lag = s.snapshotLagRows;
  if (lag === null) lines.push('快照落后：不适用（工作区库不存在或打不开）');
  else lines.push(`快照落后：${lag} 条${s.dbMode === 'localized' && lag > 0 ? '（中心库有该区残留行，revert 会拒绝，先核对分叉）' : ''}`);
  const state = s.localizeState;
  if (state === null) {
    lines.push('中间态（localize.json）：无');
  } else {
    lines.push(`中间态（localize.json）：阶段 ${stageLabel(LOCALIZE, state.stage)}，migrationId ${state.migrationId}`);
    if (state.lastError !== null) lines.push(`  lastError：${state.lastError}`);
    if (state.backupPath !== null) lines.push(`  中心库快照：${state.backupPath}`);
  }
  const job = s.activeJob;
  if (job === null) {
    lines.push('活动任务：无');
  } else {
    const stage = job.stage === null ? '' : `，阶段 ${stageLabel(job.kind === 'revert' ? REVERT : LOCALIZE, job.stage)}`;
    lines.push(`活动任务：${job.jobId}（${job.kind}，${job.status}${stage}）`);
  }
  lines.push(`解析：${s.reason}${s.error === null ? '' : `（${s.error}）`}`);
  if (s.dbMode === 'failed') {
    lines.push(`提示：迁移失败待恢复——kb workspace-db enable ${id} --resume 从中断阶段继续，或 kb workspace-db cleanup --workspace ${id} 清理半成品（中心库数据不动）`);
  }
  return lines;
}

/** kb workspace-db status [--workspace <id|名>]（缺省按 cwd 解析） */
export async function workspaceDbStatus(ctx: Ctx, workspace?: string): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const status = await request<WorkspaceDbStatusView>(ctx.base, 'GET', dbPath(workspaceId));
  if (ctx.json) {
    writeJson(ctx, status);
    if (status.disabled && status.needsRevert) ctx.io.writeErr(`${NEEDS_REVERT_TEXT}\n`);
    return;
  }
  ctx.io.write(`${statusLines(status).join('\n')}\n`);
}

/**
 * NOTHING_TO_CLEAN 识别：服务端在 job 内判定（202 + job failed）。STORE-4e 起 JobView 带 errorCode，
 * 按 WORKSPACE_DB_NOTHING_TO_CLEAN 判定，不再依赖服务端文案（文案一改即失效）；POST 同步 409 按同码识别。
 */
const NOTHING_TO_CLEAN_CODE = 'WORKSPACE_DB_NOTHING_TO_CLEAN';
const nothingToClean = (detail: string): string => `无可清理的半成品：${detail}`;

function renderCleanup(ctx: Ctx, job: WorkspaceDbOpJobView): number {
  const nothing = job.status === 'failed' && job.errorCode === NOTHING_TO_CLEAN_CODE;
  if (ctx.json) {
    writeJson(ctx, job);
  } else if (nothing) {
    ctx.io.writeErr(`${nothingToClean(job.lastError ?? '')}\n`);
  } else if (job.status === 'failed') {
    const codeSuffix = job.errorCode ? `（错误码 ${job.errorCode}）` : '';
    ctx.io.writeErr(`清理失败${codeSuffix}：${job.lastError ?? '服务端未给出原因'}\n`);
    ctx.io.writeErr(`jobId ${job.jobId}；中心库数据未动，可用 kb workspace-db status --workspace ${job.workspaceId} 核对后处理\n`);
  } else {
    const removed = job.counts['removed'] ?? 0;
    ctx.io.write(removed > 0
      ? `清理完成：已删除 ${removed} 项迁移半成品（工作区侧目标库 / 附件目录 / 残留快照 / localize.json），中心库数据未动\n`
      : '清理完成：无残留文件需删除，已释放写闸门\n');
    ctx.io.write('该工作区回到中心库读写（db_mode=center，写闸门开放）\n');
    if (typeof job.counts['center_rows_before'] === 'number') ctx.io.write(`中心库该区数据：${job.counts['center_rows_before']} 行（未动）\n`);
  }
  if (nothing) return 2;
  return job.status === 'failed' ? 1 : 0;
}

/** kb workspace-db cleanup --workspace <id|名> */
export async function workspaceDbCleanup(ctx: Ctx, workspace: string, args: WorkspaceDbPollArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const started = await postJob<WorkspaceDbOpJobView>(ctx, `${dbPath(workspaceId)}/localize/cleanup`, {},
    error => (error.code === NOTHING_TO_CLEAN_CODE ? nothingToClean(error.message) : error.message));
  const final = await waitForTerminal(ctx, started, CLEANUP, args.pollMs ?? DEFAULT_POLL_MS, args.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  exitWith(renderCleanup(ctx, final));
}

function renderRevert(ctx: Ctx, job: WorkspaceDbOpJobView): number {
  if (ctx.json) {
    writeJson(ctx, job);
  } else if (job.status === 'failed') {
    const parts: string[] = [];
    if (job.stage !== null) parts.push(`失败阶段：${stageLabel(REVERT, job.stage)}`);
    if (job.errorCode) parts.push(`错误码 ${job.errorCode}`);
    const prefix = parts.length === 0 ? '' : `（${parts.join('，')}）`;
    ctx.io.writeErr(`回迁失败${prefix}：${job.lastError ?? '服务端未给出原因'}\n`);
    ctx.io.writeErr(`jobId ${job.jobId}；回迁失败不改中心库数据，可用 kb workspace-db status --workspace ${job.workspaceId} 核对后处理\n`);
  } else {
    ctx.io.write('回迁完成：该工作区已回到中心库（db_mode=center），此后读写走中心库\n');
    ctx.io.write(`${rowsTotalLine('反向拷贝行数合计', job.counts)}\n`);
    const removedBackups = job.counts['removed_center_backups'];
    if (typeof removedBackups === 'number' && removedBackups > 0) {
      ctx.io.write(`已清理迁移前中心库快照 ${removedBackups} 份（*.center-backup-*；回迁后中心库已是事实源，快照失回滚凭据意义）\n`);
    }
    ctx.io.write(`工作区库已移入 .agentboard/backup/${job.backupPath === null ? '' : `：${job.backupPath}`}\n`);
  }
  return job.status === 'failed' ? 1 : 0;
}

/** kb workspace-db revert --workspace <id|名> */
export async function workspaceDbRevert(ctx: Ctx, workspace: string, args: WorkspaceDbPollArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const started = await postJob<WorkspaceDbOpJobView>(ctx, `${dbPath(workspaceId)}/localize/revert`, {});
  const final = await waitForTerminal(ctx, started, REVERT, args.pollMs ?? DEFAULT_POLL_MS, args.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  exitWith(renderRevert(ctx, final));
}

/** STORE-5：快照 manifest 的 CLI 视图（服务端结构见 services/workspaceSnapshot.ts） */
export interface SnapshotFileView {
  file: string;
  table: string;
  rows: number;
  sha256: string;
}

export interface SnapshotManifestView {
  format: string;
  workspace_id: string;
  schema_version: number;
  exported_at: string;
  generator_version: string;
  source_db: string;
  included_tables: string[];
  files: SnapshotFileView[];
  /** STORE-6：--include-attachments 时才有 */
  attachments?: Array<{ storage_key: string; file: string; bytes: number; sha256: string }>;
}

export interface SnapshotExportView {
  dir: string;
  manifest: SnapshotManifestView;
}

export interface SnapshotValidateView {
  ok: boolean;
  dir: string;
  manifest: SnapshotManifestView;
  tables: Array<{ table: string; rows: number }>;
}

export interface SnapshotImportView {
  dir: string;
  tables: Array<{ table: string; rows: number }>;
  rows: number;
  backupPath: string | null;
}

/** 表行数摘要：只列非零表，空库显式「无数据行」 */
const snapshotRowsSummary = (tables: Array<{ table: string; rows: number }>): string => {
  const parts = tables.filter(item => item.rows > 0).map(item => `${item.table} ${item.rows}`);
  return parts.length === 0 ? '无数据行' : parts.join('、');
};

const snapshotTotal = (tables: Array<{ rows: number }>): number => tables.reduce((sum, item) => sum + item.rows, 0);

const snapshotMetaLine = (manifest: SnapshotManifestView): string =>
  `工作区：${manifest.workspace_id}（schema_version=${manifest.schema_version}，导出于 ${manifest.exported_at}）`;

export interface SnapshotExportArgs {
  includeMessages?: boolean;
  /** STORE-6：附件本体一并导出到 snapshot/attachments/ */
  includeAttachments?: boolean;
}

/** kb workspace-db snapshot export [--workspace] [--include-messages] [--include-attachments] */
export async function workspaceDbSnapshotExport(ctx: Ctx, workspace: string, args: SnapshotExportArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const body: Record<string, boolean> = {};
  if (args.includeMessages === true) body.includeMessages = true;
  if (args.includeAttachments === true) body.includeAttachments = true;
  const result = await postJob<SnapshotExportView>(ctx, `${dbPath(workspaceId)}/snapshot/export`, body);
  if (ctx.json) {
    writeJson(ctx, result);
    return;
  }
  const files = result.manifest.files;
  ctx.io.write(`快照已导出：${result.dir}\n`);
  ctx.io.write(`${snapshotMetaLine(result.manifest)}（来源：${result.manifest.source_db}）\n`);
  ctx.io.write(`行数合计：${snapshotTotal(files)}（${snapshotRowsSummary(files)}）\n`);
  const attachments = result.manifest.attachments ?? [];
  if (attachments.length > 0) {
    const bytes = attachments.reduce((sum, item) => sum + item.bytes, 0);
    ctx.io.write(`附件：${attachments.length} 个文件，${bytes} 字节（snapshot/attachments/）\n`);
  } else if (!result.manifest.included_tables.includes('attachment')) {
    ctx.io.write('未包含：附件本体（需要时加 --include-attachments）\n');
  }
  if (!result.manifest.included_tables.includes('message')) {
    ctx.io.write('未包含：消息（会话与消息体积大，需要时加 --include-messages）\n');
  }
}

export interface SnapshotValidateArgs {
  /** 快照目录（相对工作区根；缺省 .agentboard/snapshot） */
  dir?: string;
}

/** kb workspace-db snapshot validate [--workspace] [--file <dir>]：只读校验，不写任何数据 */
export async function workspaceDbSnapshotValidate(ctx: Ctx, workspace: string, args: SnapshotValidateArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const query = args.dir === undefined ? '' : `?dir=${encodeURIComponent(args.dir)}`;
  const result = await request<SnapshotValidateView>(ctx.base, 'GET', `${dbPath(workspaceId)}/snapshot/validate${query}`);
  if (ctx.json) {
    writeJson(ctx, result);
    return;
  }
  ctx.io.write(`快照校验通过：${result.dir}\n`);
  ctx.io.write(`${snapshotMetaLine(result.manifest)}\n`);
  ctx.io.write(`文件：${result.manifest.files.length} 个，行数合计：${snapshotTotal(result.tables)}（${snapshotRowsSummary(result.tables)}）\n`);
}

export interface SnapshotImportArgs extends SnapshotValidateArgs {
  /** 目标库非空时覆盖（服务端先 VACUUM INTO 备份） */
  replace?: boolean;
}

/** kb workspace-db snapshot import [--workspace] [--file <dir>] [--replace] */
export async function workspaceDbSnapshotImport(ctx: Ctx, workspace: string, args: SnapshotImportArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const body: Record<string, string | boolean> = {};
  if (args.dir !== undefined) body.dir = args.dir;
  if (args.replace === true) body.replace = true;
  const result = await postJob<SnapshotImportView>(ctx, `${dbPath(workspaceId)}/snapshot/import`, body);
  if (ctx.json) {
    writeJson(ctx, result);
    return;
  }
  ctx.io.write(`快照已导入：${result.dir}\n`);
  ctx.io.write(`导入行数：${result.rows}（表 ${result.tables.length} 个：${snapshotRowsSummary(result.tables)}）\n`);
  if (result.backupPath !== null) ctx.io.write(`覆盖前备份：${result.backupPath}\n`);
}

/**
 * STORE-6：中心库全局快照（工作区注册表 / 成员 / 账号与签到元数据 / 公共知识），
 * 落在中心库同级的 center-snapshot/，不跟随单个工作区仓库。
 */
export interface CenterSnapshotManifestView {
  format: string;
  scope: 'center';
  schema_version: number;
  exported_at: string;
  generator_version: string;
  source_db: string;
  included_tables: string[];
  files: SnapshotFileView[];
}

export interface CenterSnapshotExportView {
  dir: string;
  manifest: CenterSnapshotManifestView;
}

export interface CenterSnapshotValidateView {
  ok: boolean;
  dir: string;
  manifest: CenterSnapshotManifestView;
  tables: Array<{ table: string; rows: number }>;
}

/** kb workspace-db snapshot center-export：导出中心库全局快照（敏感引用脱敏为 ***） */
export async function workspaceDbCenterSnapshotExport(ctx: Ctx): Promise<void> {
  const result = await postJob<CenterSnapshotExportView>(ctx, '/api/system/center-snapshot/export', {});
  if (ctx.json) {
    writeJson(ctx, result);
    return;
  }
  ctx.io.write(`中心库快照已导出：${result.dir}\n`);
  ctx.io.write(`schema_version=${result.manifest.schema_version}，导出于 ${result.manifest.exported_at}\n`);
  ctx.io.write(`行数合计：${snapshotTotal(result.manifest.files)}（${snapshotRowsSummary(result.manifest.files)}）\n`);
  ctx.io.write('账号凭据/引用已脱敏为 ***\n');
}

/** kb workspace-db snapshot center-validate：只读校验中心库快照（含脱敏自检） */
export async function workspaceDbCenterSnapshotValidate(ctx: Ctx): Promise<void> {
  const result = await request<CenterSnapshotValidateView>(ctx.base, 'GET', '/api/system/center-snapshot/validate');
  if (ctx.json) {
    writeJson(ctx, result);
    return;
  }
  ctx.io.write(`中心库快照校验通过：${result.dir}\n`);
  ctx.io.write(`文件：${result.manifest.files.length} 个，行数合计：${snapshotTotal(result.tables)}（${snapshotRowsSummary(result.tables)}）\n`);
}
