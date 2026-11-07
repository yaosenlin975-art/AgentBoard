/**
 * ACC-KB-B5S S2：五个平台账号侧额度/积分的**纯解析器**（离线样例可测，不碰网络）。
 *
 * 依据公共知识 `3c21b76c` §1/§2 的接口矩阵与语义坑，逐平台只做「响应体 → QuotaWindow[]/balance」，
 * 网络与凭据在调用方（`quotaService.ts` 的 platform fetcher）处理。
 *
 * 语义约定（与既有 `QuotaResult` 一致）：
 * - `balance` 是**当前可用余额/剩余**；
 * - `QuotaWindow.remaining` 恒为「剩余」，`used` 为「已用」，`total` 为窗口总量；
 * - 平台给的百分比字段只在能算准的情况下写 `used_percent`，算不准就留 null。
 */
import type { QuotaWindow } from '@agentboard/shared';

/** 安全取数：非有限数返回 null（平台常把数字写成字符串） */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const pct = (used: number | null, total: number | null): number | null =>
  used === null || total === null || total <= 0 ? null : Math.round((used / total) * 1000) / 10;

/** 取对象下的属性（容错：非对象返回 undefined） */
function pick(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

export interface PlatformQuotaParse {
  /** 当前可用（剩余）；无法判定时 null */
  balance: number | null;
  unit: string | null;
  windows: QuotaWindow[];
}

/**
 * Trae：`POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`（必须 v2）
 * `usage_summary.{total_amount,consumed_amount}` —— `consumed_amount` 是**已用**，剩余 = total - consumed。
 * 坑：`credits_amount` 也是已用口径，需先取包列表再 Σ；这里只用 usage_summary（有则优先）。
 */
export function parseTraeUsage(body: unknown): PlatformQuotaParse {
  const summary = pick(body, 'usage_summary') ?? body;
  const total = num(pick(summary, 'total_amount'));
  const used = num(pick(summary, 'consumed_amount'));
  const remaining = total !== null && used !== null ? Math.max(total - used, 0) : null;
  const windows: QuotaWindow[] = total === null && used === null
    ? []
    : [{
        name: '积分包',
        kind: 'credit',
        remaining: remaining ?? 0,
        total,
        used,
        used_percent: pct(used, total),
        reset_at: null,
      }];
  return { balance: remaining, unit: '积分', windows };
}

/**
 * WorkBuddy：`POST https://www.codebuddy.cn/billing/meter/get-user-resource-summary`
 * `data.TotalCredits` 是**字符串小数**（`"100.00"` 这类），必须 Number() 后校验 NaN；
 * `data.Packages[]` / `data.CreditGroups[].Cycle*` 是账期维度，能解出来就补成 credit 窗口。
 */
export function parseWorkbuddyCredits(body: unknown): PlatformQuotaParse {
  const data = pick(body, 'data') ?? body;
  const rawTotal = pick(data, 'TotalCredits');
  let total = num(rawTotal);
  // 平台会把小数写成字符串；解析失败就当「无额度字段」，不要静默变 0
  if (total !== null && typeof rawTotal === 'string' && rawTotal.trim() === '') total = null;

  const windows: QuotaWindow[] = [];
  const packages = pick(data, 'Packages');
  if (Array.isArray(packages)) {
    for (const entry of packages) {
      const remaining = num(pick(entry, 'RemainingCredits') ?? pick(entry, 'RemainCredits') ?? pick(entry, 'Remaining'));
      const packageTotal = num(pick(entry, 'TotalCredits') ?? pick(entry, 'Total'));
      const used = num(pick(entry, 'UsedCredits') ?? pick(entry, 'Consumed'));
      const resetRaw = num(pick(entry, 'ExpireAt') ?? pick(entry, 'CycleEnd'));
      if (remaining === null && packageTotal === null) continue;
      windows.push({
        name: typeof pick(entry, 'Name') === 'string' ? String(pick(entry, 'Name')).slice(0, 40) : '积分包',
        kind: 'credit',
        remaining: remaining ?? Math.max((packageTotal ?? 0) - (used ?? 0), 0),
        total: packageTotal,
        used,
        used_percent: pct(used, packageTotal),
        reset_at: resetRaw === null ? null : resetRaw,
      });
    }
  }
  if (windows.length === 0 && total !== null) {
    windows.push({ name: '积分余额', kind: 'credit', remaining: total, total, used: null, used_percent: null, reset_at: null });
  }
  return { balance: total ?? windows[0]?.remaining ?? null, unit: '积分', windows };
}

/**
 * ZCode：`GET https://bigmodel.cn/api/monitor/usage/quota/limit`
 * `data.limits[]{type,unit,number,usage,currentValue,remaining,percentage,nextResetTime}`。
 * 坑：`unit`+`number` 是窗口粒度枚举（`unit=3` + `number=5` → 5 小时窗），不是数值本身；
 * 凭据必须用 `oauth:bigmodel:access_token`，不是 `zcodejwttoken`（凭据选择在调用方）。
 */
export function zcodeWindowName(unit: unknown, number: unknown): string {
  const n = num(number);
  if (num(unit) === 3 && n !== null) return `${n}h`;
  const type = pick({ type: unit }, 'type');
  return typeof type === 'string' && type !== '' ? type : '额度窗口';
}

export function parseZcodeQuota(body: unknown): PlatformQuotaParse {
  const data = pick(body, 'data') ?? body;
  const limits = pick(data, 'limits');
  const windows: QuotaWindow[] = [];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const total = num(pick(entry, 'total')) ?? num(pick(entry, 'number'));
      const used = num(pick(entry, 'currentValue')) ?? num(pick(entry, 'usage'));
      const remaining = num(pick(entry, 'remaining'));
      const percentage = num(pick(entry, 'percentage'));
      const resetAt = num(pick(entry, 'nextResetTime'));
      const computedRemaining = remaining ?? (total !== null && used !== null ? Math.max(total - used, 0) : null);
      if (computedRemaining === null && total === null) continue;
      const unit = pick(entry, 'unit');
      const name = zcodeWindowName(unit, pick(entry, 'number'));
      windows.push({
        name,
        kind: name.endsWith('h') ? 'rolling' : 'monthly',
        remaining: computedRemaining ?? 0,
        total,
        used,
        used_percent: percentage ?? pct(used, total),
        reset_at: resetAt,
      });
    }
  }
  const primary = windows[0];
  return { balance: primary?.remaining ?? null, unit: '次', windows };
}

