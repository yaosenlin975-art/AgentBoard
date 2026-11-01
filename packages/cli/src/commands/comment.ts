import type { IssueComment } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface CommentArgs {
  /** 位置参数收集的评论文本片段（多词以空格合并） */
  text?: string[];
  /** 从 stdin 读全部内容作为评论；与 text 二选一 */
  stdin?: boolean;
}

export async function comment(ctx: Ctx, id: string, args: CommentArgs): Promise<void> {
  const joined = args.text && args.text.length > 0 ? args.text.join(' ') : undefined;
  if (args.stdin && joined !== undefined) {
    throw new Error('评论内容 text 与 --stdin 二选一，不能同时使用');
  }
  const content = args.stdin ? await ctx.io.readStdin() : joined;
  if (content === undefined || content.trim() === '') {
    throw new Error('缺少评论内容：传内容参数，或用 --stdin 从标准输入读取');
  }
  // agent 身份：KB_AGENT 优先，默认 kb-cli；服务端记 author=agent:<id>，不触发唤醒
  const res = await request<{ comment: IssueComment; woke: boolean }>(
    ctx.base,
    'POST',
    `/api/issues/${encodeURIComponent(id)}/comments`,
    { content, agent_id: ctx.agentId },
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  ctx.io.write(`评论已写入: ${res.comment.id}\n`);
  ctx.io.write(res.woke ? '已唤醒占用 agent\n' : '未唤醒（任务未被占用，仅留言）\n');
}
