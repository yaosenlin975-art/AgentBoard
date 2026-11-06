/**
 * DEC-BADGE：待决策范围的唯一 React 入口。
 *
 * 列表（`DecisionsView`）与侧栏徽标（`SideBar`）都读这一份快照：
 * - 切范围时 `setDecisionsScope` 通知两侧同一帧重渲染，不会出现「侧栏还是本工作区、列表已跨区」；
 * - 快照以 localStorage 为准，组件不再各自持有 scope state，杜绝两套数字打架。
 */
import { useSyncExternalStore } from 'react';
import {
  readDecisionsScopeSnapshot,
  subscribeDecisionsScope,
  type DecisionsScope,
} from '../lib/decisionsScope';

export function useDecisionsScope(): DecisionsScope {
  return useSyncExternalStore(
    subscribeDecisionsScope,
    readDecisionsScopeSnapshot,
    readDecisionsScopeSnapshot,
  );
}
