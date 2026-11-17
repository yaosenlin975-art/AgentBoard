/**
 * 短 id 引用解析的公共骨架（S6 抽出，供 `taskRef.ts` / `decisionRef.ts` 共用）。
 *
 * 背景：服务端**所有** `GET /<resource>/:id` 端点都不做前缀解析（`/issues`、`/decisions`、
 * `/knowledge/pages`、`/changelog` 全是精确查）。前缀支持一律由客户端提供——
 * CLI 在 `packages/cli/src/issueRef.ts` 有正确实现，MCP 此前缺这一层，
 * 而 `task_id` / `decision_id` 的描述又承诺了「8+ 位前缀也接受」。
 *
 * 判定口径与 CLI 逐字一致：
 * - 只有「1-35 位纯十六进制」才当短前缀（CLI `HEX_REF`）
 * - 非十六进制引用（`iss1`、`knowledge:p1`）零成本透传 —— 它们是服务端合法标识形态
 * - 带连字符的完整 UUID 不匹配 HEX_REF，同样透传
 * - 1-35 位十六进制但 <8 位 → 本地拒绝，不发请求
 */
import { McpError } from '../config.js';

/** 与 CLI `MIN_ISSUE_PREFIX` 同口径 */
export const MIN_ID_PREFIX = 8;
/** 完整 UUID 长度（含 4 个连字符）；带连字符的完整 id 不匹配 HEX_REF，直接透传 */
const FULL_UUID_LENGTH = 36;
/** 只有 1-35 位纯十六进制才当短前缀（CLI `issueRef.ts:35` 的 HEX_REF） */
const HEX_REF = /^[0-9a-f]{1,35}$/i;

/** 该引用是否需要走列表扫描解析（否则零成本透传） */
export function isShortIdRef(ref: string): boolean {
  return HEX_REF.test(ref.trim());
}

/** 需要解析时校验最小长度；不需要解析或已足够长则直接放行 */
export function assertPrefixLength(raw: string, fieldName: string): void {
  if (!isShortIdRef(raw) || raw.length >= FULL_UUID_LENGTH) return;
  if (raw.length >= MIN_ID_PREFIX) return;
  throw new McpError(
    'INVALID_ARGUMENT',
    `${fieldName} prefix too short: got ${raw.length} chars, need at least ${MIN_ID_PREFIX}. `
    + 'Pass the full 36-char UUID or a hex prefix of 8+ characters.',
  );
}

export interface ResolveIdByRefOptions<T> {
  /** 调用方参数名，用于错误措辞（`task_id` / `decision_id`） */
  fieldName: string;
  /** 资源的 404 错误码（`TASK_NOT_FOUND` / `DECISION_NOT_FOUND`） */
  notFoundCode: string;
  /** 拉取该范围内的全部候选（分页由调用方负责） */
  listAll: () => Promise<T[]>;
  idOf: (item: T) => string;
  /** 描述单个候选，用于歧义时的候选清单 */
  describe?: (item: T) => string;
}

/**
 * `ref` → 真实 id。
 * 三种结局：唯一命中返回真实 id；多命中抛 `INVALID_ARGUMENT` 并列候选；零命中抛 `notFoundCode`。
 * 歧义错误码在 task / decision 两族**统一为 `INVALID_ARGUMENT`**（卡面要求与 task 族一致）。
 */
export async function resolveIdByRef<T>(ref: string, options: ResolveIdByRefOptions<T>): Promise<string> {
  const raw = ref.trim();
  if (!isShortIdRef(raw) || raw.length >= FULL_UUID_LENGTH) return raw;
  assertPrefixLength(raw, options.fieldName);

  const items = await options.listAll();
  const lowered = raw.toLowerCase();
  const hits = items.filter(item => options.idOf(item).toLowerCase().startsWith(lowered));
  if (hits.length === 1) return options.idOf(hits[0]!);
  if (hits.length > 1) {
    const listed = hits.slice(0, 10).map(item => options.describe?.(item) ?? options.idOf(item));
    const more = hits.length > listed.length ? ` (and ${hits.length - listed.length} more)` : '';
    throw new McpError(
      'INVALID_ARGUMENT',
      `${options.fieldName} prefix "${raw}" is ambiguous: ${hits.length} matches${more}. `
      + `Candidates: ${listed.join(' | ')}. Pass a longer prefix or the full UUID.`,
    );
  }
  throw new McpError(options.notFoundCode, `No resource in this workspace has a ${options.fieldName} starting with "${raw}".`);
}
