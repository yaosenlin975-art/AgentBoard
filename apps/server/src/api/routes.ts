/**
 * Task 9：REST 路由（Pinned Contracts REST 全表 + 契约修订）。
 *
 * 修订点：POST /api/sessions 体增 workspace_id?——issue_id 为空时必填（400 校验）；
 * POST /api/issues/:id/claim 仅做占用登记（session_id 置 null，供 kb claim 场景），不建会话。
 */
import { spawn } from 'node:child_process';
import { zhZodIssue } from './zod.js';
import { statSync } from 'node:fs';
import express, { Router } from 'express';
import { createKnowledgeRouter } from './knowledgeRoutes.js';
import { createAccountRouter } from './accountRoutes.js';
import { createSystemRouter, performRestart, type RestartDeps } from './systemRoutes.js';
import { createArchivedChangelogRouter, createChangelogRouter } from './changelogRoutes.js';
import { createWorkspaceStatusRouter } from './workspaceStatusRoutes.js';
import { createVoiceRouter, type VoiceRouterOptions } from './voiceRoutes.js';
import { createDecisionRouter } from './decisionRoutes.js';
import { createDraftService, type DraftRunner } from '../services/smartCreateDraft.js';
import type { WorkbuddyDesktopProvider } from '../services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec, CheckinVault } from '../services/accounts/checkinProvider.js';
import type { AddAccountProviderSpec } from '../services/accounts/addAccountProtocol.js';
import type { RestoreHandler } from '../services/accounts/restore.js';
import type { QuotaService } from '../services/quotas/quotaService.js';
import { getTaskKnowledge } from '../services/taskKnowledge.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { AgentAdapter } from '@agentboard/adapters';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import { imageDeliveryHint } from '../services/imageDeliveryHint.js';
import type { KnowledgeHint, ManagedAppId, ServerWsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import type { SecretVault } from '../services/accounts/secretVault.js';
import { AttachmentStore, MAX_IMAGE_BYTES } from '../services/attachments.js';
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceDeleteBlockers,
  listWorkspaces,
  listWorkspacesPage,
  listWorkspaceIds,
  reorderWorkspaces,
} from '../db/repos/workspace.js';
import { deleteIssue, getIssue, listIssues, listIssuesPage, requireNoIssueChildren } from '../db/repos/issue.js';
import { createIssueInHierarchy, getIssueTreeChildren } from '../services/taskHierarchy.js';
import { listCommentsByIssue, listCommentsPage, getCommentContent } from '../db/repos/comment.js';
import { bindAttachmentsToSession, listPendingIssueAttachments } from '../db/repos/attachment.js';
import { textWindow } from '../db/pagination.js';
import {
  listSessionsByWorkspace,
  listSessionsByIssue,
  getSession,
  updateSession,
  deleteSession,
  forkSession,
} from '../db/repos/session.js';
import { listTurnsBySession } from '../db/repos/sessionTurn.js';
import { answerAwaitingTurn } from '../services/turnAwaiting.js';
import { decideTurnApproval } from '../services/turnApproval.js';
import { retryFailedStep } from '../services/turnStepRetry.js';
import { listActiveApprovalRules, revokeApprovalRule } from '../db/repos/approvalRule.js';
import { listMessagesBySession, deleteMessagesBySession, listFirstUserMessages } from '../db/repos/message.js';
import { listSessionEvents } from '../db/repos/sessionEvent.js';
import { buildSessionPreview } from '../services/messageSignals.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { CLAIM_FENCE_HEADER, resolveProxyEnv } from '@agentboard/shared';
import {
  describeMigrationError,
  getMigrationStatus,
  isMigrationActive,
  orchestrateMigration,
  runBootSelfCheck,
} from '../services/dbMigration.js';
import { collectStorageInfo } from '../services/storageInfo.js';
import { WORKSPACE_DB_MODES, assertWorkspaceDbWritable, decideWorkspaceDb, isWorkspaceDbDisabled, listOpenWorkspaceDbs, type WorkspaceDbMode } from '../db/resolver.js';
import { getActiveWorkspaceDbJob, getLocalizeJob, startLocalizeJob, startWorkspaceDbOpJob } from '../services/workspaceLocalizeJob.js';
import { buildWorkspaceDbStatus } from '../services/workspaceDbStatus.js';
import { claimIssue, doneIssue, failIssue, heartbeatClaim, releaseIssue, updateIssueGuarded, requireIssueInWorkspace, updateIssueWithCAS, finishClaimedIssue, releaseClaimedIssue } from '../services/claim.js';
import { releaseRunning } from '../services/releaseRunning.js';
import { captureIssueGitBaseline, commitIssueChanges, dropIssueGitBaseline } from '../services/gitBaseline.js';
import { listSkills } from '../services/skills.js';
import type { MinimaxClientProbe } from '../services/accounts/minimaxClientProbe.js';
import { addRelation, listDependencies, removeDependency, unlockCommentsForDeletedBlocker } from '../services/dependency.js';
import { requireWorkspaceStatus } from '../services/workspaceStatus.js';
import { deleteWorkspaceRemovingDeletedKnowledge } from '../services/workspaceKnowledgePurge.js';
import { getWorkspaceKnowledgeOccupancy } from '../db/repos/knowledge.js';
import { appendServerLog } from '../services/serverLog.js';
import { closeIssue, reopenIssue } from '../services/issueTransitions.js';
import { buildKnowledgeHint } from '../services/knowledgeNudge.js';
import type { ExportRunner } from '../services/accounts/credentialImport.js';
import { addComment, consumeComments, storeComment, wakeCommentSession, type AddCommentResult } from '../services/comments.js';
import { hashPayload, httpMutation, finishIdempotentEffect } from '../services/idempotency.js';
import { dispatchIssue } from '../services/dispatch.js';
import { createSession, forgetSession, getSessionRuntime, sendToSession, setMaxConcurrentTurns, stopSession, runRetriedStep } from '../services/sessionManager.js';
import { getCachedClis } from '../services/cliDetect.js';
import { attachmentsDirFor, configDir, loadConfig, readSettings, writeSettings, type DbPathSource } from '../config.js';
import {
  addCommentSchema,
  claimSchema,
  createIssueSchema,
  createSessionSchema,
  createWorkspaceSchema,
  reorderWorkspacesSchema,
  doneSchema,
  failSchema,
  issueTreeQuerySchema,
  patchIssueSchema,
  patchSessionSchema,
  forkSessionSchema,
  answerTurnSchema,
  approvalDecisionSchema,
  patchSettingsSchema,
  dbMigrateSchema,
  workspaceLocalizeSchema,
  workspaceDbOpSchema,
  sendMessageSchema,
  pageQuerySchema, descriptionQuerySchema, commentQuerySchema, issueStatusSchema,
  addDependencySchema, dependencyQuerySchema, draftRequestSchema, reopenSchema,
  releaseRunningSchema,
} from './schemas.js';

export interface RouterDeps {
  db: Db;
  attachments: AttachmentStore;
  secretVault?: SecretVault;
  getAdapter: (cliId: string) => AgentAdapter;
  /** WS 广播钩子（index.ts 装配 hub.broadcast）；CHAT-AWAIT1：放宽到 ServerWsEvent 以容纳 session.turn */
  broadcast: (event: ServerWsEvent) => void;
  /** 账号 provider 装配（ACC-05/ACC-07）；缺省时账号写接口返回 PROVIDER_UNAVAILABLE */
  accounts?: { workbuddy?: WorkbuddyDesktopProvider; checkinProvider?: CheckinProviderSpec; checkinProviders?: Partial<Record<ManagedAppId, CheckinProviderSpec>>; vault?: CheckinVault; desktopProviders?: Partial<Record<ManagedAppId, Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>>>; quotas?: Pick<QuotaService, 'get'>; minimaxClientProbe?: MinimaxClientProbe; addAccountProviders?: Partial<Record<ManagedAppId, AddAccountProviderSpec>>; restoreHandlers?: Partial<Record<ManagedAppId, RestoreHandler>> };
  /** KB-GRAPH 页面加载上限（仅测试注入；生产用 GRAPH_MAX_PAGES） */
  knowledgeGraphPageLimit?: number;
  /** 已安装技能根目录（仅测试注入；生产固定 ~/.agents/skills） */
  skillsRoot?: string;
  /** SYSTEM-RESTART：服务自重启依赖（生产 main() 注入；测试可注入 fake） */
  restart?: RestartDeps;
  /** ACC-11 凭据导出 runner（仅测试注入） */
  credentialRunner?: ExportRunner;
  /** SMART-CREATE：一次性适配器调用（仅测试注入；生产用 getAdapter().runTurn） */
  draftRunner?: DraftRunner;
  /** SMART-CREATE：草稿生成超时（ms，仅测试注入；生产 120s） */
  draftTimeoutMs?: number;
  /** STORE-1：按工作区选库的解析层（缺省自动装配：中心库=当前 db、instanceId 取 instance、port 取设置） */
  workspaceDbResolver?: boolean;
  /** SERVER-SINGLETON：实例标识（`/api/version` 输出；测试可注入） */
  instance?: { instanceId: string; dbPath: string; startedAt: number };
  /** DB-2B：迁移编排的固定状态目录（缺省 configDir()；测试注入临时目录） */
  dbMigrationStateDir?: string;
  /** DB-2B：当前进程实际使用的库路径（缺省 db.name；测试注入） */
  dbPath?: string;
  /** DB-2B：当前进程的附件目录（缺省 attachmentsDirFor(dbPath)） */
  attachmentStorageDir?: string;
  /** DB-2B：dbPath 来源（缺省按 AGENTBOARD_DB 是否设置推断） */
  dbPathSource?: DbPathSource;
  /** DB-2B：自检失败时的进程退出（缺省 process.exit；测试注入 spy） */
  dbMigrationExit?: (code: number) => void;
  /** DB-2B：自检通过后旧文件清理的重试调度（缺省 setTimeout；测试注入） */
  dbMigrationSchedule?: (fn: () => void, ms: number) => void;
  /** VOICE-1：语音模型管理依赖（仅测试注入 catalog/fetch/freeBytes/rootDir；生产用默认值） */
  voice?: VoiceRouterOptions;
}

