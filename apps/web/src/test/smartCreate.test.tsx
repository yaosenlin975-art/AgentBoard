/**
 * SMART-CREATE-UI 用例：手动/智能切换不丢内容、生成中态与取消、成功进可编辑草稿、
 * 三种错误码回退手动表单并保留需求原文、warnings 清单展示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { NewIssueDialog } from '../components/topbar/NewIssueDialog';
import { server } from './server';

function renderDialog(): { created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.post('/api/issues', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({ id: 'new-1', ...body }, { status: 200 });
    }),
    http.get('/api/clis', () => HttpResponse.json([
      { id: 'dsh', displayName: 'DSH', installed: false, version: null },
      { id: 'codex', displayName: 'Codex', installed: true, version: '1.0.0' },
      { id: 'opencode', displayName: 'OpenCode', installed: true, version: '1.0.0' },
    ])),
  );
  render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open workspaceId="ws-1" onClose={() => undefined} />
    </QueryClientProvider>,
  );
  return { created };
}

beforeEach(() => {
  localStorage.clear();
});

describe('智能创建（SMART-CREATE-UI）', () => {
  it('手动/智能切换不丢已填内容', async () => {
    renderDialog();
    await userEvent.type(screen.getByTestId('new-issue-title'), '手动标题');
    await userEvent.type(screen.getByTestId('new-issue-description'), '手动描述');

    await userEvent.click(screen.getByTestId('mode-smart'));
    await userEvent.type(screen.getByTestId('smart-requirement'), '一段需求');
    await userEvent.click(screen.getByTestId('mode-manual'));
    expect(screen.getByTestId('new-issue-title')).toHaveValue('手动标题');
    expect(screen.getByTestId('new-issue-description')).toHaveValue('手动描述');

    await userEvent.click(screen.getByTestId('mode-smart'));
    expect(screen.getByTestId('smart-requirement')).toHaveValue('一段需求');
  });

  it('dsh 本机不可用 → 面板给出可读提示', async () => {
    renderDialog();
    await userEvent.click(screen.getByTestId('mode-smart'));
    await waitFor(() => expect(screen.getByTestId('smart-adapter')).toHaveValue('codex'));
    expect(screen.queryByTestId('smart-adapter-hint')).toBeNull();
    await userEvent.selectOptions(screen.getByTestId('smart-adapter'), 'dsh');
    expect(await screen.findByTestId('smart-adapter-hint')).toHaveTextContent('在本机不可用');
  });

  it('生成中显示进度，成功进可编辑草稿，确认后才落库（值来自草稿）', async () => {
    let resolveDraft!: () => void;
    const { created } = renderDialog();
    server.use(
      http.post('/api/issues/draft', async () => {
        await new Promise<void>((r) => { resolveDraft = r; });
        return HttpResponse.json({
          title: '草稿标题',
          description: '## 背景\n…\n## 要求\n…\n## 验收\n…',
          labels: ['web', '缺陷'],
          warnings: ['『本周任务』的筛选依据未明确'],
        });
      }),
    );

    await userEvent.click(screen.getByTestId('mode-smart'));
    await userEvent.type(screen.getByTestId('smart-requirement'), '把列滚动修好');
    await userEvent.click(screen.getByTestId('smart-generate'));

    // 生成中：进度 + 取消按钮
    expect(await screen.findByTestId('smart-progress')).toHaveTextContent('正在生成草稿');
    expect(screen.getByTestId('smart-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('smart-generate')).toBeNull();

    resolveDraft();
    await waitFor(() => expect(screen.queryByTestId('smart-progress')).toBeNull());
    // 现场：草稿落进可编辑表单 + warning 清单
    expect(await screen.findByTestId('draft-status')).toBeInTheDocument();
    expect(screen.getByTestId('new-issue-title')).toHaveValue('草稿标题');
    expect(screen.getByTestId('new-issue-labels')).toHaveValue('web,缺陷');
    const warnings = screen.getByTestId('draft-warnings');
    expect(within(warnings).getByTestId('draft-warning-0')).toHaveTextContent('『本周任务』的筛选依据未明确');
    expect(created).toHaveLength(0); // 未确认不落库

    // 编辑草稿后创建
    await userEvent.clear(screen.getByTestId('new-issue-title'));
    await userEvent.type(screen.getByTestId('new-issue-title'), '改后的标题');
    await userEvent.click(screen.getByTestId('new-issue-submit'));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ title: '改后的标题', labels: ['web', '缺陷'] });
  });

  it('三种错误码 → 中文文案 + 回退手动表单 + 需求原文保留', async () => {
    const cases: Array<{ code: string; status: number; expect: RegExp }> = [
      { code: 'DRAFT_ADAPTER_FAILED', status: 502, expect: /生成失败：适配器进程退出/ },
      { code: 'DRAFT_INVALID_OUTPUT', status: 422, expect: /草稿格式不合法/ },
      { code: 'DRAFT_TIMEOUT', status: 504, expect: /生成超时/ },
    ];
    for (const item of cases) {
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <NewIssueDialog open workspaceId="ws-1" onClose={() => undefined} />
        </QueryClientProvider>,
      );
      server.use(
        http.post('/api/issues/draft', () =>
          HttpResponse.json({ error: { code: item.code, message: '适配器进程退出' } }, { status: item.status }),
        ),
      );
      await userEvent.click(screen.getByTestId('mode-smart'));
      await userEvent.type(screen.getByTestId('smart-requirement'), '原始需求文本');
      await userEvent.click(screen.getByTestId('smart-generate'));

      const message = await screen.findByTestId('smart-message');
      expect(message).toHaveTextContent(item.expect);
      expect(message).toHaveTextContent(/已回退到手动创建/);
      // 回退后是手动表单，且需求原文进了描述
      expect(screen.getByTestId('new-issue-title')).toBeInTheDocument();
      expect(screen.getByTestId('new-issue-description')).toHaveValue('原始需求文本');
      unmount();
    }
  });

  it('取消生成：不按失败回退，需求原文留在智能面板', async () => {
    renderDialog();
    server.use(
      http.post('/api/issues/draft', async ({ request }) => {
        const signal = request.signal;
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(resolve, 3000);
        });
        return HttpResponse.json({ title: 't', description: 'd', labels: [], warnings: [] });
      }),
    );
    await userEvent.click(screen.getByTestId('mode-smart'));
    await userEvent.type(screen.getByTestId('smart-requirement'), '会被取消的需求');
    await userEvent.click(screen.getByTestId('smart-generate'));
    await screen.findByTestId('smart-progress');
    await userEvent.click(screen.getByTestId('smart-cancel'));

    await waitFor(() => expect(screen.queryByTestId('smart-progress')).toBeNull());
    expect(screen.getByTestId('smart-requirement')).toHaveValue('会被取消的需求');
    expect(screen.getByTestId('smart-message')).toHaveTextContent('已取消生成');
  });
});
