/** 新增工作空间弹窗：浏览文件夹（POST /api/system/pick-folder）+ 名称留空以文件夹名兜底 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { NewWorkspaceDialog } from '../components/workspace/NewWorkspaceDialog';
import { server } from './server';

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewWorkspaceDialog open onClose={() => {}} />
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: '新增工作空间' });
  return {
    dialog,
    nameInput: within(dialog).getByLabelText('工作空间名称') as HTMLInputElement,
    pathInput: within(dialog).getByLabelText('工作空间路径') as HTMLInputElement,
    browseButton: within(dialog).getByRole('button', { name: '浏览文件夹' }),
    submitButton: within(dialog).getByRole('button', { name: '创建' }),
  };
}

describe('NewWorkspaceDialog 浏览文件夹', () => {
  it('点击浏览…：pick-folder 返回路径 → 填入路径输入框', async () => {
    server.use(
      http.post('/api/system/pick-folder', () => HttpResponse.json({ path: 'D:\\picked\\dir' })),
    );
    const ui = renderDialog();
    await userEvent.click(ui.browseButton);

    await waitFor(() => expect(ui.pathInput).toHaveValue('D:\\picked\\dir'));
    // 路径就位后（name 未手动改过）自动预填 basename
    await waitFor(() => expect(ui.nameInput).toHaveValue('dir'));
  });

  it('pick-folder 返回 null（取消/未选择）→ 路径输入框不变，按钮恢复', async () => {
    server.use(http.post('/api/system/pick-folder', () => HttpResponse.json({ path: null })));
    const ui = renderDialog();
    await userEvent.click(ui.browseButton);

    await waitFor(() => expect(ui.browseButton).toBeEnabled());
    expect(ui.pathInput).toHaveValue('');
    expect(screen.queryByText('请在弹出的窗口中选择文件夹')).not.toBeInTheDocument();
  });

  it('busy 409 → 按钮恢复并提示错误', async () => {
    server.use(
      http.post('/api/system/pick-folder', () =>
        HttpResponse.json(
          { error: { code: 'PICK_FOLDER_BUSY', message: '已有选择窗口打开' } },
          { status: 409 },
        ),
      ),
    );
    const ui = renderDialog();
    await userEvent.click(ui.browseButton);

    expect(await screen.findByText('已有选择窗口打开')).toBeInTheDocument();
    expect(ui.browseButton).toBeEnabled();
    expect(ui.browseButton).toHaveTextContent('浏览…');
    expect(screen.queryByText('请在弹出的窗口中选择文件夹')).not.toBeInTheDocument();
  });
});

describe('NewWorkspaceDialog 名称兜底', () => {
  it('输入路径后 name 实时预填 basename（含尾部反斜杠）', async () => {
    const ui = renderDialog();
    await userEvent.type(ui.pathInput, 'D:\\a\\b\\my-project');
    await waitFor(() => expect(ui.nameInput).toHaveValue('my-project'));

    await userEvent.clear(ui.pathInput);
    await userEvent.type(ui.pathInput, 'D:\\a\\b\\my-project\\');
    await waitFor(() => expect(ui.nameInput).toHaveValue('my-project'));
  });

  it('手动改过 name 后，再改路径不再覆盖', async () => {
    const ui = renderDialog();
    await userEvent.type(ui.nameInput, '自定义');
    await userEvent.type(ui.pathInput, 'D:\\x\\proj');
    await waitFor(() => expect(ui.pathInput).toHaveValue('D:\\x\\proj'));

    expect(ui.nameInput).toHaveValue('自定义');
  });

  it('name 留空提交 → body.name 为空串（服务端兜底）', async () => {
    let captured: unknown = null;
    server.use(
      http.post('/api/workspaces', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ id: 'ws-x', name: 'proj', path: 'D:\\x\\proj', created_at: 1 });
      }),
    );
    const ui = renderDialog();
    await userEvent.type(ui.pathInput, 'D:\\x\\proj');
    await waitFor(() => expect(ui.nameInput).toHaveValue('proj')); // 预填后手动清空
    await userEvent.clear(ui.nameInput);
    await userEvent.click(ui.submitButton);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({ name: '', path: 'D:\\x\\proj' });
  });
});
