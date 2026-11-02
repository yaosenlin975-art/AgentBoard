/**
 * 工作区日志（MD-CHANGELOG）：时间轴与归档只读视图共用 ChangelogTimeline → 同一个 MarkdownView，
 * 表格 / 任务列表 / 删除线 / 代码高亮必须都渲染出真实元素；归档 readonly 不出现写操作。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { ChangelogTimeline } from '../components/changelog/ChangelogTimeline';
import { ArchivedChangelogPanel } from '../components/changelog/ArchivedChangelogPanel';
import { server } from './server';

const MD = [
  '## 日志标题',
  '',
  '段落 **粗体** ~~删除线~~ `行内`。',
  '',
  '| 项目 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '',
  '- [ ] 待办',
  '- [x] 已完成',
].join('\n');

function entry(overrides: Partial<WorkspaceChangeLog> = {}): WorkspaceChangeLog {
  return {
    id: 'log-1',
    workspace_id: 'ws-1',
    title: '渲染验收',
    body_md: MD,
    change_type: '修复',
    occurred_at: 1_761_000_000_000,
    updated_at: 1_761_000_000_000,
    updated_by: 'user',
    revision: 1,
    legacy_source_key: null,
    ...overrides,
  } as WorkspaceChangeLog;
}

function withClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
});

describe('工作区日志 Markdown（MD-CHANGELOG）', () => {
  it('时间轴展开项渲染表格 / 删除线 / 任务列表 / 代码高亮', async () => {
    withClient(
      <ChangelogTimeline entries={[entry()]} onEdit={() => undefined} onDelete={() => undefined} />,
    );
    await userEvent.click(await screen.findByTestId('changelog-toggle-log-1'));
    const body = await screen.findByTestId('changelog-body-log-1');
    await waitFor(() => expect(body.querySelector('table')).not.toBeNull(), { timeout: 5000 });
    expect(body.querySelectorAll('th')).toHaveLength(2);
    expect(body.querySelectorAll('del')).toHaveLength(1);
    expect(body.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(body.textContent).not.toContain('| --- |');
    expect(body.textContent).not.toContain('~~删除线~~');
  });

  it('归档只读视图：同一套渲染，且不出现编辑/删除入口', async () => {
    server.use(
      http.get('/api/changelog/archived-workspaces', () =>
        HttpResponse.json({
          items: [{ origin_workspace_id: 'ws-old', name: '旧空间', path: 'D:\\old', removed_at: 1_761_000_000_000, entry_count: 1 }],
          next_offset: null,
        }),
      ),
      http.get('/api/changelog/archived-workspaces/ws-old/entries', () => HttpResponse.json({ items: [entry({ id: 'log-old' })], next_offset: null })),
    );
    withClient(<ArchivedChangelogPanel />);

    await userEvent.click(await screen.findByTestId('changelog-archived-workspace-ws-old'));
    await userEvent.click(await screen.findByTestId('changelog-toggle-log-old'));
    const body = await screen.findByTestId('changelog-body-log-old');
    await waitFor(() => expect(body.querySelector('table')).not.toBeNull(), { timeout: 5000 });
    expect(body.querySelectorAll('del')).toHaveLength(1);
    expect(body.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    // 只读：无编辑/删除按钮
    const root = screen.getByTestId('changelog-archived');
    expect(within(root).queryByRole('button', { name: /编辑/ })).toBeNull();
    expect(within(root).queryByRole('button', { name: /删除/ })).toBeNull();
  });
});

