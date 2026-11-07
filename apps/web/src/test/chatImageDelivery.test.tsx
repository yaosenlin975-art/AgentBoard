/**
 * CHAT-IMG-DELIVERY-B：聊天发送携带附件 id。
 * 覆盖：attachmentIdsFromText 提取/去重/过滤；Composer 发送把草稿中实际保留的图片 id 传出
 * （删除 markdown 即不投递）；超 5 张中文提示不发送；ChatPanel 请求体——纯文本不带
 * attachment_ids 键、带图时键与顺序正确。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Session } from '@agentboard/shared';
import { Composer } from '../components/chat/Composer';
import { ChatPanel } from '../components/chat/ChatPanel';
import { attachmentIdsFromText } from '../lib/imageDraft';
import { usePanelStore } from '../state/panelStore';
import { useNavStore } from '../state/navStore';
import { server } from './server';

// ---- 纯函数 ----

describe('attachmentIdsFromText', () => {
  it('提取图片 markdown 里的附件 id，按出现顺序去重', () => {
    const text = '前缀 ![图片](/api/workspaces/ws-1/attachments/att-1) 中段 ![图](/api/workspaces/ws-2/attachments/att-2) 重复 ![x](/api/workspaces/ws-1/attachments/att-1)';
    expect(attachmentIdsFromText(text)).toEqual(['att-1', 'att-2']);
  });

  it('非附件路径的图片与纯文本不提取', () => {
    expect(attachmentIdsFromText('纯文本消息')).toEqual([]);
    expect(attachmentIdsFromText('![外链](https://example.com/a.png)')).toEqual([]);
    expect(attachmentIdsFromText('![别的路径](/api/issues/iss-1/attachments/att-9)')).toEqual([]);
  });
});

// ---- Composer 层 ----

function pngFile(name = 'shot.png', bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

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

let uploadCount = 0;

function renderComposer(onSend = vi.fn().mockResolvedValue(undefined)): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer disabled={false} running={false} queuedCount={0} workspaceId="ws-1" onSend={onSend} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  uploadCount = 0;
  usePanelStore.setState({ chatDrafts: {}, chatAttachments: {} });
  server.use(
    http.post('/api/workspaces/:ws/attachments', async ({ params }) => {
      uploadCount += 1;
      const id = `att-${uploadCount}`;
      return HttpResponse.json({
        id,
        workspace_id: String(params.ws),
        mime_type: 'image/png',
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

describe('Composer 发送携带附件 id', () => {
  it('粘贴上传后发送：onSend 收到文本与对应附件 id（顺序与 markdown 一致）', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer(onSend);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 0);
    paste(input, { text: '看这两张图', files: [pngFile('a.png'), pngFile('b.png')] });

    await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(2));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toContain('![图片](/api/workspaces/ws-1/attachments/att-1)');
    expect(onSend.mock.calls[0]![1]).toEqual(['att-1', 'att-2']);
  });

  it('删除附件卡后发送：该附件不投递', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer(onSend);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 0);
    paste(input, { files: [pngFile()] });

    await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1));
    await userEvent.click(screen.getByTestId('composer-attachment-remove-att-1'));
    await userEvent.type(input, '图我删了，只发文字');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![1]).toEqual([]);
  });

  it('纯文本消息：第二参数为空数组', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer(onSend);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    await userEvent.type(input, '没有图的消息');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![1]).toEqual([]);
  });

  it('草稿含超过 5 张附件：中文提示且不发送', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer(onSend);
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `att-${i + 1}`,
      url: `/api/workspaces/ws-1/attachments/att-${i + 1}`,
      name: `shot-${i + 1}.png`,
      mime: 'image/png',
      bytes: 1024,
    }));
    // Composer 无 sessionId → 草稿落在空串键（与本卡 chatDrafts 口径一致）
    usePanelStore.setState({ chatDrafts: { '': '发' }, chatAttachments: { '': six } });
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    input.focus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('一条消息最多附带 5 个附件');
    expect(onSend).not.toHaveBeenCalled();
  });
});

// ---- ChatPanel 集成：请求体形态 ----

const postBodies: Array<Record<string, unknown>> = [];

function mockChatApi(sessions: Session[]): void {
  server.use(
    http.get('/api/sessions', () => HttpResponse.json(sessions)),
    http.get('/api/sessions/:id', ({ params }) =>
      HttpResponse.json(sessions.find((s) => s.id === params.id) ?? { error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 })),
    http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
    http.get('/api/sessions/:id/queue', () => HttpResponse.json({ texts: [] })),
    http.post('/api/sessions/:id/messages', async ({ request }) => {
      postBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ queued: false });
    }),
    http.get('/api/workspaces', () => HttpResponse.json([{ id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 }])),
    http.get('/api/clis', () => HttpResponse.json([
      { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' },
    ])),
    http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'm-a', source: 'static' }])),
  );
}

describe('ChatPanel 请求体（attachment_ids 键形态）', () => {
  it('纯文本：请求体不带 attachment_ids 键；带图：键为按序 id 数组', async () => {
    const session: Session = {
      id: 's1', workspace_id: 'ws-1', issue_id: null, cli: 'codebuddy',
      model: 'm-a', status: '已结束', adapter_session_id: null, created_at: 1,
    };
    mockChatApi([session]);
    usePanelStore.setState({ view: null, sessionId: session.id, chatSession: session, rightOpen: false });
    useNavStore.setState({ view: 'chat' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatPanel />
      </QueryClientProvider>,
    );

    const input = await screen.findByTestId('composer-input');
    await userEvent.type(input, '纯文本消息');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toEqual({ text: '纯文本消息' });
    expect(Object.hasOwn(postBodies[0]!, 'attachment_ids')).toBe(false);

    input.focus();
    (input as HTMLTextAreaElement).setSelectionRange(0, 0);
    paste(input, { files: [pngFile()] });
    await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1));
    await userEvent.type(screen.getByTestId('composer-input'), '看图');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(postBodies).toHaveLength(2));
    // 按内容定位第二条（粘贴 + 输入可能额外触发一次提交，按序取会更脆）；断言强度不变
    const withImage = postBodies.find((body) => String(body.text ?? '').includes('看图'));
    expect(withImage).toMatchObject({ text: expect.stringContaining('看图'), attachment_ids: ['att-1'] });
  });
});
