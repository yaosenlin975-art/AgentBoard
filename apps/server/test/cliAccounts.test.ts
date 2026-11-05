/**
 * ACC-CLI-MULTI（口径 A）：CLI 三来源本机凭据登记。
 *
 * 断言口径（对应卡面验收）：
 * - 两个不同 DeepSeek key → 2；同一 key 出现在两个位置 → 1；
 * - OpenCode Go ≤ 1；Codex 不产账号；
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
  listCliAccounts,
  type CliCredentialVault,
} from '../src/services/accounts/cliAccounts.js';
import type { VaultScope } from '../src/services/accounts/secretVault.js';

const KEY_A = 'sk-deepseek-aaaa';
const KEY_B = 'sk-deepseek-bbbb';
const KEY_OPENCODE = 'sk-opencode-go-cccc';

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

  it('两个不同 DeepSeek key → 2 个账号；OpenCode Go 单条 key → ≤1；Codex 不产账号', async () => {
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

  it('返回真实计数，且响应体不含 key / credential_ref', async () => {
    writeDeepseekConfig(homeDir, KEY_A);
    writeDshCredentials(homeDir, KEY_B);
    writeOpencodeAuth(homeDir, KEY_OPENCODE);
    const app = mount();

    const response = await request(app).get('/api/cli-accounts').expect(200);
    const body = response.body as { items: Array<{ app_id: string }> };
    expect(body.items.filter(item => item.app_id === 'deepseek')).toHaveLength(2);
    expect(body.items.filter(item => item.app_id === 'opencode_go')).toHaveLength(1);
    expect(body.items.filter(item => item.app_id === 'codex')).toHaveLength(0);
    const raw = JSON.stringify(response.body);
    for (const key of [KEY_A, KEY_B, KEY_OPENCODE]) expect(raw).not.toContain(key);
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
