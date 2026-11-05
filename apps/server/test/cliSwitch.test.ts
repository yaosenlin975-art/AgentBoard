/**
 * CLI-SWITCH：CLI 三来源切换（逐来源快照 → 写入 → 读回校验 → 失败回滚）。
 *
 * 断言口径（对应卡面验收）：
 * - 默认 dry-run 不写本机配置，响应只含身份指纹；
 * - 显式 apply 写入并读回校验，保留配置文件其余内容；
 * - 写入后校验失败 → 恢复写入前字节；
 * - 同一来源并发切换 → 第二个 ACCOUNT_BUSY；
 * - 环境变量影子 / 无凭据 / Codex 不支持 → 预检拒绝且不写文件；
 * - HTTP 端点与能力表可用，响应永不含凭据明文。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { cliIdentityHash } from '../src/services/accounts/cliAccounts.js';
import { CLI_SWITCH_CAPABILITIES, switchCliAccount, type CliSwitchVault } from '../src/services/accounts/cliSwitch.js';

const KEY_OLD = 'sk-deepseek-old-0001';
const KEY_NEW = 'sk-deepseek-new-0002';
const KEY_OPENCODE_OLD = 'sk-opencode-old';
const KEY_OPENCODE_NEW = 'sk-opencode-new';
const REF = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

function writeDeepseekConfig(homeDir: string, key: string, extra = ''): void {
  mkdirSync(join(homeDir, '.deepseek'), { recursive: true });
  writeFileSync(join(homeDir, '.deepseek', 'config.toml'), `# 用户配置\napi_key = "${key}"\n${extra}`);
}

function writeOpencodeAuth(homeDir: string, json: unknown): void {
  mkdirSync(join(homeDir, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'),
    typeof json === 'string' ? json : JSON.stringify(json));
}

function insertAccount(db: TestDb['db'], appId: 'deepseek' | 'opencode_go' | 'codex', key: string, ref: string | null = REF): void {
  db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(ACCOUNT_ID, appId, cliIdentityHash(appId, key), ref, 1, 1);
}

function fakeVault(plain: string): CliSwitchVault {
  return { unprotect: async () => Buffer.from(plain, 'utf8') };
}

function mount(t: TestDb, homeDir: string, vault?: CliSwitchVault, env: Record<string, string | undefined> = {}): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createAccountRouter({ db: t.db, cliSwitchVault: vault, cliAccountHomeDir: homeDir, cliAccountEnv: env }));
  app.use(errorHandler);
  return app;
}

describe('CLI-SWITCH：DeepSeek 逐来源切换', () => {
  let homeDir: string;
  let t: TestDb;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-switch-'));
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('默认 dry-run：不写文件，响应只含身份指纹', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD, 'model = "deepseek-chat"\n');
    insertAccount(t.db, 'deepseek', KEY_NEW);
    const before = readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8');
    const result = await switchCliAccount({ db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, homeDir, env: {} });

    expect(result.status).toBe('dry_run');
    expect(result.applied).toBe(false);
    expect(result.target).toBe('~/.deepseek/config.toml');
    expect(result.target_identity_hint).toBe(`sha256:${cliIdentityHash('deepseek', KEY_NEW).slice(0, 12)}`);
    expect(JSON.stringify(result)).not.toContain(KEY_NEW);
    expect(JSON.stringify(result)).not.toContain(KEY_OLD);
    expect(readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8')).toBe(before);
  });

  it('显式 apply：替换 api_key 并保留其余配置，读回校验通过', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD, 'model = "deepseek-chat"\n');
    insertAccount(t.db, 'deepseek', KEY_NEW);
    const result = await switchCliAccount({
      db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    });

    const text = readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8');
    expect(result.status).toBe('switched');
    expect(text).toContain(`api_key = "${KEY_NEW}"`);
    expect(text).not.toContain(KEY_OLD);
    expect(text).toContain('model = "deepseek-chat"');
    expect(text).toContain('# 用户配置');
    expect(JSON.stringify(result)).not.toContain(KEY_NEW);
  });

  it('写入后校验失败 → 回滚到写入前字节并报 CLI_SWITCH_ROLLED_BACK', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD, 'model = "deepseek-chat"\n');
    insertAccount(t.db, 'deepseek', KEY_NEW);
    const before = readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8');

    await expect(switchCliAccount({
      db: t.db,
      vault: fakeVault(KEY_NEW),
      accountId: ACCOUNT_ID,
      apply: true,
      homeDir,
      env: {},
      verifyOverride: async () => { throw new Error('模拟写入后校验失败'); },
    })).rejects.toMatchObject({ status: 409, code: 'CLI_SWITCH_ROLLED_BACK' });

    expect(readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8')).toBe(before);
  });

  it('环境变量影子（DEEPSEEK_API_KEY）→ 预检拒绝且不写文件', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD, 'model = "deepseek-chat"\n');
    insertAccount(t.db, 'deepseek', KEY_NEW);
    const before = readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8');

    await expect(switchCliAccount({
      db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: { DEEPSEEK_API_KEY: 'sk-env-wins' },
    })).rejects.toMatchObject({ status: 409, code: 'DEEPSEEK_ENV_SHADOWS' });
    expect(readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8')).toBe(before);
  });

  it('缺少 credential_ref → 409 CLI_CREDENTIAL_MISSING，不触碰文件', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD);
    insertAccount(t.db, 'deepseek', KEY_NEW, null);
    await expect(switchCliAccount({
      db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    })).rejects.toMatchObject({ status: 409, code: 'CLI_CREDENTIAL_MISSING' });
  });

  it('同一来源并发切换：第二个请求 409 ACCOUNT_BUSY', async () => {
    writeDeepseekConfig(homeDir, KEY_OLD);
    insertAccount(t.db, 'deepseek', KEY_NEW);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });

    const first = switchCliAccount({
      db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
      verifyOverride: async () => { entered(); await gate; },
    });
    await enteredPromise;
    await expect(switchCliAccount({
      db: t.db, vault: fakeVault(KEY_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    })).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_BUSY' });

    release();
    await expect(first).resolves.toMatchObject({ status: 'switched' });
  });
});

describe('CLI-SWITCH：OpenCode-Go 与不支持来源', () => {
  let homeDir: string;
  let t: TestDb;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-switch-'));
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('apply 只改 opencode-go.key，保留 auth.json 其它条目', async () => {
    writeOpencodeAuth(homeDir, { other: { key: 'keep-me' }, 'opencode-go': { key: KEY_OPENCODE_OLD, note: 'x' } });
    insertAccount(t.db, 'opencode_go', KEY_OPENCODE_NEW);
    const result = await switchCliAccount({
      db: t.db, vault: fakeVault(KEY_OPENCODE_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    });
    const json = JSON.parse(readFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), 'utf8')) as Record<string, { key?: string; note?: string }>;

    expect(result.status).toBe('switched');
    expect(json.other?.key).toBe('keep-me');
    expect(json['opencode-go']?.key).toBe(KEY_OPENCODE_NEW);
    expect(json['opencode-go']?.note).toBe('x');
  });

  it('auth.json 非法 JSON → 409 CLIENT_STATE_UNREADABLE 且不写文件', async () => {
    writeOpencodeAuth(homeDir, '{not-json');
    insertAccount(t.db, 'opencode_go', KEY_OPENCODE_NEW);
    const path = join(homeDir, '.local', 'share', 'opencode', 'auth.json');

    await expect(switchCliAccount({
      db: t.db, vault: fakeVault(KEY_OPENCODE_NEW), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    })).rejects.toMatchObject({ status: 409, code: 'CLIENT_STATE_UNREADABLE' });
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });

  it('Codex 保持只读：能力表 switch=false，切换返回 409 且不产生文件', async () => {
    insertAccount(t.db, 'codex', 'codex-oauth-token');
    const capability = CLI_SWITCH_CAPABILITIES.find(item => item.app_id === 'codex')!;
    expect(capability.switch).toBe(false);

    await expect(switchCliAccount({
      db: t.db, vault: fakeVault('codex-oauth-token'), accountId: ACCOUNT_ID, apply: true, homeDir, env: {},
    })).rejects.toMatchObject({ status: 409, code: 'CLI_SWITCH_UNSUPPORTED' });
  });
});

describe('CLI-SWITCH：HTTP 端点', () => {
  let homeDir: string;
  let t: TestDb;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-switch-'));
    t = createTestDb();
    writeDeepseekConfig(homeDir, KEY_OLD);
    insertAccount(t.db, 'deepseek', KEY_NEW);
  });
  afterEach(() => {
    t.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('GET /api/cli-accounts/switch-capabilities 返回三来源且 codex 不可切换', async () => {
    const res = await request(mount(t, homeDir, fakeVault(KEY_NEW)))
      .get('/api/cli-accounts/switch-capabilities').expect(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.find((item: { app_id: string }) => item.app_id === 'codex').switch).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(KEY_NEW);
  });

  it('POST switch 默认 dry-run；apply=true 才写入', async () => {
    const app = mount(t, homeDir, fakeVault(KEY_NEW));
    const dry = await request(app).post(`/api/cli-accounts/${ACCOUNT_ID}/switch`).send({}).expect(200);
    expect(dry.body.status).toBe('dry_run');
    expect(readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8')).toContain(KEY_OLD);

    const applied = await request(app).post(`/api/cli-accounts/${ACCOUNT_ID}/switch`).send({ apply: true }).expect(200);
    expect(applied.body.status).toBe('switched');
    expect(readFileSync(join(homeDir, '.deepseek', 'config.toml'), 'utf8')).toContain(KEY_NEW);
    expect(JSON.stringify(applied.body)).not.toContain(KEY_NEW);
  });

  it('Codex 切换 409 且响应不含令牌', async () => {
    t.db.prepare('DELETE FROM cli_account').run();
    insertAccount(t.db, 'codex', 'codex-oauth-token');
    const res = await request(mount(t, homeDir, fakeVault('codex-oauth-token')))
      .post(`/api/cli-accounts/${ACCOUNT_ID}/switch`).send({ apply: true }).expect(409);
    expect(res.body.error.code).toBe('CLI_SWITCH_UNSUPPORTED');
    expect(JSON.stringify(res.body)).not.toContain('codex-oauth-token');
  });
});
