/**
 * Task 13 测试：操作区四态切换、评论发送两态与 woke 提示、防抖 PATCH、删除二次确认、
 * 派发弹窗提交体（cli/model/reuse_session/prompt 渲染变量）、RightPanel 容器收起/展开/拖拽宽度。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueComment, Session, Workspace } from '@agentboard/shared';
import { DetailPanel } from '../components/detail/DetailPanel';
import { RightPanel } from '../components/right/RightPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useNavStore } from '../state/navStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    workspace_id: 'ws-1',
    title: '测试任务',
    description: '任务描述内容',
    priority: '中',
    labels: ['前端'],
    status: '待规划',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-old',
    workspace_id: 'ws-1',
    issue_id: 'iss-1',
    cli: 'codebuddy',
    model: 'm1',
    status: '已结束',
    adapter_session_id: 'ad-1',
    created_at: 1,
    ...overrides,
  };
}

const clisMixed = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0', supportsModelSelection: true },
  { id: 'codex', displayName: 'Codex', installed: true, version: '1.0.0', supportsModelSelection: true },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null, supportsModelSelection: true },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null, supportsModelSelection: false },
];

/** DetailPanel 所需的全部 GET handlers */
function mockDetailApi(
  issue: Issue,
  opts: { comments?: IssueComment[]; sessions?: Session[] } = {},
): void {
  server.use(
    http.get('/api/issues/iss-1', () => HttpResponse.json(issue)),
    http.get('/api/issues/iss-1/comments', () => HttpResponse.json(opts.comments ?? [])),
    http.get('/api/issues/iss-1/pending-attachments', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const limit = Number(params.get('limit') ?? 20);
      const offset = Number(params.get('offset') ?? 0);
      const candidates = (opts.comments ?? []).flatMap((comment) => (comment.attachments ?? [])
        .filter((attachment) => attachment.delivery_state === 'pending' || attachment.delivery_state === 'unknown')
        .map((attachment) => ({
          ...attachment,
          comment_id: comment.id,
          author: comment.author,
          ts: comment.ts,
          snippet: comment.content.slice(0, 500),
        })));
      return HttpResponse.json({ items: candidates.slice(offset, offset + limit), next_offset: offset + limit < candidates.length ? offset + limit : null });
    }),
    http.get('/api/sessions', () => HttpResponse.json(opts.sessions ?? [])),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
  );
}

/** 渲染 RightPanel；默认先打开 detail 视图（open:false 用于容器空态/收起断言） */
function renderDetail(opts: { open?: boolean } = {}): void {
  if (opts.open !== false) openDetail();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RightPanel />
    </QueryClientProvider>,
  );
}

function openDetail(issueId = 'iss-1'): void {
  usePanelStore.setState({ view: 'detail', issueId, sessionId: null, rightOpen: true });
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, rightOpen: false });
});

describe('DetailPanel 操作区四态', () => {
  it('待规划未占用：派发 + 删除，无占用操作', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    expect(await screen.findByTestId('dispatch-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delete-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('session-active-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('done-btn')).not.toBeInTheDocument();
  });

  it('进行中占用：会话进行中（禁用）+ 强制释放 + 标记待验收，无派发/删除', async () => {
    mockDetailApi(makeIssue({ status: '进行中', claimed_by: 'agent:codex', claimed_at: 5, session_id: 's-old' }));
    renderDetail();
    expect(await screen.findByTestId('session-active-btn')).toBeDisabled();
    expect(screen.getByTestId('release-btn')).toBeInTheDocument();
    expect(screen.getByTestId('done-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-btn')).not.toBeInTheDocument();
  });

  it('待验收未占用：仅删除', async () => {
    mockDetailApi(makeIssue({ status: '待验收' }));
    renderDetail();
    expect(await screen.findByTestId('delete-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-btn')).not.toBeInTheDocument();
  });

  it('已关闭未占用：仅删除', async () => {
    mockDetailApi(makeIssue({ status: '已关闭' }));
    renderDetail();
    expect(await screen.findByTestId('delete-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-btn')).not.toBeInTheDocument();
  });

  it('强制释放：POST release 后回到可派发态', async () => {
    mockDetailApi(makeIssue({ status: '进行中', claimed_by: 'agent:codex', claimed_at: 5, session_id: 's-old' }));
    let releaseCalled = false;
    server.use(
      http.post('/api/issues/iss-1/release', () => {
        releaseCalled = true;
        return HttpResponse.json(
          makeIssue({ status: '待规划', claimed_by: null, claimed_at: null, session_id: null, updated_at: 9 }),
        );
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByTestId('release-btn'));
    // F-09：强制释放先展开行内二次确认，确认后才发请求
    expect(await screen.findByTestId('release-confirm-text')).toBeInTheDocument();
    expect(releaseCalled).toBe(false);
    await userEvent.click(screen.getByTestId('release-confirm'));
    await waitFor(() => expect(releaseCalled).toBe(true));
    expect(await screen.findByTestId('dispatch-btn')).toBeInTheDocument();
  });

  it('标记待验收：POST done {agent_id:user}', async () => {
    mockDetailApi(makeIssue({ status: '进行中', claimed_by: 'agent:codex', claimed_at: 5, session_id: 's-old' }));
    let doneBody: unknown = null;
    server.use(
      http.post('/api/issues/iss-1/done', async ({ request }) => {
        doneBody = await request.json();
        return HttpResponse.json(makeIssue({ status: '待验收', updated_at: 9 }));
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByTestId('done-btn'));
    await waitFor(() => expect(doneBody).toEqual({ agent_id: 'user' }));
    await waitFor(() => expect(screen.queryByTestId('release-btn')).not.toBeInTheDocument());
  });
});

describe('DetailPanel 状态手动修改（DETAIL-STATUS01 / DETAIL-D2 chip）', () => {
  it('状态 chip 打开 popover 后列出内置五状态；改状态 PATCH 带 workspace_id + expected_updated_at，成功后按服务端响应更新', async () => {
    const base = makeIssue({ status: '待规划', updated_at: 7 });
    mockDetailApi(base);
    let current = base;
    const patches: Array<Record<string, unknown>> = [];
    let issuesRefetches = 0;
    server.use(
      http.get('/api/issues/iss-1', () => HttpResponse.json(current)),
      http.get('/api/issues', () => {
        issuesRefetches += 1;
        return HttpResponse.json([current]);
      }),
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        current = { ...base, status: '待验收', updated_at: 9 };
        return HttpResponse.json(current);
      }),
    );
    renderDetail();

    // D2：状态下拉改为 meta chip；点击后 popover 内是同一份状态字典
    const chip = await screen.findByTestId('status-chip');
    expect(chip).toHaveAttribute('data-status', '待规划');
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    expect(chip).not.toBeDisabled();
    expect(chip).toHaveTextContent('待规划');

    await userEvent.click(chip);
    expect(screen.getByTestId('status-popover')).toHaveAttribute('role', 'menu');
    // STATUS-3-UI：走 workspace_status 字典；未 mock 状态接口时兜底为五条内置（含已废弃）
    for (const name of ['待规划', '进行中', '待验收', '已关闭', '已废弃']) {
      expect(screen.getByTestId(`status-option-${name}`)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByTestId('status-option-待验收'));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ workspace_id: 'ws-1', expected_updated_at: 7, status: '待验收' });
    await waitFor(() => expect(screen.getByTestId('status-chip')).toHaveAttribute('data-status', '待验收'));
    // 看板/树列表缓存被失效（重新拉 /api/issues）
    await waitFor(() => expect(issuesRefetches).toBeGreaterThan(0));
  });

  it('「进行中」任务（含未占用）：状态 chip 禁用并给出原因，点不开 popover、不发 PATCH', async () => {
    const running = makeIssue({ status: '进行中', claimed_by: null, updated_at: 3 });
    mockDetailApi(running);
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(running);
      }),
    );
    renderDetail();

    const chip = await screen.findByTestId('status-chip');
    expect(chip).toHaveAttribute('data-status', '进行中');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', expect.stringContaining('进行中'));
    expect(screen.getByTestId('status-blocked-hint')).toHaveTextContent('进行中');

    // 禁用 chip 不会打开 popover，也不会产生状态请求
    await userEvent.click(chip);
    expect(screen.queryByTestId('status-popover')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    expect(patches).toHaveLength(0);
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-status', '进行中');
  });

  it('已占用任务：状态 chip 禁用并提示占用原因', async () => {
    mockDetailApi(makeIssue({ status: '待规划', claimed_by: 'agent:codex', claimed_at: 1 }));
    renderDetail();

    const chip = await screen.findByTestId('status-chip');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', expect.stringContaining('占用中'));
  });

  it('409 冲突：显示服务端原因，chip 保留服务端当前状态', async () => {
    const base = makeIssue({ status: '待规划', updated_at: 7 });
    mockDetailApi(base);
    server.use(
      http.patch('/api/issues/iss-1', () =>
        HttpResponse.json({ error: { code: 'TASK_REVISION_CONFLICT', message: '任务已更新，请重新读取' } }, { status: 409 }),
      ),
    );
    renderDetail();

    await userEvent.click(await screen.findByTestId('status-chip'));
    await userEvent.click(await screen.findByTestId('status-option-待验收'));
    const alert = await screen.findByTestId('detail-action-error');
    expect(alert).toHaveTextContent('任务已更新，请重新读取');
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-status', '待规划');
  });

  it('后代未关闭时「已关闭」选项禁用（与树节点下拉同规则）', async () => {
    const base = makeIssue({ status: '待规划' });
    mockDetailApi(base);
    server.use(
      http.get('/api/issues', () => HttpResponse.json([
        base,
        makeIssue({ id: 'iss-child', parent_issue_id: 'iss-1', status: '进行中' }),
      ])),
    );
    renderDetail();

    await userEvent.click(await screen.findByTestId('status-chip'));
    const closeOption = await screen.findByTestId('status-option-已关闭');
    await waitFor(() => expect(closeOption).toBeDisabled());
    expect(screen.getByTestId('status-option-待验收')).not.toBeDisabled();
  });
});

