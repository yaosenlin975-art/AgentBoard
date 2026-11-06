import type { Issue, KnowledgeHint } from '@agentboard/shared';
import { request } from '../api.js';
import { clearClaimedFence, loadClaimedFence } from '../claimStore.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef } from '../issueRef.js';
import { closeIssueWithOwnRelease } from './lifecycle.js';

export interface DoneArgs {
  notes?: string;
  /** 从 stdin 读取 notes（多行、或含 `- ` 开头的行时更安全；与 --notes 二选一，stdin 优先） */
  notesStdin?: boolean;
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；有并行占用时只提交声明范围内的改动 */
  scope?: string[];
  /** 显式纳入工作区全部未提交改动（默认只提交 scope 声明的卡内文件集，卡外改动只列清单） */
  all?: boolean;
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
  /** CLOSE-FLOW：done 成功后串行 close（待验收 → 已关闭），一步收口 */
  close?: boolean;
}

export async function done(ctx: Ctx, id: string, args: DoneArgs): Promise<void> {
  // CLI-02：允许 ≥8 位前缀；fence 与接口都用解析后的真实 id
  const target = await normalizeIssueRef(ctx, id);
  const issueId = target.id;
  const body: { agent_id: string; notes?: string; scope_paths?: string[]; workspace_id?: string; fence?: number } = { agent_id: ctx.agentId };
  // BORROW-0.3：本地有 claim 记录就自动带 fence（软模式：无记录不带，服务端放行）
  const storedFence = loadClaimedFence(issueId);
  if (storedFence !== undefined) body.fence = storedFence;
  if (args.notesStdin === true) {
    const text = (await ctx.io.readStdin()).replace(/\r\n/g, '\n');
    body.notes = text.endsWith('\n') ? text.slice(0, -1) : text;
  } else if (args.notes !== undefined) {
    // CLI-UX：多行 notes 里以 "- " 开头的行会被 shell 当成额外参数（实测 `too many arguments for 'done'`）
    if (/\n\s*- /.test(args.notes)) {
      ctx.io.writeErr('警告：--notes 含以 "- " 开头的行，可能被 shell 拆成额外参数；建议改用 --notes-stdin（从标准输入读取）\n');
    }
    body.notes = args.notes;
  }
  if (args.scope !== undefined && args.scope.length > 0) {
    /**
     * SCOPE-GUARD：PowerShell 会把 `--scope a,b` 的逗号串拆开、甚至合并成一个含空格的参数（"a b"）。
     * 含空格的值既可能是真实文件名、也可能是被拆坏的多个路径，静默再拆一次有风险 → 只报警不猜。
     */
    const suspicious = args.scope.filter(item => /\s/.test(item));
    if (suspicious.length > 0) {
      ctx.io.writeErr(
        `警告：--scope 值含空格（${suspicious.map(item => JSON.stringify(item)).join('、')}），` +
        '可能是 PowerShell 把逗号串拆开/合并了。请为每个路径重复传参：--scope a --scope b\n',
      );
    }
    body.scope_paths = args.scope;
  }
  if (args.all === true) {
    // GIT-ON-DONE：声明工作区根（`.`）＝显式纳入卡外未提交改动；默认不纳入
    body.scope_paths = [...(body.scope_paths ?? []), '.'];
  }
  if (args.requestId !== undefined) {
    // 服务端要求幂等 owner 操作提供 workspace_id；只在显式传 --request-id 时才多这一次解析
    body.workspace_id = target.issue?.workspace_id
      ?? (await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`)).workspace_id;
  }
  const issue = await request<Issue & { knowledge_hint?: KnowledgeHint | null }>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/done`, body, args.requestId,
  );
  clearClaimedFence(issueId);

  // CLOSE-FLOW：done 成功后串行 close；两阶段分别报错，已成功的 done 不回滚、也不重复执行
  if (args.close === true) {
    const outcome = await closeIssueWithOwnRelease(ctx, issue.id)
      .catch(error => {
        ctx.io.writeErr('done 阶段已完成（状态已进入待验收，占用已释放）；close 阶段失败：\n');
        throw error;
      });
    const closed = outcome.issue;
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify({ done: issue, close: closed }, null, 2)}\n`);
      return;
    }
    ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
    if (issue.knowledge_hint?.message) ctx.io.write(`提示: ${issue.knowledge_hint.message}\n`);
    if (outcome.released) ctx.io.write('已释放自有占用后关闭\n');
    ctx.io.write(`已关闭: ${closed.id}\n状态: ${closed.status}（done → close 一步收口）\n`);
    return;
  }

  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
  // 软提醒：建议而非错误，不加 ERROR 前缀、不影响退出码
  if (issue.knowledge_hint?.message) ctx.io.write(`提示: ${issue.knowledge_hint.message}\n`);
}
