/**
 * Task 9：手动派发服务（设计 §5.2）。
 *
 * 流程：渲染模板（含历史备注段）→ 建会话（不起轮）→ 原子 claim（冲突即整体失败，
 * 会话行回滚删除）→ sendToSession 起首轮。claim 即 Pinned Contracts 的原子 UPDATE，
 * 并发派发同一 issue 仅一个成功，ConflictError 向上抛（REST 层 409）。
 */
import { MAX_DISPATCH_SELECTED_ID_COUNT, selectDispatchBatch, type Issue, type Session, type TaskKnowledge } from '@agentboard/shared';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import { getTaskKnowledge, renderTaskKnowledge } from './taskKnowledge.js';
import type { AgentAdapter, RunTurnOptions } from '@agentboard/adapters';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { countPendingIssueAttachments, getIssueDispatchAttachments } from '../db/repos/attachment.js';
import { getSession } from '../db/repos/session.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { DEFAULT_DISPATCH_PROMPT_TEMPLATE } from './dispatchTemplate.js';
import { finishIdempotentEffect, hashPayload, replayIdempotentResult, withIdempotencyResult } from './idempotency.js';
import { claimIssue } from './claim.js';
import { captureIssueGitBaseline } from './gitBaseline.js';
import * as sessionManager from './sessionManager.js';
import type { AttachmentStore } from './attachments.js';

/**
 * Pinned Contracts 派发 prompt 模板（内置默认值，逐字不得改动；`{{var}}` 渲染）。
 * ARCH-05 起默认值同源于 dispatchTemplate.ts，运行期默认模板由启动期解析（文件 → env → 内置）。
 */
export const DISPATCH_PROMPT_TEMPLATE = DEFAULT_DISPATCH_PROMPT_TEMPLATE;

/** 历史备注段上限：该 issue 最近 10 条评论（ts 升序展示） */
export const HISTORY_NOTE_LIMIT = 10;

export interface DispatchDeps {
  /** 适配器解析器：派发前校验 cli 可解析（未知 CLI 即 400），轮次执行仍由 sessionManager 解析 */
  getAdapter: (cliId: string) => AgentAdapter;
  attachments?: AttachmentStore;
  /** ARCH-05：启动期解析并缓存的默认模板（缺省内置 DISPATCH_PROMPT_TEMPLATE） */
  promptTemplate?: string;
}

export interface DispatchInput {
  issueId: string;
  cli: string;
  model?: string | null;
  /** 调用方整体替换默认模板（4 变量仍渲染；渲染结果已含 `## 历史备注` 段时跳过历史备注追加）；缺省用 DISPATCH_PROMPT_TEMPLATE */
  promptTemplate?: string;
  reuse_session?: 'last' | 'new';
  knowledge_enabled?: boolean;
  knowledge_query?: string;
  retry_unknown_images?: boolean;
  selected_attachment_ids?: string[];
  idempotency_key?: string;
  idempotency_payload_hash?: string;
}

export interface DispatchResult {
  issue: Issue;
  session: Session;
  knowledge: TaskKnowledge;
  remaining_attachment_count: number;
  replayed?: boolean;
}

/** 模板变量渲染：{{issue_id}}/{{title}}/{{description}}/{{workspace_path}}；description 为空给"(空)" */
export function renderPrompt(
  template: string,
  vars: { issue_id: string; title: string; description: string; workspace_path: string; workspace_id: string },
): string {
  return template
    .replaceAll('{{issue_id}}', vars.issue_id)
    .replaceAll('{{title}}', vars.title)
    .replaceAll('{{description}}', vars.description.trim() === '' ? '(空)' : vars.description)
    .replaceAll('{{workspace_path}}', vars.workspace_path)
    .replaceAll('{{workspace_id}}', vars.workspace_id);
}

/** 历史备注段：最近 10 条评论 ts 升序，每行 `- [author] content`；无评论返回 null（整段省略） */
export function renderHistoryNotes(db: Db, issueId: string): string | null {
  const recent = db
    .prepare(
      `SELECT * FROM issue_comment WHERE issue_id = ?
       ORDER BY ts DESC, id DESC LIMIT ${HISTORY_NOTE_LIMIT}`,
    )
    .all(issueId) as Array<{ author: string; content: string }>;
  if (recent.length === 0) return null;
  const lines = recent.reverse().map((c) => `- [${c.author}] ${c.content}`);
  return `## 历史备注\n${lines.join('\n')}`;
}

/**
 * 手动派发：渲染 → 建会话（暂不起轮）→ claim（agent=<cli>，session 绑定占用）→ 起首轮。
 * 占用冲突时删除刚建的会话行后向上抛 ConflictError（不残留空会话）。
 */
