/**
 * DEC-6：待决策视图 / 卡面锁标识 / 详情决策区。
 *
 * 覆盖：四段分组与倒计时格式（纯函数）、徽标数（grace+open）、窄屏不折行、
 * grace 到期本地移入未回答、open 卡 [待决策] 已等待、详情两版答案时间线 + checkpoint + 修订请求。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Workspace } from '@agentboard/shared';
import { DecisionsView } from '../components/decisions/DecisionsView';
import { DecisionMark } from '../components/decisions/DecisionMark';
import { DecisionSection, checkpointLines } from '../components/decisions/DecisionSection';
import { formatCountdown, formatWaiting, groupDecisions } from '../components/decisions/countdown';
import type { DecisionDetailDto, DecisionListItemDto } from '../components/decisions/types';
import { SideBar } from '../components/shell/SideBar';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const WORKSPACE_ID = 'ws-1';
const ws: Workspace = { id: WORKSPACE_ID, name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };
const NOW = Date.now();

function listItem(overrides: Partial<DecisionListItemDto> & Pick<DecisionListItemDto, 'id' | 'state'>): DecisionListItemDto {
  return {
    workspace_id: WORKSPACE_ID,
    issue_id: `issue-${overrides.id}`,
    question: `问题 ${overrides.id}`,
    context_md: '',
    trigger: 'agent',
    created_by: 'agent:executor',
    grace_seconds: 180,
    grace_until: NOW,
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
    remaining_grace_seconds: null,
    waiting_seconds: null,
    ...overrides,
  };
}

const graceItem = listItem({ id: 'dec-grace', state: 'grace', grace_until: NOW + 120_000, remaining_grace_seconds: 120 });
const openItem = listItem({ id: 'dec-open', state: 'open', locked_at: NOW - 3600_000, waiting_seconds: 3600 });
const staleItem = listItem({
  id: 'dec-stale',
  state: 'open',
  locked_at: NOW - 80 * 3600_000,
  waiting_seconds: 80 * 3600,
  issue_title: '超时任务',
});
const answeredItem = listItem({
  id: 'dec-answered',
  state: 'answered',
  answer_revision: 2,
  answered_at: NOW - 3600_000,
});

function decisionHandler(active: DecisionListItemDto[], answered: DecisionListItemDto[]) {
  return http.get('/api/decisions', ({ request }) => {
    const url = new URL(request.url);
    const isAnswered = url.searchParams.get('state') === 'answered';
    return HttpResponse.json({
      decisions: isAnswered ? answered : active,
      counts: {
        grace: active.filter((item) => item.state === 'grace').length,
        open: active.filter((item) => item.state === 'open').length,
        stale_open: 1,
        answered_recent: answered.length,
      },
    });
  });
}

function renderWithQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAppStore.setState({ workspaceId: WORKSPACE_ID });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null, decisionFocus: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
});

const issue = (overrides: Partial<Issue> & Pick<Issue, 'id'>): Issue =>
  ({
    workspace_id: WORKSPACE_ID,
    title: '任务',
    description: '',
    priority: '中',
    labels: [],
    status: '待规划',
    sort_order: 0,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  }) as Issue;

describe('DEC-6 分组与倒计时', () => {
  it('倒计时 / 等待时长格式', () => {
    expect(formatCountdown(180)).toBe('3:00');
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatWaiting(12)).toBe('12 秒');
    expect(formatWaiting(330)).toBe('5 分 30 秒');
    expect(formatWaiting(3 * 3600 + 20 * 60)).toBe('3 小时 20 分');
    expect(formatWaiting(null)).toBeNull();
  });

  it('四段分组：grace 到期本地移入未回答；open 锁后 72h 进已超时；answered 只留 24h', () => {
    const expiredGrace = listItem({ id: 'dec-expired', state: 'grace', grace_until: NOW - 1000 });
    const oldAnswered = listItem({ id: 'dec-old', state: 'answered', answered_at: NOW - 30 * 3600_000 });
    const groups = groupDecisions([graceItem, expiredGrace, openItem, staleItem], [answeredItem, oldAnswered], NOW);

    expect(groups.grace.map((item) => item.id)).toEqual(['dec-grace']);
    expect(groups.open.map((item) => item.id)).toEqual(['dec-expired', 'dec-open']);
    expect(groups.stale.map((item) => item.id)).toEqual(['dec-stale']);
    expect(groups.answered.map((item) => item.id)).toEqual(['dec-answered']);
  });

  it('checkpoint_json 解析成可读行；非 JSON 原样展示', () => {
    expect(checkpointLines('{"stash_sha":"abc","diff_summary":"2 files","next_step":"等回答"}')).toEqual([
      'stash SHA：abc',
      '改动摘要：2 files',
      '下一步：等回答',
    ]);
    expect(checkpointLines('纯文本断点')).toEqual(['纯文本断点']);
    expect(checkpointLines(null)).toEqual([]);
  });
});

describe('DEC-6 徽标与卡面标识', () => {
  it('徽标 = grace + open 条数；0 时不显示', async () => {
    server.use(
      http.get('/api/workspaces/:id/decisions/count', () =>
        HttpResponse.json({ grace: 1, open: 1, stale_open: 0, answered_recent: 0 }),
      ),
    );
    renderWithQuery(<SideBar workspace={ws} />);
    await waitFor(() => expect(screen.getByTestId('sidebar-decisions-badge')).toHaveTextContent('2'));

    cleanup();
    server.use(
      http.get('/api/workspaces/:id/decisions/count', () =>
        HttpResponse.json({ grace: 0, open: 0, stale_open: 0, answered_recent: 1 }),
      ),
    );
    renderWithQuery(<SideBar workspace={ws} />);
    expect(screen.queryByTestId('sidebar-decisions-badge')).toBeNull();
    // 入口仍在
    expect(screen.getByTestId('sidebar-entry-decisions')).toBeInTheDocument();
  });

  it('grace 卡显示倒计时；open 卡显示已等待时长', () => {
    render(<DecisionMark issue={issue({ id: 'issue-a', decision_grace_until: Date.now() + 90_000 })} />);
    const mark = screen.getByTestId('decision-mark-issue-a');
    expect(mark).toHaveTextContent('[待决策] 剩 1:30');
    expect(mark).toHaveAttribute('data-decision-state', 'grace');

    cleanup();
    render(<DecisionMark issue={issue({ id: 'issue-b', decision_locked: true, decision_waiting_seconds: 330 })} />);
    const locked = screen.getByTestId('decision-mark-issue-b');
    expect(locked).toHaveTextContent('[待决策] 已等 5 分 30 秒');
    expect(locked).toHaveAttribute('data-decision-state', 'open');
  });

  it('无决策字段的旧卡不渲染标识', () => {
    const { container } = render(<DecisionMark issue={issue({ id: 'issue-c' })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DEC-6 待决策视图', () => {
  it('四段渲染、倒计时不折行、点击立即回答打开卡详情', async () => {
    server.use(decisionHandler([graceItem, openItem, staleItem], [answeredItem]));
    renderWithQuery(<DecisionsView />);

    await waitFor(() => expect(screen.getByTestId('decision-item-dec-grace')).toBeInTheDocument());

    expect(within(screen.getByTestId('decisions-group-grace')).getByTestId('decision-item-dec-grace')).toBeInTheDocument();
    expect(within(screen.getByTestId('decisions-group-open')).getByTestId('decision-item-dec-open')).toBeInTheDocument();
    expect(within(screen.getByTestId('decisions-group-stale')).getByTestId('decision-item-dec-stale')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('decisions-group-answered')).getByTestId('decision-item-dec-answered'),
    ).toBeInTheDocument();

    const countdown = screen.getByTestId('decision-countdown-dec-grace');
    expect(countdown.textContent).toMatch(/1:5\d|2:00/);
    expect(countdown.className).toContain('whitespace-nowrap');

    fireEvent.click(screen.getByTestId('decision-action-dec-grace'));
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: graceItem.issue_id });
  });

  it('深链 focusDecision 选中对应条目', async () => {
    server.use(decisionHandler([graceItem, openItem, staleItem], [answeredItem]));
    useNavStore.setState({ view: 'decisions', decisionFocus: 'dec-open' });
    renderWithQuery(<DecisionsView />);

    await waitFor(() => expect(screen.getByTestId('decision-item-dec-open')).toHaveAttribute('data-selected', 'true'));
    expect(screen.getByTestId('decision-item-dec-grace')).toHaveAttribute('data-selected', 'false');
  });
});

describe('DEC-6 详情决策区', () => {
  const detail: DecisionDetailDto = {
    ...answeredItem,
    checkpoint_json: '{"stash_sha":"abc123","next_step":"等回答后继续"}',
    current_answer_id: 'ans-2',
    expires_at: null,
    on_expire: 'lock',
    options: [
      { id: 'opt-a', ord: 1, label: '方案 A', consequence: '继续执行', is_default: 0 },
      { id: 'opt-b', ord: 2, label: '方案 B', consequence: '改走回滚', is_default: 0 },
    ],
    answers: [
      {
        id: 'ans-1',
        revision: 1,
        option_id: 'opt-a',
        answer_text: null,
        answered_by: 'human:lead',
        source: 'web',
        created_at: NOW - 7200_000,
      },
      {
        id: 'ans-2',
        revision: 2,
        option_id: 'opt-b',
        answer_text: null,
        answered_by: 'human:lead',
        source: 'web',
        created_at: NOW - 1800_000,
      },
    ],
  };

  it('展示问题 / 选项 / 两版答案时间线 / checkpoint 摘要，修订带 expected_revision', async () => {
    const posted: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/api/decisions', ({ request }) => {
        const url = new URL(request.url);
        const isAnswered = url.searchParams.get('state') === 'answered';
        return HttpResponse.json({
          decisions: isAnswered ? [answeredItem] : [],
          counts: { grace: 0, open: 0, stale_open: 0, answered_recent: 1 },
        });
      }),
      http.get('/api/decisions/dec-answered', () => HttpResponse.json({ decision: detail })),
      http.post('/api/decisions/dec-answered/answer', async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ decision: detail });
      }),
    );

    renderWithQuery(
      <DecisionSection issue={issue({ id: answeredItem.issue_id, open_decision_id: null })} />,
    );

    await waitFor(() => expect(screen.getByTestId('decision-question')).toHaveTextContent('问题 dec-answered'));
    expect(screen.getByTestId('decision-state')).toHaveTextContent('已回答');
    await waitFor(() => expect(screen.getByTestId('decision-answer-revision-1')).toHaveTextContent('第 1 版'));
    expect(screen.getByTestId('decision-answer-revision-2')).toHaveTextContent('第 2 版');
    await waitFor(() => expect(screen.getByTestId('decision-checkpoint')).toHaveTextContent('stash SHA：abc123'));
    expect(screen.getByTestId('decision-checkpoint')).toHaveTextContent('下一步：等回答后继续');

    fireEvent.click(screen.getByTestId('decision-answer-opt-a'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ option_id: 'opt-a', source: 'web', expected_revision: 2 });
  });

  it('无决策时详情区不渲染', async () => {
    renderWithQuery(<DecisionSection issue={issue({ id: 'issue-none' })} />);
    await waitFor(() => expect(screen.queryByTestId('decision-section')).toBeNull());
  });
});
