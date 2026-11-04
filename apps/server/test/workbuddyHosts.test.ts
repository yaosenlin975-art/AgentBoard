/**
 * ACC-KB-A1：WorkBuddy 计费 host 校正与区域化。
 *
 * 背景（探活证据见卡评论与 `platformHosts.ts` 头注释）：
 * - 旧常量 `api.workbuddy.cn` 在本机 NXDOMAIN（GET/POST 均连接失败），全仓只出现一次且无断言；
 * - CN 有业务成功证据（`www.codebuddy.cn` 实测 200 / code 0）；
 * - Global 备用线路 `www.workbuddy.cn` 探活 401（host 有效、需认证）。
 *
 * 断言目标：host 不再是散落字面量，而是「区域 → origin」单一映射；未知区域明确报错不回落。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBUDDY_REGION,
  loadConfig,
  parseWorkbuddyRegion,
  type WorkbuddyRegion,
} from '../src/config.js';
import {
  WORKBUDDY_BILLING_ORIGIN,
  workbuddyBillingUrl,
  workbuddyQuotaUrl,
} from '../src/services/accounts/platformHosts.js';
import { createCheckinProviders } from '../src/services/accounts/httpCheckinProviders.js';

describe('区域 → origin 映射（单一事实源）', () => {
  it('cn 打 www.codebuddy.cn、global 打 www.workbuddy.cn', () => {
    expect(WORKBUDDY_BILLING_ORIGIN.cn).toBe('https://www.codebuddy.cn');
    expect(WORKBUDDY_BILLING_ORIGIN.global).toBe('https://www.workbuddy.cn');
  });

  it('旧的错误域名不再出现在任何映射里', () => {
    expect(Object.values(WORKBUDDY_BILLING_ORIGIN).join(' ')).not.toContain('api.workbuddy.cn');
  });

  it('签到端点按区域拼 URL', () => {
    expect(workbuddyBillingUrl('cn', '/billing/meter/daily-checkin')).toBe(
      'https://www.codebuddy.cn/billing/meter/daily-checkin',
    );
    expect(workbuddyBillingUrl('global', '/billing/meter/checkin-activity-status')).toBe(
      'https://www.workbuddy.cn/billing/meter/checkin-activity-status',
    );
  });

  it('额度端点与签到同源', () => {
    expect(workbuddyQuotaUrl()).toBe('https://www.codebuddy.cn/billing/meter/get-user-resource-summary');
    expect(workbuddyQuotaUrl('global')).toBe('https://www.workbuddy.cn/billing/meter/get-user-resource-summary');
  });

  it('unknown / 未知区域明确报错，不静默回落默认域', () => {
    expect(() => workbuddyBillingUrl('unknown', '/billing/meter/daily-checkin')).toThrowError(/CHECKIN_REGION_UNSUPPORTED|不支持该区域/);
    expect(() => workbuddyBillingUrl('apac' as WorkbuddyRegion, '/x')).toThrow();
    expect(() => workbuddyQuotaUrl('unknown')).toThrow();
  });
});

describe('配置解析（env 覆盖，不落 config.json）', () => {
  it('parseWorkbuddyRegion 只接受 cn / global（大小写与空白宽容）', () => {
    expect(parseWorkbuddyRegion('cn')).toBe('cn');
    expect(parseWorkbuddyRegion(' GLOBAL ')).toBe('global');
    expect(parseWorkbuddyRegion('')).toBeNull();
    expect(parseWorkbuddyRegion('apac')).toBeNull();
  });

  it('默认 region 是 cn', () => {
    expect(DEFAULT_WORKBUDDY_REGION).toBe('cn');
    const config = loadConfig({});
    expect(config.workbuddyRegion).toBe('cn');
  });

  it('AGENTBOARD_WORKBUDDY_REGION=global 生效', () => {
    const config = loadConfig({ AGENTBOARD_WORKBUDDY_REGION: 'global' } as NodeJS.ProcessEnv);
    expect(config.workbuddyRegion).toBe('global');
  });

  it('非法 region 启动即报错（不静默回落到 cn）', () => {
    expect(() => loadConfig({ AGENTBOARD_WORKBUDDY_REGION: 'apac' } as NodeJS.ProcessEnv)).toThrowError(
      /AGENTBOARD_WORKBUDDY_REGION 非法/,
    );
  });
});

describe('provider 实际请求的 host', () => {
  function captureProvider(region: WorkbuddyRegion): { urls: string[]; provider: ReturnType<typeof createCheckinProviders>['workbuddy_desktop'] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: { active: false, checkedInToday: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const provider = createCheckinProviders({ fetchImpl, region }).workbuddy_desktop;
    return { urls, provider };
  }

  it('region=cn → 请求 www.codebuddy.cn（不再请求 api.workbuddy.cn）', async () => {
    const { urls, provider } = captureProvider('cn');
    await provider!.queryStatus({ credential: Buffer.from('token'), accountId: 'a1' } as never);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('https://www.codebuddy.cn/'))).toBe(true);
    expect(urls.some((url) => url.includes('api.workbuddy.cn'))).toBe(false);
  });

  it('region=global → 请求 www.workbuddy.cn', async () => {
    const { urls, provider } = captureProvider('global');
    await provider!.queryStatus({ credential: Buffer.from('token'), accountId: 'a1' } as never);
    expect(urls.every((url) => url.startsWith('https://www.workbuddy.cn/'))).toBe(true);
  });

  it('region=unknown → 装配期就报错（fail-fast，不落到任何 host）', () => {
    // 区域在 createWorkbuddyCheckinProvider 构造时解析 origin，非法区域不会走到任何 HTTP
    expect(() => createCheckinProviders({ region: 'unknown' })).toThrowError(/CHECKIN_REGION_UNSUPPORTED|不支持该区域/);
  });
});
