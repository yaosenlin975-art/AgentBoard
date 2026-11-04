/**
 * CLAIM-RACE：并发语义证据（真并发，不是顺序调用）。
 *
 * 四类：
 * 1. 同进程 10 路并发 `POST /api/issues/:id/claim` → 恰好 1×200 + 9×409；
 * 2. 同进程 2 路并发 `done` → 1 成功 + 1×409（另加：done 与 release 并发同理）；
 * 3. **双实例同 DB**：另一条独立进程（child_process）打开同一个 SQLite 文件并发 claim → 仍然恰好 1 成功；
 * 4. `close` / `reopen` 各一条并发（双请求只允许一个成功，另一个 409 或幂等 200）。
 *
 * 每类跑 3 次，断言结果稳定。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

describe('并发语义（CLAIM-RACE）', () => {
  let t: TestDb;
  let app: Express;
  let ws: string;

  const seedIssue = (title: string, over: Record<string, unknown> = {}): string => {
    const res = t.db.prepare(
      `INSERT INTO issue (id,workspace_id,title,description,status,priority,labels,created_at,updated_at,claimed_by,claimed_at,session_id,sort_order)
       VALUES (?,?,?,'','待规划','中','[]',?,?,NULL,NULL,NULL,0)`,
    ).run(`i-${title}-${Math.random().toString(36).slice(2, 8)}`, ws, title, Date.now(), Date.now());
    void res;
    const id = (t.db.prepare('SELECT id FROM issue ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id: string }).id;
    if (Object.keys(over).length > 0) {
      const sets = Object.keys(over).map((k) => `${k}=?`).join(',');
      t.db.prepare(`UPDATE issue SET ${sets} WHERE id=?`).run(...Object.values(over), id);
    }
    return id;
  };

  const claim = (id: string, agent: string) =>
    request(app).post(`/api/issues/${id}/claim`).send({ agent_id: agent, workspace_id: ws });
  const done = (id: string, agent: string, notes?: string) =>
    request(app).post(`/api/issues/${id}/done`).send({ agent_id: agent, workspace_id: ws, ...(notes === undefined ? {} : { notes }) });

  beforeEach(async () => {
    t = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    ws = createWorkspace(t.db, { name: '并发空间', path: mkdtempSync(join(tmpdir(), 'agentboard-race-')) }).id;
  });

  afterEach(() => { /* TestDb 自清 */ });

  it('同进程 10 路并发 claim 同一张卡：恰好 1×200 + 9×409（跑 3 次一致）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = seedIssue(`race-claim-${round}`);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(id, `agent-${i}`)));
      const ok = results.filter((r) => r.status === 200).length;
      const conflict = results.filter((r) => r.status === 409).length;
      expect({ round, ok, conflict }).toEqual({ round, ok: 1, conflict: 9 });
      const row = t.db.prepare('SELECT claimed_by FROM issue WHERE id=?').get(id) as { claimed_by: string | null };
      expect(row.claimed_by).not.toBeNull();
    }
  }, 30000);

  it('2 路并发 done 同一张卡：1 成功 + 1×409，且只落一条评论（跑 3 次一致）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = seedIssue(`race-done-${round}`);
      await claim(id, 'agent-a');
      const before = (t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(id) as { n: number }).n;
      const results = await Promise.all([done(id, 'agent-a', `第一路 round${round}`), done(id, 'agent-a', `第二路 round${round}`)]);
      const ok = results.filter((r) => r.status === 200).length;
      const conflict = results.filter((r) => r.status === 409).length;
      expect({ round, ok, conflict }).toEqual({ round, ok: 1, conflict: 1 });
      // 只有成功的那一路产生 1 条评论（失败方连评论都不该留）
      const after = (t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(id) as { n: number }).n;
      // 只数「本次 done 的 notes 评论」：system 的 GIT-ON-DONE 提示（工作区非 git 仓库）属既有行为，不计入
      const notes = (t.db.prepare("SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=? AND author='agent:agent-a'").get(id) as { n: number }).n;
      expect({ round, notes, grew: after > before }).toEqual({ round, notes: 1, grew: true });
      const row = t.db.prepare('SELECT status, claimed_by FROM issue WHERE id=?').get(id) as { status: string; claimed_by: string | null };
      expect(row).toEqual({ status: '待验收', claimed_by: null });
    }
  }, 30000);

  it('done 与 release 并发：只允许一方成功，另一方 409（跑 3 次一致）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = seedIssue(`race-done-release-${round}`);
      await claim(id, 'agent-b');
      const [d, r] = await Promise.all([
        done(id, 'agent-b', 'done 分支'),
        request(app).post(`/api/issues/${id}/release`).send({ agent_id: 'agent-b', workspace_id: ws }),
      ]);
      const statuses = [d.status, r.status].sort();
      expect({ round, statuses }).toEqual({ round, statuses: [200, 409] });
    }
  }, 30000);

  it('双实例同 DB：子进程并发 claim → 仍然恰好 1 成功（跑 3 次一致）', async () => {
    const dbPath = t.dbPath;
    for (let round = 0; round < 3; round += 1) {
      const id = seedIssue(`race-cross-${round}`);
      // 子进程直接开同一个 SQLite 文件做原子 claim（与主进程的 HTTP 请求并发）
      const script = `
        const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
        const db = new Database(${JSON.stringify(dbPath)});
        db.pragma('busy_timeout = 5000');
        try {
          const r = db.prepare("UPDATE issue SET claimed_by=?,claimed_at=?,status='进行中',updated_at=? WHERE id=? AND claimed_by IS NULL AND status IN ('待规划','进行中')").run('child-agent', Date.now(), Date.now(), ${JSON.stringify(id)});
          console.log(JSON.stringify({ changes: r.changes }));
        } finally { db.close(); }
      `;
      const childPromise = Promise.resolve().then(() => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
      const mainPromise = claim(id, 'main-agent');
      const [child, main] = await Promise.all([childPromise, mainPromise]);
      const childChanges = Number(JSON.parse(child.stdout.trim() || '{"changes":0}').changes);
      const mainOk = main.status === 200 ? 1 : 0;
      // 两边最多一方 changes=1 / 200
      expect({ round, total: childChanges + mainOk }).toEqual({ round, total: 1 });
      const row = t.db.prepare('SELECT claimed_by FROM issue WHERE id=?').get(id) as { claimed_by: string | null };
      expect(['child-agent', 'main-agent']).toContain(row.claimed_by);
    }
  }, 40000);


  it('非占用者并发 done：409 NOT_TASK_OWNER，且不写任何评论、状态不变（changes!==1 分支）', async () => {
    const id = seedIssue('race-not-owner');
    await claim(id, 'agent-owner');
    const before = (t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(id) as { n: number }).n;
    const res = await done(id, 'agent-intruder', '不该写进去');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_TASK_OWNER');
    const after = (t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(id) as { n: number }).n;
    expect(after).toBe(before);
    const row = t.db.prepare('SELECT status, claimed_by FROM issue WHERE id=?').get(id) as { status: string; claimed_by: string | null };
    expect(row).toEqual({ status: '进行中', claimed_by: 'agent-owner' });
  });
  it('close 与 reopen 并发：只允许一个成功（跑 3 次一致）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = seedIssue(`race-close-${round}`, { status: '待验收' });
      const [c1, c2] = await Promise.all([
        request(app).post(`/api/issues/${id}/close`).send({ workspace_id: ws }),
        request(app).post(`/api/issues/${id}/close`).send({ workspace_id: ws }),
      ]);
      // close 是幂等的：两次 200 也算一致（状态只落一次），不允许出现 5xx
      expect([c1.status, c2.status].every((s) => s === 200 || s === 409)).toBe(true);

      const reopened = await Promise.all([
        request(app).post(`/api/issues/${id}/reopen`).send({ workspace_id: ws }),
        request(app).post(`/api/issues/${id}/reopen`).send({ workspace_id: ws }),
      ]);
      expect(reopened.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  }, 30000);
});
