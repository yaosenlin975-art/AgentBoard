/**
 * PROV-A：知识页「来源与证据」渲染修正的四类口径（回填缺文件名 / JSON 折叠 / 去重 / 复制路径）。
 *
 * 夹具铁律同 knowledge.test.tsx：字段名从真实响应粘贴。真实
 * `kb knowledge show <id> --json` 的形态是
 *   sources[] = { source_id: 'file:apps/web/.../Board.tsx', source_type: 'file',
 *                 locator: 'apps/web/.../Board.tsx', captured_at, content_hash }
 *   evidence[] = { source_id: 'file:apps/web/.../Board.tsx', locator: 'file:185-193' }
 * 即「证据 locator 只有行号区间，路径要靠 source_id 回填」——本卡修的就是这个畸形。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import {
  CopyPathButton,
  KnowledgePageDetail,
  buildProvenanceRows,
  resolveProvenanceLocator,
  shouldCollapseSnapshot,
} from '../components/knowledge/KnowledgePageDetail';
import type { KnowledgePage } from '@agentboard/shared';

const QUOTA_PATH = 'apps/web/src/components/settings/QuotaCards.tsx';

const basePage: KnowledgePage = {
  id: 'p-prov',
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'prov-a',
  title: '来源与证据渲染',
  body_md: '正文',
  revision: 1,
  status: 'active',
  expires_at: null,
  sources: [{ source_id: `file:${QUOTA_PATH}`, source_type: 'file', locator: QUOTA_PATH, captured_at: 1793600000000, content_hash: 'a'.repeat(64) }],
  evidence: [{ source_id: `file:${QUOTA_PATH}`, locator: 'file:125-137' }],
  created_by: 'kb-cli',
  updated_by: 'kb-cli',
  created_at: 1793600000000,
  updated_at: 1793600000000,
} as unknown as KnowledgePage;

type SourceInput = (typeof basePage.sources)[number];
type EvidenceInput = (typeof basePage.evidence)[number];

function page(overrides: Partial<Pick<KnowledgePage, 'sources' | 'evidence'>> = {}): KnowledgePage {
  return { ...basePage, ...overrides };
}

/** 展开「来源与证据」折叠块（默认折叠，与 knowledgeStyle 同一口径） */
async function openProvenance() {
  const details = (await screen.findByTestId('provenance')) as HTMLDetailsElement;
  fireEvent.click(details.querySelector('summary')!);
  await waitFor(() => expect(details.open).toBe(true));
  return details;
}

