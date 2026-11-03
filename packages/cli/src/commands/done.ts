import type { Issue, KnowledgeHint } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface DoneArgs {
  notes?: string;
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；有并行占用时只提交声明范围内的改动 */
  scope?: string[];
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
}

export async function done(ctx: Ctx, id: string, args: DoneArgs): Promise<void> {
  const body: { agent_id: string; notes?: string; scope_paths?: string[]; workspace_id?: string } = { agent_id: ctx.agentId };
  if (args.notes !== undefined) body.notes = args.notes;
  if (args.scope !== undefined && args.scope.length > 0) body.scope_paths = args.scope;
  if (args.requestId !== undefined) {
    // 服务端要求幂等 owner 操作提供 workspace_id；只在显式传 --request-id 时才多这一次解析
    const target = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(id)}`);
    body.workspace_id = target.workspace_id;
  }
  const issue = await request<Issue & { knowledge_hint?: KnowledgeHint | null }>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(id)}/done`, body, args.requestId,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
  // 软提醒：建议而非错误，不加 ERROR 前缀、不影响退出码
  if (issue.knowledge_hint?.message) ctx.io.write(`提示: ${issue.knowledge_hint.message}\n`);
}
