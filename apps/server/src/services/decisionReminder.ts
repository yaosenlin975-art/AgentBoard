/**
 * DEC-8：锁后分级提醒与超时升级（设计 v3 §3.2.6、§7 DEC-8）。
 *
 * 口径：
 * - 计时起点是**锁生效时间 `locked_at`**，不是提问/创建时间。
 * - 三档：4h → stale_level=1、24h → 2、72h → 3。`stale_level=0` 表示尚未发过任何提醒。
 *   （设计稿 §4.1 注释写作「0/1/2 = 4h/24h/72h」，但卡面验收明确「4h 前 → stale_level=1」，
 *   本实现按 1/2/3 递增；差异已写进卡评论，改动只影响展示口径，不影响去重语义。）
 * - 每档只写一次：以行内 `stale_level` 为水位，只有「应到档位 > 已发档位」才写
 *   `stale_level` + `last_notified_at`；重启后按 `locked_at` 补算天然不会重复。
 * - **绝不自动解锁、不自动作答、不改 state、不触发任何 token/进程动作**。
 * - 提醒事件的对外通道：本卡禁改 `packages/shared`，`DecisionEvent` 没有 reminder 类型，
 *   因此这里只广播既有 `issue.changed`（让看板刷新投影），并把结构化提醒交给 `onRemind`
 *   回调（生产侧记录 server 日志，后续补丁卡再把 `decision.reminder` 并入共享类型与 WS）。
 */
import type { Db } from '../db/connection.js';
import type { ServerWsEvent } from '@agentboard/shared';
import { getIssue } from '../db/repos/issue.js';
import { setDecisionReminder } from '../db/repos/decision.js';

/** 档位定义：与卡面/设计一致，4h、24h、72h，逐级只前进不后退。 */
export const REMINDER_LEVELS: ReadonlyArray<{ level: number; after_ms: number; label: string }> = [
  { level: 1, after_ms: 4 * 3600 * 1000, label: '4h' },
  { level: 2, after_ms: 24 * 3600 * 1000, label: '24h' },
  { level: 3, after_ms: 72 * 3600 * 1000, label: '72h' },
];

/** 提醒精度是小时级，一分钟一轮足够；不用 2 秒级（那是宽限计时器的口径）。 */
export const REMINDER_TICK_INTERVAL_MS = 60 * 1000;
/** 单轮上限，防止一次事务风暴；剩余留给下一轮。 */
export const REMINDER_TICK_BATCH = 100;

export interface ReminderEntry {
  decision_id: string;
  workspace_id: string;
  issue_id: string;
  from_level: number;
  to_level: number;
  locked_at: number;
  /** 本次到达的档位标签（4h / 24h / 72h） */
  label: string;
}

export interface ReminderSweepOptions {
  /** 判定时刻（默认 Date.now；测试可注入） */
  now?: number;
  /** 每发一档的回调（生产用于写服务日志；缺省无操作） */
  onRemind?: (entry: ReminderEntry) => void;
  /** WS 广播：只发既有 issue.changed，不改共享事件类型 */
  broadcast?: (event: ServerWsEvent) => void;
  limit?: number;
}

export interface ReminderSweepResult {
  reminded: ReminderEntry[];
}

interface DueReminderRow {
  id: string;
  workspace_id: string;
  issue_id: string;
  locked_at: number;
  stale_level: number;
}

/** 应到档位：取 elapsed 满足的最大档；未到 4h 返回 0。 */
export function reminderLevelFor(lockedAt: number, now: number): number {
  const elapsed = now - lockedAt;
  let level = 0;
  for (const tier of REMINDER_LEVELS) {
    if (elapsed >= tier.after_ms) level = tier.level;
  }
  return level;
}

function listOpenDecisionsForReminder(db: Db, now: number, limit: number): DueReminderRow[] {
  // 只扫 open 且已上锁的；4h 门槛在 SQL 里先粗筛，档位精算在 JS（单一口径，便于单测）。
  return db
    .prepare(
      `SELECT id, workspace_id, issue_id, locked_at, stale_level
         FROM issue_decision
        WHERE state='open' AND locked_at IS NOT NULL AND stale_level < ?
          AND locked_at <= ?
        ORDER BY locked_at ASC, id ASC
        LIMIT ?`,
    )
    .all(REMINDER_LEVELS[REMINDER_LEVELS.length - 1]!.level, now - REMINDER_LEVELS[0]!.after_ms, limit) as DueReminderRow[];
}

/**
 * 扫一轮：对每张已上锁的 open 决策算应到档位，只在「应到 > 已发」时写一次并回调。
 * 可重复调用（幂等）；重启补算复用同一实现。
 */
export function sweepDecisionReminders(db: Db, options: ReminderSweepOptions = {}): ReminderSweepResult {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? REMINDER_TICK_BATCH;
  const reminded: ReminderEntry[] = [];
  for (const row of listOpenDecisionsForReminder(db, now, limit)) {
    const target = reminderLevelFor(row.locked_at, now);
    if (target <= row.stale_level) continue;
    const tier = REMINDER_LEVELS.find((item) => item.level === target);
    if (!tier) continue;
    setDecisionReminder(db, row.id, { stale_level: target, now });
    const entry: ReminderEntry = {
      decision_id: row.id,
      workspace_id: row.workspace_id,
      issue_id: row.issue_id,
      from_level: row.stale_level,
      to_level: target,
      locked_at: row.locked_at,
      label: tier.label,
    };
    reminded.push(entry);
    options.onRemind?.(entry);
    if (options.broadcast) {
      const issue = getIssue(db, row.issue_id);
      if (issue) options.broadcast({ type: 'issue.changed', issue });
    }
  }
  return { reminded };
}

/**
 * 启动补算：与 sweep 同一实现——按 `locked_at` 重算，已发档位（stale_level）跳过，
 * 因此服务重启不会重复提醒，也不会漏掉停机期间跨过的档位（一次补到最高档）。
 */
export function recoverDecisionRemindersOnBoot(
  db: Db,
  options: Omit<ReminderSweepOptions, 'now'> & { now?: number } = {},
): ReminderSweepResult {
  return sweepDecisionReminders(db, options);
}

export interface ReminderTickerHandle {
  tick: (now?: number) => ReminderSweepResult;
  stop: () => void;
}

export interface ReminderTickerOptions {
  intervalMs?: number;
  onRemind?: (entry: ReminderEntry) => void;
  broadcast?: (event: ServerWsEvent) => void;
  limit?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

/**
 * 启动提醒计时器：先跑一次启动补算，再按分钟级周期扫描。
 * 返回句柄供测试/进程退出时停表。
 */
export function startDecisionReminderTicker(db: Db, options: ReminderTickerOptions = {}): ReminderTickerHandle {
  const intervalMs = options.intervalMs ?? REMINDER_TICK_INTERVAL_MS;
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const onError = options.onError ?? ((error: unknown) => console.error('[decision-reminder] tick failed', error));
  const tick = (now?: number): ReminderSweepResult => {
    try {
      return sweepDecisionReminders(db, {
        now,
        onRemind: options.onRemind,
        broadcast: options.broadcast,
        limit: options.limit,
      });
    } catch (error) {
      onError(error);
      return { reminded: [] };
    }
  };
  tick();
  const handle = schedule(() => { tick(); }, intervalMs);
  let stopped = false;
  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel(handle);
    },
  };
}