/**
 * Qoder：`GET https://openapi.qoder.com.cn/api/v2/quota/usage`
 * `userQuota{total,used,remaining,percentage,unit}` + `isQuotaExceeded` + `plan_tier_name`。
 * 坑：只看 `percentage` 会误判——`isQuotaExceeded` 与 `plan_tier_name` 要一起判：
 * 超额就直接把 `balance` 归零（即便 percentage 还没到 100）。
 */
export function parseQoderQuota(body: unknown): PlatformQuotaParse {
  const quota = pick(body, 'userQuota') ?? body;
  const total = num(pick(quota, 'total'));
  const used = num(pick(quota, 'used'));
  const remaining = num(pick(quota, 'remaining'));
  const percentage = num(pick(quota, 'percentage'));
  const exceeded = pick(body, 'isQuotaExceeded') === true;
  const unitRaw = pick(quota, 'unit');
  const unit = typeof unitRaw === 'string' && unitRaw !== '' ? unitRaw : '积分';
  const planTier = pick(body, 'plan_tier_name');
  const computedRemaining = remaining ?? (total !== null && used !== null ? Math.max(total - used, 0) : null);
  const balance = exceeded ? 0 : computedRemaining;
  const windows: QuotaWindow[] = computedRemaining === null && total === null
    ? []
    : [{
        name: typeof planTier === 'string' && planTier !== '' ? planTier.slice(0, 40) : '套餐额度',
        kind: 'monthly',
        remaining: computedRemaining ?? 0,
        total,
        used,
        used_percent: percentage ?? pct(used, total),
        reset_at: null,
      }];
  return { balance, unit, windows };
}

/**
 * MiniMax：`POST https://agent.minimaxi.com/matrix/api/v1/commerce/get_membership_info`
 * 真积分在 `op_credit_summary.total_remaining_amount`（= purchased + free，可能是**字符串**）。
 * 坑（知识 `3c21b76c` §2）：`opcredit_balance` / `total_remains_credit` 是「已购积分取整」，
 * 当总余额用会漏掉免费积分——**只认 `op_credit_summary`**；
 * `*_usage_count` 是剩余不是已用（本解析不消费这两个字段）。
 * 签名头（yy / x-timestamp / x-signature）实测（2026-11-07）**非必需**：仅 Bearer 也 `status_code=0` 成功。
 */
export function parseMinimaxCredits(body: unknown): PlatformQuotaParse {
  const summary = pick(body, 'op_credit_summary');
  const total = num(pick(summary, 'total_remaining_amount'));
  const windows: QuotaWindow[] = total === null
    ? []
    : [{ name: '会员积分', kind: 'credit', remaining: total, total: null, used: null, used_percent: null, reset_at: null }];
  return { balance: total, unit: '积分', windows };
}
