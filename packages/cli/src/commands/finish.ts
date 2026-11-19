import type { Ctx } from '../io.js';
import { done, type DoneArgs } from './done.js';

export type FinishArgs = DoneArgs;

/**
 * `kb finish` 是 `done --close-record` 的短入口。
 * 默认复用 done 的全部参数、门禁、fence 与自动提交；只有显式 --no-changelog
 * 才走无变更出口。这里不增加新的业务状态。
 */
export async function finish(ctx: Ctx, id: string, args: FinishArgs): Promise<void> {
  await done(ctx, id, {
    ...args,
    closeRecord: args.noChangelog === true ? false : true,
  });
}