describe('DETAIL-D2 meta 行（状态 / 优先级 / 截止 / 负责人）', () => {
  it('四个 chip 同排；宽屏强制单行、窄屏允许两行（状态+优先级 / 截止+负责人）', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    const row = (await screen.findByTestId('meta-row')) as HTMLElement;
    // ≥920px 强制单行；<920px 退化为两行分组（未决 2）
    expect(row.className).toContain('min-[920px]:flex-row');
    const chips = ['status-chip', 'priority-chip', 'due-chip', 'owner-chip'].map((id) => screen.getByTestId(id));
    for (const chip of chips) {
      expect(chip).toHaveAttribute('aria-haspopup');
      expect(chip).toHaveAttribute('aria-expanded', 'false');
    }
    // jsdom 无布局：四个 chip 的 rect.top 均为 0，等价于「同一横行」
    const tops = chips.map((chip) => Math.round(chip.getBoundingClientRect().top));
    expect(new Set(tops)).toEqual(new Set([0]));
  });

  it('截止 chip：popover 内日期/时间/清除；应用后 chip 只显示结果', { timeout: 15000 }, async () => {
    mockDetailApi(makeIssue());
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ due_date: '2026-11-10', due_time: '14:30' }));
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByTestId('due-chip'));
    // 第一轮原型的 FAIL 修复点：日期选择器必须真实可见（#dueDateInput）
    const dateInput = screen.getByTestId('detail-due-date');
    expect(dateInput).toBeVisible();
    expect(dateInput).toHaveAttribute('id', 'dueDateInput');
    expect(screen.getByTestId('detail-due-time')).toBeDisabled();

    fireEvent.change(dateInput, { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByTestId('detail-due-time'), { target: { value: '14:30' } });
    await userEvent.click(screen.getByTestId('due-apply'));
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    expect(patches[0]).toEqual({ due_date: '2026-11-10', due_time: '14:30' });
    expect(screen.getByTestId('due-chip')).toHaveTextContent('11-10 14:30');
    expect(screen.queryByTestId('detail-due-date')).not.toBeInTheDocument();
  });

  it('截止 chip：清除同时清空日期与时间（PATCH 两个 null）', { timeout: 15000 }, async () => {
    mockDetailApi(makeIssue({ due_date: '2026-11-10', due_time: '14:30' }));
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ due_date: null, due_time: null }));
      }),
    );
    renderDetail();
    expect(await screen.findByTestId('due-chip')).toHaveTextContent('11-10 14:30');
    await userEvent.click(screen.getByTestId('due-chip'));
    await userEvent.click(screen.getByTestId('detail-due-clear'));
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    expect(patches[0]).toEqual({ due_date: null, due_time: null });
    expect(screen.getByTestId('due-chip')).toHaveTextContent('未设置');
  });

  it('截止 chip：逾期显示「已逾期 N 天」角标', { timeout: 15000 }, async () => {
    const daysAgo = (days: number): string => {
      const d = new Date(Date.now() - days * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    mockDetailApi(makeIssue({ due_date: daysAgo(2), due_time: null }));
    renderDetail();
    expect(await screen.findByTestId('due-chip')).toHaveTextContent('已逾期');
    expect(screen.getByTestId('detail-due-overdue')).toHaveTextContent(/已逾期 \d+ 天/);
  });

  it('同一时刻只开一个 popover；Esc 关闭并把焦点还给触发 chip', { timeout: 15000 }, async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    const priority = await screen.findByTestId('priority-chip');
    const due = screen.getByTestId('due-chip');
    await userEvent.click(priority);
    expect(screen.getByTestId('priority-popover')).toBeInTheDocument();
    expect(priority).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(due);
    expect(screen.queryByTestId('priority-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('due-popover')).toBeInTheDocument();
    expect(due).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('due-popover')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(due);
  });

  it('负责人 chip：有占用显示名称 + 已占用时长；租约明细不臆造数值', { timeout: 15000 }, async () => {
    mockDetailApi(makeIssue({ claimed_by: 'agent:codex', claimed_at: Date.now() - 12 * 60 * 1000 }));
    renderDetail();
    const chip = await screen.findByTestId('owner-chip');
    expect(chip).toHaveTextContent('codex');
    expect(chip).toHaveTextContent('12 分钟');
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(chip);
    expect(screen.getByTestId('owner-popover-duration')).toHaveTextContent('已占用 12 分钟');
    expect(screen.getByTestId('owner-popover')).toHaveTextContent('租约剩余时间：接口未暴露');
  });

  it('负责人 chip：未占用显示「未领取」并说明可直接派发', { timeout: 15000 }, async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    const chip = await screen.findByTestId('owner-chip');
    expect(chip).toHaveTextContent('未领取');
    expect(chip).toHaveAttribute('title', '未领取');
    await userEvent.click(chip);
    expect(await screen.findByTestId('owner-popover')).toHaveTextContent('当前无占用者');
  });
});

