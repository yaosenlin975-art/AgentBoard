import type { Issue, KnowledgeHint } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface DoneArgs {
  notes?: string;
  /** 从 stdin 读取 notes（多行、或含 `- ` 开头的行时更安全；与 --notes 二选一，stdin 优先） */
  notesStdin?: boolean;
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；有并行占用时只提交声明范围内的改动 */
  scope?: string[];
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
}

export async function done(ctx: Ctx, id: string, args: DoneArgs): Promise<void> {
  const body: { agent_id: string; notes?: string; scope_paths?: string[]; workspace_id?: string } = { agent_id: ctx.agentId };
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
