/**
 * Task 9：REST 路由（Pinned Contracts REST 全表 + 契约修订）。
 *
 * 修订点：POST /api/sessions 体增 workspace_id?——issue_id 为空时必填（400 校验）；
 * POST /api/issues/:id/claim 仅做占用登记（session_id 置 null，供 kb claim 场景），不建会话。
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import express, { Router } from 'express';
import { createKnowledgeRouter } from './knowledgeRoutes.js';
import { createAccountRouter } from './accountRoutes.js';
import { createSystemRouter, type RestartDeps } from './systemRoutes.js';
import { createArchivedChangelogRouter, createChangelogRouter } from './changelogRoutes.js';
import { createWorkspaceStatusRouter } from './workspaceStatusRoutes.js';
import { createDraftService, type DraftRunner } from '../services/smartCreateDraft.js';
import type { WorkbuddyDesktopProvider } from '../services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec, CheckinVault } from '../services/accounts/checkinProvider.js';
import type { QuotaService } from '../services/quotas/quotaService.js';
import { getTaskKnowledge } from '../services/taskKnowledge.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { AgentAdapter } from '@agentboard/adapters';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import type { KnowledgeHint, ManagedAppId, WsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import type { SecretVault } from '../services/accounts/secretVault.js';
import { AttachmentStore, MAX_IMAGE_BYTES } from '../services/attachments.js';
import {
  createWorkspace,
  deleteWorkspace,
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
import { listPendingIssueAttachments } from '../db/repos/attachment.js';
import { textWindow } from '../db/pagination.js';
import {
  listSessionsByWorkspace,
  listSessionsByIssue,
  getSession,
  updateSession,
  deleteSession,
} from '../db/repos/session.js';
import { listMessagesBySession, deleteMessagesBySession } from '../db/repos/message.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { claimIssue, doneIssue, failIssue, releaseIssue, updateIssueGuarded, requireIssueInWorkspace, updateIssueWithCAS, finishClaimedIssue, releaseClaimedIssue } from '../services/claim.js';
import { captureIssueGitBaseline, commitIssueChanges, dropIssueGitBaseline } from '../services/gitBaseline.js';
import { listSkills } from '../services/skills.js';
import type { MinimaxClientProbe } from '../services/accounts/minimaxClientProbe.js';
import { addDependency, listDependencies, removeDependency, unlockCommentsForDeletedBlocker } from '../services/dependency.js';
import { requireWorkspaceStatus } from '../services/workspaceStatus.js';
import { closeIssue, reopenIssue } from '../services/issueTransitions.js';
import { buildKnowledgeHint } from '../services/knowledgeNudge.js';
import type { ExportRunner } from '../services/accounts/credentialImport.js';
import { addComment, consumeComments, storeComment, wakeCommentSession, type AddCommentResult } from '../services/comments.js';
import { hashPayload, httpMutation, finishIdempotentEffect } from '../services/idempotency.js';
import { dispatchIssue } from '../services/dispatch.js';
import { createSession, forgetSession, getSessionRuntime, sendToSession, setMaxConcurrentTurns, stopSession } from '../services/sessionManager.js';
import { getCachedClis } from '../services/cliDetect.js';
import { readSettings, writeSettings } from '../config.js';
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
  patchSettingsSchema,
  sendMessageSchema,
  pageQuerySchema, descriptionQuerySchema, commentQuerySchema, issueStatusSchema,
  addDependencySchema, dependencyQuerySchema, draftRequestSchema, reopenSchema,
} from './schemas.js';

export interface RouterDeps {
  db: Db;
  attachments: AttachmentStore;
  secretVault?: SecretVault;
  getAdapter: (cliId: string) => AgentAdapter;
  /** WS 广播钩子（index.ts 装配 hub.broadcast） */
  broadcast: (event: WsEvent) => void;
  /** 账号 provider 装配（ACC-05/ACC-07）；缺省时账号写接口返回 PROVIDER_UNAVAILABLE */
  accounts?: { workbuddy?: WorkbuddyDesktopProvider; checkinProvider?: CheckinProviderSpec; checkinProviders?: Partial<Record<ManagedAppId, CheckinProviderSpec>>; vault?: CheckinVault; desktopProviders?: Partial<Record<ManagedAppId, Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>>>; quotas?: Pick<QuotaService, 'get'>; minimaxClientProbe?: MinimaxClientProbe };
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
}

/** zod 校验：失败抛 ValidationError（错误中间件 → 400） */
/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 * 例：invalid_value → 「取值必须是：a / b」；too_small → 「不能小于 N」。
 */
