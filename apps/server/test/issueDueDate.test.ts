import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

/**
 * DUE-DATE：`due_date`（YYYY-MM-DD）+ `due_time`（HH:mm）两条独立可空字段的三条路径、非法格式与清除。
 * 逾期判定本身在前端（apps/web/src/lib/planningSort.ts），服务端只负责存取与校验格式。
 */
describe('issue due date / time（DUE-DATE）', () => {
  let t: TestDb;
  let app: Express;
  let workspaceId: string;
  beforeEach(() => {
    t = createTestDb();
    workspaceId = createWorkspace(t.db, { name: 'A', path: 'A' }).id;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} }));
    app.use(errorHandler);
  });
  afterEach(() => t.cleanup());

  const create = (extra: Record<string, unknown> = {}) =>
    request(app).post('/api/issues').send(issuePayload(workspaceId, { title: '截止测试', priority: '低', ...extra }));

  it('三条路径：有日期无时间 / 有日期有时间 / 无日期，落库与回读一致', async () => {
    const dateOnly = await create({ due_date: '2026-11-10' });
    expect(dateOnly.status).toBe(200);
    expect(dateOnly.body).toMatchObject({ due_date: '2026-11-10', due_time: null });

    const withTime = await create({ due_date: '2026-11-10', due_time: '14:30' });
    expect(withTime.status).toBe(200);
    expect(withTime.body).toMatchObject({ due_date: '2026-11-10', due_time: '14:30' });

    const none = await create();
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ due_date: null, due_time: null });

    for (const id of [dateOnly.body.id, withTime.body.id, none.body.id]) {
      const read = await request(app).get(`/api/issues/${id}`);
      expect(read.status).toBe(200);
      expect(read.body.due_date).toBe([dateOnly.body, withTime.body, none.body].find((p) => p.id === id)?.due_date ?? null);
    }
    // 列表投影同样带出
    const list = await request(app).get('/api/issues').query({ workspace: workspaceId });
    const rows = (Array.isArray(list.body) ? list.body : (list.body.items ?? [])) as Array<{ id: string; due_date: string | null; due_time: string | null }>;
    const row = rows.find((item) => item.id === withTime.body.id);
    expect(row).toMatchObject({ due_date: '2026-11-10', due_time: '14:30' });
  });

  it('非法格式 → 400（日期与时间各自校验）', async () => {
    for (const bad of ['2026/11/10', '2026-1-5', '20261110', '2026-11-10T14:30']) {
      const res = await create({ due_date: bad });
      expect(res.status, `due_date=${bad}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const bad of ['25:00', '14:5', '1430', '14:30:00']) {
      const res = await create({ due_date: '2026-11-10', due_time: bad });
      expect(res.status, `due_time=${bad}`).toBe(400);
    }
  });

  it('PATCH 可独立改/清两个字段', async () => {
    const created = await create({ due_date: '2026-11-10', due_time: '09:00' });
    const id = created.body.id;

    const timeCleared = await request(app).patch(`/api/issues/${id}`).send({ due_time: null });
    expect(timeCleared.status).toBe(200);
    expect(timeCleared.body).toMatchObject({ due_date: '2026-11-10', due_time: null });

    const dateMoved = await request(app).patch(`/api/issues/${id}`).send({ due_date: '2026-12-01' });
    expect(dateMoved.body).toMatchObject({ due_date: '2026-12-01', due_time: null });

    const cleared = await request(app).patch(`/api/issues/${id}`).send({ due_date: null });
    expect(cleared.body).toMatchObject({ due_date: null, due_time: null });

    const badPatch = await request(app).patch(`/api/issues/${id}`).send({ due_date: 'nope' });
    expect(badPatch.status).toBe(400);
  });
});
