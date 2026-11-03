/**
 * ACC-QUOTA-01：额度聚合服务。
 * - deepseek 为唯一真实取数来源（Bearer + `/user/balance`），其余两来源无公开配额端点 → unsupported；
 * - 60s 缓存：窗口内重复调用不重复打第三方；失败指数退避；
 * - 401/429/5xx/网络分别映射固定 reason_code，响应不含 token。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createQuotaService,
  hasCodexLogin,
  hasOpencodeGoKey,
  parseDeepseekBalance,
  resolveDeepseekKey,
} from '../src/services/quotas/quotaService.js';

function tempHome(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'accquota-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

const balanceBody = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
    { currency: 'CNY', total_balance: '38.42', granted_balance: '10.00', topped_up_balance: '28.42' },
  ],
};

const homeWithKey = () => tempHome({ '.deepseek/config.toml': 'api_key = "sk-unit-test-key"\ndefault_text_model = "x"\n' });

describe('额度来源凭据解析（本机只读）', () => {
  it('DeepSeek key 优先环境变量，其次 ~/.deepseek/config.toml', () => {
    const home = homeWithKey();
    expect(resolveDeepseekKey(home, {})).toBe('sk-unit-test-key');
    expect(resolveDeepseekKey(home, { DEEPSEEK_API_KEY: 'sk-from-env' })).toBe('sk-from-env');
    expect(resolveDeepseekKey(tempHome({}), {})).toBeNull();
  });

  it('OpenCode Go / Codex 只检测本机痕迹，不存在时返回 false', () => {
    const empty = tempHome({});
    expect(hasOpencodeGoKey(empty)).toBe(false);
    expect(hasCodexLogin(empty)).toBe(false);
    const withAuth = tempHome({
      '.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api', key: 'x'.repeat(20) } }),
      '.codex/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(20) } }),
    });
    expect(hasOpencodeGoKey(withAuth)).toBe(true);
    expect(hasCodexLogin(withAuth)).toBe(true);
  });
});

describe('DeepSeek 余额解析', () => {
  it('优先取 CNY 的 balance_infos，余额转数字', () => {
    const result = parseDeepseekBalance(balanceBody, 1000);
    expect(result.status).toBe('ok');
    expect(result.balance).toBe(38.42);
    expect(result.unit).toBe('CNY');
    expect(result.fetched_at).toBe(1000);
  });

  it('结构不符时报固定码，不返回余额', () => {
    const result = parseDeepseekBalance({ is_available: true }, 1000);
    expect(result.status).toBe('error');
    expect(result.reason_code).toBe('UPSTREAM_SHAPE_UNEXPECTED');
    expect(result.balance).toBeNull();
  });
});

describe('聚合服务（缓存 / 错误映射 / 脱敏）', () => {
  it('60s 内重复调用只打一次第三方，且三来源逐项独立', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(balanceBody), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: homeWithKey(), now: () => 5_000 });

    const first = await service.get();
    const second = await service.get();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.items.map((item) => item.source)).toEqual(['deepseek', 'opencode_go', 'codex']);
    expect(first.items[0]!.status).toBe('ok');
    expect(first.items[0]!.balance).toBe(38.42);
    expect(first.items[1]!.status).toBe('unsupported');
    expect(first.items[1]!.reason_code).toBe('NO_PUBLIC_QUOTA_ENDPOINT');
    expect(first.items[2]!.status).toBe('unsupported');
    expect(second.items[0]!.balance).toBe(38.42);
  });

  it('缓存过期后重新取数；并发调用共用同一次请求', async () => {
    let nowValue = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(balanceBody), { status: 200 }));
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: homeWithKey(),
      now: () => nowValue,
      ttlMs: 60_000,
    });

    await Promise.all([service.get(), service.get(), service.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowValue = 60_001;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('401 → CREDENTIAL_INVALID（error，不带 token/路径）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: homeWithKey(), now: () => 1 });
    const snapshot = await service.get();
    const deepseek = snapshot.items[0]!;
    expect(deepseek.status).toBe('error');
    expect(deepseek.reason_code).toBe('CREDENTIAL_INVALID');
    expect(JSON.stringify(snapshot)).not.toContain('sk-unit-test-key');
    expect(JSON.stringify(snapshot)).not.toContain('.deepseek');
  });

  it('失败按指数退避：连续失败后短时间内不再请求', async () => {
    let nowValue = 0;
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: homeWithKey(),
      now: () => nowValue,
      ttlMs: 60_000,
    });

    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowValue = 30_000;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowValue = 61_000;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await service.get()).items[0]!.reason_code).toBe('NETWORK_ERROR');
  });

  it('无 DeepSeek key → unsupported NO_CREDENTIAL，且不发请求', async () => {
    const fetchImpl = vi.fn();
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: tempHome({}), now: () => 1 });
    const snapshot = await service.get();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.items[0]!.status).toBe('unsupported');
    expect(snapshot.items[0]!.reason_code).toBe('NO_CREDENTIAL');
  });
});
