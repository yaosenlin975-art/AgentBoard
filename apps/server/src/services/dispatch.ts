/**
 * Task 9：手动派发服务（设计 §5.2）。
 *
 * 流程：渲染模板（含历史备注段）→ 建会话（不起轮）→ 原子 claim（冲突即整体失败，
 * 会话行回滚删除）→ sendToSession 起首轮。claim 即 Pinned Contracts 的原子 UPDATE，
 * 并发派发同一 issue 仅一个成功，ConflictError 向上抛（REST 层 409）。
 */
import type { Issue, Session } from '@agentboard/shared';
import type { AgentAdapter } from '@agentboard/adapters';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { listCommentsByIssue } from '../db/repos/comment.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { claimIssue } from './claim.js';
import * as sessionManager from './sessionManager.js';

/** Pinned Contracts 派发 prompt 模板（逐字，不得改动；`{{var}}` 渲染） */
export const DISPATCH_PROMPT_TEMPLATE = `你是任务看板的执行 agent。
任务 ID：{{issue_id}}
标题：{{title}}
描述：
{{description}}
工作目录：{{workspace_path}}（你的当前工作目录即此）
规则：
1. 任务内容以 \`kb show {{issue_id}}\` 实时返回为准，开工前与关键节点重新拉取。
2. 用户在评论区的留言视为补充指令，经 \`kb show\` 读取最新评论。
3. 关键节点（开工、受阻、阶段性完成）用 \`kb comment {{issue_id}} "..."\` 写进展总结。
4. 全部完成后执行 \`kb done {{issue_id}}\`；无法完成执行 \`kb fail {{issue_id}} --reason "..."。`;

/** 历史备注段上限：该 issue 最近 10 条评论（ts 升序展示） */
export const HISTORY_NOTE_LIMIT = 10;

export interface DispatchDeps {
  /** 适配器解析器：派发前校验 cli 可解析（未知 CLI 即 400），轮次执行仍由 sessionManager 解析 */
  getAdapter: (cliId: string) => AgentAdapter;
}

export interface DispatchInput {
  issueId: string;
  cli: string;
  model?: string | null;
  /** 调用方整体替换默认模板（4 变量仍渲染；渲染结果已含 `## 历史备注` 段时跳过历史备注追加）；缺省用 DISPATCH_PROMPT_TEMPLATE */
  promptTemplate?: string;
  reuse_session?: 'last' | 'new';
}

export interface DispatchResult {
  issue: Issue;
  session: Session;
}

/** 模板变量渲染：{{issue_id}}/{{title}}/{{description}}/{{workspace_path}}；description 为空给"(空)" */
export function renderPrompt(
  template: string,
  vars: { issue_id: string; title: string; description: string; workspace_path: string },
): string {
  return template
    .replaceAll('{{issue_id}}', vars.issue_id)
    .replaceAll('{{title}}', vars.title)
    .replaceAll('{{description}}', vars.description.trim() === '' ? '(空)' : vars.description)
    .replaceAll('{{workspace_path}}', vars.workspace_path);
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
  try {
    deps.getAdapter(input.cli);
  } catch {
    throw new ValidationError(`未知 CLI: ${input.cli}`);
  }

  const issue = getIssue(db, input.issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  const workspace = getWorkspace(db, issue.workspace_id);
  if (!workspace) throw new NotFoundError('工作空间不存在');

  const rendered = renderPrompt(input.promptTemplate ?? DISPATCH_PROMPT_TEMPLATE, {
    issue_id: issue.id,
    title: issue.title,
    description: issue.description,
    workspace_path: workspace.path,
  });
  // 历史备注契约：前端派发弹窗预填可编辑历史备注段（含 promptTemplate 整体替换路径），
  // 渲染结果已含 `## 历史备注` 时跳过追加、原样使用（防双份）；仅缺失时由服务端补最近 10 条评论。
  const notes = rendered.includes('## 历史备注') ? null : renderHistoryNotes(db, issue.id);
  const prompt = notes === null ? rendered : `${rendered}\n${notes}`;

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

  await sessionManager.sendToSession(session.id, prompt);
  return { issue: claimed, session };
}