describe('DetailPanel 滚动区留白（RIGHT-PANEL-HEADER-01）', () => {
  it('滚动容器右侧留白 16px（> 经典滚动条 15px），标题作为首个区块不被滚动条压', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    const panel = await screen.findByTestId('detail-panel');
    const scroller = panel.querySelector('.overflow-y-auto') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain('pr-4');
    expect(scroller!.className).not.toContain('p-3');
    expect(scroller!.className).toContain('py-3');
    expect(scroller!.className).toContain('pl-3');
  });
});

describe('DetailPanel 标题就地编辑（D1）', () => {
  async function openTitleEditor(): Promise<HTMLInputElement> {
    await userEvent.click(await screen.findByTestId('title-edit-btn'));
    return (await screen.findByTestId('title-input')) as HTMLInputElement;
  }

  it('点 ✎ 进入编辑：原文本让位、只显示输入框，预填原文且光标在末尾；取消后恢复，连续 3 次成立', async () => {
    mockDetailApi(makeIssue());
    renderDetail();

    for (let round = 0; round < 3; round += 1) {
      const input = await openTitleEditor();
      expect(screen.queryByTestId('title-display')).not.toBeInTheDocument();
      expect(input).toHaveValue('测试任务');
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe('测试任务'.length);
      expect(input.selectionEnd).toBe('测试任务'.length);

      await userEvent.click(screen.getByTestId('title-cancel'));
      expect(screen.queryByTestId('title-input')).not.toBeInTheDocument();
      expect(await screen.findByTestId('title-display')).toHaveTextContent('测试任务');
      expect(screen.getByTestId('title-edit-btn')).toHaveFocus();
    }
  });

  it('Enter 提交：PATCH 带 workspace_id + expected_updated_at，成功后退出编辑并展示新标题', async () => {
    const base = makeIssue({ updated_at: 7 });
    mockDetailApi(base);
    let current = base;
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/api/issues/iss-1', () => HttpResponse.json(current)),
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        current = { ...base, title: '测试任务-新', updated_at: 8 };
        return HttpResponse.json(current);
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    await userEvent.type(input, '-新{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ title: '测试任务-新', workspace_id: 'ws-1', expected_updated_at: 7 });
    expect(await screen.findByTestId('title-display')).toHaveTextContent('测试任务-新');
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument();
  });

  it('Esc 取消：标题不变且不提交；有改动时下次进入恢复草稿并提示一次', async () => {
    mockDetailApi(makeIssue());
    let patchCount = 0;
    server.use(
      http.patch('/api/issues/iss-1', () => {
        patchCount += 1;
        return HttpResponse.json(makeIssue());
      }),
    );
    renderDetail();

    let input = await openTitleEditor();
    await userEvent.clear(input);
    await userEvent.type(input, '临时标题');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('title-display')).toHaveTextContent('测试任务');
    expect(patchCount).toBe(0);

    input = await openTitleEditor();
    expect(input).toHaveValue('临时标题');
    expect(screen.getByTestId('title-draft-hint')).toHaveTextContent('已恢复上次未保存的草稿');

    // 改回原文再 Esc：视为无改动，不再保留草稿
    await userEvent.clear(input);
    await userEvent.type(input, '测试任务');
    await userEvent.keyboard('{Escape}');
    input = await openTitleEditor();
    expect(input).toHaveValue('测试任务');
    expect(screen.queryByTestId('title-draft-hint')).not.toBeInTheDocument();
    expect(patchCount).toBe(0);
  });

  it('点击编辑区外部：保持编辑态，不自动提交也不自动取消', async () => {
    mockDetailApi(makeIssue());
    let patchCount = 0;
    server.use(
      http.patch('/api/issues/iss-1', () => {
        patchCount += 1;
        return HttpResponse.json(makeIssue());
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    await userEvent.type(input, 'X');
    fireEvent.click(screen.getByTestId('desc-preview'));

    expect(screen.getByTestId('title-input')).toBeInTheDocument();
    expect(input).toHaveValue('测试任务X');
    expect(patchCount).toBe(0);
  });

  it('空值 Enter：行内红字且不提交，输入保留', async () => {
    mockDetailApi(makeIssue());
    let patchCount = 0;
    server.use(
      http.patch('/api/issues/iss-1', () => {
        patchCount += 1;
        return HttpResponse.json(makeIssue());
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    await userEvent.clear(input);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('title-error')).toHaveTextContent('标题不能为空，请填写后再保存。');
    expect(patchCount).toBe(0);
    expect(screen.getByTestId('title-input')).toBeInTheDocument();
  });

  it('长度边界：恰好 200 通过并提交（计数 200/200）', async () => {
    const base = makeIssue({ updated_at: 7 });
    mockDetailApi(base);
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ...base, title: 'a'.repeat(200), updated_at: 8 });
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    fireEvent.change(input, { target: { value: 'a'.repeat(161) } });
    expect(screen.getByTestId('title-counter')).toHaveTextContent('161 / 200');
    fireEvent.change(input, { target: { value: 'a'.repeat(200) } });
    expect(screen.getByTestId('title-counter')).toHaveTextContent('200 / 200');

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ title: 'a'.repeat(200) });
    expect(await screen.findByTestId('title-display')).toHaveTextContent('a'.repeat(200));
  });

  it('长度边界 +1：201 被拒、红字可读且输入保留、不发 PATCH', async () => {
    mockDetailApi(makeIssue());
    let patchCount = 0;
    server.use(
      http.patch('/api/issues/iss-1', () => {
        patchCount += 1;
        return HttpResponse.json(makeIssue());
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    fireEvent.change(input, { target: { value: 'a'.repeat(201) } });
    expect(screen.getByTestId('title-counter')).toHaveTextContent('201 / 200');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('title-error')).toHaveTextContent(
      '标题最多 200 字，当前 201 字（已保留你的输入）。',
    );
    expect(input).toHaveValue('a'.repeat(201));
    expect(patchCount).toBe(0);
  });

  it('保存失败：可读错误 + 输入不丢 + 仍在编辑态', async () => {
    mockDetailApi(makeIssue());
    server.use(
      http.patch('/api/issues/iss-1', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: '服务暂时不可用' } }, { status: 500 }),
      ),
    );
    renderDetail();

    const input = await openTitleEditor();
    await userEvent.type(input, 'X{Enter}');
    const alert = await screen.findByTestId('title-error');
    expect(alert).toHaveTextContent('保存失败');
    expect(alert).toHaveTextContent('服务暂时不可用');
    expect(screen.getByTestId('title-input')).toHaveValue('测试任务X');
  });

  it('409 冲突：保留输入并可「仍然保存」（强制提交不带 CAS）', async () => {
    const base = makeIssue({ updated_at: 7 });
    mockDetailApi(base);
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        if (patches.length === 1) {
          return HttpResponse.json(
            { error: { code: 'TASK_REVISION_CONFLICT', message: '任务已更新，请重新读取' } },
            { status: 409 },
          );
        }
        return HttpResponse.json({ ...base, title: '测试任务X', updated_at: 9 });
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    await userEvent.type(input, 'X{Enter}');
    expect(await screen.findByTestId('title-error')).toHaveTextContent('保存冲突');
    expect(screen.getByTestId('title-input')).toHaveValue('测试任务X');

    await userEvent.click(screen.getByTestId('title-force-save'));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ title: '测试任务X' });
    expect(await screen.findByTestId('title-display')).toHaveTextContent('测试任务X');
  });

  it('输入法组词中的 Enter 不提交（isComposing）', async () => {
    mockDetailApi(makeIssue());
    let patchCount = 0;
    server.use(
      http.patch('/api/issues/iss-1', () => {
        patchCount += 1;
        return HttpResponse.json(makeIssue());
      }),
    );
    renderDetail();

    const input = await openTitleEditor();
    fireEvent.change(input, { target: { value: '测试任务组词' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(screen.getByTestId('title-input')).toBeInTheDocument();
    expect(patchCount).toBe(0);
  });

  it('进入编辑时锁住阅读态高度（标题行不跳变）', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    await screen.findByTestId('title-display');
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === 'title-display' ? 42.59 : 0;
      return { x: 0, y: 0, width: 0, height, top: 0, right: 0, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      await userEvent.click(screen.getByTestId('title-edit-btn'));
      const wrap = await screen.findByTestId('title-edit-wrap');
      expect(wrap).toHaveStyle({ height: '42.59px' });
    } finally {
      rectSpy.mockRestore();
    }
  });
});

