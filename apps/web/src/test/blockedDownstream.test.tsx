/**
 * DEC-V4-BLOCKS（P6）：阻塞下游清单。
 *
 * 覆盖：按钮文案 / 空态仍可点开 / 展开按需请求 depth=2 / 22 行 + 筛选 + 内部滚动 /
 * 原因缺失显示「未记录原因」/ 间接下游默认折叠 / 点下游卡号打开详情（含不在看板列表里的卡）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Workspace } from '@agentboard/shared';
import { DecisionsView } from '../components/decisions/DecisionsView';
import { BLOCKED_LIST_MAX_HEIGHT } from '../components/decisions/BlockedDownstream';
import type { DecisionListItemDto } from '../components/decisions/types';
import type { DependencyRef } from '../lib/dependency';
import { RightPanel } from '../components/right/RightPanel';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { resetOverlays } from '../state/overlayStore';
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
    locked_at: NOW - 60_000,
    stop_requested_at: null,
    stop_ack_at: null,
    answer_revision: 0,
    created_at: NOW - 120_000,
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
    waiting_seconds: 60,
    ...overrides,
  };
}

const blocksItem = listItem({ id: 'dec-blocks', state: 'open', blocked_downstream_count: 22 });
const noBlocksItem = listItem({ id: 'dec-no-blocks', state: 'open', blocked_downstream_count: 0 });

function directRef(index: number, overrides: Partial<DependencyRef> = {}): DependencyRef {
  return {
    issue_id: `ab-${150 + index}-0000-4000-8000-000000000000`,
    title: `下游任务 ${150 + index}`,
    status: '待规划',
    resolved: false,
    relation: 'blocks',
    claimed_by: null,
    blocked_reason: null,
    depth: 1,
    via: null,
    ...overrides,
  };
}

const direct = Array.from({ length: 22 }, (_, index) => directRef(index));
// 原因：有值 / 缺失各一条；占用者：未派工 / agent 各一条
direct[1] = { ...direct[1]!, blocked_reason: '等待数据库迁移', claimed_by: 'agent:executor' };
direct[2] = { ...direct[2]!, blocked_reason: null, claimed_by: null };

const indirect: DependencyRef[] = Array.from({ length: 4 }, (_, index) => ({
  issue_id: `cd-${164 + index}-0000-4000-8000-000000000000`,
  title: `间接任务 ${164 + index}`,
  status: '待规划',
  resolved: false,
  relation: 'blocks',
  claimed_by: null,
  blocked_reason: '经中间卡间接阻塞',
  depth: 2,
  via: direct[index]!.issue_id,
}));

function dependencyHandler(calls: string[]) {
  return http.get('/api/issues/:id/dependencies', ({ request }) => {
    const url = new URL(request.url);
    calls.push(url.pathname + url.search);
    const directItems = url.pathname.includes(noBlocksItem.issue_id) ? [] : direct;
    const indirectItems = url.pathname.includes(noBlocksItem.issue_id) ? [] : indirect;
    return HttpResponse.json({ blockers: [], blocked: [...directItems, ...indirectItems] });
  });
}

function decisionHandler() {
  return http.get('/api/decisions', () =>
    HttpResponse.json({
      decisions: [blocksItem, noBlocksItem],
      counts: { grace: 0, open: 2, stale_open: 0, answered_recent: 0 },
    }),
  );
}

function renderWithQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  resetOverlays();
  useAppStore.setState({ workspaceId: WORKSPACE_ID });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null, decisionFocus: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
});

describe('DEC-V4-BLOCKS 阻塞下游清单', () => {
  it('按钮文案：有下游「阻塞 N 个下游」，无下游「无下游阻塞」且仍可点开空态', async () => {
    const calls: string[] = [];
    server.use(decisionHandler(), dependencyHandler(calls));
    renderWithQuery(<DecisionsView />);

    const blocksButton = await screen.findByTestId('decision-blocks-issue-dec-blocks');
    expect(blocksButton).toHaveTextContent('阻塞 22 个下游');
    expect(screen.getByTestId('decision-blocks-issue-dec-no-blocks')).toHaveTextContent('无下游阻塞');
    // 未展开不请求
    expect(calls).toHaveLength(0);

    fireEvent.click(blocksButton);
    expect(await screen.findByTestId('blocked-downstream-panel-issue-dec-blocks')).toBeInTheDocument();
    // 按需请求：depth=2 + workspace_id
    expect(calls[0]).toContain('/dependencies?depth=2');
    expect(calls[0]).toContain(`workspace_id=${WORKSPACE_ID}`);

    const noBlocksButton = screen.getByTestId('decision-blocks-issue-dec-no-blocks');
    fireEvent.click(noBlocksButton);
    expect(await screen.findByTestId('blocked-downstream-empty-issue-dec-no-blocks')).toHaveTextContent(
      '这张卡目前没有 blocks 任何下游',
    );
  });

  it('展开后标题方向固定，22 行 + 筛选「AB-152」只剩 1 行，列表内部滚动', async () => {
    server.use(decisionHandler(), dependencyHandler([]));
    renderWithQuery(<DecisionsView />);

    fireEvent.click(await screen.findByTestId('decision-blocks-issue-dec-blocks'));
    const panel = await screen.findByTestId('blocked-downstream-panel-issue-dec-blocks');
    await screen.findByTestId('blocked-downstream-list-issue-dec-blocks');
    expect(panel).toHaveTextContent('本卡 blocks 的下游');
    expect(panel).toHaveTextContent('方向：这张卡 → 下游');
    expect(panel).toHaveTextContent('列的是「这张卡挡住了谁」，不是「谁挡住了这张卡」。');

    expect(within(panel).getAllByTestId(/^blocked-downstream-row-/)).toHaveLength(22);
    const list = screen.getByTestId('blocked-downstream-list-issue-dec-blocks');
    expect(list.style.maxHeight).toBe(`${BLOCKED_LIST_MAX_HEIGHT}px`);
    expect(list.style.overflowY).toBe('auto');

    fireEvent.change(screen.getByTestId('blocked-downstream-filter-issue-dec-blocks'), { target: { value: 'AB-152' } });
    const rows = screen.getAllByTestId(/^blocked-downstream-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-testid', `blocked-downstream-row-${direct[2]!.issue_id}`);
  });

  it('原因行：有值显示原文，null 显示「未记录原因」；占用者 null → 未派工', async () => {
    server.use(decisionHandler(), dependencyHandler([]));
    renderWithQuery(<DecisionsView />);

    fireEvent.click(await screen.findByTestId('decision-blocks-issue-dec-blocks'));
    await screen.findByTestId('blocked-downstream-list-issue-dec-blocks');

    expect(screen.getByTestId(`blocked-downstream-reason-${direct[0]!.issue_id}`)).toHaveTextContent('未记录原因');
    expect(screen.getByTestId(`blocked-downstream-reason-${direct[1]!.issue_id}`)).toHaveTextContent('等待数据库迁移');
    expect(screen.getByTestId(`blocked-downstream-owner-${direct[1]!.issue_id}`)).toHaveTextContent('agent:executor');
    expect(screen.getByTestId(`blocked-downstream-owner-${direct[2]!.issue_id}`)).toHaveTextContent('未派工');
  });

  it('间接下游默认折叠；展开后同样式渲染并标「经 <via> 转手」', async () => {
    server.use(decisionHandler(), dependencyHandler([]));
    renderWithQuery(<DecisionsView />);

    fireEvent.click(await screen.findByTestId('decision-blocks-issue-dec-blocks'));
    await screen.findByTestId('blocked-downstream-list-issue-dec-blocks');
    expect(screen.queryByTestId('blocked-downstream-indirect-issue-dec-blocks')).not.toBeInTheDocument();

    const toggle = screen.getByTestId('blocked-downstream-indirect-toggle-issue-dec-blocks');
    expect(toggle).toHaveTextContent('间接下游 4 张（经 1 层转手）');
    fireEvent.click(toggle);

    const list = await screen.findByTestId('blocked-downstream-indirect-issue-dec-blocks');
    expect(within(list).getAllByTestId(/^blocked-downstream-row-/)).toHaveLength(4);
    expect(screen.getByTestId(`blocked-downstream-reason-${indirect[0]!.issue_id}`)).toHaveTextContent(
      `经 ${direct[0]!.issue_id.slice(0, 8)} 转手`,
    );
  });

  it('点不在看板列表里的下游卡号：任务详情面板真的打开（aria-hidden=false）', async () => {
    const target = direct[2]!.issue_id;
    const targetIssue: Issue = {
      id: target,
      workspace_id: WORKSPACE_ID,
      title: direct[2]!.title,
      description: '',
      priority: '中',
      labels: [],
      status: '待规划',
      sort_order: 0,
      parent_issue_id: null,
      claimed_by: null,
      claimed_at: null,
      session_id: null,
      comment_count: 0,
      created_at: 1,
      updated_at: 1,
    };
    server.use(
      decisionHandler(),
      dependencyHandler([]),
      http.get(`/api/issues/${target}`, () => HttpResponse.json(targetIssue)),
      http.get(`/api/issues/${target}/comments`, () => HttpResponse.json([])),
      http.get(`/api/issues/${target}/pending-attachments`, () => HttpResponse.json({ items: [], next_offset: null })),
      http.get('/api/workspaces', () => HttpResponse.json([ws])),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );

    renderWithQuery(
      <>
        <DecisionsView />
        <RightPanel />
      </>,
    );

    fireEvent.click(await screen.findByTestId('decision-blocks-issue-dec-blocks'));
    fireEvent.click(await screen.findByTestId(`blocked-downstream-id-${target}`));

    await waitFor(() => expect(usePanelStore.getState().issueId).toBe(target));
    expect(usePanelStore.getState().view).toBe('detail');
    const panel = await screen.findByTestId('right-panel');
    await waitFor(() => expect(panel).not.toHaveAttribute('aria-hidden'));
    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();
  });
});
