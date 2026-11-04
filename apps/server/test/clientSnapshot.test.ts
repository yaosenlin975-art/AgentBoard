/**
 * ACC-KB-B4S-2：客户端账号域快照清单 + Trae 明文残留清理。
 *
 * 重点验证：sidecar（`-wal`/`-shm`/`-journal`）**成对**被抓、篡改/缺失能被固定错误码抓出、
 * 残留清理只碰已知路径且可配置关闭。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_SNAPSHOT_SCHEMA,
  buildClientSnapshotManifest,
  cleanupTraeResidualLog,
  sqliteSidecarsOf,
  traeResidualLogPath,
  verifyClientSnapshot,
  type ClientSnapshotManifest,
} from '../src/services/accounts/clientSnapshot.js';

describe('client snapshot manifest (ACC-KB-B4S-2)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-clientsnap-'));
    dbPath = join(dir, 'state.vscdb');
    writeFileSync(dbPath, 'main-db-content');
    writeFileSync(`${dbPath}-wal`, 'wal-content');
    writeFileSync(`${dbPath}-shm`, 'shm');
    writeFileSync(`${dbPath}-journal`, 'journal');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('成对抓取：主文件与 -wal/-shm/-journal 都进清单，且 sidecar 单列', () => {
    const manifest = buildClientSnapshotManifest({ files: [dbPath], now: 1700000000000 });
    expect(manifest.schema).toBe(CLIENT_SNAPSHOT_SCHEMA);
    expect(manifest.createdAt).toBe(1700000000000);
    expect(manifest.files.map(file => file.path)).toEqual([dbPath]);
    expect(manifest.sidecars.map(file => file.path)).toEqual([`${dbPath}-journal`, `${dbPath}-shm`, `${dbPath}-wal`]);
    expect(manifest.files[0]).toMatchObject({ bytes: 'main-db-content'.length });
    expect(manifest.files[0]!.sha8).toMatch(/^[0-9a-f]{8}$/);
    expect(verifyClientSnapshot(manifest)).toEqual({ ok: true, codes: [], problems: [] });
  });

  it('没有 sidecar 时不硬造条目（只抓主文件）', () => {
    const plain = join(dir, 'auth.json');
    writeFileSync(plain, '{}');
    const manifest = buildClientSnapshotManifest({ files: [plain] });
    expect(manifest.sidecars).toEqual([]);
    expect(sqliteSidecarsOf(plain)).toEqual([]);
    expect(verifyClientSnapshot(manifest).ok).toBe(true);
  });

  it('主文件缺失 → 直接抛错，不生成少文件的清单', () => {
    expect(() => buildClientSnapshotManifest({ files: [join(dir, 'missing.db')] })).toThrow(/快照主文件不存在/);
  });

  it('篡改主文件 → SIZE_MISMATCH + SHA_MISMATCH', () => {
    const manifest = buildClientSnapshotManifest({ files: [dbPath] });
    writeFileSync(dbPath, 'tampered-content-longer');
    const result = verifyClientSnapshot(manifest);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('CLIENT_SNAPSHOT_SIZE_MISMATCH');
    expect(result.codes).toContain('CLIENT_SNAPSHOT_SHA_MISMATCH');
  });

  it('只改内容不改长度 → 仍能靠 sha8 抓出', () => {
    const manifest = buildClientSnapshotManifest({ files: [dbPath] });
    writeFileSync(dbPath, 'main-db-contEnt'); // 同长度、内容不同
    const result = verifyClientSnapshot(manifest);
    expect(result.codes).toContain('CLIENT_SNAPSHOT_SHA_MISMATCH');
    expect(result.codes).not.toContain('CLIENT_SNAPSHOT_SIZE_MISMATCH');
  });

  it('sidecar 被删 → FILE_MISSING + SIDECAR_MISSING', () => {
    const manifest = buildClientSnapshotManifest({ files: [dbPath] });
    unlinkSync(`${dbPath}-wal`);
    const result = verifyClientSnapshot(manifest);
    expect(result.codes).toContain('CLIENT_SNAPSHOT_FILE_MISSING');
    expect(result.codes).toContain('CLIENT_SNAPSHOT_SIDECAR_MISSING');
    expect(result.problems.join('\n')).toContain('-wal');
  });

  it('清单漏登 sidecar（成对抓取被破坏）→ SIDECAR_MISSING', () => {
    const manifest = buildClientSnapshotManifest({ files: [dbPath] });
    const broken: ClientSnapshotManifest = { ...manifest, sidecars: [] };
    const result = verifyClientSnapshot(broken);
    expect(result.codes).toContain('CLIENT_SNAPSHOT_SIDECAR_MISSING');
    expect(result.problems.join('\n')).toContain('成对抓取被破坏');
  });

  it('空清单 / schema 不符 → MANIFEST_INVALID', () => {
    const empty: ClientSnapshotManifest = { schema: CLIENT_SNAPSHOT_SCHEMA, files: [], sidecars: [], createdAt: 1 };
    expect(verifyClientSnapshot(empty).codes).toEqual(['CLIENT_SNAPSHOT_MANIFEST_INVALID']);
    const wrongSchema = { ...empty, schema: 'x/1' } as unknown as ClientSnapshotManifest;
    expect(verifyClientSnapshot(wrongSchema).codes).toEqual(['CLIENT_SNAPSHOT_MANIFEST_INVALID']);
  });
});

describe('trae residual cleanup (ACC-KB-B4S-2)', () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-trae-residual-'));
    logPath = traeResidualLogPath(dir);
    mkdirSync(join(dir, 'logs', 'trae.ai-code-completion'), { recursive: true });
    writeFileSync(logPath, 'plaintext completion log');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('只删已知残留路径，删后文件不存在', () => {
    expect(existsSync(logPath)).toBe(true);
    const result = cleanupTraeResidualLog({ traeDataDir: dir });
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([logPath]);
    expect(existsSync(logPath)).toBe(false);
  });

  it('可配置关闭 → TRAE_RESIDUAL_DISABLED 且不动文件', () => {
    const result = cleanupTraeResidualLog({ traeDataDir: dir, enabled: false });
    expect(result).toMatchObject({ ok: false, code: 'TRAE_RESIDUAL_DISABLED' });
    expect(existsSync(logPath)).toBe(true);
  });

  it('本来就没有残留 → TRAE_RESIDUAL_NOT_FOUND（不算错误）', () => {
    unlinkSync(logPath);
    const result = cleanupTraeResidualLog({ traeDataDir: dir });
    expect(result).toMatchObject({ ok: false, code: 'TRAE_RESIDUAL_NOT_FOUND' });
  });

  it('删除失败 → TRAE_RESIDUAL_DELETE_FAILED 并带原因', () => {
    // 让目标变成一个非空目录：rmSync(force:true) 删目录需要 recursive，非递归会抛 EISDIR/EPERM
    unlinkSync(logPath);
    mkdirSync(logPath, { recursive: true });
    writeFileSync(join(logPath, 'inner.txt'), 'x');
    const result = cleanupTraeResidualLog({ traeDataDir: dir });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TRAE_RESIDUAL_DELETE_FAILED');
    expect(result.message).toContain('删除失败');
  });
});
