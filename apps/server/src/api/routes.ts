/**
 * Task 9：REST 路由（Pinned Contracts REST 全表 + 契约修订）。
 *
 * 修订点：POST /api/sessions 体增 workspace_id?——issue_id 为空时必填（400 校验）；
 * POST /api/issues/:id/claim 仅做占用登记（session_id 置 null，供 kb claim 场景），不建会话。
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { AgentAdapter } from '@agentboard/adapters';
import type { WsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
} from '../db/repos/workspace.js';
import { createIssue, deleteIssue, getIssue, listIssues } from '../db/repos/issue.js';
import { listCommentsByIssue } from '../db/repos/comment.js';
import {
  listSessionsByWorkspace,
  listSessionsByIssue,
  getSession,
  updateSession,
  deleteSession,
} from '../db/repos/session.js';
import { listMessagesBySession, deleteMessagesBySession } from '../db/repos/message.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { claimIssue, doneIssue, failIssue, releaseIssue, updateIssueGuarded } from '../services/claim.js';
import { addComment, consumeComments } from '../services/comments.js';
import { dispatchIssue } from '../services/dispatch.js';
import { createSession, getSessionRuntime, sendToSession, setMaxConcurrentTurns, stopSession } from '../services/sessionManager.js';
import { getCachedClis } from '../services/cliDetect.js';
import { readSettings, writeSettings } from '../config.js';
import {
  addCommentSchema,
  claimSchema,
  createIssueSchema,
  createSessionSchema,
  createWorkspaceSchema,
  doneSchema,
  failSchema,
  patchIssueSchema,
  patchSessionSchema,
  patchSettingsSchema,
  sendMessageSchema,
} from './schemas.js';

export interface RouterDeps {
  db: Db;
  getAdapter: (cliId: string) => AgentAdapter;
  /** WS 广播钩子（index.ts 装配 hub.broadcast） */
  broadcast: (event: WsEvent) => void;
}

/** zod 校验：失败抛 ValidationError（错误中间件 → 400） */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ValidationError(`${where}${issue?.message ?? '参数不合法'}`);
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

