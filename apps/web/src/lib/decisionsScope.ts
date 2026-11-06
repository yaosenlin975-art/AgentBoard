/**
 * 待决策区范围（PERM-2 / P5）：当前工作区 vs 所有可访问工作区。
 *
 * 与知识库范围、形态/主题等设置**独立持久化**（不同 localStorage 键），互不影响。
 * 非法/损坏值一律回落「当前工作区」，避免把无效范围带进 UI 或请求。
 * 纯逻辑 + 存储读写，不依赖 React；storage 可注入便于单测。
 */
export type DecisionsScope = 'workspace' | 'all';

export const DECISIONS_SCOPE_KEY = 'agentboard.decisions.scope';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function browserStorage(): (ReadStorage & WriteStorage) | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // 隐私模式等场景取 localStorage 本身会抛错
    return null;
  }
}

export function isDecisionsScope(value: unknown): value is DecisionsScope {
  return value === 'workspace' || value === 'all';
}

/** 读取记忆范围：无记录 / 非法值 / 存储不可用 → workspace */
export function resolveDecisionsScope(storage: ReadStorage | null = browserStorage()): DecisionsScope {
  if (storage === null) return 'workspace';
  try {
    const raw = storage.getItem(DECISIONS_SCOPE_KEY);
    return isDecisionsScope(raw) ? raw : 'workspace';
  } catch {
    return 'workspace';
  }
}

/** 记住用户显式选择的范围；localStorage 不可用时仅本次会话生效 */
export function persistDecisionsScope(
  scope: DecisionsScope,
  storage: WriteStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(DECISIONS_SCOPE_KEY, scope);
  } catch {
    // 隐私模式/配额满：忽略，本次会话内仍生效
  }
}
