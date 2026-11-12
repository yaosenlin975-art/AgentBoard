/**
 * CLI-DEFAULT-MODEL-3 测试（issue ed38017c）：设置页「各 CLI 默认模型」分区契约 +
 * 新建会话/派发弹窗的模型预填优先级（settings.cliDefaultModels[cli] → loadLastModel(cli) → ''/清单首项）。
 * MSW 隔离：/api/settings、/api/clis、模型清单按用例覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { CliDefaultModelSection } from '../components/settings/CliDefaultModelSection';
import { NewSessionDialog } from '../components/chat/NewSessionDialog';
import { DispatchDialog } from '../components/detail/DispatchDialog';
import { server } from './server';
import { lastModelKey } from '../lib/dispatchTemplate';

const settingsPayload = {
  port: 8787,
  dbPath: 'D:\\db\\a.db',
  maxConcurrentTurns: 3,
  cliDefaultModels: {} as Record<string, string>,
};

/** codex 已安装（触发「默认第一个已安装项」与可选 option） */
const clisInstalled = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: false, version: null, supportsModelSelection: true },
  { id: 'codex', displayName: 'Codex', installed: true, version: '1.0', supportsModelSelection: true },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null, supportsModelSelection: true },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null, supportsModelSelection: false },
];

function withProviders(ui: React.ReactElement): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

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

beforeEach(() => {
  cleanup();
  localStorage.clear();
  server.use(http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: {} })));
  server.use(http.get('/api/clis', () => HttpResponse.json(clisInstalled)));
  server.use(
    http.get('/api/clis/:cliId/models', ({ params }) =>
      params.cliId === 'codex'
        ? HttpResponse.json([{ id: 'gpt-5', source: 'static' }])
        : HttpResponse.json([]),
    ),
  );
});

/** 等模型清单加载完、ModelField 从输入形态切到下拉形态（否则 selectOptions 打到 <input> 上） */
async function waitForSelect(testid: string): Promise<HTMLSelectElement> {
  return await waitFor(() => {
    const el = screen.getByTestId(testid);
    if (el.tagName !== 'SELECT') throw new Error(`${testid} 还是输入形态（模型清单未加载）`);
    return el as HTMLSelectElement;
  });
}

describe('设置页「各 CLI 默认模型」分区', () => {
  it('每个 CLI 一行；dsh 只读；空值文案「使用 <cli> 自身默认」', async () => {
    withProviders(<CliDefaultModelSection />);
    const codex = await waitForSelect('cli-default-model-codex');
    expect(screen.getByTestId('cli-default-model-codebuddy')).toBeInTheDocument();
    expect(screen.getByTestId('cli-default-model-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('cli-default-model-dsh')).toBeInTheDocument();
    // dsh 只读提示（ModelField 内置；等 ['clis'] 缓存解析出 supportsModelSelection=false）
    const hint = await screen.findByTestId('cli-default-model-dsh-readonly-hint');
    expect(hint).toHaveTextContent('由 profile 配置决定');
    // 有清单 → 下拉；空值选项文案为「不配置」语义
    expect(codex.tagName).toBe('SELECT');
    expect(codex.options[0]?.textContent).toBe('使用 Codex 自身默认');
  });

  it('保存：选值 → PATCH body 只含 cliDefaultModels 且含该键；成功提示', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/settings', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...settingsPayload, cliDefaultModels: { codex: 'gpt-5' } });
      }),
    );
    withProviders(<CliDefaultModelSection />);
    await userEvent.selectOptions(await waitForSelect('cli-default-model-codex'), 'gpt-5');
    await userEvent.click(screen.getByTestId('cli-default-model-save'));
    await waitFor(() => expect(screen.getByTestId('cli-default-model-saved')).toBeInTheDocument());
    expect(patched).toEqual({ cliDefaultModels: { codex: 'gpt-5' } });
  });

  it('清除：选回空值 → 保存 → 该键为 ""（服务端删键口径）', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: { codex: 'gpt-5' } })));
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/settings', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...settingsPayload, cliDefaultModels: {} });
      }),
    );
    withProviders(<CliDefaultModelSection />);
    const select = await waitForSelect('cli-default-model-codex');
    expect(select.value).toBe('gpt-5');
    await userEvent.selectOptions(select, '');
    await userEvent.click(screen.getByTestId('cli-default-model-save'));
    await waitFor(() => expect(patched).toEqual({ cliDefaultModels: { codex: '' } }));
  });

  it('服务端 422：显示 MODEL_UNAVAILABLE 文案，输入不被清空', async () => {
    server.use(
      http.patch(
        '/api/settings',
        () =>
          HttpResponse.json(
            { error: { code: 'MODEL_UNAVAILABLE', message: '模型 mX 不在 codex 的可用清单中' } },
            { status: 422 },
          ),
      ),
    );
    withProviders(<CliDefaultModelSection />);
    await userEvent.selectOptions(await waitForSelect('cli-default-model-codex'), '__manual__');
    const input = (await screen.findByTestId('cli-default-model-codex')) as HTMLInputElement;
    await userEvent.type(input, 'mX');
    await userEvent.click(screen.getByTestId('cli-default-model-save'));
    const error = await screen.findByTestId('cli-default-model-error');
    expect(error).toHaveTextContent('模型 mX 不在 codex 的可用清单中');
    // 用户输入保留不回滚
    const after = screen.getByTestId('cli-default-model-codex') as HTMLInputElement;
    expect(after.value).toBe('mX');
  });
});

