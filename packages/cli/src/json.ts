/**
 * KB-CLI-3c：CLI `--json` 的统一形状（契约：knowledge:bb929054-1d44-4542-bb96-4530e42b0546）。
 *
 * - 列表类命令 → `{ items: [...], next_offset: number | null }`；空结果也两个字段齐全，不省略。
 * - 单对象命令 → 对象直出，不套 `items`。
 * - stdout 只放 JSON，进度/警告一律走 stderr。
 * - 服务端已返回 `{ items, next_offset }` 的分页视图原样透传（`writePageJson`）。
 */
import type { Ctx } from './io.js';

export interface JsonListEnvelope<T> {
  items: T[];
  next_offset: number | null;
}

/** 列表结果 → 信封；无分页的列表把 nextOffset 传 null */
export function listEnvelope<T>(items: T[], nextOffset: number | null = null): JsonListEnvelope<T> {
  return { items, next_offset: nextOffset };
}

/** 列表类命令的唯一 JSON 出口 */
export function writeListJson<T>(ctx: Ctx, items: T[], nextOffset: number | null = null): void {
  ctx.io.write(`${JSON.stringify(listEnvelope(items, nextOffset), null, 2)}\n`);
}

/** 单对象命令的唯一 JSON 出口：对象直出，不套信封 */
export function writeObjectJson(ctx: Ctx, value: unknown): void {
  ctx.io.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 服务端分页视图（已是 { items, next_offset }）透传，缺 next_offset 时补 null */
export function writePageJson<T>(ctx: Ctx, page: { items: T[]; next_offset?: number | null }): void {
  writeListJson(ctx, page.items, page.next_offset ?? null);
}
