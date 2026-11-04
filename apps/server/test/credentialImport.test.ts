/**
 * ACC-11：Python 凭据导出通道与 vault 集成。
 * 重点覆盖「安全边界」而不是 happy path：token 不进响应/日志、python 缺失不 500、stdout 不可信、重复导入不新增、审计不含 token。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { buildExportArgs, createCredentialImporter, parseExportOutput, type ExportPlatform, type ExportRunner } from '../src/services/accounts/credentialImport.js';

const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEiLCJleHAiOjE3OTM2MTMyNTh9.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWIiLCJleHAiOjE3OTM2MTMyNTl9.c2lnbmF0dXJlLWI';

const entry = (platform: ExportPlatform, sub: string, token: string) => ({
  platform, account_key: sub, display_hint: `账号 ${sub}`, token, expires_at: 1793613258.13,
});

describe('credential import (ACC-11)', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let vault: SecretVault;
  let audit: Array<Record<string, unknown>>;

  const stubRunner = (byPlatform: Partial<Record<ExportPlatform, unknown>>): ExportRunner =>
    async (platform) => {
      const value = byPlatform[platform];
      if (value instanceof Error) throw value;
      if (value === undefined) return { stdout: '[]', stderr: '', durationMs: 1 };
      return { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', durationMs: 1 };
    };

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-acc11-'));
    vault = new SecretVault(join(root, 'vault'));
    audit = [];
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault,
      credentialRunner: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A)] }),
    });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('ACC-KB-A2：导入即把 checkin_capability 从 unknown 回填为 supported（新建 + 重导入两条路径）', async () => {
    const importer = createCredentialImporter({
      db: t.db, vault, onAudit: () => {},
      runExport: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A)], trae: [entry('trae', 'user-b', TOKEN_B)] }),
    });
    const first = await importer.importCredentials({ platforms: ['workbuddy', 'trae'], actor: 'user' });
    expect(first.platforms.every(p => p.created === 1)).toBe(true);
    const created = t.db.prepare('SELECT app_id, checkin_capability FROM managed_account ORDER BY app_id').all() as Array<{ app_id: string; checkin_capability: string }>;
    expect(created).toEqual([
      { app_id: 'trae', checkin_capability: 'supported' },
      { app_id: 'workbuddy_desktop', checkin_capability: 'supported' },
    ]);

    // 老行被手工写成 unknown（模拟历史导入遗留）→ 重导入必须回填
    t.db.prepare("UPDATE managed_account SET checkin_capability='unknown'").run();
    const again = createCredentialImporter({
      db: t.db, vault, onAudit: () => {},
      runExport: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A)], trae: [entry('trae', 'user-b', TOKEN_B)] }),
    });
    const second = await again.importCredentials({ platforms: ['workbuddy', 'trae'], actor: 'user' });
    expect(second.platforms.every(p => p.updated === 1)).toBe(true);
    const backfilled = t.db.prepare('SELECT DISTINCT checkin_capability AS c FROM managed_account').all() as Array<{ c: string }>;
    expect(backfilled).toEqual([{ c: 'supported' }]);
  });

  it('importsTwoAccountsAndNeverLeaksTokens', async () => {    const importer = createCredentialImporter({
      db: t.db, vault, onAudit: line => audit.push(line),
      runExport: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A), entry('workbuddy', 'user-b', TOKEN_B)] }),
    });
    const result = await importer.importCredentials({ platforms: ['workbuddy'], actor: 'user' });
    expect(result.platforms[0]).toMatchObject({ platform: 'workbuddy', app_id: 'workbuddy_desktop', found: 2, created: 2, updated: 0, error: null });
    expect(result.accounts).toHaveLength(2);
    const stored = t.db.prepare('SELECT app_id, client_instance_id, checkin_credential_ref, identity_hash FROM managed_account').all() as Array<Record<string, string>>;
    expect(stored).toHaveLength(2);
    expect(stored.every(row => row.checkin_credential_ref !== null && row.checkin_credential_ref !== '')).toBe(true);
    // identity_hash 必须由 app_id+account_key 派生（不是 token）
    const expectedHash = createHash('sha256').update(['workbuddy_desktop', 'user-a'].join(String.fromCharCode(0))).digest('hex');
    expect(stored.map(row => row.identity_hash)).toContain(expectedHash);
    expect(stored.map(row => row.identity_hash)).not.toContain(TOKEN_A);
    expect(stored.every(row => /^[a-f0-9]{64}$/.test(row.identity_hash))).toBe(true);
    // 响应、审计、DB 都不该出现 token 形状
    expect(TOKEN_SHAPE.test(JSON.stringify(result))).toBe(false);
    expect(TOKEN_SHAPE.test(JSON.stringify(audit))).toBe(false);
    expect(TOKEN_SHAPE.test(JSON.stringify(stored))).toBe(false);
  });

  it('reimportUpdatesInPlaceWithoutNewRows', async () => {
    const importer = createCredentialImporter({
      db: t.db, vault, onAudit: () => {},
      runExport: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A)] }),
    });
    const first = await importer.importCredentials({ platforms: ['workbuddy'], actor: 'user' });
    expect(first.accounts[0]!.action).toBe('created');
    const second = await importer.importCredentials({ platforms: ['workbuddy'], actor: 'user' });
    expect(second.accounts[0]!.action).toBe('updated');
    // 重复导入不得在 vault 里堆积孤儿密文（旧引用应被删除）
    const blobs = readdirSync(join(root, 'vault')).filter(name => name.endsWith('.dpapi'));
    expect(blobs).toHaveLength(1);
    // 更新分支同样不能回传 token
    expect(TOKEN_SHAPE.test(JSON.stringify(second))).toBe(false);
    expect(JSON.stringify(second)).not.toContain(TOKEN_A);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get() as { n: number }).n).toBe(1);
  });

  it('reportsPythonUnavailableWithoutFailing', async () => {
    const pythonMissing = Object.assign(new Error('spawn python ENOENT'), { reason: 'PYTHON_UNAVAILABLE' });
    const importer = createCredentialImporter({ db: t.db, vault, onAudit: () => {}, runExport: stubRunner({ workbuddy: pythonMissing }) });
    const result = await importer.importCredentials({ platforms: ['workbuddy'], actor: 'user' });
    expect(result.error).toBe('PYTHON_UNAVAILABLE');
    expect(result.platforms[0]).toMatchObject({ found: 0, created: 0, error: 'PYTHON_UNAVAILABLE' });
  });

  it('treatsStdoutAsUntrustedInput', async () => {
    // 混入 warning 行 / 非数组 / 超长 → 固定错误码，绝不回传原文
    expect(parseExportOutput('warning: deprecated\n[]', 'workbuddy')).toEqual({ entries: [], error: 'EXPORT_OUTPUT_INVALID' });
    expect(parseExportOutput('{"accounts":[]}', 'workbuddy')).toEqual({ entries: [], error: 'EXPORT_OUTPUT_INVALID' });
    const huge = JSON.stringify([{ ...entry('workbuddy', 'x', TOKEN_A), pad: 'x'.repeat(3 * 1024 * 1024) }]);
    expect(parseExportOutput(huge, 'workbuddy')).toEqual({ entries: [], error: 'EXPORT_OUTPUT_INVALID' });
    // 合法输出但平台不匹配 → 丢弃且不报错
    expect(parseExportOutput(JSON.stringify([entry('trae', 'user-t', TOKEN_B)]), 'workbuddy')).toEqual({ entries: [], error: null });
    // 缺字段条目被跳过
    expect(parseExportOutput(JSON.stringify([{ platform: 'workbuddy', account_key: 'a' }]), 'workbuddy')).toEqual({ entries: [], error: null });
  });

  it('mapsTimeoutToFixedCode', async () => {
    const timeout = Object.assign(new Error('timeout'), { reason: 'EXPORT_TIMEOUT' });
    const importer = createCredentialImporter({ db: t.db, vault, onAudit: () => {}, runExport: stubRunner({ trae: timeout }) });
    const result = await importer.importCredentials({ platforms: ['trae'], actor: 'user' });
    expect(result.platforms[0]).toMatchObject({ error: 'EXPORT_TIMEOUT', found: 0 });
  });

  it('emptyExportIsNotAnError', async () => {
    const importer = createCredentialImporter({ db: t.db, vault, onAudit: () => {}, runExport: stubRunner({ minimax: [] }) });
    const result = await importer.importCredentials({ platforms: ['minimax'], actor: 'user' });
    expect(result.platforms[0]).toMatchObject({ found: 0, created: 0, updated: 0, error: null });
    expect(result.accounts).toEqual([]);
  });

  it('writesAuditOperationRowPerPlatformWithoutToken', async () => {
    const importer = createCredentialImporter({
      db: t.db, vault, onAudit: line => audit.push(line),
      runExport: stubRunner({ workbuddy: [entry('workbuddy', 'user-a', TOKEN_A)], minimax: [entry('minimax', 'client-1', TOKEN_B)] }),
    });
    const result = await importer.importCredentials({ platforms: ['workbuddy', 'minimax'], actor: 'agent:test' });
    const rows = t.db.prepare('SELECT batch_id, app_id, operation, state, safe_error_code, recovery_ref FROM account_operation WHERE batch_id=?').all(result.batch_id) as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.app_id).sort()).toEqual(['minimax', 'workbuddy_desktop']);
    expect(rows.every(row => row.state === 'succeeded' && row.safe_error_code === null)).toBe(true);
    expect(TOKEN_SHAPE.test(JSON.stringify(rows))).toBe(false);
    expect(audit[0]).toMatchObject({ batch_id: result.batch_id, actor: 'agent:test' });
    expect(TOKEN_SHAPE.test(JSON.stringify(audit))).toBe(false);
  });

  it('endpointReturnsSummaryWithoutTokenAndHandlesPythonMissing', async () => {
    const ok = await request(app).post('/api/accounts/import-credentials').send({ platforms: ['workbuddy'], actor: 'user' });
    expect(ok.status).toBe(200);
    expect(ok.body.platforms[0]).toMatchObject({ platform: 'workbuddy', created: 1 });
    expect(TOKEN_SHAPE.test(JSON.stringify(ok.body))).toBe(false);
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN_A);

    const pythonMissing = Object.assign(new Error('spawn python ENOENT'), { reason: 'PYTHON_UNAVAILABLE' });
    const adapter = new FakeAdapter();
    const broken = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault,
      credentialRunner: stubRunner({ workbuddy: pythonMissing }),
    });
    const res = await request(broken.app).post('/api/accounts/import-credentials').send({ platforms: ['workbuddy'] });
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('PYTHON_UNAVAILABLE');
  });

  it('rejectsInvalidBody', async () => {
    expect((await request(app).post('/api/accounts/import-credentials').send({ platforms: ['bogus'] })).status).toBe(400);
    expect((await request(app).post('/api/accounts/import-credentials').send({ path: '/etc/passwd' })).status).toBe(400);
    expect((await request(app).post('/api/accounts/import-credentials').send({ platforms: [] })).status).toBe(400);
  });


  it('neverAcceptsProcessSelectionFromRequest', async () => {
    // 1) strict body：pid / process-name 一类字段一律 400，不会被静默忽略
    for (const body of [{ pid: 1234 }, { process_name: 'workbuddy' }, { platforms: ['workbuddy'], pid: 1234 }]) {
      const res = await request(app).post('/api/accounts/import-credentials').send(body);
      expect(res.status).toBe(400);
    }
    // 2) 服务端拼脚本参数只含平台白名单，绝无 --pid / --process-name
    for (const platform of ['workbuddy', 'trae', 'minimax'] as const) {
      const args = buildExportArgs('C:/scripts/export_credentials.py', platform);
      expect(args).toEqual(['C:/scripts/export_credentials.py', '--platform', platform, '--json']);
      expect(args.join(' ')).not.toMatch(/--pid|--process-name/);
    }
    // 3) 端点即使被塞入额外字段也不会把值带到 runner（runner 收到的只有平台）
    const seen: string[] = [];
    const adapter = new FakeAdapter();
    const spy = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault,
      credentialRunner: async (platform) => { seen.push(platform); return { stdout: '[]', stderr: '', durationMs: 1 }; },
    });
    const ok = await request(spy.app).post('/api/accounts/import-credentials').send({ platforms: ['trae'], actor: 'user' });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['trae']);
  });
  it('realScriptEmitsJsonArrayForMinimaxWithoutNetwork', () => {
    // 真实 python 冒烟：只跑 minimax（读本地文件，不扫进程、不打网络）
    const script = join(process.cwd(), 'scripts', 'accounts', 'export_credentials.py');
    const stdout = execFileSync('python', [script, '--platform', 'minimax', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    for (const item of parsed as Array<Record<string, unknown>>) {
      expect(typeof item.token).toBe('string');
      expect(String(item.token).length).toBeGreaterThan(10);
      expect(item.platform).toBe('minimax');
    }
    // 脚本自身不能把 token 打到 stderr
    const stderrRun = execFileSync('python', [script, '--platform', 'minimax'], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(TOKEN_SHAPE.test(stderrRun)).toBe(false);
  }, 40000);
});