export function createRouter(deps: RouterDeps): Router {
  const { db, getAdapter, broadcast } = deps;
  const router = Router();

  // ---- workspaces ----
  router.get('/workspaces', (_req, res) => {
    res.json(listWorkspaces(db));
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

  router.delete('/workspaces/:id', (req, res) => {
    deleteWorkspace(db, req.params.id!);
    res.status(204).end();
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
    res.json(next);
  });

  // ---- issues ----
  router.get('/issues', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    res.json(listIssues(db, workspaceId));
  });

  router.post('/issues', (req, res) => {
    const body = parseBody(createIssueSchema, req.body);
    requireExistingWorkspace(db, body.workspace_id);
    const issue = createIssue(db, body);
    broadcast({ type: 'issue.changed', issue });
    res.json(issue);
  });

  // kb show 依赖：按 id 取单个 issue（设计 §6.2；REST 全表补充，只读不改契约语义）
  router.get('/issues/:id', (req, res) => {
    res.json(requireIssue(db, req.params.id!));
  });

  router.patch('/issues/:id', (req, res) => {
    const body = parseBody(patchIssueSchema, req.body);
    const issue = updateIssueGuarded(db, req.params.id!, body);
    broadcast({ type: 'issue.changed', issue });
    res.json(issue);
  });

  // 设计 §7.4：非占用中删除，级联清理关联会话与消息。
  // 先停各绑定会话的运行中轮次（stopSession 对无在途轮次会话幂等：不 kill、仅状态落库已结束），
  // 再在同一事务内显式删 message → session → issue（不依赖 FK CASCADE 语义）。
  router.delete('/issues/:id', async (req, res) => {
    const issue = requireIssue(db, req.params.id!);
    if (issue.claimed_by !== null) throw new ConflictError('占用中禁止删除');
    const bound = listSessionsByIssue(db, issue.id);
    for (const session of bound) {
      await stopSession(session.id);
    }
    db.transaction(() => {
      for (const session of bound) {
        deleteMessagesBySession(db, session.id);
        deleteSession(db, session.id);
      }
      deleteIssue(db, issue.id);
    })();
    broadcast({ type: 'issue.deleted', issue_id: issue.id, workspace_id: issue.workspace_id });
    for (const session of bound) {
      broadcast({ type: 'session.deleted', session_id: session.id });
    }
    res.status(204).end();
  });

  // ---- comments ----
  router.get('/issues/:id/comments', (req, res) => {
    requireIssue(db, req.params.id!);
    res.json(listCommentsByIssue(db, req.params.id!));
  });

  router.post('/issues/:id/comments', async (req, res) => {
    const body = parseBody(addCommentSchema, req.body);
    // 作者身份：body.agent_id 存在 → agent:<agent_id>（agent 写评论），否则 user；唤醒判定在 addComment 内不变
    const author: string = body.agent_id ? `agent:${body.agent_id}` : 'user';
    const { comment, woke } = await addComment(db, req.params.id!, author, body.content);
    broadcast({ type: 'comment.added', comment });
    broadcast({ type: 'issue.changed', issue: getIssue(db, req.params.id!)! });
    res.json({ comment, woke });
  });

  // 留言消费（kb 占用场景）：事务内读全部评论 + 标注新评论 + 推进游标，恰好一次
  router.post('/issues/:id/comments/consume', (req, res) => {
    res.json(consumeComments(db, req.params.id!));
  });

  // ---- 占用事务 ----
  // REST claim 仅占用登记（session_id=null），不建会话；派发场景走 POST /api/sessions
  router.post('/issues/:id/claim', (req, res) => {
    const body = parseBody(claimSchema, req.body);
    const issue = claimIssue(db, req.params.id!, body.agent_id, null);
    broadcast({ type: 'issue.changed', issue });
    res.json(issue);
  });

  // 自动评论补 WS 推送：comment 非空时追加 comment.added（顺序与手动评论端点一致：先 comment.added 后 issue.changed）
  router.post('/issues/:id/release', async (req, res) => {
    const { issue, comment } = await releaseIssue(db, req.params.id!);
    if (comment) broadcast({ type: 'comment.added', comment });
    broadcast({ type: 'issue.changed', issue });
    res.json({ ...issue, comment });
  });

  router.post('/issues/:id/done', async (req, res) => {
    const body = parseBody(doneSchema, req.body);
    const { issue, comment } = await doneIssue(db, req.params.id!, body.agent_id, body.notes);
    if (comment) broadcast({ type: 'comment.added', comment });
    broadcast({ type: 'issue.changed', issue });
    res.json({ ...issue, comment });
  });

  router.post('/issues/:id/fail', async (req, res) => {
    const body = parseBody(failSchema, req.body);
    const { issue, comment } = await failIssue(db, req.params.id!, body.agent_id, body.reason);
    if (comment) broadcast({ type: 'comment.added', comment });
    broadcast({ type: 'issue.changed', issue });
    res.json({ ...issue, comment });
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
    if (body.issue_id) {
      const result = await dispatchIssue(db, { getAdapter }, {
        issueId: body.issue_id,
        cli: body.cli,
        model: body.model ?? null,
        promptTemplate: body.prompt,
        reuse_session: body.reuse_session,
      });
      broadcast({ type: 'issue.changed', issue: result.issue });
      session = result.session;
    } else {
      session = await createSession({
        cli: body.cli,
        model: body.model ?? null,
        workspace_id: body.workspace_id,
        prompt: body.prompt ?? null,
      });
    }
    broadcast({ type: 'session.changed', session });
    res.json(session);
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const body = parseBody(sendMessageSchema, req.body);
    const result = await sendToSession(req.params.id!, body.text);
    res.json(result);
  });

  router.post('/sessions/:id/stop', async (req, res) => {
    res.json(await stopSession(req.params.id!));
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
    _res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    _res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    return;
  }
  console.error('[agentboard] 未处理错误:', err);
  _res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
}

/** 未匹配的 /api 路由 → 404 JSON（避免落到静态托管） */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` } });
};