/** zod 校验：失败抛 ValidationError（错误中间件 → 400） */
/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 * 例：invalid_value → 「取值必须是：a / b」；too_small → 「不能小于 N」。
 */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

/** CHAT-SB1：会话列表按设计稿用 `workspace_id` 查询，既有调用方仍用 `workspace`，两者等价 */
function requireWorkspaceParam(req: Request): string {
  const value = req.query.workspace ?? req.query.workspace_id;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('缺少 workspace 查询参数');
  }
  return value;
}

function requireExistingWorkspace(db: Db, id: string): void {
  if (!getWorkspace(db, id)) throw new NotFoundError('工作空间不存在');
}

function requireIssue(db: Db, id: string) {
  const issue = getIssue(db, id);
  if (!issue) throw new NotFoundError('任务不存在');
  return issue;
}

async function wakeStoredComment(
  db: Db,
  getAdapter: RouterDeps['getAdapter'],
  attachments: AttachmentStore,
  issueId: string,
  sessionId: string,
  content: string,
  attachmentIds: string[],
): Promise<{ woke: boolean; warning?: string }> {
  if (attachmentIds.length === 0) {
    try {
      await wakeCommentSession(sessionId, content);
      return { woke: true };
    } catch {
      return { woke: false, warning: 'WAKE_FAILED' };
    }
  }

  const session = getSession(db, sessionId);
  if (!session) return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' };
  let adapter: AgentAdapter;
  try { adapter = getAdapter(session.cli); }
  catch { return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' }; }
  const verifiedCliVersion = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined);
  if (verifiedCliVersion === null) return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' };

  try {
    const imageAttachments = attachmentIds.map((id) => ({
      path: attachments.issuePath(issueId, id),
      mimeType: attachments.issueMime(issueId, id) as 'image/png' | 'image/jpeg' | 'image/webp',
    }));
    await wakeCommentSession(sessionId, content || '请查看随附图片。', {
      attachments: imageAttachments,
      deliveredAttachmentIds: attachmentIds,
      verifiedCliVersion,
    });
    return { woke: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { woke: false, warning: message.includes('IMAGE_DELIVERY_UNVERIFIED') ? 'IMAGE_DELIVERY_UNVERIFIED' : 'WAKE_FAILED' };
  }
}

/** name 留空兜底：先去尾部 / 与 \，再按 / 或 \ 分段取最后一段 */
function workspaceNameFromPath(path: string): string {
  const segments = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

// ---- POST /api/system/pick-folder（Windows 原生文件夹选择） ----

/** pick-folder 并发守卫：同一时刻只允许一个选择窗口（finally 复位） */
let pickFolderInFlight = false;

/**
 * PowerShell 弹 FolderBrowserDialog：单引号 PS 字符串、无双引号，-Command 参数整体
 * 经 spawn 参数数组传递不经 shell；OK 时 stdout 只输出 SelectedPath（UTF-8，无换行）。
 */
const PICK_FOLDER_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description='选择工作空间文件夹'",
  '$d.ShowNewFolderButton=$true',
  'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}',
].join('; ');

function pickFolderErrorDetail(stderr: string, fallback: string): string {
  const firstLine = stderr.trim().split(/\r?\n/, 1)[0];
  return (firstLine && firstLine !== '' ? firstLine : fallback).slice(0, 200);
}

/** spawn powershell 弹窗；选中 → 路径，取消/无输出 → null，spawn 或脚本失败 → reject */
function pickFolderViaPowerShell(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', PICK_FOLDER_PS_SCRIPT],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(
        new ApiError(
          500,
          'PICK_FOLDER_FAILED',
          `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, err.message)}`,
        ),
      );
    });
    child.on('close', (code) => {
      const picked = stdout.trim();
      if (picked !== '') {
        resolve(picked);
        return;
      }
      if (code !== 0) {
        reject(
          new ApiError(
            500,
            'PICK_FOLDER_FAILED',
            `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, `exit code ${code}`)}`,
          ),
        );
        return;
      }
      resolve(null); // 用户取消（无输出）
    });
  });
}

/**
 * 默认草稿 runner：直接调适配器的 runTurn（一次性进程），只收集 text 事件。
 * 不建 session 行、不占 claim 槽位；超时由 smartCreateDraft 的 AbortSignal 触发 kill。
 */
