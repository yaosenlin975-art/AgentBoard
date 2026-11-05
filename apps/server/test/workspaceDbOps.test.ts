/**
 * STORE-3a：cleanup / revert / 启动塌缩 / disabled 紧急开关（服务层 + 判定层，隔离临时库）。
 *
 * - cleanup：只清工作区侧半成品（目标库/-wal/-shm/附件目录/残留快照/localize.json），中心数据不动；
 *   db_mode=failed/localizing 落回 center（写闸门释放）；活库（localized）与唯一副本（中心无行）拒绝；
 * - revert：反向迁移——附件回拷 + 单事务反向插行（逐表守恒）+ db_mode=center + 工作区库移 backup；
 *   中心已有行 / 非 localized / meta 不自洽拒绝；copy_back 段中断后重跑自愈；
 * - recoverLocalizeGates：启动时 localizing 残留塌缩 failed（写闸门生命周期跨进程兜底）；
 * - decideWorkspaceDb disabled：已下沉区回中心库（error=null 不冻结写），localizing/failed 优先；
 * - UNREADABLE 提示：打不开的工作区库 + localize.json backup_path → 话术指向快照。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { decideWorkspaceDb, getDbForWorkspace, resetResolverState, workspaceDbPath, workspaceStateDir } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { readLocalizeState, writeLocalizeState } from '../src/services/workspaceLocalize.js';
import { cleanupWorkspaceDbRemnants, readBackupMeta, recoverLocalizeGates, revertWorkspace } from '../src/services/workspaceDbOps.js';

describe('STORE-3a cleanup / revert（服务层）', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;
  const attachmentsDir = (): string => join(root, 'attachments');

  const seed = (): void => {
    for (const title of ['卡一', '卡二', '卡三']) createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
    createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: ws, slug: 'ws-page', title: '本区页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    } as never);
  };

  /** 中心附件目录放一个真实文件 + attachment 行（验证 localize 拷出 / revert 拷回） */
  const seedAttachment = (): string => {
    const key = '2026/11/store3a-att.png';
    const file = join(attachmentsDir(), key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'PNGDATA-store3a', 'utf8');
    t.db.prepare(
      "INSERT INTO attachment (id, workspace_id, storage_key, file_name, mime_type, kind, size_bytes, status, created_at, expires_at) VALUES ('att-1', ?, ?, 'a.png', 'image/png', 'image', 15, 'attached', 1, 9999999999999)",
    ).run(ws, key);
    return key;
  };

  const localize = () => localizeWorkspace(t.db, {
    workspaceId: ws,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    attachmentsDir: attachmentsDir(),
  }, { attachmentsDir: attachmentsDir() }); // 附件拷贝读 deps.attachmentsDir（与 job runner 同口径）

  const revert = (deps: Parameters<typeof revertWorkspace>[2] = {}) => revertWorkspace(t.db, { workspaceId: ws }, {
    attachmentsDir: attachmentsDir(),
    ...deps,
  });

  const centerIssueCount = (): number => (t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n;
  const centerMode = (): string => (t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode;

  beforeEach(() => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store3ops-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: '回迁区', path: wsPath }).id;
    seed();
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('revert 全链路：中心行数守恒、db_mode=center、工作区库移 backup（meta.localized=0）、附件回拷', async () => {
    const key = seedAttachment();
    const before = {
      issue: centerIssueCount(),
      page: (t.db.prepare("SELECT COUNT(*) AS n FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?").get(ws) as { n: number }).n,
    };
    const localized = await localize();
    expect(existsSync(join(workspaceStateDir(wsPath), 'attachments', key))).toBe(true);
    expect(centerIssueCount()).toBe(0);

    const result = await revert();
    expect(result.stages).toEqual(['preflight', 'copy_attachments_back', 'copy_back', 'finalize']);
    expect(result.counts.issue).toBe(before.issue);
    expect(result.counts.knowledge_page).toBe(before.page);
    expect(centerMode()).toBe('center');
    expect(centerIssueCount()).toBe(before.issue);
    // 工作区库已移入 backup，原路径清空
    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    expect(existsSync(result.backup_path)).toBe(true);
    expect(result.backup_path).toContain(join('.agentboard', 'backup'));
    expect(readBackupMeta(result.backup_path).localized).toBe('0');
    expect(readLocalizeState(wsPath)).toBeNull();
    // STORE-4e 快照生命周期：前向迁移的 center-backup 快照在 revert 收尾一并清理（数据已回中心，快照失回滚凭据意义）
    expect(result.removed_center_backups).toBeGreaterThanOrEqual(1);
    expect(readdirSync(workspaceStateDir(wsPath)).some((name) => name.includes('.center-backup-'))).toBe(false);
    // 附件文件回到中心目录，工作区侧附件目录已删
    expect(readFileSync(join(attachmentsDir(), key), 'utf8')).toBe('PNGDATA-store3a');
    expect(existsSync(join(workspaceStateDir(wsPath), 'attachments'))).toBe(false);
    // localized.target_db_path 与 revert 后路径一致性（原路径已空）
    expect(existsSync(localized.target_db_path)).toBe(false);
  });

  it('revert → 再 localize → 再 revert 往返幂等', async () => {
    seedAttachment();
    await localize();
    await revert();
    const second = await localize();
    expect(second.state).toBe('localized');
    expect(centerIssueCount()).toBe(0);
    const secondRevert = await revert();
    expect(centerIssueCount()).toBe(3);
    expect(centerMode()).toBe('center');
    expect(existsSync(secondRevert.backup_path)).toBe(true);
  });

  it('revert 拒绝：中心已有该区行（disabled 回写类分叉）、非 localized、meta.localized=0', async () => {
    await expect(revert()).rejects.toMatchObject({ code: 'WORKSPACE_DB_REVERT_NOT_LOCALIZED' });

    await localize();
    // 分叉：localized 后中心又被写进一行（openWorkspaceDbs=false 的现状写路径即如此）
    createIssue(t.db, { workspace_id: ws, title: '分叉卡', description: '', priority: '中', labels: [] } as never);
    await expect(revert()).rejects.toMatchObject({ code: 'WORKSPACE_DB_REVERT_CENTER_ROWS' });

    // meta.localized=0（半拷贝）→ 拒绝回迁
    t.db.prepare("UPDATE workspace SET db_mode = 'localized' WHERE id = ?").run(ws);
    const Database3 = (await import('better-sqlite3')).default;
    const target = new Database3(workspaceDbPath(wsPath));
    target.prepare("UPDATE meta SET value = '0' WHERE key = 'localized'").run();
    target.close();
    await expect(revert()).rejects.toMatchObject({ code: 'WORKSPACE_DB_REVERT_NOT_LOCALIZED' });
  });

  it('copy_back 段中断（kill 演练）→ db_mode 还原 localized、中心无行；重跑 revert 成功', async () => {
    seedAttachment();
    await localize();
    await expect(revert({
      onStage: (stage) => { if (stage === 'copy_back') throw Object.assign(new Error('模拟 kill@copy_back'), { code: 'SIMULATED_KILL' }); },
    })).rejects.toThrow(/模拟 kill@copy_back/);
    // 事务回滚：中心仍无该区行，工作区库完好（唯一副本），闸门还原 localized
    expect(centerMode()).toBe('localized');
    expect(centerIssueCount()).toBe(0);
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
    // 重跑自愈
    const result = await revert();
    expect(centerMode()).toBe('center');
    expect(centerIssueCount()).toBe(3);
    expect(existsSync(result.backup_path)).toBe(true);
  });

  it('cleanup：清空半成品（库/wal/附件目录/localize.json/残留快照）、中心数据不动、db_mode 回 center', async () => {
    seedAttachment();
    // 模拟前向迁移失败（kill@copy）后的现场
    await expect(localizeWorkspace(t.db, {
      workspaceId: ws,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      attachmentsDir: attachmentsDir(),
    }, { onStage: (stage) => { if (stage === 'copy') throw new Error('模拟 kill@copy'); } })).rejects.toThrow(/模拟 kill@copy/);
    expect(readLocalizeState(wsPath)).not.toBeNull();
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(3);

    // 再补一个残留快照（backup 段产物）
    const staleBackup = join(workspaceStateDir(wsPath), 'agentboard.db.center-backup-x');
    writeFileSync(staleBackup, 'stale', 'utf8');

    const cleaned = cleanupWorkspaceDbRemnants(t.db, { workspaceId: ws });
    expect(cleaned.mode_after).toBe('center');
    expect(cleaned.center_rows_before).toBeGreaterThan(0); // 全表合计（issue+评论+知识页+附件行…），>0 即中心持有数据
    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    expect(existsSync(staleBackup)).toBe(false);
    expect(readLocalizeState(wsPath)).toBeNull();
    expect(existsSync(join(workspaceStateDir(wsPath), 'attachments'))).toBe(false);
    // 中心数据原封不动 + 完整性 ok
    expect(centerIssueCount()).toBe(3);
    expect(centerMode()).toBe('center');
    const integrity = (t.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>)[0]?.integrity_check;
    expect(String(integrity).toLowerCase()).toBe('ok');
    // 闸门释放：写判定不再 409
    const gate = getDbForWorkspace({ centerDb: t.db, instanceId: 'inst-s3c', port: 0 }, { id: ws, path: wsPath, dbMode: 'center' });
    expect(gate.decision.error).toBeNull();
  });

  it('cleanup 拒绝：localized 活库、唯一副本（中心无行）、无可清理物 409', async () => {
    // 干净工作区：无可清理
    expect(() => cleanupWorkspaceDbRemnants(t.db, { workspaceId: ws })).toThrow(/WORKSPACE_DB_NOTHING_TO_CLEAN|没有可清理/);

    await localize();
    // 活库：409
    expect(() => cleanupWorkspaceDbRemnants(t.db, { workspaceId: ws })).toThrow(/已正常下沉|WORKSPACE_DB_CLEANUP_NOT_ALLOWED/);

    // 唯一副本（revert 中断遗留的 failed + 中心无行）：409，宁可不删也不丢数据
    t.db.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(ws);
    expect(() => cleanupWorkspaceDbRemnants(t.db, { workspaceId: ws })).toThrow(/唯一数据副本|WORKSPACE_DB_CLEANUP_UNSAFE/);
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
  });

  it('recoverLocalizeGates：启动时 localizing 残留塌缩 failed（跨进程闸门兜底）', () => {
    const otherPath = join(root, 'other');
    mkdirSync(otherPath, { recursive: true });
    const otherWs = createWorkspace(t.db, { name: '别区', path: otherPath }).id;
    t.db.prepare("UPDATE workspace SET db_mode = 'localizing' WHERE id = ?").run(ws);
    t.db.prepare("UPDATE workspace SET db_mode = 'localizing' WHERE id = ?").run(otherWs);
    expect(recoverLocalizeGates(t.db)).toBe(2);
    expect(centerMode()).toBe('failed');
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(otherWs) as { db_mode: string }).db_mode).toBe('failed');
    // 幂等：再跑 0
    expect(recoverLocalizeGates(t.db)).toBe(0);
  });
});

