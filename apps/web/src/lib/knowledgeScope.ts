/**
 * 知识库默认范围（KB-SCOPE-DEFAULT）。
 *
 * 首次打开默认落在「当前项目」；用户显式切到「当前项目＋公共」或「公共经验」后写
 * localStorage 记住这次选择，下次打开不再强制拉回项目。
 * 未选中工作区时无法按项目过滤，退化为「公共经验」（与旧行为一致，不静默变空列表）。
 * 纯逻辑 + 存储读写，不依赖 React；storage 可注入便于单测。
 */
export type KnowledgeScope = 'both' | 'workspace' | 'common';

export const KNOWLEDGE_SCOPE_KEY = 'agentboard.knowledge-scope';

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

export function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return value === 'both' || value === 'workspace' || value === 'common';
}

/** 首次打开（无持久化记录）时的默认范围：有工作区 → 当前项目；无工作区 → 公共经验 */
export function fallbackKnowledgeScope(hasWorkspace: boolean): KnowledgeScope {
  return hasWorkspace ? 'workspace' : 'common';
}

/**
 * 解析面板初始范围：
 * - 无工作区：固定退化到 common（workspace/both 无法过滤），不读取记忆，避免把非法范围带到 UI；
 * - 有工作区：记忆里的合法值优先，否则回落「当前项目」；
 * - localStorage 不可用/损坏：回落当前项目。
 */
export function resolveKnowledgeScope(
  hasWorkspace: boolean,
  storage: ReadStorage | null = browserStorage(),
): KnowledgeScope {
  if (!hasWorkspace) return 'common';
  if (storage === null) return 'workspace';
  try {
    const raw = storage.getItem(KNOWLEDGE_SCOPE_KEY);
    return isKnowledgeScope(raw) ? raw : 'workspace';
  } catch {
    return 'workspace';
  }
}

/** 记住用户显式选择的范围；localStorage 不可用时仅本次会话生效 */
export function persistKnowledgeScope(
  scope: KnowledgeScope,
  storage: WriteStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(KNOWLEDGE_SCOPE_KEY, scope);
  } catch {
    // 隐私模式/配额满：忽略，本次会话内仍生效
  }
}
