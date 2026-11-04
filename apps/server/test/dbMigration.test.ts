/**
 * DB-2：数据库迁移引擎——前置检查（可写/空间/目标冲突）、一致性快照、附件逐文件 sha256 校验、
 * 失败回滚（旧路径不变 + 固定错误码 + 可重试）、`.bak-<ts>` 备份与旧文件清理。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  cleanupOldDbFiles,
  copyAttachmentsVerified,
  listFilesRecursive,
  measureMigrationSource,
  preflightMigration,
  runDbMigration,
} from '../src/services/dbMigration.js';

describe('db migration (DB-2)', () => {
  let root: string;
  let fromDb: string;
  let fromAttach: string;
  let toDb: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-dbmig-'));
    fromDb = join(root, 'old', 'agentboard.db');
    fromAttach = join(root, 'old', 'attachments');
    toDb = join(root, 'new', 'agentboard.db');
    mkdirSync(join(root, 'old'), { recursive: true });
    const db = new Database(fromDb);
    db.exec('CREATE TABLE issue (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE workspace (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO workspace VALUES (?)').run('w1');
    db.prepare('INSERT INTO issue VALUES (?, ?)').run('i1', '卡一');
    db.prepare('INSERT INTO issue VALUES (?, ?)').run('i2', '卡二');
    db.prepare('INSERT INTO issue VALUES (?, ?)').run('i3', '卡三');
    db.close();
    // 附件：2 个文件（含子目录）
    mkdirSync(join(fromAttach, 'sub'), { recursive: true });
    writeFileSync(join(fromAttach, 'a.png'), Buffer.from('png-a'));
    writeFileSync(join(fromAttach, 'sub', 'b.png'), Buffer.from('png-bb'));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('前置检查：目标可写 + 空间足够 → 通过，并算出总量（db + 附件）', async () => {
    const result = await preflightMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, freeBytes: async () => 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const measured = measureMigrationSource(fromDb, fromAttach);
    expect(result.plan.totalBytes).toBe(measured.totalBytes);
    expect(result.plan.attachmentFiles).toBe(2);
  });

  it('空间不足 → DB_MIGRATION_NO_SPACE（不动源数据）', async () => {
    const result = await preflightMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, freeBytes: async () => 1 });
    expect(result).toMatchObject({ ok: false, code: 'DB_MIGRATION_NO_SPACE' });
    expect(existsSync(toDb)).toBe(false);
  });

  it('目标已存在同名库且未确认 → DB_MIGRATION_TARGET_EXISTS', async () => {
    mkdirSync(join(root, 'new'), { recursive: true });
    writeFileSync(toDb, 'existing');
    const result = await preflightMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, freeBytes: async () => 10 * 1024 * 1024 });
    expect(result).toMatchObject({ ok: false, code: 'DB_MIGRATION_TARGET_EXISTS' });
    const overwrite = await preflightMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, overwrite: true, freeBytes: async () => 10 * 1024 * 1024 });
    expect(overwrite.ok).toBe(true);
  });

  it('一致性快照（VACUUM INTO）+ 附件逐文件校验 → 卡数/附件数/sha 一致', async () => {
    const source = new Database(fromDb);
    try {
      const result = await runDbMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, sourceDb: source, freeBytes: async () => 10 * 1024 * 1024, now: () => 1700000000000 });
      expect(result.ok, result.message).toBe(true);
      expect(result.backupDir).toContain('.bak-');
      const copied = new Database(toDb, { readonly: true });
      try {
        expect((copied.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(3);
        expect((copied.prepare('SELECT COUNT(*) AS n FROM workspace').get() as { n: number }).n).toBe(1);
      } finally { copied.close(); }
      const toAttach = join(root, 'new', 'attachments');
      const files = listFilesRecursive(toAttach);
      expect(files.map(file => file.path)).toEqual(['a.png', 'sub/b.png']);
      expect(readFileSync(join(toAttach, 'a.png'), 'utf8')).toBe('png-a');
      expect(readFileSync(join(toAttach, 'sub', 'b.png'), 'utf8')).toBe('png-bb');
    } finally { source.close(); }
  });

  it('附件校验失败 → DB_MIGRATION_VERIFY_FAILED：目标半成品清掉、源库不变、可重试', async () => {
    const source = new Database(fromDb);
    try {
      const result = await runDbMigration({
        fromDbPath: fromDb,
        toDbPath: toDb,
        fromAttachmentsDir: fromAttach,
        sourceDb: source,
        freeBytes: async () => 10 * 1024 * 1024,
        // 注入一个「复制后 sha 不符」的结果，模拟真实校验失败
        copyAttachments: () => ({ files: 2, bytes: 10, mismatches: ['a.png（期望 aaaaaaaa，实际 bbbbbbbb）'] }),
      });
      expect(result).toMatchObject({ ok: false, code: 'DB_MIGRATION_VERIFY_FAILED', retryable: true });
      expect(result.message).toContain('附件校验失败');
      // 目标侧半成品被清掉；源库与源附件都在
      expect(existsSync(toDb)).toBe(false);
      expect(existsSync(fromDb)).toBe(true);
      expect(existsSync(fromAttach)).toBe(true);
    } finally { source.close(); }
  });
  it('源库文件被删（复制中断）→ 失败码 + 旧路径不变', async () => {
    const result = await runDbMigration({ fromDbPath: join(root, 'old', 'missing.db'), toDbPath: toDb, fromAttachmentsDir: fromAttach, freeBytes: async () => 10 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(existsSync(toDb)).toBe(false);
    expect(existsSync(fromAttach)).toBe(true);
  });

  it('成功后清理旧文件：旧库与 sidecar 移入 .old 归档，.bak 保留', async () => {
    const source = new Database(fromDb);
    let backupDir = '';
    try {
      const result = await runDbMigration({ fromDbPath: fromDb, toDbPath: toDb, fromAttachmentsDir: fromAttach, sourceDb: source, freeBytes: async () => 10 * 1024 * 1024, now: () => 1700000000000 });
      expect(result.ok).toBe(true);
      backupDir = result.backupDir as string;
    } finally { source.close(); }
    const cleaned = cleanupOldDbFiles(backupDir, fromDb);
    expect(cleaned.removed.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(fromDb)).toBe(false);
    expect(existsSync(`${backupDir}.json`)).toBe(true);
    expect(statSync(`${backupDir}.old`).isDirectory()).toBe(true);
  });
});
