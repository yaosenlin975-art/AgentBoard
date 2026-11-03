import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { normalizeLabels } from '../src/services/labelNormalize.js';

/**
 * TAG-CLEANUP-EXEC：服务端 labels 规范化（与 CLI `parseLabels` 同一套规则）。
 * 以前只有 CLI 拆空格，直接 PATCH/POST 带空格的标签会原样落库 → 标签体系再次变脏。
 */
describe('labels 规范化（服务端请求边界）', () => {
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

  it('normalizeLabels：空白/半角逗号/全角逗号都拆，trim + 丢空 + 去重', () => {
    expect(normalizeLabels(['调研 跨平台 文档'])).toEqual(['调研', '跨平台', '文档']);
    expect(normalizeLabels(['web,server'])).toEqual(['web', 'server']);
    expect(normalizeLabels(['调研，跨平台'])).toEqual(['调研', '跨平台']);
    expect(normalizeLabels(['  测试 ,,  测试  ,文档  '])).toEqual(['测试', '文档']);
    expect(normalizeLabels(['功能 web UI 用户需求2026-11-03'])).toEqual(['功能', 'web', 'UI', '用户需求2026-11-03']);
    expect(normalizeLabels([])).toEqual([]);
  });

  it('POST 带空格标签 → 落库为拆分后的多项；PATCH 同样生效', async () => {
    const created = await request(app).post('/api/issues').send({
      workspace_id: workspaceId,
      title: '标签规范化',
      priority: '低',
      labels: ['功能 web UI', '调研，跨平台'],
    });
    expect(created.status).toBe(200);
    expect(created.body.labels).toEqual(['功能', 'web', 'UI', '调研', '跨平台']);

    const patched = await request(app).patch(`/api/issues/${created.body.id}`).send({ labels: ['缺陷  web', '测试, 测试'] });
    expect(patched.status).toBe(200);
    expect(patched.body.labels).toEqual(['缺陷', 'web', '测试']);

    const read = await request(app).get(`/api/issues/${created.body.id}`);
    expect(read.body.labels).toEqual(['缺陷', 'web', '测试']);
  });

  it('空标签数组清空所有标签', async () => {
    const created = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title: 'x', priority: '低', labels: ['a b'] });
    expect(created.body.labels).toEqual(['a', 'b']);
    const cleared = await request(app).patch(`/api/issues/${created.body.id}`).send({ labels: [] });
    expect(cleared.body.labels).toEqual([]);
  });
});
