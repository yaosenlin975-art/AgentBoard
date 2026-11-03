/**
 * CHAT-PASTE-IMAGE / CHAT-USER-IMAGE：聊天输入框粘贴截图。
 * 覆盖：带文本+1 张 png 的粘贴（文本插入 + 上传 1 次 + markdown 图片插入光标处）、
 * 多图顺序、超限/类型不支持/上传失败的中文提示、未选工作区提示、纯文本粘贴不接管、
 * 以及「图片上传中不许发送」（否则消息不带图，用户看到气泡里没有图）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { Composer } from '../components/chat/Composer';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

function pngFile(name = 'shot.png', bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

/** 构造一次「粘贴」：jsdom 没有 DataTransfer，这里造最小 clipboardData 形状（items/files/getData） */
function paste(target: HTMLElement, options: { text?: string; files?: File[] }): void {
  const files = options.files ?? [];
  const clipboard = {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
    types: options.text === undefined ? ['Files'] : ['text/plain', 'Files'],
    getData: (type: string) => (type === 'text/plain' ? (options.text ?? '') : ''),
  };
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboard });
  target.dispatchEvent(event);
}

function renderComposer(workspaceId: string | null = 'ws-1', onSend = vi.fn().mockResolvedValue(undefined)): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer disabled={false} running={false} queuedCount={0} workspaceId={workspaceId} onSend={onSend} />
    </QueryClientProvider>,
  );
}

const uploaded: Array<{ name: string; mime: string }> = [];

beforeEach(() => {
  localStorage.clear();
  uploaded.length = 0;
  usePanelStore.setState({ chatDraft: '' });
  server.use(
    http.post('/api/workspaces/:ws/attachments', async ({ request, params }) => {
      const mime = request.headers.get('Content-Type') ?? 'image/png';
      const id = `att-${uploaded.length + 1}`;
      uploaded.push({ name: request.headers.get('X-File-Name') ?? 'unnamed', mime });
      return HttpResponse.json({
        id,
        workspace_id: String(params.ws),
        mime_type: mime,
        bytes: 1024,
        status: 'staged',
        expires_at: Date.now() + 60_000,
        download_url: `/api/workspaces/${params.ws}/attachments/${id}`,
      });
    }),
    http.get('/api/skills', () => HttpResponse.json([])),
    http.get('/api/issues', () => HttpResponse.json([])),
  );
});

describe('聊天输入框粘贴图片（CHAT-PASTE-IMAGE）', () => {
  it('粘贴 1 张 png + 一段文本：文本照常插入，上传被调 1 次，图片 markdown 插到光标处', async () => {
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 0);
    paste(input, { text: '看这张图', files: [pngFile()] });

    await waitFor(() => expect(uploaded).toHaveLength(1));
    await waitFor(() => expect(input.value).toContain('![图片](/api/workspaces/ws-1/attachments/att-1)'));
    expect(input.value.startsWith('看这张图')).toBe(true);
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  it('多图按粘贴顺序串行上传，顺序稳定', async () => {
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    paste(input, { files: [pngFile('a.png'), pngFile('b.png')] });

    await waitFor(() => expect(uploaded).toHaveLength(2));
    await waitFor(() => expect(input.value).toContain('attachments/att-2'));
    const firstAt = input.value.indexOf('attachments/att-1');
    const secondAt = input.value.indexOf('attachments/att-2');
    expect(firstAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it('超过 10 MiB：给「单张图片不能超过 10 MiB」且不上传', async () => {
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    paste(input, { files: [pngFile('big.png', 11 * 1024 * 1024)] });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('单张图片不能超过 10 MiB');
    expect(uploaded).toHaveLength(0);
  });

  it('非图片文件不接管粘贴（交给原生行为），也不上传', async () => {
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    paste(input, { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] });

    await new Promise((r) => setTimeout(r, 50));
    expect(uploaded).toHaveLength(0);
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  it('未选工作区时给可读提示，不发起上传', async () => {
    renderComposer(null);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    paste(input, { files: [pngFile()] });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('图片上传需要先选择工作区');
    expect(uploaded).toHaveLength(0);
  });

  it('上传失败：显示服务端中文原因，不静默丢', async () => {
    server.use(
      http.post('/api/workspaces/:ws/attachments', () =>
        HttpResponse.json({ error: { code: 'ATTACHMENT_TOO_LARGE', message: '附件过大，服务端拒绝' } }, { status: 413 }),
      ),
    );
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    paste(input, { files: [pngFile()] });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('附件过大，服务端拒绝');
    expect(input.value).not.toContain('![图片]');
  });
});

describe('用户气泡里的图片（CHAT-USER-IMAGE）', () => {
  it('图片上传中按 Enter 不会发出「无图消息」；上传完成后才能发送且消息带图', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/workspaces/:ws/attachments', async () => {
        await gate;
        return HttpResponse.json({
          id: 'att-slow',
          workspace_id: 'ws-1',
          mime_type: 'image/png',
          bytes: 1024,
          status: 'staged',
          expires_at: Date.now() + 60_000,
          download_url: '/api/workspaces/ws-1/attachments/att-slow',
        });
      }),
    );
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer('ws-1', onSend);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    paste(input, { files: [pngFile()] });
    await waitFor(() => expect(screen.getByTestId('composer-uploading')).toBeInTheDocument());
    // 用户手快：刚打完字就 Enter
    await userEvent.type(input, '看这张');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('composer-error')).toHaveTextContent('图片还在上传');
    expect(onSend).not.toHaveBeenCalled();

    // 放行上传 → markdown 落到输入框 → 再发送，消息里带图
    release();
    await waitFor(() => expect(input.value).toContain('![图片](/api/workspaces/ws-1/attachments/att-slow)'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toContain('![图片]');
  });
});