function zhZodIssue(rawIssue: unknown): string {
  const issue = (rawIssue ?? {}) as { code?: string; path?: Array<string | number>; message?: string; minimum?: unknown; maximum?: unknown; options?: unknown[]; expected?: unknown };
  const where = issue.path && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  const raw = (issue as { options?: unknown[]; values?: unknown[] });
  const list = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.values) ? raw.values : [];
  const options = list.map(String);
  switch (issue.code) {
    case 'invalid_value':
    case 'invalid_enum_value':
      return options.length > 0 ? `${where}取值必须是：${options.join(' / ')}` : `${where}${issue.message ?? '取值不合法'}`;
    case 'too_small':
      return `${where}不能小于 ${String(issue.minimum ?? '')}`.trim();
    case 'too_big':
      return `${where}不能大于 ${String(issue.maximum ?? '')}`.trim();
    case 'invalid_type':
      return `${where}类型不对（期望 ${String(issue.expected ?? '')}）`;
    case 'unrecognized_keys':
    case 'custom':
      return `${where}${issue.message ?? '参数不合法'}`;
    default:
      return `${where}${issue.message ?? '参数不合法'}`;
  }
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

function requireWorkspaceParam(req: Request): string {
  const value = req.query.workspace;
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
    res.json({ name: 'agentboard-server', version: SERVER_VERSION, pid: process.pid });
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
  router.use(createSystemRouter({ restart: deps.restart }));
  router.use(createAccountRouter({ db, workbuddy: deps.accounts?.workbuddy, checkinProvider: deps.accounts?.checkinProvider, checkinProviders: deps.accounts?.checkinProviders, desktopProviders: deps.accounts?.desktopProviders, vault: deps.accounts?.vault ?? deps.secretVault, credentialRunner: deps.credentialRunner, quotas: deps.accounts?.quotas, minimaxClientProbe: deps.accounts?.minimaxClientProbe }));
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

  router.use('/issues/:id', (req, _res, next) => {
    const raw = req.query.workspace_id ?? req.body?.workspace_id;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !raw) throw new ValidationError('workspace_id 不合法');
      if (req.query.workspace_id && req.body?.workspace_id && req.query.workspace_id !== req.body.workspace_id) throw new ValidationError('workspace_id 不一致');
      const wrappedMutation = req.get('Idempotency-Key') && ((req.method === 'PATCH' && req.path === '/') || (req.method === 'POST' && ['/claim', '/release', '/done', '/fail', '/comments', '/dependencies', '/close', '/reopen'].includes(req.path)));
      if (!wrappedMutation) requireIssueInWorkspace(deps.db, String(req.params.id), raw);
    }
    next();
  });

  // ---- workspaces ----
  router.get('/workspaces', (req, res) => {
    if (req.query.limit !== undefined || req.query.offset !== undefined) { const page = parseBody(pageQuerySchema, req.query); res.json(listWorkspacesPage(db, page.limit, page.offset)); }
    else res.json(listWorkspaces(db));
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
    const blockers = getWorkspaceDeleteBlockers(db, req.params.id!);
    if (blockers.knowledgePages > 0)
      throw new ConflictError(
        `该空间仍有 ${blockers.knowledgePages} 个知识页及 ${blockers.knowledgeRevisions} 条历史 revision，请先删除或迁移知识页后再移除`,
      );
    if (blockers.runningSessions > 0)
      throw new ConflictError(`该空间有 ${blockers.runningSessions} 个运行中会话，请先结束会话后再移除`);
    if (blockers.childIssues > 0)
      throw new ConflictError(`该空间有 ${blockers.childIssues} 个子任务仍挂在父任务下，请先解除关联后再移除`);
    deleteWorkspace(db, req.params.id!);
    await attachments.processCleanup();
    res.status(204).end();
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
    const filePath = attachments.stagedPath(workspaceId, id);
    res.type(attachments.stagedMime(workspaceId, id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachments.stagedName(workspaceId, id))}`);
    res.sendFile(filePath, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(error); });
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
    res.json(readSettings());
  });

  // 写侧：端口/DB 路径重启生效（启动时 loadConfig 读取）；并发上限即时生效
  router.patch('/settings', (req, res) => {
    const body = parseBody(patchSettingsSchema, req.body);
    const current = readSettings();
    const next = writeSettings(body);
    if (body.maxConcurrentTurns !== undefined && body.maxConcurrentTurns !== current.maxConcurrentTurns) {
      setMaxConcurrentTurns(body.maxConcurrentTurns);
    }
    attachments.configure({
      attachmentQuotaBytes: next.attachmentQuotaBytes,
      attachmentStagedTtlMs: next.attachmentStagedTtlMs,
      attachmentCleanupIntervalMs: next.attachmentCleanupIntervalMs,
    });
    res.json(next);
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
    const body = parseBody(createIssueSchema, req.body);
    const outcome = mutation(req, () => { requireExistingWorkspace(db, body.workspace_id); return createIssueInHierarchy(db, body); });
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
    const { workspace_id, expected_updated_at, ...patch } = body;
    if (expected_updated_at !== undefined && !workspace_id) throw new ValidationError('CAS 必须提供 workspace_id');
    const outcome = mutation(req, () => expected_updated_at !== undefined
      ? updateIssueWithCAS(db, req.params.id!, workspace_id!, expected_updated_at, patch)
      : updateIssueGuarded(db, req.params.id!, patch));
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
    const outcome = mutation(req, () => addDependency(db, {
      blocked_issue_id: req.params.id!, blocker_issue_id: body.blocker_issue_id, workspace_id: body.workspace_id,
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
        const stored = storeComment(db, req.params.id!, author, body.content, attachmentIds);
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
    const stored = storeComment(db, req.params.id!, author, body.content, attachmentIds);
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

  // 自动评论补 WS 推送：comment 非空时追加 comment.added（顺序与手动评论端点一致：先 comment.added 后 issue.changed）
  async function claimAction(req: Request, res: Response, action: 'release' | 'done' | 'fail') {
    const issueId = String(req.params.id);
    const workspace = effectiveWorkspace(req);
    if (req.get('Idempotency-Key') && !workspace) throw new ValidationError('幂等 owner 操作必须提供 workspace_id');
    const actor = action === 'release' && !workspace ? 'user' : parseBody(claimSchema, req.body).agent_id;
    const doneBody = action === 'done' ? parseBody(doneSchema, req.body) : undefined;
    const detail = action === 'done' ? doneBody!.notes : action === 'fail' ? parseBody(failSchema, req.body).reason : undefined;
    // GIT-ON-DONE 提交范围：只有 done 认 scope_paths（文件路径或目录前缀），其余动作忽略
    const scopePaths = doneBody?.scope_paths ?? [];
    // KB-WRITE-NUDGE：hint 必须在 done 清空 claimed_at/claimed_by 之前算，并随幂等结果一起缓存（重放响应要逐字一致）
    const outcome = workspace ? mutation(req, () => {
      if (action === 'done') {
        const preFinish = getIssue(db, issueId);
        const hint = preFinish ? buildKnowledgeHint(db, preFinish) : null;
        return { ...finishClaimedIssue(db, issueId, workspace, actor, 'done', detail), knowledge_hint: hint };
      }
      return action === 'release'
        ? releaseClaimedIssue(db, issueId, workspace, actor)
        : finishClaimedIssue(db, issueId, workspace, actor, action, detail);
    }) : { result: action === 'release'
      ? await releaseIssue(db, issueId) : action === 'done'
        ? await (async () => {
          const preFinish = getIssue(db, issueId);
          const hint = preFinish ? buildKnowledgeHint(db, preFinish) : null;
          return { ...(await doneIssue(db, issueId, actor, detail)), knowledge_hint: hint };
        })() : await failIssue(db, issueId, actor, detail!), replayed: false };
    const { issue, comment } = outcome.result;
    const knowledgeHint = (outcome.result as { knowledge_hint?: KnowledgeHint | null }).knowledge_hint ?? null;
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

  // ---- sessions ----
  // 运行时态（队列长度/等待槽位）内存合并进响应，不入库、不回传队列文本
  router.get('/sessions', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    res.json(
      listSessionsByWorkspace(db, workspaceId).map((s) => {
        const runtime = getSessionRuntime(s.id);
        return { ...s, queued_count: runtime.queuedCount, waiting_slot: runtime.waitingSlot };
      }),
    );
  });

  // 聊天视图刷新恢复：panelStore 持久化的 sessionId 在 chatSession 缺失时按 id 拉取
  router.get('/sessions/:id', (req, res) => {
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const runtime = getSessionRuntime(session.id);
    res.json({ ...session, queued_count: runtime.queuedCount, waiting_slot: runtime.waitingSlot });
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
    const result = await sendToSession(req.params.id!, body.text);
    res.json(result);
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

  // Task 14：修改会话模型（只改 model 字段，下一轮生效——sessionManager.runTurn 起轮时读取 session.model）
  router.patch('/sessions/:id', (req, res) => {
    const body = parseBody(patchSessionSchema, req.body);
    if (!getSession(db, req.params.id!)) throw new NotFoundError('会话不存在');
    const session = updateSession(db, req.params.id!, { model: body.model });
    broadcast({ type: 'session.changed', session });
    res.json(session);
  });

  return router;
}

/** 统一错误响应 {error:{code,message}}（ValidationError→400/NotFoundError→404/ConflictError→409/其余→500） */
export function errorHandler(err: unknown, _req: Request, _res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    _res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    _res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    return;
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    _res.status(413).json({ error: { code: 'ATTACHMENT_TOO_LARGE', message: '单张图片不能超过 10 MiB' } });
    return;
  }
  console.error('[agentboard] 未处理错误:', err);
  _res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
}

/** 未匹配的 /api 路由 → 404 JSON（避免落到静态托管） */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` } });
};
