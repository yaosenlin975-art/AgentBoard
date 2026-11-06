/**
 * DEC-V4-PERM-TEST（Web 侧）：capability 逐项驱动撤销入口。
 *
 * 只补既有覆盖的缺口——`can_undo` 这一项此前没有独立用例：
 * - `decisionsView.test.tsx:1083` 覆盖 `can_answer=false`（按钮禁用、无权原因、不弹跨区确认）
 * - `decisionsView.test.tsx:1134` 覆盖 `can_revise` / `can_extend` / `can_withdraw=false`
 * - `decisionsView.test.tsx:1160` 覆盖 `can_withdraw=true` 两步确认
 * - `decisionsView.test.tsx:1193` 覆盖提交 403 ROLE_FORBIDDEN（inline + 刷新列表）
 * - `decisionsView.test.tsx:1217` 覆盖列表 401 banner 只出一次且不重试
 * - `decisionsView.test.tsx:1109` 覆盖旧服务端无 capabilities 的降级
 *
 * 这里补：`can_undo=false` 时提交回答后不出现 6 秒撤销条，`can_undo=true` 时出现（对照组）。
 * 判定源：`DecisionCard.tsx` 的 `canUndo = decision.capabilities?.can_undo ?? canAnswer`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { DecisionsView } from '../components/decisions/DecisionsView';
import type { DecisionDetailDto, DecisionListItemDto } from '../components/decisions/types';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const WORKSPACE_ID = 'ws-perm';
const NOW = Date.now();
const CAPS_ALL = {
  can_answer: true,
  can_revise: true,
  can_undo: true,
  can_withdraw: true,
  can_extend: true,
};

function listItem(overrides: Partial<DecisionListItemDto> & Pick<DecisionListItemDto, 'id'>): DecisionListItemDto {
  return {
    workspace_id: WORKSPACE_ID,
    issue_id: `issue-${overrides.id}`,
    question: `问题 ${overrides.id}`,
    context_md: '',
    trigger: 'agent',
    created_by: 'agent:executor',
    grace_seconds: 180,
    grace_until: NOW + 600_000,
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
      { id: `opt-a-${overrides.id}`, ord: 1, label: '继续', consequence: '继续执行', is_default: 1 },
      { id: `opt-b-${overrides.id}`, ord: 2, label: '停止', consequence: '停在检查点', is_default: 0 },
    ],
    blocked_downstream_count: 0,
    remaining_grace_seconds: 600,
    waiting_seconds: null,
    state: 'grace',
    ...overrides,
  };
}

function detailFor(item: DecisionListItemDto, canUndo: boolean): DecisionDetailDto {
  return {
    ...item,
    state: 'answered',
    answer_revision: 1,
    undo_until: NOW + 6000,
    answered_at: NOW,
    checkpoint_json: null,
    current_answer_id: 'a-1',
    expires_at: null,
    on_expire: 'stay_locked',
    options: item.options,
    capabilities: { ...CAPS_ALL, can_undo: canUndo },
    answers: [
      {
        id: 'a-1',
        revision: 1,
        option_id: item.options[1]!.id,
        answer_text: null,
        answered_by: 'user',
        source: 'web',
        created_at: NOW,
      },
    ],
  };
}

/** 一条待答决策 + 一条陪跑在途条（避免答完唯一一条后进入真空态） */
function installServer(canUndo: boolean) {
  const target = listItem({ id: 'perm-target' });
  const filler = listItem({ id: 'perm-filler', state: 'open', locked_at: NOW - 60_000, waiting_seconds: 60 });
  const posts: Array<Record<string, unknown>> = [];

  server.use(
    http.get('/api/decisions', ({ request }) => {
      const isAnswered = new URL(request.url).searchParams.get('state') === 'answered';
      // answered 查询留空：否则同一条会以相同 testid 再渲染一次（分组各渲染一遍）
      const decisions = isAnswered ? [] : [target, filler];
      return HttpResponse.json({
        decisions,
        counts: { grace: isAnswered ? 0 : 1, open: isAnswered ? 0 : 1, stale_open: 0, answered_recent: 0 },
      });
    }),
    http.get('/api/decisions/:id', () => HttpResponse.json({ decision: detailFor(target, canUndo) })),
    http.post('/api/decisions/:id/answer', async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ decision: detailFor(target, canUndo) });
    }),
  );

  return { target, posts };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DecisionsView />
    </QueryClientProvider>,
  );
}

async function submitAnswer(item: DecisionListItemDto) {
  await screen.findByTestId(`decision-item-${item.id}`);
  fireEvent.click(screen.getByTestId(`decision-option-${item.options[1]!.id}`));
  fireEvent.click(screen.getByTestId(`decision-action-${item.id}`));
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAppStore.setState({ workspaceId: WORKSPACE_ID });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null, decisionFocus: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
});

describe('DEC-V4-PERM-TEST Web：can_undo 驱动撤销入口', () => {
  it('can_undo=false：提交回答后不出现 6 秒撤销条（答案照常落库）', async () => {
    const { target, posts } = installServer(false);
    renderView();

    await submitAnswer(target);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ option_id: target.options[1]!.id, source: 'web' });

    // 落库照常：卡片进入「已记录 · 正在移出」
    expect(await screen.findByTestId('decision-leaving-perm-target')).toHaveTextContent('已记录 · 正在移出');
    // 但没有撤销入口
    expect(screen.queryByTestId('decision-undo-countdown')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('decision-leaving-perm-target')).not.toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.queryByTestId('decision-undo-countdown')).toBeNull();
  });

  it('can_undo=true：同一路径下撤销条出现（对照组，证明上一条不是整体不渲染）', async () => {
    const { target } = installServer(true);
    renderView();

    await submitAnswer(target);
    expect(await screen.findByTestId('decision-undo-countdown')).toHaveTextContent('秒内可撤销');
  });
});
