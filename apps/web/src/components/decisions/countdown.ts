/**
 * DEC-6：待决策列表的纯函数（分组 / 倒计时 / 等待时长格式化）。
 * 全部按「本地 now」计算，宽限到期先在前端移入「未回答」，服务端 ticker 落锁后由 WS 刷新转正。
 */
import type { DecisionListItemDto } from './types';

/** 锁后超过 72 小时 = 已超时（与 DEC-8 提醒档位、DEC-3 stale 查询同一口径） */
export const DECISION_STALE_MS = 72 * 3600 * 1000;
/** 已回答在列表保留 24 小时（设计 §3.7「最近已回答」） */
export const RECENT_ANSWERED_MS = 24 * 3600 * 1000;

export interface DecisionGroups {
  /** 宽限中（秒级倒计时） */
  grace: DecisionListItemDto[];
  /** 未回答（含宽限刚到期、ticker 尚未落锁的条目） */
  open: DecisionListItemDto[];
  /** 已超时（open 且锁后 ≥72h） */
  stale: DecisionListItemDto[];
  /** 最近已回答（24h 内，按回答时间倒序） */
  answered: DecisionListItemDto[];
}

function byNewest(a: DecisionListItemDto, b: DecisionListItemDto): number {
  return b.created_at - a.created_at;
}

/** grace 剩余秒数（≤0 视为已到期） */
export function remainingGraceSeconds(graceUntil: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((graceUntil - now) / 1000));
}

/**
 * 四段分组：
 * - `grace` 且 `grace_until > now` → 宽限中；
 * - `grace` 但已到期 → 未回答（本地过渡，服务端落锁后状态变 open）；
 * - `open` 且 `locked_at <= now - 72h` → 已超时；
 * - `answered` 且 `answered_at >= now - 24h` → 最近已回答。
 */
export function groupDecisions(
  active: DecisionListItemDto[],
  answered: DecisionListItemDto[],
  now: number = Date.now(),
): DecisionGroups {
  const staleBefore = now - DECISION_STALE_MS;
  const groups: DecisionGroups = { grace: [], open: [], stale: [], answered: [] };

  for (const item of active) {
    if (item.state === 'grace') {
      if (item.grace_until > now) groups.grace.push(item);
      else groups.open.push(item);
      continue;
    }
    if (item.state !== 'open') continue;
    if (item.locked_at !== null && item.locked_at <= staleBefore) groups.stale.push(item);
    else groups.open.push(item);
  }

  const recentAfter = now - RECENT_ANSWERED_MS;
  for (const item of answered) {
    if (item.state !== 'answered') continue;
    if (item.answered_at !== null && item.answered_at >= recentAfter) groups.answered.push(item);
  }

  groups.grace.sort((a, b) => a.grace_until - b.grace_until);
  groups.open.sort(byNewest);
  groups.stale.sort((a, b) => (a.locked_at ?? 0) - (b.locked_at ?? 0));
  groups.answered.sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0));
  return groups;
}

/** 倒计时格式：`mm:ss`（180 → `3:00`，0 → `0:00`） */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** 等待时长：<60 秒 → `12 秒`；<1 小时 → `5 分 30 秒`；否则 `3 小时 20 分` */
export function formatWaiting(totalSeconds: number | null): string | null {
  if (totalSeconds === null || totalSeconds < 0) return null;
  const seconds = Math.floor(totalSeconds);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
