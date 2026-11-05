/**
 * ACC-CC-3：Command Code 接入 CLI 来源。
 *
 * 断言口径（对应卡面验收）：
 * - 迁移幂等：旧 CHECK（三值）库重建后行数与行内容不变、可写入 commandcode、连跑两次一致；
 * - 发现如实：未安装 / 无 auth.json / 格式未识别 / 可读取 / 环境变量 五条路径的能力码；
 * - 导入：复用 vault 与 (app_id, identity_hash) 去重，响应与库行不含明文；
 * - 接线：能力端点在真实 createApp 下非 404。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db/connection.js';
import { migrateCliAccounts } from '../src/db/migrations/cliAccounts.js';
import {
  commandCodeCapability,
  discoverCliCredentials,
  importCliCredential,
  type CliCredentialVault,
} from '../src/services/accounts/cliAccounts.js';
import type { VaultScope } from '../src/services/accounts/secretVault.js';

const CC_KEY = 'cc-studio-key-123456';

function writeCommandCodeAuth(homeDir: string, content: string): void {
  mkdirSync(join(homeDir, '.commandcode'), { recursive: true });
  writeFileSync(join(homeDir, '.commandcode', 'auth.json'), content);
}

/** 造一个「CLI 已安装」的 PATH：目录里放平台对应的可执行入口 */
function installedBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bin-'));
  const name = process.platform === 'win32' ? 'command-code.cmd' : 'command-code';
  writeFileSync(join(dir, name), '');
  return dir;
}

function fakeVault(): { vault: CliCredentialVault; scopes: VaultScope[] } {
  const scopes: VaultScope[] = [];
  const vault: CliCredentialVault = {
    protect: async (_data, scope) => {
      scopes.push(scope);
      return `00000000-0000-4000-8000-${String(scopes.length).padStart(12, '0')}`;
    },
  };
  return { vault, scopes };
}

describe('ACC-CC-3：cli_account CHECK 约束幂等重建', () => {
  it('旧库升级后行数不变、旧行可读，且能写入 commandcode；连跑两次一致', () => {
    const db = openDb(':memory:');
    db.exec(`
CREATE TABLE cli_account (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK (app_id IN ('deepseek','opencode_go','codex')),
  identity_hash TEXT NOT NULL,
  credential_ref TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL);
CREATE UNIQUE INDEX cli_account_identity ON cli_account(app_id, identity_hash);
`);
    db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run('old-ds', 'deepseek', 'hash-ds', 'ref-ds', 1000, 1000);
    db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run('old-oc', 'opencode_go', 'hash-oc', null, 2000, 2000);

    migrateCliAccounts(db);
    const rows = db.prepare('SELECT id,app_id,credential_ref,created_at,last_seen_at FROM cli_account ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'old-ds', app_id: 'deepseek', credential_ref: 'ref-ds', created_at: 1000, last_seen_at: 1000 },
      { id: 'old-oc', app_id: 'opencode_go', credential_ref: null, created_at: 2000, last_seen_at: 2000 },
    ]);

    // CHECK 已放宽：commandcode 可写入
    db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run('new-cc', 'commandcode', 'hash-cc', null, 3000, 3000);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(3);

    // 幂等：再跑一次不重建、不丢行
    migrateCliAccounts(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n).toBe(3);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cli_account'").get() as { sql: string }).sql;
    expect(sql).toContain("'commandcode'");

    // 约束仍生效：非法 app_id 被拒
    expect(() =>
      db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
        .run('bad', 'unknown_app', 'hash-bad', null, 4000, 4000),
    ).toThrow();
    db.close();
  });
});

