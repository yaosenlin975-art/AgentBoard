import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbuddyCheckinTokenSource, defaultWorkbuddyPluginInfoPath } from '../src/services/accounts/workbuddyCheckinSource.js';
import type { ExportRunner } from '../src/services/accounts/credentialImport.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const jwt = (sub: string): string => {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ sub })}.sig`;
};
const identity = (uid: string) => ({ identity_hash: sha256(uid), uid_sha256_8: sha256(uid).slice(0, 8) });

describe('WorkBuddy 捕获签到凭据来源 (ACC-GET)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('插件线明文 JWT 且 sub 与身份匹配 → 直接命中（不调导出脚本）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-wb-checkin-'));
    const infoPath = join(dir, 'Tencent-Cloud.coding-copilot.info');
    const token = jwt('uid-1');
    writeFileSync(infoPath, JSON.stringify({ auth: { accessToken: token } }), 'utf8');
    let exported = 0;
    const source = createWorkbuddyCheckinTokenSource({ pluginInfoPath: infoPath, runExport: async () => { exported += 1; return { stdout: '[]', stderr: '', durationMs: 1 }; } });
    await expect(source.find(identity('uid-1'))).resolves.toBe(token);
    expect(exported).toBe(0);
  });

  it('插件线身份不匹配 → 回落到导出脚本按 account_key 命中', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-wb-checkin-'));
    const infoPath = join(dir, 'missing.info');
    const runExport: ExportRunner = async () => ({
      stdout: JSON.stringify([{ platform: 'workbuddy', account_key: 'uid-1', token: 'FROM-PROCESS' }]),
      stderr: '', durationMs: 1,
    });
    const source = createWorkbuddyCheckinTokenSource({ pluginInfoPath: infoPath, runExport });
    await expect(source.find(identity('uid-1'))).resolves.toBe('FROM-PROCESS');
  });

  it('两路都拿不到 → null（不抛错）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-wb-checkin-'));
    const source = createWorkbuddyCheckinTokenSource({
      pluginInfoPath: join(dir, 'missing.info'),
      runExport: async () => { throw new Error('python missing'); },
    });
    await expect(source.find(identity('uid-1'))).resolves.toBeNull();
  });

  it('默认插件线路径指向 CodeBuddyExtension 明文凭据', () => {
    expect(defaultWorkbuddyPluginInfoPath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toContain(join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'));
  });
});
