import type { Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';

export async function listSpaces(ctx: Ctx): Promise<void> {
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(spaces, null, 2)}\n`);
    return;
  }
  if (spaces.length === 0) {
    ctx.io.write('（无工作空间）\n');
    return;
  }
  ctx.io.write(table(['id', 'name', 'path'], spaces.map((s) => [s.id, s.name, s.path])));
}