describe('DetailPanel 字段防抖 PATCH', () => {
  it('标签 chips 编辑 → PATCH labels 数组；优先级 chip popover → PATCH priority', async () => {
    mockDetailApi(makeIssue());
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ updated_at: Date.now() }));
      }),
    );
    renderDetail();
    // F-07：chips 编辑器 —— 输入后回车成 chip（不再靠逗号分隔整串解析）
    await userEvent.type(await screen.findByTestId('labels-input'), '性能{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ labels: ['前端', '性能'] });

    // D2：优先级 select 改成 chip + popover
    const chip = screen.getByTestId('priority-chip');
    expect(chip).toHaveAttribute('data-priority', '中');
    await userEvent.click(chip);
    await userEvent.click(screen.getByTestId('priority-option-高'));
    await waitFor(() => expect(patches).toHaveLength(2), { timeout: 2000 });
    expect(patches[1]).toEqual({ priority: '高' });
    expect(screen.getByTestId('priority-chip')).toHaveAttribute('data-priority', '高');
  });
});

describe('AUDIT-DETAIL 增补', () => {
  it('待验收卡：验收动作 + 通过验收并关闭预填验收评论草稿', async () => {
    mockDetailApi(makeIssue({ status: '待验收', updated_at: 3 }));
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ status: '已关闭', updated_at: 9 }));
      }),
    );
    renderDetail();
    const close = await screen.findByTestId('accept-close-btn');
    expect(screen.getByTestId('reopen-running-btn')).toBeInTheDocument();
    await userEvent.click(close);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ status: '已关闭' });
    // 预填草稿同时落 localStorage 与输入框
    const draft = localStorage.getItem('agentboard.comment-draft:iss-1') ?? '';
    expect(draft).toContain('验收通过');
    expect(await screen.findByTestId('comment-input')).toHaveValue(draft);
  });

  it('待验收卡：退回进行中 → PATCH status=进行中', async () => {
    mockDetailApi(makeIssue({ status: '待验收', updated_at: 3 }));
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeIssue({ status: '进行中', updated_at: 9 }));
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByTestId('reopen-running-btn'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ status: '进行中' });
  });

  it('标签 chips：chip 逐枚删除 → PATCH labels 数组', async () => {
    mockDetailApi(makeIssue());
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ updated_at: Date.now() }));
      }),
    );
    renderDetail();
    expect(await screen.findByTestId('label-chip-前端')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('label-chip-remove-前端'));
    expect(screen.queryByTestId('label-chip-前端')).not.toBeInTheDocument();
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ labels: [] });
  });

  it('评论草稿落 localStorage；输入框内首按 Esc 只失焦不关面板', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    const input = await screen.findByTestId('comment-input');
    await userEvent.type(input, '半截草稿');
    expect(localStorage.getItem('agentboard.comment-draft:iss-1')).toBe('半截草稿');

    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).not.toBe(input);
    // 面板仍在（DetailPanel 未被关闭）
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});

