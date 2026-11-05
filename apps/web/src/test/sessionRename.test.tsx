/**
 * 会话重命名弹窗：空值 / 超 50 字在前端就有明确文案且不发请求；正常提交发 PATCH title。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Session } from '@agentboard/shared';
import { RenameSessionDialog } from '../components/chat/RenameSessionDialog';
import { server } from './server';

const session: Session = {
  id: 'sess-1',
  workspace_id: 'ws-1',
  issue_id: null,
  cli: 'codex',
  model: 'gpt',
  status: '已结束',
  adapter_session_id: null,
  created_at: 1,
  title: null,
};

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RenameSessionDialog session={session} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('RenameSessionDialog', () => {
  it('空值提交：明确提示且不发请求', async () => {
    const onClose = renderDialog();
    fireEvent.change(screen.getByTestId('rename-session-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('rename-session-submit'));
    expect(screen.getByTestId('rename-session-error')).toHaveTextContent('会话名称不能为空');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('超 50 字提交：提示字数且不发请求', async () => {
    const onClose = renderDialog();
    fireEvent.change(screen.getByTestId('rename-session-input'), { target: { value: 'x'.repeat(51) } });
    fireEvent.click(screen.getByTestId('rename-session-submit'));
    expect(screen.getByTestId('rename-session-error')).toHaveTextContent('最多 50 字');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('正常提交：PATCH title（trim 后）并关闭', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('/api/sessions/sess-1', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...session, title: '新名字' });
      }),
    );
    const onClose = renderDialog();
    fireEvent.change(screen.getByTestId('rename-session-input'), { target: { value: '  新名字  ' } });
    fireEvent.click(screen.getByTestId('rename-session-submit'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ title: '新名字' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
