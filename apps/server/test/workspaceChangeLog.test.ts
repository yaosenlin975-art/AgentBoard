/**
 * LOG01｜workspace_change_log 的 schema migration 与 repository：
 * - 幂等迁移：重复 initSchema 得到一致 schema，既有数据不动；
 * - 约束：change_type 四值、workspace_id/origin 一致性、revision>0；
 * - 工作区删除：日志保留、workspace_id 置 NULL、快照不变、活动列表查不到、归档可查；
 * - updated_at 单调递增、occurred_at DESC,id DESC 稳定排序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace, deleteWorkspace } from '../src/db/repos/workspace.js';
import {
  createChangeLog,
  deleteChangeLog,
  getActiveChangeLog,
  getArchivedChangeLog,
  listActiveChangeLogs,
  listArchivedChangeLogs,
  listArchivedWorkspaces,
  patchChangeLog,
} from '../src/db/repos/workspaceChangeLog.js';

let t: TestDb;
let wsA: { id: string; name: string; path: string; created_at: number };
let wsB: { id: string; name: string; path: string; created_at: number };

function schemaSignature(): unknown {
  return t.db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'workspace_change_log%' OR name LIKE 'changelog_%' ORDER BY name",
    )
    .all();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z'));
  t = createTestDb();
  wsA = createWorkspace(t.db, { name: 'A 空间', path: 'D:\\A' });
  wsB = createWorkspace(t.db, { name: 'B 空间', path: 'D:\\B' });
});

afterEach(() => {
  vi.useRealTimers();
  t.cleanup();
});

function mk(workspaceId: string, title: string, extra: Record<string, unknown> = {}) {
  const workspace = workspaceId === wsA.id ? wsA : wsB;
  return createChangeLog(t.db, workspace, {
    title,
    body_md: `${title} 正文`,
    change_type: '新增',
    actor: 'user',
    ...extra,
  } as Parameters<typeof createChangeLog>[2]);
}

describe('workspace_change_log migration', () => {
  it('幂等：重复 initSchema 得到一致 schema 且不清数据', () => {
    const before = schemaSignature();
    expect(before.length).toBeGreaterThan(0);
    mk(wsA.id, '已有日志');
    const rowsBefore = t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get();

    initSchema(t.db);
    initSchema(t.db);

    expect(schemaSignature()).toEqual(before);
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual(rowsBefore);
  });

  it('change_type 只接受 新增/修复/调整/历史（repository 校验 + DB CHECK 双保险）', () => {
    expect(() => mk(wsA.id, '合法', { change_type: '调整' })).not.toThrow();
    expect(() => mk(wsA.id, '非法', { change_type: '发布' })).toThrow(/change_type 不合法/);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO workspace_change_log (id,workspace_id,origin_workspace_id,origin_workspace_name,origin_workspace_path,title,body_md,change_type,occurred_at,created_by,updated_by,created_at,updated_at,revision)
           VALUES ('bad-type',?,?,?,?,'t','b','发布',1,'user','user',1,1,1)`,
        )
        .run(wsA.id, wsA.id, 'A', 'D:\\A'),
    ).toThrow(/CHECK constraint failed/);
  });

  it('workspace_id 必须等于 origin_workspace_id；revision 必须为正', () => {
    const log = mk(wsA.id, '快照校验');
    expect(log.origin_workspace_id).toBe(wsA.id);
    expect(log.origin_workspace_name).toBe('A 空间');
    expect(log.origin_workspace_path).toBe('D:\\A');
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO workspace_change_log (id,workspace_id,origin_workspace_id,origin_workspace_name,origin_workspace_path,title,body_md,change_type,occurred_at,created_by,updated_by,created_at,updated_at,revision)
           VALUES ('bad-1',?,?,?,?,'t','b','新增',1,'user','user',1,1,1)`,
        )
        .run(wsB.id, wsA.id, 'A', 'D:\\A'),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO workspace_change_log (id,workspace_id,origin_workspace_id,origin_workspace_name,origin_workspace_path,title,body_md,change_type,occurred_at,created_by,updated_by,created_at,updated_at,revision)
           VALUES ('bad-2',?,?,?,?,'t','b','新增',1,'user','user',1,1,0)`,
        )
        .run(wsA.id, wsA.id, 'A', 'D:\\A'),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('workspace_change_log 与工作区删除', () => {
  it('删工作区后日志保留、workspace_id 置 NULL、快照不变、活动查不到、归档可查', () => {
    const log = mk(wsA.id, '将被归档');
    mk(wsB.id, '别的空间');

    deleteWorkspace(t.db, wsA.id);

    const row = t.db.prepare('SELECT * FROM workspace_change_log WHERE id=?').get(log.id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.workspace_id).toBeNull();
    expect(row.origin_workspace_id).toBe(wsA.id);
    expect(row.origin_workspace_name).toBe('A 空间');
    expect(row.origin_workspace_path).toBe('D:\\A');

    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0 }).items).toEqual([]);
    expect(listActiveChangeLogs(t.db, wsB.id, { limit: 10, offset: 0 }).items.map((l) => l.title)).toEqual(['别的空间']);
    expect(listArchivedChangeLogs(t.db, wsA.id, { limit: 10, offset: 0 }).items.map((l) => l.id)).toEqual([log.id]);
    expect(listArchivedChangeLogs(t.db, wsB.id, { limit: 10, offset: 0 }).items).toEqual([]);
    expect(listArchivedWorkspaces(t.db, 10, 0).items).toEqual([
      { origin_workspace_id: wsA.id, origin_workspace_name: 'A 空间', origin_workspace_path: 'D:\\A', entry_count: 1, last_occurred_at: log.occurred_at },
    ]);
    expect(getArchivedChangeLog(t.db, wsA.id, log.id)?.title).toBe('将被归档');
    // 跨 origin 不可见
    expect(getArchivedChangeLog(t.db, wsB.id, log.id)).toBeNull();
    expect(getActiveChangeLog(t.db, wsA.id, log.id)).toBeNull();
  });
});

describe('workspace_change_log CRUD 语义', () => {
  it('创建写入快照与 revision=1；PATCH 递增 revision 且 updated_at 单调', () => {
    const created = mk(wsA.id, '标题 A');
    expect(created.revision).toBe(1);
    expect(created.change_type).toBe('新增');
    expect(created.created_by).toBe('user');

    // 同一毫秒内连续两次更新，updated_at 仍必须递增
    const first = patchChangeLog(t.db, {
      workspace_id: wsA.id,
      id: created.id,
      expected_revision: 1,
      actor: 'user',
      patch: { title: '标题 A2' },
    });
    const second = patchChangeLog(t.db, {
      workspace_id: wsA.id,
      id: created.id,
      expected_revision: 2,
      actor: 'agent:codex',
      patch: { body_md: '正文 A2' },
    });
    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
    expect(second.updated_by).toBe('agent:codex');
    expect(second.title).toBe('标题 A2');
  });

  it('过期 revision 的 PATCH/DELETE 报 409 且不改数据；删除后详情 404', () => {
    const created = mk(wsA.id, '并发保护');
    patchChangeLog(t.db, { workspace_id: wsA.id, id: created.id, expected_revision: 1, actor: 'user', patch: { title: 'v2' } });

    expect(() =>
      patchChangeLog(t.db, { workspace_id: wsA.id, id: created.id, expected_revision: 1, actor: 'user', patch: { title: 'stale' } }),
    ).toThrow(expect.objectContaining({ code: 'CHANGELOG_REVISION_CONFLICT', status: 409 }));
    expect(getActiveChangeLog(t.db, wsA.id, created.id)?.title).toBe('v2');

    expect(() => deleteChangeLog(t.db, { workspace_id: wsA.id, id: created.id, expected_revision: 1 })).toThrow(
      expect.objectContaining({ code: 'CHANGELOG_REVISION_CONFLICT', status: 409 }),
    );
    expect(getActiveChangeLog(t.db, wsA.id, created.id)).not.toBeNull();

    deleteChangeLog(t.db, { workspace_id: wsA.id, id: created.id, expected_revision: 2 });
    expect(getActiveChangeLog(t.db, wsA.id, created.id)).toBeNull();
    expect(() => deleteChangeLog(t.db, { workspace_id: wsA.id, id: created.id, expected_revision: 2 })).toThrow(
      expect.objectContaining({ code: 'CHANGELOG_NOT_FOUND', status: 404 }),
    );
  });

  it('跨工作区不可见：别的空间的 id 视为不存在', () => {
    const log = mk(wsA.id, '属于 A');
    expect(getActiveChangeLog(t.db, wsB.id, log.id)).toBeNull();
    expect(() => deleteChangeLog(t.db, { workspace_id: wsB.id, id: log.id, expected_revision: 1 })).toThrow(
      expect.objectContaining({ code: 'CHANGELOG_NOT_FOUND', status: 404 }),
    );
  });

  it('occurred_at DESC,id DESC 稳定排序；编辑标题不改变排序', () => {
    const a = mk(wsA.id, 'a', { occurred_at: 1000 });
    const b = mk(wsA.id, 'b', { occurred_at: 1000 });
    const c = mk(wsA.id, 'c', { occurred_at: 2000 });
    const ids = listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0 }).items.map((l) => l.id);
    expect(ids).toEqual([c.id, ...[a.id, b.id].sort().reverse()]);

    patchChangeLog(t.db, { workspace_id: wsA.id, id: a.id, expected_revision: 1, actor: 'user', patch: { title: 'a2' } });
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0 }).items.map((l) => l.id)).toEqual(ids);
  });

  it('字面搜索：标题/正文子串命中，% _ \\ 按字面处理，空查询恢复全量；类型筛选可与 q 组合', () => {
    mk(wsA.id, '缓存失效 100%', { body_md: '正文含 a_b' });
    mk(wsA.id, '缓存失效', { body_md: '正文含 axb', change_type: '修复' });
    mk(wsA.id, '其它标题', { body_md: '无关正文', change_type: '调整' });

    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: '缓存失效' }).items).toHaveLength(2);
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: '100%' }).items).toHaveLength(1);
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: 'a_b' }).items).toHaveLength(1);
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: 'a%b' }).items).toHaveLength(0);
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: '缓存失效', change_type: '修复' }).items).toHaveLength(1);
    expect(listActiveChangeLogs(t.db, wsA.id, { limit: 10, offset: 0, q: '' }).items).toHaveLength(3);
  });
});
