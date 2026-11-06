/**
 * SMART-CREATE：`POST /api/issues/draft`（不落库）。
 *
 * 覆盖四条路径 + 结构断言：
 * - 成功：返回 title/description/labels/warnings，**不落库**（issue 表无新增）；
 * - 「不补要求」fixture：一句话需求 + 模型只给 requirements → description 的「验收」段必须是「未提供」；
 * - 模型自造标签 → 丢弃并进 warnings（只允许工作区已有标签）；
 * - JSON 不合法 → 重试 1 次 → 仍不合法 → 422 `DRAFT_INVALID_OUTPUT`（不抛 500）；
 * - 适配器失败 → 502 `DRAFT_ADAPTER_FAILED`；超时 → 504 `DRAFT_TIMEOUT`；
 * - 审计只记 adapter/耗时/成败/warning 数，**不含需求原文**。
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
import { NOT_PROVIDED, buildDraftPrompt, extractJsonObject, renderDraftDescription, resetDraftSessions } from '../src/services/smartCreateDraft.js';

const modelJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
  title: '支持按标题搜索',
  background: null,
  requirements: '看板支持按标题搜索任务',
  acceptance: null,
  labels: [],
  warnings: [],
  ...over,
});

describe('smart create draft (SMART-CREATE)', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let ws: string;
  let prompts: string[];

  /** 每次测试可换的 runner 脚本 */
  let runner: (args: { adapter: string; prompt: string; cwd: string; signal: AbortSignal }) => Promise<string>;

  const postDraft = (body: Record<string, unknown>) => request(app).post('/api/issues/draft').send(body);
  // ---- SMART-CREATE-SESSION（0fce2f7b）：会话按 workspace_id + adapter 复用 ----
  it('同工作区同 adapter 连点两次 → 同一 session_id，轮次递增', async () => {
    resetDraftSessions();
    const first = await postDraft({ workspace_id: ws, requirement: '第一版需求：加排序开关', adapter: 'codex' });
    const second = await postDraft({ workspace_id: ws, requirement: '再补一条：默认关闭', adapter: 'codex' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.session_id).toBeTruthy();
    expect(second.body.session_id).toBe(first.body.session_id);
    expect(first.body.session_turn).toBe(1);
    expect(second.body.session_turn).toBe(2);
    expect(first.body.session_reused).toBe(false);
    expect(second.body.session_reused).toBe(true);
    // 第二轮 prompt 带上第一轮需求作为只读上下文
    expect(prompts[1]).toContain('第一版需求：加排序开关');
  });

  it('换 adapter → 新 session_id；换工作区 → 新 session_id', async () => {
    resetDraftSessions();
    const codex = await postDraft({ workspace_id: ws, requirement: '需求 A', adapter: 'codex' });
    const opencode = await postDraft({ workspace_id: ws, requirement: '需求 A', adapter: 'opencode' });
    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-draft2-'));
    const otherWs = createWorkspace(t.db, { name: '第二空间', path: otherDir });
    const other = await postDraft({ workspace_id: otherWs.id, requirement: '需求 A', adapter: 'codex' });
    expect(codex.body.session_id).not.toBe(opencode.body.session_id);
    expect(codex.body.session_id).not.toBe(other.body.session_id);
    expect(opencode.body.session_reused).toBe(false);
    expect(other.body.session_reused).toBe(false);
  });

  it('失败不吃脏上下文：422 后再成功，轮次仍从 1 开始且 prompt 不含失败需求', async () => {
    resetDraftSessions();
    runner = async () => '不是 JSON';
    const failed = await postDraft({ workspace_id: ws, requirement: '这条会失败的需求', adapter: 'codex' });
    expect(failed.status).toBe(422);
    runner = async ({ prompt }) => { prompts.push(prompt); return modelJson(); };
    prompts = [];
    const ok = await postDraft({ workspace_id: ws, requirement: '重试后的新需求', adapter: 'codex' });
    expect(ok.status).toBe(200);
    expect(ok.body.session_turn).toBe(1);
    expect(prompts[0]).not.toContain('这条会失败的需求');
  });
  const issueCount = (): number => (t.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n;

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-draft-'));
    prompts = [];
    runner = async ({ prompt }) => { prompts.push(prompt); return modelJson(); };
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'dsh' || id === 'codex' || id === 'opencode' || id === 'codebuddy' || id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      draftRunner: args => runner(args),
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '草稿空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('returnsAThreeSectionDraftWithoutPersisting', async () => {
    // 工作区里先有一张带标签的卡，labels 只允许从这里选
    await request(app).post('/api/issues').send(issuePayload(ws, { title: '已有卡', labels: ['前端', '性能'] }));
    runner = async ({ prompt }) => { prompts.push(prompt); return modelJson({ labels: ['前端', '自造标签'] }); };

    const before = issueCount();
    const res = await postDraft({ workspace_id: ws, requirement: '看板要能按标题搜索', adapter: 'dsh' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe('支持按标题搜索');
    expect(res.body.description).toContain('## 背景');
    expect(res.body.description).toContain('## 要求');
    expect(res.body.description).toContain('## 验收');
    // 自造标签被丢弃并进 warnings
    expect(res.body.labels).toEqual(['前端']);
    expect((res.body.warnings as string[]).join('\n')).toContain('自造标签');
    // 不落库
    expect(issueCount()).toBe(before);
    // 审计只记结构性字段
    const audit = t.db.prepare('SELECT adapter, ok, warning_count, error_code, duration_ms FROM issue_draft_audit').all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ adapter: 'dsh', ok: 1, error_code: null });
    expect(audit[0]!.warning_count).toBeGreaterThan(0);
    // 审计表里没有需求原文
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM issue_draft_audit').all());
    expect(dump).not.toContain('看板要能按标题搜索');
  });

  it('neverInventsAcceptanceCriteriaForOneLineRequirement', async () => {
    // 固定 fixture：模型只回要求段，验收段为 null → 渲染必须是「未提供」
    const fixture = modelJson({ title: '导出周报', background: null, requirements: '导出周报', acceptance: null });
    runner = async () => fixture;

    const res = await postDraft({ workspace_id: ws, requirement: '导出周报', adapter: 'codex' });
    expect(res.status).toBe(200);
    const description = res.body.description as string;
    const sections = description.split(/\n\n/);
    expect(sections[0]).toBe(`## 背景\n${NOT_PROVIDED}`);
    expect(sections[1]).toBe('## 要求\n导出周报');
    expect(sections[2]).toBe(`## 验收\n${NOT_PROVIDED}`);
    // 不许出现任何编造的验收字样
    expect(description).not.toMatch(/验收[:：]\s*\S/);
  });

  it('retriesOnceThenFailsWithExplainableErrorOnInvalidJson', async () => {
    let calls = 0;
    runner = async () => { calls += 1; return '这不是 JSON'; };
    const res = await postDraft({ workspace_id: ws, requirement: '随便写', adapter: 'opencode' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DRAFT_INVALID_OUTPUT');
    expect(res.body.error.message).toContain('合法');
    expect(calls).toBe(2); // 首次 + 重试 1 次
    const audit = t.db.prepare('SELECT ok, error_code FROM issue_draft_audit').all() as Array<Record<string, unknown>>;
    expect(audit).toEqual([{ ok: 0, error_code: 'DRAFT_INVALID_OUTPUT' }]);
  });

  it('recoversWhenTheRetryReturnsValidJson', async () => {
    let calls = 0;
    runner = async () => { calls += 1; return calls === 1 ? 'oops' : modelJson(); };
    const res = await postDraft({ workspace_id: ws, requirement: '第二次才成功', adapter: 'dsh' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('reportsAdapterUnavailableWithReasonBeforeTouchingTheAdapter', async () => {
    // DSH-ADAPTER-BUG：适配器探测说不可用（shim 坏的）→ 503 ADAPTER_UNAVAILABLE + 原因，且不调 runTurn
    let ran = false;
    const created = await createApp({
      db: t.db,
      getAdapter: (): AgentAdapter => ({
        ...new FakeAdapter(),
        detect: async () => ({ installed: false, version: null, message: 'dsh CLI 不可用：输出异常（node:internal/modules/cjs/loader:1424），exit 1' }),
      }) as AgentAdapter,
      adapters: [new FakeAdapter()],
      refreshClisOnBoot: false,
      draftRunner: async () => { ran = true; return modelJson(); },
    });
    const res = await request(created.app).post('/api/issues/draft').send({ workspace_id: ws, requirement: '适配器不可用', adapter: 'dsh' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADAPTER_UNAVAILABLE');
    expect(res.body.error.message).toContain('loader:1424');
    expect(res.body.error.message).toContain('手动创建');
    expect(ran).toBe(false);
    const audit = t.db.prepare('SELECT ok, error_code FROM issue_draft_audit ORDER BY created_at DESC LIMIT 1').all() as Array<Record<string, unknown>>;
    expect(audit[0]).toMatchObject({ ok: 0, error_code: 'ADAPTER_UNAVAILABLE' });
  });

  it('surfacesAdapterFailureAs502', async () => {
    runner = async () => { throw new Error('适配器未安装'); };
    const res = await postDraft({ workspace_id: ws, requirement: '适配器坏掉', adapter: 'codex' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DRAFT_ADAPTER_FAILED');
    expect(res.body.error.message).toContain('适配器未安装');
  });

  it('timesOutWithAnExplainableError', async () => {
    const created = await createApp({
      db: t.db,
      getAdapter: (): AgentAdapter => new FakeAdapter(),
      adapters: [new FakeAdapter()],
      refreshClisOnBoot: false,
      draftRunner: ({ signal }) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      draftTimeoutMs: 30,
    });
    const res = await request(created.app).post('/api/issues/draft').send({ workspace_id: ws, requirement: '超时用例', adapter: 'dsh' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('DRAFT_TIMEOUT');
    expect(res.body.error.message).toContain('手动创建');
  });

  it('rejectsUnknownAdapterAndEmptyRequirementWith400', async () => {
    // SMART-CREATE-CB：codebuddy 现在是合法值，未知值改用 cursor
    const unknown = await postDraft({ workspace_id: ws, requirement: 'x', adapter: 'cursor' });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('codebuddy');
    const empty = await postDraft({ workspace_id: ws, requirement: '   ', adapter: 'dsh' });
    expect(empty.status).toBe(400);
    const missingWs = await postDraft({ workspace_id: '00000000-0000-4000-8000-000000000000', requirement: 'x', adapter: 'dsh' });
    expect(missingWs.status).toBe(404);
  });

  it('acceptsCodebuddyAdapterAfterAllowlistExtension', async () => {
    runner = async () => JSON.stringify({ title: '支持 codebuddy 草稿', background: 'b', requirements: null, acceptance: null, labels: [], warnings: [] });
    const res = await postDraft({ workspace_id: ws, requirement: '用 codebuddy 生成草稿', adapter: 'codebuddy' });
    expect(res.status).toBe(200);
    expect(res.body.title).toContain('codebuddy');
  });

  it('promptForbidsInventingRequirementsAndAcceptsFencedJson', () => {
    const prompt = buildDraftPrompt('一句话需求', ['前端']);
    expect(prompt).toContain('不要补充需求');
    expect(prompt).toContain('不要推断验收条件');
    expect(prompt).toContain('[前端]');
    // 围栏与前后废话都能抠出对象
    expect(extractJsonObject('好的：\n```json\n{"a":1}\n```\n以上')).toEqual({ a: 1 });
    expect(() => extractJsonObject('没有 JSON')).toThrow();
    // 三段渲染：空值 → 未提供
    expect(renderDraftDescription({ title: 't', background: null, requirements: 'r', acceptance: null, labels: [], warnings: [] }))
      .toBe(`## 背景\n${NOT_PROVIDED}\n\n## 要求\nr\n\n## 验收\n${NOT_PROVIDED}`);
  });
});

describe('draft adapter allowlist (SMART-CREATE-CB)', () => {
  it('DRAFT_ADAPTERS 是唯一来源：zod 枚举与它完全一致，且包含 codebuddy', async () => {
    const { DRAFT_ADAPTERS } = await import('../src/services/smartCreateDraft.js');
    const { draftRequestSchema } = await import('../src/api/schemas.js');
    expect([...DRAFT_ADAPTERS]).toEqual(['dsh', 'codex', 'opencode', 'codebuddy']);
    // 逐个 id 都能过校验（含 codebuddy）
    for (const id of DRAFT_ADAPTERS) {
      expect(draftRequestSchema.safeParse({ workspace_id: 'w', requirement: 'r', adapter: id }).success).toBe(true);
    }
    // 不在清单里的必须被拒，且错误里列出可用值（中文文案来自 zhZodIssue，由路由层负责）
    const rejected = draftRequestSchema.safeParse({ workspace_id: 'w', requirement: 'r', adapter: 'cursor' });
    expect(rejected.success).toBe(false);
  });

  it('防漂移：DRAFT_ADAPTERS 里每个 id 都必须在适配器注册表与 /api/clis 里', async () => {
    const { DRAFT_ADAPTERS } = await import('../src/services/smartCreateDraft.js');
    const { ADAPTERS } = await import('@agentboard/adapters');
    const registryIds = new Set(ADAPTERS.map(adapter => adapter.id));
    for (const id of DRAFT_ADAPTERS) expect(registryIds.has(id)).toBe(true);
  });
});

describe('MULTI-DRAFT：多条需求拆多卡（6a59ef60）', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let ws: string;
  let prompts: string[];
  let runner: (args: { adapter: string; prompt: string; cwd: string; signal: AbortSignal }) => Promise<string>;

  const postDraft = (body: Record<string, unknown>) => request(app).post('/api/issues/draft').send(body);
  const cardJson = (title: string, requirements: string | null, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    title, background: null, requirements, acceptance: null, labels: [], warnings: [], ...over,
  });

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-multi-'));
    prompts = [];
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (['dsh', 'codex', 'opencode', 'codebuddy', 'fake'].includes(id)) return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      draftRunner: args => runner(args),
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '多卡空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('3 条需求 → 3 张卡；顶层字段镜像第一张（兼容旧读取）', async () => {
    resetDraftSessions();
    runner = async ({ prompt }) => {
      prompts.push(prompt);
      return JSON.stringify({ cards: [
        cardJson('加排序开关', '看板加排序开关'),
        cardJson('按标题搜索', '支持按标题搜索'),
        cardJson('导出 CSV', '导出为 CSV'),
      ] });
    };
    const res = await postDraft({ workspace_id: ws, requirement: '1. 加排序开关\n2. 按标题搜索\n3. 导出 CSV', adapter: 'codex' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cards).toHaveLength(3);
    expect(res.body.cards.map((c: { title: string }) => c.title)).toEqual(['加排序开关', '按标题搜索', '导出 CSV']);
    expect(res.body.cards[0].local_id).toBe('c1');
    // 兼容：顶层镜像第一张卡
    expect(res.body.title).toBe('加排序开关');
    expect(res.body.description).toBe(res.body.cards[0].description);
    // 批量 prompt 要求条数与条目一一对应
    expect(prompts[0]).toContain('恰好 3 张');
  });

  it('单条需求不拆：cards 长度 1，且走单卡 prompt（不含批量措辞）', async () => {
    resetDraftSessions();
    runner = async ({ prompt }) => { prompts.push(prompt); return modelJson(); };
    const res = await postDraft({ workspace_id: ws, requirement: '看板要能按标题搜索', adapter: 'codex' });
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.title).toBe('支持按标题搜索');
    expect(prompts[0]).not.toContain('一条一卡');
  });

  it('模型条数与需求条数不符 → 确定性兜底：按原文逐条出卡，不丢需求', async () => {
    resetDraftSessions();
    runner = async () => JSON.stringify({ cards: [cardJson('只有一张', '合并了')] });
    const res = await postDraft({ workspace_id: ws, requirement: '1. 甲\n2. 乙\n3. 丙', adapter: 'codex' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cards).toHaveLength(3);
    expect(res.body.cards.map((c: { title: string }) => c.title)).toEqual(['甲', '乙', '丙']);
    expect(res.body.cards[0].description).toContain('## 验收\n未提供');
    expect((res.body.warnings as string[]).join('\n')).toContain('按需求原文逐条生成');
  });

  it('模型输出非 JSON 且是多条需求 → 仍兜底出卡（不 422）', async () => {
    resetDraftSessions();
    runner = async () => '完全不是 JSON';
    const res = await postDraft({ workspace_id: ws, requirement: '加导出；修暗色对比度', adapter: 'codex' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cards).toHaveLength(2);
  });
});
