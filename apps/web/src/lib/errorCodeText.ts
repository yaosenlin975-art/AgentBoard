/**
 * BORROW-1.2（错误码不裸展示）：服务端错误码 → 中文口径。
 * 未登记的码保留原样（码本身仍是排查线索），页面不再出现「裸码 + 无上下文」的组合。
 */
import { ApiError } from '../api/client.js';

const CODE_TEXT: Record<string, string> = {
  TASK_NOT_FOUND: '任务不存在',
  TASK_CLAIMED: '任务已被占用',
  ISSUE_CLAIMED: '任务已被占用',
  ISSUE_STATUS_NOT_CLAIMABLE: '任务当前状态不可领取',
  NOT_TASK_OWNER: '只有当前占用者可执行此操作',
  STALE_FENCE: '占用代次已过期，请重新领取任务',
  CONFLICT: '操作冲突',
  TASK_REVISION_CONFLICT: '任务已被他人更新，请刷新后重试',
  VALIDATION_ERROR: '提交内容不合法',
  DEPENDENCY_SELF: '任务不能依赖自身',
  DEPENDENCY_CYCLE: '该依赖会形成循环，已拒绝',
  DEPENDENCY_EXISTS: '该依赖已存在',
  CROSS_WORKSPACE_DEPENDENCY: '不支持跨工作空间依赖',
  KNOWLEDGE_NOT_FOUND: '知识页不存在',
  KNOWLEDGE_REVISION_CONFLICT: '知识页已被他人更新，请刷新后重试',
  KNOWLEDGE_UNAVAILABLE: '知识检索暂不可用',
  IDEMPOTENCY_KEY_REUSED: '幂等键已被使用，请换新的 request-id',
  SERVER_UNREACHABLE: '看板服务未启动或不可达',
  TIMEOUT: '服务无响应，请稍后重试',
  UNAUTHORIZED: '未登录或登录已过期',
};

/** 登记过的码 → 中文；未登记的码原样返回（不做伪装） */
export function errorCodeText(code: string): string {
  return CODE_TEXT[code] ?? code;
}

/**
 * 任意 error → 可展示文本：ApiError 且码已登记 → 中文；其余保留原 message。
 * 纯字符串原样透传（Board 的 setError(null | string) 场景）。
 */
export function errorText(error: unknown, fallback = '操作失败'): string {
  if (typeof error === 'string') return error;
  if (error instanceof ApiError) return CODE_TEXT[error.code] ?? error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}
