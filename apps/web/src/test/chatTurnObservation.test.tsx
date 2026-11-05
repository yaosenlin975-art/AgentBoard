/**
 * CHAT-VIS1：计划条 + 工具结果卡 / 文件级 diff + 成本脚注。
 *
 * 覆盖卡面 7 项验收（纯前端，不跑真实轮次）：
 * 1. 一轮一条计划条 + 切会话不残留 + chip 三态；2. button/aria-expanded/aria-live/减动效；
 * 3. 带 meta_json 的工具事件成卡、无元信息仍走 EventGroup；4. diff 默认折叠到文件级、+N −M 与 meta 一致；
 * 5. meta_json IS NULL 的旧消息走旧渲染；6. 成本脚注 0 / 随 session.usage 更新 / 「估算」/ 不进消息区；
 * 7. 计划条与卡上都没有重试或改计划入口。
 * 事件用 wsBus 注入（`emitWsEvent`），与 streamingStore 的既有测试同一套路。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message, MessageToolMeta, TurnPlanStep, TurnUsage } from '@agentboard/shared';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/chat/Composer';
import { emitWsEvent } from '../api/wsBus';
import { usePanelStore } from '../state/panelStore';
import { useTurnStore } from '../state/turnStore';
import {
  contextPercent,
  deriveTurnChip,
  formatTokens,
  planHeadline,
  usageFootnote,
} from '../lib/turnView';

const step = (id: string, title: string, state: TurnPlanStep['state']): TurnPlanStep => ({
  step_id: id,
  title,
  state,
});

function toolMeta(overrides: Partial<MessageToolMeta> = {}): MessageToolMeta {
  return {
    status: 'ok',
    duration_ms: 8200,
    output_summary: '更新 3 处：新增计划条、工具结果分组、默认折叠',
    tool_call_id: 's1',
    diff: {
      files: [
        { path: 'apps/web/src/components/chat/MessageList.tsx', add: 12, del: 3, patch: '@@ -1,3 +1,4 @@\n+const a = 1\n-const b = 2\n ctx' },
        { path: 'apps/web/src/index.css', add: 4, del: 0, patch: null },
      ],
    },
    ...overrides,
  };
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 's1',
    role: 'user',
    content: '把计划条和工具卡做扎实',
    ts: 100,
    ...overrides,
  };
}

function emitPlan(turnId: string, plan: TurnPlanStep[], currentIndex: number, sessionId = 's1'): void {
  act(() => {
    emitWsEvent({ type: 'session.plan', session_id: sessionId, turn_id: turnId, plan, current_index: currentIndex });
  });
}

function emitUsage(turnId: string, usage: Partial<TurnUsage>, sessionId = 's1'): void {
  act(() => {
    emitWsEvent({
      type: 'session.usage',
      session_id: sessionId,
      turn_id: turnId,
      usage: {
        input_tokens: 6200,
        output_tokens: 6200,
        cost_usd: null,
        context_used_tokens: 12400,
        context_limit_tokens: null,
        estimated: true,
        ...usage,
      },
    });
  });
}

function renderList(messages: Message[], sessionStatus: '运行中' | '已结束' | '失败' = '运行中'): void {
  // CHAT-RETRY2：工具卡内的单步重试是 useMutation，渲染必须带 QueryClient
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageList messages={messages} streaming="" running={false} sessionStatus={sessionStatus} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useTurnStore.getState().reset();
  usePanelStore.setState({ chatDrafts: {} });
});

// ---------- 1 / 2 / 7：计划条 ----------

describe('计划条', () => {
  const messages = [
    msg({ id: 'u1', turn_id: 't1', role: 'user' }),
    msg({ id: 'e1', turn_id: 't1', step_id: 's1', role: 'event', content: JSON.stringify({ name: 'Read', input: 'MessageList.tsx' }), meta_json: toolMeta() }),
  ];

  it('一轮一条：同一 turn_id 的多条消息只在容器顶部渲染一个计划条', () => {
    emitPlan('t1', [step('s1', 'Read', 'running'), step('s2', 'Edit', 'pending')], 0);
    renderList([...messages, msg({ id: 'u2', turn_id: 't1', content: '继续' })]);
    expect(screen.getAllByTestId('plan-bar-t1')).toHaveLength(1);
    expect(screen.getByTestId('plan-bar-t1')).toBeVisible();
    // 条在「一轮容器」顶部：容器带 turn id，条是第一个子节点
    const group = screen.getByTestId('turn-group-t1');
    expect(group.firstElementChild).toBe(screen.getByTestId('plan-bar-wrap-t1'));
  });

  it('消息交错出现同一轮次也只有一条（同一 turn 的第二段容器不重复挂条）', () => {
    emitPlan('t1', [step('s1', 'Read', 'running')], 0);
    emitPlan('t2', [step('s1', 'Grep', 'running')], 0);
    renderList([
      msg({ id: 'a', turn_id: 't1' }),
      msg({ id: 'b', turn_id: 't2' }),
      msg({ id: 'c', turn_id: 't1' }),
    ]);
    expect(screen.getAllByTestId('plan-bar-t1')).toHaveLength(1);
    expect(screen.getByTestId('plan-bar-t2')).toBeInTheDocument();
  });

  it('切到别的会话不显示该条（无观测条目 / 别的 turn id 都不出条）', () => {
    emitPlan('t1', [step('s1', 'Read', 'running')], 0, 's1');
    renderList([msg({ id: 'x', turn_id: 't9', session_id: 's2' }), msg({ id: 'y', session_id: 's2' })]);
    expect(screen.queryAllByTestId(/^plan-bar-/).length).toBe(0);
    // 无 tool 事件 → plan 为 [] → 隐藏计划条（与「历史会话无 turn 行」同降级）
    emitPlan('t3', [], -1, 's1');
    renderList([msg({ id: 'z', turn_id: 't3' })]);
    expect(screen.queryAllByTestId(/^plan-bar-/).length).toBe(0);
  });

  it('一行摘要 + sticky 贴顶 + 展开为步骤清单（不铺时间线）', async () => {
    const plan = [step('s1', 'Read', 'done'), step('s2', 'Grep', 'done'), step('s3', 'Edit', 'running'), step('s4', 'Test', 'pending'), step('s5', 'Commit', 'pending')];
    emitPlan('t1', plan, 2);
    renderList(messages);
    const bar = screen.getByTestId('plan-bar-t1');
    expect(screen.getByTestId('plan-headline-t1')).toHaveTextContent('计划 2/5 · 正在执行：Edit');
    // sticky 贴顶：jsdom 不加载样式表，计算样式取不到 → 断类名，计算值在 5174 页面取证
    expect(screen.getByTestId('plan-bar-wrap-t1')).toHaveClass('sticky', 'top-0', 'z-10');
    expect(bar).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByTestId('plan-steps-t1');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getByTestId('plan-step-t1-s3')).toHaveTextContent('第 3 步 · Edit执行中');
    expect(within(list).getByTestId('plan-step-t1-s4')).toHaveTextContent('待执行');
  });

  it('chip 三态文案与配色语义可辨（data-tone 区分：accent / danger / neutral）', () => {
    const cases: Array<[TurnPlanStep[], number, '运行中' | '已结束' | '失败', string, string]> = [
      [[step('s1', 'Read', 'awaiting')], 0, '运行中', '等待回答', 'accent'],
      [[step('s1', 'Read', 'failed')], 0, '运行中', '已失败', 'danger'],
      [[step('s1', 'Read', 'done')], 1, '已结束', '已完成', 'neutral'],
    ];
    for (const [plan, index, status, label, tone] of cases) {
      cleanup();
      emitPlan('t1', plan, index);
      renderList(messages, status);
      const chip = screen.getByTestId('plan-status-t1');
      expect(chip).toHaveTextContent(label);
      expect(chip).toHaveAttribute('data-tone', tone);
      expect(chip.className).not.toBe('');
    }
  });

  it('无障碍：整条是 button、步骤变化写进 aria-live=polite、无重试/改计划入口', async () => {
    emitPlan('t1', [step('s1', 'Read', 'running')], 0);
    renderList(messages);
    const bar = screen.getByTestId('plan-bar-t1');
    expect(bar.tagName).toBe('BUTTON');
    expect(bar).toHaveAttribute('aria-expanded');
    const live = screen.getByTestId('plan-live-t1');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('计划第 1 步，共 1 步：Read');
    emitPlan('t1', [step('s1', 'Read', 'done'), step('s2', 'Edit', 'running')], 1);
    expect(live).toHaveTextContent('计划第 2 步，共 2 步：Edit');
    emitPlan('t1', [step('s1', 'Read', 'done'), step('s2', 'Edit', 'done')], 2);
    expect(live).toHaveTextContent('计划已完成，共 2 步');
    // 验收 7（CHAT-VIS1 口径）：计划条/计划条容器不放重试或改计划入口；
    // 失败步骤卡的「重试此步」由 CHAT-RETRY2 提供（本用例的步骤 status=ok，不应出现重试按钮）
    const group = screen.getByTestId('turn-group-t1');
    expect(within(group).queryByRole('button', { name: /重试|重发|重新执行/ })).toBeNull();
    expect(within(group).queryAllByRole('textbox').length).toBe(0);
    expect(within(group).queryAllByRole('spinbutton').length).toBe(0);
  });

  it('prefers-reduced-motion：只带 motion-reduce 兜底、无 animate-* / transition-all', () => {
    emitPlan('t1', [step('s1', 'Read', 'running')], 0);
    renderList(messages);
    const wrap = screen.getByTestId('plan-bar-wrap-t1');
    expect(wrap.className).toContain('motion-reduce:transition-none');
    expect(wrap.className).not.toMatch(/animate-|transition-all/);
    expect(wrap.className).toContain('motion-safe:transition-[background-color]');
  });
});

// ---------- 3 / 4 / 5：工具结果卡 + 文件级 diff ----------

describe('工具结果卡', () => {
  it('带 meta_json 的工具事件渲染为卡：图标 + 工具名 + 耗时 + 摘要三件套；纯思考仍在 EventGroup', () => {
    renderList([
      msg({ id: 'e1', turn_id: 't1', step_id: 's1', role: 'event', content: JSON.stringify({ name: 'Read', input: 'x' }), meta_json: toolMeta() }),
      msg({ id: 'e2', turn_id: 't1', role: 'event', content: JSON.stringify({ kind: 'thinking', text: '想想' }) }),
    ]);
    const card = screen.getByTestId('tool-card-e1');
    expect(within(card).getByTestId('tool-mark-e1')).toHaveTextContent('✓');
    expect(within(card).getByTestId('tool-name-e1')).toHaveTextContent('Read');
    expect(within(card).getByTestId('tool-duration-e1')).toHaveTextContent('8.2s');
    expect(within(card).getByTestId('tool-summary-e1')).toHaveTextContent('更新 3 处');
    // 无 meta 的思考事件仍留在 EventGroup 折叠（验收 3 的后半句）
    expect(screen.getByTestId('event-group-e2')).toBeInTheDocument();
    // 失败态：✕ + data-status
    cleanup();
    renderList([msg({ id: 'e3', role: 'event', content: JSON.stringify({ name: 'Bash', input: 'pnpm test' }), meta_json: toolMeta({ status: 'failed', output_summary: null }) })]);
    expect(screen.getByTestId('tool-mark-e3')).toHaveTextContent('✕');
    expect(screen.getByTestId('tool-card-e3')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('tool-summary-e3')).toHaveTextContent('输入：pnpm test');
  });

  it('diff 默认折叠到文件级；+N −M 与 meta_json.diff.files 一致；单文件可展开/收起', async () => {
    const meta = toolMeta();
    renderList([msg({ id: 'e1', role: 'event', content: JSON.stringify({ name: 'Edit' }), meta_json: meta })]);
    const fileA = screen.getByTestId('diff-file-e1-0');
    const fileB = screen.getByTestId('diff-file-e1-1');
    expect(fileA).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('diff-body-e1-0')).toBeNull();
    expect(fileA).toHaveAttribute('data-add', String(meta.diff!.files[0]!.add));
    expect(fileA).toHaveAttribute('data-del', String(meta.diff!.files[0]!.del));
    expect(fileA).toHaveTextContent(`+${meta.diff!.files[0]!.add}−${meta.diff!.files[0]!.del}`);
    expect(fileB).toHaveTextContent(`+${meta.diff!.files[1]!.add}−${meta.diff!.files[1]!.del}`);
    await userEvent.click(fileA);
    const body = screen.getByTestId('diff-body-e1-0');
    expect(body).toHaveTextContent('const a = 1');
    const addLine = within(body).getByText('+const a = 1');
    const delLine = within(body).getByText('-const b = 2');
    expect(addLine.className).toContain('ab-diff-add');
    expect(delLine.className).toContain('ab-diff-del');
    await userEvent.click(screen.getByTestId('diff-file-e1-0'));
    expect(screen.queryByTestId('diff-body-e1-0')).toBeNull();
  });

  it('无 patch 的文件退化为复制 `git diff -- <path>` 提示；截断标记透出', async () => {
    renderList([msg({ id: 'e1', role: 'event', content: JSON.stringify({ name: 'Edit' }), meta_json: toolMeta() })]);
    await userEvent.click(screen.getByTestId('diff-file-e1-1'));
    expect(screen.getByTestId('diff-empty-e1-1')).toHaveTextContent('git diff -- apps/web/src/index.css');
    await userEvent.click(screen.getByTestId('git-open-e1'));
    expect(screen.getByTestId('git-hint-e1')).toHaveTextContent('git diff -- apps/web/src/components/chat/MessageList.tsx');
    cleanup();
    renderList([
      msg({
        id: 'e2',
        role: 'event',
        content: JSON.stringify({ name: 'Edit' }),
        meta_json: toolMeta({ diff: { files: [{ path: 'a.ts', add: 500, del: 1, patch: '@@ -1 +1 @@\n+x', truncated: true }] } }),
      }),
    ]);
    await userEvent.click(screen.getByTestId('diff-file-e2-0'));
    expect(screen.getByTestId('diff-truncated-e2-0')).toHaveTextContent('patch 已截断');
  });

  it('验收 5：meta_json 为 null 的旧消息走旧渲染，无报错、不回填、不出卡', () => {
    renderList([
      msg({ id: 'old1', role: 'event', content: JSON.stringify({ name: 'Read', input: '老消息' }) }),
      msg({ id: 'old2', role: 'event', content: '不是 JSON' }),
      msg({ id: 'old3', role: 'assistant', content: '正文' }),
    ]);
    expect(screen.queryAllByTestId(/^tool-card-/).length).toBe(0);
    expect(screen.getByTestId('event-group-old1')).toBeInTheDocument();
    expect(screen.getByTestId('msg-old3')).toHaveTextContent('正文');
    // 老消息（无 turn_id / 无观测）保持平铺：不套轮次容器
    expect(screen.queryAllByTestId(/^turn-group-/).length).toBe(0);
  });

  it('观测缺失时不编造：duration/summary 为 null 显示占位，无 diff 文件时展示输入正文', () => {
    renderList([
      msg({
        id: 'e1',
        role: 'event',
        content: JSON.stringify({ name: 'Grep', input: 'turn' }),
        meta_json: { status: 'ok', duration_ms: null, output_summary: null, tool_call_id: 's1', diff: null },
      }),
    ]);
    expect(screen.getByTestId('tool-duration-e1')).toHaveTextContent('—');
    expect(screen.getByTestId('tool-summary-e1')).toHaveTextContent('输入：turn');
    expect(screen.queryAllByTestId(/^diff-file-/).length).toBe(0);
    expect(screen.getByTestId('tool-body-e1')).toHaveTextContent('turn');
  });
});

// ---------- 6：成本脚注 ----------

describe('成本脚注', () => {
  function renderComposer(sessionId: string | null): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Composer disabled={false} running={false} queuedCount={0} workspaceId="ws-1" sessionId={sessionId} onSend={async () => {}} />
      </QueryClientProvider>,
    );
  }

  it('纯函数：token 可读化、null 不冒充、百分比按分母', () => {
    expect(formatTokens(12400)).toBe('12.4k');
    expect(formatTokens(0)).toBe('0');
    expect(usageFootnote(null)).toBe('本轮 0 tokens · 成本 待接入 · 上下文 未知');
    expect(usageFootnote({ input_tokens: 6200, output_tokens: 6200, cost_usd: null, context_used_tokens: 12400, context_limit_tokens: null, estimated: true })).toBe(
      '本轮 12.4k tokens（估算） · 成本 待接入 · 上下文 未知',
    );
    expect(contextPercent({ input_tokens: 1, output_tokens: 1, cost_usd: 0.02, context_used_tokens: 340, context_limit_tokens: 1000, estimated: true })).toBe(34);
    expect(usageFootnote({ input_tokens: 1, output_tokens: 1, cost_usd: 0.02, context_used_tokens: 340, context_limit_tokens: 1000, estimated: true })).toBe(
      '本轮 2 tokens（估算） · 估算 ¥0.020 · 上下文 34%',
    );
  });

  it('未开始轮次显示 0；流式中随 session.usage 更新；标注「估算」；不进消息区', () => {
    renderComposer('s1');
    const foot = screen.getByTestId('composer-usage');
    expect(foot).toHaveTextContent('本轮 0 tokens');
    emitUsage('t1', { input_tokens: 6200, output_tokens: 6200, context_used_tokens: 12400 });
    expect(foot).toHaveTextContent('本轮 12.4k tokens（估算）');
    emitUsage('t1', { input_tokens: 9000, output_tokens: 9000, context_used_tokens: 18000 });
    expect(foot).toHaveTextContent('本轮 18.0k tokens（估算）');
    // 10px 右对齐（jsdom 无样式表 → 断类名；计算值在 5174 页面取证）+ 在输入区内，不占消息区高度
    expect(foot).toHaveClass('text-[10px]', 'text-right');
    expect(foot.closest('[data-testid="composer"]')).not.toBeNull();
    expect(screen.queryByTestId('message-list')).toBeNull();
    // 别的会话不污染：切到 s2 后回到 0
    cleanup();
    renderComposer('s2');
    expect(screen.getByTestId('composer-usage')).toHaveTextContent('本轮 0 tokens');
  });
});

// ---------- 推导口径回归（lib 纯函数） ----------

describe('turnView 推导口径', () => {
  it('chip 优先级：awaiting > failed > 收口 > running；会话失败也归为已失败', () => {
    expect(deriveTurnChip([step('s1', 'a', 'awaiting'), step('s2', 'b', 'failed')], 0, '运行中').state).toBe('awaiting');
    expect(deriveTurnChip([step('s1', 'a', 'failed')], 0, '运行中').state).toBe('failed');
    expect(deriveTurnChip([step('s1', 'a', 'done')], 0, '失败').state).toBe('failed');
    expect(deriveTurnChip([step('s1', 'a', 'done')], 1, '已结束').state).toBe('done');
    expect(deriveTurnChip([step('s1', 'a', 'done'), step('s2', 'b', 'running')], 2, '已结束').state).toBe('stopped');
    expect(deriveTurnChip([step('s1', 'a', 'running')], 0, '运行中').state).toBe('running');
  });

  it('收口/失败态的一行文案不出现「正在执行」', () => {
    expect(planHeadline([step('s1', 'Read', 'done')], 1, deriveTurnChip([step('s1', 'Read', 'done')], 1, '已结束'))).toBe('计划 1/1 · 全部步骤已完成');
    expect(planHeadline([step('s1', 'Read', 'failed')], 0, deriveTurnChip([step('s1', 'Read', 'failed')], 0, '运行中'))).toBe('计划 0/1 · 失败于第 1 步：Read');
  });
});
