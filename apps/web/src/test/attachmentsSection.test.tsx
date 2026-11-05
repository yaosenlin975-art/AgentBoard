import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { AttachmentsSection } from '../components/detail/AttachmentsSection';
import { server } from './server';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function stubClipboard(impl: { writeText: ReturnType<typeof vi.fn> } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: impl, configurable: true, writable: true });
}

function stubExecCommand(impl: (() => boolean) | undefined): void {
  Object.defineProperty(document, 'execCommand', { value: impl, configurable: true, writable: true });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else delete (document as { execCommand?: unknown }).execCommand;
});

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsSection issueId="iss-1" />
    </QueryClientProvider>,
  );
}

const items = [
  { id: 'att-txt', file_name: 'notes.txt', kind: 'file', size_bytes: 17, url: '/api/workspaces/ws-1/attachments/att-txt' },
  { id: 'att-png', file_name: 'screen.png', kind: 'image', size_bytes: 9, url: '/api/workspaces/ws-1/attachments/att-png' },
];

describe('DETAIL-D7 附件路径索引', () => {
  it('按路径列出附件：文件名 + 完整路径（固定 URL）；「打开所在位置」置灰并提示需服务端 reveal 能力', async () => {
    server.use(http.get('/api/issues/iss-1/attachments', () => HttpResponse.json({ items, next_offset: null })));
    renderSection();

    expect(await screen.findByTestId('detail-attachments')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('/api/workspaces/ws-1/attachments/att-txt')).toBeInTheDocument();
    expect(screen.getByText('screen.png')).toBeInTheDocument();

    const reveal = screen.getByTestId('detail-attachment-reveal-att-txt');
    expect(reveal).toBeDisabled();
    expect(reveal).toHaveAttribute('title', '需服务端 reveal 能力');
  });

  it('复制路径写入剪贴板并反馈「已复制」', async () => {
    server.use(http.get('/api/issues/iss-1/attachments', () => HttpResponse.json({ items, next_offset: null })));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    renderSection();

    const button = await screen.findByTestId('detail-attachment-copy-att-png');
    await userEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('/api/workspaces/ws-1/attachments/att-png');
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    // 其它条目不受影响，仍显示「复制路径」
    expect(screen.getByTestId('detail-attachment-copy-att-txt')).toHaveTextContent('复制路径');
  });

  it('clipboard 不可用时回退 execCommand，仍给出复制反馈', async () => {
    server.use(http.get('/api/issues/iss-1/attachments', () => HttpResponse.json({ items, next_offset: null })));
    stubClipboard(undefined);
    const execCommand = vi.fn(() => true);
    stubExecCommand(execCommand);
    renderSection();

    await userEvent.click(await screen.findByTestId('detail-attachment-copy-att-txt'));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('无附件时显示空态提示', async () => {
    renderSection();

    expect(await screen.findByTestId('detail-attachments-empty')).toHaveTextContent('暂无附件');
    expect(screen.queryByTestId('detail-attachments')).not.toBeInTheDocument();
  });
});