export async function dispatchIssue(db: Db, deps: DispatchDeps, input: DispatchInput): Promise<DispatchResult> {
  // 幂等身份：路由层传入载荷哈希；直接调用时可内部回退计算，保证重放判定与记账同源。
  const idempotencyInput = input.idempotency_key
    ? {
        key: input.idempotency_key,
        actorId: input.cli,
        action: 'POST',
        resource: '/api/sessions',
        payloadHash: input.idempotency_payload_hash ?? hashPayload({
          issue_id: input.issueId, cli: input.cli, model: input.model ?? null, prompt: input.promptTemplate ?? null,
          reuse_session: input.reuse_session ?? 'new', selected_attachment_ids: input.selected_attachment_ids ?? null,
          retry_unknown_images: input.retry_unknown_images ?? false,
        }),
      }
    : null;
  if (idempotencyInput) {
    const replay = replayIdempotentResult<DispatchResult>(db, idempotencyInput);
    if (replay !== null) return { ...replay, replayed: true };
  }

  let adapter: AgentAdapter;
  try {
    adapter = deps.getAdapter(input.cli);
  } catch {
    throw new ValidationError(`未知 CLI: ${input.cli}`);
  }

  const issue = getIssue(db, input.issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  const workspace = getWorkspace(db, issue.workspace_id);
  if (!workspace) throw new NotFoundError('工作空间不存在');
  const totalPendingAttachmentCount = countPendingIssueAttachments(db, issue.id);

  const selectedIds = input.selected_attachment_ids;
  if (selectedIds !== undefined && selectedIds.length > MAX_DISPATCH_SELECTED_ID_COUNT) {
    throw new ValidationError(`IMAGE_SELECTION_LIMIT_EXCEEDED:一次最多选择 ${MAX_DISPATCH_SELECTED_ID_COUNT} 张图片`);
  }
  if (selectedIds !== undefined && new Set(selectedIds).size !== selectedIds.length) {
    throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:所选图片不能重复');
  }
  if (selectedIds === undefined && totalPendingAttachmentCount > 0) {
    throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_REQUIRED:请先选择本批要发送的历史图片');
  }
  const requestedAttachments = selectedIds === undefined ? [] : getIssueDispatchAttachments(db, issue.id, selectedIds);
  if (requestedAttachments.some((attachment) => attachment.delivery_state === 'sending')) {
    throw new ValidationError('IMAGE_DELIVERY_IN_PROGRESS:所选图片仍在投递');
  }
  if (!input.idempotency_key && requestedAttachments.some((attachment) => attachment.delivery_state === 'delivered')) {
    throw new ValidationError('IMAGE_ATTACHMENT_NOT_PENDING:所选图片已交付');
  }
  const selectedAttachments = selectDispatchBatch(requestedAttachments);
  const remainingAttachmentCount = Math.max(0, totalPendingAttachmentCount - selectedAttachments.length);
  const hasUnknownImages = selectedAttachments.some((attachment) => attachment.delivery_state === 'unknown');
  if (hasUnknownImages && input.retry_unknown_images !== true) {
    throw new ValidationError('IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED:存在投递结果未知的图片，确认重试后再派发');
  }
  const reusableSession = input.reuse_session === 'last' && issue.session_id !== null
    ? getSession(db, issue.session_id)
    : null;
  let attachments: NonNullable<RunTurnOptions['attachments']> = [];
  let verifiedCliVersion: string | null = null;
  if (selectedAttachments.length > 0) {
    verifiedCliVersion = await getVerifiedImageInputCliVersion(adapter, reusableSession?.model ?? input.model ?? undefined);
    if (verifiedCliVersion === null) {
      throw new ValidationError('IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证');
    }
    if (!deps.attachments) throw new ValidationError('IMAGE_DELIVERY_UNVERIFIED:图片存储未装配');
    attachments = selectedAttachments.map((attachment) => ({
      path: deps.attachments!.issuePath(issue.id, attachment.id),
      mimeType: deps.attachments!.issueMime(issue.id, attachment.id) as 'image/png' | 'image/jpeg' | 'image/webp',
    }));
  }

  const rendered = renderPrompt(input.promptTemplate ?? deps.promptTemplate ?? DISPATCH_PROMPT_TEMPLATE, {
    issue_id: issue.id,
    title: issue.title,
    description: issue.description,
    workspace_path: workspace.path,
    workspace_id: workspace.id,
  });
  // 历史备注契约：前端派发弹窗预填可编辑历史备注段（含 promptTemplate 整体替换路径），
  // 渲染结果已含 `## 历史备注` 时跳过追加、原样使用（防双份）；仅缺失时由服务端补最近 10 条评论。
  const notes = rendered.includes('## 历史备注') ? null : renderHistoryNotes(db, issue.id);
  const basePrompt = notes === null ? rendered : `${rendered}\n${notes}`;
  const knowledge = getTaskKnowledge(db, issue, input.knowledge_enabled ?? true, input.knowledge_query);
  const knowledgeBlock = renderTaskKnowledge(knowledge);
  let prompt = knowledgeBlock && !basePrompt.includes('## 知识参考') ? `${basePrompt}\n${knowledgeBlock}` : basePrompt;
  if (remainingAttachmentCount > 0) {
    prompt += `\n\n## 图片派发状态\n另有 ${remainingAttachmentCount} 张未附，仍保持待读。`;
  }
  if (attachments.length > 0) {
    const excerpts = new Map<string, string>();
    for (const attachment of selectedAttachments) {
      if (!excerpts.has(attachment.comment_id)) excerpts.set(attachment.comment_id, `- [${attachment.author}] ${attachment.snippet}`);
    }
    prompt += `\n\n## 本批随附图片评论引用\n${[...excerpts.values()].join('\n')}`;
  }

  if (input.reuse_session === 'last' && issue.session_id !== null && issue.claimed_by === input.cli) {
    const session = db.transaction(() => {
      const binding = db.prepare(`SELECT i.claimed_by,i.session_id,s.issue_id AS bound_issue_id,s.cli AS bound_cli
        FROM issue i LEFT JOIN session s ON s.id=i.session_id WHERE i.id=?`).get(issue.id) as
        { claimed_by: string | null; session_id: string | null; bound_issue_id: string | null; bound_cli: string | null } | undefined;
      if (!binding || binding.session_id === null || binding.claimed_by !== input.cli || binding.session_id !== issue.session_id ||
          binding.bound_issue_id !== issue.id || binding.bound_cli !== input.cli) {
        throw new ConflictError('任务绑定已变化，不能续用该会话');
      }
      const boundSession = getSession(db, binding.session_id);
      if (!boundSession) throw new ConflictError('当前任务绑定的会话不存在');
      return boundSession;
    }).immediate();
    if (!session || session.issue_id !== issue.id || session.cli !== input.cli) {
      throw new ConflictError('当前任务绑定的会话无法续用');
    }
    const idempotency = idempotencyInput
      ? withIdempotencyResult(db, idempotencyInput, () => {
          if (requestedAttachments.some((attachment) => attachment.delivery_state === 'delivered')) {
            throw new ValidationError('IMAGE_ATTACHMENT_NOT_PENDING:所选图片已交付');
          }
          return { issue, session, knowledge, remaining_attachment_count: remainingAttachmentCount };
        }, true)
      : null;
    if (idempotency?.replayed) return { ...idempotency.result, replayed: true };
    await sessionManager.sendToSession(session.id, prompt, {
      attachments,
      deliveredAttachmentIds: selectedAttachments.map((attachment) => attachment.id),
      retryUnknownAttachmentIds: input.retry_unknown_images === true
        ? selectedAttachments.filter((attachment) => attachment.delivery_state === 'unknown').map((attachment) => attachment.id)
        : [],
      verifiedCliVersion: verifiedCliVersion ?? undefined,
    });
    const updatedSession = getSession(db, session.id)!;
    const result = { issue, session: updatedSession, knowledge, remaining_attachment_count: remainingAttachmentCount };
    if (input.idempotency_key) finishIdempotentEffect(db, input.idempotency_key, result);
    return result;
  }

  // 建会话（prompt 留空不起轮，claim 成功后再起首轮，保证"先占用后执行"）
  const session = await sessionManager.createSession({
    cli: input.cli,
    model: input.model ?? null,
    issue_id: issue.id,
    reuse_session: input.reuse_session,
  });

  let claimed: Issue;
  try {
    claimed = claimIssue(db, issue.id, input.cli, session.id);
  } catch (err) {
    // 回滚刚建的会话行（无轮次、无消息，直接删行）；空内存态无害
    db.prepare('DELETE FROM session WHERE id = ?').run(session.id);
    throw err;
  }
  // 派发即占用：同样记录 git 基线（GIT-ON-DONE），失败静默
  await captureIssueGitBaseline(db, issue.id);

  // 幂等记账：claim 成功即落账本（effect_pending=1），首轮收发完成后再定稿。
  // 否则同一 Idempotency-Key 的后续重放会落到 claim 冲突（409 CONFLICT）而非回放首轮响应。
  // 占用冲突分支在记账之前抛出，故失败请求不会污染账本。
  const idempotent = idempotencyInput
    ? withIdempotencyResult<DispatchResult>(db, idempotencyInput, () => (
        { issue: claimed, session, knowledge, remaining_attachment_count: remainingAttachmentCount }
      ), true)
    : null;
  if (idempotent?.replayed) return { ...idempotent.result, replayed: true };

  await sessionManager.sendToSession(session.id, prompt, {
    attachments,
    deliveredAttachmentIds: selectedAttachments.map((attachment) => attachment.id),
    retryUnknownAttachmentIds: input.retry_unknown_images === true
      ? selectedAttachments.filter((attachment) => attachment.delivery_state === 'unknown').map((attachment) => attachment.id)
      : [],
    verifiedCliVersion: verifiedCliVersion ?? undefined,
  });
  const result = { issue: claimed, session, knowledge, remaining_attachment_count: remainingAttachmentCount };
  if (input.idempotency_key) finishIdempotentEffect(db, input.idempotency_key, result);
  return result;
}
