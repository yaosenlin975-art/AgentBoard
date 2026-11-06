/**
 * ACCEPT-1：`kb accept` 给「待验收」卡写一条结构化验收记录。
 * 只复用评论流，不改数据库 schema、不改卡片状态；关闭仍走 `kb close`。
 */
import type { IssueComment } from '@agentboard/shared';
import { request } from '../api.js';
import { CliExitError } from '../errors.js';
import type { Ctx } from '../io.js';
import { resolveIssueByRef } from '../issueRef.js';

export interface AcceptArgs {
  /** 验收结论：pass | fail（必填） */
  verdict?: string;
  /** 验收依据（必填，另起一行写入评论） */
  note?: string;
  /** 验收人；缺省取 KB_AGENT / kb-cli */
  reviewer?: string;
  /** 幂等请求 id；同一 request-id 重放不重复写评论 */
  requestId?: string;
}

interface CommentResult {
  comment: IssueComment;
  woke: boolean;
  warning?: string;
}

/**
 * 固定记录格式（写进 CLI 帮助与 Docs/api.md，改动即破坏可检索性）：
 * `【验收记录】verdict=pass; reviewer=<name>; at=<ISO8601>`
 * 第二行起为验收依据。
 */
export function acceptRecordContent(verdict: 'pass' | 'fail', reviewer: string, at: string, note: string): string {
  return `【验收记录】verdict=${verdict}; reviewer=${reviewer}; at=${at}\n${note}`;
}

export async function accept(ctx: Ctx, id: string, args: AcceptArgs): Promise<void> {
  const verdict = args.verdict;
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new Error('缺少验收结论：--verdict pass|fail');
  }
  const note = args.note?.trim();
  if (note === undefined || note === '') {
    throw new Error('缺少验收依据：--note "..."（写清对照的验收标准与观测结果）');
  }
  const reviewer = args.reviewer?.trim() || ctx.agentId;
  const issue = await resolveIssueByRef(ctx, id);
  if (issue.status !== '待验收') {
    throw new CliExitError(
      'ACCEPT_STATUS_NOT_ACCEPTABLE',
      `只有「待验收」卡可以写验收记录（当前状态：${issue.status}）；待规划卡请用 kb done <issue-id> 提交验收，关闭请用 kb close <issue-id>`,
      2,
    );
  }
  const at = new Date().toISOString();
  const res = await request<CommentResult>(
    ctx.base,
    'POST',
    `/api/issues/${encodeURIComponent(issue.id)}/comments`,
    { content: acceptRecordContent(verdict, reviewer, at, note), agent_id: ctx.agentId },
    args.requestId,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  ctx.io.write(`验收记录已写入: ${res.comment.id}\n`);
  ctx.io.write(`记录: verdict=${verdict}; reviewer=${reviewer}; at=${at}\n`);
  ctx.io.write('卡片状态未变更（accept 只记录）；关闭请显式执行 kb close <issue-id>\n');
}
