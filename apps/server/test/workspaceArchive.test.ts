/**
 * STORE-7（M5）：
 * - `GET /api/workspaces` 回显只读 `db_mode` / `db_path` / `snapshot_lag`（真实 createApp）；
 * - 删除已下沉工作区 → db（含 -wal/-shm）+ attachments 移入 `<中心库目录>/archive/<id>/`，
 *   中心库落 `workspace_archive` 记录，归档列表可见（即使没有任何日志行）；
 * - 删除未下沉工作区 → 行为不变，不产生归档目录。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { resetResolverState } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { exportWorkspaceSnapshot } from '../src/services/workspaceSnapshot.js';
import { invalidateSnapshotLagCache } from '../src/services/workspaceSnapshotLag.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let created: CreatedApp;
let app: Express;
let root: string;

const attachmentsDir = (): string => join(dirname(t.db.name), 'attachments');
const archiveDir = (id: string): string => join(dirname(t.db.name), 'archive', id);

beforeEach(() => {
  resetResolverState();
  t = createTestDb();
  root = mkdtempSync(join(tmpdir(), 'agentboard-store7-'));
});

afterEach(async () => {
  resetResolverState();
  resetSessionManager();
  vi.restoreAllMocks();
  t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function boot(): Promise<void> {
  created = await createApp({ db: t.db, refreshClisOnBoot: false });
  app = created.app;
}

function mkSpace(name: string): { id: string; path: string } {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return { id: createWorkspace(t.db, { name, path }).id, path };
}

/** 中心附件目录放真实文件 + attachment 行（localize 会拷到工作区库目录） */
function seedAttachment(workspaceId: string): void {
  const key = '2026/11/store7.png';
  const file = join(attachmentsDir(), key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'PNGDATA-store7', 'utf8');
  t.db
    .prepare(
      "INSERT INTO attachment (id, workspace_id, storage_key, file_name, mime_type, kind, size_bytes, status, created_at, expires_at) VALUES ('att-store7', ?, ?, 'a.png', 'image/png', 'image', 14, 'attached', 1, 9999999999999)",
    )
    .run(workspaceId, key);
}

describe('STORE-7 GET /api/workspaces 只读回显', () => {
  it('db_mode / db_path / snapshot_lag 三字段存在，snapshot_lag 随快照与新增行变化', async () => {
    const ws = mkSpace('回显区');
    await boot();

    const first = await request(app).get('/api/workspaces');
    expect(first.status).toBe(200);
    const item = (first.body as Array<Record<string, unknown>>).find(row => row.id === ws.id);
    expect(item).toBeDefined();
    expect(item!.db_mode).toBe('center');
    expect(typeof item!.db_path).toBe('string');
    expect(item!.snapshot_lag).toBeNull();

    exportWorkspaceSnapshot({ db: t.db, workspacePath: ws.path, workspaceId: ws.id });
    const second = await request(app).get('/api/workspaces');
    const afterExport = (second.body as Array<Record<string, unknown>>).find(row => row.id === ws.id);
    expect(afterExport!.snapshot_lag).toBe(0);

    createIssue(t.db, { workspace_id: ws.id, title: '快照后新增', description: '', priority: '中', labels: [] } as never);
    // CR2-3：snapshot_lag 改为 60s TTL 缓存（见 workspaceSnapshotLag.ts），库行数变化按 TTL 收敛。
    // 本用例直接写库（不经 API 失效钩子），这里显式失效以断言重算后的落后条数。
    invalidateSnapshotLagCache(ws.id);
    const third = await request(app).get('/api/workspaces');
    const afterWrite = (third.body as Array<Record<string, unknown>>).find(row => row.id === ws.id);
    expect(afterWrite!.snapshot_lag).toBe(1);
  }, 30000);
});

describe('STORE-7 删除工作区归档', () => {
  it('已下沉工作区：库 + 附件移入 archive/<id>/，中心落记录，归档列表可见', async () => {
    const ws = mkSpace('下沉区');
    seedAttachment(ws.id);
    await localizeWorkspace(
      t.db,
      { workspaceId: ws.id, freeBytes: async () => 10 * 1024 * 1024 * 1024, attachmentsDir: attachmentsDir() },
      { attachmentsDir: attachmentsDir() },
    );
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws.id) as { db_mode: string }).db_mode).toBe('localized');
    await boot();

    const res = await request(app).delete(`/api/workspaces/${ws.id}`);
    expect(res.status).toBe(204);
    expect(res.headers['x-workspace-archived']).toBeDefined();
    expect(decodeURI(res.headers['x-workspace-archived'] as string)).toBe(archiveDir(ws.id));

    expect(existsSync(join(archiveDir(ws.id), 'agentboard.db'))).toBe(true);
    expect(existsSync(join(archiveDir(ws.id), 'attachments', '2026', '11', 'store7.png'))).toBe(true);
    // 工作区目录里的活库已移走，不留孤儿
    expect(existsSync(join(ws.path, '.agentboard', 'agentboard.db'))).toBe(false);

    const record = t.db.prepare('SELECT workspace_name, origin_path, archive_dir FROM workspace_archive WHERE workspace_id = ?').get(ws.id) as
      | { workspace_name: string; origin_path: string; archive_dir: string }
      | undefined;
    expect(record?.workspace_name).toBe('下沉区');
    expect(record?.archive_dir).toBe(archiveDir(ws.id));
    expect(t.db.prepare('SELECT id FROM workspace WHERE id = ?').get(ws.id)).toBeUndefined();

    const archived = await request(app).get('/api/changelog/archived-workspaces');
    expect(archived.status).toBe(200);
    const summary = (archived.body.items as Array<Record<string, unknown>>).find(row => row.origin_workspace_id === ws.id);
    expect(summary).toBeDefined();
    expect(summary!.entry_count).toBe(0);
  }, 30000);

  it('未下沉工作区：行为不变，不产生归档目录', async () => {
    const ws = mkSpace('中心区');
    await boot();

    const res = await request(app).delete(`/api/workspaces/${ws.id}`);
    expect(res.status).toBe(204);
    expect(res.headers['x-workspace-archived']).toBeUndefined();
    expect(existsSync(archiveDir(ws.id))).toBe(false);
    expect(t.db.prepare('SELECT workspace_id FROM workspace_archive WHERE workspace_id = ?').get(ws.id)).toBeUndefined();
  });
});
