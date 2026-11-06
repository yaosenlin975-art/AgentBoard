/**
 * DEC-3：决策 REST 与 WS 事件（路由层单测，独立挂载 createDecisionRouter，不依赖 routes.ts 的他人未提交改动）。
 *
 * 说明：本卡原计划把挂载行加进 routes.ts；开工时 routes.ts/schemas.ts 存在他人（STORE-3a）未提交改动，
 * 按 RULE-2「同文件单 owner」停手，先用独立挂载验证全部契约，挂载与 schemas 迁入留待文件释放（见卡评论）。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionEvent, ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { insertDecision, listDecisions } from '../src/db/repos/decision.js';
import { claimIssue } from '../src/services/claim.js';
import { createDecisionRouter } from '../src/api/decisionRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';

let t: TestDb;
let wsId: string;
let app: express.Express;
let events: ServerWsEvent[];
let agentIssue: { id: string; fence: number };

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
  events = [];
  const issue = createIssue(t.db, { workspace_id: wsId, title: 'REST 决策卡' });
  const claimed = claimIssue(t.db, issue.id, 'agent-1', null);
  agentIssue = { id: claimed.id, fence: claimed.claim_fence };
  app = express();
  app.use(express.json());
  app.use(
    '/api',
    createDecisionRouter({
      db: t.db,
      broadcast: (event: ServerWsEvent) => events.push(event),
    }),
  );
  app.use(errorHandler);
});

afterEach(() => {
  t.cleanup();
});

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

function askBody(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'agent-1',
    fence: agentIssue.fence,
    question: '继续还是停止？',
    options: OPTIONS,
    ...overrides,
  };
}

function ask(overrides: Record<string, unknown> = {}) {
  return request(app).post(`/api/issues/${agentIssue.id}/ask`).send(askBody(overrides));
}

/** 决策域事件（含 issue.stop_requested）；issue.changed 另算（卡面投影刷新） */
function decisionEvents(): DecisionEvent[] {
  return events.filter(
    (event) => event.type.startsWith('decision.') || event.type === 'issue.stop_requested',
  ) as DecisionEvent[];
}

function issueChanges() {
  return events.filter((event) => event.type === 'issue.changed');
}

