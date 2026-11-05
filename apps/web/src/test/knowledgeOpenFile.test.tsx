/**
 * PROV-B：知识页证据条目「打开本地文件」的前端接线与降级。
 *
 * 断言口径按「视口无关」写（应用内嵌浏览器约 577px 且不可调）：只看点了什么、发了什么请求、
 * 出现了什么提示文案，不看位置与尺寸。
 *
 * 覆盖：
 *  ① 行模型只有 source_type='file' 才产出 openTarget（url/agent/commit 不给打开）；
 *  ② 点击确实发出 POST /api/knowledge/files/open，body 只有 workspace_id + path + line；
 *  ③ 打开成功 → 「已打开 / 已在VS Code打开」；
 *  ④ 打不开（500 OPEN_FAILED、400 越界拒绝）→ 降级复制路径 + 可见原因，绝不假装成功；
 *  ⑤ 剪贴板也不可用 → 说清「复制也失败」；
 *  ⑥ 公共页（无 workspace_id）不渲染「打开」。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import {
  KnowledgePageDetail,
  buildProvenanceRows,
  openTargetOf,
} from '../components/knowledge/KnowledgePageDetail';
import type { KnowledgePage } from '@agentboard/shared';

const FILE_PATH = 'apps/web/src/components/knowledge/KnowledgePageDetail.tsx';

const basePage: KnowledgePage = {
  id: 'p-prov-b',
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'prov-b',
  title: '打开证据文件',
  body_md: '正文',
  revision: 1,
  status: 'active',
  expires_at: null,
  sources: [{ source_id: `file:${FILE_PATH}`, source_type: 'file', locator: FILE_PATH, captured_at: 1793600000000, content_hash: 'a'.repeat(64) }],
  evidence: [{ source_id: `file:${FILE_PATH}`, locator: 'file:125-137' }],
  created_by: 'kb-cli',
  updated_by: 'kb-cli',
  created_at: 1793600000000,
  updated_at: 1793600000000,
} as unknown as KnowledgePage;

type SourceInput = (typeof basePage.sources)[number];

function page(overrides: Partial<Pick<KnowledgePage, 'sources' | 'evidence'>> = {}): KnowledgePage {
  return { ...basePage, ...overrides };
}

async function openProvenance(): Promise<void> {
  const details = (await screen.findByTestId('provenance')) as HTMLDetailsElement;
  fireEvent.click(details.querySelector('summary')!);
  await waitFor(() => expect(details.open).toBe(true));
}

function mountDetail(current: KnowledgePage, scope: 'workspace' | 'common' = 'workspace', workspaceId: string | null = 'A') {
  server.use(http.get('/api/knowledge/pages/:id', () => HttpResponse.json(current)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgePageDetail pageId={current.id} scope={scope} workspaceId={workspaceId} onChanged={() => {}} />
    </QueryClientProvider>,
  );
}

/** 拦住打开端点并记录请求体；status/code/message 可控 */
function stubOpenEndpoint(response: { status: number; body: Record<string, unknown> }) {
  const requests: Array<Record<string, unknown>> = [];
  server.use(http.post('/api/knowledge/files/open', async ({ request }) => {
    requests.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json(response.body, { status: response.status });
  }));
  return requests;
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function stubClipboard(impl: { writeText: ReturnType<typeof vi.fn> } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: impl,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

/* ================= ① 行模型：谁能被打开 ================= */

describe('PROV-B ①：只有 file 来源产出 openTarget', () => {
  it('openTargetOf：行号区间取首号；没有区间就没有 line', () => {
    expect(openTargetOf(`${FILE_PATH}:125-137`)).toEqual({ path: FILE_PATH, line: 125 });
    expect(openTargetOf(FILE_PATH)).toEqual({ path: FILE_PATH, line: null });
    expect(openTargetOf(`${FILE_PATH}:42`)).toEqual({ path: FILE_PATH, line: 42 });
    expect(openTargetOf(null)).toBeNull();
  });

  it('source_type=file → 有 openTarget；url / agent / commit → 没有', () => {
    const rows = buildProvenanceRows(
      [
        { source_id: 'file:a.ts', source_type: 'file', locator: 'apps/a.ts', captured_at: 1, content_hash: 'b'.repeat(64) },
        { source_id: 'url:b', source_type: 'url', locator: 'https://example.com/a.ts', captured_at: 2, content_hash: '' },
        { source_id: 'agent:c', source_type: 'agent', locator: 'apps/c.ts:3-9', captured_at: 3, content_hash: '' },
        { source_id: 'commit:d', source_type: 'commit', locator: 'apps/d.ts:1', captured_at: 4, content_hash: '' },
      ] as unknown as SourceInput[],
      [],
    );
    expect(rows.map((row) => row.openTarget)).toEqual([
      { path: 'apps/a.ts', line: null },
      null,
      null,
      null,
    ]);
  });

  it('证据行跟随对应来源的类型；来源缺失或不是 file 就不给打开', () => {
    const rows = buildProvenanceRows(
      [
        { source_id: 'file:e.ts', source_type: 'file', locator: 'apps/e.ts', captured_at: 1, content_hash: 'c'.repeat(64) },
        { source_id: 'agent:f', source_type: 'agent', locator: 'apps/f.ts', captured_at: 2, content_hash: '' },
      ] as unknown as SourceInput[],
      [
        { source_id: 'file:e.ts', locator: 'file:10-12' },
        { source_id: 'agent:f', locator: 'file:20-22' },
        { source_id: 'file:unknown', locator: 'file:30' },
      ],
    );
    const evidence = rows.filter((row) => row.kind === 'evidence');
    expect(evidence.map((row) => row.openTarget)).toEqual([
      { path: 'apps/e.ts', line: 10 },
      null,
      null,
    ]);
  });
});

/* ================= ②③④⑤⑥ 渲染与交互 ================= */

describe('PROV-B ②：点击「打开」发的是 POST /api/knowledge/files/open', () => {
  it('成功：请求体只有 workspace_id + path + line，反馈「已在VS Code打开」', async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const requests = stubOpenEndpoint({ status: 200, body: { ok: true, opened_with: 'vscode', path: FILE_PATH, line: 125 } });
    mountDetail(page());
    await openProvenance();

    const rows = screen.getAllByTestId('provenance-row');
    const evidenceRow = rows.find((row) => row.getAttribute('data-kind') === 'evidence')!;
    const button = within(evidenceRow).getByTestId('provenance-open');
    expect(button).toHaveTextContent('打开');

    fireEvent.click(button);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({ workspace_id: 'A', path: FILE_PATH, line: 125 });
    await waitFor(() => expect(within(evidenceRow).getByTestId('provenance-open-note')).toHaveTextContent('已在VS Code打开'));
    // 成功路径不写剪贴板（复制只属降级）
    expect(navigator.clipboard?.writeText).not.toHaveBeenCalled();
  });

  it('没有行号的来源条目：请求体不带 line 字段', async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    const requests = stubOpenEndpoint({ status: 200, body: { ok: true, opened_with: 'explorer', path: FILE_PATH, line: null } });
    mountDetail(page({ evidence: [] }));
    await openProvenance();
    fireEvent.click(screen.getAllByTestId('provenance-open')[0]!);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({ workspace_id: 'A', path: FILE_PATH });
    await waitFor(() => expect(screen.getByTestId('provenance-open-note')).toHaveTextContent('已在资源管理器打开'));
  });
});

