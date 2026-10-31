/**
 * Task 13 测试：操作区四态切换、评论发送两态与 woke 提示、防抖 PATCH、删除二次确认、
 * 派发弹窗提交体（cli/model/reuse_session/prompt 渲染变量）、RightPanel 容器收起/展开/拖拽宽度。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueComment, Session, Workspace } from '@agentboard/shared';
import { DetailPanel } from '../components/detail/DetailPanel';
import { RightPanel } from '../components/right/RightPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
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
    claimed_by: null,
    claimed_at: null,
    session_id: null,
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
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' },
  { id: 'codex', displayName: 'Codex', installed: true, version: '1.0.0' },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null },
];

/** DetailPanel 所需的全部 GET handlers */
function mockDetailApi(
  issue: Issue,
  opts: { comments?: IssueComment[]; sessions?: Session[] } = {},
): void {
  server.use(
    http.get('/api/issues/iss-1', () => HttpResponse.json(issue)),
    http.get('/api/issues/iss-1/comments', () => HttpResponse.json(opts.comments ?? [])),
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

describe('DetailPanel 字段防抖 PATCH', () => {
  it('连续输入只发一次 PATCH，体为最终值', async () => {
    mockDetailApi(makeIssue());
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ title: '测试任务ab', updated_at: 99 }));
      }),
    );
    renderDetail();
    const input = await screen.findByTestId('title-input');
    await userEvent.type(input, 'ab');
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ title: '测试任务ab' });
  });

  it('标签逗号分隔编辑 → PATCH labels 数组；优先级 select → PATCH priority', async () => {
    mockDetailApi(makeIssue());
    const patches: Array<Record<string, unknown>> = [];
    server.use(
      http.patch('/api/issues/iss-1', async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(makeIssue({ updated_at: Date.now() }));
      }),
    );
    renderDetail();
    await userEvent.type(await screen.findByTestId('labels-input'), ',性能');
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ labels: ['前端', '性能'] });

    await userEvent.selectOptions(screen.getByTestId('priority-select'), '高');
    await waitFor(() => expect(patches).toHaveLength(2), { timeout: 2000 });
    expect(patches[1]).toEqual({ priority: '高' });
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
    expect(usePanelStore.getState()).toMatchObject({ view: 'chat', sessionId: 's-old', rightOpen: true });
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
    expect(screen.getByTestId('history-note')).toHaveTextContent('历史备注（后端自动追加，最近10条）');
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

    await waitFor(() => expect(usePanelStore.getState()).toMatchObject({ view: 'chat', sessionId: 'sess-new', rightOpen: true }));
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
});

describe('RightPanel 容器', () => {
  it('view=null 不渲染；收起后窄条可展开恢复', async () => {
    mockDetailApi(makeIssue());
    renderDetail({ open: false });
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();

    openDetail();
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('right-panel-collapse'));
    expect(screen.getByTestId('right-panel-collapsed')).toBeInTheDocument();
    // 数据保留：展开恢复 detail
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'iss-1' });
    await userEvent.click(screen.getByTestId('right-panel-expand'));
    expect(await screen.findByTestId('right-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('detail-panel')).toBeInTheDocument();
  });

  it('chat 视图渲染占位（T14 替换）', async () => {
    usePanelStore.setState({ view: 'chat', issueId: null, sessionId: null, rightOpen: true });
    renderDetail({ open: false });
    expect(await screen.findByText('聊天视图将在 Task 14 实现')).toBeInTheDocument();
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