describe('POST /issues/:id/ask', () => {
  it('201 建 grace 决策：卡保持进行中，广播 decision.grace_started（带 grace_until）', async () => {
    const response = await ask();
    expect(response.status).toBe(201);
    expect(response.body.decision.state).toBe('grace');
    expect(response.body.decision.grace_seconds).toBe(180);
    expect(response.body.decision.remaining_grace_seconds).toBeGreaterThan(170);
    const row = t.db.prepare('SELECT status,claimed_by,claim_fence FROM issue WHERE id=?').get(agentIssue.id) as {
      status: string;
      claimed_by: string;
      claim_fence: number;
    };
    expect(row).toEqual({ status: '进行中', claimed_by: 'agent-1', claim_fence: agentIssue.fence });
    expect(decisionEvents()).toHaveLength(1);
    expect(decisionEvents()[0]).toMatchObject({
      type: 'decision.grace_started',
      issue_id: agentIssue.id,
      workspace_id: wsId,
      decision_id: response.body.decision.id,
      state: 'grace',
    });
    expect(decisionEvents()[0].grace_until).toBeTypeOf('number');
    // 卡面投影也随刷新广播（§5.3：issue.changed 继续用于卡面锁标识）
    expect(issueChanges()).toHaveLength(1);
    expect(issueChanges()[0]).toMatchObject({ type: 'issue.changed', issue: { id: agentIssue.id } });
  });

  it('grace_seconds=0 → 201 直接落锁：卡转待规划、bump fence、广播 decision.expired + issue.stop_requested', async () => {
    const response = await ask({ grace_seconds: 0 });
    expect(response.status).toBe(201);
    expect(response.body.decision.state).toBe('open');
    expect(response.body.decision.locked_at).toBeTypeOf('number');
    const row = t.db.prepare('SELECT status,claimed_by,claim_fence FROM issue WHERE id=?').get(agentIssue.id) as {
      status: string;
      claimed_by: string | null;
      claim_fence: number;
    };
    expect(row).toEqual({ status: '待规划', claimed_by: null, claim_fence: agentIssue.fence + 1 });
    expect(decisionEvents()).toHaveLength(2);
    expect(decisionEvents()[0]).toMatchObject({ type: 'decision.expired', state: 'open', reason: 'grace_zero' });
    expect(decisionEvents()[1]).toMatchObject({ type: 'issue.stop_requested', state: 'open', reason: 'grace_zero' });
  });

  it('未占用/他人占用 409 NOT_TASK_OWNER；旧 fence 409 STALE_FENCE；非进行中 409 ISSUE_STATUS_NOT_RUNNING', async () => {
    const issue2 = createIssue(t.db, { workspace_id: wsId, title: '未占用卡' });
    const notClaimed = await request(app)
      .post(`/api/issues/${issue2.id}/ask`)
      .send(askBody({ fence: 1 }));
    expect(notClaimed.status).toBe(409);
    expect(notClaimed.body.error.code).toBe('NOT_TASK_OWNER');

    const mismatch = await ask({ agent_id: 'agent-2' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('NOT_TASK_OWNER');

    const stale = await ask({ fence: agentIssue.fence - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_FENCE');

    t.db.prepare("UPDATE issue SET status='待验收' WHERE id=?").run(agentIssue.id);
    const notRunning = await ask();
    expect(notRunning.status).toBe(409);
    expect(notRunning.body.error.code).toBe('ISSUE_STATUS_NOT_RUNNING');
  });

  it('宽限越界 400 INVALID_GRACE（-1/601），不静默截断', async () => {
    for (const bad of [-1, 601]) {
      const response = await ask({ grace_seconds: bad });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_GRACE');
    }
  });

  it('同一卡重复提问 409 DECISION_ALREADY_OPEN', async () => {
    await ask();
    const second = await ask({ question: '第二个问题？' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DECISION_ALREADY_OPEN');
  });

  it('选项 <2 / 重复 label / 空 consequence → 400 ASK_TOO_FEW_OPTIONS', async () => {
    const tooFew = await ask({ options: [OPTIONS[0]] });
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error.code).toBe('ASK_TOO_FEW_OPTIONS');
    const dup = await ask({ options: [OPTIONS[0], { label: '继续', consequence: '另一个后果' }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('ASK_TOO_FEW_OPTIONS');
    const emptyConsequence = await ask({ options: [{ label: 'A', consequence: ' ' }, OPTIONS[1]] });
    expect(emptyConsequence.status).toBe(400);
    expect(emptyConsequence.body.error.code).toBe('ASK_TOO_FEW_OPTIONS');
  });

  it('同 agent 同工作区在途 >3 → 429 ASK_RATE_LIMITED（含冷却文案）', async () => {
    for (let i = 0; i < 3; i += 1) {
      const issue = createIssue(t.db, { workspace_id: wsId, title: `限流卡${i}` });
      claimIssue(t.db, issue.id, 'agent-1', null);
      const response = await request(app).post(`/api/issues/${issue.id}/ask`).send({
        agent_id: 'agent-1',
        question: `问题${i}`,
        options: OPTIONS,
      });
      expect(response.status).toBe(201);
    }
    const fourth = createIssue(t.db, { workspace_id: wsId, title: '限流卡3' });
    claimIssue(t.db, fourth.id, 'agent-1', null);
    const limited = await request(app).post(`/api/issues/${fourth.id}/ask`).send({
      agent_id: 'agent-1',
      question: '第四条',
      options: OPTIONS,
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('ASK_RATE_LIMITED');
    expect(String(limited.body.error.message)).toContain('3');
  });
});

describe('回答 / 修订 / 撤回', () => {
  async function seededDecision(grace?: number): Promise<string> {
    const response = await ask(grace === undefined ? {} : { grace_seconds: grace });
    return response.body.decision.id as string;
  }

  it('按序号回答：200 + revision=1 + 广播 decision.answered；重复回答 409', async () => {
    const decisionId = await seededDecision();
    const answered = await request(app).post(`/api/decisions/${decisionId}/answer`).send({ option_ord: 1 });
    expect(answered.status).toBe(200);
    expect(answered.body.decision.state).toBe('answered');
    expect(answered.body.decision.answer_revision).toBe(1);
    expect(decisionEvents().at(-1)).toMatchObject({ type: 'decision.answered', decision_id: decisionId, revision: 1 });
    const again = await request(app).post(`/api/decisions/${decisionId}/answer`).send({ option_ord: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DECISION_ALREADY_ANSWERED');
  });

  it('expected_revision 修订：revision=2 广播 decision.revised；旧版本 409 DECISION_REVISION_CONFLICT', async () => {
    const decisionId = await seededDecision();
    await request(app).post(`/api/decisions/${decisionId}/answer`).send({ option_ord: 1 });
    const revised = await request(app)
      .post(`/api/decisions/${decisionId}/answer`)
      .send({ option_ord: 2, answer_text: '改成停止', expected_revision: 1 });
    expect(revised.status).toBe(200);
    expect(revised.body.decision.answer_revision).toBe(2);
    expect(decisionEvents().at(-1)).toMatchObject({ type: 'decision.revised', revision: 2 });
    const stale = await request(app)
      .post(`/api/decisions/${decisionId}/answer`)
      .send({ option_ord: 1, expected_revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('DECISION_REVISION_CONFLICT');
  });

  it('回答必须给选项或文本；已撤回 409 DECISION_WITHDRAWN', async () => {
    const decisionId = await seededDecision();
    const empty = await request(app).post(`/api/decisions/${decisionId}/answer`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    const withdrawn = await request(app).post(`/api/decisions/${decisionId}/withdraw`).send({ reason: '误报' });
    expect(withdrawn.status).toBe(200);
    expect(decisionEvents().at(-1)).toMatchObject({ type: 'decision.withdrawn', state: 'withdrawn' });
    const answered = await request(app).post(`/api/decisions/${decisionId}/answer`).send({ option_ord: 1 });
    expect(answered.status).toBe(409);
    expect(answered.body.error.code).toBe('DECISION_WITHDRAWN');
  });

  it('撤回缺 reason → 400；非提问者 agent 撤回 → 403', async () => {
    const decisionId = await seededDecision();
    const noReason = await request(app).post(`/api/decisions/${decisionId}/withdraw`).send({});
    expect(noReason.status).toBe(400);
    const forbidden = await request(app)
      .post(`/api/decisions/${decisionId}/withdraw`)
      .send({ by: 'agent-2', reason: '我来撤回' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });
});

describe('查询 / 计数 / 停止信号', () => {
  it('GET /decisions 缺 workspace_id 400；带过滤返回列表与计数', async () => {
    const missing = await request(app).get('/api/decisions');
    expect(missing.status).toBe(400);
    await ask({ grace_seconds: 0 });
    const list = await request(app).get(`/api/decisions?workspace_id=${wsId}`);
    expect(list.status).toBe(200);
    expect(list.body.decisions).toHaveLength(1);
    expect(list.body.decisions[0]).toMatchObject({ issue_id: agentIssue.id, state: 'open', option_count: 2 });
    expect(list.body.counts).toMatchObject({ grace: 0, open: 1 });
    const graceOnly = await request(app).get(`/api/decisions?workspace_id=${wsId}&state=grace`);
    expect(graceOnly.body.decisions).toHaveLength(0);
  });

  it('GET /decisions/:id 详情含选项与答案；未知 404', async () => {
    const response = await ask();
    const decisionId = response.body.decision.id as string;
    const detail = await request(app).get(`/api/decisions/${decisionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.decision.options.map((option: { label: string }) => option.label)).toEqual(['继续', '停止']);
    expect(detail.body.decision.answers).toEqual([]);
    const missing = await request(app).get('/api/decisions/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('GET /issues/:id/stop：open → stop_requested=true；answered → false；stop-ack 只写观测字段', async () => {
    const decisionId = (await ask({ grace_seconds: 0 })).body.decision.id as string;
    const stop = await request(app).get(`/api/issues/${agentIssue.id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ issue_id: agentIssue.id, stop_requested: true, decision_id: decisionId });
    const ack = await request(app).post(`/api/issues/${agentIssue.id}/stop-ack`);
    expect(ack.status).toBe(200);
    expect(ack.body.stop_ack_at).toBeTypeOf('number');
    const row = t.db.prepare('SELECT stop_ack_at FROM issue_decision WHERE id=?').get(decisionId) as {
      stop_ack_at: number | null;
    };
    expect(row.stop_ack_at).toBeTypeOf('number');
    await request(app).post(`/api/decisions/${decisionId}/answer`).send({ option_ord: 1 });
    const after = await request(app).get(`/api/issues/${agentIssue.id}/stop`);
    expect(after.body.stop_requested).toBe(false);
  });

  it('GET /workspaces/:id/decisions/count 返回四类计数', async () => {
    await ask();
    const counts = await request(app).get(`/api/workspaces/${wsId}/decisions/count`);
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual({ grace: 1, open: 0, stale_open: 0, answered_recent: 0 });
  });
});

describe('DEC-V4-API-LIST：列表投影（options / issue_priority / blocked_downstream_count）', () => {
  it('列表项内联 options（ord 升序）与 issue_priority，无下游计数为 0 而非 null', async () => {
    await ask({
      options: [
        { label: '继续', consequence: '继续执行' },
        { label: '停止', consequence: '停在检查点' },
        { label: '降级', consequence: '只做一半' },
      ],
    });
    const list = await request(app).get(`/api/decisions?workspace_id=${wsId}&limit=50`);
    expect(list.status).toBe(200);
    expect(list.body.decisions).toHaveLength(1);
    const item = list.body.decisions[0];
    expect(item.option_count).toBe(3);
    expect(item.options.map((option: { ord: number }) => option.ord)).toEqual([1, 2, 3]);
    expect(item.options.map((option: { label: string }) => option.label)).toEqual(['继续', '停止', '降级']);
    expect(item.options[0]).toMatchObject({ consequence: '继续执行' });
    expect([0, 1]).toContain(item.options[0].is_default);
    expect(item.issue_priority).toBe('中');
    expect(item.blocked_downstream_count).toBe(0);
  });

  it('A blocks B 后 A 的 blocked_downstream_count 从 0 变 1；related 边不计入', async () => {
    const downstream = createIssue(t.db, { workspace_id: wsId, title: '下游卡', priority: '高' });
    await ask();
    const before = await request(app).get(`/api/decisions?workspace_id=${wsId}`);
    expect(before.body.decisions[0].blocked_downstream_count).toBe(0);

    t.db
      .prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES (?,?,?,?)')
      .run(downstream.id, agentIssue.id, 'blocks', Date.now());
    // 另建一条 related 标注边，验证非 blocks 边不计数
    const relatedIssue = createIssue(t.db, { workspace_id: wsId, title: '关联卡' });
    t.db
      .prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES (?,?,?,?)')
      .run(relatedIssue.id, agentIssue.id, 'related', Date.now());

    const after = await request(app).get(`/api/decisions?workspace_id=${wsId}`);
    expect(after.body.decisions[0].blocked_downstream_count).toBe(1);
    expect(after.body.decisions[0].issue_priority).toBe('中');
  });

  it('50 条决策列表批量取选项：prepare 次数 ≤3（无 N+1）', () => {
    for (let index = 0; index < 50; index += 1) {
      const issue = createIssue(t.db, { workspace_id: wsId, title: `批量卡${index}` });
      insertDecision(t.db, {
        workspace_id: wsId,
        issue_id: issue.id,
        question: `问题${index}？`,
        created_by: 'agent-1',
        grace_seconds: 180,
        grace_until: Date.now() + 180_000,
        now: Date.now() + index,
        options: [
          { label: 'A', consequence: '选 A' },
          { label: 'B', consequence: '选 B' },
          { label: 'C', consequence: '选 C' },
        ],
      });
    }
    let prepared = 0;
    const countingDb = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (...args: unknown[]) => {
            prepared += 1;
            return (target.prepare as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof t.db;

    const items = listDecisions(countingDb, { workspace_id: wsId, limit: 50 });
    expect(items).toHaveLength(50);
    expect(items.every((item) => item.options.length === 3)).toBe(true);
    expect(items[0]!.options.map((option) => option.ord)).toEqual([1, 2, 3]);
    expect(prepared).toBeLessThanOrEqual(3);
  });
});

describe('DEC-V4-API-LIST：真实 createApp 下新字段对外可触达', () => {
  let t2: TestDb;
  let realApp: express.Express;
  let realWsId: string;
  let realIssue: { id: string; fence: number };

  beforeEach(async () => {
    t2 = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t2.db,
      getAdapter: (id: string) => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      maxConcurrentTurns: 1,
      refreshClisOnBoot: false,
    });
    realApp = created.app;
    realWsId = createWorkspace(t2.db, { name: 'ws-real', path: 'D:\\ws-real' }).id;
    const issue = createIssue(t2.db, { workspace_id: realWsId, title: '真实 app 决策卡', priority: '高' });
    realIssue = claimIssue(t2.db, issue.id, 'agent-real', null);
  });

  afterEach(() => {
    t2.cleanup();
  });

  it('GET /api/decisions 返回 options / issue_priority / blocked_downstream_count', async () => {
    const asked = await request(realApp).post(`/api/issues/${realIssue.id}/ask`).send({
      agent_id: 'agent-real',
      fence: realIssue.fence,
      question: '选哪条？',
      options: [
        { label: '继续', consequence: '继续执行' },
        { label: '停止', consequence: '停在检查点' },
        { label: '降级', consequence: '只做一半' },
      ],
    });
    expect(asked.status).toBe(201);

    const downstream = createIssue(t2.db, { workspace_id: realWsId, title: '真实下游卡' });
    t2.db
      .prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES (?,?,?,?)')
      .run(downstream.id, realIssue.id, 'blocks', Date.now());

    const list = await request(realApp).get(`/api/decisions?workspace_id=${realWsId}&limit=50`);
    expect(list.status).toBe(200);
    const item = list.body.decisions[0];
    expect(item.options).toHaveLength(3);
    expect(item.options.map((option: { ord: number }) => option.ord)).toEqual([1, 2, 3]);
    expect(item.issue_priority).toBe('高');
    expect(item.blocked_downstream_count).toBe(1);
  });
});
