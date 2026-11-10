/**
 * TRAVEL-REC：WorkBuddy 猫猫旅行「派出 → 到期自动回收」执行器。
 *
 * 口径（与卡 4a0cb507 / 父卡 03e6da6f 一致）：
 * - 派出成功时 checkinRunner 落 `workbuddy_travel_round` pending，`due_at` = 派出时间 + 3 小时 45 分；
 * - 4 小时是得分窗口上限，提前 15 分钟回收，留出请求延迟与时钟误差的安全余量；
 * - 本模块只做 status→claim（provider.claimAfterTravel），**绝不重新 depart**，同一轮只离开 pending 一次（CAS）；
 * - 启动先跑一次补偿扫描：到期未回收的立刻回收，已超出 4 小时窗口的落 missed 并上报，不假装成功；
 * - 失败不静默：保留 pending 并累加 attempts / safe_error_code，下轮重试，直到窗口用尽；
 * - 开关 `travelAutoRecover` 每轮实时读取，关闭时整轮跳过（不改任何行）。
 */
import type { Db } from '../../db/connection.js';
import { getManagedAccount } from '../../db/repos/managedAccount.js';
import {
  TRAVEL_SCORE_WINDOW_MS,
  listPendingTravelRounds,
  recordTravelAttemptFailure,
  transitionTravelRound,
  type WorkbuddyTravelRound,
} from '../../db/repos/travelRound.js';
import { ApiError } from '../../errors.js';
import type { CheckinProviderSpec, CheckinVault } from './checkinProvider.js';

/** 扫描周期：5 分钟一次（4 小时窗口内足够，且不会把请求打密） */
export const TRAVEL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** 超出得分窗口仍未回收的终态错误码（如实上报「已错过」） */
export const TRAVEL_WINDOW_EXPIRED = 'TRAVEL_WINDOW_EXPIRED';
/** provider 未实现 claimAfterTravel 时的终态错误码 */
export const TRAVEL_RECOVERY_UNSUPPORTED = 'TRAVEL_RECOVERY_UNSUPPORTED';

export interface TravelRecoveryDeps {
  db: Db;
  vault: CheckinVault;
  provider: CheckinProviderSpec;
}

export interface TravelRecoveryOptions {
  /** 判定时刻（默认 Date.now；测试注入） */
  now?: () => number;
  /** 自动回收开关（默认开；生产读 settings.travelAutoRecover） */
  enabled?: () => boolean;
  /** 日志（缺省静默；生产接 appendServerLog） */
  log?: (line: string) => void;
  /** 调度器（测试注入；默认 setInterval） */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  intervalMs?: number;
}

export interface TravelRecoverySweep {
  /** 实际发起了回收请求的轮次数 */
  attempted: number;
  /** 本轮成功落 claimed（含远端 already_done） */
  claimed: number;
  /** 本轮落 missed（超出得分窗口） */
  missed: number;
  /** 本轮回收失败/仍失败，保留 pending 待下轮 */
  failed: number;
  /** 未到期或开关关闭，本轮未处理 */
  skipped: number;
}

const emptySweep = (): TravelRecoverySweep => ({ attempted: 0, claimed: 0, missed: 0, failed: 0, skipped: 0 });

/** 单轮扫描：幂等，可重复调用；不抛异常以外的副作用都会落库 */
export async function sweepTravelRecoveries(deps: TravelRecoveryDeps, options: TravelRecoveryOptions = {}): Promise<TravelRecoverySweep> {
  const now = options.now ?? Date.now;
  const result = emptySweep();
  const rounds = listPendingTravelRounds(deps.db);
  if (options.enabled !== undefined && !options.enabled()) {
    result.skipped = rounds.length;
    return result;
  }
  for (const round of rounds) {
    const ts = now();
    // 超窗优先判定：即便已到期也不再发请求，如实记「已错过」
    if (ts >= round.dispatched_at + TRAVEL_SCORE_WINDOW_MS) {
      if (transitionTravelRound(deps.db, round.id, 'pending', { state: 'missed', safe_error_code: TRAVEL_WINDOW_EXPIRED }) !== null) {
        result.missed += 1;
        log(options, `travel-recovery missed ${round.id} account=${round.account_id} dispatched_at=${round.dispatched_at}`);
      }
      continue;
    }
    if (round.due_at > ts) {
      result.skipped += 1;
      continue;
    }
    await recoverRound(deps, round, result, options);
  }
  return result;
}

