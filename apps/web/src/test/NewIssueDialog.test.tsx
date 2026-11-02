import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { NewIssueDialog } from '../components/topbar/NewIssueDialog';
import { server } from './server';

/** NEW-ISSUE-IMAGE：选择 / 拖拽 / 粘贴三入口同一上传流程；提交只传附件 id；失败保留草稿并复用幂等键。 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

interface UploadCall { contentType: string | null; bytes: number; workspaceId: string }
interface IssueCall { body: Record<string, unknown>; idempotencyKey: string | null }

let uploads: UploadCall[];
let issueCalls: IssueCall[];
let uploadSeq: number;

function stagedResponse(id: string) {
  return {
    id,
    workspace_id: 'ws-1',
    file_name: 'shot.png',
    mime_type: 'image/png',
    size_bytes: PNG.length,
    status: 'staged',
    expires_at: Date.now() + 60_000,
    download_url: `/api/workspaces/ws-1/attachments/${id}`,
  };
}

function setupHandlers(issueStatuses: number[] = [200]) {
  uploads = [];
  issueCalls = [];
  uploadSeq = 0;
  server.use(
    http.post('/api/workspaces/:workspaceId/attachments', async ({ request, params }) => {
      const bytes = (await request.arrayBuffer()).byteLength;
      uploads.push({
        contentType: request.headers.get('content-type'),
        bytes,
        workspaceId: String(params.workspaceId),
      });
      uploadSeq += 1;
      return HttpResponse.json(stagedResponse(`att-${uploadSeq}`), { status: 201 });
    }),
    http.post('/api/issues', async ({ request }) => {
      issueCalls.push({
        body: (await request.json()) as Record<string, unknown>,
        idempotencyKey: request.headers.get('Idempotency-Key'),
      });
      const status = issueStatuses[Math.min(issueCalls.length - 1, issueStatuses.length - 1)];
      if (status !== 200) {
        return HttpResponse.json({ error: { code: 'INTERNAL', message: '创建失败（模拟）' } }, { status });
      }
      return HttpResponse.json({
        id: 'iss-new',
        workspace_id: 'ws-1',
        title: 'x',
        description: '',
        priority: '中',
        labels: [],
        status: '待规划',
        sort_order: 0,
        parent_issue_id: null,
        claimed_by: null,
        claimed_at: null,
        session_id: null,
        comment_count: 1,
        created_at: 1,
        updated_at: 1,
      });
    }),
    http.get('/api/issues', () => HttpResponse.json([])),
  );
}

function renderDialog(workspaceId = 'ws-1', onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open workspaceId={workspaceId} onClose={onClose} />
    </QueryClientProvider>,
  );
  const rerenderWith = (nextWorkspaceId: string) => {
    view.rerender(
      <QueryClientProvider client={qc}>
        <NewIssueDialog open workspaceId={nextWorkspaceId} onClose={onClose} />
      </QueryClientProvider>,
    );
  };
  return { ...view, onClose, rerenderWith };
}

function pngFile(name = 'shot.png', type = 'image/png', bytes = PNG): File {
  return new File([bytes], name, { type });
}

const pasteImage = (file: File): void => {
  fireEvent.paste(screen.getByTestId('new-issue-description'), {
    clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] },
  });
};

const dropImage = (file: File): void => {
  fireEvent.drop(screen.getByTestId('new-issue-dropzone'), { dataTransfer: { files: [file] } });
};

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('新建任务附图', () => {
  it('粘贴图片：进同一上传流程，预览显示已上传，提交只传附件 id 不传 base64', async () => {
    setupHandlers();
    const { onClose } = renderDialog();

    pasteImage(pngFile());
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({ contentType: 'image/png', workspaceId: 'ws-1', bytes: PNG.length });
    expect(await screen.findByText('已上传')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('new-issue-title'), '粘贴图任务');
    await userEvent.type(screen.getByTestId('new-issue-description'), '描述文本');
    await userEvent.click(screen.getByTestId('new-issue-submit'));

    await waitFor(() => expect(issueCalls).toHaveLength(1));
    expect(issueCalls[0]!.body).toMatchObject({
      workspace_id: 'ws-1',
      title: '粘贴图任务',
      description: '描述文本',
      attachment_ids: ['att-1'],
    });
    expect(JSON.stringify(issueCalls[0]!.body)).not.toContain('data:image');
    expect(issueCalls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('拖拽与文件选择走同一流程', async () => {
    setupHandlers();
    renderDialog();

    dropImage(pngFile('dropped.png'));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await screen.findByText('已上传');

    await userEvent.upload(screen.getByTestId('new-issue-image-input'), pngFile('picked.png'));
    await waitFor(() => expect(uploads).toHaveLength(2));
    expect(screen.getAllByText('已上传')).toHaveLength(2);
  });

  it('非法格式与超限：给出与评论一致的拒绝文案，且不上传', async () => {
    setupHandlers();
    renderDialog();

    dropImage(pngFile('bad.gif', 'image/gif'));
    expect(await screen.findByTestId('new-issue-error')).toHaveTextContent('仅支持 PNG、JPEG 和 WebP 图片');
    expect(uploads).toHaveLength(0);

    const huge = pngFile('huge.png');
    Object.defineProperty(huge, 'size', { value: 10 * 1024 * 1024 + 1 });
    dropImage(huge);
    expect(await screen.findByTestId('new-issue-error')).toHaveTextContent('单张图片不能超过 10 MiB');
    expect(uploads).toHaveLength(0);
  });

  it('创建失败保留标题、描述与图片草稿；重试复用同一幂等键只提交一次成功', async () => {
    setupHandlers([500, 200]);
    const { onClose } = renderDialog();

    pasteImage(pngFile());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await userEvent.type(screen.getByTestId('new-issue-title'), '失败重试任务');
    await userEvent.type(screen.getByTestId('new-issue-description'), '保留描述');

    await userEvent.click(screen.getByTestId('new-issue-submit'));
    expect(await screen.findByTestId('new-issue-error')).toHaveTextContent('创建失败（模拟）');
    expect(screen.getByTestId('new-issue-title')).toHaveValue('失败重试任务');
    expect(screen.getByTestId('new-issue-description')).toHaveValue('保留描述');
    expect(screen.getByText('已上传')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('new-issue-submit'));
    await waitFor(() => expect(issueCalls).toHaveLength(2));
    expect(issueCalls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(issueCalls[1]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(issueCalls[1]!.idempotencyKey).toBe(issueCalls[0]!.idempotencyKey);
    expect(issueCalls[1]!.body.attachment_ids).toEqual(['att-1']);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('移除草稿后不再提交该附件，并回收预览 URL', async () => {
    setupHandlers();
    renderDialog();

    pasteImage(pngFile());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await userEvent.type(screen.getByTestId('new-issue-title'), '删除草稿');
    await userEvent.click(screen.getByRole('button', { name: '移除图片 shot.png' }));
    expect(screen.queryByText('已上传')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');

    await userEvent.click(screen.getByTestId('new-issue-submit'));
    await waitFor(() => expect(issueCalls).toHaveLength(1));
    expect(issueCalls[0]!.body.attachment_ids).toEqual([]);
  });

  it('切换 workspace 后图片草稿清空，不跨空间引用', async () => {
    setupHandlers();
    const { rerenderWith } = renderDialog('ws-1');

    pasteImage(pngFile());
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(screen.getByText('已上传')).toBeInTheDocument();

    rerenderWith('ws-2');
    await waitFor(() => expect(screen.queryByText('已上传')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('上传未完成或失败时禁止提交', async () => {
    setupHandlers();
    // 让上传一直挂起
    server.use(http.post('/api/workspaces/:workspaceId/attachments', () => new Promise(() => {}), { once: true }));
    renderDialog();

    pasteImage(pngFile());
    await screen.findByText('上传中…');
    expect(screen.getByTestId('new-issue-submit')).toBeDisabled();

    await userEvent.type(screen.getByTestId('new-issue-title'), '等待上传');
    expect(screen.getByTestId('new-issue-submit')).toBeDisabled();
  });

  it('上传失败可重试，成功后才允许提交', async () => {
    setupHandlers();
    let attempt = 0;
    server.use(
      http.post('/api/workspaces/:workspaceId/attachments', async ({ request, params }) => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json({ error: { code: 'ATTACHMENT_INVALID_IMAGE', message: '图片格式与文件签名不匹配' } }, { status: 400 });
        }
        const bytes = (await request.arrayBuffer()).byteLength;
        uploads.push({ contentType: request.headers.get('content-type'), bytes, workspaceId: String(params.workspaceId) });
        return HttpResponse.json(stagedResponse('att-retry'), { status: 201 });
      }),
    );
    renderDialog();

    pasteImage(pngFile());
    expect(await screen.findByText('上传失败')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('new-issue-title'), '重试上传');
    expect(screen.getByTestId('new-issue-submit')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '重试上传 shot.png' }));
    await waitFor(() => expect(screen.getByText('已上传')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('new-issue-submit')).not.toBeDisabled());
  });
});
