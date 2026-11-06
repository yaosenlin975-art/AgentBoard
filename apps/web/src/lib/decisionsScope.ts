/**
 * 待决策区范围（PERM-2 / P5）：当前工作区 vs 所有可访问工作区。
 *
 * 与知识库范围、形态/主题等设置**独立持久化**（不同 localStorage 键），互不影响。
 * 非法/损坏值一律回落「当前工作区」，避免把无效范围带进 UI 或请求。
 * 纯逻辑 + 存储读写，不依赖 React；storage 可注入便于单测。
 *
 * DEC-BADGE：待决策列表与侧栏徽标必须共用同一份范围，所以这里额外提供
 * 「读取快照 + 变更订阅」的最小外部 store；React 侧见 `state/useDecisionsScope.ts`。
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

/**
 * DEC-BADGE：存储不可用（隐私模式等）时的会话内兜底。
 * 只要 localStorage 可读就以存储值为准，避免测试/多标签下出现第二份口径。
 */
let memoryScope: DecisionsScope | null = null;
const scopeListeners = new Set<() => void>();

/** 当前范围的快照；切范围后同一帧内所有订阅者读到同一个值 */
export function readDecisionsScopeSnapshot(): DecisionsScope {
  const storage = browserStorage();
  if (storage !== null) {
    try {
      const raw = storage.getItem(DECISIONS_SCOPE_KEY);
      return isDecisionsScope(raw) ? raw : 'workspace';
    } catch {
      // 读失败 → 落到会话内兜底
    }
  }
  return memoryScope ?? 'workspace';
}

/** 订阅范围变更（列表与侧栏徽标共用，禁止各自维护一份） */
export function subscribeDecisionsScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

/** 切换范围：写记忆 + 通知所有订阅者（持久化失败也会更新会话内兜底与界面） */
export function setDecisionsScope(scope: DecisionsScope): void {
  memoryScope = scope;
  persistDecisionsScope(scope);
  for (const listener of scopeListeners) listener();
}
