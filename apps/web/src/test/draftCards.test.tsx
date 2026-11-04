/**
 * MULTI-DRAFT 前端（6a59ef60）：草稿 responses 里的 cards[] → 多张可编辑卡、逐张取消、逐张创建。
 *
 * 覆盖：
 * - 响应带 3 张卡 → 渲染 3 张可编辑卡（1 条需求 1 张），不再落到单卡表单；
 * - 取消 1 张 → 只创建 2 张（贴实际请求体数量），结果区「成功 2 / 失败 0」；
 * - 旧响应（只有顶层单卡字段，没有 cards）→ 兼容成 1 张卡，不报错。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { NewIssueDialog } from '../components/topbar/NewIssueDialog';
import { requestDraft } from '../lib/smartDraft';
import { server } from './server';

const card = (title: string, requirements: string): Record<string, unknown> => ({
  local_id: title,
  title,
  description: `## 背景\n未提供\n\n## 要求\n${requirements}\n\n## 验收\n未提供`,
  labels: [],
  warnings: [],
});

function mockDraft(cards: unknown[] | null, legacy = false): void {
  const firstTitle = Array.isArray(cards) && cards.length > 0 ? String((cards[0] as { title?: unknown }).title ?? '') : '加排序开关';
  server.use(
    http.post('/api/issues/draft', () =>
      HttpResponse.json(
        legacy
          ? { title: '单卡标题', description: '## 要求\n单卡正文', labels: [], warnings: [], session_id: 's', session_turn: 1, session_reused: false }
          : { cards, title: firstTitle, description: 'x', labels: [], warnings: [], session_id: 's', session_turn: 1, session_reused: false },
      ),
    ),
  );
}

function renderDialog(created: Array<Record<string, unknown>>): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.post('/api/issues', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({ id: `new-${created.length}`, ...body }, { status: 200 });
    }),
    http.get('/api/clis', () => HttpResponse.json([
      { id: 'codex', displayName: 'Codex', installed: true, version: '1.0.0' },
    ])),
  );
  render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open workspaceId="ws-1" onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('requestDraft 兼容（cards[] 与旧单卡响应）', () => {
  it('响应带 cards[] → 映射成多张卡（localId 用服务端 local_id）', async () => {
    mockDraft([card('加排序开关', '看板加排序开关'), card('按标题搜索', '支持按标题搜索')]);
    const draft = await requestDraft({ workspace_id: 'ws-1', requirement: '1. 加排序开关\n2. 按标题搜索', adapter: 'codex' });
    expect(draft.cards).toHaveLength(2);
    expect(draft.cards.map((item) => item.title)).toEqual(['加排序开关', '按标题搜索']);
    expect(draft.cards[0]!.localId).toBe('加排序开关');
    // 顶层字段仍是第一张（兼容）
    expect(draft.title).toBe('加排序开关');
  });

  it('旧响应（无 cards）→ 兼容成 1 张卡，不抛错', async () => {
    mockDraft(null, true);
    const draft = await requestDraft({ workspace_id: 'ws-1', requirement: '一个需求', adapter: 'codex' });
    expect(draft.cards).toHaveLength(1);
    expect(draft.cards[0]!.title).toBe('单卡标题');
    expect(draft.title).toBe('单卡标题');
  });
});

describe('多卡草稿区（MULTI-DRAFT）', () => {
  it('3 条需求 → 3 张可编辑卡；取消 1 张 → 只建 2 张，结果区成功 2 / 失败 0', async () => {
    const created: Array<Record<string, unknown>> = [];
    mockDraft([card('c1', '甲'), card('c2', '乙'), card('c3', '丙')]);
    renderDialog(created);

    await userEvent.click(screen.getByTestId('mode-smart'));
    await userEvent.type(screen.getByTestId('smart-requirement'), '1. 甲\n2. 乙\n3. 丙');
    await userEvent.click(screen.getByTestId('smart-generate'));

    await waitFor(() => expect(screen.getByTestId('draft-cards')).toBeInTheDocument());
    for (const id of ['c1', 'c2', 'c3']) {
      expect(screen.getByTestId(`draft-card-title-${id}`)).toBeInTheDocument();
    }
    // 单卡表单不再出现（避免把多条塞进一张卡）
    expect(screen.queryByTestId('new-issue-title')).toBeNull();

    // 取消 c2 → 按钮文案变为 2 张
    await userEvent.click(screen.getByTestId('draft-card-cancel-c2'));
    await waitFor(() => expect(screen.getByTestId('draft-cards-create')).toHaveTextContent('创建 2 张'));

    await userEvent.click(screen.getByTestId('draft-cards-create'));
    await waitFor(() => expect(created).toHaveLength(2));
    expect(created.map((body) => body.title)).toEqual(['c1', 'c3']);
    expect(screen.getByTestId('draft-cards-result')).toHaveTextContent('成功 2 / 失败 0');
  });

  it('单条需求 → 仍是单卡路径（不出现多卡编辑器）', async () => {
    const created: Array<Record<string, unknown>> = [];
    mockDraft([card('单卡', '只有一个需求')]);
    renderDialog(created);

    await userEvent.click(screen.getByTestId('mode-smart'));
    await userEvent.type(screen.getByTestId('smart-requirement'), '只有一个需求');
    await userEvent.click(screen.getByTestId('smart-generate'));

    await waitFor(() => expect(screen.getByTestId('new-issue-title')).toHaveValue('单卡'));
    expect(screen.queryByTestId('draft-cards')).toBeNull();
  });
});
