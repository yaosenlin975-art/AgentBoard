/**
 * B4S-4：切换骨架 S0–S5 —— **一份流程**，provider 只提供各步回调。
 *
 * ## 为什么要收敛
 *
 * 收敛前，WorkBuddy（28KB）与 MiniMax（13KB）各自写了一套切换流程，阶段名一样、语义不同：
 *
 * | 步 | WorkBuddy（收敛前） | MiniMax（收敛前） |
 * | --- | --- | --- |
 * | S0 preflight | 版本/实例检查 + 目标实例三元组 | 读 auth.json + 客户端在跑则阻断 |
 * | S1 stop | UIA 托盘退出 → 降级 WS 手动退出 + 退出签名轮询 | 探测 + stop（仍在跑则阻断） |
 * | S2 snapshot | 读盘 backup（回滚依据） | vault.protect 当前凭据（回滚依据） |
 * | S3 validate_target | 解密快照 + 三元组/版本/sha256 校验 | 共用 `validateTarget` |
 * | S4 write | 临时文件 + rename 原子替换 | 临时文件 + rename 原子替换 |
 * | S5 start | 启动 + 等三信号 | 启动 |
 * | S5 verify | 读回本地 uid 比对 | 本地 token 比对 + **服务端身份校验** |
 * | rollback | 写回 backup + 重启 + 核验原账号 | 写回快照（失败 → `recovery_ref` → A3 restore） |
 *
 * 两套流程的**编排**其实一样（都是「停 → 快照 → 校验 → 写 → 起 → 核验 → 失败回滚」），
 * 差的是每步的实现。本模块把**编排**抽成一份，两个 provider 各自提供回调；
 * 各步的判定口径（例如 S5 是否查服务端）仍由 provider 自己决定，**不在本模块改变语义**。
 *
 * ## 骨架的职责边界
 *
 * 骨架只做三件事：
 * 1. **按固定顺序**调用各步回调，并在每步开始前把 stage 落库（运维能定位卡在哪一步）；
 * 2. **start / verify 失败 → 走回滚**（S4 写盘失败**不回滚**：客户端文件未被改动）；
 * 3. 回滚失败的收尾由 provider 的 rollback 回调决定（抛 `SWITCH_ROLLED_BACK` 表示已核验恢复，
 *    抛 `RECOVERY_REQUIRED` 表示未能恢复、实例冻结）。
 *
 * 骨架**不做**：判定目标是否可用（S3）、判定切换结果对不对（S5）、写客户端（S4）、改 stage 之外的任何状态。
 */
import type { AccountOperation } from '@agentboard/shared';
import { ApiError } from '../../errors.js';

/** 骨架的阶段落点（与 `account_operation.stage` 同一套值） */
export type SwitchFlowStage = AccountOperation['stage'];

/** 骨架的固定步序（回滚步不在正常路径上，由失败分支进入） */
export const SWITCH_FLOW_STEPS = [
  'preflight', 'stop', 'snapshot', 'validate_target', 'write', 'start', 'verify',
] as const;

/**
 * provider 的回调表：骨架按顺序调用，每步失败即中止。
 *
 * - `TSnapshot` = **回滚依据**（S2 产出；写盘前的客户端状态）
 * - `TWrite` = **要写进客户端的内容**（S3 产出；S4 消费）
 */
export interface SwitchFlowCallbacks<TWrite, TSnapshot> {
  /** S0 preflight：客户端实例/版本/路径 + 目标账号基本事实。失败 → 中止，未触碰客户端 */
  preflight(): Promise<void>;
  /** S1 stop：确保客户端退出（绝不覆盖仍在运行的客户端）。失败 → 中止，未触碰客户端 */
  stop(): Promise<void>;
  /** S2 snapshot：产出回滚依据 */
  snapshot(): Promise<TSnapshot>;
  /** S3 validate_target：校验目标并产出要写的内容。失败 → 中止，未写客户端 */
  validateTarget(): Promise<TWrite>;
  /** S4 write：把目标写进客户端（原子替换）。失败 → 中止（文件未被改动，不回滚） */
  write(target: TWrite): Promise<void>;
  /** S5 start：启动客户端。失败 → 回滚 */
  start(): Promise<void>;
  /** S5 verify：核验切换结果。失败 → 回滚 */
  verify(): Promise<void>;
  /**
   * 回滚：把 S2 的依据写回客户端。
   * 必须**以抛错收尾**：抛 `SWITCH_ROLLED_BACK` = 已核验恢复原账号；抛 `RECOVERY_REQUIRED` = 未能恢复、实例冻结。
   */
  rollback(snapshot: TSnapshot, cause: string): Promise<void>;
}

/** 失败原因码：ApiError 用其 code，其余归到固定码（不带原始异常文本） */
export function switchFailureCause(error: unknown): string {
  return error instanceof ApiError ? error.code : 'SWITCH_STAGE_FAILED';
}

/**
 * 跑一遍切换流程。
 *
 * 返回 `'succeeded'` 供 `runAccountOperation` 收尾；任何失败都以异常上抛（由 operationRunner 落终态）。
 */
export async function runSwitchFlow<TWrite, TSnapshot>(options: {
  /** 落 stage（provider 自己决定怎么写库） */
  setStage: (stage: SwitchFlowStage) => void;
  callbacks: SwitchFlowCallbacks<TWrite, TSnapshot>;
}): Promise<'succeeded'> {
  const { setStage, callbacks } = options;

  setStage('preflight');
  await callbacks.preflight();

  setStage('stop');
  await callbacks.stop();

  setStage('snapshot');
  const snapshot = await callbacks.snapshot();

  setStage('validate_target');
  const target = await callbacks.validateTarget();

  setStage('write');
  await callbacks.write(target);

  setStage('start');
  try {
    await callbacks.start();
  } catch (error) {
    await rollbackOrThrow(setStage, callbacks, snapshot, switchFailureCause(error));
  }

  setStage('verify');
  try {
    await callbacks.verify();
  } catch (error) {
    await rollbackOrThrow(setStage, callbacks, snapshot, switchFailureCause(error));
  }

  return 'succeeded';
}

/**
 * 回滚并收尾。
 *
 * provider 的 rollback 回调以抛错收尾（`SWITCH_ROLLED_BACK` / `RECOVERY_REQUIRED`），错误直接上抛；
 * 万一回调正常返回（provider 没按约定抛错），骨架兜底抛 `SWITCH_ROLLED_BACK`（视为已回滚）。
 */
async function rollbackOrThrow<TWrite, TSnapshot>(
  setStage: (stage: SwitchFlowStage) => void,
  callbacks: SwitchFlowCallbacks<TWrite, TSnapshot>,
  snapshot: TSnapshot,
  cause: string,
): Promise<never> {
  setStage('rollback');
  await callbacks.rollback(snapshot, cause);
  throw new ApiError(409, 'SWITCH_ROLLED_BACK', `切换失败已回滚（失败原因: ${cause}）`);
}
