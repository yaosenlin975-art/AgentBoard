/**
 * DETAIL-D6：描述编辑器图片入口（粘贴 / 拖拽 / 选择）与固定 URL 插入、失败可见、数量与格式拒绝。
 * 与评论共用 lib/imageDraft 的校验口径；这里只锁描述侧接线，不重复测评论链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Workspace } from '@agentboard/shared';
import { RightPanel } from '../components/right/RightPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    workspace_id: 'ws-1',
    title: '测试任务',
    description: '现有描述',
    priority: '中',
    labels: [],
    status: '待规划',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function mockApi(issue: Issue): void {
  server.use(
    http.get('/api/issues/iss-1', () => HttpResponse.json(issue)),
    http.get('/api/issues', () => HttpResponse.json([issue])),
    http.get('/api/issues/iss-1/comments', () => HttpResponse.json([])),
    http.get('/api/issues/iss-1/pending-attachments', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/issues/iss-1/dependencies', () =>
      HttpResponse.json({ blockers: [], blocked: [], related: [], duplicate: [] }),
    ),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
  );
}

function renderPanel(): void {
  usePanelStore.setState({ view: 'detail', issueId: 'iss-1', sessionId: null, rightOpen: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RightPanel />
    </QueryClientProvider>,
  );
}

/** 构造带文件的粘贴事件（jsdom 的 ClipboardEvent 不保留 clipboardData，这里直接挂属性） */
function pasteFiles(element: HTMLElement, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) },
  });
  fireEvent(element, event);
}

function dropFiles(element: HTMLElement, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  fireEvent(element, event);
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, rightOpen: false });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

function uploadHandler(): { uploads: File[] } {
  const uploads: File[] = [];
  server.use(http.post('/api/workspaces/ws-1/attachments', async ({ request }) => {
    uploads.push(new File([await request.arrayBuffer()], request.headers.get('x-file-name') ?? 'image.png'));
    return HttpResponse.json({
      id: `att-${uploads.length}`,
      workspace_id: 'ws-1',
      file_name: request.headers.get('x-file-name') ?? 'image.png',
      mime_type: 'image/png',
      size_bytes: png.length,
      status: 'staged',
      expires_at: Date.now() + 60_000,
      download_url: `/api/workspaces/ws-1/attachments/att-${uploads.length}`,
    }, { status: 201 });
  }));
  return { uploads };
}

async function openEditor(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId('desc-toggle'));
  return screen.getByTestId('desc-input');
}

describe('DETAIL-D6 描述图片入口', () => {
  it('粘贴截图：上传后用固定 URL 的 markdown 插到光标处，并随描述防抖 PATCH', async () => {
    const issue = makeIssue();
    mockApi(issue);
    const { uploads } = uploadHandler();
    const patches: Array<Record<string, unknown>> = [];
    server.use(http.patch('/api/issues/iss-1', async ({ request }) => {
      patches.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(issue);
    }));
    renderPanel();
    const textarea = await openEditor();

    pasteFiles(textarea, [new File([png], 'shot.png', { type: 'image/png' })]);

    await waitFor(() => expect((screen.getByTestId('desc-input') as HTMLTextAreaElement).value)
      .toContain('![shot.png](/api/workspaces/ws-1/attachments/att-1)'));
    expect(uploads).toHaveLength(1);
    await waitFor(() => expect(patches.some((body) => typeof body.description === 'string'
      && (body.description as string).includes('/api/workspaces/ws-1/attachments/att-1'))).toBe(true));
    expect(patches.every((body) => !('attachment_ids' in body))).toBe(true);
  });

  it('拖入文件同样触发上传并插入 markdown', async () => {
    const issue = makeIssue();
    mockApi(issue);
    const { uploads } = uploadHandler();
    renderPanel();
    const textarea = await openEditor();

    dropFiles(textarea, [new File([png], 'dropped.png', { type: 'image/png' })]);

    await waitFor(() => expect((screen.getByTestId('desc-input') as HTMLTextAreaElement).value)
      .toContain('![dropped.png](/api/workspaces/ws-1/attachments/att-1)'));
    expect(uploads).toHaveLength(1);
  });

  it('选择文件入口可用（粘贴为主、选择为辅）', async () => {
    const issue = makeIssue();
    mockApi(issue);
    const { uploads } = uploadHandler();
    renderPanel();
    await openEditor();

    await userEvent.upload(
      screen.getByTestId('desc-image-input'),
      new File([png], 'picked.png', { type: 'image/png' }),
    );

    await waitFor(() => expect((screen.getByTestId('desc-input') as HTMLTextAreaElement).value)
      .toContain('![picked.png](/api/workspaces/ws-1/attachments/att-1)'));
    expect(uploads).toHaveLength(1);
  });

  it('非图片被拒：给出可读拒绝，描述文本不变、不上传', async () => {
    const issue = makeIssue();
    mockApi(issue);
    const { uploads } = uploadHandler();
    renderPanel();
    const textarea = await openEditor();

    pasteFiles(textarea, [new File(['hello'], 'note.txt', { type: 'text/plain' })]);

    expect(await screen.findByTestId('desc-image-error')).toHaveTextContent('仅支持 PNG、JPEG 和 WebP 图片');
    expect(screen.getByTestId('desc-input')).toHaveValue('现有描述');
    expect(uploads).toHaveLength(0);
  });

  it('整条描述最多 5 张：第 6 张给出可读拒绝，最多上传 5 张', async () => {
    const issue = makeIssue();
    mockApi(issue);
    const { uploads } = uploadHandler();
    renderPanel();
    await openEditor();

    const files = Array.from({ length: 6 }, (_, index) => new File([png], `p${index}.png`, { type: 'image/png' }));
    await userEvent.upload(screen.getByTestId('desc-image-input'), files);

    expect(await screen.findByTestId('desc-image-error')).toHaveTextContent('每次最多添加 5 张图片');
    await waitFor(() => expect(uploads).toHaveLength(5));
  });

  it('上传失败：显示失败状态，且不把坏 markdown 写进描述', async () => {
    const issue = makeIssue();
    mockApi(issue);
    server.use(http.post('/api/workspaces/ws-1/attachments', () =>
      HttpResponse.json({ error: { code: 'TEMP', message: '上传暂时失败' } }, { status: 503 }),
    ));
    renderPanel();
    const textarea = await openEditor();

    pasteFiles(textarea, [new File([png], 'broken.png', { type: 'image/png' })]);

    expect(await screen.findByTestId('desc-image-error')).toHaveTextContent('上传暂时失败');
    expect(screen.getByTestId('desc-image-uploads')).toHaveTextContent('broken.png · 上传失败：上传暂时失败');
    expect(screen.getByTestId('desc-input')).toHaveValue('现有描述');
  });
});
