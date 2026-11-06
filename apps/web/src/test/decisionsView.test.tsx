/**
 * DEC-6：待决策视图 / 卡面锁标识 / 详情决策区。
 *
 * 覆盖：四段分组与倒计时格式（纯函数）、徽标数（grace+open）、窄屏不折行、
 * grace 到期本地移入未回答、open 卡 [待决策] 已等待、详情两版答案时间线 + checkpoint + 修订请求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Workspace } from '@agentboard/shared';
import { DecisionsView } from '../components/decisions/DecisionsView';
import { DecisionMark } from '../components/decisions/DecisionMark';
import { DecisionSection, checkpointLines } from '../components/decisions/DecisionSection';
import { formatCountdown, formatWaiting, groupDecisions } from '../components/decisions/countdown';
import type { DecisionDetailDto, DecisionListItemDto } from '../components/decisions/types';
import { DECISIONS_SCOPE_KEY, persistDecisionsScope, resolveDecisionsScope } from '../lib/decisionsScope';
import { KNOWLEDGE_SCOPE_KEY } from '../lib/knowledgeScope';
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
    // P7：无在途时「全部」展示真空态，已回答卡改从「已回答」tab 进入
    fireEvent.click(await screen.findByTestId('decisions-tab-answered'));
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
    // P7：无在途时「全部」展示真空态，已回答卡改从「已回答」tab 进入
    fireEvent.click(await screen.findByTestId('decisions-tab-answered'));
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

describe('DEC-V4-CUSTOM 自定义答案', () => {
  const customItem = listItem({ id: 'custom-grace', state: 'grace', grace_until: NOW + 120_000 });
  const customOptions = customItem.options;
  const a = customOptions[0]!;
  const b = customOptions[1]!;

  function postAnswer(posts: Array<Record<string, unknown>>) {
    return http.post('/api/decisions/:id/answer', async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ decision: { ...customItem, checkpoint_json: null, current_answer_id: null, expires_at: null, on_expire: 'stay_locked', answers: [] } });
    });
  }

  it('互斥：选自定义后真实选项 aria-checked=false；再选真实选项收起输入框但保留草稿', async () => {
    server.use(decisionHandler([customItem], []));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-custom-grace');

    fireEvent.click(screen.getByTestId(`decision-option-${a.id}`));
    expect(screen.getByTestId(`decision-option-${a.id}`)).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('decision-custom-custom-grace'));
    expect(screen.getByTestId(`decision-option-${a.id}`)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('decision-custom-custom-grace')).toHaveAttribute('aria-checked', 'true');
    const input = screen.getByTestId('decision-custom-input-custom-grace');
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: '先这样' } });
    fireEvent.click(screen.getByTestId(`decision-option-${b.id}`));
    expect(screen.queryByTestId('decision-custom-input-custom-grace')).toBeNull();
    expect(screen.getByTestId(`decision-option-${b.id}`)).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('decision-custom-custom-grace'));
    expect(screen.getByTestId('decision-custom-input-custom-grace')).toHaveValue('先这样');
  });

  it('空文本提交：不发 POST、红字提示、aria-invalid、焦点留在输入框', async () => {
    const posts: Array<Record<string, unknown>> = [];
    server.use(decisionHandler([customItem], []), postAnswer(posts));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-custom-grace');

    fireEvent.click(screen.getByTestId('decision-custom-custom-grace'));
    fireEvent.change(screen.getByTestId('decision-custom-input-custom-grace'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('decision-action-custom-grace'));

    expect(posts).toHaveLength(0);
    expect(screen.getByTestId('decision-custom-error-custom-grace')).toHaveTextContent('先写一句答案再提交（不能为空）');
    const input = screen.getByTestId('decision-custom-input-custom-grace');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
  });

  it('120 字硬截断：粘贴 130 字只留 120，提交请求体 answer_text 为 120 字且不带 option_id', async () => {
    const posts: Array<Record<string, unknown>> = [];
    server.use(decisionHandler([customItem], []), postAnswer(posts));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-custom-grace');

    fireEvent.click(screen.getByTestId('decision-custom-custom-grace'));
    const input = screen.getByTestId('decision-custom-input-custom-grace');
    fireEvent.change(input, { target: { value: '甲'.repeat(130) } });

    expect(input).toHaveValue('甲'.repeat(120));
    expect(screen.getByTestId('decision-custom-count-custom-grace')).toHaveTextContent('120/120');

    fireEvent.click(screen.getByTestId('decision-custom-submit-custom-grace'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.answer_text as string).length).toBe(120);
    expect(posts[0]).not.toHaveProperty('option_id');
    expect(posts[0]).toMatchObject({ source: 'web' });
  });

  it('Enter 提交（非输入法组合）发出 1 次 POST；Esc 收起并回退到选自定义之前的选项', async () => {
    const posts: Array<Record<string, unknown>> = [];
    server.use(decisionHandler([customItem], []), postAnswer(posts));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-custom-grace');

    fireEvent.click(screen.getByTestId(`decision-option-${b.id}`));
    fireEvent.click(screen.getByTestId('decision-custom-custom-grace'));
    const input = screen.getByTestId('decision-custom-input-custom-grace');
    fireEvent.change(input, { target: { value: '我选自定义' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ answer_text: '我选自定义', source: 'web' });
  });

  it('Esc：收起输入框并回退到前一项；7 项时 chip 行内部滚动且页面不跳', async () => {
    const manyOptions = Array.from({ length: 6 }, (_, index) => ({
      id: `many-opt-${index + 1}`,
      ord: index + 1,
      label: `选项 ${index + 1}`,
      consequence: `后果 ${index + 1}`,
      is_default: index === 0 ? 1 : 0,
    }));
    const manyItem = listItem({ id: 'custom-many', state: 'grace', grace_until: NOW + 120_000, options: manyOptions });
    server.use(decisionHandler([manyItem], []));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-custom-many');

    const chips = screen.getByTestId('decision-chips-custom-many');
    expect(chips.style.maxHeight).toBe('76px');
    expect(chips.style.overflowY).toBe('auto');

    fireEvent.click(screen.getByTestId(`decision-option-${manyOptions[1]!.id}`));
    fireEvent.click(screen.getByTestId('decision-custom-custom-many'));
    expect(screen.getByTestId('decision-custom-input-custom-many')).toHaveFocus();

    const scrollBefore = window.scrollY;
    fireEvent.keyDown(screen.getByTestId('decision-custom-input-custom-many'), { key: 'Escape' });
    expect(screen.queryByTestId('decision-custom-input-custom-many')).toBeNull();
    expect(screen.getByTestId(`decision-option-${manyOptions[1]!.id}`)).toHaveAttribute('aria-checked', 'true');
    expect(window.scrollY).toBe(scrollBefore);
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

describe('P8 三处互跳', () => {
  it('看板卡面 [待决策] 可点 → 切待决策并带深链；缺 open_decision_id 时降级为不可点 span', () => {
    render(
      <DecisionMark
        issue={issue({
          id: 'issue-a',
          decision_grace_until: Date.now() + 90_000,
          open_decision_id: 'dec-open',
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('decision-mark-issue-a'));
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: 'dec-open' });

    cleanup();
    useNavStore.setState({ view: 'board', decisionFocus: null });
    // 已答 / 已撤回 / 旧投影没有 open_decision_id：降级展示，不出现「点进去空白」
    render(
      <DecisionMark
        issue={issue({ id: 'issue-b', decision_locked: true, decision_waiting_seconds: 30, open_decision_id: null })}
      />,
    );
    const degraded = screen.getByTestId('decision-mark-issue-b');
    expect(degraded.tagName).toBe('SPAN');
    fireEvent.click(degraded);
    expect(useNavStore.getState()).toMatchObject({ view: 'board', decisionFocus: null });
  });

  it('详情决策块底部按钮 → 切到待决策并深链该条', async () => {
    server.use(
      http.get('/api/decisions', ({ request }) => {
        const url = new URL(request.url);
        const isAnswered = url.searchParams.get('state') === 'answered';
        return HttpResponse.json({
          decisions: isAnswered ? [] : [openItem],
          counts: { grace: 0, open: 1, stale_open: 0, answered_recent: 0 },
        });
      }),
    );
    renderWithQuery(<DecisionSection issue={issue({ id: openItem.issue_id })} />);

    await waitFor(() => expect(screen.getByTestId('decision-question')).toHaveTextContent(openItem.question));
    const button = screen.getByTestId('decision-open-in-queue');
    expect(button).toHaveTextContent('在待决策区查看');

    fireEvent.click(button);
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: openItem.id });
  });

  it('决策列表消费深链：定位 / 展开 / 滚到可视区 / 闪两次后保留高亮，并强制回「全部」', async () => {
    const scrollSpy = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      server.use(decisionHandler([graceItem, openItem], []));
      useNavStore.setState({ view: 'decisions', decisionFocus: null });
      renderWithQuery(<DecisionsView />);

      await screen.findByTestId('decision-item-dec-open');
      fireEvent.click(screen.getByTestId('decisions-tab-answered'));
      expect(screen.getByTestId('decisions-tab-answered')).toHaveAttribute('aria-selected', 'true');

      useNavStore.getState().focusDecision('dec-open');

      await waitFor(() => expect(screen.getByTestId('decision-item-dec-open')).toHaveAttribute('data-selected', 'true'));
      const target = screen.getByTestId('decision-item-dec-open');
      expect(target).toHaveAttribute('data-expanded', 'true');
      expect(target).toHaveAttribute('data-flash', 'true');
      expect(screen.getByTestId('decisions-tab-all')).toHaveAttribute('aria-selected', 'true');
      expect(useNavStore.getState().decisionFocus).toBeNull();
      expect(screen.getByTestId('decision-item-dec-grace')).toHaveAttribute('data-selected', 'false');
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled());

      // 两次闪烁结束后：不再闪，但高亮边框保留
      await waitFor(() => expect(target).toHaveAttribute('data-flash', 'false'), { timeout: 3000 });
      expect(target).toHaveAttribute('data-selected', 'true');
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  }, 15_000);

  it('reduced motion：不闪，只保留高亮；目标缺失 → 回顶部 + toast，不空白', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as typeof window.matchMedia;
    try {
      server.use(decisionHandler([openItem], []));
      useNavStore.setState({ view: 'decisions', decisionFocus: 'dec-open' });
      renderWithQuery(<DecisionsView />);

      await waitFor(() => expect(screen.getByTestId('decision-item-dec-open')).toHaveAttribute('data-selected', 'true'));
      expect(screen.getByTestId('decision-item-dec-open')).toHaveAttribute('data-flash', 'false');

      useNavStore.getState().focusDecision('dec-missing');
      const toast = await screen.findByTestId('decisions-focus-toast');
      expect(toast).toHaveTextContent('该决策已不存在或不在当前范围');
      expect(useNavStore.getState().decisionFocus).toBeNull();
      expect(screen.queryByTestId('decision-item-dec-missing')).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe('P5 跨区范围', () => {
  const CAPS_ALL = {
    can_answer: true,
    can_revise: true,
    can_undo: true,
    can_withdraw: true,
    can_extend: true,
  };
  const homeItem = listItem({ id: 'p5-home', state: 'grace', grace_until: NOW + 120_000, workspace_name: '主项目' });
  const crossItem = listItem({
    id: 'p5-cross',
    state: 'grace',
    grace_until: NOW + 120_000,
    workspace_id: 'ws-2',
    workspace_name: '设计区',
    issue_title: '跨区任务',
    capabilities: CAPS_ALL,
  });

  /** 记录每次列表请求的 query，按服务端口径（去重后的可访问区并集）返回 */
  function scopedHandler(calls: string[], home: DecisionListItemDto[], all: DecisionListItemDto[]) {
    return http.get('/api/decisions', ({ request }) => {
      const url = new URL(request.url);
      calls.push(url.search);
      const isAnswered = url.searchParams.get('state') === 'answered';
      const accessible = url.searchParams.get('scope') === 'accessible';
      const decisions = isAnswered ? [] : accessible ? all : home;
      return HttpResponse.json({
        decisions,
        counts: { grace: decisions.length, open: 0, stale_open: 0, answered_recent: 0 },
        ...(accessible ? { capabilities: CAPS_ALL } : {}),
      });
    });
  }

  function postAnswer(posts: Array<Record<string, unknown>>, item: DecisionListItemDto = crossItem) {
    return http.post('/api/decisions/:id/answer', async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        decision: { ...item, checkpoint_json: null, current_answer_id: null, expires_at: null, on_expire: 'stay_locked', answers: [] },
      });
    });
  }

  const activeCall = (calls: string[]) => calls.find((query) => !query.includes('state=answered')) ?? '';

  it('默认当前工作区：请求带 workspace_id 且不带 scope；本区卡不显示工作区 chip', async () => {
    const calls: string[] = [];
    server.use(scopedHandler(calls, [homeItem], [homeItem, crossItem]));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-home');

    expect(screen.getByTestId('decisions-scope')).toHaveValue('workspace');
    const query = activeCall(calls);
    expect(query).toContain('workspace_id=ws-1');
    expect(query).not.toContain('scope=accessible');
    expect(screen.queryByTestId('decision-workspace-p5-home')).toBeNull();
  });

  it('切「所有可访问工作区」：请求 scope=accessible 且不带 workspace_id；跨区卡显示工作区名', async () => {
    const calls: string[] = [];
    server.use(scopedHandler(calls, [homeItem], [homeItem, crossItem]));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-home');

    calls.length = 0;
    fireEvent.change(screen.getByTestId('decisions-scope'), { target: { value: 'all' } });
    await screen.findByTestId('decision-item-p5-cross');

    const query = activeCall(calls);
    expect(query).toContain('scope=accessible');
    expect(query).not.toContain('workspace_id=');

    const chip = screen.getByTestId('decision-workspace-p5-cross');
    expect(chip).toHaveTextContent('设计区');
    expect(chip).toHaveAttribute('data-workspace-name', '设计区');
    expect(chip).toHaveAttribute('title', '设计区');
    expect(screen.queryByTestId('decision-workspace-p5-home')).toBeNull();
    // 只渲染服务端返回的可访问区条目（不存在第三区）
    expect(screen.getAllByTestId(/^decision-item-/)).toHaveLength(2);
  });

  it('空态文案：本区提示其它工作区；切到全部后该提示消失', async () => {
    const calls: string[] = [];
    server.use(scopedHandler(calls, [], []));
    renderWithQuery(<DecisionsView />);

    await waitFor(() => expect(screen.getByTestId('decisions-empty')).toBeInTheDocument());
    expect(screen.getByTestId('decisions-empty')).toHaveTextContent('其它工作区');

    fireEvent.change(screen.getByTestId('decisions-scope'), { target: { value: 'all' } });
    await waitFor(() =>
      expect(screen.getByTestId('decisions-empty')).toHaveTextContent('所有可访问工作区都没有待决策'),
    );
    expect(screen.getByTestId('decisions-empty').textContent).not.toContain('其它工作区');
  });

  it('范围独立持久化：非法值回落、写入专用 key、知识库 key 不受影响', async () => {
    localStorage.setItem(KNOWLEDGE_SCOPE_KEY, 'last-visited');
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'bogus');
    const calls: string[] = [];
    server.use(scopedHandler(calls, [homeItem], [homeItem, crossItem]));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-home');

    expect(screen.getByTestId('decisions-scope')).toHaveValue('workspace');
    fireEvent.change(screen.getByTestId('decisions-scope'), { target: { value: 'all' } });
    await screen.findByTestId('decision-item-p5-cross');

    expect(localStorage.getItem(DECISIONS_SCOPE_KEY)).toBe('all');
    expect(localStorage.getItem(KNOWLEDGE_SCOPE_KEY)).toBe('last-visited');
  });

  it('读取/写入纯函数：无记录与非法值回落 workspace，storage 不可用不抛错', () => {
    const store = new Map<string, string>();
    const read = { getItem: (key: string) => store.get(key) ?? null };
    const write = { setItem: (key: string, value: string) => void store.set(key, value) };

    expect(resolveDecisionsScope(read)).toBe('workspace');
    persistDecisionsScope('all', write);
    expect(store.get(DECISIONS_SCOPE_KEY)).toBe('all');
    expect(resolveDecisionsScope(read)).toBe('all');

    store.set(DECISIONS_SCOPE_KEY, 'everything');
    expect(resolveDecisionsScope(read)).toBe('workspace');
    expect(resolveDecisionsScope(null)).toBe('workspace');
    expect(() => persistDecisionsScope('all', null)).not.toThrow();
  });

  it('跨区二次确认：第一次只上膛不发请求，第二次才发出 1 次 POST', async () => {
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'all');
    const calls: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    server.use(scopedHandler(calls, [], [crossItem]), postAnswer(posts));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-cross');

    const option = crossItem.options[1]!;
    fireEvent.click(screen.getByTestId(`decision-option-${option.id}`));
    const action = screen.getByTestId('decision-action-p5-cross');
    expect(action).toHaveTextContent('提交回答');

    fireEvent.click(action);
    expect(posts).toHaveLength(0);
    expect(action).toHaveTextContent('确认跨区回答');
    expect(screen.getByTestId('decision-cross-confirm-p5-cross')).toHaveTextContent('设计区');

    fireEvent.click(action);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ option_id: option.id, source: 'web' });
  });

  it('改选项 / 展开收起都重置跨区确认态', async () => {
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'all');
    const calls: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    server.use(scopedHandler(calls, [], [crossItem]), postAnswer(posts));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-cross');

    const [a, b] = crossItem.options;
    fireEvent.click(screen.getByTestId(`decision-option-${b!.id}`));
    const action = screen.getByTestId('decision-action-p5-cross');
    fireEvent.click(action);
    expect(screen.getByTestId('decision-cross-confirm-p5-cross')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`decision-option-${a!.id}`));
    expect(screen.queryByTestId('decision-cross-confirm-p5-cross')).toBeNull();
    expect(action).toHaveTextContent('提交回答');

    fireEvent.click(action);
    expect(screen.getByTestId('decision-cross-confirm-p5-cross')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('decision-toggle-p5-cross'));
    expect(screen.queryByTestId('decision-cross-confirm-p5-cross')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('capabilities.can_answer=false：按钮禁用、显示无权原因、不弹跨区确认', async () => {
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'all');
    const blocked = listItem({
      id: 'p5-blocked',
      state: 'grace',
      grace_until: NOW + 120_000,
      workspace_id: 'ws-2',
      workspace_name: '设计区',
      capabilities: { ...CAPS_ALL, can_answer: false },
    });
    const calls: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    server.use(scopedHandler(calls, [], [blocked]), postAnswer(posts, blocked));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-blocked');

    expect(screen.getByTestId('decision-action-p5-blocked')).toBeDisabled();
    expect(screen.getByTestId('decision-role-blocked-p5-blocked')).toHaveTextContent('设计区');

    fireEvent.click(screen.getByTestId(`decision-option-${blocked.options[0]!.id}`));
    fireEvent.click(screen.getByTestId('decision-action-p5-blocked'));
    expect(screen.queryByTestId('decision-cross-confirm-p5-blocked')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('旧服务端无 capabilities：跨区仍按二次确认提交', async () => {
    localStorage.setItem(DECISIONS_SCOPE_KEY, 'all');
    const legacy = listItem({
      id: 'p5-legacy',
      state: 'grace',
      grace_until: NOW + 120_000,
      workspace_id: 'ws-2',
      workspace_name: '设计区',
    });
    const calls: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    server.use(scopedHandler(calls, [], [legacy]), postAnswer(posts, legacy));
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-legacy');

    fireEvent.click(screen.getByTestId(`decision-option-${legacy.options[0]!.id}`));
    const action = screen.getByTestId('decision-action-p5-legacy');
    fireEvent.click(action);
    expect(posts).toHaveLength(0);
    expect(action).toHaveTextContent('确认跨区回答');

    fireEvent.click(action);
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('提交 403 ROLE_FORBIDDEN：显示「当前角色无权回答这条决策」', async () => {
    const calls: string[] = [];
    server.use(
      scopedHandler(calls, [homeItem], []),
      http.post('/api/decisions/:id/answer', () =>
        HttpResponse.json({ error: { code: 'ROLE_FORBIDDEN', message: '角色无权' } }, { status: 403 }),
      ),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decision-item-p5-home');

    fireEvent.click(screen.getByTestId(`decision-option-${homeItem.options[0]!.id}`));
    fireEvent.click(screen.getByTestId('decision-action-p5-home'));
    await waitFor(() =>
      expect(screen.getByTestId('decision-error-p5-home')).toHaveTextContent('当前角色无权回答这条决策'),
    );
  });

  it('列表 401 / 403 / 通用错误分区展示，不一律显示加载失败', async () => {
    server.use(
      http.get('/api/decisions', () =>
        HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '未认证' } }, { status: 401 }),
      ),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decisions-error-unauth');
    cleanup();

    server.use(
      http.get('/api/decisions', () =>
        HttpResponse.json({ error: { code: 'WORKSPACE_FORBIDDEN', message: '无权工作区' } }, { status: 403 }),
      ),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decisions-error-forbidden');
    cleanup();

    server.use(
      http.get('/api/decisions', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderWithQuery(<DecisionsView />);
    await screen.findByTestId('decisions-error-generic');
  });

  it('侧栏徽标不随范围切换变化（仍只算本工作区）', async () => {
    const calls: string[] = [];
    const countCalls: string[] = [];
    server.use(
      scopedHandler(calls, [homeItem], [homeItem, crossItem]),
      http.get('/api/workspaces/:id/decisions/count', ({ request }) => {
        countCalls.push(request.url);
        return HttpResponse.json({ grace: 1, open: 1, stale_open: 0, answered_recent: 0 });
      }),
    );
    renderWithQuery(
      <>
        <SideBar workspace={ws} />
        <DecisionsView />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('sidebar-decisions-badge')).toHaveTextContent('2'));
    const countRequestsBefore = countCalls.length;

    fireEvent.change(screen.getByTestId('decisions-scope'), { target: { value: 'all' } });
    await screen.findByTestId('decision-item-p5-cross');

    expect(screen.getByTestId('sidebar-decisions-badge')).toHaveTextContent('2');
    expect(countCalls.length).toBe(countRequestsBefore);
  });
});

describe('DEC-V4-EMPTY 空态', () => {
  it('真空态：三条机制说明出现，「刚处理完」不存在', async () => {
    server.use(decisionHandler([], []));
    renderWithQuery(<DecisionsView />);

    const empty = await screen.findByTestId('decisions-empty');
    expect(empty).toHaveTextContent('当前范围没有待决策');
    expect(empty).toHaveTextContent('3 分钟');
    expect(empty).toHaveTextContent('通知');
    expect(empty).toHaveTextContent('不等于失败');
    expect(screen.queryByTestId('decisions-empty-recent')).not.toBeInTheDocument();
  });

  it('刚处理完：列出 24h 内已回答（标题 / 时间 / 结论摘要），点击回到该卡详情', async () => {
    const recent = listItem({
      id: 'dec-recent',
      state: 'answered',
      answer_revision: 2,
      answered_at: NOW - 2 * 3600_000,
      current_answer_by: 'agent:executor',
    });
    server.use(
      decisionHandler([], [recent]),
      http.get('/api/decisions/dec-recent', () =>
        HttpResponse.json({
          decision: {
            ...recent,
            checkpoint_json: null,
            current_answer_id: 'answer-2',
            expires_at: null,
            on_expire: '',
            answers: [
              {
                id: 'answer-2',
                revision: 2,
                option_id: recent.options[0]!.id,
                answer_text: null,
                answered_by: 'agent:executor',
                source: 'web',
                created_at: NOW - 2 * 3600_000,
              },
            ],
          },
        }),
      ),
    );
    renderWithQuery(<DecisionsView />);

    const section = await screen.findByTestId('decisions-empty-recent');
    expect(section).toHaveTextContent('刚处理完');
    const row = screen.getByTestId('decisions-empty-recent-dec-recent');
    expect(row).toHaveTextContent(recent.issue_title);
    await waitFor(() => expect(row).toHaveTextContent('「继续」'));
    expect(row).toHaveTextContent('agent:executor');

    fireEvent.click(row.querySelector('button')!);
    expect(usePanelStore.getState().issueId).toBe(recent.issue_id);
    expect(usePanelStore.getState().view).toBe('detail');
  });

  it('筛选空态：有数据但当前 tab 为空 → 只显示「该筛选下没有条目」+「清除筛选」', async () => {
    const openOnly = listItem({ id: 'dec-open-only', state: 'open', locked_at: NOW - 60_000, waiting_seconds: 60 });
    server.use(decisionHandler([openOnly], []));
    renderWithQuery(<DecisionsView />);

    await screen.findByTestId('decision-item-dec-open-only');
    fireEvent.click(screen.getByTestId('decisions-tab-grace'));

    const filterEmpty = screen.getByTestId('decisions-filter-empty');
    expect(filterEmpty).toHaveTextContent('该筛选下没有条目');
    expect(screen.getByTestId('decisions-filter-clear')).toHaveTextContent('清除筛选');
    expect(screen.queryByTestId('decisions-empty-mechanisms')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decisions-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('decisions-filter-clear'));
    expect(await screen.findByTestId('decision-item-dec-open-only')).toBeInTheDocument();
  });

  it('点「去任务看板」切回 board 视图', async () => {
    server.use(decisionHandler([], []));
    useNavStore.setState({ view: 'knowledge' });
    renderWithQuery(<DecisionsView />);

    fireEvent.click(await screen.findByTestId('decisions-empty-go-board'));
    expect(useNavStore.getState().view).toBe('board');
  });
});

describe('DEC-V4-UNDO Web 6 秒撤销', () => {
  const undoGrace = listItem({ id: 'undo-grace', state: 'grace', grace_until: NOW + 600_000, remaining_grace_seconds: 600 });
  /** 陪跑在途条：避免答完唯一一条后进入 P7 真空态（那时卡片不再以决策卡渲染） */
  const undoFiller = listItem({ id: 'undo-filler', state: 'open', locked_at: NOW - 60_000, waiting_seconds: 60 });

  function detailFor(
    item: DecisionListItemDto,
    revision: number,
    deadline: number | null,
  ): DecisionDetailDto {
    return {
      ...item,
      state: revision > 0 ? 'answered' : 'grace',
      answer_revision: revision,
      undo_until: deadline,
      answered_at: revision > 0 ? Date.now() : null,
      checkpoint_json: null,
      current_answer_id: revision > 0 ? `a-${revision}` : null,
      expires_at: null,
      on_expire: 'stay_locked',
      options: item.options,
      answers:
        revision > 0
          ? [
              {
                id: `a-${revision}`,
                revision,
                option_id: item.options[1]!.id,
                answer_text: null,
                answered_by: 'user',
                source: 'web',
                created_at: Date.now(),
              },
            ]
          : [],
    };
  }

  interface UndoFixtureOptions {
    items?: DecisionListItemDto[];
    /** 服务端 undo_until = 响应时刻 + N（默认 6000，测试可缩短） */
    deadlineMs?: number;
    /** 非空时 /undo 固定返回该错误；`network` 模拟断网 */
    undoError?: { status: number; code: string; message: string } | 'network';
  }

  /** 有状态的决策服务：answer 落库 → 列表翻面；undo 真回滚 */
  function installUndoServer(options: UndoFixtureOptions = {}) {
    const base = options.items ?? [undoGrace, undoFiller];
    const answerPosts: Array<Record<string, unknown>> = [];
    const undoPosts: Array<Record<string, unknown>> = [];
    const answered = new Set<string>();
    const revisions = new Map<string, number>();
    let deadline: number | null = null;
    let failUndo = options.undoError === 'network';

    const current = (item: DecisionListItemDto) => ({
      ...item,
      state: answered.has(item.id) ? ('answered' as const) : ('grace' as const),
      answer_revision: revisions.get(item.id) ?? 0,
      undo_until: answered.has(item.id) ? deadline : null,
      // 列表分组按 answered_at 过滤 24h 内，必须给真实回答时刻
      answered_at: answered.has(item.id) ? Date.now() : null,
    });

    const handlers = [
      http.get('/api/decisions', ({ request }) => {
        const isAnswered = new URL(request.url).searchParams.get('state') === 'answered';
        const items = base.map(current).filter((item) => (item.state === 'answered') === isAnswered);
        const active = base.map(current).filter((item) => item.state !== 'answered');
        return HttpResponse.json({
          decisions: items,
          counts: {
            grace: active.length,
            open: 0,
            stale_open: 0,
            answered_recent: base.length - active.length,
          },
        });
      }),
      http.get('/api/decisions/:id', ({ params }) => {
        const item = base.find((candidate) => candidate.id === params.id) ?? undoGrace;
        const revision = revisions.get(item.id) ?? 0;
        return HttpResponse.json({ decision: detailFor(item, revision, answered.has(item.id) ? deadline : null) });
      }),
      http.post('/api/decisions/:id/answer', async ({ request, params }) => {
        const id = String(params.id);
        answerPosts.push({ decisionId: id, ...((await request.json()) as Record<string, unknown>) });
        const revision = (revisions.get(id) ?? 0) + 1;
        revisions.set(id, revision);
        answered.add(id);
        deadline = Date.now() + (options.deadlineMs ?? 6000);
        const item = base.find((candidate) => candidate.id === id) ?? undoGrace;
        return HttpResponse.json({ decision: detailFor(item, revision, deadline) });
      }),
      http.post('/api/decisions/:id/undo', async ({ request, params }) => {
        const id = String(params.id);
        undoPosts.push({ decisionId: id, ...((await request.json()) as Record<string, unknown>) });
        if (failUndo) return HttpResponse.error();
        if (options.undoError !== undefined && options.undoError !== 'network') {
          return HttpResponse.json(
            { error: { code: options.undoError.code, message: options.undoError.message } },
            { status: options.undoError.status },
          );
        }
        answered.delete(id);
        revisions.set(id, 0);
        const item = base.find((candidate) => candidate.id === id) ?? undoGrace;
        return HttpResponse.json({
          decision: detailFor(item, 0, null),
          reverted_to: 'grace',
          undo_window_ms: 6000,
          already_undone: false,
        });
      }),
    ];

    return {
      handlers,
      answerPosts,
      undoPosts,
      answered,
      /** 让网络失败用例的第二次请求放行 */
      recover: () => {
        failUndo = false;
      },
    };
  }

  async function submitAnswer(item: DecisionListItemDto) {
    await screen.findByTestId(`decision-item-${item.id}`);
    fireEvent.click(screen.getByTestId(`decision-option-${item.options[1]!.id}`));
    fireEvent.click(screen.getByTestId(`decision-action-${item.id}`));
  }

  it('提交即落库：420ms 覆盖「已记录 · 正在移出」且按钮不可点，之后移入已回答并出现撤销条', async () => {
    const fixture = installUndoServer();
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    expect(fixture.answerPosts[0]).toMatchObject({ option_id: undoGrace.options[1]!.id, source: 'web' });

    const leaving = await screen.findByTestId('decision-leaving-undo-grace');
    expect(leaving).toHaveTextContent('已记录 · 正在移出');
    expect(screen.getByTestId('decision-item-undo-grace')).toHaveAttribute('data-leaving', 'true');
    expect(screen.getByTestId('decision-action-undo-grace')).toBeDisabled();

    // 撤销条立即出现，倒计时读服务端 undo_until
    expect(await screen.findByTestId('decision-undo-countdown')).toHaveTextContent('秒内可撤销');

    // 420ms 后视觉移出，卡片落到「最近已回答」
    await waitFor(() => expect(screen.queryByTestId('decision-leaving-undo-grace')).not.toBeInTheDocument(), {
      timeout: 2000,
    });
    await waitFor(() =>
      expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-answered"]')).not.toBeNull(),
    );
  });

  it('6 秒内撤销：POST 带 expected_revision，服务端回滚后卡片回到宽限中', async () => {
    const fixture = installUndoServer();
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-answered"]')).not.toBeNull(),
      { timeout: 2000 },
    );

    fireEvent.click(await screen.findByTestId('decision-undo'));
    await waitFor(() => expect(fixture.undoPosts).toHaveLength(1));
    expect(fixture.undoPosts[0]).toMatchObject({ by: 'user', expected_revision: 1 });

    expect(await screen.findByTestId('decision-undo-result')).toHaveTextContent('已撤销');
    await waitFor(() =>
      expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-grace"]')).not.toBeNull(),
    );
  });

  it('窗口已过：撤销按钮消失显示「已作答」，不会补发 /undo', async () => {
    const fixture = installUndoServer({ deadlineMs: 400 });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));

    await waitFor(() => expect(screen.queryByTestId('decision-undo')).not.toBeInTheDocument(), { timeout: 2500 });
    expect(screen.getByTestId('decision-undo-expired')).toHaveTextContent('已作答');
    expect(fixture.undoPosts).toHaveLength(0);
  });

  it('刷新页面：答案已在服务端保持已回答，不补发 answer、不出现撤销条', async () => {
    const fixture = installUndoServer();
    server.use(...fixture.handlers);
    const first = renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    first.unmount();

    renderWithQuery(<DecisionsView />);
    fireEvent.click(await screen.findByTestId('decisions-tab-answered'));
    await waitFor(() =>
      expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-answered"]')).not.toBeNull(),
    );
    expect(fixture.answerPosts).toHaveLength(1);
    expect(fixture.undoPosts).toHaveLength(0);
    expect(screen.queryByTestId('decision-undo-bar')).not.toBeInTheDocument();
  });

  it('409 过期：toast「撤销窗口已过」，卡片保持已回答', async () => {
    const fixture = installUndoServer({
      undoError: { status: 409, code: 'UNDO_WINDOW_EXPIRED', message: '撤销窗口已过期' },
    });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('decision-undo'));

    expect(await screen.findByTestId('decision-undo-result')).toHaveTextContent('撤销窗口已过');
    expect(screen.queryByTestId('decision-undo-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-grace"]')).toBeNull();
  });

  it('409 已被重新领取：toast 给出对应文案，不显示「操作失败」', async () => {
    const fixture = installUndoServer({
      undoError: {
        status: 409,
        code: 'UNDO_CLAIMED_AFTER_LOCK',
        message: '卡在回答后已被重新领取',
      },
    });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('decision-undo'));

    const result = await screen.findByTestId('decision-undo-result');
    expect(result).toHaveTextContent('已被重新领取');
    expect(result).not.toHaveTextContent('操作失败');
  });

  it('409 版本冲突：toast 带服务端原因', async () => {
    const fixture = installUndoServer({
      undoError: { status: 409, code: 'DECISION_REVISION_CONFLICT', message: 'revision 2 已过期' },
    });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('decision-undo'));

    expect(await screen.findByTestId('decision-undo-result')).toHaveTextContent('答案版本已变化');
  });

  it('连续提交两条：撤销条只保留第二条，旧回答保持有效', async () => {
    const second = listItem({ id: 'undo-second', state: 'grace', grace_until: NOW + 600_000, remaining_grace_seconds: 600 });
    const fixture = installUndoServer({ items: [undoGrace, second] });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    await submitAnswer(second);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(2));

    const bar = screen.getByTestId('decision-undo-bar');
    expect(bar).toHaveAttribute('data-decision-id', second.id);
    expect(bar).toHaveTextContent(second.issue_title);

    fireEvent.click(screen.getByTestId('decision-undo'));
    await waitFor(() => expect(fixture.undoPosts).toHaveLength(1));
    expect(fixture.undoPosts[0]).toMatchObject({ decisionId: second.id, expected_revision: 1 });
    // 第一条没有被连带撤销
    expect(fixture.answered.has(undoGrace.id)).toBe(true);
  });

  it('倒计时读服务端 undo_until，而不是本地提交时刻 + 6 秒', async () => {
    const fixture = installUndoServer({ deadlineMs: 3000 });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));

    const text = (await screen.findByTestId('decision-undo-countdown')).textContent ?? '';
    // 服务端只给 3s 窗口；剩余秒数由服务端 undo_until 反推（本地此刻仍可能显示 4s 的取整差）
    expect(text).toMatch(/秒内可撤销/);
    expect(text).not.toContain('6 秒');
  });

  it('网络失败：保留「重试撤销」，重试成功后回到宽限中', async () => {
    const fixture = installUndoServer({ undoError: 'network' });
    server.use(...fixture.handlers);
    renderWithQuery(<DecisionsView />);

    await submitAnswer(undoGrace);
    await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('decision-undo'));

    expect(await screen.findByTestId('decision-undo-retry')).toBeInTheDocument();
    expect(screen.getByTestId('decision-undo-result')).toHaveTextContent('网络异常');

    fixture.recover();
    fireEvent.click(screen.getByTestId('decision-undo-retry'));
    await waitFor(() => expect(fixture.undoPosts).toHaveLength(2));
    expect(await screen.findByTestId('decision-undo-result')).toHaveTextContent('已撤销');
  });

  it('reduced motion：跳过 420ms leaving，提交后直接进入已回答', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const fixture = installUndoServer();
    server.use(...fixture.handlers);
    try {
      renderWithQuery(<DecisionsView />);
      await submitAnswer(undoGrace);
      await waitFor(() => expect(fixture.answerPosts).toHaveLength(1));

      // 无 leaving 覆盖层，直接读列表新状态
      expect(screen.queryByTestId('decision-leaving-undo-grace')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByTestId('decision-item-undo-grace').closest('[data-testid="decisions-group-answered"]')).not.toBeNull(),
      );
    } finally {
      window.matchMedia = original;
    }
  });
});