describe('STORE-3a disabled 紧急开关（判定层）', () => {
  let root: string;
  let wsPath: string;
  const WS_ID = 'ws-disabled';
  const CENTER = 'C:/center/agentboard.db';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-store3disabled-'));
    wsPath = join(root, 'workspace');
    mkdirSync(wsPath, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const decide = (over: Partial<Parameters<typeof decideWorkspaceDb>[0]> = {}) => decideWorkspaceDb({
    workspaceId: WS_ID,
    workspacePath: wsPath,
    centerDbMode: 'localized',
    centerDbPath: CENTER,
    fileExists: () => true,
    readMeta: () => ({ localized: true, workspaceId: WS_ID }),
    ...over,
  });

  it('disabled + localized：直接回中心库、不冻结写（error=null），reason 点名 revert', () => {
    const d = decide({ disabled: true });
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: null });
    expect(d.reason).toContain('AGENTBOARD_WORKSPACE_DB=disabled');
    expect(d.reason).toContain('revert');
    // getDbForWorkspace 不打开工作区库（disabled 时即便 openWorkspaceDbs=true 也不开）
    const resolution = getDbForWorkspace(
      { centerDb: { name: CENTER } as never, instanceId: 'inst-dis', port: 0, openWorkspaceDbs: true, disabled: true, fileExists: () => true, readMeta: () => ({ localized: true, workspaceId: WS_ID }) },
      { id: WS_ID, path: wsPath, dbMode: 'localized' },
    );
    expect(resolution.decision.target).toBe('center');
  });

  it('disabled 不覆盖迁移中间态：localizing / failed 仍 MIGRATING（写冻结优先）', () => {
    expect(decide({ disabled: true, centerDbMode: 'localizing' }).error).toBe('WORKSPACE_DB_MIGRATING');
    expect(decide({ disabled: true, centerDbMode: 'failed' }).error).toBe('WORKSPACE_DB_MIGRATING');
  });

  it('disabled 对未下沉工作区无感（正常走 center）；未启用开关时行为不变', () => {
    const noFile = decide({ disabled: true, centerDbMode: 'center', fileExists: () => false, readMeta: () => null });
    expect(noFile).toMatchObject({ target: 'center', error: null });
    expect(noFile.reason).toContain('未下沉');
    expect(decide().target).toBe('workspace');
  });

  it('UNREADABLE 提示：localize.json 带 backup_path 时话术指向快照（goal5）', () => {
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    writeFileSync(join(wsPath, '.agentboard', 'agentboard.db'), 'not-a-sqlite-file', 'utf8');
    writeFileSync(join(wsPath, '.agentboard', 'localize.json'), JSON.stringify({
      migration_id: 'mig-x', workspace_id: WS_ID, stage: 'finalize', center_db: CENTER,
      backup_path: 'C:/ws/.agentboard/agentboard.db.center-backup-2026', started_at: 1, counts: {}, last_error: null,
    }), 'utf8');
    const d = decide({ readMeta: () => null });
    expect(d.error).toBe('WORKSPACE_DB_UNREADABLE');
    expect(d.reason).toContain('agentboard.db.center-backup-2026');
    // 抛错路径同样带提示
    try {
      getDbForWorkspace(
        { centerDb: { name: CENTER } as never, instanceId: 'inst-hint', port: 0, fileExists: () => true, readMeta: () => null },
        { id: WS_ID, path: wsPath, dbMode: 'localized' },
      );
      throw new Error('应抛 UNREADABLE');
    } catch (error) {
      expect((error as Error).message).toContain('agentboard.db.center-backup-2026');
    }
    // 无 localize.json：不拼提示
    rmSync(join(wsPath, '.agentboard', 'localize.json'));
    expect(decide({ readMeta: () => null }).reason).not.toContain('center-backup');
  });

  it('isWorkspaceDbDisabled 只认 disabled 值', async () => {
    const { isWorkspaceDbDisabled } = await import('../src/db/resolver.js');
    expect(isWorkspaceDbDisabled({ AGENTBOARD_WORKSPACE_DB: 'disabled' })).toBe(true);
    expect(isWorkspaceDbDisabled({})).toBe(false);
    expect(isWorkspaceDbDisabled({ AGENTBOARD_WORKSPACE_DB: 'enabled' })).toBe(false);
  });
});
