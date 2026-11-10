import type { Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import { writeListJson } from '../json.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';
import { matchCurrentWorkspace } from '../workspace.js';

export interface ListSpacesArgs {
  /** A：只输出 cwd 解析到的当前工作区（JSON 仍为单元素数组） */
  current?: boolean;
}

export async function listSpaces(ctx: Ctx, args: ListSpacesArgs = {}): Promise<void> {
  const all = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  // A：--current 走与 list-tasks 默认值同一个解析器（唯一根等值优先 / 路径段边界 / 多候选报歧义 / 无匹配报错）
  const spaces = args.current === true ? [matchCurrentWorkspace(all)] : all;
  if (ctx.json) {
    writeListJson(ctx, spaces);
    return;
  }
  if (spaces.length === 0) {
    ctx.io.write('（无工作空间）\n');
    return;
  }
  // SK-10：工作区 id 是卡面/依赖/提交要抄的坐标，文本模式也给全长（任务列表的 id 列仍短 ID）
  ctx.io.write(table(['id', 'name', 'path'], spaces.map((s) => [s.id, s.name, s.path])));
}