function mountDetail(current: KnowledgePage) {
  server.use(http.get('/api/knowledge/pages/:id', () => HttpResponse.json(current)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgePageDetail pageId={current.id} scope="workspace" workspaceId="A" onChanged={() => {}} />
    </QueryClientProvider>,
  );
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function stubClipboard(impl: { writeText: ReturnType<typeof vi.fn> } | undefined) {
  if (impl === undefined) {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    return;
  }
  Object.defineProperty(navigator, 'clipboard', { value: impl, configurable: true, writable: true });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

/* ================= ① 缺文件名回填 ================= */

describe('PROV-A ①：evidence.source_id → sources[].locator 路径回填', () => {
  it('单测：只剩行号的 locator 被补成「仓库相对路径 + 行号区间」', () => {
    const paths = new Map([[`file:${QUOTA_PATH}`, QUOTA_PATH]]);
    expect(resolveProvenanceLocator('file:125-137', `file:${QUOTA_PATH}`, paths)).toEqual({
      display: `${QUOTA_PATH}:125-137`,
      copyPath: `${QUOTA_PATH}:125-137`,
    });
    // 行号区间后面带的中文说明保留在路径之后，不混进可复制路径
    expect(resolveProvenanceLocator('file:1-41（mtime 判定与跳过目录口径）', 'file:scripts/check-stale.mjs', new Map([['file:scripts/check-stale.mjs', 'scripts/check-stale.mjs']]))).toEqual({
      display: 'scripts/check-stale.mjs:1-41 （mtime 判定与跳过目录口径）',
      copyPath: 'scripts/check-stale.mjs:1-41',
    });
  });

  it('单测：已含路径的 locator 原样显示；cmd:/issue: 取证不回填、不给复制路径', () => {
    const paths = new Map([['file:x.md', 'apps/x.md']]);
    expect(resolveProvenanceLocator('Docs/ref.md:1', 's', paths).display).toBe('Docs/ref.md:1');
    expect(resolveProvenanceLocator('package.json', 'file:package.json', new Map()).display).toBe('package.json');
    // 命令与工单取证：本身不是路径，绝不伪造
    expect(resolveProvenanceLocator('cmd:pnpm --filter @agentboard/web test', 'file:x.md', paths)).toEqual({
      display: 'cmd:pnpm --filter @agentboard/web test',
      copyPath: null,
    });
    expect(resolveProvenanceLocator('issue:176b6a96-4902-4bf7-9c6a-e800501ea6bd', 'file:x.md', paths).copyPath).toBeNull();
    // 回填不出来（没有命中含路径的 source）→ 原样显示，宁缺毋伪
    expect(resolveProvenanceLocator('file:125-137', 'file:unknown', new Map())).toEqual({ display: 'file:125-137', copyPath: null });
  });

  it('渲染：不再出现只剩 file:125-137 的孤立条目', async () => {
    mountDetail(page());
    await openProvenance();
    expect(screen.getByText(`${QUOTA_PATH}:125-137`)).toBeInTheDocument();
    expect(screen.queryByText('file:125-137')).not.toBeInTheDocument();
    // 只做展示与复制：不新增可点击跳转、不渲染 file:/// 链接
    const rows = screen.getAllByTestId('provenance-row');
    expect(rows.flatMap((row) => Array.from(row.querySelectorAll('a')))).toHaveLength(0);
    expect(document.body.textContent).not.toContain('file:///');
  });

  it('source_id 是裸文件名、locator 才是全路径时，也按 source_id 命中回填', () => {
    // 真实形态（知识页 ccca0c04）：source_id="file:EmptyState.tsx"，locator="apps/web/src/components/ui/EmptyState.tsx"
    const rows = buildProvenanceRows(
      [{ source_id: 'file:EmptyState.tsx', source_type: 'file', locator: 'apps/web/src/components/ui/EmptyState.tsx', captured_at: 5, content_hash: 'b'.repeat(64) }] as SourceInput[],
      [{ source_id: 'file:EmptyState.tsx', locator: 'file:12-20' }] as EvidenceInput[],
    );
    expect(rows.map((row) => row.display)).toEqual([
      'apps/web/src/components/ui/EmptyState.tsx',
      'apps/web/src/components/ui/EmptyState.tsx:12-20',
    ]);
  });
});

/* ================= ② JSON / 长文本 snapshot 折叠 ================= */

describe('PROV-A ②：snapshot 折叠', () => {
  const jsonSnapshot = JSON.stringify({ quota: { total_bytes: 1024, used_bytes: 512 }, checks: ['a', 'b'] });

  it('单测：JSON 一律折叠；短文本不折叠；超长/多行文本折叠', () => {
    expect(shouldCollapseSnapshot(jsonSnapshot)).toBe(true);
    expect(shouldCollapseSnapshot('export const cache = new Map();')).toBe(false);
    expect(shouldCollapseSnapshot(`第一行\n第二行\n第三行\n第四行`)).toBe(true);
    // 看起来像 JSON 但解析不了的，不按 JSON 折叠（不猜）
    expect(shouldCollapseSnapshot('{ 不是合法 JSON')).toBe(false);
  });

  it('渲染：JSON snapshot 收成「展开查看」，默认不裸露，展开后是缩进后的 JSON', async () => {
    mountDetail(page({ evidence: [{ source_id: `file:${QUOTA_PATH}`, locator: 'file:125-137', snapshot: jsonSnapshot }] }));
    await openProvenance();

    const folded = screen.getByTestId('provenance-snapshot') as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(within(folded).getByText(/展开查看/)).toHaveTextContent('JSON');
    // 折叠态不把整段 JSON 裸露成旧 blockquote 形态
    expect(Array.from(document.querySelectorAll('blockquote')).some((node) => node.textContent?.includes('total_bytes'))).toBe(false);

    fireEvent.click(within(folded).getByText(/展开查看/));
    await waitFor(() => expect(folded.open).toBe(true));
    expect(screen.getByTestId('provenance-snapshot-body')).toHaveTextContent('"total_bytes": 1024');
  });

  it('渲染：短 snapshot 仍直接显示（不套折叠壳）', async () => {
    mountDetail(page({ evidence: [{ source_id: `file:${QUOTA_PATH}`, locator: 'file:125-137', snapshot: 'export const cache = new Map();' }] }));
    await openProvenance();
    expect(screen.getByText('export const cache = new Map();')).toBeInTheDocument();
    expect(screen.queryByTestId('provenance-snapshot')).not.toBeInTheDocument();
  });
});

/* ================= ③ 重复条目去重 ================= */

describe('PROV-A ③：同一 locator / 同一提交去重', () => {
  it('同一 locator 的两条来源只留一条，且保留最早 captured_at', () => {
    const rows = buildProvenanceRows(
      [
        { source_id: 's2', source_type: 'file', locator: 'Docs/dup.md:1-9', captured_at: 3000, content_hash: 'c'.repeat(64) },
        { source_id: 's1', source_type: 'file', locator: 'Docs/dup.md:1-9', captured_at: 1000, content_hash: 'd'.repeat(64) },
      ] as SourceInput[],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt).toBe(1000);
    expect(rows[0]?.contentHash).toBe('d'.repeat(64));
  });

  it('没有路径的同提交条目（locator 为空）按 content_hash 折叠；同提交只留最早一条', () => {
    const rows = buildProvenanceRows(
      [
        { source_id: 'commit-1', source_type: 'commit', locator: '', captured_at: 2000, content_hash: 'same-sha' },
        { source_id: 'commit-2', source_type: 'commit', locator: '', captured_at: 900, content_hash: 'same-sha' },
      ] as unknown as SourceInput[],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt).toBe(900);
  });

  it('来源与证据指向同一 locator 时合并成一行，条数与展开后的行数同口径', async () => {
    mountDetail(page({ evidence: [{ source_id: `file:${QUOTA_PATH}`, locator: QUOTA_PATH }] }));
    const details = (await screen.findByTestId('provenance')) as HTMLDetailsElement;
    // 1 来源 + 1 证据，locator 相同 → 去重后 1 条
    expect(details.querySelector('summary')).toHaveTextContent('来源与证据（1 条）');
    await openProvenance();
    expect(screen.getAllByTestId('provenance-row')).toHaveLength(1);
    // 合并到信息更全的来源行（SHA-256 仍在）
    expect(screen.getByText(QUOTA_PATH)).toBeInTheDocument();
    expect(screen.getByText(/SHA-256/)).toBeInTheDocument();
  });
});

/* ================= ④ 复制路径按钮 ================= */

describe('PROV-A ④：复制路径按钮', () => {
  it('点「复制路径」写入剪贴板并给出「已复制」反馈（复用现有次级按钮样式）', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    mountDetail(page());
    await openProvenance();

    const rows = screen.getAllByTestId('provenance-row');
    const evidenceRow = rows.find((row) => row.getAttribute('data-kind') === 'evidence')!;
    const button = within(evidenceRow).getByTestId('provenance-copy');
    expect(button.className).toContain('rounded-lg');
    expect(button).toHaveTextContent('复制路径');

    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${QUOTA_PATH}:125-137`));
    await waitFor(() => expect(button).toHaveTextContent('已复制'));
  });

  it('剪贴板拒绝写入 → 明确报「复制失败」，不假装成功', async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.reject(new Error('document not focused'))) });
    mountDetail(page());
    await openProvenance();
    const button = within(screen.getAllByTestId('provenance-row')[0]!).getByTestId('provenance-copy');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('复制失败'));
  });

  it('剪贴板不可用（无 navigator.clipboard）→ 同样报失败而不是静默', async () => {
    stubClipboard(undefined);
    mountDetail(page());
    await openProvenance();
    const button = within(screen.getAllByTestId('provenance-row')[0]!).getByTestId('provenance-copy');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('复制失败'));
  });

  it('非文件取证（cmd:/issue:）不渲染「复制路径」按钮', async () => {
    mountDetail(
      page({
        evidence: [
          { source_id: `file:${QUOTA_PATH}`, locator: 'cmd:pnpm --filter @agentboard/web test' },
          { source_id: `file:${QUOTA_PATH}`, locator: 'issue:176b6a96-4902-4bf7-9c6a-e800501ea6bd' },
        ],
      }),
    );
    await openProvenance();
    expect(screen.getByText('cmd:pnpm --filter @agentboard/web test')).toBeInTheDocument();
    expect(screen.getByText('issue:176b6a96-4902-4bf7-9c6a-e800501ea6bd')).toBeInTheDocument();
    // 只剩来源行有复制按钮
    expect(screen.getAllByTestId('provenance-copy')).toHaveLength(1);
  });

  it('独立渲染的按钮：卸载后定时器不报错（复制反馈会自行复位）', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <CopyPathButton path="Docs/a.md:1" />
      </QueryClientProvider>,
    );
    const button = screen.getByTestId('provenance-copy');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('已复制'));
    unmount();
    expect(writeText).toHaveBeenCalledWith('Docs/a.md:1');
  });
});
