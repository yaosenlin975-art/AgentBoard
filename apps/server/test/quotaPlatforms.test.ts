/**
 * ACC-KB-B5S S2：五平台额度的纯解析器 + 来源分组断言（离线样例，不碰网络）。
 *
 * 只用接口响应形状做断言，**不写任何一次性真实读数**（知识页里 2026-11-04 的单账号数值不进断言）。
 * 重点校验知识 §2 的语义坑：Trae 的 consumed 是已用、WorkBuddy 的字符串小数要能解、
 * ZCode 的 unit/number 是窗口粒度枚举、Qoder 的超额标记优先级高于 percentage。
 */
import { describe, expect, it } from 'vitest';
import { QUOTA_GROUPS, QUOTA_SOURCE_GROUP, QUOTA_SOURCE_IDS } from '@agentboard/shared';
import {
  MINIMAX_UNSUPPORTED_DETAIL,
  parseQoderQuota,
  parseTraeUsage,
  parseWorkbuddyCredits,
  parseZcodeQuota,
  zcodeWindowName,
} from '../src/services/quotas/platformQuotaParsers.js';
import { createQuotaService } from '../src/services/quotas/quotaService.js';

describe('额度来源分组（8 个来源分两组）', () => {
  it('CLI 额度 3 个 + 平台账号 5 个，且分组与来源清单自洽', () => {
    expect(QUOTA_GROUPS.map((group) => group.id)).toEqual(['cli', 'platform']);
    expect(QUOTA_GROUPS[0]!.sources).toEqual(['deepseek', 'opencode_go', 'codex']);
    expect(QUOTA_GROUPS[1]!.sources).toEqual(['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode']);
    expect([...QUOTA_SOURCE_IDS]).toHaveLength(8);
    for (const source of QUOTA_SOURCE_IDS) expect(QUOTA_SOURCE_GROUP[source]).toBeDefined();
  });
});

describe('Trae 解析（consumed 是已用，剩余 = total - consumed）', () => {
  it('usage_summary 直出', () => {
    const parsed = parseTraeUsage({ usage_summary: { total_amount: 5000, consumed_amount: 1200.5 } });
    expect(parsed.balance).toBeCloseTo(3799.5, 5);
    expect(parsed.windows[0]).toMatchObject({ kind: 'credit', total: 5000, used: 1200.5, remaining: 3799.5 });
    expect(parsed.windows[0]!.used_percent).toBeCloseTo(24, 0);
  });

  it('字符串数字与缺字段都能兜住（不把空串当 0）', () => {
    expect(parseTraeUsage({ usage_summary: { total_amount: '100', consumed_amount: '40' } }).balance).toBe(60);
    const missing = parseTraeUsage({});
    expect(missing.balance).toBeNull();
    expect(missing.windows).toEqual([]);
  });
});

describe('WorkBuddy 解析（TotalCredits 是字符串小数）', () => {
  it('字符串小数可解，并落成 credit 窗口', () => {
    const parsed = parseWorkbuddyCredits({ data: { TotalCredits: '100.00' } });
    expect(parsed.balance).toBe(100);
    expect(parsed.windows[0]).toMatchObject({ kind: 'credit', total: 100, remaining: 100 });
  });

  it('Packages 能给出多包窗口时优先用包维度', () => {
    const parsed = parseWorkbuddyCredits({
      data: {
        TotalCredits: '12987.00',
        Packages: [
          { Name: '月度包', TotalCredits: '1000', UsedCredits: '900', ExpireAt: 1_800_000_000_000 },
          { Name: '赠送包', TotalCredits: '500', UsedCredits: '100' },
        ],
      },
    });
    expect(parsed.windows).toHaveLength(2);
    expect(parsed.windows[0]).toMatchObject({ name: '月度包', total: 1000, used: 900, remaining: 100 });
    expect(parsed.balance).toBe(12987);
  });

  it('异常字符串不当 0 处理', () => {
    const parsed = parseWorkbuddyCredits({ data: { TotalCredits: '   ' } });
    expect(parsed.balance).toBeNull();
  });
});

describe('ZCode 解析（unit/number 是窗口粒度枚举）', () => {
  it('unit=3 + number=5 → 5 小时窗，字段映射到 total/used/remaining', () => {
    expect(zcodeWindowName(3, 5)).toBe('5h');
    const parsed = parseZcodeQuota({
      data: { limits: [{ type: 'tokens', unit: 3, number: 5, currentValue: 800, total: 2000, nextResetTime: 1_800_000_000_000 }] },
    });
    expect(parsed.windows[0]).toMatchObject({ name: '5h', kind: 'rolling', total: 2000, used: 800, remaining: 1200 });
    expect(parsed.windows[0]!.used_percent).toBe(40);
    expect(parsed.balance).toBe(1200);
  });

  it('percentage 优先于自己算的比例；无 limits 时返回空', () => {
    const parsed = parseZcodeQuota({ data: { limits: [{ unit: 1, number: 30, remaining: 10, percentage: 66.6 }] } });
    expect(parsed.windows[0]!.used_percent).toBe(66.6);
    expect(parseZcodeQuota({ data: {} }).windows).toEqual([]);
  });
});

describe('Qoder 解析（isQuotaExceeded 优先级高于 percentage）', () => {
  it('超额时 balance 归零，即使 percentage 不到 100', () => {
    const parsed = parseQoderQuota({
      userQuota: { total: 1000, used: 600, remaining: 400, percentage: 60, unit: '积分' },
      isQuotaExceeded: true,
      plan_tier_name: 'Pro',
    });
    expect(parsed.balance).toBe(0);
    expect(parsed.windows[0]).toMatchObject({ name: 'Pro', total: 1000, used: 600, remaining: 400 });
  });

  it('未超额时用 remaining', () => {
    const parsed = parseQoderQuota({ userQuota: { total: 1000, used: 600, remaining: 400, unit: '积分' }, isQuotaExceeded: false });
    expect(parsed.balance).toBe(400);
    expect(parsed.unit).toBe('积分');
  });
});

describe('平台来源的「无凭据即如实 unsupported」', () => {
  const build = () => createQuotaService({
    platformTokens: {}, // 五个平台都没凭据
    fetchImpl: (() => { throw new Error('无凭据时不应发起任何请求'); }) as unknown as typeof fetch,
    env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
  });

  it('五个平台来源都返回 unsupported + NO_CREDENTIAL，MiniMax 给出签名材料缺失说明', async () => {
    const snapshot = await build().get();
    const byId = new Map(snapshot.items.map((item) => [item.source, item]));
    for (const source of ['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode'] as const) {
      const item = byId.get(source);
      expect(item, `缺来源 ${source}`).toBeDefined();
      expect(item).toMatchObject({ status: 'unsupported', reason_code: 'NO_CREDENTIAL', balance: null });
    }
    expect(byId.get('minimax')!.detail).toBe(MINIMAX_UNSUPPORTED_DETAIL);
    // 八个来源都要在响应里（单来源失败不影响其它来源）
    expect([...byId.keys()].sort()).toEqual([...QUOTA_SOURCE_IDS].sort());
  });
});
