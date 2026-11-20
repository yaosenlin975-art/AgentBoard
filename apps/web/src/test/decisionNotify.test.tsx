/**
 * DEC-7：通知两档 + 降级。
 *
 * 覆盖四类通道：Tauri（有壳，权限允许/拒绝）、Web Notification（允许/默认）、
 * 无任何通道（inapp）；以及应用内三件套中的汇总条与常驻 toast（忽略 / 立即回答深链）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { StrictMode } from 'react';
import { DecisionNotifier } from '../components/decisions/DecisionNotifier';
import {
  isNotificationGranted,
  notificationChannel,
  notifyDecision,
  requestNotificationPermission,
} from '../components/decisions/notify';
import type { DecisionListItemDto } from '../components/decisions/types';
import { DECISIONS_SCOPE_KEY } from '../lib/decisionsScope';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { server } from './server';

const WORKSPACE_ID = 'ws-1';
const TARGET_WORKSPACE_1 = '10000000-0000-4000-8000-000000000001';
const TARGET_WORKSPACE_2 = '10000000-0000-4000-8000-000000000002';
const TARGET_DECISION_1 = '20000000-0000-4000-8000-000000000001';
const TARGET_DECISION_2 = '20000000-0000-4000-8000-000000000002';
const NOW = Date.now();

interface FakeInternals {
  invoke: ReturnType<typeof vi.fn>;
}

function setInternals(internals: FakeInternals | null): void {
  if (internals === null) {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  } else {
    (window as unknown as { __TAURI_INTERNALS__?: FakeInternals }).__TAURI_INTERNALS__ = internals;
  }
}

function setWebNotification(permission: NotificationPermission, requestResult: NotificationPermission): void {
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => requestResult);
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      readonly title: string,
      readonly options?: NotificationOptions,
    ) {
      created.push(this);
    }
  }
  created = [];
  (window as unknown as { Notification: unknown }).Notification = FakeNotification;
}

let created: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null; close: () => void }> = [];

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setInternals(null);
  delete (window as unknown as { Notification?: unknown }).Notification;
  delete (window as unknown as { __AGENTBOARD_PENDING_DECISION__?: unknown }).__AGENTBOARD_PENDING_DECISION__;
  created = [];
  useAppStore.setState({ workspaceId: WORKSPACE_ID });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null, decisionFocus: null });
});

afterEach(() => {
  setInternals(null);
  delete (window as unknown as { Notification?: unknown }).Notification;
});

describe('DEC-7 通知通道', () => {
  it('无壳无 Notification → inapp；不会抛异常', async () => {
    expect(notificationChannel()).toBe('inapp');
    expect(await notifyDecision({ title: 't', body: 'b', decisionId: 'd1' })).toBe('inapp');
    expect(await isNotificationGranted()).toBe(false);
  });

  it('Web Notification 已授权：发通知并支持点击深链', async () => {
    setWebNotification('granted', 'granted');
    expect(notificationChannel()).toBe('web');

    const onOpen = vi.fn();
    expect(await notifyDecision({ title: '卡标题', body: '问题摘要', decisionId: 'd1', onOpen })).toBe('web');
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('卡标题');
    expect(created[0]!.options?.body).toBe('问题摘要');

    created[0]!.onclick?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('Web Notification 默认权限（未授权）→ inapp，不实例化通知', async () => {
    setWebNotification('default', 'denied');
    expect(await notifyDecision({ title: 't', body: 'b', decisionId: 'd1' })).toBe('inapp');
    expect(created).toHaveLength(0);
    // 权限申请必须由调用方手势触发；这里断言 API 返回 denied 即可
    expect(await requestNotificationPermission()).toBe(false);
  });

  it('Tauri 已授权：走插件命令并返回 tauri', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return true;
      if (command === 'plugin:notification|request_permission') return 'granted';
      return undefined;
    });
    setInternals({ invoke });

    expect(notificationChannel()).toBe('tauri');
    expect(await isNotificationGranted()).toBe(true);
    expect(await notifyDecision({ title: 't', body: 'b', decisionId: 'd1' })).toBe('tauri');
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: { title: 't', body: 'b' },
    });
  });

  it('Tauri 权限拒绝：不发通知，降级 inapp', async () => {
    const invoke = vi.fn(async () => false);
    setInternals({ invoke });

    expect(await notifyDecision({ title: 't', body: 'b', decisionId: 'd1' })).toBe('inapp');
    expect(invoke).not.toHaveBeenCalledWith('plugin:notification|notify', expect.anything());
  });

  it('Tauri 命令抛错：吞掉异常并降级 inapp', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('IPC 不可用');
    });
    setInternals({ invoke });

    await expect(notifyDecision({ title: 't', body: 'b', decisionId: 'd1' })).resolves.toBe('inapp');
    await expect(isNotificationGranted()).resolves.toBe(false);
  });
});

function listItem(overrides: Partial<DecisionListItemDto> & Pick<DecisionListItemDto, 'id'>): DecisionListItemDto {
  return {
    workspace_id: WORKSPACE_ID,
    issue_id: `issue-${overrides.id}`,
    question: `问题 ${overrides.id}`,
    context_md: '',
    trigger: 'agent',
    state: 'grace',
    created_by: 'agent:executor',
    grace_seconds: 180,
    grace_until: NOW + 90_000,
    locked_at: null,
    stop_requested_at: null,
    stop_ack_at: null,
    answer_revision: 0,
    created_at: NOW - 60_000,
    answered_at: null,
    withdrawn_at: null,
    withdrawn_by: null,
    withdrawn_reason: null,
    issue_title: `任务 ${overrides.id}`,
    issue_status: '待规划',
    issue_priority: '中',
    option_count: 2,
    options: [
      { id: `option-a-${overrides.id}`, ord: 1, label: '继续', consequence: '继续执行', is_default: 1 },
      { id: `option-b-${overrides.id}`, ord: 2, label: '停止', consequence: '停在检查点', is_default: 0 },
    ],
    blocked_downstream_count: 0,
    remaining_grace_seconds: 90,
    waiting_seconds: null,
    ...overrides,
  };
}

function renderWithQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function emptyDecisionHandler() {
  return http.get('/api/decisions', () =>
    HttpResponse.json({ decisions: [], counts: { grace: 0, open: 0, stale_open: 0, answered_recent: 0 } }),
  );
}

describe('DEC-7 桌面通知决策目标接收', () => {
  it('挂载时消费启动 pending 槽一次，并保留所有工作区范围', async () => {
    server.use(emptyDecisionHandler());
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'all');
    const focusDecision = vi.spyOn(useNavStore.getState(), 'focusDecision');
    (window as unknown as { __AGENTBOARD_PENDING_DECISION__?: unknown }).__AGENTBOARD_PENDING_DECISION__ = {
      workspaceId: TARGET_WORKSPACE_1,
      decisionId: TARGET_DECISION_1,
    };

    try {
      renderWithQuery(
        <StrictMode>
          <DecisionNotifier />
        </StrictMode>,
      );

      await waitFor(() =>
        expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: TARGET_DECISION_1 }),
      );
      expect(useAppStore.getState().workspaceId).toBe(TARGET_WORKSPACE_1);
      expect(
        (window as unknown as { __AGENTBOARD_PENDING_DECISION__?: unknown }).__AGENTBOARD_PENDING_DECISION__,
      ).toBeUndefined();
      expect(focusDecision).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(DECISIONS_SCOPE_KEY)).toBe('all');
    } finally {
      focusDecision.mockRestore();
    }
  });

  it('连续事件各自切工作区并替换定位目标，保留当前工作区范围', () => {
    server.use(emptyDecisionHandler());
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'workspace');
    renderWithQuery(<DecisionNotifier />);

    fireEvent(
      window,
      new CustomEvent('agentboard:open-decision', {
        detail: { workspaceId: TARGET_WORKSPACE_1, decisionId: TARGET_DECISION_1 },
      }),
    );
    expect(useAppStore.getState().workspaceId).toBe(TARGET_WORKSPACE_1);
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: TARGET_DECISION_1 });

    fireEvent(
      window,
      new CustomEvent('agentboard:open-decision', {
        detail: { workspaceId: TARGET_WORKSPACE_2, decisionId: TARGET_DECISION_2 },
      }),
    );
    expect(useAppStore.getState().workspaceId).toBe(TARGET_WORKSPACE_2);
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: TARGET_DECISION_2 });
    expect(localStorage.getItem(DECISIONS_SCOPE_KEY)).toBe('workspace');
  });

  it('忽略非法 pending 与事件目标，不改工作区、视图或焦点', () => {
    server.use(emptyDecisionHandler());
    const originalWorkspaceId = useAppStore.getState().workspaceId;
    (window as unknown as { __AGENTBOARD_PENDING_DECISION__?: unknown }).__AGENTBOARD_PENDING_DECISION__ = {
      workspaceId: TARGET_WORKSPACE_1,
      decisionId: 'not-a-uuid',
    };
    renderWithQuery(<DecisionNotifier />);

    expect(
      (window as unknown as { __AGENTBOARD_PENDING_DECISION__?: unknown }).__AGENTBOARD_PENDING_DECISION__,
    ).toBeUndefined();
    for (const detail of [
      { workspaceId: TARGET_WORKSPACE_1, decisionId: 'bad-id' },
      { workspaceId: 'bad-workspace', decisionId: TARGET_DECISION_1 },
      null,
    ]) {
      fireEvent(window, new CustomEvent('agentboard:open-decision', { detail }));
    }

    expect(useAppStore.getState().workspaceId).toBe(originalWorkspaceId);
    expect(useNavStore.getState()).toMatchObject({ view: 'board', decisionFocus: null });
  });
});

describe('DEC-7 应用内降级三件套', () => {
  it('有 N 条待决策汇总条 + 常驻 toast；忽略后消失；立即回答深链选中', async () => {
    server.use(
      http.get('/api/decisions', ({ request }) => {
        const isAnswered = new URL(request.url).searchParams.get('state') === 'answered';
        return HttpResponse.json({
          decisions: isAnswered ? [] : [listItem({ id: 'dec-1' })],
          counts: { grace: isAnswered ? 0 : 1, open: 0, stale_open: 0, answered_recent: 0 },
        });
      }),
    );
    useNavStore.setState({ view: 'board' });
    renderWithQuery(<DecisionNotifier />);

    await waitFor(() => expect(screen.getByTestId('decisions-summary-bar')).toHaveTextContent('有 1 条待决策'));
    expect(screen.getByTestId('decision-toast-dec-1')).toHaveTextContent('问题 dec-1');

    fireEvent.click(screen.getByTestId('decision-toast-dismiss-dec-1'));
    expect(screen.queryByTestId('decision-toast-dec-1')).toBeNull();
    // 汇总条仍保留（忽略只影响本会话的 toast，不改变待决策事实）
    expect(screen.getByTestId('decisions-summary-bar')).toBeInTheDocument();

    cleanup();
    renderWithQuery(<DecisionNotifier />);
    await waitFor(() => expect(screen.getByTestId('decision-toast-dec-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('decision-toast-open-dec-1'));
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: 'dec-1' });
  });

  it('待决策视图内不重复渲染汇总条与 toast（列表本身即提示）', async () => {
    server.use(
      http.get('/api/decisions', () =>
        HttpResponse.json({
          decisions: [listItem({ id: 'dec-1' })],
          counts: { grace: 1, open: 0, stale_open: 0, answered_recent: 0 },
        }),
      ),
    );
    useNavStore.setState({ view: 'decisions' });
    renderWithQuery(<DecisionNotifier />);

    await waitFor(() => expect(screen.queryByTestId('decisions-summary-bar')).toBeNull());
    expect(screen.queryByTestId('decisions-toasts')).toBeNull();
  });

  it('无待决策时不渲染任何降级 UI', async () => {
    renderWithQuery(<DecisionNotifier />);
    await waitFor(() => expect(screen.queryByTestId('decisions-summary-bar')).toBeNull());
    expect(screen.queryByTestId('decisions-toasts')).toBeNull();
  });
});