describe('DetailPanel 评论区', () => {
  it('未占用：提示"仅留言"，发送后 woke=false 显示未唤醒', async () => {
    const comments: IssueComment[] = [];
    mockDetailApi(makeIssue());
    let postBody: unknown = null;
    server.use(
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)),
      http.post('/api/issues/iss-1/comments', async ({ request }) => {
        postBody = await request.json();
        const comment: IssueComment = {
          id: 'c-new',
          issue_id: 'iss-1',
          author: 'user',
          content: '**加粗**留言',
          ts: 2,
        };
        comments.push(comment);
        return HttpResponse.json({ comment, woke: false });
      }),
    );
    renderDetail();
    expect(await screen.findByTestId('comment-hint')).toHaveTextContent('仅留言');
    await userEvent.type(screen.getByTestId('comment-input'), '**加粗**留言');
    await userEvent.click(screen.getByTestId('comment-send'));
    await waitFor(() => expect(postBody).toEqual({ content: '**加粗**留言' }));
    expect(await screen.findByTestId('comment-woke-result')).toHaveTextContent('未唤醒');
    // markdown 渲染 + 新评论上屏
    expect(screen.getByText('加粗').closest('strong')).not.toBeNull();
    expect(await screen.findByTestId('comment-c-new')).toBeInTheDocument();
  });

  it('评论区时间正序：最早在最上，同 ts 保持服务端次序（COMMENT-ORDER）', async () => {
    const comments: IssueComment[] = [
      { id: 'c3', issue_id: 'iss-1', author: 'user', content: '第三条', ts: 200 },
      { id: 'c1', issue_id: 'iss-1', author: 'user', content: '第一条', ts: 100 },
      { id: 'c4', issue_id: 'iss-1', author: 'user', content: '第四条', ts: 400 },
      { id: 'c2', issue_id: 'iss-1', author: 'user', content: '第二条', ts: 200 },
    ];
    mockDetailApi(makeIssue());
    server.use(http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)));
    renderDetail();

    await screen.findByTestId('comment-c4');
    const ids = [...document.querySelectorAll('[data-testid^="comment-c"]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id !== 'comment-count');
    // 正序：c1(100) → c3(200，服务端在前) → c2(200) → c4(400)
    expect(ids).toEqual(['comment-c1', 'comment-c3', 'comment-c2', 'comment-c4']);
  });

  it('正序下新发评论出现在最后一行（不置顶）', async () => {
    const comments: IssueComment[] = [
      { id: 'c-old', issue_id: 'iss-1', author: 'user', content: '旧评论', ts: 100 },
    ];
    mockDetailApi(makeIssue());
    server.use(
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)),
      http.post('/api/issues/iss-1/comments', async () => {
        const comment: IssueComment = { id: 'c-最新', issue_id: 'iss-1', author: 'user', content: '新评论', ts: 900 };
        comments.push(comment);
        return HttpResponse.json({ comment, woke: false });
      }),
    );
    renderDetail();
    await screen.findByTestId('comment-c-old');
    await userEvent.type(screen.getByTestId('comment-input'), '新评论');
    await userEvent.click(screen.getByTestId('comment-send'));

    await screen.findByTestId('comment-c-最新');
    await waitFor(() => {
      const ids = [...document.querySelectorAll('[data-testid^="comment-c"]')]
        .map((node) => node.getAttribute('data-testid'))
        .filter((id) => id !== 'comment-count');
      expect(ids.at(-1)).toBe('comment-c-最新');
    });
  });

  it('占用中：提示"将唤醒 <cli>"，woke=true 显示已唤醒', async () => {
    const comments: IssueComment[] = [];
    mockDetailApi(makeIssue({ status: '进行中', claimed_by: 'agent:codex', claimed_at: 5, session_id: 's-old' }));
    server.use(
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)),
      http.post('/api/issues/iss-1/comments', () =>
        HttpResponse.json({
          comment: { id: 'c-2', issue_id: 'iss-1', author: 'user', content: '补充指令', ts: 3 },
          woke: true,
        }),
      ),
    );
    renderDetail();
    expect(await screen.findByTestId('comment-hint')).toHaveTextContent('将唤醒 codex');
    await userEvent.type(screen.getByTestId('comment-input'), '补充指令');
    await userEvent.click(screen.getByTestId('comment-send'));
    expect(await screen.findByTestId('comment-woke-result')).toHaveTextContent('已唤醒 codex');
  });

  it('kb 自助领取占用（session_id=null）：提示"留言待 agent 下次读取"，woke=false 显示未唤醒', async () => {
    const comments: IssueComment[] = [];
    mockDetailApi(makeIssue({ status: '进行中', claimed_by: 'agent:codex', claimed_at: 5, session_id: null }));
    server.use(
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)),
      http.post('/api/issues/iss-1/comments', () =>
        HttpResponse.json({
          comment: { id: 'c-3', issue_id: 'iss-1', author: 'user', content: '异步留言', ts: 4 },
          woke: false,
        }),
      ),
    );
    renderDetail();
    expect(await screen.findByTestId('comment-hint')).toHaveTextContent('留言待 agent 下次读取');
    await userEvent.type(screen.getByTestId('comment-input'), '异步留言');
    await userEvent.click(screen.getByTestId('comment-send'));
    expect(await screen.findByTestId('comment-woke-result')).toHaveTextContent('未唤醒');
  });
});

