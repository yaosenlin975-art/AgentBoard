/**
 * ACC-KB-B5S S2 + ACC-QUOTA-ALL：五平台额度的纯解析器 + 来源分组 + fetchPlatform 分支断言（离线样例，不碰网络）。
 *
 * 只用接口响应形状做断言，**不写任何一次性真实读数**（知识页里 2026-11-04 的单账号数值不进断言）。
 * 重点校验知识 §2 的语义坑：Trae 的 consumed 是已用、WorkBuddy 的字符串小数要能解、
 * ZCode 的 unit/number 是窗口粒度枚举、Qoder 的超额标记优先级高于 percentage、
 * MiniMax 只认 op_credit_summary（opcredit_balance/total_remains_credit 是已购取整，不消费）。
 */
import { describe, expect, it } from 'vitest';
import { QUOTA_GROUPS, QUOTA_SOURCE_GROUP, QUOTA_SOURCE_IDS } from '@agentboard/shared';
import {
  parseMinimaxCredits,
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

describe('MiniMax 解析（只认 op_credit_summary，其余积分字段不消费）', () => {
  it('total_remaining_amount 是字符串也能解（= purchased + free 自洽样本）', () => {
    const parsed = parseMinimaxCredits({
      plan_type: 'free',
      opcredit_balance: 1976,
      total_remains_credit: 1976,
      op_credit_summary: { total_remaining_amount: '5695.397', purchased_remaining_amount: '1976.867', free_remaining_amount: '3718.53' },
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    expect(parsed.balance).toBeCloseTo(5695.397, 3);
    expect(parsed.unit).toBe('积分');
    expect(parsed.windows[0]).toMatchObject({ name: '会员积分', kind: 'credit', remaining: 5695.397 });
  });

  it('旧口径字段（opcredit_balance / total_remains_credit）不冒充总余额', () => {
    // 已购取整 1976 < 真余额 5695.397：解析器若误读旧字段就会少报免费积分
    const parsed = parseMinimaxCredits({
      opcredit_balance: 1976,
      total_remains_credit: 1976,
      op_credit_summary: { total_remaining_amount: 5695.397, purchased_remaining_amount: 1976.867, free_remaining_amount: 3718.53 },
    });
    expect(parsed.balance).toBeCloseTo(5695.397, 3);
  });

  it('缺 op_credit_summary 时如实返回空（不拿旧字段兜底）', () => {
    const parsed = parseMinimaxCredits({ opcredit_balance: 1976, base_resp: { status_code: 2062 } });
    expect(parsed.balance).toBeNull();
    expect(parsed.windows).toEqual([]);
  });
});

describe('平台来源的「无凭据即如实 unsupported」', () => {
  const build = () => createQuotaService({
    platformTokens: {}, // 五个平台都没凭据
    fetchImpl: (() => { throw new Error('无凭据时不应发起任何请求'); }) as unknown as typeof fetch,
    env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
  });

  it('五个平台来源都返回 unsupported + NO_CREDENTIAL', async () => {
    const snapshot = await build().get();
    const byId = new Map(snapshot.items.map((item) => [item.source, item]));
    for (const source of ['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode'] as const) {
      const item = byId.get(source);
      expect(item, `缺来源 ${source}`).toBeDefined();
      expect(item).toMatchObject({ status: 'unsupported', reason_code: 'NO_CREDENTIAL', balance: null });
    }
    // 八个来源都要在响应里（单来源失败不影响其它来源）
    expect([...byId.keys()].sort()).toEqual([...QUOTA_SOURCE_IDS].sort());
  });
});

/**
 * ACC-QUOTA-ALL：fetchPlatform 五分支的端点/鉴权/解析逐项断言（fake fetch，不碰网络）。
 * 鉴权口径来自知识 `3c21b76c` §1：trae 必须 `Authorization: Cloud-IDE-JWT`（Bearer 401），
 * 其余四平台 Bearer；trae body 需 require_usage:true（v2 才有 usage_summary）。
 */
describe('fetchPlatform 五分支（fake fetch + 注入凭据）', () => {
  interface Captured { url: string; init: RequestInit }
  const captureFetch = (respond: () => { status: number; body: unknown }) => {
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const { status, body } = respond();
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  const buildWith = (source: 'workbuddy' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode', fetchImpl: typeof fetch) =>
    createQuotaService({
      platformTokens: { [source]: `token-for-${source}` } as Partial<Record<'workbuddy' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode' | 'deepseek' | 'opencode_go' | 'codex', string | null>>,
      fetchImpl,
      env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
    });

  const authOf = (call: Captured): string => String((call.init.headers as Record<string, string>)['authorization'] ?? (call.init.headers as Record<string, string>).Authorization ?? '');

  it('trae：POST v2 pay 端点 + Cloud-IDE-JWT 前缀 + require_usage body，usage_summary 语义（consumed 是已用）', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({
      status: 200,
      body: { usage_summary: { total_amount: 5000, consumed_amount: 1200.5, consumption_ratio: 0.24 } },
    }));
    const item = (await buildWith('trae', fetchImpl).get()).items.find((entry) => entry.source === 'trae')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
    expect(calls[0]!.init.method).toBe('POST');
    expect(authOf(calls[0]!)).toBe('Cloud-IDE-JWT token-for-trae');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ require_usage: true, req_source: 1 });
    expect(item).toMatchObject({ status: 'ok', balance: 3799.5, unit: '积分', reason_code: null });
    expect(item.windows[0]).toMatchObject({ kind: 'credit', total: 5000, used: 1200.5, remaining: 3799.5 });
  });

  it('workbuddy：POST codebuddy 计费端点 + Bearer + 空 body，TotalCredits 字符串可解', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({ status: 200, body: { code: 0, data: { TotalCredits: '300.00' } } }));
    const item = (await buildWith('workbuddy', fetchImpl).get()).items.find((entry) => entry.source === 'workbuddy')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://www.codebuddy.cn/billing/meter/get-user-resource-summary');
    expect(calls[0]!.init.method).toBe('POST');
    expect(authOf(calls[0]!)).toBe('Bearer token-for-workbuddy');
    expect(String(calls[0]!.init.body)).toBe('{}');
    expect(item).toMatchObject({ status: 'ok', balance: 300, unit: '积分' });
  });

  it('minimax：POST get_membership_info + Bearer（无签名头），真积分取 op_credit_summary', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({
      status: 200,
      body: {
        opcredit_balance: 1976,
        total_remains_credit: 1976,
        op_credit_summary: { total_remaining_amount: '5695.397', purchased_remaining_amount: '1976.867', free_remaining_amount: '3718.53' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    }));
    const item = (await buildWith('minimax', fetchImpl).get()).items.find((entry) => entry.source === 'minimax')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://agent.minimaxi.com/matrix/api/v1/commerce/get_membership_info');
    expect(calls[0]!.init.method).toBe('POST');
    expect(authOf(calls[0]!)).toBe('Bearer token-for-minimax');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['yy']).toBeUndefined();
    expect(headers['x-signature']).toBeUndefined();
    expect(item).toMatchObject({ status: 'ok', balance: 5695.397, unit: '积分', reason_code: null });
  });

  it('qoder_cn：GET openapi quota/usage + Bearer，userQuota 直读', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({
      status: 200,
      body: { userQuota: { total: 1000, used: 250, remaining: 750, percentage: 25, unit: 'credits' }, isQuotaExceeded: false, plan_tier_name: 'Pro' },
    }));
    const item = (await buildWith('qoder_cn', fetchImpl).get()).items.find((entry) => entry.source === 'qoder_cn')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openapi.qoder.com.cn/api/v2/quota/usage');
    expect(calls[0]!.init.method).toBe('GET');
    expect(authOf(calls[0]!)).toBe('Bearer token-for-qoder_cn');
    expect(item).toMatchObject({ status: 'ok', balance: 750, unit: 'credits' });
    expect(item.windows[0]).toMatchObject({ name: 'Pro', total: 1000, used: 250, remaining: 750 });
  });

  it('zcode：GET bigmodel quota/limit + Bearer，limits 映射成窗口', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({
      status: 200,
      body: { data: { level: 'lite', limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 778, remaining: 1221, percentage: 38, nextResetTime: 1_800_000_000_000 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 8379, remaining: 1620, percentage: 83 },
      ] } },
    }));
    const item = (await buildWith('zcode', fetchImpl).get()).items.find((entry) => entry.source === 'zcode')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://bigmodel.cn/api/monitor/usage/quota/limit');
    expect(calls[0]!.init.method).toBe('GET');
    expect(authOf(calls[0]!)).toBe('Bearer token-for-zcode');
    expect(item.status).toBe('ok');
    expect(item.balance).toBe(1221);
    expect(item.windows).toHaveLength(2);
    // 真实响应无 total 字段（unit/number 是窗口粒度枚举），断言只锁 name/kind/used/remaining
    expect(item.windows[0]).toMatchObject({ name: '5h', kind: 'rolling', used: 778, remaining: 1221, used_percent: 38 });
  });

  it('401 → CREDENTIAL_INVALID + 可行动指引；单平台失败不影响其它平台', async () => {
    const { fetchImpl } = captureFetch(() => ({ status: 401, body: {} }));
    const service = createQuotaService({
      platformTokens: { trae: 'expired-token', zcode: 'ok-token' } as Partial<Record<'workbuddy' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode' | 'deepseek' | 'opencode_go' | 'codex', string | null>>,
      fetchImpl,
      env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
    });
    const byId = new Map((await service.get()).items.map((entry) => [entry.source, entry]));
    expect(byId.get('trae')).toMatchObject({ status: 'error', reason_code: 'CREDENTIAL_INVALID' });
    expect(byId.get('trae')!.detail).toContain('凭据已失效');
    expect(byId.get('trae')!.detail).not.toContain('expired-token');
    // 无凭据的其它平台不受影响
    expect(byId.get('workbuddy')).toMatchObject({ status: 'unsupported', reason_code: 'NO_CREDENTIAL' });
  });

  it('platformCredential 解析器优先于静态 platformTokens；抛错兜底 CREDENTIAL_UNAVAILABLE', async () => {
    const { calls, fetchImpl } = captureFetch(() => ({ status: 200, body: { data: { TotalCredits: '1088.63' } } }));
    const service = createQuotaService({
      platformTokens: { workbuddy: 'stale-static-token' },
      platformCredential: async (source) => source === 'workbuddy'
        ? { kind: 'ok', token: 'fresh-vault-token', accountName: 'Mui' }
        : { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '无凭据' },
      fetchImpl,
      env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
    });
    const byId = new Map((await service.get()).items.map((entry) => [entry.source, entry]));
    expect(authOf(calls[0]!)).toBe('Bearer fresh-vault-token');
    expect(byId.get('workbuddy')).toMatchObject({ status: 'ok', balance: 1088.63, detail: '账号：Mui' });
    // 解析器抛错 → 该来源 error + CREDENTIAL_UNAVAILABLE，不炸整个快照
    const failing = createQuotaService({
      platformCredential: async () => { throw new Error('vault boom'); },
      fetchImpl: (() => { throw new Error('解析失败时不应发起请求'); }) as unknown as typeof fetch,
      env: {}, homeDir: 'D:\\no-such-home', now: () => 1_700_000_000_000,
    });
    const failingById = new Map((await failing.get()).items.map((entry) => [entry.source, entry]));
    expect(failingById.get('minimax')).toMatchObject({ status: 'error', reason_code: 'CREDENTIAL_UNAVAILABLE' });
    expect(failingById.get('deepseek')!.status).toBeDefined();
  });
});
