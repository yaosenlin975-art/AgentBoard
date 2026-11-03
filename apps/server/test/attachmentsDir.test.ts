/**
 * DOCKER-2：附件目录与 DB 同目录派生。
 * - 本机（未设 env）必须仍是 %APPDATA%\AgentBoard\attachments（老用户附件不能"消失"）；
 * - 设 AGENTBOARD_DB=/tmp/x/agentboard.db 时附件落 /tmp/x/attachments（容器只挂 /data 一个卷）；
 * - 选择「派生」而不是新增 AGENTBOARD_ATTACHMENTS_DIR：少一个 env、少一处漂移，
 *   且 createApp 的默认值本来就是 dirname(db.name)/attachments，派生与既有约定一致。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentsDirFor, configDir, defaultDbPath } from '../src/config.js';

let tmp: string;
let cfgDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agentboard-attach-'));
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-attach-cfg-'));
  process.env.APPDATA = cfgDir;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('附件目录派生（attachmentsDirFor）', () => {
  it('本机默认：DB 在 configDir 下 → 附件仍在 configDir/attachments（路径不变）', () => {
    expect(defaultDbPath()).toBe(join(configDir(), 'agentboard.db'));
    expect(attachmentsDirFor(defaultDbPath())).toBe(join(configDir(), 'attachments'));
    // Windows 上是 %APPDATA%\AgentBoard\attachments：下标量断言，防止以后有人改成 join(appDataDir(), ...)
    expect(attachmentsDirFor(defaultDbPath()).endsWith(join('AgentBoard', 'attachments'))).toBe(true);
  });

  it('容器形态：AGENTBOARD_DB=/data/agentboard.db → /data/attachments', () => {
    const containerDb = join(tmp, 'data', 'agentboard.db');
    expect(attachmentsDirFor(containerDb)).toBe(join(tmp, 'data', 'attachments'));
  });

  it('自定义 DB 目录：附件跟着 DB 走，不回到 configDir', () => {
    const custom = join(tmp, 'custom', 'db.sqlite');
    const attachments = attachmentsDirFor(custom);
    expect(attachments).toBe(join(tmp, 'custom', 'attachments'));
    expect(attachments.startsWith(configDir())).toBe(false);
  });

  it('目录不存在时 mkdir recursive 可建；被同名文件占用时抛错（启动即失败，不静默）', () => {
    const dbDir = join(tmp, 'mk');
    const attachments = attachmentsDirFor(join(dbDir, 'agentboard.db'));
    mkdirSync(attachments, { recursive: true });
    expect(() => rmSync(attachments, { recursive: true })).not.toThrow();

    // 用同名文件占位 → mkdirSync recursive 报错，服务启动时报「附件目录不可用」
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(attachments, 'occupied');
    expect(() => mkdirSync(attachments, { recursive: true })).toThrow();
  });
});
