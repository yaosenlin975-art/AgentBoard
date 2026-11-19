import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveIssueByRef } from '../issueRef.js';
import { claim } from './claim.js';

interface DependencyRef {
  issue_id: string;
  title: string;
  status: string;
  resolved: boolean;
}

interface DependencyView {
  blockers: DependencyRef[];
  blocked: DependencyRef[];
}

type WorkIssue = Issue & {
  description_truncated?: boolean;
  next_description_offset_chars?: number | null;
};

export interface WorkArgs {
  knowledge?: boolean;
  knowledgeQuery?: string;
  requestId?: string;
  comments?: number | 'all';
}

/**
 * `kb work`：复用 claim 的原子写，再读取有界正文与结构化依赖。
 * 失败发生在 claim 之前由现有 claim 报错；claim 成功后的读取失败不回滚占用，
 * 而是明确告诉调用方卡已被占用、可用 `kb show` 继续。
 */
export async function work(ctx: Ctx, id: string, args: WorkArgs = {}): Promise<void> {
  if (ctx.json) {
    // claim 的 --json 输出是领取对象；工作包只能输出一个 JSON 文档，因此用静默翻转捕获其输出。
    const quietIo = { ...ctx.io, write: () => {} };
    await claim({ ...ctx, io: quietIo, json: false }, id, args);
  } else {
    await claim(ctx, id, args);
  }
  // claim 已校验状态并写 fence；完整 id 由 resolve 处理前缀。
  const issue = await resolveIssueByRef(ctx, id) as WorkIssue;
  const deps = await request<DependencyView>(
    ctx.base,
    'GET',
    `/api/issues/${encodeURIComponent(issue.id)}/dependencies?workspace_id=${encodeURIComponent(issue.workspace_id)}`,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({
      issue,
      ...(typeof issue.description === 'string' ? {
        description: issue.description,
        description_truncated: Boolean(issue.description_truncated),
        next_description_offset_chars: issue.next_description_offset_chars ?? null,
      } : {}),
      blockers: deps.blockers,
      blocked: deps.blocked,
    }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`工作包: ${issue.id}\n`);
  ctx.io.write(`状态: ${issue.status}\n占用者: ${issue.claimed_by ?? '（未占用）'}\n`);
  ctx.io.write(`标题: ${issue.title}\n优先级: ${issue.priority}\n`);
  if (issue.parent_issue_id) ctx.io.write(`父卡: ${issue.parent_issue_id}\n`);
  if (issue.description) {
    ctx.io.write(`描述:\n${issue.description}\n`);
    if (issue.description_truncated === true) {
      ctx.io.write(`描述已截断；续读：kb show ${issue.id} --description-offset ${issue.next_description_offset_chars ?? 12000}\n`);
    }
  }
  if (deps.blockers.length > 0) {
    ctx.io.write(`前置（${deps.blockers.length}）：${deps.blockers.map(ref => `${ref.issue_id.slice(0, 8)} ${ref.status}`).join('；')}\n`);
  }
  ctx.io.write('下一步：按卡面实施；收尾使用 kb finish 或 kb done。\n');
}
