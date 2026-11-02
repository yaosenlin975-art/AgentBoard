import type { Command } from 'commander';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';

interface ScopeOptions { scope: string; workspace?: string }
async function scopeFor(ctx: Ctx, opts: ScopeOptions, search = false): Promise<{ scope: string; workspace_id?: string }> {
  if (!(search ? ['workspace', 'common', 'both'] : ['workspace', 'common']).includes(opts.scope)) throw new Error('知识范围无效');
  if (opts.scope === 'common') {
    if (opts.workspace) throw new Error('common 不接受 --workspace');
    return { scope: 'common' };
  }
  if (!opts.workspace) throw new Error('项目知识必须指定 --workspace');
  return { scope: opts.scope, workspace_id: await resolveWorkspaceId(ctx.base, opts.workspace) };
}
function output(ctx: Ctx, data: unknown): void {
  if (ctx.json) { ctx.io.write(`${JSON.stringify(data, null, 2)}\n`); return; }
  if (Array.isArray(data)) {
    ctx.io.write(data.length ? data.map(p => `${p.page_id ?? p.id} [${p.scope}] rev:${p.revision} ${p.title}\n${p.snippet ?? ''}`).join('\n') + '\n' : '（无知识）\n');
  } else {
    const p = data as Record<string, unknown>;
    ctx.io.write(`${p.id ?? ''} [${p.scope ?? ''}] rev:${p.revision ?? ''} ${p.title ?? ''}\n${p.body_md ?? JSON.stringify(data, null, 2)}\n`);
  }
}
const query = (params: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
export function registerKnowledgeCommands(program: Command, context: () => Ctx): void {
  const knowledge = program.command('knowledge').description('共享知识库（项目与公共范围显式指定）');
  knowledge.command('search <query>').option('--scope <scope>', 'workspace|common|both', 'both').option('--workspace <id|名>').option('--limit <n>', '结果数量', '5')
    .action(async (q: string, opts: ScopeOptions & { limit: string }) => { const ctx = context(); output(ctx, await request(ctx.base, 'GET', `/api/knowledge/search?${query({ ...await scopeFor(ctx, opts, true), q, limit: opts.limit })}`)); });
  const scoped = (command: Command) => command.requiredOption('--scope <scope>', 'workspace|common').option('--workspace <id|名>');
  scoped(knowledge.command('show <page-id>').option('--history', '同时读取版本历史'))
    .action(async (id: string, opts: ScopeOptions & { history?: boolean }) => {
      const ctx = context(); const suffix = query(await scopeFor(ctx, opts)); const path = `/api/knowledge/pages/${encodeURIComponent(id)}`;
      const page = await request(ctx.base, 'GET', `${path}?${suffix}`);
      if (opts.history) output(ctx, { page, history: await request(ctx.base, 'GET', `${path}/revisions?${suffix}`) }); else output(ctx, page);
    });
  scoped(knowledge.command('list').option('--status <status>', 'active|archived|deleted|all', 'active').option('--offset <n>', '分页偏移', '0').option('--limit <n>', '分页数量', '20').option('--include-expired', '包含过期页面'))
    .action(async (opts: ScopeOptions & { status: string; offset: string; limit: string; includeExpired?: boolean }) => {
      const ctx = context(); output(ctx, await request(ctx.base, 'GET', `/api/knowledge/pages?${query({ ...await scopeFor(ctx, opts), status: opts.status, offset: opts.offset, limit: opts.limit, include_expired: String(!!opts.includeExpired) })}`));
    });
  const contentOptions = (cmd: Command) => cmd.option('--stdin', '从 UTF-8 stdin 读取正文').option('--sources <json>', '来源数组 JSON').option('--evidence <json>', '证据数组 JSON').option('--expires-at <ms>', '过期时间，null 清除期限');
  async function content(ctx: Ctx, opts: { stdin?: boolean; sources?: string; evidence?: string; expiresAt?: string }) {
    return { ...(opts.stdin ? { body_md: await ctx.io.readStdin() } : {}), ...(opts.sources !== undefined ? { sources: JSON.parse(opts.sources) } : {}), ...(opts.evidence !== undefined ? { evidence: JSON.parse(opts.evidence) } : {}), ...(opts.expiresAt !== undefined ? { expires_at: JSON.parse(opts.expiresAt) } : {}), actor: ctx.agentId };
  }
  scoped(contentOptions(knowledge.command('create')).requiredOption('--title <title>').requiredOption('--slug <slug>'))
    .action(async (opts: ScopeOptions & { title: string; slug: string; stdin?: boolean; sources?: string; evidence?: string; expiresAt?: string }) => {
      const ctx = context(); if (!opts.stdin || !opts.sources || !opts.evidence) throw new Error('create 必须提供 --stdin、--sources 和 --evidence');
      output(ctx, await request(ctx.base, 'POST', '/api/knowledge/pages', { ...await scopeFor(ctx, opts), ...await content(ctx, opts), title: opts.title, slug: opts.slug }));
    });
  scoped(contentOptions(knowledge.command('revise <page-id>')).requiredOption('--expected-revision <n>').option('--title <title>'))
    .action(async (id: string, opts: ScopeOptions & { expectedRevision: string; title?: string; stdin?: boolean; sources?: string; evidence?: string; expiresAt?: string }) => {
      const ctx = context(); output(ctx, await request(ctx.base, 'PUT', `/api/knowledge/pages/${encodeURIComponent(id)}`, { ...await scopeFor(ctx, opts), ...await content(ctx, opts), ...(opts.title !== undefined ? { title: opts.title } : {}), expected_revision: Number(opts.expectedRevision) }));
    });
  scoped(knowledge.command('action <page-id> <action>').requiredOption('--expected-revision <n>'))
    .action(async (id: string, action: string, opts: ScopeOptions & { expectedRevision: string }) => {
      const ctx = context(); output(ctx, await request(ctx.base, 'POST', `/api/knowledge/pages/${encodeURIComponent(id)}/actions`, { ...await scopeFor(ctx, opts), action, expected_revision: Number(opts.expectedRevision), actor: ctx.agentId }));
    });
}
