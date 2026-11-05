/**
 * CHAT-APP2 测试：三档确认弹窗 + ⋯ 审批规则工作表。
 *
 * 覆盖卡面验收：
 * - 三档全部可见、默认「仅本次」；写类工具「本工作区」置灰且 tooltip 说明，只读工具可选；
 * - 方向键切档、Esc = 拒绝、Tab 在弹窗内循环、打开时焦点落在当前档位；
 * - allow 按所选档提交；deny 走拒绝；
 * - 规则工作表列出未撤销规则，撤销后列表移除。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { ApprovalRule, Message, Session, SessionTurn, Workspace } from '@agentboard/shared';
import { ChatPanel } from '../components/chat/ChatPanel';
import { emitWsEvent } from '../api/wsBus';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useStreamingStore } from '../state/streamingStore';
import { useTurnStore } from '../state/turnStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    issue_id: null,
    cli: 'codebuddy',
    model: 'm1',
    status: '运行中',
    adapter_session_id: null,
    created_at: 1,
    ...overrides,
  };
}

function makeMessage(): Message {
  return { id: 'm1', session_id: 's1', role: 'user', content: 'hi', ts: 100 };
}

function makeRunningTurn(): SessionTurn {
  return {
    id: 't1',
    session_id: 's1',
    seq: 1,
    state: 'running',
    current_index: 0,
    plan_json: [{ step_id: 's1', title: '执行', state: 'running' }],
    awaiting_json: null,
    usage_json: null,
    started_at: 1,
    ended_at: null,
  };
}

let approvalCalls: Array<{ requestId: string; body: { decision?: string; scope?: string } }> = [];
let approvalResponse: { turn: SessionTurn } = { turn: makeRunningTurn() };
let rules: ApprovalRule[] = [];
let revokeCalls: string[] = [];
let sessionsList: Session[] = [];

function makeRule(overrides: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: 'r-1',
    workspace_id: 'ws-1',
    issue_id: null,
    session_id: 's1',
    turn_id: 't1',
    tool_name: 'read',
    match_key: 'read::src/a.ts',
    scope: 'workspace',
    created_at: 1000,
    created_by: 'user',
    revoked_at: null,
    ...overrides,
  };
}

function mockApi(): void {
  server.use(
    http.get('/api/sessions', () => HttpResponse.json(sessionsList)),
    http.get('/api/sessions/:id', ({ params }) => {
      const found = sessionsList.find((s) => s.id === params.id) ?? makeSession();
      return HttpResponse.json({ ...found, turns: [] as SessionTurn[] });
    }),
    http.get('/api/sessions/:id/messages', () => HttpResponse.json([makeMessage()])),
    http.get('/api/sessions/:id/queue', () => HttpResponse.json({ texts: [] })),
    http.post('/api/sessions/:id/turns/:turnId/approvals/:requestId', async ({ request, params }) => {
      approvalCalls.push({
        requestId: params.requestId as string,
        body: (await request.json()) as { decision?: string; scope?: string },
      });
      return HttpResponse.json(approvalResponse);
    }),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
    http.get('/api/clis', () =>
      HttpResponse.json([{ id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' }]),
    ),
    http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'm-a', source: 'static' }])),
    http.get('/api/skills', () => HttpResponse.json({ items: [] })),
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/issues/:id', () =>
      HttpResponse.json({
        id: 'i-1',
        workspace_id: 'ws-1',
        title: '任务一',
        status: '进行中',
        claimed_by: 'kb-cli',
        priority: '中',
        labels: [],
        description: '',
        sort_order: 0,
        parent_issue_id: null,
        due_date: null,
        due_time: null,
        created_at: 1,
        updated_at: 1,
        comment_count: 0,
      }),
    ),
    http.get('/api/workspaces/:workspaceId/approval-rules', () => HttpResponse.json(rules)),
    http.delete('/api/workspaces/:workspaceId/approval-rules/:ruleId', ({ params }) => {
      revokeCalls.push(params.ruleId as string);
      const found = rules.find((rule) => rule.id === params.ruleId) ?? null;
      rules = rules.filter((rule) => rule.id !== params.ruleId);
      return HttpResponse.json({ ...found, revoked_at: 2000 });
    }),
  );
}

function renderChat(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChatPanel />
    </QueryClientProvider>,
  );
}

function emitApprovalRequest(tool = 'Bash', target = 'rm -rf build', risk = 'write', requestId = 'r1'): void {
  act(() => {
    emitWsEvent({
      type: 'session.approval_request',
      session_id: 's1',
      turn_id: 't1',
      request_id: requestId,
      tool,
      target,
      risk,
    });
  });
}

beforeEach(() => {
  approvalCalls = [];
  revokeCalls = [];
  rules = [];
  approvalResponse = { turn: makeRunningTurn() };
  localStorage.clear();
  useTurnStore.getState().reset();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  useStreamingStore.setState({ streams: new Map() });
  sessionsList = [makeSession()];
  usePanelStore.setState({ sessionId: 's1', chatSession: makeSession() });
  mockApi();
});

describe('CHAT-APP2 三档确认弹窗', () => {
  it('三档全部可见、默认选中「仅本次」；未绑定任务时「本任务」置灰并说明原因', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();

    await screen.findByTestId('approval-dialog');
    expect(screen.getByTestId('approval-tier-once')).toBeInTheDocument();
    expect(screen.getByTestId('approval-tier-task')).toBeInTheDocument();
    expect(screen.getByTestId('approval-tier-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('approval-tier-input-once')).toBeChecked();
    expect(screen.getByTestId('approval-tier-hint-task')).toHaveTextContent('未绑定任务');
  });

  it('写类工具的「本工作区」置灰并有 tooltip，只读工具可选择', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest('Bash', 'rm -rf build', 'write');
    await screen.findByTestId('approval-dialog');

    const workspaceInput = screen.getByTestId('approval-tier-input-workspace') as HTMLInputElement;
    expect(workspaceInput.disabled).toBe(true);
    expect(screen.getByTestId('approval-tier-workspace').getAttribute('title')).toContain('撤销入口');

    // 换只读工具：工作区档可选中
    emitApprovalRequest('Read', 'src/a.ts', 'read', 'r2');
    await waitFor(() =>
      expect((screen.getByTestId('approval-tier-input-workspace') as HTMLInputElement).disabled).toBe(false),
    );
  });

  it('打开时焦点落在当前档位；方向键切档；Tab 在弹窗内循环', async () => {
    sessionsList = [makeSession({ issue_id: 'i-1' })];
    usePanelStore.setState({ sessionId: 's1', chatSession: sessionsList[0]! });
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest('Read', 'src/a.ts', 'read');
    await screen.findByTestId('approval-dialog');

    const once = screen.getByTestId('approval-tier-input-once') as HTMLInputElement;
    const task = screen.getByTestId('approval-tier-input-task') as HTMLInputElement;
    const workspace = screen.getByTestId('approval-tier-input-workspace') as HTMLInputElement;
    expect(document.activeElement).toBe(once);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(task);
    expect(task.checked).toBe(true);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(workspace);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(task);

    // Tab 从最后一个可 Tab 元素（允许）回到第一个（原生 keydown 验证焦点循环）
    act(() => {
      const allow = screen.getByTestId('approval-allow');
      allow.focus();
      allow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(once);
    act(() => {
      once.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(screen.getByTestId('approval-allow'));
  });

  it('Esc 等同于拒绝', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();
    await screen.findByTestId('approval-dialog');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(approvalCalls).toHaveLength(1));
    expect(approvalCalls[0]?.body).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('选择「本任务」后 allow 提交 task 档；只读工具选「本工作区」提交 workspace 档', async () => {
    sessionsList = [makeSession({ issue_id: 'i-1' })];
    usePanelStore.setState({ sessionId: 's1', chatSession: sessionsList[0]! });
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest('Read', 'src/a.ts', 'read');
    await screen.findByTestId('approval-dialog');

    await userEvent.click(screen.getByTestId('approval-tier-input-task'));
    await userEvent.click(screen.getByTestId('approval-allow'));
    await waitFor(() => expect(approvalCalls).toHaveLength(1));
    expect(approvalCalls[0]?.body).toEqual({ decision: 'allow', scope: 'task' });
    await waitFor(() => expect(screen.queryByTestId('approval-dialog')).not.toBeInTheDocument());

    // 只读工具的「本工作区」档同样可提交
    emitApprovalRequest('Read', 'src/b.ts', 'read', 'r2');
    await screen.findByTestId('approval-dialog');
    await userEvent.click(screen.getByTestId('approval-tier-input-workspace'));
    await userEvent.click(screen.getByTestId('approval-allow'));
    await waitFor(() => expect(approvalCalls).toHaveLength(2));
    expect(approvalCalls[1]?.body).toEqual({ decision: 'allow', scope: 'workspace' });
  });
});

describe('CHAT-APP2 审批规则工作表', () => {
  it('⋯ 打开规则列表，撤销后行从列表移除', async () => {
    rules = [makeRule()];
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('chat-header-menu-btn'));
    await userEvent.click(screen.getByTestId('approval-rules-btn'));

    const row = await screen.findByTestId('approval-rule-row-r-1');
    expect(row).toHaveTextContent('read');
    expect(row).toHaveTextContent('read::src/a.ts');
    expect(row).toHaveTextContent('本工作区');

    await userEvent.click(screen.getByTestId('approval-rule-revoke-r-1'));
    await waitFor(() => expect(revokeCalls).toEqual(['r-1']));
    await waitFor(() => expect(screen.queryByTestId('approval-rule-row-r-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('approval-rules-empty')).toBeInTheDocument();
  });
});
