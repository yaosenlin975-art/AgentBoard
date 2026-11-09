/**
 * STATUS-3：kind 语义贯通（服务端）。
 *
 * - 关闭类 = `workspace_status.kind ∈ ('done','deprecated')`：后代替关闭计数、父卡关闭校验都按它判，
 *   不再比较状态名 `'已关闭'`。
 * - 依赖解除 = `kind ∈ ('review','done','deprecated')`：blocker 为「已废弃」时 `claim` 放行。
 * - 用自定义状态（kind=done，名字不叫「已关闭」）反证判定确实走 kind 而非名字。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createWorkspaceStatus, isClosedKind } from '../src/services/workspaceStatus.js';

describe('status kind semantics (STATUS-3)', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let ws: string;

  const mkIssue = async (title: string, parentId?: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(ws, { title, ...(parentId ? { parent_issue_id: parentId } : {}) }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  };
  const setStatus = (id: string, status: string) => request(app).patch(`/api/issues/${id}`).send({ status });
  const addDep = (blocked: string, blocker: string) =>
    request(app).post(`/api/issues/${blocked}/dependencies`).send({ workspace_id: ws, blocker_issue_id: blocker });

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-kind-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: 'kind 空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('isClosedKind只有done和deprecated', () => {
    expect(isClosedKind('done')).toBe(true);
    expect(isClosedKind('deprecated')).toBe(true);
    expect(isClosedKind('review')).toBe(false);
    expect(isClosedKind('started')).toBe(false);
    expect(isClosedKind('open')).toBe(false);
    expect(isClosedKind(null)).toBe(false);
  });

  it('已废弃子卡计入已关闭计数，父卡可关闭', async () => {
    const parent = await mkIssue('父卡');
    const deprecatedChild = await mkIssue('子卡-废弃', parent);
    const closedChild = await mkIssue('子卡-关闭', parent);
    expect((await setStatus(deprecatedChild, '已废弃')).status).toBe(200);
    expect((await setStatus(closedChild, '已关闭')).status).toBe(200);

    const tree = await request(app).get(`/api/issues/tree?workspace=${ws}`);
    expect(tree.status).toBe(200);
    const item = (tree.body.items as Array<Record<string, number | string>>).find(row => row.id === parent)!;
    expect(item).toMatchObject({ descendant_count: 2, descendants_closed_count: 2 });

    const closed = await setStatus(parent, '已关闭');
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('已关闭');
  });

  it('自定义 kind=done 状态（名字不叫已关闭）同样算关闭类', async () => {
    createWorkspaceStatus(t.db, { workspace_id: ws, name: '已验收', kind: 'done' });
    const parent = await mkIssue('父卡-自定义');
    const child = await mkIssue('子卡-已验收', parent);
    expect((await setStatus(child, '已验收')).status).toBe(200);

    const tree = await request(app).get(`/api/issues/tree?workspace=${ws}`);
    const item = (tree.body.items as Array<Record<string, number>>).find(row => row.id === parent)!;
    expect(item.descendants_closed_count).toBe(1);
    expect((await setStatus(parent, '已关闭')).status).toBe(200);
  });

  it('未关闭（待验收）子卡仍然阻止父卡关闭', async () => {
    const parent = await mkIssue('父卡-待验收子');
    const child = await mkIssue('子卡-待验收', parent);
    expect((await setStatus(child, '待验收')).status).toBe(200);
    const res = await setStatus(parent, '已关闭');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('未关闭');
  });

  it('自定义 kind=blocked 可建，非法 kind 被拒并列出可用值（ARCH-02）', async () => {
    const ok = await request(app).post(`/api/workspaces/${ws}/statuses`).send({ name: '等外部确认', kind: 'blocked' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ name: '等外部确认', kind: 'blocked', is_builtin: 0 });

    const bad = await request(app).post(`/api/workspaces/${ws}/statuses`).send({ name: '乱写', kind: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('blocked');
  });

  it('kind=blocked 的卡归入未完成默认收敛（ARCH-02）', async () => {
    createWorkspaceStatus(t.db, { workspace_id: ws, name: '等外部确认', kind: 'blocked' });
    const open = await mkIssue('开放卡');
    const blocked = await mkIssue('阻塞卡');
    expect((await setStatus(blocked, '等外部确认')).status).toBe(200);

    const list = await request(app).get(`/api/issues?workspace=${ws}&kinds=open,started,review,blocked&unclaimed=1`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const ids = (list.body as Array<{ id: string }>).map(row => row.id);
    expect(ids).toContain(blocked);
    expect(ids).toContain(open);

    // 旧口径（不含 blocked）仍然排除它，证明归类来自 kinds 参数而非名字
    const legacy = await request(app).get(`/api/issues?workspace=${ws}&kinds=open,started,review&unclaimed=1`);
    expect((legacy.body as Array<{ id: string }>).map(row => row.id)).not.toContain(blocked);
  });

  it('blocker 为已废弃时被阻塞卡可以 claim', async () => {
    const blocked = await mkIssue('被阻塞卡');
    const blocker = await mkIssue('前置卡-废弃');
    expect((await addDep(blocked, blocker)).status).toBe(201);
    // 未解除时 claim 被拒
    expect((await request(app).post(`/api/issues/${blocked}/claim`).send({ agent_id: 'fake' })).status).toBe(409);
    // blocker 设为已废弃（kind=deprecated）→ 视为解除
    expect((await setStatus(blocker, '已废弃')).status).toBe(200);
    const claimed = await request(app).post(`/api/issues/${blocked}/claim`).send({ agent_id: 'fake' });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.status).toBe('进行中');

    const list = await request(app).get(`/api/issues?workspace=${ws}`);
    const row = (list.body as Array<Record<string, unknown>>).find(item => item.id === blocked)!;
    expect(row).toMatchObject({ blocked_by_count: 1, blocked_by_open_count: 0, resolved: true });

    const deps = await request(app).get(`/api/issues/${blocked}/dependencies?workspace_id=${ws}`);
    expect(deps.body.blockers[0]).toMatchObject({ status: '已废弃', resolved: true });
  });

  it('blocker 仍进行中时被阻塞卡不能 claim', async () => {
    const blocked = await mkIssue('被阻塞卡二');
    const blocker = await mkIssue('前置卡-进行中');
    expect((await addDep(blocked, blocker)).status).toBe(201);
    expect((await request(app).post(`/api/issues/${blocker}/claim`).send({ agent_id: 'fake' })).status).toBe(200);
    const denied = await request(app).post(`/api/issues/${blocked}/claim`).send({ agent_id: 'fake' });
    expect(denied.status).toBe(409);
    expect(denied.body.error.message).toContain('前置卡-进行中');
  });
});
