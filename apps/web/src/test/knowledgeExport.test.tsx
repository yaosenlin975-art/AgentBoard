import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { KnowledgePageDetail } from '../components/knowledge/KnowledgePageDetail';
import { buildKnowledgeMarkdown, downloadKnowledgeMarkdown, sanitizeExportFilename } from '../lib/knowledgeExport';
import type { KnowledgePage } from '@agentboard/shared';

const page: KnowledgePage = {
  id: 'p-1234abcd-5678',
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'cache-policy',
  title: '缓存策略',
  body_md: '- 缓存分层与失效\n- 预热成本',
  revision: 3,
  status: 'active',
  expires_at: null,
  sources: [
    { source_id: 's1', source_type: 'file', locator: 'apps/web/src/lib/cache.ts', captured_at: 1793600000000, content_hash: 'a'.repeat(64) },
  ],
  evidence: [{ source_id: 's1', locator: 'apps/web/src/lib/cache.ts', snapshot: 'export const cache = new Map();' }],
  created_by: 'agentboard-chat',
  updated_by: 'agentboard-chat',
  created_at: 1793500000000,
  updated_at: 1793600000000,
};

// jsdom 未实现 Blob URL API：装最小桩，按用例 spy
beforeEach(() => {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:stub'), writable: true, configurable: true });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true });
  }
});

describe('knowledgeExport（文件名净化 / 内容拼装 / 下载）', () => {
  it('文件名净化：非法字符与控制字符替换为 -，折叠连续 -，去掉首尾', () => {
    expect(sanitizeExportFilename('缓存/策略: 失效*?', 'p-1')).toBe('缓存-策略-失效');
    expect(sanitizeExportFilename('a\\b:c*d?e"f<g>h|i', 'p-1')).toBe('a-b-c-d-e-f-g-h-i');
    expect(sanitizeExportFilename('  含\u0007控制\u001f字符  ', 'p-1')).toBe('含-控制-字符');
    expect(sanitizeExportFilename('---多重---横线---', 'p-1')).toBe('多重-横线');
  });

  it('文件名净化：超长标题按 80 字符截断且不留尾部横线', () => {
    const longTitle = `${'甲'.repeat(79)}/尾巴`;
    const name = sanitizeExportFilename(longTitle, 'p-1');
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('-')).toBe(false);
  });

  it('文件名净化：空标题 / 纯非法字符回退 knowledge-<pageId 前 8 位>', () => {
    expect(sanitizeExportFilename('', 'abcdef1234567890')).toBe('knowledge-abcdef12');
    expect(sanitizeExportFilename('///', 'abcdef1234567890')).toBe('knowledge-abcdef12');
    expect(sanitizeExportFilename('', '')).toBe('knowledge-page');
  });

  it('导出内容：头部 meta 字段顺序固定 + 正文原样 + 来源与证据', () => {
    const md = buildKnowledgeMarkdown(page, { workspaceName: '任务看板', exportedAt: 1793700000000 });
    // 固定顺序：title / slug / scope / workspace / revision / updated_at / sources
    const order = ['title:', 'slug:', 'scope:', 'workspace:', 'revision:', 'updated_at:', 'sources:'];
    const positions = order.map((key) => md.indexOf(key));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(md).toContain('# 缓存策略');
    expect(md).toContain('workspace: 任务看板');
    expect(md).toContain('revision: 3');
    expect(md).toContain('- 缓存分层与失效');
    expect(md).toContain('- 预热成本');
    expect(md).toContain('apps/web/src/lib/cache.ts');
    expect(md).toContain('SHA-256 `aaaaaaaaaaaa…`');
    expect(md).toContain('export const cache = new Map();');
  });

  it('导出内容：无来源与证据时写（无），公共知识 workspace 显示「公共」', () => {
    const md = buildKnowledgeMarkdown(
      { ...page, scope: 'common', workspace_id: null, sources: [], evidence: [] },
      { exportedAt: 1793700000000 },
    );
    expect(md).toContain('scope: common');
    expect(md).toContain('workspace: 公共');
    expect(md.match(/（无）/g)?.length).toBe(2);
  });

  it('下载：createObjectURL 一次、触发 a[download]、且 revokeObjectURL 被调用', () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const filename = downloadKnowledgeMarkdown(page, { exportedAt: 1793700000000 });

    expect(filename).toBe('缓存策略.md');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
    // 下载用的 <a> 不留在 DOM 里
    expect(document.querySelectorAll('a[download]').length).toBe(0);
    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('下载：点击抛错时仍然 revoke（不泄漏 objectURL）', () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url-2');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click blocked');
    });
    expect(() => downloadKnowledgeMarkdown(page)).toThrow('click blocked');
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url-2');
    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });
});

describe('KnowledgePageDetail 导出入口（Markdown 下载 / PDF 打印）', () => {
  beforeEach(() => {
    server.use(http.get('/api/knowledge/pages/:id', () => HttpResponse.json(page)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.classList.remove('kg-printing');
  });

  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgePageDetail pageId={page.id} scope="workspace" workspaceId="A" onChanged={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('点「导出 Markdown」下载净化后的文件，内容含正文与来源', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:md');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount();
    fireEvent.click(await screen.findByTestId('export-markdown'));
    expect(await screen.findByText('导出 Markdown')).toBeInTheDocument();
    const blob = createSpy.mock.calls[0]?.[0] as Blob;
    // jsdom 的 Blob 无 text()：用 FileReader 读取
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toContain('# 缓存策略');
    expect(text).toContain('- 缓存分层与失效');
    expect(text).toContain('apps/web/src/lib/cache.ts');
    expect(revokeSpy).toHaveBeenCalledWith('blob:md');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('点「导出 PDF」走浏览器打印：window.print 被调用、body 加类、afterprint 后复原', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    mount();
    fireEvent.click(await screen.findByTestId('export-pdf'));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(document.body.classList.contains('kg-printing')).toBe(true);
    // 打印视图是只读快照：内容直接来自已加载详情
    const printView = screen.getByTestId('knowledge-print-view');
    expect(printView).toHaveTextContent('缓存策略');
    expect(printView).toHaveTextContent('apps/web/src/lib/cache.ts');
    // 打印结束 → 类被移除（页面状态复原）
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.body.classList.contains('kg-printing')).toBe(false));
    expect(screen.queryByTestId('knowledge-print-view')).not.toBeInTheDocument();
  });
});
