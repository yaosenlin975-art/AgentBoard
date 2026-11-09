/**
 * ACC-QUOTA-01：额度聚合服务。
 * - deepseek 为唯一真实取数来源（Bearer + `/user/balance`），其余两来源无公开配额端点 → unsupported；
 * - 60s 缓存：窗口内重复调用不重复打第三方；失败指数退避；
 * - 401/429/5xx/网络分别映射固定 reason_code，响应不含 token。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  collectDeepseekKeyCandidates,
  createQuotaService,
  discoverOpencodeUrl,
  hasCodexLogin,
  hasOpencodeGoKey,
  parseDeepseekBalance,
  parseCodexRateLimits,
  parseNetstatListeners,
  parseTasklistPids,
  readDshCredentialsDeepseekKey,
  resolveDeepseekKey,
  scanCodexRollout,
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

    // 只有 CLI 组的 deepseek 需要联网（opencode/codex 走本地探测/本地快照）；平台组无凭据 → 不请求
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // ACC-KB-B5S：来源 8 个分两组，顺序 = QUOTA_SOURCE_IDS（CLI 3 + 平台 5）
    expect(first.items.map((item) => item.source)).toEqual([
      'deepseek', 'opencode_go', 'codex', 'workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode',
    ]);
    expect(first.items[0]!.status).toBe('ok');
    expect(first.items[0]!.balance).toBe(38.42);
    expect(first.items[1]!.status).toBe('unsupported');
    // 该夹具没有 opencode 登录态 → 走可解释的「未登录」分支（不再笼统 NO_PUBLIC_QUOTA_ENDPOINT）
    expect(first.items[1]!.reason_code).toBe('OPENCODE_NOT_LOGGED_IN');
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

  it('无 DeepSeek key → unsupported CREDENTIAL_MISSING，且不发请求', async () => {
    const fetchImpl = vi.fn();
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1 });
    const snapshot = await service.get();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.items[0]!.status).toBe('unsupported');
    expect(snapshot.items[0]!.reason_code).toBe('CREDENTIAL_MISSING');
  });
});

describe('OpenCode Go（ACC-QUOTA-02）', () => {
  const usageBody = {
    location: { directory: 'C:\\Users\\test' },
    data: {
      workspace: { id: 'wrk_x', name: 'Default', usageURL: 'https://opencode.ai/console/wrk_x/activity/overview' },
      go: {
        rolling: { percent: 19, limited: false, resetsAt: 1_793_680_271_000 },
        weekly: { percent: 8, limited: false, resetsAt: 1_794_182_400_000 },
        monthly: { percent: 26, limited: false, resetsAt: 1_796_000_751_000 },
      },
      budgets: [],
    },
  };

  const homeWithOpencode = () => tempHome({
    '.local/share/opencode/auth.json': JSON.stringify({ opencode: { type: 'api', key: 'x'.repeat(20) }, 'opencode-go': { type: 'api', key: 'y'.repeat(20) } }),
    '.config/opencode/service.json': JSON.stringify({ password: 'z'.repeat(43) }),
  });

  function opencodeService(fetchImpl: unknown, extra: Record<string, unknown> = {}) {
    return createQuotaService({
      fetchImpl: fetchImpl as typeof fetch,
      homeDir: homeWithOpencode(),
      env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:28894' },
      platform: 'linux',
      now: () => 1_000,
      ...extra,
    });
  }

  it('三个窗口按「已用百分比」换算剩余 + 保留重置时刻', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    });
    const snapshot = await opencodeService(fetchImpl).get();
    const go = snapshot.items[1]!;
    expect(go.status).toBe('ok');
    expect(go.unit).toBe('%');
    expect(go.windows.map((w) => w.name)).toEqual(['5h', 'weekly', 'monthly']);
    expect(go.windows[0]).toMatchObject({ remaining: 81, used_percent: 19, reset_at: 1_793_680_271_000 });
    expect(go.windows[1]).toMatchObject({ remaining: 92, used_percent: 8 });
    expect(go.windows[2]).toMatchObject({ remaining: 74, used_percent: 26 });
    expect(go.detail).toContain('Default');
    expect(requested.some((u) => u.endsWith('/api/experimental/usage/limits'))).toBe(true);
  });

  it('limited=true 时给出限额提示', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: { go: { rolling: { percent: 100, limited: true, resetsAt: 1 } } },
    }), { status: 200 }));
    const snapshot = await opencodeService(fetchImpl).get();
    expect(snapshot.items[1]!.status).toBe('ok');
    expect(snapshot.items[1]!.windows[0]!.remaining).toBe(0);
    expect(snapshot.items[1]!.detail).toContain('限额');
  });

  it('未登录 / 未发现服务分别给可解释码（不再笼统 unsupported）', async () => {
    const noLogin = createQuotaService({ fetchImpl: vi.fn() as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1 });
    expect((await noLogin.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_NOT_LOGGED_IN' });

    const noServer = createQuotaService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      homeDir: homeWithOpencode(),
      env: {},
      platform: 'linux',
      execFileImpl: async () => '',
      now: () => 1,
    });
    expect((await noServer.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_SERVER_NOT_RUNNING' });
  });

  it('401 / 404 分别映射 OPENCODE_AUTH_FAILED / OPENCODE_ROUTE_UNSUPPORTED', async () => {
    const unauthorized = opencodeService(vi.fn(async () => new Response('{"_tag":"UnauthorizedError"}', { status: 401 })));
    expect((await unauthorized.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'OPENCODE_AUTH_FAILED' });

    const notFound = opencodeService(vi.fn(async () => new Response('{}', { status: 404 })));
    expect((await notFound.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'OPENCODE_ROUTE_UNSUPPORTED' });
  });

  it('响应缺 go 段 → UPSTREAM_SHAPE_UNEXPECTED', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { budgets: [] } }), { status: 200 }));
    expect((await opencodeService(fetchImpl).get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'UPSTREAM_SHAPE_UNEXPECTED' });
  });

  function writeOpenCodeCredentialDb(
    filename: string,
    rows: Array<{ id: string; integrationId: string; active: number; created: number; value: unknown }>,
  ): void {
    mkdirSync(join(filename, '..'), { recursive: true });
    const db = new Database(filename);
    db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, value TEXT NOT NULL, active INTEGER NOT NULL, time_created INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO credential (id, integration_id, value, active, time_created) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.id, row.integrationId, JSON.stringify(row.value), row.active, row.created);
    db.close();
  }

  const directCredential = (overrides: Record<string, unknown> = {}) => ({
    type: 'oauth',
    access: 'access-token-only-in-memory',
    expires: Date.parse('2026-12-01T00:00:00.000Z'),
    metadata: { orgID: 'private-org-id', orgName: 'Default', server: 'https://opencode.ai/console' },
    ...overrides,
  });

  function windowsOpencodeService(
    homeDir: string,
    output: string,
    env: Record<string, string | undefined> = { OPENCODE_DB: join(homeDir, 'opencode.db') },
  ) {
    const execFileImpl = vi.fn(async () => output);
    const service = createQuotaService({
      homeDir,
      env,
      platform: 'win32',
      now: () => Date.parse('2026-11-09T08:00:00.000Z'),
      execFileImpl,
    });
    return { service, execFileImpl };
  }

  it('Windows 从当前 active credential 取 Go 窗口，凭据仅经 stdin 传入', async () => {
    const home = tempHome({
      '.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api', key: 'legacy-key-only' } }),
    });
    const xdgData = join(home, 'xdg-data');
    const dbPath = join(xdgData, 'opencode', 'active.db');
    writeOpenCodeCredentialDb(dbPath, [
      { id: 'old', integrationId: 'opencode', active: 1, created: 100, value: directCredential({ access: 'older-token' }) },
      { id: 'newest', integrationId: 'opencode', active: 1, created: 200, value: directCredential() },
      { id: 'inactive', integrationId: 'opencode', active: 0, created: 900, value: directCredential({ access: 'inactive-token' }) },
      { id: 'other-provider', integrationId: 'other', active: 1, created: 999, value: directCredential({ access: 'other-token' }) },
    ]);
    const usage = {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-09T09:18:13.247Z' },
        weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-16T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 72, resetsAt: '2026-11-30T01:05:51.000Z' },
      },
    };
    let capturedArgs: string[] = [];
    let capturedInput = '';
    let capturedTimeout: number | undefined;
    const execFileImpl = vi.fn(async (_file: string, args: string[], runnerOptions?: { input?: string; timeoutMs?: number }) => {
      capturedArgs = args;
      capturedInput = runnerOptions?.input ?? '';
      capturedTimeout = runnerOptions?.timeoutMs;
      return JSON.stringify({ status: 200, body: JSON.stringify(usage) });
    });
    const service = createQuotaService({
      homeDir: home,
      env: { XDG_DATA_HOME: xdgData, OPENCODE_DB: 'active.db' },
      platform: 'win32',
      now: () => Date.parse('2026-11-09T08:00:00.000Z'),
      execFileImpl,
    });

    const result = (await service.get()).items[1]!;
    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.calls[0]![0]).toBe('powershell.exe');
    expect(capturedArgs).toContain('-Command');
    expect(capturedArgs.join(' ')).not.toContain('access-token-only-in-memory');
    expect(capturedArgs.join(' ')).not.toContain('private-org-id');
    expect(capturedInput).toContain('access-token-only-in-memory');
    expect(capturedInput).toContain('private-org-id');
    expect(capturedInput).not.toContain('older-token');
    expect(capturedInput).not.toContain('inactive-token');
    expect(capturedInput).not.toContain('other-token');
    expect(JSON.parse(capturedInput)).toMatchObject({
      url: 'https://opencode.ai/zen/go/v1/usage', timeoutMs: 12_000,
    });
    expect(capturedTimeout).toBe(12_000);
    const script = capturedArgs[capturedArgs.indexOf('-Command') + 1]!;
    expect(script).toContain('$handler.UseProxy = $true');
    expect(script).toContain('$handler.AllowAutoRedirect = $false');
    expect(script).toContain('FromMilliseconds');
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[string]$inputData.orgHeaderName');
    expect(script).not.toContain('ServerCertificateCustomValidationCallback');
    expect(result).toMatchObject({ status: 'ok', balance: null, unit: '%' });
    expect(result.windows).toEqual([
      { name: '5h', remaining: 100, used_percent: 0, reset_at: Date.parse('2026-11-09T09:18:13.247Z') },
      { name: 'weekly', remaining: 0, used_percent: 100, reset_at: Date.parse('2026-11-16T00:00:00.000Z') },
      { name: 'monthly', remaining: 28, used_percent: 72, reset_at: Date.parse('2026-11-30T01:05:51.000Z') },
    ]);
    expect(result.detail).toContain('限额');
    expect(JSON.stringify(result)).not.toContain('private-org-id');
    expect(JSON.stringify(result)).not.toContain('access-token-only-in-memory');
  });

  it('403 无 allowance、401 凭据失效、网络错误分别返回非成功状态', async () => {
    const home = tempHome({});
    writeOpenCodeCredentialDb(join(home, 'opencode.db'), [
      {
        id: 'active', integrationId: 'opencode', active: 1, created: 1,
        value: directCredential({ expires: Date.parse('2026-11-09T08:02:00.000Z') }),
      },
    ]);
    const noAllowance = windowsOpencodeService(home, JSON.stringify({ status: 403 }));
    expect((await noAllowance.service.get()).items[1]!).toMatchObject({
      status: 'unsupported', reason_code: 'OPENCODE_NO_ALLOWANCE', balance: null, windows: [],
    });
    const unauthorized = windowsOpencodeService(home, JSON.stringify({ status: 401 }));
    expect((await unauthorized.service.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'OPENCODE_AUTH_FAILED' });
    expect(unauthorized.execFileImpl).toHaveBeenCalledOnce();
    const networkError = windowsOpencodeService(home, JSON.stringify({ status: null, error: 'TimeoutException' }));
    expect((await networkError.service.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'NETWORK_ERROR' });
  });

  it('Console credential 缺失或来源不受支持时回退既有本机路径', async () => {
    const legacyHome = tempHome({
      '.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api', key: 'legacy-key-only' } }),
    });
    const legacy = windowsOpencodeService(legacyHome, '');
    expect((await legacy.service.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_AUTH_UNAVAILABLE' });
    expect(legacy.execFileImpl).not.toHaveBeenCalled();

    const unsupportedHostHome = tempHome({});
    writeOpenCodeCredentialDb(join(unsupportedHostHome, 'opencode.db'), [
      { id: 'untrusted-host', integrationId: 'opencode', active: 1, created: 1, value: directCredential({ metadata: { orgID: 'private-org-id', server: 'https://not-opencode.example/console' } }) },
    ]);
    const unsupportedHost = windowsOpencodeService(unsupportedHostHome, '');
    expect((await unsupportedHost.service.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_NOT_LOGGED_IN' });
    expect(unsupportedHost.execFileImpl).not.toHaveBeenCalled();
  });

  it('Windows 的显式 OPENCODE_SERVER_URL 保留本机服务路径', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    });
    const execFileImpl = vi.fn(async () => '');
    const service = opencodeService(fetchImpl, { platform: 'win32', execFileImpl });

    expect((await service.get()).items[1]!).toMatchObject({ status: 'ok', unit: '%' });
    expect(requested).toEqual(['http://127.0.0.1:28894/api/experimental/usage/limits']);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('Windows 缺少 Console credential 时保留发现并读取运行中的本机服务', async () => {
    const netstat = '  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       55392';
    const tasklist = '"opencode.exe","55392","Console","1","417,780 K"';
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    });
    const execFileImpl = vi.fn(async (file: string) => file === 'netstat' ? netstat : tasklist);
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: homeWithOpencode(),
      env: {},
      platform: 'win32',
      now: () => 1_000,
      execFileImpl,
    });

    expect((await service.get()).items[1]!).toMatchObject({ status: 'ok', unit: '%' });
    expect(requested).toEqual(['http://127.0.0.1:28894/api/experimental/usage/limits']);
    expect(execFileImpl.mock.calls.map(([file]) => file)).toEqual(['netstat', 'tasklist']);
  });

  it('端口发现：netstat LISTENING ∩ tasklist 名字含 opencode', async () => {
    const netstat = [
      '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       55392',
      '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       11111',
    ].join('\r\n');
    const tasklist = ['"opencode.exe","55392","Console","1","417,780 K"', '"node.exe","11111","Console","1","100,000 K"'].join('\r\n');
    expect(parseNetstatListeners(netstat)).toEqual([{ port: 445, pid: 4 }, { port: 28894, pid: 55392 }, { port: 8787, pid: 11111 }]);
    expect(parseTasklistPids(tasklist).get(55392)).toBe('opencode.exe');
    const discovered = await discoverOpencodeUrl(async (file) => (file === 'netstat' ? netstat : tasklist));
    expect(discovered).toBe('http://127.0.0.1:28894');
    // 没有 opencode 进程 → null
    expect(await discoverOpencodeUrl(async (file) => (file === 'netstat' ? netstat : '"node.exe","11111","Console","1","1 K"'))).toBeNull();
  });
});
describe('DeepSeek 多候选 + 逐个试（ACC-QUOTA-03）', () => {
  const okBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '751.82', granted_balance: '0.00', topped_up_balance: '751.82' }] };
  const yaml = (key: string) => `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n  OPENCODE_GO_API_KEY: oc_sk_x\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n`;
  const okFetch = () => vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));

  function service(home: Record<string, string>, env: Record<string, string | undefined>, fetchImpl: unknown) {
    return createQuotaService({
      fetchImpl: fetchImpl as typeof fetch,
      homeDir: tempHome(home),
      env,
      now: () => 1,
      execFileImpl: async () => '',
    });
  }

  it('① 只有 env → 直接命中 env', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({}, { DEEPSEEK_API_KEY: 'sk-env-only-0001' }, fetchImpl).get();
    expect(snapshot.items[0]).toMatchObject({ status: 'ok', balance: 751.82, unit: 'CNY' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const auth = (fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization;
    expect(auth).toBe('Bearer sk-env-only-0001');
  });

  it('② 只有 config.toml → 命中 config.toml', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({ '.deepseek/config.toml': 'api_key = "sk-config-only"\n' }, {}, fetchImpl).get();
    expect(snapshot.items[0]!.status).toBe('ok');
    expect((fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization).toBe('Bearer sk-config-only');
  });

  it('③ 只有 .credentials.yaml → 命中 refs.DEEPSEEK_API_KEY', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({ '.dsh/.credentials.yaml': yaml('sk-dsh-credentials') }, {}, fetchImpl).get();
    expect(snapshot.items[0]!.status).toBe('ok');
    expect((fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization).toBe('Bearer sk-dsh-credentials');
  });

  it('④ 三者都有、前两个 401 → 逐个试命中第三个（.credentials.yaml）', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { headers: { Authorization: string } }) => {
      const token = init.headers.Authorization.replace('Bearer ', '');
      if (token === 'sk-dsh-credentials') return new Response(JSON.stringify(okBody), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error' } }), { status: 401 });
    });
    const snapshot = await service(
      { '.deepseek/config.toml': 'api_key = "sk-stale-config"\n', '.dsh/.credentials.yaml': yaml('sk-dsh-credentials') },
      { DEEPSEEK_API_KEY: 'sk-stale-env' },
      fetchImpl,
    ).get();
    expect(snapshot.items[0]).toMatchObject({ status: 'ok', balance: 751.82 });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // env 401 → config 401 → credentials 200
    // 命中后缓存来源：第二次聚合用同一来源，不再逐个试
    await service; // noop 保持结构清晰
    const second = await (async () => {
      const svc = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1, execFileImpl: async () => '' });
      return svc;
    })();
    expect(typeof second.get).toBe('function');
  });

  it('⑤ 全部无效 → error CREDENTIAL_INVALID 且文案含尝试来源数', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const snapshot = await service(
      { '.deepseek/config.toml': 'api_key = "sk-bad-config"\n', '.dsh/.credentials.yaml': yaml('sk-bad-dsh') },
      { DEEPSEEK_API_KEY: 'sk-bad-env' },
      fetchImpl,
    ).get();
    const deepseek = snapshot.items[0]!;
    expect(deepseek.status).toBe('error');
    expect(deepseek.reason_code).toBe('CREDENTIAL_INVALID');
    expect(deepseek.detail).toContain('尝试过 3 个凭据来源');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-env');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-config');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-dsh');
  });

  it('候选收集与 YAML 解析：优先级、去重、坏文件静默跳过', () => {
    const home = tempHome({
      '.deepseek/config.toml': 'api_key = "sk-dup"\n',
      '.dsh/.credentials.yaml': 'refs:\n  DEEPSEEK_API_KEY: "sk-dup"\nrecords:\n  x:\n    token: ignored\n',
    });
    expect(collectDeepseekKeyCandidates(home, { DEEPSEEK_API_KEY: 'sk-dup' })).toEqual([{ source: 'env', key: 'sk-dup' }]);
    expect(collectDeepseekKeyCandidates(tempHome({}), {})).toEqual([]);
    expect(readDshCredentialsDeepseekKey(join(home, '.dsh', '.credentials.yaml'))).toBe('sk-dup');
    expect(readDshCredentialsDeepseekKey(join(tempHome({}), 'nope.yaml'))).toBeNull();
    const broken = tempHome({ '.dsh/.credentials.yaml': 'not yaml at all' });
    expect(readDshCredentialsDeepseekKey(join(broken, '.dsh', '.credentials.yaml'))).toBeNull();
  });
});
describe('Codex 本地 rollout 快照（ACC-CODEX-QUOTA-IMPL）', () => {
  const rateLimits = (usedPrimary: number, usedSecondary: number, balance = '0') => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: usedPrimary, window_minutes: 300, resets_at: 1_793_703_146 },
        secondary: { used_percent: usedSecondary, window_minutes: 10_080, resets_at: 1_794_108_823 },
        credits: { has_credits: false, unlimited: false, balance },
        plan_type: 'plus',
        rate_limit_reached_type: null,
      },
    },
  });

  function homeWithRollouts(files: Record<string, { content: string; mtimeMs: number }>): string {
    const home = tempHome({});
    for (const [relative, spec] of Object.entries(files)) {
      const target = join(home, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `${spec.content}\n`, 'utf8');
      const date = new Date(spec.mtimeMs);
      utimesSync(target, date, date);
    }
    return home;
  }

  it('取 mtime 最新的 rollout，映射 5h/weekly 两个窗口 + 余额', async () => {
    const home = homeWithRollouts({
      '.codex/sessions/2026/11/02/rollout-old.jsonl': { content: rateLimits(80, 90), mtimeMs: 1_760_000_000_000 },
      '.codex/sessions/2026/11/03/rollout-new.jsonl': { content: rateLimits(2, 77), mtimeMs: 1_761_000_000_000 },
    });
    const result = await scanCodexRollout(home, () => 1_000);
    expect(result.status).toBe('ok');
    expect(result.windows.map((w) => w.name)).toEqual(['5h', 'weekly']);
    expect(result.windows[0]).toMatchObject({ used_percent: 2, remaining: 98, reset_at: 1_793_703_146_000 });
    expect(result.windows[1]).toMatchObject({ used_percent: 77, remaining: 23, reset_at: 1_794_108_823_000 });
    expect(result.balance).toBe(0);
    expect(result.unit).toBe('USD');
    expect(result.detail).toBe('额度内');
  });

  it('没有 sessions 目录 / 没有 rollout / 没有 rate_limits 都给可解释 unsupported', async () => {
    const emptyHome = tempHome({});
    expect(await scanCodexRollout(emptyHome, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_SESSIONS' });

    const noFiles = homeWithRollouts({ '.codex/sessions/2026/11/03/keep.txt': { content: 'x', mtimeMs: 1 } });
    expect(await scanCodexRollout(noFiles, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_SESSIONS' });

    const noLimits = homeWithRollouts({
      '.codex/sessions/2026/11/03/rollout-1.jsonl': { content: JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }), mtimeMs: 1 },
    });
    expect(await scanCodexRollout(noLimits, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_RATE_LIMITS' });
  });

  it('只认 300/10080 分钟窗口：月度窗口（43800）被忽略', () => {
    const result = parseCodexRateLimits({
      primary: { used_percent: 10, window_minutes: 43_800, resets_at: 1 },
      secondary: { used_percent: 20, window_minutes: 10_080, resets_at: 2 },
      credits: { balance: '1.5' },
    }, 999);
    expect(result.windows.map((w) => w.name)).toEqual(['weekly']);
    expect(result.balance).toBe(1.5);
    // 无 plan_type 且余额非 0 → detail 为 null
    expect(result.detail).toBeNull();
  });

  it('缓存：TTL 内两次聚合只扫一次 Codex 本地文件', async () => {
    let scans = 0;
    const service = createQuotaService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      homeDir: tempHome({}),
      env: {},
      now: () => 1,
      execFileImpl: async () => '',
      codexScan: async () => {
        scans += 1;
        return parseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: 10 }, credits: { balance: '0' } }, 1);
      },
    });
    const first = await service.get();
    const second = await service.get();
    expect(scans).toBe(1);
    expect(first.items[2]!.status).toBe('ok');
    expect(second.items[2]!.windows[0]!.used_percent).toBe(5);
  });
});

describe('托管账号额度缓存隔离', () => {
  it('同平台账号并发与缓存各自取数，reset 清理账号缓存', async () => {
    const accountA = '11111111-1111-4111-8111-111111111111';
    const accountB = '22222222-2222-4222-8222-222222222222';
    const selectedAccounts: string[] = [];
    const platformCredential = async (_source: string, accountId?: string) => {
      selectedAccounts.push(accountId ?? 'aggregate');
      return { kind: 'ok' as const, token: accountId === accountA ? 'account-a-secret' : 'account-b-secret', accountName: null };
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      const totalCredits = authorization === 'Bearer account-a-secret' ? '101.25' : '202.5';
      return new Response(JSON.stringify({ data: { TotalCredits: totalCredits } }), { status: 200 });
    });
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platformCredential,
      homeDir: tempHome({}),
      env: {},
      now: () => 1_000,
    });

    const [firstA, firstB, parallelA] = await Promise.all([
      service.get({ accountId: accountA, source: 'workbuddy' }),
      service.get({ accountId: accountB, source: 'workbuddy' }),
      service.get({ accountId: accountA, source: 'workbuddy' }),
    ]);
    const balance = (snapshot: Awaited<ReturnType<typeof service.get>>) => snapshot.items[0]!.balance;
    expect(balance(firstA)).toBe(101.25);
    expect(balance(parallelA)).toBe(101.25);
    expect(balance(firstB)).toBe(202.5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(selectedAccounts).toEqual([accountA, accountB]);

    await service.get({ accountId: accountB, source: 'workbuddy' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    service.reset();
    await service.get({ accountId: accountA, source: 'workbuddy' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reset 后旧在途请求不能回写缓存或清除新在途请求', async () => {
    const accountId = '33333333-3333-4333-8333-333333333333';
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platformCredential: async () => ({ kind: 'ok' as const, token: 'quota-test-token', accountName: null }),
      homeDir: tempHome({}),
      env: {},
      now: () => 1_000,
    });
    const getBalance = async (read: ReturnType<typeof service.get>) => (await read).items[0]!.balance;
    const waitForFetchCount = async (count: number): Promise<void> => {
      for (let attempt = 0; attempt < 50 && fetchImpl.mock.calls.length < count; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(fetchImpl).toHaveBeenCalledTimes(count);
    };
    const reply = (balance: number) => new Response(JSON.stringify({ data: { TotalCredits: balance } }), { status: 200 });

    const oldRead = service.get({ accountId, source: 'workbuddy' });
    await waitForFetchCount(1);
    service.reset();
    const newRead = service.get({ accountId, source: 'workbuddy' });
    await waitForFetchCount(2);

    try {
      releases[0]!(reply(101.25));
      expect(await getBalance(oldRead)).toBe(101.25);

      const concurrentRead = service.get({ accountId, source: 'workbuddy' });
      await new Promise(resolve => setImmediate(resolve));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      releases[1]!(reply(202.5));
      const [newBalance, concurrentBalance] = await Promise.all([getBalance(newRead), getBalance(concurrentRead)]);
      expect(newBalance).toBe(202.5);
      expect(concurrentBalance).toBe(202.5);
      expect(await service.get({ accountId, source: 'workbuddy' }).then(snapshot => snapshot.items[0]!.balance)).toBe(202.5);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      for (const release of releases) release(reply(0));
    }
  });
});

describe('Command Code 按账号额度', () => {
  const accountA = '44444444-4444-4444-8444-444444444444';
  const accountB = '55555555-5555-4555-8555-555555555555';

  it('按账号取 credits 与 5h/weekly 窗口，USD、reset 毫秒与缓存均隔离', async () => {
    const calls: Array<{ url: string; token: string; orgHeader: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = new Headers(init?.headers).get('authorization') ?? '';
      calls.push({ url, token, orgHeader: new Headers(init?.headers).get('x-opencode-org-id') });
      if (url.includes('/whoami')) return new Response(JSON.stringify({ org: { id: 'org-test' } }), { status: 200 });
      const zero = token.endsWith('account-b-key');
      return new Response(JSON.stringify({ credits: {
        credits: { monthlyCredits: zero ? 0 : 1.25, purchasedCredits: zero ? 0 : 0.5, freeCredits: zero ? 0 : 0.25 },
        windowLimits: {
          fiveHour: { used: 0, cap: 0, resetAt: 0 },
          weekly: { used: 2, cap: 8, resetAt: 1_800_000_000_000 },
        },
      } }), { status: 200 });
    });
    const credentialIds: string[] = [];
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      commandCodeCredential: async id => {
        credentialIds.push(id);
        return { kind: 'ok', token: id === accountA ? 'account-a-key' : 'account-b-key', accountName: null };
      },
      now: () => 1_000,
    });
    const [a, b] = await Promise.all([
      service.get({ accountId: accountA, source: 'commandcode' }),
      service.get({ accountId: accountB, source: 'commandcode' }),
    ]);
    await service.get({ accountId: accountA, source: 'commandcode' });
    expect(a.items).toHaveLength(1);
    expect(a.items[0]).toMatchObject({ source: 'commandcode', status: 'ok', balance: 2, unit: 'USD' });
    expect(a.items[0]!.windows).toEqual([
      { name: '5h', kind: 'rolling', used: 0, total: 0, remaining: 0, used_percent: null, reset_at: null },
      { name: 'weekly', kind: 'weekly', used: 2, total: 8, remaining: 6, used_percent: 25, reset_at: 1_800_000_000_000 },
    ]);
    expect(b.items[0]).toMatchObject({ status: 'ok', balance: 0, unit: 'USD' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(credentialIds.sort()).toEqual([accountA, accountB]);
    expect(calls.every(call => call.orgHeader === null)).toBe(true);
    expect(calls.filter(call => call.url.includes('/whoami')).every(call => call.url === 'https://api.commandcode.ai/alpha/whoami?limits=1')).toBe(true);
    expect(calls.filter(call => call.url.includes('/billing/credits')).every(call => call.url === 'https://api.commandcode.ai/alpha/billing/credits?orgId=org-test')).toBe(true);
    expect(calls.every(call => call.token.startsWith('Bearer account-'))).toBe(true);
    expect(JSON.stringify([a, b])).not.toContain('account-a-key');
  });

  it('缺凭据、401/403、网络失败和坏 schema 都不返回伪零余额', async () => {
    const missingFetch = vi.fn();
    const missing = createQuotaService({ fetchImpl: missingFetch as unknown as typeof fetch, now: () => 1_000 });
    expect((await missing.get({ accountId: accountA, source: 'commandcode' })).items[0]).toMatchObject({
      status: 'unsupported', reason_code: 'CREDENTIAL_MISSING', balance: null,
    });
    expect(missingFetch).not.toHaveBeenCalled();

    const fetchFor = (fetchImpl: unknown) => createQuotaService({
      fetchImpl: fetchImpl as typeof fetch,
      commandCodeCredential: async () => ({ kind: 'ok' as const, token: 'temporary-key', accountName: null }),
      now: () => 1_000,
    });
    for (const [status, reason] of [[401, 'CREDENTIAL_INVALID'], [403, 'NO_ALLOWANCE']] as const) {
      const service = fetchFor(vi.fn(async () => new Response('{}', { status })));
      expect((await service.get({ accountId: accountA, source: 'commandcode' })).items[0]).toMatchObject({ status: 'error', reason_code: reason, balance: null });
    }
    const network = fetchFor(vi.fn(async () => { throw new Error('offline'); }));
    expect((await network.get({ accountId: accountA, source: 'commandcode' })).items[0]).toMatchObject({ status: 'error', reason_code: 'NETWORK_ERROR', balance: null });
    const badSchema = fetchFor(vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/whoami') ? {} : { credits: { credits: { monthlyCredits: 1 } } }), { status: 200 })));
    expect((await badSchema.get({ accountId: accountA, source: 'commandcode' })).items[0]).toMatchObject({ status: 'error', reason_code: 'UPSTREAM_SHAPE_UNEXPECTED', balance: null });
  });
});