describe('ACC-CC-3：Command Code 本机发现与能力（能力如实）', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cc-home-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('PATH 里没有 CLI → CLI_NOT_INSTALLED，不产账号', () => {
    const capability = commandCodeCapability(homeDir, { PATH: join(homeDir, 'empty-bin') });
    expect(capability.installed).toBe(false);
    expect(capability.capture).toBe(false);
    expect(capability.capture_reason_code).toBe('CLI_NOT_INSTALLED');
    expect(capability.auth_file_state).toBe('missing');
    expect(discoverCliCredentials(homeDir, { PATH: join(homeDir, 'empty-bin') })).toHaveLength(0);
    // 切换 / 签到恒为不可用，并给出原因码
    expect(capability.switch).toBe(false);
    expect(capability.switch_reason_code).toBe('AUTH_WRITE_UNVERIFIED');
    expect(capability.checkin_reason_code).toBe('CHECKIN_NOT_APPLICABLE');
  });

  it('已安装但无 auth.json → AUTH_FILE_MISSING', () => {
    const binDir = installedBinDir();
    try {
      const capability = commandCodeCapability(homeDir, { PATH: binDir });
      expect(capability.installed).toBe(true);
      expect(capability.capture).toBe(false);
      expect(capability.capture_reason_code).toBe('AUTH_FILE_MISSING');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('auth.json 无法解析 / 多个候选凭据 → AUTH_SCHEMA_UNSUPPORTED，不猜字段', () => {
    writeCommandCodeAuth(homeDir, 'not-json');
    const broken = commandCodeCapability(homeDir, { PATH: join(homeDir, 'empty-bin') });
    expect(broken.auth_file_state).toBe('unrecognized');
    expect(broken.capture_reason_code).toBe('AUTH_SCHEMA_UNSUPPORTED');

    writeCommandCodeAuth(homeDir, JSON.stringify({ accessToken: 'a', apiKey: 'b' }));
    expect(commandCodeCapability(homeDir, { PATH: join(homeDir, 'empty-bin') }).capture_reason_code)
      .toBe('AUTH_SCHEMA_UNSUPPORTED');
    expect(discoverCliCredentials(homeDir, { PATH: join(homeDir, 'empty-bin') })).toHaveLength(0);
  });

  it('auth.json 唯一凭据 → capture 可用，且被发现为 commandcode 账号', () => {
    writeCommandCodeAuth(homeDir, JSON.stringify({ accessToken: CC_KEY }));
    const capability = commandCodeCapability(homeDir, { PATH: join(homeDir, 'empty-bin') });
    expect(capability.capture).toBe(true);
    expect(capability.capture_reason_code).toBe('OK');
    expect(capability.auth_file_state).toBe('readable');

    const found = discoverCliCredentials(homeDir, { PATH: join(homeDir, 'empty-bin') });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ app_id: 'commandcode', key: CC_KEY });
  });

  it('COMMAND_CODE_API_KEY 环境变量同样可被发现（未安装也可导入前预览）', () => {
    const env = { PATH: join(homeDir, 'empty-bin'), COMMAND_CODE_API_KEY: CC_KEY };
    const capability = commandCodeCapability(homeDir, env);
    expect(capability.capture).toBe(true);
    expect(capability.capture_reason_code).toBe('OK');
    expect(discoverCliCredentials(homeDir, env)).toHaveLength(1);
  });
});

describe('ACC-CC-3：Command Code 导入与路由接线', () => {
  let t: TestDb;
  let homeDir: string;

  beforeEach(() => {
    t = createTestDb();
    homeDir = mkdtempSync(join(tmpdir(), 'cc-route-home-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('导入 commandcode：去重、vault purpose 正确、响应与库行无明文', async () => {
    const { vault, scopes } = fakeVault();
    const created = await importCliCredential({
      db: t.db, vault, appId: 'commandcode', credential: `COMMAND_CODE_API_KEY=${CC_KEY}`, now: () => 1000,
    });
    expect(created.action).toBe('created');
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ app_id: 'commandcode', purpose: 'cli_credential' });

    const repeated = await importCliCredential({
      db: t.db, vault, appId: 'commandcode', credential: CC_KEY, now: () => 2000,
    });
    expect(repeated.action).toBe('updated');
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM cli_account WHERE app_id='commandcode'").get() as { n: number }).n).toBe(1);

    expect(JSON.stringify(created)).not.toContain(CC_KEY);
    expect(JSON.stringify(t.db.prepare('SELECT * FROM cli_account').all())).not.toContain(CC_KEY);
  });

  it('GET /api/cli-accounts/commandcode/capability 与导入端点可触达', async () => {
    const { vault } = fakeVault();
    const app: Express = express();
    app.use(express.json());
    app.use('/api', createAccountRouter({ db: t.db, cliVault: vault, cliAccountHomeDir: homeDir, cliAccountEnv: { PATH: join(homeDir, 'empty-bin') } }));
    app.use(errorHandler);

    const capability = await request(app).get('/api/cli-accounts/commandcode/capability').expect(200);
    expect(capability.body.capability).toMatchObject({
      app_id: 'commandcode',
      capture: false,
      capture_reason_code: 'CLI_NOT_INSTALLED',
      switch: false,
      switch_reason_code: 'AUTH_WRITE_UNVERIFIED',
      checkin: false,
      checkin_reason_code: 'CHECKIN_NOT_APPLICABLE',
    });

    const imported = await request(app)
      .post('/api/cli-accounts/import')
      .send({ app_id: 'commandcode', credential: CC_KEY })
      .expect(200);
    expect(imported.body.action).toBe('created');
    expect(JSON.stringify(imported.body)).not.toContain(CC_KEY);
  });

  it('真实 createApp 下能力端点非 404（路由确实挂载）', async () => {
    const created = await createApp({ db: t.db, refreshClisOnBoot: false, workbuddyProvider: null });
    const response = await request(created.app).get('/api/cli-accounts/commandcode/capability');
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(200);
    expect(response.body.capability.app_id).toBe('commandcode');
  });
});
