/**
 * CHAT-COMPOSER-V2：聊天输入框按截图重做的结构验收。
 * 覆盖：输入卡外壳 / 无麦克风按钮 / 空草稿发送禁用 / 附件预览条（文件名 + 类型 + 体积）/
 * 「＋」选图与粘贴共用同一条上传链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { Composer } from '../components/chat/Composer';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

function pngFile(name = 'shot.png'): File {
  return new File([new Uint8Array(1024)], name, { type: 'image/png' });
}

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
  usePanelStore.setState({ chatDrafts: {}, chatAttachments: {} });
  server.use(
    http.post('/api/workspaces/:ws/attachments', async ({ request, params }) => {
      const mime = request.headers.get('Content-Type') ?? 'image/png';
      return HttpResponse.json({
        id: 'att-1',
        workspace_id: String(params.ws),
        file_name: request.headers.get('X-File-Name') ?? 'image.png',
        mime_type: mime,
        size_bytes: 1024,
        status: 'staged',
        expires_at: Date.now() + 60_000,
        download_url: `/api/workspaces/${params.ws}/attachments/att-1`,
      });
    }),
    http.get('/api/skills', () => HttpResponse.json([])),
    http.get('/api/issues', () => HttpResponse.json([])),
  );
});

describe('聊天输入框结构（CHAT-COMPOSER-V2）', () => {
  it('渲染输入卡外壳、文本区、「＋」与圆形发送按钮，且不渲染麦克风按钮', () => {
    renderComposer();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.getByTestId('composer-shell')).toBeInTheDocument();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    expect(screen.getByTestId('composer-attach')).toBeInTheDocument();
    expect(screen.getByTestId('composer-send')).toBeInTheDocument();
    // 麦克风按钮不显示：输入区内没有任何语音相关按钮/提示
    expect(screen.queryByRole('button', { name: /语音|麦克风/ })).toBeNull();
    expect(screen.queryByTestId('voice-hint')).toBeNull();
  });

  it('空草稿发送禁用，输入文本后可用', async () => {
    renderComposer();
    const send = screen.getByTestId('composer-send');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByTestId('composer-input'), '你好');
    expect(send).toBeEnabled();
  });

  it('粘贴图片后显示附件预览条（文件名 + 类型 · 体积），正文保持干净不插 markdown', async () => {
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    const file = pngFile();
    const clipboard = {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      files: [file],
      types: ['Files'],
      getData: () => '',
    };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard });
    input.dispatchEvent(event);

    const chip = await screen.findByTestId('composer-attachment');
    expect(chip).toHaveTextContent('shot.png');
    expect(chip).toHaveTextContent('image/png · 1.0 KB');
    // CHAT-ATTACH-STATE：附件卡是独立状态，正文不再出现 ![图片](...) 纯文本
    expect(input.value).not.toContain('![图片]');
    expect(input.value).toBe('');
  });

  it('「＋」选图走上传链路并生成附件预览条', async () => {
    renderComposer();
    const picker = screen.getByTestId('composer-file-input') as HTMLInputElement;
    // CHAT-ATTACH-ANY：不再限制 accept，任何文件类型都可选
    expect(picker.getAttribute('accept')).toBeNull();
    fireEvent.change(picker, { target: { files: [pngFile('picked.png')] } });

    const chip = await screen.findByTestId('composer-attachment');
    expect(chip).toHaveTextContent('picked.png');
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.value).not.toContain('/api/workspaces/ws-1/attachments/att-1');
  });
});
