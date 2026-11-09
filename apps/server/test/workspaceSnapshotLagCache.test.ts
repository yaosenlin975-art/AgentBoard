/**
 * CR2-3（PERF-1 回归）：computeSnapshotLag 进程内 TTL 缓存。
 *
 * 卡面验收：
 * - 两次 compute 同 workspace → 只开一次库 / 只算一次（readonly open 计数 + lag COUNT 执行计数）；
 * - TTL 过期后重算（且重算取到新值）；
 * - 失效钩子清缓存后立即重算（手动 invalidate + exportWorkspaceSnapshot 落 manifest 两条路径）；
 * - 对照基准：GET /api/workspaces 两次连续调用，第二次不触发 readonly open（spy 断言，不压测）。
 *
 * 测量口径：
 * - readonly open 计数：代理 better-sqlite3 构造器，只数 `readonly: true` 的 open 尝试（含失败）；
 * - lag COUNT 计数：包住 prepare，按 get/all/run 执行计数，只认 countScopedRowsByTable 独有的
 *   knowledge_attachment 聚合语句（其余 COUNT 不属于本卡回归面）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, issuePayload, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { closeWorkspaceDbs, getDbForWorkspace, resetResolverState, workspaceDbPath, workspaceStateDir } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { exportWorkspaceSnapshot } from '../src/services/workspaceSnapshot.js';
import { computeSnapshotLag, invalidateSnapshotLagCache } from '../src/services/workspaceSnapshotLag.js';

// ---- readonly open 计数：代理构造器（vi.mock 工厂须自包含，状态经模块命名空间带回） ----
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = await importOriginal<typeof import('better-sqlite3')>();
  const state = { readonlyOpens: 0 };
  const Counting = new Proxy(Real.default, {
    construct(target, args) {
      const options = args[1] as { readonly?: boolean } | undefined;
      if (options?.readonly === true) state.readonlyOpens += 1;
      return Reflect.construct(target, args);
    },
  });
  return { ...Real, default: Counting, __countingState: state } as typeof Real & { __countingState: typeof state };
});

const sqliteMockState = ((await import('better-sqlite3')) as unknown as { __countingState: { readonlyOpens: number } }).__countingState;
const readonlyOpens = (): number => sqliteMockState.readonlyOpens;

// ---- lag COUNT 执行计数：包 prepare，只认 knowledge_attachment 聚合语句 ----
/** countScopedRowsByTable 独有片段：`SELECT COUNT(*) AS n FROM (<knowledge_attachment 查询>)` */
const LAG_COUNT_MARKER = 'SELECT COUNT(*) AS n FROM (SELECT a.* FROM knowledge_attachment a JOIN knowledge_page';
type PrepareFn = typeof Database.prototype.prepare;
let lagCountExecs = 0;
let originalPrepare: PrepareFn | null = null;
function installLagCountCounter(): void {
  if (originalPrepare !== null) return;
  const orig: PrepareFn = Database.prototype.prepare;
  originalPrepare = orig;
  Database.prototype.prepare = function (this: Database.Database, source: string) {
    const stmt = orig.call(this, source);
    if (!source.includes(LAG_COUNT_MARKER)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          const fn = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
          return (...a: unknown[]) => { lagCountExecs += 1; return fn.apply(target, a); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  } as typeof Database.prototype.prepare;
}
installLagCountCounter();
afterAll(() => {
  if (originalPrepare !== null) {
    Database.prototype.prepare = originalPrepare;
    originalPrepare = null;
  }
});

/** 建一个已下沉（localized）工作区：中心库 2 条 issue，enable 后自动落 snapshot/manifest.json */
async function makeLocalizedFixture(prefix: string): Promise<{ t: TestDb; root: string; ws: string; wsPath: string }> {
  const t = createTestDb();
  const root = mkdtempSync(join(tmpdir(), `agentboard-cr23-${prefix}-`));
  const wsPath = join(root, 'ws');
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(join(root, 'attachments'), { recursive: true });
  const ws = createWorkspace(t.db, { name: `快照落后区 ${prefix}`, path: wsPath }).id;
  for (const title of ['卡一', '卡二']) {
    createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
  }
  const result = await localizeWorkspace(t.db, {
    workspaceId: ws,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    attachmentsDir: join(root, 'attachments'),
  });
  expect(result.state).toBe('localized');
  return { t, root, ws, wsPath };
}

function cleanupFixture(t: TestDb, root: string): void {
  closeWorkspaceDbs('cr2-3-cleanup');
  resetResolverState();
  t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function manifestPathOf(wsPath: string): string {
  return join(workspaceStateDir(wsPath), 'snapshot', 'manifest.json');
}

describe('CR2-3 computeSnapshotLag TTL 缓存', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;

  beforeEach(async () => {
    resetResolverState();
    ({ t, root, ws, wsPath } = await makeLocalizedFixture('svc'));
  });
  afterEach(() => { cleanupFixture(t, root); });

  const lagInput = () => ({ workspaceId: ws, workspacePath: wsPath, effectiveDbPath: workspaceDbPath(wsPath), centerDb: t.db });

  it('两次 compute 同 workspace：只开一次库 / 只算一次，第二次零 open 零 COUNT', () => {
    expect(existsSync(manifestPathOf(wsPath))).toBe(true);
    const opensBefore = readonlyOpens();
    const countsBefore = lagCountExecs;
    const first = computeSnapshotLag(lagInput());
    expect(first).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(1);
    expect(lagCountExecs - countsBefore).toBe(1);
    const second = computeSnapshotLag(lagInput());
    expect(second).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(1);
    expect(lagCountExecs - countsBefore).toBe(1);
  });

  it('null/失败也缓存：manifest 在但库打不开，第二次不再尝试 open', () => {
    const brokenInput = { workspaceId: ws, workspacePath: wsPath, effectiveDbPath: join(root, 'missing.db'), centerDb: t.db };
    const opensBefore = readonlyOpens();
    expect(computeSnapshotLag(brokenInput)).toBe(null);
    expect(readonlyOpens() - opensBefore).toBe(1);
    expect(computeSnapshotLag(brokenInput)).toBe(null);
    expect(readonlyOpens() - opensBefore).toBe(1);
  });

  it('TTL 过期后重算：过期前旧值，过期后取到 manifest 变更后的新值', () => {
    const opensBefore = readonlyOpens();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(computeSnapshotLag(lagInput())).toBe(0);
      expect(readonlyOpens() - opensBefore).toBe(1);
      // TTL 内改 manifest（绕过失效钩子）：仍回旧值，不重算
      const manifest = JSON.parse(readFileSync(manifestPathOf(wsPath), 'utf8')) as { files: Array<{ table: string; rows: number }> };
      for (const entry of manifest.files) if (entry.table === 'issue') entry.rows = 0;
      writeFileSync(manifestPathOf(wsPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      vi.advanceTimersByTime(59_999);
      expect(computeSnapshotLag(lagInput())).toBe(0);
      expect(readonlyOpens() - opensBefore).toBe(1);
      // 超过 60s TTL → 重算，lag = live issue 行数（2）
      vi.advanceTimersByTime(1_001);
      expect(computeSnapshotLag(lagInput())).toBe(2);
      expect(readonlyOpens() - opensBefore).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失效钩子：invalidateSnapshotLagCache 清缓存后立即重算', () => {
    const opensBefore = readonlyOpens();
    expect(computeSnapshotLag(lagInput())).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(1);
    invalidateSnapshotLagCache(ws);
    expect(computeSnapshotLag(lagInput())).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(2);
  });

  it('失效钩子：exportWorkspaceSnapshot 落 manifest 后立即重算', () => {
    expect(computeSnapshotLag(lagInput())).toBe(0);
    const resolution = getDbForWorkspace(
      { centerDb: t.db, instanceId: 'inst-cr23', port: 0, openWorkspaceDbs: true },
      { id: ws, path: wsPath, dbMode: 'localized' },
    );
    const exported = exportWorkspaceSnapshot({ db: resolution.db, workspacePath: wsPath });
    expect(existsSync(join(exported.dir, 'manifest.json'))).toBe(true);
    // 导出流程自身会开句柄，计数基线取在重算前，只断言「缓存已失效 → 确实重算一次」
    const opensBeforeRecompute = readonlyOpens();
    expect(computeSnapshotLag(lagInput())).toBe(0);
    expect(readonlyOpens() - opensBeforeRecompute).toBe(1);
  });
});

describe('CR2-3 对照基准：GET /api/workspaces 连续两次', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  beforeAll(async () => {
    resetResolverState();
    const fixture = await makeLocalizedFixture('http');
    t = fixture.t;
    root = fixture.root;
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    // 预热一次：填充 lag 缓存 + meta 常驻只读句柄
    const warm = await request(app).get('/api/workspaces');
    expect(warm.status).toBe(200);
    expect(warm.body[0].snapshot_lag).toBe(0);
  }, 120_000);

  afterAll(() => { cleanupFixture(t, root); });

  it('第二次 GET 不触发 readonly open，也不跑 lag COUNT（契约不变）', async () => {
    const opensBefore = readonlyOpens();
    const countsBefore = lagCountExecs;
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body[0].snapshot_lag).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(0);
    expect(lagCountExecs - countsBefore).toBe(0);
  });

  it('对照：缓存失效（invalidate）后 GET 会重算一次（证明计数口径有效）', async () => {
    invalidateSnapshotLagCache((await (await import('../src/db/repos/workspace.js')).listWorkspaces(t.db))[0]!.id);
    const opensBefore = readonlyOpens();
    const countsBefore = lagCountExecs;
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body[0].snapshot_lag).toBe(0);
    expect(readonlyOpens() - opensBefore).toBe(1);
    expect(lagCountExecs - countsBefore).toBe(1);
  });
});
