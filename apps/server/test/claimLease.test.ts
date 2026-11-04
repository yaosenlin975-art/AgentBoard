/**
 * BORROW-0.2：占用租约（claim lease）。
 *
 * 覆盖卡面验收 5 条：
 * 1. 老库迁移：fence=0、lease/heartbeat NULL；
 * 2. 过期租约第二次 claim 成功抢占，未过期 409；
 * 3. heartbeat 推进租约与 last_heartbeat_at（fence 只读返回）；
 * 4. sweep 只清占用、任务保留「进行中」、system 评论、基线删除；
 * 5. 迁移幂等可重入。
 * 外加：REST /heartbeat 路由 + 不进幂等表。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Issue } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db/connection.js';
import { migrateClaimLease } from '../src/db/migrations/claimLease.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { claimIssue, doneIssue, heartbeatClaim, sweepExpiredLeases } from '../src/services/claim.js';
import { ApiError, ConflictError, NotFoundError } from '../src/errors.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
});

afterEach(() => {
  t.cleanup();
});

function seedIssue(title = '租约任务'): Issue {
  return createIssue(t.db, { workspace_id: wsId, title });
}

interface LeaseRow { claimed_by: string | null; claim_lease_until: number | null; claim_fence: number; last_heartbeat_at: number | null; status: string; }
function leaseRow(id: string): LeaseRow {
  return t.db.prepare('SELECT claimed_by, claim_lease_until, claim_fence, last_heartbeat_at, status FROM issue WHERE id=?').get(id) as LeaseRow;
}

describe('migrateClaimLease（老库迁移 + 幂等重入）', () => {
  it('老库补列：fence 默认 0、lease/heartbeat NULL；重跑幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-'));
    try {
      const db = openDb(join(dir, 'legacy.db'));
      db.exec('CREATE TABLE issue (id TEXT PRIMARY KEY, claimed_by TEXT)');
      db.exec("INSERT INTO issue (id, claimed_by) VALUES ('i1', 'agent-old')");
      migrateClaimLease(db);
      const row = db.prepare('SELECT claim_lease_until, claim_fence, last_heartbeat_at FROM issue WHERE id=?').get('i1') as LeaseRow;
      expect(row.claim_fence).toBe(0);
      expect(row.claim_lease_until).toBeNull();
      expect(row.last_heartbeat_at).toBeNull();
      const indexCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_issue_claim_lease'").get() as { n: number };
      expect(indexCount.n).toBe(1);
      // 重入：再跑两遍不抛错、不重复建索引
      migrateClaimLease(db);
      migrateClaimLease(db);
      const after = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_issue_claim_lease'").get() as { n: number };
      expect(after.n).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('新库：initSchema 建出的 issue 自带三列，未领取时 lease/heartbeat NULL、fence 0', () => {
    const issue = seedIssue();
    const row = leaseRow(issue.id);
    expect(row.claim_fence).toBe(0);
    expect(row.claim_lease_until).toBeNull();
    expect(row.last_heartbeat_at).toBeNull();
  });
});

describe('claimIssue 租约写入与过期抢占', () => {
  it('领取写回填：lease=领取时刻+租约窗、fence=1、heartbeat=领取时刻', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const issue = seedIssue();
      claimIssue(t.db, issue.id, 'agent-a', null);
      const row = leaseRow(issue.id);
      expect(row.claimed_by).toBe('agent-a');
      expect(row.claim_fence).toBe(1);
      expect(row.claim_lease_until).toBe(Date.now() + 900_000);
      expect(row.last_heartbeat_at).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('未过期占用：第二次 claim 409 ISSUE_CLAIMED', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    expect(() => claimIssue(t.db, issue.id, 'agent-b', null)).toThrowError(
      expect.objectContaining({ status: 409, code: 'ISSUE_CLAIMED' }) as ApiError,
    );
  });

  it('租约过期：第二个 agent 直接抢占成功，fence 自增', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
    const again = claimIssue(t.db, issue.id, 'agent-b', null);
    expect(again.claimed_by).toBe('agent-b');
    const row = leaseRow(issue.id);
    expect(row.claim_fence).toBe(2);
    expect(row.claim_lease_until).toBeGreaterThan(Date.now());
  });

  it('租约 NULL（存量占用）：不可抢占，仍 409', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    t.db.prepare('UPDATE issue SET claim_lease_until=NULL WHERE id=?').run(issue.id);
    expect(() => claimIssue(t.db, issue.id, 'agent-b', null)).toThrowError(
      expect.objectContaining({ status: 409, code: 'ISSUE_CLAIMED' }) as ApiError,
    );
  });
});

describe('heartbeatClaim 续租', () => {
  it('占用者续租：租约与 last_heartbeat_at 推进，fence 只读不变', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const issue = seedIssue();
      claimIssue(t.db, issue.id, 'agent-a', null);
      const firstLease = leaseRow(issue.id).claim_lease_until!;
      vi.advanceTimersByTime(5_000);
      const lease = heartbeatClaim(t.db, issue.id, 'agent-a');
      expect(lease.claimed_by).toBe('agent-a');
      expect(lease.claim_fence).toBe(1);
      expect(lease.claim_lease_until).toBe(firstLease + 5_000);
      expect(lease.last_heartbeat_at).toBe(Date.now());
      const row = leaseRow(issue.id);
      expect(row.claim_lease_until).toBe(firstLease + 5_000);
      expect(row.last_heartbeat_at).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('非占用者 409；无占用 ConflictError；任务不存在 NotFoundError', () => {
    const issue = seedIssue();
    expect(() => heartbeatClaim(t.db, issue.id, 'agent-x')).toThrowError(ConflictError);
    claimIssue(t.db, issue.id, 'agent-a', null);
    expect(() => heartbeatClaim(t.db, issue.id, 'agent-b')).toThrowError(
      expect.objectContaining({ status: 409, code: 'NOT_TASK_OWNER' }) as ApiError,
    );
    expect(() => heartbeatClaim(t.db, 'no-such-id', 'agent-a')).toThrowError(NotFoundError);
  });

  it('续租让过期线后退：过期租约续租后不再被 sweep 清掉', () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, issue.id);
    heartbeatClaim(t.db, issue.id, 'agent-a');
    expect(sweepExpiredLeases(t.db)).toBe(0);
    expect(leaseRow(issue.id).claimed_by).toBe('agent-a');
  });
});

describe('sweepExpiredLeases 启动清扫', () => {
  it('只清过期占用：状态保留「进行中」、system 评论、基线删除；未过期/NULL 租约不动', () => {
    const expired = seedIssue('过期');
    const fresh = seedIssue('未过期');
    const legacy = seedIssue('无租约');
    claimIssue(t.db, expired.id, 'agent-a', null);
    claimIssue(t.db, fresh.id, 'agent-b', null);
    claimIssue(t.db, legacy.id, 'agent-c', null);
    // 过期卡造一条假基线（captureIssueGitBaseline 依赖 git 环境，直接落行验证清理路径）
    t.db.prepare(
      `INSERT INTO issue_git_baseline (issue_id, workspace_id, head_sha, paths_json, file_count, captured_at)
       VALUES (?, ?, NULL, '[]', 0, ?)`,
    ).run(expired.id, wsId, Date.now());
    // legacy 卡去掉租约（模拟迁移前的存量占用）
    t.db.prepare('UPDATE issue SET claim_lease_until=NULL WHERE id=?').run(legacy.id);
    // 过期卡租约拨回过去
    t.db.prepare('UPDATE issue SET claim_lease_until=? WHERE id=?').run(Date.now() - 1, expired.id);

    expect(sweepExpiredLeases(t.db)).toBe(1);

    const swept = leaseRow(expired.id);
    expect(swept.claimed_by).toBeNull();
    expect(swept.status).toBe('进行中');
    expect(swept.claim_lease_until).toBeNull();
    expect(swept.last_heartbeat_at).toBeNull();
    expect(swept.claim_fence).toBe(1);
    const comments = listCommentsByIssue(t.db, expired.id);
    const systemComment = comments.find((c) => c.author === 'system');
    expect(systemComment?.content).toContain('占用租约过期');
    const baseline = t.db.prepare('SELECT COUNT(*) AS n FROM issue_git_baseline WHERE issue_id=?').get(expired.id) as { n: number };
    expect(baseline.n).toBe(0);

    expect(leaseRow(fresh.id).claimed_by).toBe('agent-b');
    expect(leaseRow(legacy.id).claimed_by).toBe('agent-c');

    // 再跑一遍：无可清，返回 0
    expect(sweepExpiredLeases(t.db)).toBe(0);
  });

  it('done 清占用后（租约已清），sweep 返回 0 且不动「待验收」', async () => {
    const issue = seedIssue();
    claimIssue(t.db, issue.id, 'agent-a', null);
    await doneIssue(t.db, issue.id, 'agent-a');
    expect(sweepExpiredLeases(t.db)).toBe(0);
    const row = leaseRow(issue.id);
    expect(row.status).toBe('待验收');
    expect(row.claimed_by).toBeNull();
  });
});

describe('REST POST /api/issues/:id/heartbeat', () => {
  let app: Express;

  beforeEach(async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });

  it('占用者心跳 200 返回租约快照；非占用者 409；不进幂等表', async () => {
    const issue = seedIssue();
    const claimRes = await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(claimRes.status).toBe(200);

    const beat = await request(app).post(`/api/issues/${issue.id}/heartbeat`)
      .set('Idempotency-Key', 'hb-1')
      .send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({ claimed_by: 'agent-a', claim_fence: 1 });
    expect(beat.body.claim_lease_until).toBeGreaterThan(Date.now());
    expect(beat.body.last_heartbeat_at).toBeGreaterThan(0);

    const forbidden = await request(app).post(`/api/issues/${issue.id}/heartbeat`).send({ agent_id: 'agent-b', workspace_id: wsId });
    expect(forbidden.status).toBe(409);

    const stored = t.db.prepare('SELECT COUNT(*) AS n FROM idempotency_record').get() as { n: number };
    expect(stored.n).toBe(0);
  });

  it('未占用任务心跳 409', async () => {
    const issue = seedIssue();
    const res = await request(app).post(`/api/issues/${issue.id}/heartbeat`).send({ agent_id: 'agent-a', workspace_id: wsId });
    expect(res.status).toBe(409);
  });
});
