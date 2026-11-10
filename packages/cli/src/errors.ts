/** CLI-04 / CLI-02：统一错误出口（退出码 + 文本 / --json 结构化错误体）。 */
import { CliHttpError, ServerUnreachableError } from './api.js';
import type { Io } from './io.js';
import { AmbiguousIssueRefError } from './issueRef.js';

/** CLI-05：服务端文案里的裸 "release" 统一补成可执行的 `kb release <issue-id>`（REL-3 起该子命令存在） */
export function releaseAdvice(message: string): string {
  return message
    .replace(/；先 release 或换卡，勿重复 claim/g, '；先 kb release <issue-id> 或换卡，勿重复 claim')
    .replace(/请先 release 再/g, '请先 kb release <issue-id> 再');
}

/** 需要指定退出码的本地校验错误（如 ACCEPT-1 状态不符 exit 2，且不改数据） */
export class CliExitError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number) {
    super(message);
    this.name = 'CliExitError';
  }
}

export interface DescribedError {
  code: string;
  message: string;
  details?: unknown;
  exitCode: number;
  /** 409 按既有口径包装「已被占用（…）」 */
  wrapConflict: boolean;
  /** 未被占用 / 自解释文案原样输出 */
  raw: boolean;
}

export function describeError(err: unknown): DescribedError {
  if (err instanceof CliExitError) {
    return { code: err.code, message: err.message, exitCode: err.exitCode, wrapConflict: false, raw: true };
  }
  if (err instanceof AmbiguousIssueRefError) {
    return {
      code: err.code,
      message: err.message,
      details: { ref: err.ref, candidates: err.candidates },
      exitCode: 2,
      wrapConflict: false,
      raw: true,
    };
  }
  if (err instanceof ServerUnreachableError) {
    return { code: 'SERVER_UNREACHABLE', message: err.message, exitCode: 1, wrapConflict: false, raw: true };
  }
  if (err instanceof CliHttpError) {
    // 服务端已给出自解释文案的 409 原样透传（删除被占用/含子任务等），不再包装成「已被占用（…）」
    const raw = err.code.startsWith('KNOWLEDGE_') || err.code.startsWith('CHANGELOG_')
      || err.code === 'CONFLICT' || err.code === 'IDEMPOTENCY_KEY_REUSED'
      // CLAIM-MSG：占用冲突与「状态不可领取」自带自解释文案，原样透传
      || err.code === 'ISSUE_CLAIMED' || err.code === 'ISSUE_STATUS_NOT_CLAIMABLE' || err.code === 'NOT_TASK_OWNER'
      // BORROW-0.3：fence 过期自带「重新 claim」指引，原样透传
      || err.code === 'STALE_FENCE'
      // DEC-V4-API-EXTEND：非宽限中 / 超上限自带自解释文案，原样透传
      || err.code === 'DECISION_NOT_GRACE' || err.code === 'EXTEND_LIMIT_EXCEEDED'
      // SK-03：决策锁不是占用，文案自带「谁能回答 + 怎么撤回」，原样透传
      || err.code === 'DECISION_LOCKED'
      // SK-02：仅人类可答自带可执行下一步，原样透传
      || err.code === 'DECISION_HUMAN_ONLY'
      // CLI-SWITCH：切换失败/不支持/预检阻断自带自解释文案，原样透传（避免被包装成「已被占用（…）」）
      || err.code.startsWith('CLI_SWITCH_') || err.code === 'DEEPSEEK_ENV_SHADOWS'
      || err.code === 'CLIENT_STATE_UNREADABLE' || err.code === 'CLI_CREDENTIAL_MISSING'
      || err.code === 'ACCOUNT_BUSY';
    return {
      code: err.code,
      message: releaseAdvice(err.message),
      details: err.details,
      exitCode: err.status === 409 ? 2 : 1,
      wrapConflict: err.status === 409,
      raw,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INVALID_ARGUMENT', message: releaseAdvice(message), exitCode: 1, wrapConflict: false, raw: true };
}

/** --json 错误体：{error:{code,message,details}}（details 缺省省略） */
export function errorJson(described: DescribedError): string {
  return JSON.stringify({
    error: {
      code: described.code,
      message: described.message,
      ...(described.details === undefined ? {} : { details: described.details }),
    },
  });
}

/** 错误 → (stdout JSON 或 stderr 单行, 退出码)：连接拒绝 1；409 冲突 2；前缀多命中 2；其余 1 */
export function toExit(err: unknown, io: Io, json = false): number {
  const described = describeError(err);
  if (json) {
    io.write(`${errorJson(described)}\n`);
    return described.exitCode;
  }
  if (described.exitCode === 2 && described.wrapConflict) {
    // CLI-CRASH：done/fail 报「未被占用」时给可操作下一步，而不是让人卡在最后一步
    const hint = described.message === '未被占用'
      ? '未被占用：如需推进请先 kb claim，或使用 kb close（待验收 → 已关闭）\n'
      : described.raw ? `${described.message}\n` : described.message === '已被占用' ? '已被占用\n' : `已被占用（${described.message}）\n`;
    io.writeErr(hint);
    return described.exitCode;
  }
  io.writeErr(`${described.message}\n`);
  return described.exitCode;
}
