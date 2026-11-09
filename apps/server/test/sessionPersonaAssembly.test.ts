/**
 * P1-C：sessionManager 起轮装配测试——session 四列 → RunTurnOptions。
 * 覆盖：persona 注入各模式（缺省 auto / flag / off / file）、tool_policy 解析透传、
 * file 模式标记块落盘 + adapter 收不到 persona、悬空 persona_id 不拦起轮、skill_policy 无 adapter 通道。
 * 测试会话 cli='fake' → file 模式标记块文件为工作区根 AGENTS.md（映射按 session.cli，非 adapter 实例 id）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createPersona, deletePersona } from '../src/db/repos/persona.js';
import { updateSession } from '../src/db/repos/session.js';
import {
  createSession,
  initSessionManager,
  resetSessionManager,
  sendToSession,
} from '../src/services/sessionManager.js';

let t: TestDb;
let wsId: string;
let workdir: string;
let adapter: FakeAdapter;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(() => {
  t = createTestDb();
  adapter = new FakeAdapter();
  workdir = mkdtempSync(join(tmpdir(), 'agentboard-ws-'));
  wsId = createWorkspace(t.db, { name: 'ws', path: workdir }).id;
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(workdir, { recursive: true, force: true });
});

const TOOL_POLICY = { approval_mode: 'plan' as const, allow: ['Read'], deny: ['Bash'] };

/** 起空闲会话 → 打 persona 四列 → 发消息跑完一轮，返回会话 id（先 patch 后起轮，无装配时序竞争） */
async function runOneTurn(patch: {
  persona_id?: string | null;
  tool_policy?: string | null;
  skill_policy?: string | null;
  persona_injection?: string | null;
}): Promise<{ sessionId: string }> {
  const session = await createSession({ cli: 'fake', workspace_id: wsId });
  updateSession(t.db, session.id, patch);
  await sendToSession(session.id, '继续');
  await settle();
  return { sessionId: session.id };
}

describe('persona 装配（runTurn opts）', () => {
  it('persona_id + 缺省 injection：adapter 收到 opts.persona（body/source 对应 personas 行）', async () => {
    const persona = createPersona(t.db, { name: '审查', body_md: '只输出事实', source: 'builtin' });
    await runOneTurn({ persona_id: persona.id });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.persona).toEqual({ id: persona.id, body: '只输出事实', source: 'builtin' });
    expect(adapter.calls[0]!.personaInjection).toBeUndefined();
  });

  it("persona_injection='flag'：persona + personaInjection='flag' 同时透传", async () => {
    const persona = createPersona(t.db, { name: '审查', body_md: '正文' });
    await runOneTurn({ persona_id: persona.id, persona_injection: 'flag' });
    expect(adapter.calls[0]!.persona).toMatchObject({ id: persona.id });
    expect(adapter.calls[0]!.personaInjection).toBe('flag');
  });

  it("persona_injection='file'：adapter 收不到 persona，workdir 标记块含本会话边界；toolPolicy 照传", async () => {
    const persona = createPersona(t.db, { name: '审查', body_md: '标记块正文' });
    await runOneTurn({
      persona_id: persona.id,
      persona_injection: 'file',
      tool_policy: JSON.stringify(TOOL_POLICY),
      skill_policy: JSON.stringify({ allow: ['kb-*'] }),
    });
    expect(adapter.calls[0]!.persona).toBeUndefined();
    expect(adapter.calls[0]!.personaInjection).toBe('file');
    expect(adapter.calls[0]!.toolPolicy).toEqual(TOOL_POLICY);
    const blockFile = join(workdir, 'AGENTS.md');
    expect(existsSync(blockFile)).toBe(true);
    const content = readFileSync(blockFile, 'utf8');
    expect(content).toContain(`<!-- BEGIN AGENTBOARD-SESSION:`);
    expect(content).toContain(`<!-- END AGENTBOARD-SESSION:`);
    expect(content).toContain('标记块正文');
  });

  it("persona_injection='off'：透传 'off'（persona flag 由 adapters 侧全关），不写标记块", async () => {
    const persona = createPersona(t.db, { name: '审查', body_md: '正文' });
    await runOneTurn({ persona_id: persona.id, persona_injection: 'off' });
    expect(adapter.calls[0]!.personaInjection).toBe('off');
    expect(existsSync(join(workdir, 'AGENTS.md'))).toBe(false);
  });

  it('tool_policy 单独设置（无 persona）：解析透传给 adapter', async () => {
    await runOneTurn({ tool_policy: JSON.stringify(TOOL_POLICY) });
    expect(adapter.calls[0]!.toolPolicy).toEqual(TOOL_POLICY);
    expect(adapter.calls[0]!.persona).toBeUndefined();
  });

  it('悬空 persona_id（行被删）：不注入也不拦起轮', async () => {
    const persona = createPersona(t.db, { name: '将删', body_md: '正文' });
    const { sessionId } = await runOneTurn({ persona_id: persona.id });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.persona).toMatchObject({ id: persona.id });
    // 删 persona 行后再起一轮：persona 缺席、轮次照常
    deletePersona(t.db, persona.id);
    adapter.calls.length = 0;
    await sendToSession(sessionId, '再来');
    await settle();
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.persona).toBeUndefined();
  });

  it('脏 tool_policy（非法 JSON）：按未设置处理，不拦起轮', async () => {
    await runOneTurn({ tool_policy: '{not-json' });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.toolPolicy).toBeUndefined();
  });
});
