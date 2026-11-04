import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef, resolveIssueByRef } from '../issueRef.js';

export interface DeleteIssueArgs {
  /** 必填：不可逆操作，非交互环境也不做「没 TTY 就默认同意」的推断 */
  yes?: boolean;
}

/**
 * 删除任务（不可逆）。
 * 缺 `--yes` 时先读任务并打印标题/状态，然后以非 0 退出，**不发 DELETE 请求**；
 * 是否 TTY 不影响判定（CI/管道同样必须显式 `--yes`）。
 */
export async function deleteIssue(ctx: Ctx, id: string, args: DeleteIssueArgs): Promise<void> {
  // CLI-02：允许 ≥8 位前缀；确认回显与 JSON 都回真实 id
  if (args.yes !== true) {
    const issue = await resolveIssueByRef(ctx, id);
    throw new Error(
      `将删除任务 ${issue.id}「${issue.title}」（状态: ${issue.status}）。删除不可恢复，确认请重新执行并加 --yes`,
    );
  }
  const target = await normalizeIssueRef(ctx, id);
  await request<void>(ctx.base, 'DELETE', `/api/issues/${encodeURIComponent(target.id)}`);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ deleted: true, id: target.id }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已删除任务: ${target.id}（不可恢复）\n`);
}
