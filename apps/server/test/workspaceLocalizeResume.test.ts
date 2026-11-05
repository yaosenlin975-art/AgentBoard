/**
 * STORE-3a：resume 崩溃矩阵（隔离临时库，不碰 8787）。
 *
 * 逐段语义（kill 演练用 onStage 注入，落点 = localize.json 的 stage）：
 * - preflight / backup：整段重跑（清残留快照与半成品目标库）；
 * - create ~ copy_attachments：删半成品目标库 + 附件目录后从 create 重建（沿用上次快照）；
 * - verify：保留已拷贝数据只重验（migration_id / backup 文件不变）；
 * - switch：幂等重跑 switch；
 * - finalize：db_mode 已=localized，补账返回 already_localized。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { getDbForWorkspace, resetResolverState } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { LOCALIZE_STAGES, localizeStatePath, readLocalizeState, writeLocalizeState } from '../src/services/workspaceLocalize.js';

describe('STORE-3a resume 崩溃矩阵', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;

  const seed = (): void => {
    for (const title of ['卡一', '卡二', '卡三']) createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
    createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: ws, slug: 'ws-page', title: '本区页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    } as never);
  };

  beforeEach(() => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store3resume-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: '续跑区', path: wsPath }).id;
    seed();
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const run = (over: Record<string, unknown> = {}, deps: Parameters<typeof localizeWorkspace>[2] = {}) => localizeWorkspace(t.db, {
    workspaceId: ws,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    attachmentsDir: join(root, 'attachments'),
    ...over,
  }, deps);

  const killAt = (stage: string): Parameters<typeof localizeWorkspace>[2] => ({
    onStage: (hit: string) => {
      if (hit === stage) throw Object.assign(new Error(`模拟 kill@${stage}`), { code: 'SIMULATED_KILL' });
    },
  });

  /** 已完成的迁移可开工作区库核数（2a 同款） */
  const expectWorkspaceIssueCount = (n: number): void => {
    const target = getDbForWorkspace(
      { centerDb: t.db, instanceId: 'inst-s3', port: 0, openWorkspaceDbs: true },
      { id: ws, path: wsPath, dbMode: 'localized' },
    );
    try {
      expect(target.decision.target).toBe('workspace');
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(n);
    } finally {
      target.db.close();
      resetResolverState();
    }
  };

  const expectLocalizedEndState = (): void => {
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('localized');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(0);
    expectWorkspaceIssueCount(3);
  };

  const backupFiles = (): string[] => readdirSync(join(wsPath, '.agentboard')).filter((name) => name.includes('.center-backup-'));

  for (const stage of LOCALIZE_STAGES) {
    it(`kill@${stage} → resume 完成：行数守恒、中心清空、db_mode=localized`, async () => {
      mkdirSync(join(root, 'attachments'), { recursive: true });
      await expect(run({}, killAt(stage))).rejects.toThrow(new RegExp(`模拟 kill@${stage}`));
      const interrupted = readLocalizeState(wsPath);
      expect(interrupted).not.toBeNull();
      expect(interrupted?.stage).toBe(stage);

      const resumed = await run({ resume: true });
      // kill@finalize 时 switch 已提交：迁移实际完成，resume 补账返回 already_localized；其余段跑完返回 localized
      expect(['localized', 'already_localized']).toContain(resumed.state);
      expect(resumed.counts.issue).toBe(3);
      expectLocalizedEndState();
      // 快照恰好一份：重跑段删旧建新，中段续跑沿用旧快照
      expect(backupFiles().length).toBe(1);
    });
  }

  it('verify/switch 段 resume 不重建：migration_id 与 backup 快照原样保留', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    await expect(run({}, killAt('verify'))).rejects.toThrow(/模拟 kill@verify/);
    const interrupted = readLocalizeState(wsPath)!;
    const backupBefore = backupFiles();
    expect(backupBefore.length).toBe(1);

    const resumed = await run({ resume: true });
    expect(resumed.state).toBe('localized');
    expect(resumed.migration_id).toBe(interrupted.migration_id);
    expect(resumed.backup_path).toBe(interrupted.backup_path);
    expect(backupFiles()).toEqual(backupBefore);
    expectLocalizedEndState();
  });

  it('preflight/backup 段 resume 整段重跑：残留快照被清掉、换新 migration_id', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    await expect(run({}, killAt('backup'))).rejects.toThrow(/模拟 kill@backup/);
    const interrupted = readLocalizeState(wsPath)!;
    // kill@backup 的窗口在 vacuumInto 之前：本次没建出快照；手工放一个上次崩溃残留的坏快照，验证重跑前被清掉
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    const staleBackup = join(wsPath, '.agentboard', 'agentboard.db.center-backup-2-残留');
    writeFileSync(staleBackup, 'garbage', 'utf8');
    expect(backupFiles()).toHaveLength(1);

    const resumed = await run({ resume: true });
    expect(resumed.state).toBe('localized');
    expect(resumed.migration_id).not.toBe(interrupted.migration_id);
    expect(backupFiles()).toHaveLength(1);
    expect(backupFiles()[0]).not.toBe('agentboard.db.center-backup-2-残留');
    expect(existsSync(staleBackup)).toBe(false);
    expectLocalizedEndState();
  });

  it('resume 无中间态 → 409 NO_LOCALIZE_STATE', async () => {
    await expect(run({ resume: true })).rejects.toMatchObject({ code: 'NO_LOCALIZE_STATE' });
    expect(readLocalizeState(wsPath)).toBeNull();
  });

  it('resume 中间态与工作区/中心库不一致 → 409 LOCALIZE_STATE_INVALID', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    await expect(run({}, killAt('copy'))).rejects.toThrow(/模拟 kill@copy/);
    const state = readLocalizeState(wsPath)!;
    writeLocalizeState(wsPath, { ...state, workspace_id: 'ws-other' });
    await expect(run({ resume: true })).rejects.toMatchObject({ code: 'LOCALIZE_STATE_INVALID' });
    writeLocalizeState(wsPath, { ...state, center_db: join(root, 'elsewhere.db') });
    await expect(run({ resume: true })).rejects.toMatchObject({ code: 'LOCALIZE_STATE_INVALID' });
    writeLocalizeState(wsPath, { ...state, stage: 'not-a-stage' as never });
    await expect(run({ resume: true })).rejects.toMatchObject({ code: 'LOCALIZE_STATE_INVALID' });
    // 状态文件仍是原样，cleanup 可清
    expect(existsSync(localizeStatePath(wsPath))).toBe(true);
  });

  it('switch 已提交但 localize.json 停在 switch（真实 kill 窗口）→ resume 幂等重跑 switch', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    // 先正常迁移到 finalize，再手工把状态回拨到 switch（模拟「提交后、finalize 落盘前」进程死亡）
    const first = await run();
    expect(first.state).toBe('localized');
    const state = readLocalizeState(wsPath)!;
    writeLocalizeState(wsPath, { ...state, stage: 'switch' });
    // db_mode 已经是 localized：resume 走补账早退（幂等），不动数据
    const resumed = await run({ resume: true });
    expect(resumed.state).toBe('already_localized');
    expect(resumed.counts.issue).toBe(3);
    expectLocalizedEndState();
  });
});
