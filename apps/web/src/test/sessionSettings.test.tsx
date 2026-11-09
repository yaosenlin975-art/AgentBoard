/**
 * P1-C 会话设置三节：
 * - 三节渲染与人设列表/能力探测加载态；
 * - 保存只发本段字段（人设 persona_id/injection、工具 tool_policy、技能 skill_policy）；
 * - flag 注入按能力置灰并给原因；builtin 人设正文只读；
 * - 保存失败回滚 UI 并提示；未知/已删人设显示「未知人设 <id>」且可切走。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Session } from '@agentboard/shared';
import { SessionSettingsDialog, type SessionPersonaFields, type ToolPolicyValue } from '../components/chat/SessionSettingsDialog';
import { server } from './server';

const baseSession: Session & SessionPersonaFields = {
  id: 'sess-settings',
  workspace_id: 'ws-1',
  issue_id: null,
  cli: 'codex',
  model: 'gpt',
  status: '已结束',
  adapter_session_id: null,
  created_at: 1,
  title: null,
  persona_id: null,
  tool_policy: null,
  skill_policy: null,
  persona_injection: 'auto',
};

const personas = [
  {
    id: 'p-builtin',
    name: '内置人设',
    description: '内置',
    body_md: 'BUILTIN BODY',
    source: 'builtin' as const,
    package_path: null,
    created_at: 1,
  },
  {
    id: 'p-user',
    name: '自定义人设',
    description: '自定义',
    body_md: 'USER BODY',
    source: 'user' as const,
    package_path: null,
    created_at: 2,
  },
];

function stubCapabilities(overrides: Partial<{ personaFlag: boolean; toolFlags: boolean }> = {}) {
  server.use(
    http.get('/api/cli-capabilities', () =>
      HttpResponse.json({
        adapter: 'codex',
        command: 'codex',
        personaFlag: true,
        toolFlags: true,
        permissionFlags: [],
        ...overrides,
      }),
    ),
  );
}

function renderDialog(session: Session & SessionPersonaFields = baseSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionSettingsDialog session={session} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

function stubPersonas(list: unknown[] = personas) {
  server.use(http.get('/api/personas', () => HttpResponse.json(list)));
}

describe('SessionSettingsDialog（P1-C）', () => {
  it('三节渲染：人设列表、builtin 只读、flag 注入按能力置灰并给原因', async () => {
    stubPersonas();
    stubCapabilities({ personaFlag: false, toolFlags: false });
    renderDialog({ ...baseSession, persona_id: 'p-builtin' });

    expect(screen.getByTestId('settings-section-persona')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-tools')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-skills')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('option', { name: '内置人设（内置）' })).toBeInTheDocument());

    expect(screen.getByTestId('persona-builtin-badge')).toBeInTheDocument();
    const body = screen.getByTestId('persona-body') as HTMLTextAreaElement;
    expect(body.value).toBe('BUILTIN BODY');
    expect(body.readOnly).toBe(true);
    expect(screen.queryByTestId('persona-body-save')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('injection-option-flag')).toBeDisabled());
    expect(screen.getByTestId('injection-flag-reason')).toBeInTheDocument();
  });

  it('人设改动自动防抖保存，并只 PATCH 变更字段', async () => {
    stubPersonas();
    stubCapabilities();
    let body: Record<string, unknown> | null = null;
    let patchCount = 0;
    server.use(
      http.patch('/api/sessions/sess-settings', async ({ request }) => {
        patchCount += 1;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(baseSession);
      }),
    );
    renderDialog();

    await waitFor(() => expect(screen.getByTestId('injection-option-off')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('injection-option-off'));
    fireEvent.change(screen.getByTestId('persona-select'), { target: { value: 'p-user' } });

    expect(body).toBeNull();
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ persona_id: 'p-user', persona_injection: 'off' });
    expect(patchCount).toBe(1);
  });

  it('工具保存：PATCH 只带 tool_policy（含审批模式与 allow 标签）', async () => {
    stubPersonas();
    stubCapabilities();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/sessions/sess-settings', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(baseSession);
      }),
    );
    renderDialog();

    fireEvent.change(screen.getByTestId('tools-approval-select'), { target: { value: 'plan' } });
    fireEvent.change(screen.getByTestId('tools-allow-input'), { target: { value: 'bash' } });
    fireEvent.keyDown(screen.getByTestId('tools-allow-input'), { key: 'Enter' });

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ tool_policy: { approval_mode: 'plan', allow: ['bash'], deny: [] } });
  });

  it('技能保存：PATCH 只带 skill_policy 且空数组允许', async () => {
    stubPersonas();
    stubCapabilities();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/sessions/sess-settings', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(baseSession);
      }),
    );
    renderDialog();

    fireEvent.change(screen.getByTestId('skills-allow-input'), { target: { value: 'skill-a' } });
    fireEvent.keyDown(screen.getByTestId('skills-allow-input'), { key: 'Enter' });

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ skill_policy: { allow: ['skill-a'], deny: [] } });
  });

  it('保存失败：回滚 UI 并提示错误', async () => {
    stubPersonas();
    stubCapabilities();
    server.use(
      http.patch('/api/sessions/sess-settings', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: '保存炸了' } }, { status: 500 }),
      ),
    );
    renderDialog();

    fireEvent.change(screen.getByTestId('tools-approval-select'), { target: { value: 'bypass' } });

    await waitFor(() => expect(screen.getByTestId('session-settings-error')).toHaveTextContent('保存炸了'));
    expect((screen.getByTestId('tools-approval-select') as HTMLSelectElement).value).toBe('inherit');
  });

  it('同字段后续快照已排队时，早期失败不回滚覆盖最新值', async () => {
    stubPersonas();
    stubCapabilities();
    const patches: Array<{ approvalMode: string }> = [];
    let savedMode = 'inherit';
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
    server.use(
      http.patch('/api/sessions/sess-settings', async ({ request }) => {
        const body = (await request.json()) as { tool_policy: ToolPolicyValue };
        patches.push({ approvalMode: body.tool_policy.approval_mode });
        if (patches.length === 1) {
          await firstResponse;
          return HttpResponse.json({ error: { code: 'INTERNAL', message: '首请求失败' } }, { status: 500 });
        }
        savedMode = body.tool_policy.approval_mode;
        return HttpResponse.json(baseSession);
      }),
    );
    renderDialog();

    await waitFor(() => expect(screen.getByTestId('tools-approval-select')).toBeInTheDocument());
    const select = screen.getByTestId('tools-approval-select');
    fireEvent.change(select, { target: { value: 'plan' } });
    await waitFor(() => expect(patches).toHaveLength(1));

    fireEvent.change(select, { target: { value: 'bypass' } });
    await new Promise((resolve) => setTimeout(resolve, 550));
    fireEvent.change(select, { target: { value: 'plan' } });
    await new Promise((resolve) => setTimeout(resolve, 550));

    releaseFirst();
    await waitFor(() => expect(patches).toHaveLength(3), { timeout: 3000 });
    await waitFor(() => expect(savedMode).toBe('plan'));
    expect(patches.map((patch) => patch.approvalMode)).toEqual(['plan', 'bypass', 'plan']);
    expect((screen.getByTestId('tools-approval-select') as HTMLSelectElement).value).toBe('plan');
  }, 10_000);

  it('卸载和切换 session 会立即 flush 到对应的旧 session', async () => {
    stubPersonas();
    stubCapabilities();
    const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
    server.use(
      http.patch('/api/sessions/:id', async ({ request, params }) => {
        patches.push({ id: String(params.id), body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json(baseSession);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderSession = (session: Session & SessionPersonaFields) => (
      <QueryClientProvider client={client}>
        <SessionSettingsDialog session={session} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    const view = render(renderSession({ ...baseSession, id: 'sess-old' }));

    await waitFor(() => expect(screen.getByRole('option', { name: '自定义人设' })).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('persona-select'), { target: { value: 'p-user' } });
    view.rerender(renderSession({ ...baseSession, id: 'sess-new', persona_id: 'p-builtin' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ id: 'sess-old', body: { persona_id: 'p-user' } });
    expect((screen.getByTestId('persona-select') as HTMLSelectElement).value).toBe('p-builtin');

    fireEvent.change(screen.getByTestId('persona-select'), { target: { value: '' } });
    view.unmount();
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ id: 'sess-new', body: { persona_id: null } });
  });

  it('未知/已删人设：显示「未知人设 <id>」且可切走为解绑', async () => {
    stubPersonas();
    stubCapabilities();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/sessions/sess-settings', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(baseSession);
      }),
    );
    renderDialog({ ...baseSession, persona_id: 'ghost-1' });

    await waitFor(() => expect(screen.getByRole('option', { name: '未知人设 ghost-1' })).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('persona-select'), { target: { value: '' } });

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ persona_id: null });
  });

  it('人设加载失败：显示错误与重试；空列表显示空态', async () => {
    stubPersonas([]);
    stubCapabilities();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('persona-empty')).toBeInTheDocument());
  });

  it('人设加载失败态：错误文案 + 重试按钮', async () => {
    server.use(
      http.get('/api/personas', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '人设挂了' } }, { status: 500 })),
    );
    stubCapabilities();
    renderDialog();
    await waitFor(() => expect(screen.getByText(/人设加载失败：人设挂了/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
