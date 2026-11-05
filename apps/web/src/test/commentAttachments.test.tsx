import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueComment } from '@agentboard/shared';
import { CommentThread } from '../components/detail/CommentThread';
import { server } from './server';

const issue: Issue = {
  id: 'iss-1', workspace_id: 'ws-1', title: 'Task', description: '', priority: '中', labels: [],
  status: '待规划', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 1,
};

function renderThread() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><CommentThread issue={issue} /></QueryClientProvider>);
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const staged = (id: string, fileName: string) => ({
  id, workspace_id: 'ws-1', file_name: fileName, mime_type: 'image/png', size_bytes: png.length,
  status: 'staged', expires_at: Date.now() + 60_000, download_url: `/api/workspaces/ws-1/attachments/${id}`,
});

beforeEach(() => {
  let sequence = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:preview-${++sequence}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  server.use(http.get('/api/issues/iss-1/comments', () => HttpResponse.json([])));
});

describe('CommentThread 图片附件', () => {
  it('刷新后显示图片投递未知状态和手动重试提示', async () => {
    server.use(http.get('/api/issues/iss-1/comments', () => HttpResponse.json([{
      id: 'c-unknown', issue_id: 'iss-1', author: 'user', content: '请查看图片', ts: 2,
      attachments: [{
        id: 'att-unknown', file_name: 'proof.png', mime_type: 'image/png', size_bytes: png.length,
        url: '/api/issues/iss-1/attachments/att-unknown', delivery_state: 'unknown',
      }],
    }])));

    renderThread();

    expect(await screen.findByText(/图片投递结果未知.*保持未读.*手动重试/)).toBeInTheDocument();
  });

  it('文件选择后上传 raw 图片，并允许纯图片评论；刷新后显示受控附件 URL', async () => {
    let uploadHeaders: Headers | undefined;
    let uploadedBytes: number[] = [];
    let posted: unknown;
    const comments: IssueComment[] = [];
    server.use(
      http.post('/api/workspaces/ws-1/attachments', async ({ request }) => {
        uploadHeaders = request.headers;
        uploadedBytes = [...new Uint8Array(await request.arrayBuffer())];
        return HttpResponse.json(staged('att-1', 'proof.png'), { status: 201 });
      }),
      http.post('/api/issues/iss-1/comments', async ({ request }) => {
        posted = await request.json();
        const comment: IssueComment = {
          id: 'c-image', issue_id: 'iss-1', author: 'user', content: '', ts: 2,
          attachments: [{ id: 'att-1', file_name: 'proof.png', mime_type: 'image/png', size_bytes: png.length, url: '/api/issues/iss-1/attachments/att-1' }],
        };
        comments.push(comment);
        return HttpResponse.json({ comment, woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' });
      }),
      http.get('/api/issues/iss-1/comments', () => HttpResponse.json(comments)),
    );

    renderThread();
    const file = new File([png], 'proof.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('comment-image-input'), file);
    expect(await screen.findByText('已上传')).toBeInTheDocument();
    expect(screen.getByAltText('proof.png')).toHaveAttribute('src', expect.stringContaining('blob:'));
    await userEvent.click(screen.getByTestId('comment-send'));

    await waitFor(() => expect(posted).toEqual({ content: '', workspace_id: 'ws-1', attachment_ids: ['att-1'] }));
    expect(uploadHeaders?.get('content-type')).toBe('image/png');
    expect(uploadedBytes).toEqual([...png]);
    expect(await screen.findByText(/图片已保存.*投递能力未验证/)).toBeInTheDocument();
    const historyImage = await screen.findByAltText('proof.png');
    expect(historyImage).toHaveAttribute('src', '/api/issues/iss-1/attachments/att-1');
    expect(historyImage.getAttribute('src')).not.toMatch(/storage|[A-Z]:\\/i);
  });

  it('剪贴板与拖放图片进入同一附件列表', async () => {
    const uploaded: string[] = [];
    server.use(http.post('/api/workspaces/ws-1/attachments', async ({ request }) => {
      const id = `att-${uploaded.length + 1}`;
      uploaded.push(request.headers.get('x-file-name') ?? id);
      return HttpResponse.json(staged(id, uploaded.at(-1)!), { status: 201 });
    }));
    renderThread();
    const clipboardFile = new File([png], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('comment-input'), {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => clipboardFile }] },
    });
    const droppedFile = new File([png], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('comment-dropzone'), { dataTransfer: { files: [droppedFile] } });

    expect(await screen.findByAltText('clipboard.png')).toBeInTheDocument();
    expect(await screen.findByAltText('dropped.png')).toBeInTheDocument();
    await waitFor(() => expect(uploaded).toHaveLength(2));
  });

  it('拒绝不支持的类型和超过 10 MiB 的文件，不发起上传', async () => {
    let uploads = 0;
    server.use(http.post('/api/workspaces/ws-1/attachments', () => {
      uploads++;
      return HttpResponse.json(staged('att', 'x.png'), { status: 201 });
    }));
    renderThread();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByTestId('comment-image-input'), new File(['text'], 'note.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/PNG.*JPEG.*WebP/);
    await user.upload(screen.getByTestId('comment-image-input'), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/10 MiB/);
    expect(uploads).toBe(0);
  });

  it('单条评论最多保留 5 张；可移除已上传的草稿图片', async () => {
    let uploads = 0;
    server.use(http.post('/api/workspaces/ws-1/attachments', async ({ request }) => {
      uploads++;
      const fileName = request.headers.get('x-file-name') ?? 'image.png';
      return HttpResponse.json(staged(`att-${uploads}`, fileName), { status: 201 });
    }));
    renderThread();
    const user = userEvent.setup();
    const files = Array.from({ length: 6 }, (_, index) => new File([png], `photo-${index}.png`, { type: 'image/png' }));
    await user.upload(screen.getByTestId('comment-image-input'), files);

    expect(await screen.findByRole('alert')).toHaveTextContent('每条评论最多添加 5 张图片');
    await waitFor(() => expect(uploads).toBe(5));
    expect(screen.getAllByRole('img')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: '移除图片 photo-0.png' }));
    expect(screen.queryByAltText('photo-0.png')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(4);
  });

  it('键盘顺序跳过视觉隐藏的文件输入并可激活添加图片按钮', async () => {
    renderThread();
    const user = userEvent.setup();
    const input = screen.getByTestId('comment-image-input');
    const clickInput = vi.spyOn(input, 'click');
    await user.tab();
    expect(screen.getByTestId('comment-input')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('comment-image-picker')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(clickInput).toHaveBeenCalledOnce();
  });

  it('上传失败可重试；评论提交失败时正文与附件草稿仍在，再提交成功', async () => {
    let uploadAttempts = 0;
    const posts: unknown[] = [];
    server.use(
      http.post('/api/workspaces/ws-1/attachments', () => {
        uploadAttempts++;
        return uploadAttempts === 1
          ? HttpResponse.json({ error: { code: 'TEMP', message: '上传暂时失败' } }, { status: 503 })
          : HttpResponse.json(staged('att-1', 'proof.png'), { status: 201 });
      }),
      http.post('/api/issues/iss-1/comments', async ({ request }) => {
        posts.push(await request.json());
        return posts.length === 1
          ? HttpResponse.json({ error: { code: 'TEMP', message: '提交暂时失败' } }, { status: 503 })
          : HttpResponse.json({ comment: { id: 'c-1', issue_id: 'iss-1', author: 'user', content: '保留文字', ts: 3 }, woke: false });
      }),
    );
    renderThread();
    await userEvent.type(screen.getByTestId('comment-input'), '保留文字');
    await userEvent.upload(screen.getByTestId('comment-image-input'), new File([png], 'proof.png', { type: 'image/png' }));
    expect(await screen.findByText('上传暂时失败')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试上传 proof.png' }));
    expect(await screen.findByText('已上传')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('comment-send'));
    expect(await screen.findByText('提交暂时失败')).toBeInTheDocument();
    expect(screen.getByTestId('comment-input')).toHaveValue('保留文字');
    expect(screen.getByAltText('proof.png')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('comment-send'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { content: '保留文字', workspace_id: 'ws-1', attachment_ids: ['att-1'] },
      { content: '保留文字', workspace_id: 'ws-1', attachment_ids: ['att-1'] },
    ]);
    expect(uploadAttempts).toBe(2);
  });
});

describe('DETAIL-D6 评论图片统一灯箱', () => {
  function mockCommentImage(): void {
    server.use(http.get('/api/issues/iss-1/comments', () => HttpResponse.json([{
      id: 'c-img', issue_id: 'iss-1', author: 'user', content: '看截图', ts: 2,
      attachments: [{
        id: 'att-img', file_name: 'shot.png', mime_type: 'image/png', size_bytes: png.length,
        url: '/api/workspaces/ws-1/attachments/att-img', delivery_state: 'delivered',
      }],
    }])));
  }

  it('点击评论图打开灯箱；Esc 关闭并把焦点还给原图', async () => {
    mockCommentImage();
    renderThread();
    const trigger = await screen.findByTestId('comment-attachment-button-att-img');
    await userEvent.click(trigger);
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
    expect(screen.getByTestId('image-lightbox-caption')).toHaveTextContent('shot.png');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('点击遮罩关闭灯箱；图片加载失败时保留同款占位，不留破图', async () => {
    mockCommentImage();
    renderThread();
    await userEvent.click(await screen.findByTestId('comment-attachment-button-att-img'));
    fireEvent.mouseDown(screen.getByTestId('image-lightbox'));
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();

    fireEvent.error(screen.getByAltText('shot.png'));
    expect(screen.getByTestId('comment-attachment-fallback-att-img')).toHaveTextContent('shot.png（加载失败）');
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
  });
});