describe('DetailPanel 删除二次确认', () => {
  it('点删除出现确认，取消可返回；确认后 DELETE 并收起面板', async () => {
    mockDetailApi(makeIssue());
    let deleted = false;
    server.use(http.delete('/api/issues/iss-1', () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    renderDetail();
    await userEvent.click(await screen.findByTestId('delete-btn'));
    expect(screen.getByTestId('delete-confirm-text')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('delete-cancel'));
    expect(screen.queryByTestId('delete-confirm-text')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('delete-btn'));
    await userEvent.click(screen.getByTestId('delete-confirm'));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(usePanelStore.getState().rightOpen).toBe(false));
  });

  it('有直接子任务时明确阻止删除并说明先处理子任务', async () => {
    const parent = makeIssue();
    mockDetailApi(parent);
    let deleteCalls = 0;
    server.use(
      http.get('/api/issues', () => HttpResponse.json([
        parent,
        makeIssue({ id: 'child', title: '子任务', parent_issue_id: parent.id }),
      ])),
      http.delete('/api/issues/iss-1', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderDetail();
    await userEvent.click(await screen.findByTestId('delete-btn'));

    expect(await screen.findByTestId('delete-confirm-text')).toHaveTextContent('该任务有 1 个直接子任务');
    expect(screen.getByTestId('delete-confirm-text')).toHaveTextContent('先移动或删除子任务');
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    expect(deleteCalls).toBe(0);
  });
});

describe('关联会话列表', () => {
  it('状态徽标 + 当前高亮，点击切聊天视图', async () => {
    const sessions = [
      makeSession({ id: 's-cur', status: '运行中', created_at: 2 }),
      makeSession({ id: 's-old' }),
    ];
    mockDetailApi(makeIssue({ session_id: 's-cur' }), { sessions });
    renderDetail();
    expect(await screen.findByTestId('session-item-s-cur')).toBeInTheDocument();
    expect(screen.getByTestId('session-current-s-cur')).toHaveTextContent('当前');
    expect(screen.getByTestId('session-running-s-cur')).toBeInTheDocument();
    expect(screen.queryByTestId('session-running-s-old')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('session-item-s-old'));
    // S2b：聊天整屏化 —— openChat 只切 navStore，面板视图清空收起
    expect(usePanelStore.getState()).toMatchObject({ view: null, sessionId: 's-old', rightOpen: false });
    expect(useNavStore.getState().view).toBe('chat');
  });
});

describe('DispatchDialog', () => {
  function mockDispatchApi(opts: { modelsFor?: Record<string, unknown[]> } = {}): {
    bodies: Array<Record<string, unknown>>;
  } {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/api/clis', () => HttpResponse.json(clisMixed)),
      http.get('/api/clis/codebuddy/models', () =>
        HttpResponse.json(opts.modelsFor?.codebuddy ?? [
          { id: 'm1', source: 'static' },
          { id: 'm2', source: 'static' },
        ]),
      ),
      http.get('/api/clis/codex/models', () =>
        HttpResponse.json(opts.modelsFor?.codex ?? [{ id: 'gpt-5-codex', source: 'static' }]),
      ),
      http.post('/api/sessions', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeSession({ id: 'sess-new', status: '运行中' }));
      }),
    );
    return { bodies };
  }

  it('默认值（上次模型优先）、未装 CLI 禁用、提交体含渲染变量并切聊天', async () => {
    mockDetailApi(makeIssue(), { sessions: [makeSession({ id: 's-old', status: '已结束' })] });
    mockDispatchApi();
    localStorage.setItem('agentboard.last-model.codebuddy', 'm2');
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const promptEl = (await screen.findByTestId('dispatch-prompt')) as HTMLTextAreaElement;
    expect(promptEl.value).toContain('任务 ID：iss-1');
    expect(promptEl.value).toContain('工作目录：D:/ws/main');
    expect(promptEl.value).toContain('标题：测试任务');
    expect(promptEl.value).toContain('kb show iss-1');
    // 无评论：不预填历史备注段，不显示历史备注提示
    expect(promptEl.value).not.toContain('历史备注');
    expect(screen.queryByTestId('history-note')).not.toBeInTheDocument();
    // 未安装项禁用并标注
    const opencode = screen.getByRole('option', { name: 'OpenCode（未安装）' }) as HTMLOptionElement;
    expect(opencode).toBeDisabled();
    // 默认模型 = localStorage 上次值
    await waitFor(
      () => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('m2'),
    );
    // 有历史会话 → 续用单选
    expect(screen.getByTestId('reuse-group')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('续用最近会话（保留 agent 已有进度）'));
    await userEvent.click(screen.getByTestId('dispatch-confirm'));

    await waitFor(() => expect(usePanelStore.getState()).toMatchObject({ view: null, sessionId: 'sess-new', rightOpen: false }));
    expect(useNavStore.getState().view).toBe('chat');
    await waitFor(() => {
      expect(screen.queryByTestId('dispatch-confirm')).not.toBeInTheDocument();
    });
  });

  it('提交体断言：cli/model/reuse_session/prompt；无历史会话时不出现续用单选；模型回写 localStorage', async () => {
    mockDetailApi(makeIssue());
    const { bodies } = mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    await screen.findByTestId('dispatch-confirm');
    expect(screen.queryByTestId('reuse-group')).not.toBeInTheDocument();
    // 无 localStorage 记录 → 清单第一项
    await waitFor(
      () => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('m1'),
    );

    await userEvent.click(screen.getByTestId('dispatch-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      cli: 'codebuddy',
      model: 'm1',
      issue_id: 'iss-1',
      reuse_session: 'new',
    });
    expect(String(bodies[0]!.prompt)).toContain('任务 ID：iss-1');
    expect(String(bodies[0]!.prompt)).toContain('描述：\n任务描述内容');
    await waitFor(() => expect(localStorage.getItem('agentboard.last-model.codebuddy')).toBe('m1'));
  });

  it('重新派发未知结果图片需显式勾选确认', async () => {
    const imageComment: IssueComment = {
      id: 'c-unknown', issue_id: 'iss-1', author: 'user', content: '请看图', ts: 2,
      attachments: [{
        id: 'att-unknown', file_name: 'proof.png', mime_type: 'image/png', size_bytes: 8,
        url: '/api/issues/iss-1/attachments/att-unknown', delivery_state: 'unknown',
      }],
    };
    mockDetailApi(makeIssue(), { comments: [imageComment] });
    const { bodies } = mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const retry = await screen.findByLabelText('确认重试未知投递图片');
    expect(retry).not.toBeChecked();
    await userEvent.click(retry);
    await userEvent.click(screen.getByTestId('dispatch-confirm'));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ retry_unknown_images: true, selected_attachment_ids: ['att-unknown'] });
  });

  it('长图片列表将派发对话框限制在视口内并提供内部滚动', async () => {
    mockDetailApi(makeIssue());
    const candidates = Array.from({ length: 13 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      comment_id: `comment-${index + 1}`, author: 'user', ts: index + 1, snippet: `合成评论 ${index + 1}`,
      file_name: `synthetic-${index + 1}.png`, mime_type: 'image/png' as const, size_bytes: 1024,
      delivery_state: (index === 0 ? 'unknown' : 'pending') as 'unknown' | 'pending',
    }));
    server.use(http.get('/api/issues/iss-1/pending-attachments', () => HttpResponse.json({ items: candidates, next_offset: null })));
    mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const dialog = await screen.findByRole('dialog', { name: '派发设置' });

    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
    expect(await screen.findByLabelText('确认重试未知投递图片')).toBeInTheDocument();
    expect(screen.getByTestId('dispatch-confirm')).toBeInTheDocument();
  });

  it('默认最旧优先选择5张，加载下一页后可替换本批并提交opaque ID', async () => {
    mockDetailApi(makeIssue());
    const candidates = Array.from({ length: 22 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      comment_id: `comment-${index + 1}`,
      author: 'user',
      ts: index + 1,
      snippet: `合成评论 ${index + 1}`,
      file_name: `synthetic-${index + 1}.png`,
      mime_type: 'image/png' as const,
      size_bytes: 1024,
      delivery_state: 'pending' as const,
    }));
    server.use(http.get('/api/issues/iss-1/pending-attachments', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      return HttpResponse.json({ items: candidates.slice(offset, offset + limit), next_offset: offset + limit < candidates.length ? offset + limit : null });
    }));
    const { bodies } = mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const checkbox = (index: number) => screen.getByLabelText(`选择图片 synthetic-${index}.png`) as HTMLInputElement;
    await waitFor(() => expect(checkbox(5)).toBeChecked());
    expect(checkbox(1)).toBeChecked();
    expect(checkbox(6)).not.toBeChecked();

    await userEvent.click(checkbox(1));
    await userEvent.click(checkbox(6));
    await userEvent.click(checkbox(7));
    expect(await screen.findByTestId('attachment-selection-notice')).toHaveTextContent('最多 5 张');
    expect(checkbox(7)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: '加载更多历史图片' }));
    expect(await screen.findByLabelText('选择图片 synthetic-21.png')).not.toBeChecked();
    await userEvent.click(checkbox(2));
    await userEvent.click(screen.getByLabelText('选择图片 synthetic-21.png'));
    await userEvent.click(screen.getByTestId('dispatch-confirm'));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.selected_attachment_ids).toEqual(candidates.slice(2, 7).map((candidate) => candidate.id).concat(candidates[20]!.id));
  });

  it('允许选择超出20 MiB的图片并提示服务端按有界前缀截断', async () => {
    mockDetailApi(makeIssue());
    const candidates = [1, 2].map((index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      comment_id: `comment-${index}`, author: 'user', ts: index, snippet: '合成评论',
      file_name: `large-${index}.png`, mime_type: 'image/png' as const,
      size_bytes: 12 * 1024 * 1024, delivery_state: 'pending' as const,
    }));
    server.use(http.get('/api/issues/iss-1/pending-attachments', () => HttpResponse.json({ items: candidates, next_offset: null })));
    mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const first = await screen.findByLabelText('选择图片 large-1.png') as HTMLInputElement;
    const second = screen.getByLabelText('选择图片 large-2.png') as HTMLInputElement;
    await waitFor(() => expect(first).toBeChecked());
    await userEvent.click(second);

    expect(second).toBeChecked();
    expect(await screen.findByTestId('attachment-selection-notice')).toHaveTextContent('20 MiB');
  });

  it('派发响应返回剩余数后保留弹窗并允许显式续用会话发送下一批', async () => {
    mockDetailApi(makeIssue({ session_id: 's-old' }), { sessions: [makeSession({ id: 's-old', status: '已结束' })] });
    const allCandidates = Array.from({ length: 7 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      comment_id: `comment-${index + 1}`, author: 'user', ts: index + 1, snippet: `合成图片 ${index + 1}`,
      file_name: `batch-${index + 1}.png`, mime_type: 'image/png' as const, size_bytes: 1024, delivery_state: 'pending' as const,
    }));
    let pending = [...allCandidates];
    const bodies: Array<Record<string, unknown>> = [];
    mockDispatchApi();
    server.use(
      http.get('/api/issues/iss-1/pending-attachments', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset'));
        return HttpResponse.json({ items: pending.slice(offset, offset + limit), next_offset: offset + limit < pending.length ? offset + limit : null });
      }),
      http.post('/api/sessions', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        const sentIds = body.selected_attachment_ids as string[];
        pending = pending.filter((candidate) => !sentIds.includes(candidate.id));
        return HttpResponse.json({ ...makeSession({ id: bodies.length === 1 ? 'sess-first' : 'sess-second', status: '运行中' }), remaining_attachment_count: pending.length });
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    await waitFor(() => expect((screen.getByLabelText('选择图片 batch-5.png') as HTMLInputElement)).toBeChecked());
    await userEvent.click(screen.getByTestId('dispatch-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(await screen.findByTestId('attachment-batch-notice')).toHaveTextContent('另有 2 张未附');
    expect(screen.getByTestId('reuse-group')).toBeInTheDocument();
    expect(screen.getByLabelText('续用最近会话（保留 agent 已有进度）')).toBeChecked();
    expect(screen.queryByLabelText('选择图片 batch-1.png')).not.toBeInTheDocument();
    expect(screen.getByLabelText('选择图片 batch-6.png')).not.toBeChecked();

    await userEvent.click(screen.getByLabelText('选择图片 batch-6.png'));
    await userEvent.click(screen.getByLabelText('选择图片 batch-7.png'));
    await userEvent.click(screen.getByTestId('dispatch-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ reuse_session: 'last', selected_attachment_ids: allCandidates.slice(5).map((candidate) => candidate.id) });
    await waitFor(() => expect(screen.queryByTestId('dispatch-confirm')).not.toBeInTheDocument());
  });

  it('手输模型走 datalist 输入框并提交手输值', async () => {
    mockDetailApi(makeIssue());
    const { bodies } = mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    await userEvent.click(await screen.findByTestId('model-mode-toggle'));
    const input = screen.getByTestId('model-manual-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'my-custom-model');
    await userEvent.click(screen.getByTestId('dispatch-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ model: 'my-custom-model' });
  });

  it('dsh（supportsModelSelection=false）→ 模型控件禁用 + 标注，提交不带 model；切回非只读恢复可用', async () => {
    mockDetailApi(makeIssue());
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/api/clis', () =>
        HttpResponse.json([
          { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0', supportsModelSelection: true },
          { id: 'dsh', displayName: 'DSH', installed: true, version: '0.2.4', supportsModelSelection: false },
        ]),
      ),
      http.get('/api/clis/codebuddy/models', () => HttpResponse.json([{ id: 'm1', source: 'static' }])),
      http.get('/api/clis/dsh/models', () => HttpResponse.json([{ id: 'deepseek-v4-flash', source: 'static' }])),
      http.post('/api/sessions', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeSession({ id: 'sess-new', status: '运行中' }));
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    // 默认 CLI = codebuddy（第一个已安装）：模型正常预填可用，无只读标注
    await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('m1'));
    expect(screen.queryByTestId('model-readonly-hint')).not.toBeInTheDocument();

    // 切到 dsh：select/手输切换禁用、不预填（state 为空）、标注"由 profile 配置决定"
    await userEvent.selectOptions(screen.getByTestId('cli-select'), 'dsh');
    await waitFor(() =>
      expect(screen.getByTestId('model-readonly-hint')).toHaveTextContent('由 profile 配置决定'),
    );
    expect(screen.getByTestId('model-select')).toBeDisabled();
    expect(screen.getByTestId('model-mode-toggle')).toBeDisabled();

    await userEvent.click(screen.getByTestId('dispatch-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ cli: 'dsh', model: null });
  });

  const threeComments: IssueComment[] = [
    { id: 'c-1', issue_id: 'iss-1', author: 'user', content: '第一条', ts: 1 },
    { id: 'c-2', issue_id: 'iss-1', author: 'agent:codex', content: '第二条', ts: 2 },
    { id: 'c-3', issue_id: 'iss-1', author: 'user', content: '第三条', ts: 3 },
  ];

  it('有评论：textarea 预填历史备注段（3 条 ts 升序），显示可编辑提示', async () => {
    mockDetailApi(makeIssue(), { comments: threeComments });
    mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const promptEl = (await screen.findByTestId('dispatch-prompt')) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(promptEl.value).toContain('## 历史备注\n- [user] 第一条\n- [agent:codex] 第二条\n- [user] 第三条'),
    );
    expect(promptEl.value).toContain('任务 ID：iss-1');
    expect(screen.getByTestId('history-note')).toHaveTextContent('可自由删改');
  });

  it('编辑历史备注内容后提交，请求体 prompt 含编辑后文本', async () => {
    mockDetailApi(makeIssue(), { comments: threeComments });
    const { bodies } = mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const promptEl = (await screen.findByTestId('dispatch-prompt')) as HTMLTextAreaElement;
    await waitFor(() => expect(promptEl.value).toContain('- [agent:codex] 第二条'));
    fireEvent.change(promptEl, {
      target: { value: promptEl.value.replace('- [agent:codex] 第二条', '- [agent:codex] 第二条（已改）') },
    });
    await userEvent.click(screen.getByTestId('dispatch-confirm'));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sentPrompt = String(bodies[0]!.prompt);
    expect(sentPrompt).toContain('- [agent:codex] 第二条（已改）');
    expect(sentPrompt).not.toContain('- [agent:codex] 第二条\n');
    expect(sentPrompt).toContain('任务 ID：iss-1');
  });

  it('无评论：textarea 不含历史备注，不显示历史备注提示', async () => {
    mockDetailApi(makeIssue(), { comments: [] });
    mockDispatchApi();
    renderDetail();

    await userEvent.click(await screen.findByTestId('dispatch-btn'));
    const promptEl = (await screen.findByTestId('dispatch-prompt')) as HTMLTextAreaElement;
    await waitFor(() => expect(promptEl.value).not.toContain('历史备注'));
    expect(screen.queryByTestId('history-note')).not.toBeInTheDocument();
  });
});

describe('RightPanel 容器', () => {
  it('view=null 不渲染；收起后窄条可展开恢复', async () => {
    mockDetailApi(makeIssue());
    renderDetail({ open: false });
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();

    openDetail();
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();

    // PANEL-ENTRY2：关闭是整块卸载（没有收起态窄条），重开由入口触发（openDetail）
    await userEvent.click(screen.getByTestId('right-panel-close'));
    // PANEL-MOTION-2：关闭先走出场相位（仍挂载），动画结束后才卸载
    await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    expect(screen.queryByTestId('right-panel-collapsed')).toBeNull();
    expect(screen.queryByTestId('right-panel-rail')).toBeNull();
    openDetail();
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();
  });

  it('D1 回归排除：连续 3 次打开任务详情，详情容器每次都在 DOM 且可见（无列信息时 detailAnchor 回落 drawer）', async () => {
    mockDetailApi(makeIssue());
    renderDetail({ open: false });

    for (let round = 0; round < 3; round += 1) {
      openDetail();
      const panel = await screen.findByTestId('right-panel');
      // 进入相位结束后（内联 opacity=1）才算「真实可见」，不能只看数据层
      await waitFor(() => expect(panel).toHaveAttribute('data-panel-state', 'open'));
      expect(panel).not.toHaveAttribute('aria-hidden');
      expect(screen.getByTestId('right-panel-content')).not.toHaveAttribute('inert');
      // 面板没有被某个条件提前 return/null：详情容器、字段区与标题都在 DOM 且可见
      expect(await screen.findByTestId('detail-panel-view')).toBeVisible();
      expect(await screen.findByTestId('detail-panel')).toBeVisible();
      expect(await screen.findByTestId('title-display')).toBeVisible();
      // jsdom 无列信息：detailAnchor 仍被调用并回落 drawer（不是锚定成 0 高面板）
      expect(panel).toHaveAttribute('data-anchored', 'false');
      expect(panel).toHaveAttribute('data-anchor-side', 'fixed');

      await userEvent.click(screen.getByTestId('right-panel-close'));
      await waitFor(() => expect(screen.queryByTestId('right-panel')).toBeNull());
    }
  });

  it('openChat 走 navStore：面板不再渲染 chat 视图（S2b 整屏化，detail/ref 浮窗计数 0）', async () => {
    renderDetail({ open: false });
    act(() => usePanelStore.getState().openChat());
    expect(useNavStore.getState().view).toBe('chat');
    expect(usePanelStore.getState().view).toBeNull();
    expect(screen.queryByTestId('chat-panel-view')).toBeNull();
    expect(screen.queryByTestId('detail-panel-view')).toBeNull();
    expect(screen.queryByTestId('right-panel')).toBeNull();
  });

  it('拖拽左缘调整宽度并写 localStorage（钳制 320–720）', async () => {
    mockDetailApi(makeIssue());
    renderDetail();
    openDetail();
    await screen.findByTestId('right-panel');

    const handle = screen.getByTestId('right-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 }); // +100
    fireEvent.pointerUp(window, { clientX: 400 });
    await waitFor(() => expect(localStorage.getItem('agentboard.right-panel-width')).toBe('520'));

    fireEvent.pointerDown(handle, { clientX: 1000 });
    fireEvent.pointerMove(window, { clientX: 0 }); // +1000 → 钳制 720
    fireEvent.pointerUp(window, { clientX: 0 });
    await waitFor(() => expect(localStorage.getItem('agentboard.right-panel-width')).toBe('720'));
  });
});