describe('PROV-B ④⑤：打不开就降级为「已复制路径」+ 可见原因', () => {
  it('500 OPEN_FAILED → 复制整串（含行号区间）并说明原因，按钮文案不假装成功', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    stubOpenEndpoint({
      status: 500,
      body: { error: { code: 'OPEN_FAILED', message: '本机没有可用的打开方式（VS Code / 资源管理器 / 默认程序均失败），已降级为复制路径' } },
    });
    mountDetail(page());
    await openProvenance();
    const rows = screen.getAllByTestId('provenance-row');
    const evidenceRow = rows.find((row) => row.getAttribute('data-kind') === 'evidence')!;
    fireEvent.click(within(evidenceRow).getByTestId('provenance-open'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${FILE_PATH}:125-137`));
    const note = within(evidenceRow).getByTestId('provenance-open-note');
    expect(note).toHaveTextContent('已复制路径');
    expect(note).toHaveTextContent('本机没有可用的打开方式');
    expect(within(evidenceRow).getByTestId('provenance-open')).toHaveTextContent('已复制路径');
  });

  it('400 越界拒绝 → 同样降级（安全边界拒绝也算「打不开」），原因照实说', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    stubOpenEndpoint({ status: 400, body: { error: { code: 'FILE_PATH_ESCAPE', message: '路径解析后不在该工作区内，已拒绝' } } });
    mountDetail(page());
    await openProvenance();
    const row = screen.getAllByTestId('provenance-row')[0]!;
    fireEvent.click(within(row).getByTestId('provenance-open'));
    await waitFor(() => expect(within(row).getByTestId('provenance-open-note')).toHaveTextContent('路径解析后不在该工作区内，已拒绝'));
    expect(within(row).getByTestId('provenance-open')).not.toHaveTextContent('已打开');
  });

  it('剪贴板也不可用 → 明说「剪贴板不可用」，不静默失败', async () => {
    stubClipboard(undefined);
    stubOpenEndpoint({ status: 500, body: { error: { code: 'OPEN_FAILED', message: '本机没有可用的打开方式' } } });
    mountDetail(page());
    await openProvenance();
    const row = screen.getAllByTestId('provenance-row')[0]!;
    fireEvent.click(within(row).getByTestId('provenance-open'));
    await waitFor(() => expect(within(row).getByTestId('provenance-open-note')).toHaveTextContent('剪贴板不可用'));
    expect(within(row).getByTestId('provenance-open')).toHaveTextContent('打开失败');
  });
});

describe('PROV-B ⑥：不给打开的场景', () => {
  it('公共页（scope=common）没有可依据的工作区根 → 只有复制，没有打开', async () => {
    mountDetail(page(), 'common', null);
    await openProvenance();
    expect(screen.queryByTestId('provenance-open')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('provenance-copy').length).toBeGreaterThan(0);
  });

  it('agent / cmd 取证 → 不渲染打开按钮（只有 file 来源可点）', async () => {
    mountDetail(page({
      sources: [{ source_id: 'agent:x', source_type: 'agent', locator: FILE_PATH, captured_at: 1, content_hash: '' }] as unknown as SourceInput[],
      evidence: [{ source_id: 'agent:x', locator: 'file:125-137' }],
    }));
    await openProvenance();
    expect(screen.queryByTestId('provenance-open')).not.toBeInTheDocument();
  });
});