describe('预填优先级：settings.cliDefaultModels[cli] → loadLastModel(cli) → 空/清单首项', () => {
  it('新建会话：配置 codex 默认 → 模型=配置值（localStorage 有别的值也不生效）；未配置 → 回落 last-model', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: { codex: 'gpt-5' } })),
    );
    localStorage.setItem(lastModelKey('codex'), 'user-last');
    withProviders(<NewSessionDialog defaultWorkspaceId="ws-1" onClose={vi.fn()} />);
    // codex 已安装 → 自动选中，预填配置值
    await waitFor(() => {
      const model = screen.getByTestId('ns-model') as HTMLSelectElement;
      expect(model.value).toBe('gpt-5');
    });

    // 未配置场景：回落 localStorage 记忆
    cleanup();
    server.use(http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: {} })));
    localStorage.setItem(lastModelKey('codex'), 'user-last');
    withProviders(<NewSessionDialog defaultWorkspaceId="ws-1" onClose={vi.fn()} />);
    await waitFor(() => {
      const model = screen.getByTestId('ns-model') as HTMLInputElement;
      // user-last 不在清单 → ModelField 自动切手动输入形态，值保留
      expect(model.value).toBe('user-last');
    });
  });

  it('派发对话框：配置默认优先于 localStorage；未配置时回落 last-model（在清单内）', async () => {
    server.use(http.get('/api/issues/:id/comments', () => HttpResponse.json([])));
    server.use(
      http.get('/api/issues/:id/pending-attachments', () => HttpResponse.json({ items: [], next_offset: null })),
    );

    // 配置优先：localStorage 有别的值也不生效
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: { codex: 'gpt-5' } })),
    );
    localStorage.setItem(lastModelKey('codex'), 'user-last');
    withProviders(<DispatchDialog issue={makeIssue()} workspacePath="D:\\demo" onClose={vi.fn()} />);
    await waitFor(() => {
      const model = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(model.value).toBe('gpt-5');
    });

    // 未配置：回落 last-model（在清单内才生效）
    cleanup();
    server.use(http.get('/api/settings', () => HttpResponse.json({ ...settingsPayload, cliDefaultModels: {} })));
    localStorage.setItem(lastModelKey('codex'), 'gpt-5');
    withProviders(<DispatchDialog issue={makeIssue()} workspacePath="D:\\demo" onClose={vi.fn()} />);
    await waitFor(() => {
      const model = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(model.value).toBe('gpt-5');
    });
  });
});