async function recoverRound(deps: TravelRecoveryDeps, round: WorkbuddyTravelRound, result: TravelRecoverySweep, options: TravelRecoveryOptions): Promise<void> {
  const account = getManagedAccount(deps.db, round.account_id);
  if (!account || !account.enabled) {
    failAttempt(deps, round, result, options, account === null ? 'TRAVEL_ACCOUNT_MISSING' : 'TRAVEL_ACCOUNT_DISABLED');
    return;
  }
  if (account.app_id !== 'workbuddy_desktop' || !account.checkin_credential_ref) {
    failAttempt(deps, round, result, options, 'TRAVEL_CREDENTIAL_MISSING');
    return;
  }
  if (deps.provider.claimAfterTravel === undefined) {
    if (transitionTravelRound(deps.db, round.id, 'pending', { state: 'failed', safe_error_code: TRAVEL_RECOVERY_UNSUPPORTED }) !== null) {
      result.failed += 1;
      log(options, `travel-recovery unsupported ${round.id} account=${round.account_id}`);
    }
    return;
  }
  result.attempted += 1;
  try {
    const credential = await deps.vault.unprotect(account.checkin_credential_ref, {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    const activity = await deps.provider.claimAfterTravel(credential);
    if (activity === null) {
      failAttempt(deps, round, result, options, 'TRAVEL_RECOVERY_EMPTY');
      return;
    }
    if (activity.status === 'claimed' || activity.status === 'already_done') {
      if (transitionTravelRound(deps.db, round.id, 'pending', { state: 'claimed', touch_attempt: true }) !== null) {
        result.claimed += 1;
        log(options, `travel-recovery claimed ${round.id} account=${round.account_id}`);
      }
      return;
    }
    // dispatched = 仍在途，下轮再试；failed = 本轮回收失败，同样保留 pending
    failAttempt(deps, round, result, options, activity.status === 'dispatched' ? 'TRAVEL_STILL_TRAVELING' : (activity.safe_error_code ?? 'TRAVEL_RECOVERY_FAILED'));
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'TRAVEL_RECOVERY_ERROR';
    failAttempt(deps, round, result, options, `TRAVEL_RECOVERY_FAILED:${code}`);
  }
}

function failAttempt(deps: TravelRecoveryDeps, round: WorkbuddyTravelRound, result: TravelRecoverySweep, options: TravelRecoveryOptions, code: string): void {
  if (recordTravelAttemptFailure(deps.db, round.id, code) !== null) result.failed += 1;
  log(options, `travel-recovery failed ${round.id} account=${round.account_id} code=${code}`);
}

function log(options: TravelRecoveryOptions, line: string): void {
  options.log?.(line);
}

export interface TravelRecoveryHandle {
  /** 手动/即时触发一轮（与周期扫描串行，不会并发重复回收） */
  runNow(): Promise<TravelRecoverySweep>;
  /** 启动补偿扫描的完成信号（生产可选 await；测试用它断言接线生效） */
  ready: Promise<TravelRecoverySweep>;
  /** 停表（幂等） */
  stop(): void;
}

/**
 * 启动回收 ticker：先跑一次补偿扫描（启动补算），之后每 intervalMs（默认 5 分钟）扫一轮。
 * 扫描串行化：启动补算与周期 tick 不会同时处理同一批行（CAS 之外的第二道保险）。
 */
export function startTravelRecoveryTicker(deps: TravelRecoveryDeps, options: TravelRecoveryOptions = {}): TravelRecoveryHandle {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const handle = setInterval(fn, ms);
    // 辅助定时器不阻止进程退出（测试/优雅关闭不留悬挂句柄）
    handle.unref?.();
    return handle;
  });
  const cancel = options.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let chain: Promise<TravelRecoverySweep> = Promise.resolve(emptySweep());
  const enqueue = (): Promise<TravelRecoverySweep> => {
    const next = chain.then(
      () => sweepTravelRecoveries(deps, options),
      () => sweepTravelRecoveries(deps, options),
    );
    chain = next.catch(() => emptySweep());
    return next;
  };
  const ready = enqueue().catch(error => {
    log(options, `travel-recovery startup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    return emptySweep();
  });
  const handle = schedule(() => {
    void enqueue().catch(error => {
      log(options, `travel-recovery sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.intervalMs ?? TRAVEL_SWEEP_INTERVAL_MS);
  let stopped = false;
  return {
    runNow: enqueue,
    ready,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel(handle);
    },
  };
}
