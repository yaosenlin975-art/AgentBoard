import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Issue, IssueComment } from '@agentboard/shared';
import { request, requestBinary, verifyCommentStoredText } from '../api.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef, shortIssueId, withNotFoundSuggestion } from '../issueRef.js';

export interface CommentArgs {
  /** 位置参数收集的评论文本片段（多词以空格合并） */
  text?: string[];
  /** 从 stdin 读全部内容作为评论；与 text 二选一 */
  stdin?: boolean;
  /** 本机图片路径；最多 5 张 PNG/JPEG/WebP */
  image?: string[];
  /** 评论请求幂等键；重试时复用 */
  requestId?: string;
}

interface StagedAttachment { id: string }
interface IssueWorkspace { workspace_id: string }
interface CommentResult { comment: IssueComment; woke: boolean; warning?: string }

function imageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
}

export async function comment(ctx: Ctx, id: string, args: CommentArgs): Promise<void> {
  const joined = args.text && args.text.length > 0 ? args.text.join(' ') : undefined;
  if (args.stdin && joined !== undefined) {
    throw new Error('评论内容 text 与 --stdin 二选一，不能同时使用');
  }
  const content = args.stdin ? await ctx.io.readStdin() : joined;
  const imagePaths = args.image ?? [];
  if (imagePaths.length > 5) throw new Error('每条评论最多添加 5 张图片');
  if ((content === undefined || content.trim() === '') && imagePaths.length === 0) {
    throw new Error('缺少评论内容：传内容参数，或用 --stdin 从标准输入读取');
  }
  const attachments: string[] = [];
  let workspaceId: string | undefined;
  // CLI-02：允许 ≥8 位前缀；后续接口都用解析后的真实 id
  const target = await normalizeIssueRef(ctx, id);
  const issueId = target.id;
  // CLI-RECEIPT：回执要回显卡标题与状态；前缀解析命中时已有整卡，不再多打一次 GET
  let issue: Issue | null = target.issue ?? null;
  if (imagePaths.length > 0) {
    if (issue === null) {
      issue = await withNotFoundSuggestion(ctx, id, () =>
        request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`));
    }
    workspaceId = issue.workspace_id;
    for (const path of imagePaths) {
      const bytes = await readFile(path);
      if (bytes.length > 10 * 1024 * 1024) throw new Error(`图片超过 10 MiB：${basename(path)}`);
      const staged = await requestBinary<StagedAttachment>(
        ctx.base,
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
        bytes,
        imageMime(bytes),
        basename(path),
      );
      attachments.push(staged.id);
    }
  }
  // agent 身份：KB_AGENT 优先，默认 kb-cli；服务端记 author=agent:<id>，不触发唤醒
  const res = await withNotFoundSuggestion(ctx, id, () => request<CommentResult>(
    ctx.base,
    'POST',
    `/api/issues/${encodeURIComponent(issueId)}/comments`,
    {
      content: content ?? '',
      agent_id: ctx.agentId,
      ...(attachments.length > 0 ? { attachment_ids: attachments, workspace_id: workspaceId } : {}),
    },
    attachments.length > 0 ? args.requestId ?? randomUUID() : undefined,
  ));
  // MOJI-GUARD：回读落库正文（纯图片评论没有文字可校验，不发这次回读）
  if (content !== undefined && content !== '') {
    await verifyCommentStoredText(ctx.base, issueId, res.comment.id, content);
  }
  // CLI-RECEIPT：评论写成功后回显卡标题与状态；读不到就少打一行，不编造标题、不影响成功退出码
  if (issue === null) {
    issue = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`).catch(() => null);
  }
  const receipt = issue !== null && typeof issue.title === 'string' && typeof issue.status === 'string'
    ? `卡：${shortIssueId(issue.id)} ${issue.title}（${issue.status}）`
    : null;
  if (ctx.json) {
    const summary = receipt === null ? res : { ...res, issue: { id: issue!.id, title: issue!.title, status: issue!.status } };
    ctx.io.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  ctx.io.write(`评论已写入: ${res.comment.id}\n`);
  if (receipt !== null) ctx.io.write(`${receipt}\n`);
  if (res.warning === 'IMAGE_DELIVERY_UNVERIFIED') {
    ctx.io.write('图片已保存；图片交付能力未验证，评论保留为待读\n');
  } else {
    // KB-SRVMSG N-05：不暗示「评论等于通知」——已写入、下次读取可见
    ctx.io.write(res.woke ? '已唤醒占用 agent\n' : '评论已写入，对方下次读取时可见\n');
  }
}
