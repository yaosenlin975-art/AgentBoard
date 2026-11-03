/**
 * KB-IMG-2：客户端压缩规则 + 图片编辑区（粘贴/拖拽/按钮 → 压缩 → 上传 → 光标处插入）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { KnowledgeImageComposer } from '../components/knowledge/KnowledgeImageComposer';
import {
  IMAGE_COMPRESS_TARGET_EDGE,
  formatBytes,
  needsCompression,
  pickMimeType,
  scaleToFit,
} from '../lib/imageCompress';

const compressMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../lib/imageCompress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/imageCompress')>();
  return { ...actual, compressImage: compressMock.fn };
});

const MB = 1024 * 1024;

describe('压缩规则（纯函数）', () => {
  it('needsCompression：>5MiB 或最长边 >5000px 才压缩', () => {
    expect(needsCompression({ bytes: 4 * MB, width: 4000, height: 3000 })).toBe(false);
    expect(needsCompression({ bytes: 6 * MB, width: 800, height: 600 })).toBe(true);
    expect(needsCompression({ bytes: 1 * MB, width: 5001, height: 100 })).toBe(true);
    expect(needsCompression({ bytes: 1 * MB, width: 5000, height: 5000 })).toBe(false);
  });

  it('scaleToFit：最长边缩到 3000，等比且不放大', () => {
    expect(IMAGE_COMPRESS_TARGET_EDGE).toBe(3000);
    expect(scaleToFit(6000, 4000)).toEqual({ width: 3000, height: 2000 });
    expect(scaleToFit(4000, 6000)).toEqual({ width: 2000, height: 3000 });
    expect(scaleToFit(1200, 800)).toEqual({ width: 1200, height: 800 });
  });

  it('pickMimeType：透明优先 PNG；否则 webp，不支持回落 jpeg', () => {
    expect(pickMimeType('image/png', true, true)).toBe('image/png');
    expect(pickMimeType('image/png', false, true)).toBe('image/webp');
    expect(pickMimeType('image/jpeg', false, false)).toBe('image/jpeg');
  });

  it('formatBytes：KB / MB 可读化', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(320 * 1024)).toBe('320KB');
    expect(formatBytes(7.2 * MB)).toBe('7.2MB');
  });
});

function mount(value = '第一行\n第二行', onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeImageComposer scope="workspace" workspaceId="A" pageId="p1" value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('图片编辑区（KB-IMG-2）', () => {
  beforeEach(() => {
    compressMock.fn.mockReset();
  });

  it('按钮上传：压缩后显示「原始 7.2MB → 3.1MB」并在光标处插入 Markdown', async () => {
    compressMock.fn.mockResolvedValue({
      blob: new Blob(['x'], { type: 'image/webp' }),
      beforeBytes: 7.2 * MB,
      afterBytes: 3.1 * MB,
      width: 3000,
      height: 2000,
      mime: 'image/webp',
      skipped: false,
    });
    server.use(
      http.post('/api/knowledge/pages/p1/images', () =>
        HttpResponse.json({ id: 'img1', url: '/api/knowledge/images/img1', bytes: 3.1 * MB, width: 3000, height: 2000 }),
      ),
    );
    const onChange = mount();
    const textarea = screen.getByTestId('knowledge-body-editor') as HTMLTextAreaElement;
    // 光标放到「第一行」末尾（位置 3）
    textarea.setSelectionRange(3, 3);
    const file = new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('knowledge-image-input'), { target: { files: [file] } });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const inserted = onChange.mock.calls.at(-1)?.[0] as string;
    // KB-IMG-3：正文图片 GET 依赖 query 里的 scope/workspace_id，插入时必须带上，否则正文渲染必然回落占位。
    expect(inserted).toContain('![shot](/api/knowledge/images/img1?scope=workspace&workspace_id=A)');
    expect(inserted.startsWith('第一行\n![shot]')).toBe(true);
    const status = await screen.findByTestId('knowledge-image-status');
    expect(status).toHaveTextContent('7.2MB → 3.1MB');
  });

  it('粘贴图片走同一路径', async () => {
    compressMock.fn.mockResolvedValue({
      blob: new Blob(['x'], { type: 'image/webp' }),
      beforeBytes: 2 * MB,
      afterBytes: 1 * MB,
      width: 800,
      height: 600,
      mime: 'image/webp',
      skipped: false,
    });
    server.use(http.post('/api/knowledge/pages/p1/images', () => HttpResponse.json({ id: 'img2', url: '/api/knowledge/images/img2', bytes: 1 * MB, width: 800, height: 600 })));
    const onChange = mount('正文');
    const textarea = screen.getByTestId('knowledge-body-editor');
    const file = new File([new Uint8Array(10)], 'paste.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining('/api/knowledge/images/img2')));
  });

  it('拖拽图片走同一路径', async () => {
    compressMock.fn.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/webp' }), beforeBytes: MB, afterBytes: MB / 2, width: 100, height: 100, mime: 'image/webp', skipped: false });
    server.use(http.post('/api/knowledge/pages/p1/images', () => HttpResponse.json({ id: 'img3', url: '/api/knowledge/images/img3', bytes: MB / 2, width: 100, height: 100 })));
    const onChange = mount('拖拽前');
    const zone = screen.getByTestId('knowledge-image-composer');
    fireEvent.drop(zone, { dataTransfer: { files: [new File([new Uint8Array(5)], 'drop.png', { type: 'image/png' })] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining('/api/knowledge/images/img3')));
  });

  it('压缩后仍 >5MiB → 中止并给明确中文原因（不发上传请求）', async () => {
    const posted = vi.fn();
    server.use(http.post('/api/knowledge/pages/p1/images', () => { posted(); return HttpResponse.json({ id: 'x', url: '/u', bytes: 1, width: 1, height: 1 }); }));
    compressMock.fn.mockResolvedValue({ blob: new Blob(['x']), beforeBytes: 9 * MB, afterBytes: 6 * MB, width: 3000, height: 2000, mime: 'image/webp', skipped: false });
    mount();
    fireEvent.change(screen.getByTestId('knowledge-image-input'), { target: { files: [new File([new Uint8Array(9 * MB)], 'huge.png', { type: 'image/png' })] } });
    const alert = await screen.findByTestId('knowledge-image-error');
    expect(alert).toHaveTextContent('超过 5MB 上限');
    expect(posted).not.toHaveBeenCalled();
  });

  it('非图片类型 → 直接拒绝（不压缩不上传）', async () => {
    mount();
    fireEvent.change(screen.getByTestId('knowledge-image-input'), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(await screen.findByTestId('knowledge-image-error')).toHaveTextContent('不是受支持的图片格式');
    expect(compressMock.fn).not.toHaveBeenCalled();
  });

  it('服务端 413/415/409 → 对应中文原因', async () => {
    compressMock.fn.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/webp' }), beforeBytes: MB, afterBytes: MB / 2, width: 10, height: 10, mime: 'image/webp', skipped: false });
    const cases: Array<[string, string]> = [
      ['IMAGE_TOO_LARGE', '超过 5MB 上限'],
      ['IMAGE_TYPE_UNSUPPORTED', '不是受支持的图片格式'],
      ['IMAGE_LIMIT_EXCEEDED', '本页图片数量或总量已到上限'],
    ];
    for (const [code, expected] of cases) {
      server.use(http.post('/api/knowledge/pages/p1/images', () => HttpResponse.json({ error: { code, message: code } }, { status: code === 'IMAGE_TOO_LARGE' ? 413 : code === 'IMAGE_TYPE_UNSUPPORTED' ? 415 : 409 })));
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
          <KnowledgeImageComposer scope="workspace" workspaceId="A" pageId="p1" value="" onChange={vi.fn()} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByTestId('knowledge-image-input'), { target: { files: [new File([new Uint8Array(5)], 'x.png', { type: 'image/png' })] } });
      expect(await screen.findByTestId('knowledge-image-error')).toHaveTextContent(expected);
      unmount();
    }
  });
});
