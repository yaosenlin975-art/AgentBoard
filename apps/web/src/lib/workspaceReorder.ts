/**
 * 工作空间拖拽排序（WS-REORDER 前端）。
 * - 乐观更新：本地立即重排并写入 ['workspaces'] 缓存，请求失败按快照回滚 + 重新拉取。
 * - 权威顺序：200 响应的 `workspaces` 整体覆盖缓存，不自己再推序号。
 * - 幂等：一次拖拽生成一个 UUID，随请求发送；重试复用同一个 key。
 * - 集合冲突 409 WORKSPACE_SET_CHANGED：回滚并提示刷新（不重试、不部分重排）；顺序冲突是 LWW，不提示。
 */
import { arrayMove } from '@dnd-kit/sortable';
import type { QueryClient } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../api/client';

export const WORKSPACES_KEY = ['workspaces'] as const;

export interface ReorderOutcome {
  ok: boolean;
  /** 面向用户的一句话（失败原因 / 集合冲突提示） */
  message: string | null;
}

/** 本地按 sort_order 稳定排序（服务端已排好，这里防御旧缓存/未排序数据） */
export function sortWorkspaces(list: readonly Workspace[]): Workspace[] {
  return [...list].sort((left, right) => {
    const leftOrder = left.sort_order ?? 0;
    const rightOrder = right.sort_order ?? 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.created_at !== right.created_at) return left.created_at - right.created_at;
    return left.id.localeCompare(right.id);
  });
}

export function moveWorkspace(list: readonly Workspace[], from: number, to: number): Workspace[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  return arrayMove([...list], from, to);
}

/** 置顶条目（按下态 + 置顶前的位置）；顺序本身由服务端 sort_order 承载 */
export interface PinnedEntry {
  id: string;
  /** 置顶前的列表下标，取消置顶时据此还原原位置 */
  originIndex: number;
}

export const PINNED_IDS_KEY = 'agentboard.pinned-workspaces';

/** 读置顶条目；localStorage 不可用或内容损坏时按空集合处理 */
export function readPinned(): PinnedEntry[] {
  try {
    const raw = window.localStorage.getItem(PINNED_IDS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PinnedEntry[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { id, originIndex } = entry as { id?: unknown; originIndex?: unknown };
      if (typeof id !== 'string') return [];
      return [{ id, originIndex: typeof originIndex === 'number' ? originIndex : 0 }];
    });
  } catch {
    return [];
  }
}

export function writePinned(entries: readonly PinnedEntry[]): void {
  try {
    window.localStorage.setItem(PINNED_IDS_KEY, JSON.stringify(entries));
  } catch {
    // localStorage 不可用（隐私模式等）：仅本次会话生效
  }
}

/**
 * 置顶顺序：置顶 = 移到首位；取消置顶 = 还原到置顶前的位置（越界时夹到末尾）。
 * 两种情况都保持其余项相对次序不变。
 * @param pinned 当前的置顶条目（调用方传入，函数保持纯）
 */
export function pinnedOrder(
  list: readonly Workspace[],
  id: string,
  pin: boolean,
  pinned: readonly PinnedEntry[],
): Workspace[] {
  const from = list.findIndex((workspace) => workspace.id === id);
  const moving = list[from];
  if (from < 0 || moving === undefined) return [...list];
  if (pin) return moveWorkspace(list, from, 0);
  const originIndex = pinned.find((entry) => entry.id === id)?.originIndex ?? from;
  const rest = list.filter((workspace) => workspace.id !== id);
  const target = Math.min(Math.max(originIndex, 0), rest.length);
  return [...rest.slice(0, target), moving, ...rest.slice(target)];
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * 提交新顺序：先乐观落缓存，再 PATCH 到 reorder 接口。
 * @param ordered 新顺序的完整列表（必须包含全部工作区）
 * @param idempotencyKey 同一拖拽操作的幂等键（重试复用）
 */
export async function commitWorkspaceOrder(
  queryClient: QueryClient,
  ordered: readonly Workspace[],
  idempotencyKey: string,
): Promise<ReorderOutcome> {
  const snapshot = queryClient.getQueryData<Workspace[]>(WORKSPACES_KEY) ?? [];
  queryClient.setQueryData<Workspace[]>(WORKSPACES_KEY, ordered.map((workspace, index) => ({ ...workspace, sort_order: index })));

  try {
    const result = await api.post<{ workspaces: Workspace[]; reordered_at: number }>(
      '/api/workspaces/reorder',
      { ordered_ids: ordered.map((workspace) => workspace.id) },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
    queryClient.setQueryData<Workspace[]>(WORKSPACES_KEY, sortWorkspaces(result.workspaces));
    return { ok: true, message: null };
  } catch (error) {
    // 失败回滚：恢复快照并重新拉一次，避免留下脏顺序
    queryClient.setQueryData<Workspace[]>(WORKSPACES_KEY, snapshot);
    await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    const code = errorCode(error);
    if (code === 'WORKSPACE_SET_CHANGED') {
      return { ok: false, message: '工作空间列表已变化（有人新建或删除），已回滚，请刷新后再拖动' };
    }
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      return { ok: false, message: '重试标识冲突，已回滚，请重新拖动' };
    }
    return { ok: false, message: error instanceof Error ? error.message : '排序保存失败，已回滚' };
  }
}
