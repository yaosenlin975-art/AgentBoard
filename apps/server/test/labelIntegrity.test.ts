import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './helpers.js';
import { createIssue, parseLabelsOrEmpty, tryParseLabels } from '../src/db/repos/issue.js';
import { inspectIssueLabels } from '../src/services/labelIntegrity.js';
import { createApp, type CreatedApp } from '../src/index.js';

/**
 * CR-5：labels 是 TEXT 无 JSON 约束，一行脏数据不能让整个看板列表 500。
 * 覆盖：容错解析口径、启动期体检报数、真实 createApp 下列表/详情不 500 且脏行按 [] 渲染。
 */
let t: TestDb;
let created: CreatedApp;
let spaceDir: string;
let workspaceId: string;

beforeEach(async () => {
  t = createTestDb();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-labels-'));
  created = await createApp({ db: t.db, refreshClisOnBoot: false });
  const ws = await request(created.app).post('/api/workspaces').send({ name: 'labels', path: spaceDir });
  expect(ws.status).toBe(200);
  workspaceId = ws.body.id as string;
});

afterEach(() => {
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

/** 造脏数据：绕开仓储直接改库，模拟旧版本写入 / 手工改库 / 外部工具写入 */
function corruptLabels(issueId: string, raw: string): void {
  t.db.prepare('UPDATE issue SET labels = ? WHERE id = ?').run(raw, issueId);
}

describe('CR-5 labels 容错解析', () => {
  it('只接受 JSON 字符串数组，其余一律判为无效', () => {
    expect(tryParseLabels('["server","缺陷"]')).toEqual(['server', '缺陷']);
    expect(tryParseLabels('[]')).toEqual([]);
    expect(tryParseLabels('[broken')).toBeNull();
    expect(tryParseLabels('{"a":1}')).toBeNull();
    expect(tryParseLabels('[1,2]')).toBeNull();
    expect(tryParseLabels('null')).toBeNull();
    expect(tryParseLabels(null)).toBeNull();
    expect(parseLabelsOrEmpty('[broken', 'issue-x')).toEqual([]);
  });

  it('启动期体检测出脏行并给出 issue id，且不改写数据', () => {
    const good = createIssue(t.db, { workspace_id: workspaceId, title: '正常卡', labels: ['server'] }).id;
    const bad = createIssue(t.db, { workspace_id: workspaceId, title: '脏卡' }).id;
    corruptLabels(bad, '{"broken"');

    const report = inspectIssueLabels(t.db);

    expect(report.scanned).toBe(2);
    expect(report.invalid.map(row => row.id)).toEqual([bad]);
    expect(report.invalid[0].workspace_id).toBe(workspaceId);
    // 体检只读：库里的原值仍在
    const raw = (t.db.prepare('SELECT labels FROM issue WHERE id = ?').get(bad) as { labels: string }).labels;
    expect(raw).toBe('{"broken"');
    const goodLabels = (t.db.prepare('SELECT labels FROM issue WHERE id = ?').get(good) as { labels: string }).labels;
    expect(JSON.parse(goodLabels)).toEqual(['server']);
  });

  it('真实 createApp 下脏 labels 不再打挂列表与详情：200 + 该卡 labels 为 []', async () => {
    const healthy = createIssue(t.db, { workspace_id: workspaceId, title: '健康卡', labels: ['server', '缺陷'] }).id;
    const dirty = createIssue(t.db, { workspace_id: workspaceId, title: '脏卡' }).id;
    corruptLabels(dirty, '[broken');

    const list = await request(created.app).get(`/api/issues?workspace_id=${workspaceId}`);
    expect(list.status).toBe(200);
    const rows = list.body as Array<{ id: string; labels: string[] }>;
    expect(rows.find(row => row.id === healthy)?.labels).toEqual(['server', '缺陷']);
    expect(rows.find(row => row.id === dirty)?.labels).toEqual([]);

    const detail = await request(created.app).get(`/api/issues/${dirty}`);
    expect(detail.status).toBe(200);
    expect(detail.body.labels).toEqual([]);
  });
});
