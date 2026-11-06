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

    fireEvent.click(screen.getByTestId('decision-open-dec-grace'));
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

describe('DEC-V4-QUEUE 处置队列', () => {
  const qGrace1 = listItem({ id: 'q-g1', state: 'grace', grace_until: NOW + 90_000, created_at: NOW - 30_000, issue_priority: '中' });
  const qGrace2 = listItem({ id: 'q-g2', state: 'grace', grace_until: NOW + 60_000, created_at: NOW - 10_000, issue_priority: '高' });
  const qGrace3 = listItem({ id: 'q-g3', state: 'grace', grace_until: NOW + 150_000, created_at: NOW - 50_000, issue_priority: '低' });
  const qOpen1 = listItem({
    id: 'q-o1', state: 'open', locked_at: NOW - 2000, created_at: NOW - 70_000,
    blocked_downstream_count: 2, issue_priority: '中',
  });
  const qOpen2 = listItem({
    id: 'q-o2', state: 'open', locked_at: NOW - 1000, created_at: NOW - 80_000,
    blocked_downstream_count: 0, issue_priority: '高',
  });
  const qStale = listItem({
    id: 'q-s1', state: 'open', locked_at: NOW - 80 * 3600_000, created_at: NOW - 100 * 3600_000,
    issue_priority: '低',
  });
  const qAnswered = listItem({ id: 'q-a1', state: 'answered', answered_at: NOW - 3600_000 });
  const queueActive = [qGrace1, qGrace2, qGrace3, qOpen1, qOpen2, qStale];

  const itemOrder = () =>
    screen.getAllByTestId(/^decision-item-/).map((node) => node.getAttribute('data-testid'));

  it('页头只留标题 + 在途总数徽标；筛选 tab 计数来自完整分组', async () => {
    server.use(decisionHandler(queueActive, [qAnswered]));
    renderWithQuery(<DecisionsView />);
    await waitFor(() => expect(screen.getByTestId('decision-item-q-g2')).toBeInTheDocument());

    expect(screen.queryByTestId('decisions-summary')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('宽限 3 · 未回答 2');
    expect(screen.getByTestId('decisions-total')).toHaveTextContent('6');
    expect(screen.getByTestId('decisions-tab-count-all')).toHaveTextContent('7');
    expect(screen.getByTestId('decisions-tab-count-grace')).toHaveTextContent('3');
    expect(screen.getByTestId('decisions-tab-count-open')).toHaveTextContent('2');
    expect(screen.getByTestId('decisions-tab-count-stale')).toHaveTextContent('1');
    expect(screen.getByTestId('decisions-tab-count-answered')).toHaveTextContent('1');
  });

  it('默认紧急度：宽限倒计时升序 → open 下游数降序 → 已超时；rank 连续且 answered 无 rank', async () => {
    server.use(decisionHandler(queueActive, [qAnswered]));
    renderWithQuery(<DecisionsView />);
    await waitFor(() => expect(screen.getByTestId('decision-item-q-g2')).toBeInTheDocument());

    expect(itemOrder()).toEqual([
      'decision-item-q-g2',
      'decision-item-q-g1',
      'decision-item-q-g3',
      'decision-item-q-o1',
      'decision-item-q-o2',
      'decision-item-q-s1',
      'decision-item-q-a1',
    ]);
    expect(screen.getByTestId('decision-rank-q-g2')).toHaveTextContent('#1');
    expect(screen.getByTestId('decision-rank-q-g1')).toHaveTextContent('#2');
    expect(screen.getByTestId('decision-rank-q-g3')).toHaveTextContent('#3');
    expect(screen.getByTestId('decision-rank-q-o1')).toHaveTextContent('#4');
    expect(screen.getByTestId('decision-rank-q-o2')).toHaveTextContent('#5');
    expect(screen.getByTestId('decision-rank-q-s1')).toHaveTextContent('#6');
    expect(screen.queryByTestId('decision-rank-q-a1')).not.toBeInTheDocument();
  });

  it('切 tab 只渲染该层并重新从 #1 编号；切回全部恢复连续编号', async () => {
    server.use(decisionHandler(queueActive, [qAnswered]));
    renderWithQuery(<DecisionsView />);
    await waitFor(() => expect(screen.getByTestId('decision-item-q-g2')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('decisions-tab-stale'));
    expect(screen.queryByTestId('decisions-group-grace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decisions-group-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decisions-group-answered')).not.toBeInTheDocument();
    expect(itemOrder()).toEqual(['decision-item-q-s1']);
    expect(screen.getByTestId('decision-rank-q-s1')).toHaveTextContent('#1');

    fireEvent.click(screen.getByTestId('decisions-tab-all'));
    expect(screen.getByTestId('decision-rank-q-g2')).toHaveTextContent('#1');
    expect(screen.getByTestId('decision-rank-q-s1')).toHaveTextContent('#6');
  });

  it('等待最久：grace/open 按 created_at 升序，同键回落紧急度；answered 保持回答时间倒序', async () => {
    const groups = groupDecisions(queueActive, [qAnswered], NOW, 'waiting');
    expect(groups.grace.map((item) => item.id)).toEqual(['q-g3', 'q-g1', 'q-g2']);
    expect(groups.open.map((item) => item.id)).toEqual(['q-o2', 'q-o1']);
    expect(groups.answered.map((item) => item.id)).toEqual(['q-a1']);
  });

  it('任务优先级：grace/open/stale 按 高>中>低，同键回落紧急度；answered 不变', async () => {
    const groups = groupDecisions(queueActive, [qAnswered], NOW, 'priority');
    expect(groups.grace.map((item) => item.id)).toEqual(['q-g2', 'q-g1', 'q-g3']);
    expect(groups.open.map((item) => item.id)).toEqual(['q-o2', 'q-o1']);
    expect(groups.stale.map((item) => item.id)).toEqual(['q-s1']);
    expect(groups.answered.map((item) => item.id)).toEqual(['q-a1']);
  });

  it('排序下拉可切换到等待最久，DOM 顺序随之变化', async () => {
    server.use(decisionHandler(queueActive, [qAnswered]));
    renderWithQuery(<DecisionsView />);
    await waitFor(() => expect(screen.getByTestId('decision-item-q-g2')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('decisions-sort'), { target: { value: 'waiting' } });
    expect(itemOrder().slice(0, 5)).toEqual([
      'decision-item-q-g3',
      'decision-item-q-g1',
      'decision-item-q-g2',
      'decision-item-q-o2',
      'decision-item-q-o1',
    ]);
  });

  it('字段缺失兜底：blocked_downstream_count / issue_priority 缺省不报错、不出现 NaN', async () => {
    const noCount: DecisionListItemDto = {
      ...listItem({ id: 'q-missing', state: 'open', locked_at: NOW - 500 }),
      blocked_downstream_count: undefined as unknown as number,
      issue_priority: undefined as unknown as DecisionListItemDto['issue_priority'],
    };
    server.use(decisionHandler([noCount], []));
    renderWithQuery(<DecisionsView />);
    await waitFor(() => expect(screen.getByTestId('decision-item-q-missing')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('NaN');

    const groups = groupDecisions([noCount], [], NOW, 'priority');
    expect(groups.open.map((item) => item.id)).toEqual(['q-missing']);
  });
});

describe('DEC-V4-INLINE 就地作答卡', () => {
  const graceOptions = listItem({ id: 'inline-grace', state: 'grace', grace_until: NOW + 120_000 }).options;
  const inlineGrace = listItem({ id: 'inline-grace', state: 'grace', grace_until: NOW + 120_000 });
  const inlineAnswered = listItem({ id: 'inline-answered', state: 'answered', answer_revision: 2, answered_at: NOW - 60_000 });

  function detailFor(
    base: DecisionListItemDto,
    answers: DecisionDetailDto['answers'],
    checkpoint: string | null = null,
  ): DecisionDetailDto {
    return {
      ...base,
      checkpoint_json: checkpoint,
      current_answer_id: answers.length > 0 ? answers[answers.length - 1]!.id : null,
      expires_at: null,
      on_expire: 'stay_locked',
      options: base.options,
      answers,
    };
  }

  function postAnswer(posts: Array<Record<string, unknown>>, response: () => Record<string, unknown>) {
    return http.post('/api/decisions/:id/answer', async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(response());
    });
  }

  it('收起态：主按钮默认禁用；选中第二个选项后可用，提交发出 1 次 POST（含 option_id / source）', async () => {
    const posts: Array<Record<string, unknown>> = [];
    server.use(
      decisionHandler([inlineGrace], []),
      postAnswer(posts, () => ({ decision: detailFor(inlineGrace, []) })),
    );
    renderWithQuery(<DecisionsView />);

    const action = await screen.findByTestId('decision-action-inline-grace');
    expect(action).toBeDisabled();
    expect(screen.getByTestId(`decision-option-${graceOptions[0]!.id}`)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId(`decision-option-${graceOptions[1]!.id}`));
    expect(screen.getByTestId('decision-action-inline-grace')).toBeEnabled();

    fireEvent.click(screen.getByTestId('decision-action-inline-grace'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ option_id: graceOptions[1]!.id, source: 'web' });
    expect(posts[0]).not.toHaveProperty('expected_revision');
  });

  it('单选：点 A 再点 B 只保留 B；重复点 B 不会取消选中', async () => {
    server.use(decisionHandler([inlineGrace], []));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-inline-grace');

    const a = graceOptions[0]!;
    const b = graceOptions[1]!;
    fireEvent.click(screen.getByTestId(`decision-option-${a.id}`));
    expect(screen.getByTestId(`decision-option-${a.id}`)).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId(`decision-option-${b.id}`));
    expect(screen.getByTestId(`decision-option-${a.id}`)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId(`decision-option-${b.id}`)).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId(`decision-option-${b.id}`));
    expect(screen.getByTestId(`decision-option-${b.id}`)).toHaveAttribute('aria-pressed', 'true');
  });

  it('后果预览：默认展示默认选项 consequence；选中后跟随切换', async () => {
    server.use(decisionHandler([inlineGrace], []));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-inline-grace');

    const preview = screen.getByTestId('decision-consequence-inline-grace');
    expect(preview).toHaveTextContent(graceOptions[0]!.consequence);

    fireEvent.click(screen.getByTestId(`decision-option-${graceOptions[1]!.id}`));
    expect(screen.getByTestId('decision-consequence-inline-grace')).toHaveTextContent(graceOptions[1]!.consequence);
  });

  it('展开态只渲染详细卡：chip 行不进 DOM，含选项 consequence / 默认标 / 断点 / 答案时间线', async () => {
    const answered = detailFor(
      inlineAnswered,
      [
        { id: 'a-1', revision: 1, option_id: inlineAnswered.options[0]!.id, answer_text: null, answered_by: 'human:lead', source: 'web', created_at: NOW - 7200_000 },
        { id: 'a-2', revision: 2, option_id: inlineAnswered.options[1]!.id, answer_text: null, answered_by: 'human:lead', source: 'web', created_at: NOW - 1800_000 },
      ],
      '{"stash_sha":"abc123","next_step":"等回答后继续"}',
    );
    server.use(
      decisionHandler([], [inlineAnswered]),
      http.get('/api/decisions/inline-answered', () => HttpResponse.json({ decision: answered })),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-inline-answered');

    // 收起态：当前答案选项 + 「改答案」入口
    await waitFor(() =>
      expect(screen.getByTestId('decision-current-answer-inline-answered')).toHaveTextContent(
        `第 2 版「${inlineAnswered.options[1]!.label}」`,
      ),
    );
    fireEvent.click(screen.getByTestId('decision-revise-inline-answered'));

    expect(screen.queryByTestId('decision-chips-inline-answered')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-full-question-inline-answered')).toHaveTextContent(inlineAnswered.question);
    expect(screen.getByTestId('decision-options-inline-answered')).toHaveTextContent(
      inlineAnswered.options[1]!.consequence,
    );
    expect(screen.getByTestId(`decision-default-${inlineAnswered.options[0]!.id}`)).toHaveTextContent('默认');
    expect(screen.getByTestId('decision-checkpoint-inline-answered')).toHaveTextContent('stash SHA：abc123');
    expect(screen.getByTestId('decision-answer-revision-inline-answered-1')).toHaveTextContent('第 1 版');
    expect(screen.getByTestId('decision-answer-revision-inline-answered-2')).toHaveAttribute('data-current', 'true');
  });

  it('改答案：提交带 expected_revision，成功后 revision 递增且新版高亮', async () => {
    const posts: Array<Record<string, unknown>> = [];
    let revision = 2;
    let detail = detailFor(inlineAnswered, [
      { id: 'a-2', revision: 2, option_id: inlineAnswered.options[1]!.id, answer_text: null, answered_by: 'human:lead', source: 'web', created_at: NOW - 1800_000 },
    ]);

    server.use(
      http.get('/api/decisions', ({ request }) => {
        const url = new URL(request.url);
        const answered = url.searchParams.get('state') === 'answered';
        return HttpResponse.json({
          decisions: answered ? [{ ...inlineAnswered, answer_revision: revision }] : [],
          counts: { grace: 0, open: 0, stale_open: 0, answered_recent: 1 },
        });
      }),
      http.get('/api/decisions/inline-answered', () => HttpResponse.json({ decision: detail })),
      http.post('/api/decisions/inline-answered/answer', async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        revision += 1;
        detail = detailFor(
          { ...inlineAnswered, answer_revision: revision },
          [
            ...detail.answers,
            {
              id: `a-${revision}`,
              revision,
              option_id: inlineAnswered.options[0]!.id,
              answer_text: null,
              answered_by: 'human:lead',
              source: 'web',
              created_at: NOW,
            },
          ],
        );
        return HttpResponse.json({ decision: detail });
      }),
    );

    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-inline-answered');
    fireEvent.click(screen.getByTestId('decision-revise-inline-answered'));
    fireEvent.click(screen.getByTestId(`decision-detail-option-${inlineAnswered.options[0]!.id}`));
    fireEvent.click(screen.getByTestId('decision-action-inline-answered'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ option_id: inlineAnswered.options[0]!.id, expected_revision: 2 });

    await waitFor(() =>
      expect(screen.getByTestId('decision-answer-revision-inline-answered-3')).toHaveAttribute('data-current', 'true'),
    );
    expect(screen.getByTestId('decision-answer-revision-inline-answered-2')).toHaveAttribute('data-current', 'false');
  });

  it('停止确认状态：未确认显示红字，已确认显示「已确认停止」', async () => {
    const unacked = listItem({
      id: 'stop-unacked',
      state: 'open',
      locked_at: NOW - 5000,
      stop_requested_at: NOW - 2000,
    });
    const acked = listItem({
      id: 'stop-acked',
      state: 'open',
      locked_at: NOW - 5000,
      stop_requested_at: NOW - 4000,
      stop_ack_at: NOW - 1000,
    });
    server.use(decisionHandler([unacked, acked], []));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-stop-unacked');

    expect(screen.getByTestId('decision-stop-unacked-stop-unacked')).toHaveTextContent('停止未确认');
    expect(screen.getByTestId('decision-stop-unacked-stop-unacked').className).toContain('text-red');
    expect(screen.queryByTestId('decision-stop-acked-stop-unacked')).not.toBeInTheDocument();

    expect(screen.getByTestId('decision-stop-acked-stop-acked')).toHaveTextContent('已确认停止');
    expect(screen.queryByTestId('decision-stop-unacked-stop-acked')).not.toBeInTheDocument();
  });

  it('409 冲突：就地红字提示、保留选中、不自动重试', async () => {
    const posts: Array<Record<string, unknown>> = [];
    server.use(
      decisionHandler([inlineGrace], []),
      http.post('/api/decisions/:id/answer', async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(
          { error: { code: 'DECISION_REVISION_CONFLICT', message: '答案版本冲突' } },
          { status: 409 },
        );
      }),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-inline-grace');

    fireEvent.click(screen.getByTestId(`decision-option-${graceOptions[1]!.id}`));
    fireEvent.click(screen.getByTestId('decision-action-inline-grace'));

    await waitFor(() =>
      expect(screen.getByTestId('decision-error-inline-grace')).toHaveTextContent('答案版本冲突'),
    );
    expect(posts).toHaveLength(1);
    // 选中保留，按钮仍可用，用户可直接重试
    expect(screen.getByTestId(`decision-option-${graceOptions[1]!.id}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('decision-action-inline-grace')).toBeEnabled();
  });

  it('容器 ≤660px：动作行 flex-direction 为 column（主按钮占满）', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    try {
      server.use(decisionHandler([inlineGrace], []));
      renderWithQuery(<DecisionsView />);
      await screen.findByTestId('decision-item-inline-grace');
      await waitFor(() =>
        expect(window.getComputedStyle(screen.getByTestId('decision-actions-inline-grace')).flexDirection).toBe('column'),
      );
      expect(screen.getByTestId('decision-action-inline-grace').className).toContain('w-full');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
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