function defaultDraftRunner(getAdapter: (cliId: string) => AgentAdapter): DraftRunner {
  return ({ adapter, prompt, cwd, signal }) => new Promise<string>((resolve, reject) => {
    let handle: ReturnType<AgentAdapter['runTurn']>;
    try {
      handle = getAdapter(adapter).runTurn({ cwd, prompt });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let text = '';
    handle.onEvent((event) => {
      if (event.type === 'text') text += event.delta;
    });
    const onAbort = (): void => { void handle.kill().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    handle.result.then((result) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return;
      if (result.exitCode !== 0) {
        // stderr 尾部最后一行常是 Node 版本横幅，取最后 3 行非空内容更可解释
        const tail = (result.stderrTail ?? []).map(line => line.trim()).filter(line => line !== '').slice(-3).join(' | ');
        reject(new Error(tail === '' ? `适配器退出码 ${result.exitCode}` : `适配器退出码 ${result.exitCode}：${tail}`));
        return;
      }
      resolve(text);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function createRouter(deps: RouterDeps): Router {
  const { db, getAdapter, broadcast, attachments } = deps;
  const router = Router();

  // STORE-1（M1）：解析层装配（中心库=当前 db；每工作区锁用与 server.lock 同一实现）
  // STORE-3a：disabled 紧急开关在装配期解析一次（生产改 env 必然伴随重启重建路由，无需逐请求读）
  const workspaceResolverDeps = {
    centerDb: db,
    instanceId: deps.instance?.instanceId ?? 'inst-unset',
    port: readSettings().port,
    ...(isWorkspaceDbDisabled() ? { disabled: true } : {}),
  };
  /** 读中心库 workspace.db_mode（缺列为老库 → center，行为与现状一致） */
  const workspaceRowMode = (workspaceId: string): WorkspaceDbMode => {
    try {
      const row = db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(workspaceId) as { db_mode?: string } | undefined;
      const raw = row?.db_mode ?? 'center';
      return (WORKSPACE_DB_MODES as readonly string[]).includes(raw) ? (raw as WorkspaceDbMode) : 'center';
    } catch {
      return 'center';
    }
  };
  /**
   * STORE-2a（D7）：写闸门与 localize 端点共用的工作区行取用。
   * 未知工作区显式 404——不得用 `path ?? ''` 进判定：'' 拼 `.agentboard/agentboard.db`
   * 会落到进程 cwd 相对路径，读错文件比报错更糟。
   */
  const requireWorkspaceRow = (workspaceId: string): { id: string; path: string; dbMode: WorkspaceDbMode } => {
    const row = getWorkspace(db, workspaceId);
    if (row === null) throw new NotFoundError('工作空间不存在');
    return { id: row.id, path: row.path, dbMode: workspaceRowMode(workspaceId) };
  };

  // ---- DB-2B：迁移编排上下文 ----
  // 状态目录固定（configDir），不随库路径漂移：新进程靠它读到旧进程写的待自检意图。
  const migrationStateDir = deps.dbMigrationStateDir ?? configDir();
  // db 可能是最小装配的替身（无 name）：此时迁移端点明确 503，不在构造期抛错
  const currentDbPath: string | null = deps.dbPath ?? (typeof db.name === 'string' && db.name !== '' ? db.name : null);
  const attachmentsDirOf = (dbPath: string): string => deps.attachmentStorageDir ?? attachmentsDirFor(dbPath);
  // 来源三态（env / settings / default）：缺省按启动同一套规则解析（loadConfig），
  // 解析失败（例如 AGENTBOARD_HOST 非法）时退化为 env-否则-settings 两态，不让只读端点 500。
  const resolveDbPathSource = (): DbPathSource => {
    if (deps.dbPathSource !== undefined) return deps.dbPathSource;
    try {
      return loadConfig(process.env).dbPathSource;
    } catch {
      return (process.env.AGENTBOARD_DB ?? '') !== '' ? 'env' : 'settings';
    }
  };
  const triggerRestart = async (): Promise<void> => {
    if (!deps.restart) throw new Error('当前装配未启用服务重启');
    const outcome = await performRestart(deps.restart);
    if (!outcome.ok) throw new Error(outcome.message);
  };

  // 新进程启动钩子：有 pending 意图就自检；失败则回滚设置并退出本进程
  // （旧进程健康判定会失败 → 重新监听旧库继续服务，即「重启回旧库」）。
  if (currentDbPath !== null && isMigrationActive(migrationStateDir)) {
    const boot = runBootSelfCheck({
      stateDir: migrationStateDir,
      currentDbPath,
      sourceDb: db,
      applySettings: (path) => { writeSettings({ dbPath: path }); },
      ...(deps.dbMigrationSchedule !== undefined ? { schedule: deps.dbMigrationSchedule } : {}),
    });
    if (boot.handled && !boot.ok && boot.needsRestartToOldDb) {
      (deps.dbMigrationExit ?? ((code: number) => process.exit(code)))(1);
    }
  }
  const effectiveWorkspace = (req: Request): string | undefined => req.body?.workspace_id ?? req.query.workspace_id;
  function mutation<T>(req: Request, perform: () => T) {
    return httpMutation(db, req, () => {
      const workspace = effectiveWorkspace(req);
      if (workspace && req.params.id) requireIssueInWorkspace(db, String(req.params.id), workspace);
      return perform();
    });
  }
  // ---- version ----
  // pid：RESTART-HARDENING —— 客户端据它区分「新进程已接管」与「已回退旧进程」，端口占用检查也靠它识别自身
  router.get('/version', (_req, res) => {
    // PROXY-ENV：出站代理是否生效（只读、脱敏）。客户端/诊断脚本据此判断「为什么外网请求超时」
    const proxy = resolveProxyEnv(process.env);
    res.json({
      name: 'agentboard-server',
      version: SERVER_VERSION,
      pid: process.pid,
      // SERVER-SINGLETON：判定「端口上的实例是不是同一个 DB 的同一个进程」
      instance_id: deps.instance?.instanceId ?? null,
      db_path: deps.instance?.dbPath ?? currentDbPath,
      started_at: deps.instance?.startedAt ?? null,
      proxy_env: { enabled: proxy.enabled, proxy_var: proxy.proxy_var, proxy_host: proxy.proxy_host, node_env_proxy: proxy.node_env_proxy },
      // STORE-1（M1）：排障要能看出「本实例服务哪些库」——中心库 + 当前已打开的工作区库
      db_scope: { center_db_path: deps.instance?.dbPath ?? currentDbPath, localized_open: listOpenWorkspaceDbs() },
    });
  });

  router.use('/knowledge', createKnowledgeRouter(deps.db, { maxGraphPages: deps.knowledgeGraphPageLimit }));

  // ---- 已安装技能（只读、固定根、不接受路径参数）----
  router.get('/skills', (_req, res) => {
    res.json(listSkills({ root: deps.skillsRoot }));
  });
  router.use('/workspaces/:workspaceId/changelog', createChangelogRouter(deps.db));
  // STATUS-2：工作区状态字典（列表/新建/删除+强制迁移）
  router.use('/workspaces/:workspaceId/statuses', createWorkspaceStatusRouter(deps.db));
  router.use('/changelog', createArchivedChangelogRouter(deps.db));
  router.use('/voice', createVoiceRouter(deps.db, deps.voice ?? {}));
  router.use(createSystemRouter({ restart: deps.restart }));
  router.use(createAccountRouter({ db, workbuddy: deps.accounts?.workbuddy, checkinProvider: deps.accounts?.checkinProvider, checkinProviders: deps.accounts?.checkinProviders, desktopProviders: deps.accounts?.desktopProviders, vault: deps.accounts?.vault ?? deps.secretVault, secretVault: deps.secretVault, credentialRunner: deps.credentialRunner, quotas: deps.accounts?.quotas, minimaxClientProbe: deps.accounts?.minimaxClientProbe, addAccountProviders: deps.accounts?.addAccountProviders, addAccountVault: deps.secretVault, restoreHandlers: deps.accounts?.restoreHandlers }));
  // ---- SMART-CREATE：智能创建草稿（不落库，设计 §4）----
  // 必须在 /issues/:id 中间件之前注册：否则 'draft' 会被当成 issue id 去查库并 404。
  const draftService = createDraftService({
    db,
    run: deps.draftRunner ?? defaultDraftRunner(getAdapter),
    detectAdapter: async (cliId) => {
      try {
        const detected = await deps.getAdapter(cliId).detect();
        return { installed: detected.installed, version: detected.version, ...(detected.message === undefined ? {} : { message: detected.message }) };
      } catch (error) {
        return { installed: false, version: null, message: `适配器 ${cliId} 探测失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
    existingLabels: (workspaceId) => {
      const rows = db.prepare('SELECT labels FROM issue WHERE workspace_id=?').all(workspaceId) as Array<{ labels: string }>;
      const set = new Set<string>();
      for (const row of rows) {
        try { for (const label of JSON.parse(row.labels) as unknown[]) if (typeof label === 'string' && label.trim() !== '') set.add(label); } catch { /* 脏数据忽略 */ }
      }
      return [...set].sort();
    },
    workspacePath: (workspaceId) => getWorkspace(db, workspaceId)?.path ?? process.cwd(),
    ...(deps.draftTimeoutMs === undefined ? {} : { timeoutMs: deps.draftTimeoutMs }),
  });
  router.post('/issues/draft', async (req, res) => {
    const body = parseBody(draftRequestSchema, req.body);
    const workspace = getWorkspace(db, body.workspace_id);
    if (!workspace) throw new NotFoundError('工作空间不存在');
    const draft = await draftService.generate({
      workspace_id: body.workspace_id,
      requirement: body.requirement,
      adapter: body.adapter,
      ...(body.priority === undefined ? {} : { priority: body.priority }),
    });
    res.json(draft);
  });

  // DEC-WIRE：决策 REST（DEC-3 定稿）必须在 '/issues/:id' 中间件之前注册，否则 /issues/:id/ask 与 /issues/:id/stop 会被当作 issue 子路由
  router.use(createDecisionRouter({ db, broadcast }));

  router.use('/issues/:id', (req, _res, next) => {
    const raw = req.query.workspace_id ?? req.body?.workspace_id;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !raw) throw new ValidationError('workspace_id 不合法');
      if (req.query.workspace_id && req.body?.workspace_id && req.query.workspace_id !== req.body.workspace_id) throw new ValidationError('workspace_id 不一致');
      const wrappedMutation = req.get('Idempotency-Key') && ((req.method === 'PATCH' && req.path === '/') || (req.method === 'POST' && ['/claim', '/release', '/done', '/fail', '/comments', '/dependencies', '/close', '/reopen'].includes(req.path)));
      if (!wrappedMutation) requireIssueInWorkspace(deps.db, String(req.params.id), raw);
    }
    // STORE-1（M1）写入门禁：中间态/缺失/id 不匹配/被锁 → 409 或 500，读路径不受影响
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const issue = getIssue(deps.db, String(req.params.id));
      if (issue !== null) assertWorkspaceDbWritable(workspaceResolverDeps, requireWorkspaceRow(issue.workspace_id));
    }
    next();
  });

  // ---- workspaces ----
  /**
   * STORE-1（M1）：工作区行带上「服务端判定结果」——`db_mode`（中心期望状态）、`db_path`（判定后实际会用的库）、
   * `db_target`/`db_reason`（排障用）。判定输入只有「中心行 + 文件 + 库内 meta」，**不接受客户端传参决定走库**。
   */
  const withWorkspaceDb = <T extends { id: string; path: string }>(row: T) => {
    const dbModeRaw = (row as T & { db_mode?: string | null }).db_mode ?? 'center';
    const centerDbMode = (WORKSPACE_DB_MODES as readonly string[]).includes(dbModeRaw) ? (dbModeRaw as (typeof WORKSPACE_DB_MODES)[number]) : 'center';
    const decision = decideWorkspaceDb({ workspaceId: row.id, workspacePath: row.path, centerDbMode, centerDbPath: db.name, ...(isWorkspaceDbDisabled() ? { disabled: true } : {}) });
    return { ...row, db_mode: centerDbMode, db_path: decision.dbPath, db_target: decision.target, db_reason: decision.reason };
  };
  router.get('/workspaces', (req, res) => {
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      const page = parseBody(pageQuerySchema, req.query);
      const result = listWorkspacesPage(db, page.limit, page.offset);
      res.json({ ...result, items: result.items.map(withWorkspaceDb) });
    } else res.json(listWorkspaces(db).map(withWorkspaceDb));
  });

  /**
   * WS-REORDER：批量重排工作区展示顺序。
   * 必填 `Idempotency-Key`（同 key 同 body 重放返回首次结果、不改写；同 key 不同 body → 409）。
   * 并发语义：顺序冲突为 LWW（后写覆盖）；集合与当前库不一致 → 409 WORKSPACE_SET_CHANGED（附 missing/extra），
   * 不按部分集合静默重排。
   */
  router.post('/workspaces/reorder', (req, res) => {
    if (!req.get('Idempotency-Key')) throw new ValidationError('该接口要求 Idempotency-Key（UUID）');
    const body = parseBody(reorderWorkspacesSchema, req.body);
    const current = listWorkspaceIds(db);
    const unknown = body.ordered_ids.filter(id => !current.includes(id));
    if (unknown.length > 0) throw new ValidationError(`工作空间不存在: ${unknown.join(', ')}`);
    const missing = current.filter(id => !body.ordered_ids.includes(id));
    const extra = body.ordered_ids.filter(id => !current.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new ApiError(409, 'WORKSPACE_SET_CHANGED', '工作区集合已变化，请刷新后重试', { missing, extra });
    }
    const result = httpMutation(db, req, () => ({ workspaces: reorderWorkspaces(db, body.ordered_ids), reordered_at: Date.now() }));
    res.json(result.result);
  });

  router.post('/workspaces', (req, res) => {
    const body = parseBody(createWorkspaceSchema, req.body);
    let stat;
    try {
      stat = statSync(body.path);
    } catch {
      throw new ValidationError(`路径不存在或不是目录: ${body.path}`);
    }
    if (!stat.isDirectory()) throw new ValidationError(`路径不存在或不是目录: ${body.path}`);
    // name 留空 → 从 path basename 兜底（路径存在性校验已在前，空路径不会到这里）
    const name = body.name !== '' ? body.name : workspaceNameFromPath(body.path);
    res.json(createWorkspace(db, { name, path: body.path }));
  });

  router.delete('/workspaces/:id', async (req, res) => {
    const workspaceId = req.params.id!;
    // KB-DEL（N-03）：知识占用只算**未软删**的页与其 revision（口径见 repos/knowledge.ts）；
    // 已 `status='deleted'` 的页对用户不可见，不再阻断，由下面的 purge 一并硬删——
    // `knowledge_page.workspace_id` 是 ON DELETE RESTRICT，留着它们空间行本来就删不掉。
    // purge 只可能发生在显式 `--yes` 的 DELETE 上（`kb delete-space` 缺 --yes 不发请求），
    // 且删了多少页/多少条 revision 一律回显（响应头 + 服务日志）。
    const knowledge = getWorkspaceKnowledgeOccupancy(db, workspaceId);
    if (knowledge.pages > 0) {
      // 拒绝原因点名剩余页 id（最多 5 个，多了只报总数），用户才能直接去删/迁这几页
      const shown = 5;
      throw new ConflictError(
        `该空间仍有 ${knowledge.pages} 个知识页及 ${knowledge.revisions} 条历史 revision`
        + `（剩余页：${knowledge.pageIds.slice(0, shown).join(', ')}`
        + `${knowledge.pageIds.length > shown ? ` 等 ${knowledge.pageIds.length} 个` : ''}），请先删除或迁移知识页后再移除`,
      );
    }
    const blockers = getWorkspaceDeleteBlockers(db, workspaceId);
    if (blockers.runningSessions > 0)
      throw new ConflictError(`该空间有 ${blockers.runningSessions} 个运行中会话，请先结束会话后再移除`);
    if (blockers.childIssues > 0)
      throw new ConflictError(`该空间有 ${blockers.childIssues} 个子任务仍挂在父任务下，请先解除关联后再移除`);
    const purged = deleteWorkspaceRemovingDeletedKnowledge(db, workspaceId);
    if (purged.pages > 0) {
      res.setHeader('X-Knowledge-Purged', `pages=${purged.pages}; revisions=${purged.revisions}`);
      appendServerLog(
        `[workspace-delete] ${workspaceId} 移除时硬删已软删知识页 ${purged.pages} 个、历史 revision ${purged.revisions} 条（仅 status='deleted'）`,
      );
    }
    // 空间行已由 purge 服务在同一事务内删除（外键 CASCADE 带走任务/会话/评论/消息）
    await attachments.processCleanup();
    res.status(204).end();
  });

  /**
   * REL-1：工作区批量退回待规划（「进行中」列头救火键的服务端契约）。
   * workspace 只取路径参数 —— 明确不读 effectiveWorkspace（`body.workspace_id ?? query.workspace_id`），
   * 不存在「省略工作区就清全部」；未知工作区 404 零写入。body 里的 workspace_id 直接忽略。
   */
  router.post('/workspaces/:workspaceId/release-running', (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    const body = parseBody(releaseRunningSchema, req.body ?? {});
    const { released, skipped } = releaseRunning(db, workspaceId, body);
    if (body.dry_run !== true) {
      for (const issue of released) broadcast({ type: 'issue.changed', issue });
    }
    res.json({ released, skipped });
  });

  router.post('/workspaces/:workspaceId/attachments', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
    const workspaceId = req.params.workspaceId!;
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('图片请求体必须为原始二进制');
    const uploaded = await attachments.upload(workspaceId, req.get('Content-Type') ?? '', req.get('X-File-Name') ?? undefined, req.body);
    res.status(201).json(uploaded);
  });

  router.get('/workspaces/:workspaceId/attachments/:attachmentId', (req, res, next) => {
    const workspaceId = req.params.workspaceId!;
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    const id = req.params.attachmentId!;
    // CHAT-IMG-DELIVERY：workspace 内 staged/attached 均可读——聊天消息里的 markdown URL 绑定会话后仍能显示
    const filePath = attachments.workspacePath(workspaceId, id);
    res.type(attachments.workspaceMime(workspaceId, id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachments.workspaceName(workspaceId, id))}`);
    res.sendFile(filePath, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(error); });
  });

  // ---- STORE-2a/3a：工作区库下沉（localize）——八阶段状态机的 REST 入口（2b CLI 消费）----
  /**
   * POST /api/workspaces/:id/db/localize：body { dryRun?, overwrite?, resume? } → 202 { jobId, ... }。
   * dry-run 与真实迁移统一走 jobId 模型；真实迁移开跑即置中心 db_mode=localizing，
   * 该工作区写闸门随之 409 WORKSPACE_DB_MIGRATING、读继续走中心库、其它工作区无感。
   * STORE-3a：resume=true 从 `<ws>/.agentboard/localize.json` 记录的阶段续跑（崩溃矩阵见
   * workspaceLocalizeRun.localizeWorkspace）；dryRun=true 时忽略 resume，resume=true 时忽略 overwrite。
   */
  router.post('/workspaces/:id/db/localize', async (req, res) => {
    const workspaceId = req.params.id!;
    requireWorkspaceRow(workspaceId); // 未知工作区显式 404，不进任务表
    const body = parseBody(workspaceLocalizeSchema, req.body ?? {});
    const job = startLocalizeJob(db, {
      workspaceId,
      dryRun: body.dryRun === true,
      overwrite: body.overwrite === true,
      resume: body.resume === true,
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /** GET /api/workspaces/:id/db/localize/:jobId：阶段、计数、last_error（任务表只在内存，重启即 404） */
  router.get('/workspaces/:id/db/localize/:jobId', (req, res) => {
    const job = getLocalizeJob(String(req.params.id), String(req.params.jobId));
    if (job === null) throw new NotFoundError('迁移任务不存在');
    res.json(job);
  });

  /**
   * STORE-3a：POST /api/workspaces/:id/db/localize/cleanup → 202 { jobId, kind: 'cleanup', ... }。
   * 只清失败半成品（工作区侧目标库 / -wal / -shm / 附件目录 / 残留快照 / localize.json），
   * 中心库数据不动；failed/localizing 的中心 db_mode 落回 center（写闸门释放）。
   * db_mode=localized（活库）或工作区库是唯一数据副本时 409 拒绝。
   */
  router.post('/workspaces/:id/db/localize/cleanup', (req, res) => {
    const workspaceId = req.params.id!;
    requireWorkspaceRow(workspaceId);
    parseBody(workspaceDbOpSchema, req.body ?? {});
    const job = startWorkspaceDbOpJob(db, {
      workspaceId,
      kind: 'cleanup',
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /**
   * STORE-3a：POST /api/workspaces/:id/db/localize/revert → 202 { jobId, kind: 'revert', ... }。
   * 反向迁移：附件回拷（sha256）+ 单事务反向插行（逐表行数守恒，复用 verify 守恒语义）+
   * db_mode=center；提交后工作区库移入 `<ws>/.agentboard/backup/`。中心已有该区行（disabled
   * 期间回写等分叉）时 409 拒绝，不静默覆盖。
   */
  router.post('/workspaces/:id/db/localize/revert', (req, res) => {
    const workspaceId = req.params.id!;
    requireWorkspaceRow(workspaceId);
    parseBody(workspaceDbOpSchema, req.body ?? {});
    const job = startWorkspaceDbOpJob(db, {
      workspaceId,
      kind: 'revert',
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /**
   * STORE-3a：GET /api/workspaces/:id/db → 工作区库状态只读汇总（db_mode / 闸门 / db 路径 /
   * 数据归属侧行数与附件 / 快照落后条数 / localize.json 中间态 / disabled+needsRevert）。
   */
  router.get('/workspaces/:id/db', (req, res) => {
    const workspaceId = req.params.id!;
    requireWorkspaceRow(workspaceId);
    const active = getActiveWorkspaceDbJob(workspaceId);
    res.json(buildWorkspaceDbStatus(db, { workspaceId }, {
      centerDbPath: currentDbPath ?? db.name,
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
      ...(active === null ? {} : { activeJob: { jobId: active.jobId, kind: active.kind ?? 'localize', status: active.status, stage: active.stage } }),
    }));
  });

  // ---- system ----
  // 原生文件夹选择（Windows PowerShell FolderBrowserDialog）；同一时刻仅允许一个窗口
  router.post('/system/pick-folder', async (_req, res) => {
    if (pickFolderInFlight) {
      throw new ApiError(409, 'PICK_FOLDER_BUSY', '已有选择窗口打开');
    }
    pickFolderInFlight = true;
    try {
      res.json({ path: await pickFolderViaPowerShell() });
    } finally {
      pickFolderInFlight = false;
    }
  });

  // ---- settings ----
  // 读侧只反映 config.json 持久化值（环境变量覆盖不参与，见 config.readSettings 注释）
  router.get('/settings', (_req, res) => {
    const settings = readSettings();
    // DB-1：对外规范名是 db_path；dbPath 保留给既有前端字段（同值，避免破坏已有设置界面）
    res.json({ ...settings, db_path: settings.dbPath });
  });

  // 写侧：端口/DB 路径重启生效（启动时 loadConfig 读取）；并发上限即时生效
  router.patch('/settings', (req, res) => {
    const body = parseBody(patchSettingsSchema, req.body);
    // DB-2B：迁移进行中不接受直接改 db 路径（否则与新库切换打架）
    if ((body.db_path !== undefined || body.dbPath !== undefined) && isMigrationActive(migrationStateDir)) {
      const text = describeMigrationError('DB_MIGRATION_BUSY');
      throw new ApiError(409, text.code, '迁移进行中，暂不接受直接修改 db 路径；请等迁移结束：' + text.message);
    }
    // DB-1：db_path 是对外规范名；与 dbPath 同时出现且不一致时明确报错（不静默取一个）
    if (body.db_path !== undefined && body.dbPath !== undefined && body.db_path !== body.dbPath) {
      throw new ValidationError('db_path 与 dbPath 同时出现且不一致：请只传 db_path');
    }
    const patch: Partial<typeof body> = { ...body, ...(body.db_path !== undefined ? { dbPath: body.db_path } : {}) };
    delete (patch as { db_path?: string }).db_path;
    const current = readSettings();
    const next = writeSettings(patch);
    if (body.maxConcurrentTurns !== undefined && body.maxConcurrentTurns !== current.maxConcurrentTurns) {
      setMaxConcurrentTurns(body.maxConcurrentTurns);
    }
    attachments.configure({
      attachmentQuotaBytes: next.attachmentQuotaBytes,
      attachmentStagedTtlMs: next.attachmentStagedTtlMs,
      attachmentCleanupIntervalMs: next.attachmentCleanupIntervalMs,
    });
    // DB-1：响应与 GET /settings 同形（都带对外 db_path），避免同一资源两种形状
    res.json({ ...next, db_path: next.dbPath });
  });

  // ---- DB-3B-S：存储位置只读汇总 ----
  // 只读：不改配置、不触发迁移。数字全部服务端算（含 ×1.2 空间门槛），前端只格式化。
  router.get('/settings/storage', (_req, res) => {
    if (currentDbPath === null) {
      throw new ApiError(503, 'DB_STORAGE_UNAVAILABLE', '当前装配拿不到数据库路径，存储统计不可用');
    }
    const attachmentsDir = attachmentsDirOf(currentDbPath);
    res.json(collectStorageInfo({
      dbPath: currentDbPath,
      attachmentsDir,
      dbPathSource: resolveDbPathSource(),
      countIssues: () => Number((db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n),
    }));
  });

  // ---- DB-2B：数据库位置迁移编排 ----
  // 顺序：preflight → snapshot → verify → switch → restart（旧进程）→ selfcheck → cleanup | rolled_back（新进程）。
  // 自检在新进程启动时跑，故本端点只保证「已切换 + 已拉起新进程」；结果用 GET 状态查询。
  router.post('/settings/db-path/migrate', async (req, res) => {
    const body = parseBody(dbMigrateSchema, req.body);
    if (resolveDbPathSource() === 'env') {
      const text = describeMigrationError('DB_MIGRATION_ENV_OVERRIDDEN');
      throw new ApiError(409, text.code, text.message);
    }
    if (isMigrationActive(migrationStateDir)) {
      const text = describeMigrationError('DB_MIGRATION_BUSY');
      throw new ApiError(409, text.code, text.message);
    }
    if (!deps.restart) {
      const text = describeMigrationError('DB_MIGRATION_RESTART_UNAVAILABLE');
      throw new ApiError(503, text.code, text.message);
    }
    if (currentDbPath === null) {
      throw new ApiError(503, 'DB_MIGRATION_UNAVAILABLE', '当前装配拿不到数据库路径，迁移不可用');
    }
    const status = await orchestrateMigration({
      fromDbPath: currentDbPath,
      toDbPath: body.target_db_path,
      fromAttachmentsDir: attachmentsDirOf(currentDbPath),
      toAttachmentsDir: attachmentsDirFor(body.target_db_path),
      ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
      stateDir: migrationStateDir,
      sourceDb: db,
      applySettings: (path) => { writeSettings({ dbPath: path }); },
      triggerRestart,
    });
    if (status.ok === false) {
      throw new ApiError(status.retryable ? 409 : 500, status.code ?? 'DB_MIGRATION_COPY_FAILED', status.message);
    }
    res.status(202).json({
      migration_id: status.migration_id,
      backup_dir: status.backup_dir,
      stages: status.stages,
      stage: status.stage,
      message: status.message,
    });
  });

  // 迁移状态：重启后由新进程读盘返回（内存表在重启时丢失）
  router.get('/settings/db-path/migrate/:migrationId', (req, res) => {
    const status = getMigrationStatus(migrationStateDir, req.params.migrationId);
    if (status === null) throw new NotFoundError('迁移记录不存在');
    res.json(status);
  });

  // ---- issues ----
  router.get('/issues', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    // CLI-LIST-GUARD：status 必须是该工作区已定义的状态（内置 + 自定义），
    // 非法 → 400 并列出可用状态；合法 → 两个分支都真的按它过滤（旧实现非分页分支直接忽略 status）。
    const status = req.query.status === undefined ? undefined : requireWorkspaceStatus(db, workspaceId, parseBody(issueStatusSchema, req.query.status));
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      const page = parseBody(pageQuerySchema, req.query);
      res.json(listIssuesPage(db, workspaceId, { ...page, status }));
    } else res.json(listIssues(db, workspaceId, status));
  });

  router.get('/issues/tree', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    const input = parseBody(issueTreeQuerySchema, req.query);
    // CLI-LIST-GUARD：树视图的 status 同样按工作区字典校验，避免自定义状态被静默过滤成空树
    const treeStatus = input.status === undefined ? undefined : requireWorkspaceStatus(db, workspaceId, input.status);
    const result = getIssueTreeChildren(db, {
      workspace_id: workspaceId,
      parent_issue_id: input.parent_issue_id ?? null,
      limit: input.limit,
      status: treeStatus,
      cursor: input.cursor,
    });
    res.json(result);
  });

  router.post('/issues', (req, res) => {
    // STORE-1（M1）：该工作区库不可写时不允许新建卡（与 /issues/:id 写操作同一门禁）
    if (typeof req.body?.workspace_id === 'string') {
      assertWorkspaceDbWritable(workspaceResolverDeps, requireWorkspaceRow(req.body.workspace_id));
    }
    const body = parseBody(createIssueSchema, req.body);
    const outcome = mutation(req, () => { requireExistingWorkspace(db, body.workspace_id); return createIssueInHierarchy(db, body); });
    // KB-CLI-1：幂等重放标记（CLI 文本/JSON 依此区分新建与重放）
    if (outcome.replayed) res.setHeader('x-agentboard-replayed', '1');
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // kb show 依赖：按 id 取单个 issue（设计 §6.2；REST 全表补充，只读不改契约语义）
  router.get('/issues/:id', (req, res) => {
    const issue = requireIssue(db, req.params.id!);
    if (req.query.description_offset_chars !== undefined || req.query.description_max_chars !== undefined) {
      const input = parseBody(descriptionQuerySchema, req.query); const window = textWindow(issue.description, input.description_offset_chars, input.description_max_chars);
      res.json({ ...issue, description: window.content, description_truncated: window.truncated, next_description_offset_chars: window.next_offset_chars });
    } else res.json(issue);
  });

  router.patch('/issues/:id', (req, res) => {
    const body = parseBody(patchIssueSchema, req.body);
    const { workspace_id, expected_updated_at, fence, ...patch } = body;
    if (expected_updated_at !== undefined && !workspace_id) throw new ValidationError('CAS 必须提供 workspace_id');
    const outcome = mutation(req, () => expected_updated_at !== undefined
      ? updateIssueWithCAS(db, req.params.id!, workspace_id!, expected_updated_at, patch)
      : updateIssueGuarded(db, req.params.id!, patch, fence));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // 设计 §7.4：非占用中删除，级联清理关联会话与消息。
  // 先停各绑定会话的运行中轮次（stopSession 对无在途轮次会话幂等：不 kill、仅状态落库已结束），
  // 再在同一事务内显式删 message → session → issue（不依赖 FK CASCADE 语义）。
  router.delete('/issues/:id', async (req, res) => {
    const issue = requireIssue(db, req.params.id!);
    if (issue.claimed_by !== null) throw new ConflictError('占用中禁止删除');
    requireNoIssueChildren(db, issue.id);
    const bound = listSessionsByIssue(db, issue.id);
    for (const session of bound) {
      await stopSession(session.id);
    }
    let unlockComments: ReturnType<typeof unlockCommentsForDeletedBlocker> = [];
    db.transaction(() => {
      for (const session of bound) {
        deleteMessagesBySession(db, session.id);
        deleteSession(db, session.id);
      }
      // DEP-1 §17-B4：删掉 blocker 卡时，同事务给每个被阻塞卡留解锁痕迹
      unlockComments = unlockCommentsForDeletedBlocker(db, issue.id);
      deleteIssue(db, issue.id);
    })();
    await attachments.processCleanup();
    broadcast({ type: 'issue.deleted', issue_id: issue.id, workspace_id: issue.workspace_id });
    for (const comment of unlockComments) broadcast({ type: 'comment.added', comment });
    for (const session of bound) {
      broadcast({ type: 'session.deleted', session_id: session.id });
    }
    res.status(204).end();
  });

  // ---- 依赖（DEP-1）----
  // 读写都锁定工作区（§17-B1）：GET/DELETE 走 query，POST 走 body；跨区依赖在服务层与服务端触发器双重拒绝。
  router.get('/issues/:id/dependencies', (req, res) => {
    const { workspace_id: workspaceId } = parseBody(dependencyQuerySchema, req.query);
    requireIssueInWorkspace(db, req.params.id!, workspaceId);
    res.json(listDependencies(db, req.params.id!));
  });

  router.post('/issues/:id/dependencies', (req, res) => {
    const body = parseBody(addDependencySchema, req.body);
    const outcome = mutation(req, () => addRelation(db, {
      blocked_issue_id: req.params.id!, blocker_issue_id: body.blocker_issue_id, workspace_id: body.workspace_id,
      relation: body.relation ?? 'blocks',
    }));
    if (!outcome.replayed) {
      broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
      broadcast({ type: 'issue.changed', issue: getIssue(db, body.blocker_issue_id)! });
    }
    res.status(201).json(outcome.result);
  });

  router.delete('/issues/:id/dependencies/:blockerId', (req, res) => {
    const { workspace_id: workspaceId } = parseBody(dependencyQuerySchema, req.query);
    const outcome = mutation(req, () => removeDependency(db, {
      blocked_issue_id: req.params.id!, blocker_issue_id: req.params.blockerId!, workspace_id: workspaceId,
    }));
    if (!outcome.replayed) {
      broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
      broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.blockerId!)! });
    }
    res.status(204).end();
  });

  // ---- comments ----
  router.get('/issues/:id/comments', (req, res) => {
    requireIssue(db, req.params.id!);
    if (req.query.limit !== undefined || req.query.offset !== undefined) res.json(listCommentsPage(db, req.params.id!, parseBody(pageQuerySchema, req.query)));
    else res.json(listCommentsByIssue(db, req.params.id!));
  });
  router.get('/issues/:id/pending-attachments', (req, res) => {
    requireIssue(db, req.params.id!);
    const input = parseBody(pageQuerySchema, req.query);
    res.json(listPendingIssueAttachments(db, req.params.id!, input));
  });
  router.get('/issues/:id/comments/:commentId', (req, res) => {
    requireIssue(db, req.params.id!);
    const input = parseBody(commentQuerySchema, req.query);
    const comment = getCommentContent(db, req.params.id!, req.params.commentId!, input.content_offset_chars, input.content_max_chars);
    res.json({ ...comment, next_content_offset_chars: comment.next_offset_chars });
  });

  router.get('/issues/:id/attachments/:attachmentId', (req, res, next) => {
    requireIssue(db, req.params.id!);
    const issueId = req.params.id!;
    const attachmentId = req.params.attachmentId!;
    const filePath = attachments.issuePath(issueId, attachmentId);
    res.type(attachments.issueMime(issueId, attachmentId));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachments.issueName(issueId, attachmentId))}`);
    res.sendFile(filePath, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(error); });
  });

  router.post('/issues/:id/comments', async (req, res) => {
    const body = parseBody(addCommentSchema, req.body);
    const attachmentIds = body.attachment_ids ?? [];
    const workspaceId = effectiveWorkspace(req);
    if (attachmentIds.length > 0 && !workspaceId) throw new ValidationError('图片评论必须提供 workspace_id');
    if (workspaceId) requireIssueInWorkspace(db, req.params.id!, workspaceId);
    // 作者身份：body.agent_id 存在 → agent:<agent_id>（agent 写评论），否则 user；唤醒判定在 addComment 内不变
    const author: string = body.agent_id ? `agent:${body.agent_id}` : 'user';
    const key = req.get('Idempotency-Key');
    if (key) {
      let wakeSessionId: string | null = null;
      const outcome = httpMutation(db, req, () => {
        const stored = storeComment(db, req.params.id!, author, body.content, attachmentIds, readFence(req, body));
        wakeSessionId = stored.wakeSessionId;
        return {
          comment: stored.comment,
          woke: false,
          ...(attachmentIds.length > 0 ? { warning: 'IMAGE_DELIVERY_UNVERIFIED' } : {}),
        } as AddCommentResult & { warning?: string };
      }, author === 'user');
      if (outcome.replayed) { res.json(outcome.result); return; }
      const result = outcome.result;
      if (attachmentIds.length > 0) result.warning = 'IMAGE_DELIVERY_UNVERIFIED';
      if (wakeSessionId) {
        const wake = await wakeStoredComment(db, getAdapter, attachments, req.params.id!, wakeSessionId, body.content, attachmentIds);
        result.woke = wake.woke;
        if (wake.warning) result.warning = wake.warning;
        else delete result.warning;
      }
      finishIdempotentEffect(db, key, result);
      broadcast({ type: 'comment.added', comment: result.comment });
      broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
      res.json(result); return;
    }
    const stored = storeComment(db, req.params.id!, author, body.content, attachmentIds, readFence(req, body));
    let woke = false;
    let warning: string | undefined;
    if (attachmentIds.length > 0) warning = 'IMAGE_DELIVERY_UNVERIFIED';
    if (stored.wakeSessionId) {
      const wake = await wakeStoredComment(db, getAdapter, attachments, req.params.id!, stored.wakeSessionId, body.content, attachmentIds);
      woke = wake.woke;
      warning = wake.warning;
    }
    broadcast({ type: 'comment.added', comment: stored.comment });
    broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
    res.json({ comment: stored.comment, woke, ...(warning ? { warning } : {}) });
  });

  // 留言消费（kb 占用场景）：事务内读全部评论 + 标注新评论 + 推进游标，恰好一次
  router.post('/issues/:id/comments/consume', (req, res) => {
    res.json(consumeComments(db, req.params.id!));
  });

  // ---- 占用事务 ----
  // REST claim 仅占用登记（session_id=null），不建会话；派发场景走 POST /api/sessions
  router.post('/issues/:id/claim', async (req, res) => {
    const body = parseBody(claimSchema, req.body);
    const outcome = mutation(req, () => {
      const issue = claimIssue(db, req.params.id!, body.agent_id, null);
      return { ...issue, knowledge: getTaskKnowledge(db, issue, body.knowledge_enabled ?? true, body.knowledge_query) };
    });
    // 领取后记录 git 基线（GIT-ON-DONE）；失败静默，不阻断领取
    if (!outcome.replayed) await captureIssueGitBaseline(db, req.params.id!);
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // BORROW-0.2：占用续租。不进幂等表——心跳只刷新租约，重放无意义；fence 校验属 B03。
  router.post('/issues/:id/heartbeat', (req, res) => {
    const body = parseBody(claimSchema, req.body);
    const lease = heartbeatClaim(db, req.params.id!, body.agent_id, readFence(req, body));
    broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
    res.json(lease);
  });

  // BORROW-0.3：fence 双通道——body.fence 优先，回退 x-claim-fence 头；缺席=软模式；值非法一律 400
  function readFence(req: Request, body: { fence?: number } | undefined): number | undefined {
    if (body?.fence !== undefined) return body.fence;
    const raw = req.get(CLAIM_FENCE_HEADER);
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ValidationError(`x-claim-fence 头需为 ≥0 整数，收到 ${JSON.stringify(raw)}`);
    return parsed;
  }

  // 自动评论补 WS 推送：comment 非空时追加 comment.added（顺序与手动评论端点一致：先 comment.added 后 issue.changed）
  async function claimAction(req: Request, res: Response, action: 'release' | 'done' | 'fail') {
    const issueId = String(req.params.id);
    const workspace = effectiveWorkspace(req);
    if (req.get('Idempotency-Key') && !workspace) throw new ValidationError('幂等 owner 操作必须提供 workspace_id');
    const actor = action === 'release' && !workspace ? 'user' : parseBody(claimSchema, req.body).agent_id;
    const fence = readFence(req, req.body as { fence?: number } | undefined);
    const doneBody = action === 'done' ? parseBody(doneSchema, req.body) : undefined;
    const detail = action === 'done' ? doneBody!.notes : action === 'fail' ? parseBody(failSchema, req.body).reason : undefined;
    // GIT-ON-DONE 提交范围：只有 done 认 scope_paths（文件路径或目录前缀），其余动作忽略
    const scopePaths = doneBody?.scope_paths ?? [];
    // KB-WRITE-NUDGE：hint 必须在 done 清空 claimed_at/claimed_by 之前算，并随幂等结果一起缓存（重放响应要逐字一致）
    const outcome = workspace ? mutation(req, () => {
      if (action === 'done') {
        const preFinish = getIssue(db, issueId);
        const hint = preFinish ? buildKnowledgeHint(db, preFinish) : null;
        return { ...finishClaimedIssue(db, issueId, workspace, actor, 'done', detail, fence), knowledge_hint: hint };
      }
      return action === 'release'
        ? releaseClaimedIssue(db, issueId, workspace, actor, fence)
        : finishClaimedIssue(db, issueId, workspace, actor, action, detail, fence);
    }) : { result: action === 'release'
      ? await releaseIssue(db, issueId, fence) : action === 'done'
        ? await (async () => {
          const preFinish = getIssue(db, issueId);
          const hint = preFinish ? buildKnowledgeHint(db, preFinish) : null;
          return { ...(await doneIssue(db, issueId, actor, detail, fence)), knowledge_hint: hint };
        })() : await failIssue(db, issueId, actor, detail!, undefined, fence), replayed: false };
    const { issue, comment } = outcome.result;
    const knowledgeHint = (outcome.result as { knowledge_hint?: KnowledgeHint | null }).knowledge_hint ?? null;
    // KB-CLI-1：done/fail/release 幂等重放同样回传标记
    if (outcome.replayed) res.setHeader('x-agentboard-replayed', '1');
    if (!outcome.replayed) {
      if (comment) broadcast({ type: 'comment.added', comment });
      broadcast({ type: 'issue.changed', issue });
      // GIT-ON-DONE：done 后按 claim 基线提交本任务改动；幂等重放不重复提交
      if (action === 'done') {
        const gitNote = await commitIssueChanges(db, issueId, scopePaths);
        if (gitNote) {
          const added = await addComment(db, issueId, 'system', gitNote);
          broadcast({ type: 'comment.added', comment: added.comment });
        }
      } else {
        dropIssueGitBaseline(db, issueId);
      }
    }
    res.json(action === 'done' ? { ...issue, comment, knowledge_hint: knowledgeHint } : { ...issue, comment });
  }
  router.post('/issues/:id/release', (req, res) => claimAction(req, res, 'release'));
  router.post('/issues/:id/done', (req, res) => claimAction(req, res, 'done'));
  router.post('/issues/:id/fail', (req, res) => claimAction(req, res, 'fail'));

  // ---- CLI-CLOSE：验收后流转（close 待验收→已关闭；reopen 已关闭/已废弃→指定状态）----
  router.post('/issues/:id/close', (req, res) => {
    const workspace = effectiveWorkspace(req);
    const outcome = mutation(req, () => closeIssue(db, req.params.id!, workspace));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });
  router.post('/issues/:id/reopen', (req, res) => {
    const workspace = effectiveWorkspace(req);
    const body = parseBody(reopenSchema, req.body ?? {});
    const outcome = mutation(req, () => reopenIssue(db, req.params.id!, body.status, workspace));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // ---- clis ----
  router.get('/clis', (_req, res) => {
    res.json(getCachedClis());
  });

  router.get('/clis/:id/models', async (req, res) => {
    let adapter: AgentAdapter;
    try {
      adapter = getAdapter(req.params.id!);
    } catch {
      throw new NotFoundError(`未知 CLI: ${req.params.id}`);
    }
    res.json(await adapter.listModels());
  });

  // ---- approval rules（CHAT-APP1 契约 #16/#17）----
  // 只列未撤销规则（撤销入口数据源）；DELETE 是软撤销，行保留作审计。
  router.get('/workspaces/:workspaceId/approval-rules', (req, res) => {
    const workspaceId = req.params.workspaceId!;
    requireExistingWorkspace(db, workspaceId);
    res.json(listActiveApprovalRules(db, workspaceId));
  });

  router.delete('/workspaces/:workspaceId/approval-rules/:ruleId', (req, res) => {
    const workspaceId = req.params.workspaceId!;
    requireExistingWorkspace(db, workspaceId);
    res.json(revokeApprovalRule(db, workspaceId, req.params.ruleId!));
  });

  // ---- sessions ----
  // 运行时态（队列长度/等待槽位）内存合并进响应，不入库、不回传队列文本
  router.get('/sessions', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    // CHAT-SB1（契约 #11）：默认排除归档会话；侧栏「归档组」用 include_archived=1 拉全量
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const sessions = listSessionsByWorkspace(db, workspaceId, { includeArchived });
    // AUDIT-SRV（F-03）：首条用户消息预览 + 来源（dispatch=绑任务，chat=自由会话），一次查回避免 N+1
    const previews = listFirstUserMessages(db, sessions.map((s) => s.id));
    res.json(
      sessions.map((s) => {
        const runtime = getSessionRuntime(s.id);
        return {
          ...s,
          preview: buildSessionPreview(previews.get(s.id) ?? ''),
          source: s.issue_id === null ? 'chat' : 'dispatch',
          queued_count: runtime.queuedCount,
          waiting_slot: runtime.waitingSlot,
        };
      }),
    );
  });

  // 聊天视图刷新恢复：panelStore 持久化的 sessionId 在 chatSession 缺失时按 id 拉取
  router.get('/sessions/:id', (req, res) => {
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const runtime = getSessionRuntime(session.id);
    // CHAT-AWAIT1（契约 #18）：详情带该会话 turns，阻塞/超时状态可直接读取
    res.json({
      ...session,
      queued_count: runtime.queuedCount,
      waiting_slot: runtime.waitingSlot,
      turns: listTurnsBySession(db, session.id),
    });
  });

  // 停止后队列查看（只读，不提供编辑）：返回当前内存排队文本
  router.get('/sessions/:id/queue', (req, res) => {
    if (!getSession(db, req.params.id!)) throw new NotFoundError('会话不存在');
    res.json({ texts: getSessionRuntime(req.params.id!).queuedTexts });
  });

  router.get('/sessions/:id/messages', (req, res) => {
    if (!getSession(db, req.params.id!)) throw new NotFoundError('会话不存在');
    const raw = req.query.after;
    let after = 0;
    if (typeof raw === 'string' && raw !== '') {
      after = Number(raw);
      if (!Number.isFinite(after) || after < 0) throw new ValidationError('after 必须为非负整数时间戳');
    }
    res.json(listMessagesBySession(db, req.params.id!, after));
  });

  // BORROW-4.2：会话事件流增量拉取（after_seq 之后的全部事件，seq 升序；老会话返回空数组）
  router.get('/sessions/:id/events', (req, res) => {
    if (!getSession(db, req.params.id!)) throw new NotFoundError('会话不存在');
    const raw = req.query.after_seq;
    let afterSeq = 0;
    if (typeof raw === 'string' && raw !== '') {
      afterSeq = Number(raw);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw new ValidationError('after_seq 必须为非负整数');
      }
    }
    res.json(listSessionEvents(db, req.params.id!, afterSeq));
  });

  // 契约修订：issue_id 为空时 body.workspace_id 必填；绑 issue 时自动 claim+派发
  router.post('/sessions', async (req, res) => {
    const body = parseBody(createSessionSchema, req.body);
    let session;
    let knowledge: ReturnType<typeof getTaskKnowledge> | undefined;
    let remainingAttachmentCount: number | undefined;
    let replayed = false;
    if (body.issue_id) {
      const result = await dispatchIssue(db, { getAdapter, attachments }, {
        issueId: body.issue_id,
        cli: body.cli,
        model: body.model ?? null,
        promptTemplate: body.prompt,
        reuse_session: body.reuse_session,
        knowledge_enabled: body.knowledge_enabled,
        knowledge_query: body.knowledge_query,
        retry_unknown_images: body.retry_unknown_images,
        selected_attachment_ids: body.selected_attachment_ids,
        idempotency_key: req.get('Idempotency-Key') ?? undefined,
        idempotency_payload_hash: req.get('Idempotency-Key') ? hashPayload({ body, query: req.query }) : undefined,
      });
      replayed = result.replayed ?? false;
      if (!replayed) broadcast({ type: 'issue.changed', issue: result.issue });
      session = result.session;
      knowledge = result.knowledge;
      remainingAttachmentCount = result.remaining_attachment_count;
    } else {
      session = await createSession({
        cli: body.cli,
        model: body.model ?? null,
        workspace_id: body.workspace_id,
        prompt: body.prompt ?? null,
      });
    }
    if (!replayed) broadcast({ type: 'session.changed', session });
    const result = knowledge ? { ...session, knowledge } : session;
    res.json(remainingAttachmentCount === undefined ? result : { ...result, remaining_attachment_count: remainingAttachmentCount });
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const body = parseBody(sendMessageSchema, req.body);
    const attachmentIds = body.attachment_ids ?? [];
    if (attachmentIds.length === 0) {
      res.json(await sendToSession(req.params.id!, body.text));
      return;
    }
    // CHAT-IMG-DELIVERY：聊天发消息携带附件——先验 CLI 图片输入（失败不绑定，附件保持 staged 可重发），
    // 再绑定到会话（session_attachment），经既有 RunTurnOptions.attachments → adapter base64 通道投递
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    let adapter: AgentAdapter;
    try { adapter = getAdapter(session.cli); }
    catch {
      // 取不到适配器（未知 cli id）：给「换执行方式」的通用指路
      throw new ValidationError(`IMAGE_DELIVERY_UNVERIFIED:${imageDeliveryHint({
        cliId: 'unknown',
        displayName: session.cli,
        detectedVersion: null,
        ...(session.model ? { model: session.model } : {}),
      })}`);
    }
    const verifiedCliVersion = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined);
    if (verifiedCliVersion === null || !adapter.supportsImageInput(session.model ?? undefined, verifiedCliVersion)) {
      const detected = await adapter.detect().catch(() => ({ installed: false, version: null as string | null }));
      throw new ValidationError(`IMAGE_DELIVERY_UNVERIFIED:${imageDeliveryHint({
        cliId: adapter.id,
        displayName: adapter.displayName,
        detectedVersion: detected.version,
        ...(session.model ? { model: session.model } : {}),
      })}`);
    }
    bindAttachmentsToSession(db, session.workspace_id, session.id, attachmentIds, Date.now());
    const imageAttachments = attachmentIds.map((id) => ({
      path: attachments.sessionPath(session.id, id),
      mimeType: attachments.sessionMime(session.id, id) as 'image/png' | 'image/jpeg' | 'image/webp',
    }));
    res.json(await sendToSession(session.id, body.text, {
      attachments: imageAttachments,
      deliveredAttachmentIds: attachmentIds,
      verifiedCliVersion,
      sessionAttachment: true,
    }));
  });

  router.post('/sessions/:id/stop', async (req, res) => {
    res.json(await stopSession(req.params.id!));
  });

  // 持久删除会话（聊天视图删除入口）：运行中/正占用任务时 409 拒绝（不自动释放 claim、不加 system 评论）；
  // 删除顺序照 issue 删除示范——事务内先删 message 再删 session，最后清内存态并无 body 204 + 广播 session.deleted。
  // 幂等：重复删除已删会话落 404（会话不存在），不会 500。
  router.delete('/sessions/:id', (req, res) => {
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    if (session.status === '运行中') throw new ConflictError('会话正在运行，请先停止再删除');
    if (session.issue_id !== null) {
      const issue = getIssue(db, session.issue_id);
      if (
        issue !== null &&
        issue.status === '进行中' &&
        issue.claimed_by !== null &&
        issue.session_id === session.id
      ) {
        throw new ConflictError(
          `该会话正占用任务「${issue.title}」，请先标记待验收或释放占用后再删除`,
        );
      }
    }
    db.transaction(() => {
      deleteMessagesBySession(db, session.id);
      deleteSession(db, session.id);
    })();
    forgetSession(session.id);
    broadcast({ type: 'session.deleted', session_id: session.id });
    res.status(204).end();
  });

  // Task 14：修改会话模型（下一轮生效——sessionManager.runTurn 起轮时读取 session.model）
  // 会话标题：同一端点接受 title（1–50 字，null 清空回到派生标题），与 model 可同时提交。
  // CHAT-SB1：同一端点接受 archived（true=归档 / false=恢复）；运行中归档与删除同口径 409。
  router.patch('/sessions/:id', (req, res) => {
    const body = parseBody(patchSessionSchema, req.body);
    const current = getSession(db, req.params.id!);
    if (!current) throw new NotFoundError('会话不存在');
    if (body.archived === true && current.status === '运行中') {
      throw new ConflictError('会话正在运行，请先停止再归档');
    }
    const patch: { model?: string | null; title?: string | null; archived_at?: number | null } = {};
    if (body.model !== undefined) patch.model = body.model;
    if (body.title !== undefined) patch.title = body.title;
    if (body.archived !== undefined) patch.archived_at = body.archived ? Date.now() : null;
    const session = updateSession(db, req.params.id!, patch);
    broadcast({
      type: 'session.changed',
      session,
      session_id: session.id,
      title: session.title ?? null,
      archived_at: session.archived_at ?? null,
      forked_from_session_id: session.forked_from_session_id ?? null,
    });
    res.json(session);
  });

  // CHAT-SB1（契约 #12）：分叉会话——复制截止消息到新会话（不复制 plan / adapter_session_id），
  // 新会话继承 issue_id / cli / model，并写 forked_from_session_id + fork_message_id 来源标记。
  router.post('/sessions/:id/fork', (req, res) => {
    const body = parseBody(forkSessionSchema, req.body ?? {});
    const session = forkSession(db, req.params.id!, {
      fromMessageId: body.from_message_id ?? null,
      title: body.title,
    });
    broadcast({
      type: 'session.changed',
      session,
      session_id: session.id,
      title: session.title ?? null,
      archived_at: session.archived_at ?? null,
      forked_from_session_id: session.forked_from_session_id ?? null,
    });
    res.json(session);
  });

  // CHAT-AWAIT1（契约 #13）：回答阻塞轮次——同一 turn 继续（步骤 awaiting→done，下一步 running），
  // 非 awaiting_input 一律 409（重复回答天然幂等）；成功推一次 session.turn。
  router.post('/sessions/:id/turns/:turnId/answer', (req, res) => {
    const body = parseBody(answerTurnSchema, req.body ?? {});
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const turn = answerAwaitingTurn(db, session.id, req.params.turnId!, {
      optionId: body.option_id,
      text: body.text,
    });
    broadcast({
      type: 'session.turn',
      session_id: session.id,
      turn_id: turn.id,
      state: turn.state,
      awaiting: null,
    });
    res.json(turn);
  });

  // CHAT-RETRY1（契约 #15）：单步重试——只重跑该 failed + retryable 的步骤，不新建轮次、不整轮重发。
  // 校验/幂等/状态推进与广播都在 service 内完成（重复提交在状态校验处 409，不会执行第二次）。
  router.post('/sessions/:id/turns/:turnId/steps/:stepId/retry', async (req, res) => {
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const result = await retryFailedStep(db, session.id, req.params.turnId!, req.params.stepId!, {
      broadcast,
      execute: ({ session_id, turn_id, step_id, tool_name }) => runRetriedStep(session_id, { turn_id, step_id, tool_name }),
    });
    res.json(result);
  });

  // CHAT-APP1（契约 #14）：三档确认决策——allow 按档写规则并恢复 running，deny 置 stopped；
  // 非 awaiting_approval / 重复决策 → 409；request_id 不匹配 → 404；写类工具 + workspace 档 → 403。
  router.post('/sessions/:id/turns/:turnId/approvals/:requestId', (req, res) => {
    const body = parseBody(approvalDecisionSchema, req.body ?? {});
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const result = decideTurnApproval(db, session.id, req.params.turnId!, req.params.requestId!, body);
    broadcast({
      type: 'session.turn',
      session_id: session.id,
      turn_id: result.turn.id,
      state: result.turn.state,
      awaiting: result.turn.state === 'running' ? null : result.turn.awaiting_json,
    });
    res.json(result);
  });

  return router;
}

/** 统一错误响应 {error:{code,message}}（ValidationError→400/NotFoundError→404/ConflictError→409/其余→500） */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    return;
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    // KBIMP-1B：导入端点的上限是 2 MiB 请求体，文案不能套用「单张图片」
    if (req.path.startsWith('/api/knowledge/pages/import')) {
      res.status(413).json({ error: { code: 'IMPORT_TOO_LARGE', message: '导入请求体过大（上限 12 MiB）；单文件上限 10MB、单页正文上限 2,000,000 字符' } });
      return;
    }
    res.status(413).json({ error: { code: 'ATTACHMENT_TOO_LARGE', message: '单张图片不能超过 10 MiB' } });
    return;
  }
  // CLAIM-RACE：SQLite 忙等超时（busy_timeout=5000）不是内部错误——而是「别的进程/请求正握着写锁」，
  // 映射成 409 让调用方（agent / kb CLI）知道「重试即可」，而不是当成 500 崩掉。
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'SQLITE_BUSY') {
    res.status(409).json({ error: { code: 'DB_BUSY', message: '数据库正被其它操作占用（写锁等待超时），请稍后重试' } });
    return;
  }
  console.error('[agentboard] 未处理错误:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
}

/** 未匹配的 /api 路由 → 404 JSON（避免落到静态托管） */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` } });
};
