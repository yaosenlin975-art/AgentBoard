/**
 * ACC-CLI-MULTI（口径 A）：CLI 三来源本机凭据登记。
 *
 * 断言口径（对应卡面验收）：
 * - 两个不同 DeepSeek key → 2；同一 key 出现在两个位置 → 1；
 * - OpenCode Go ≤ 1；Codex 只从 ChatGPT OAuth account ID 产出身份；
 * - 重启（关闭库再打开 + initSchema）后账号仍在；ensureTable 连跑两次结构一致、数据不丢；
 * - 响应与库行都不含 key 明文 / credential_ref；凭据只进 vault 且 purpose = cli_credential。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { openDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { migrateCliAccounts } from '../src/db/migrations/cliAccounts.js';
import {
  captureCliAccounts,
  cliIdentityHash,
  discoverCliCredentials,
  importCliCredential,
  listCliAccounts,
  parseCliCredentialText,
  type CliCredentialVault,
} from '../src/services/accounts/cliAccounts.js';
import type { VaultScope } from '../src/services/accounts/secretVault.js';

const KEY_A = 'sk-deepseek-aaaa';
const KEY_B = 'sk-deepseek-bbbb';
const KEY_OPENCODE = 'sk-opencode-go-cccc';
const CODEX_ACCOUNT_ID = 'chatgpt-account-001';

function writeDeepseekConfig(homeDir: string, key: string): void {
  mkdirSync(join(homeDir, '.deepseek'), { recursive: true });
  writeFileSync(join(homeDir, '.deepseek', 'config.toml'), `api_key = "${key}"\n`);
}

function writeDshCredentials(homeDir: string, key: string): void {
  mkdirSync(join(homeDir, '.dsh'), { recursive: true });
  writeFileSync(join(homeDir, '.dsh', '.credentials.yaml'), `refs:\n  DEEPSEEK_API_KEY: ${key}\n`);
}

function writeOpencodeAuth(homeDir: string, key: string): void {
  mkdirSync(join(homeDir, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { key } }));
}

function codexIdToken(accountId: string, signature: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function writeCodexAuth(codexHomeDir: string, auth: unknown): void {
  mkdirSync(codexHomeDir, { recursive: true });
  writeFileSync(join(codexHomeDir, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
}

function codexChatgptAuth(accountId: string, tokenVersion: string): { auth_mode: string; tokens: Record<string, string> } {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: accountId,
      id_token: codexIdToken(accountId, `signature-${tokenVersion}`),
      access_token: `access-${tokenVersion}`,
      refresh_token: `refresh-${tokenVersion}`,
    },
  };
}

function fakeVault(): { vault: CliCredentialVault; scopes: VaultScope[]; refs: string[] } {
  const scopes: VaultScope[] = [];
  const refs: string[] = [];
  const vault: CliCredentialVault = {
    protect: async (_data, scope) => {
      scopes.push(scope);
      const ref = `00000000-0000-4000-8000-${String(refs.length + 1).padStart(12, '0')}`;
      refs.push(ref);
      return ref;
    },
  };
  return { vault, scopes, refs };
}

describe('ACC-CLI-MULTI：本机凭据发现与去重', () => {
  let homeDir: string;
  let t: TestDb;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-home-'));
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('同一 DeepSeek key 出现在两个位置 → 只算 1 个账号（identity 去重）', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    writeDshCredentials(homeDir, KEY_A);
    const { vault, scopes } = fakeVault();
    const items = await captureCliAccounts({ db: t.db, vault, homeDir, env: {}, now: () => 1000 });

    expect(items).toHaveLength(1);
    expect(items[0]!.app_id).toBe('deepseek');
    expect(items[0]!.identity_hint).toBe(`sha256:${cliIdentityHash('deepseek', KEY_A).slice(0, 12)}`);
    // 凭据落 vault，purpose 与签到分离
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.purpose).toBe('cli_credential');
  });

  it('两个不同 DeepSeek key → 2 个账号；OpenCode Go 单条 key → ≤1；无 Codex OAuth 时不产账号', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    writeDshCredentials(homeDir, KEY_B);
    writeOpencodeAuth(homeDir, KEY_OPENCODE);
    const { vault } = fakeVault();
    const items = await captureCliAccounts({ db: t.db, vault, homeDir, env: {}, now: () => 2000 });

    expect(items.filter(item => item.app_id === 'deepseek')).toHaveLength(2);
    expect(items.filter(item => item.app_id === 'opencode_go')).toHaveLength(1);
    expect(items.filter(item => item.app_id === 'codex')).toHaveLength(0);
    expect(items).toHaveLength(3);
  });

  it('Codex 读取 CODEX_HOME 的稳定 account ID；token 轮换不重复登记且不进 vault', async () => {
    const codexHomeDir = join(homeDir, 'custom-codex-home');
    writeCodexAuth(codexHomeDir, codexChatgptAuth(CODEX_ACCOUNT_ID, 'first'));
    const { vault, scopes } = fakeVault();

    const first = await captureCliAccounts({ db: t.db, vault, homeDir, env: { CODEX_HOME: codexHomeDir }, now: () => 1000 });
    const firstCodex = first.filter(item => item.app_id === 'codex');
    expect(firstCodex).toHaveLength(1);
    expect(firstCodex[0]!.identity_hint).toBe(`sha256:${cliIdentityHash('codex', CODEX_ACCOUNT_ID).slice(0, 12)}`);
    const firstRow = t.db.prepare("SELECT id,identity_hash,credential_ref,created_at,last_seen_at FROM cli_account WHERE app_id='codex'").get() as Record<string, unknown>;
    expect(firstRow).toMatchObject({ identity_hash: cliIdentityHash('codex', CODEX_ACCOUNT_ID), credential_ref: null, created_at: 1000, last_seen_at: 1000 });
    expect(JSON.stringify(first)).not.toContain(CODEX_ACCOUNT_ID);
    expect(JSON.stringify(first)).not.toContain('access-first');
    expect(JSON.stringify(first)).not.toContain('refresh-first');
    expect(JSON.stringify(firstRow)).not.toContain(CODEX_ACCOUNT_ID);
    expect(scopes.filter(scope => scope.app_id === 'codex')).toEqual([]);

    writeCodexAuth(codexHomeDir, codexChatgptAuth(CODEX_ACCOUNT_ID, 'rotated'));
    const second = await captureCliAccounts({ db: t.db, vault, homeDir, env: { CODEX_HOME: codexHomeDir }, now: () => 2000 });
    const secondCodex = second.filter(item => item.app_id === 'codex');
    const secondRow = t.db.prepare("SELECT id,identity_hash,credential_ref,created_at,last_seen_at FROM cli_account WHERE app_id='codex'").get() as Record<string, unknown>;
    expect(secondCodex).toHaveLength(1);
    expect(secondCodex[0]!.id).toBe(firstCodex[0]!.id);
    expect(secondRow).toMatchObject({ id: firstRow.id, identity_hash: firstRow.identity_hash, credential_ref: null, created_at: 1000, last_seen_at: 2000 });
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM cli_account WHERE app_id='codex'").get() as { n: number }).n).toBe(1);
  });

  it('Codex rejects API-key mode, malformed auth, mismatched identity, and hides stale identity after sign-out', async () => {
    const codexHomeDir = join(homeDir, 'custom-codex-home');
    const authPath = join(codexHomeDir, 'auth.json');
    const env = { CODEX_HOME: codexHomeDir };
    writeCodexAuth(codexHomeDir, codexChatgptAuth(CODEX_ACCOUNT_ID, 'valid'));
    await captureCliAccounts({ db: t.db, homeDir, env, now: () => 1000 });

    writeCodexAuth(codexHomeDir, { ...codexChatgptAuth(CODEX_ACCOUNT_ID, 'api-key'), auth_mode: 'api_key' });
    expect((await captureCliAccounts({ db: t.db, homeDir, env, now: () => 2000 })).filter(item => item.app_id === 'codex')).toEqual([]);

    writeCodexAuth(codexHomeDir, { ...codexChatgptAuth(CODEX_ACCOUNT_ID, 'mismatch'), tokens: { ...codexChatgptAuth(CODEX_ACCOUNT_ID, 'mismatch').tokens, account_id: 'another-account' } });
    expect((await captureCliAccounts({ db: t.db, homeDir, env, now: () => 3000 })).filter(item => item.app_id === 'codex')).toEqual([]);

    writeCodexAuth(codexHomeDir, { auth_mode: 'chatgpt', tokens: { account_id: CODEX_ACCOUNT_ID, id_token: 'not-a-jwt', access_token: 'secret-access' } });
    expect((await captureCliAccounts({ db: t.db, homeDir, env, now: () => 4000 })).filter(item => item.app_id === 'codex')).toEqual([]);

    writeCodexAuth(codexHomeDir, '{ invalid json');
    expect((await captureCliAccounts({ db: t.db, homeDir, env, now: () => 5000 })).filter(item => item.app_id === 'codex')).toEqual([]);

    rmSync(authPath, { force: true });
    expect((await captureCliAccounts({ db: t.db, homeDir, env, now: () => 6000 })).filter(item => item.app_id === 'codex')).toEqual([]);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM cli_account WHERE app_id='codex'").get() as { n: number }).n).toBe(1);
  });

  it('env 与配置文件里的不同 key 同样按 key 区分', () => {
    writeDeepseekConfig(homeDir, KEY_A);
    const found = discoverCliCredentials(homeDir, { DEEPSEEK_API_KEY: KEY_B });
    expect(found.filter(item => item.app_id === 'deepseek').map(item => item.key).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  it('重复捕获幂等：只更新 last_seen_at，不新增账号', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    const { vault, refs } = fakeVault();
    await captureCliAccounts({ db: t.db, vault, homeDir, env: {}, now: () => 1000 });
    const second = await captureCliAccounts({ db: t.db, vault, homeDir, env: {}, now: () => 5000 });

    expect(second).toHaveLength(1);
    expect(second[0]!.created_at).toBe(1000);
    expect(second[0]!.last_seen_at).toBe(5000);
    // 已登记账号不再重复写 vault
    expect(refs).toHaveLength(1);
  });

  it('库行与对外投影都不含 key 明文；凭据只以 vault ref 存在', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    const { vault } = fakeVault();
    const items = await captureCliAccounts({ db: t.db, vault, homeDir, env: {}, now: () => 1000 });

    const row = t.db.prepare('SELECT * FROM cli_account').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(KEY_A);
    expect(row.credential_ref).not.toBeNull();
    expect(Object.keys(items[0]!)).not.toContain('credential_ref');
  });
});

describe('ACC-CLI-MULTI：持久化与迁移幂等', () => {
  let dir: string;
  let homeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-cli-db-'));
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-home-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('重启（关库重开 + initSchema）后账号仍在', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    const dbPath = join(dir, 'test.db');
    const first = openDb(dbPath);
    initSchema(first);
    await captureCliAccounts({ db: first, homeDir, env: {}, now: () => 1000 });
    first.close();

    const reopened = openDb(dbPath);
    initSchema(reopened);
    expect(listCliAccounts(reopened)).toHaveLength(1);
    reopened.close();
  });

  it('ensureTable 连跑两次结构一致、既有数据不丢', () => {
    const dbPath = join(dir, 'test.db');
    const db = openDb(dbPath);
    initSchema(db);
    db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run('row-1', 'deepseek', cliIdentityHash('deepseek', KEY_A), null, 1, 1);

    migrateCliAccounts(db);
    migrateCliAccounts(db);

    const columns = (db.prepare('PRAGMA table_info(cli_account)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(['id', 'app_id', 'identity_hash', 'credential_ref', 'created_at', 'last_seen_at']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(1);
    // 唯一索引在：同一身份第二次插入必须冲突
    expect(() => db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,created_at,last_seen_at) VALUES (?,?,?,?,?)')
      .run('row-2', 'deepseek', cliIdentityHash('deepseek', KEY_A), 2, 2)).toThrow();
    db.close();
  });
});

describe('ACC-CLI-MULTI：GET /api/cli-accounts', () => {
  let homeDir: string;
  let t: TestDb;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-home-'));
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function mount(): Express {
    const scoped = express();
    scoped.use(express.json());
    const { vault } = fakeVault();
    scoped.use('/api', createAccountRouter({ db: t.db, cliVault: vault, cliAccountHomeDir: homeDir, cliAccountEnv: {} }));
    scoped.use(errorHandler);
    return scoped;
  }

  it('返回真实计数和脱敏Codex身份，且响应体不含 key / OAuth材料 / credential_ref', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    writeDshCredentials(homeDir, KEY_B);
    writeOpencodeAuth(homeDir, KEY_OPENCODE);
    writeCodexAuth(join(homeDir, '.codex'), codexChatgptAuth(CODEX_ACCOUNT_ID, 'api'));
    const app = mount();

    const response = await request(app).get('/api/cli-accounts').expect(200);
    const body = response.body as { items: Array<{ app_id: string }> };
    expect(body.items.filter(item => item.app_id === 'deepseek')).toHaveLength(2);
    expect(body.items.filter(item => item.app_id === 'opencode_go')).toHaveLength(1);
    expect(body.items.filter(item => item.app_id === 'codex')).toHaveLength(1);
    const raw = JSON.stringify(response.body);
    for (const key of [KEY_A, KEY_B, KEY_OPENCODE, CODEX_ACCOUNT_ID, 'access-api', 'refresh-api', codexIdToken(CODEX_ACCOUNT_ID, 'api')]) {
      expect(raw).not.toContain(key);
    }
    expect(raw).not.toContain('credential_ref');
  });

  it('第二次请求计数不变（幂等登记）', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    const app = mount();
    const first = await request(app).get('/api/cli-accounts').expect(200);
    const second = await request(app).get('/api/cli-accounts').expect(200);
    expect(second.body.items).toHaveLength(first.body.items.length);
    expect(second.body.items).toHaveLength(1);
  });
});

describe('CLI-IMPORT：手动导入与校验', () => {
  let dir: string;
  let t: TestDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-cli-import-'));
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('导入成功：写 cli_account + vault（purpose cli_credential），响应与库行不含明文', async () => {
    const { vault, scopes, refs } = fakeVault();
    const result = await importCliCredential({ db: t.db, vault, appId: 'deepseek', credential: KEY_A, now: () => 1000 });

    expect(result.action).toBe('created');
    expect(result.account.identity_hint).toBe(`sha256:${cliIdentityHash('deepseek', KEY_A).slice(0, 12)}`);
    const row = t.db.prepare('SELECT * FROM cli_account').get() as Record<string, unknown>;
    expect(row).toMatchObject({ app_id: 'deepseek', identity_hash: cliIdentityHash('deepseek', KEY_A), created_at: 1000, last_seen_at: 1000 });
    expect(row.credential_ref).toBe(refs[0]);
    expect(scopes[0]!.purpose).toBe('cli_credential');
    expect(JSON.stringify(row)).not.toContain(KEY_A);
    expect(JSON.stringify(result)).not.toContain(KEY_A);
    expect(Object.keys(result.account)).not.toContain('credential_ref');
  });

  it('导入两份不同 DeepSeek key → 计数 2，且关库重开后仍在', async () => {
    const dbPath = join(dir, 'import.db');
    const db = openDb(dbPath);
    initSchema(db);
    const { vault } = fakeVault();
    await importCliCredential({ db, vault, appId: 'deepseek', credential: KEY_A, now: () => 1000 });
    await importCliCredential({ db, vault, appId: 'deepseek', credential: KEY_B, now: () => 2000 });
    expect(listCliAccounts(db).filter(item => item.app_id === 'deepseek')).toHaveLength(2);
    db.close();

    const reopened = openDb(dbPath);
    initSchema(reopened);
    expect(listCliAccounts(reopened).filter(item => item.app_id === 'deepseek')).toHaveLength(2);
    reopened.close();
  });

  it('同 identity 二次导入不新增行：只刷新 last_seen_at，且不重复写 vault', async () => {
    const { vault, refs } = fakeVault();
    const first = await importCliCredential({ db: t.db, vault, appId: 'deepseek', credential: KEY_A, now: () => 1000 });
    const second = await importCliCredential({ db: t.db, vault, appId: 'deepseek', credential: KEY_A, now: () => 5000 });

    expect(second.action).toBe('updated');
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.created_at).toBe(1000);
    expect(second.account.last_seen_at).toBe(5000);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(1);
    expect(refs).toHaveLength(1);
  });

  it('格式非法被拒：可读原因且不回显输入原文', async () => {
    const { vault } = fakeVault();
    for (const credential of ['', '   ', 'not-a-key with spaces', 'short']) {
      await expect(importCliCredential({ db: t.db, vault, appId: 'opencode_go', credential })).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_CREDENTIAL',
      });
    }
    // 多份 key 混在一起 → 明确拒绝（一次一份）
    expect(parseCliCredentialText(`${KEY_A}\n${KEY_B}`)).toEqual({ error: '一次只能导入一份凭据：输入里检测到多份 key' });
    // DeepSeek 的 sk- 前缀是硬约束
    await expect(importCliCredential({ db: t.db, vault, appId: 'deepseek', credential: 'abc123456789' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CREDENTIAL',
      message: expect.stringContaining('sk-'),
    });
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(0);
  });

  it('Codex 导入对象未定 → 409，不产生任何记录', async () => {
    const { vault, refs } = fakeVault();
    await expect(importCliCredential({ db: t.db, vault, appId: 'codex', credential: 'abc123456789' })).rejects.toMatchObject({
      status: 409,
      code: 'CLI_IMPORT_UNSUPPORTED',
    });
    expect(refs).toHaveLength(0);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(0);
  });

  it('从配置文件片段解析凭据（api_key / JSON / env 赋值）', () => {
    expect(parseCliCredentialText(`api_key = "${KEY_A}"`)).toEqual({ token: KEY_A });
    expect(parseCliCredentialText(`{"api_key": "${KEY_A}"}`)).toEqual({ token: KEY_A });
    expect(parseCliCredentialText(`DEEPSEEK_API_KEY=${KEY_A}\n`)).toEqual({ token: KEY_A });
    expect(parseCliCredentialText('随便一段日志文字')).toEqual({ error: '无法从输入中解析出凭据：请粘贴单个 API key，不要包含多余文字' });
  });

  it('POST /api/cli-accounts/import：成功 / 重复 / 越界 app_id / 非法格式 / Codex', async () => {
    const { vault } = fakeVault();
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api', createAccountRouter({ db: t.db, cliVault: vault }));
    scoped.use(errorHandler);

    const created = await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'deepseek', credential: KEY_A }).expect(200);
    expect(created.body).toMatchObject({ app_id: 'deepseek', action: 'created' });
    expect(JSON.stringify(created.body)).not.toContain(KEY_A);

    const duplicate = await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'deepseek', credential: KEY_A }).expect(200);
    expect(duplicate.body.action).toBe('updated');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(1);

    const badApp = await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'bogus', credential: KEY_A }).expect(400);
    const badFormat = await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'opencode_go', credential: 'a b c d' }).expect(400);
    expect(badFormat.body.error.message).toContain('无法从输入中解析出凭据');
    // 严格 body：额外字段不被静默忽略
    await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'deepseek', credential: KEY_A, path: 'C:/key.txt' }).expect(400);
    const codex = await request(scoped).post('/api/cli-accounts/import').send({ app_id: 'codex', credential: KEY_A }).expect(409);
    expect(codex.body.error.code).toBe('CLI_IMPORT_UNSUPPORTED');
    expect(badApp.body.error.code).toBe('VALIDATION_ERROR');
  });
});
