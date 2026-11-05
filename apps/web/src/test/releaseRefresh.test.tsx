/**
 * RELEASE-REFRESH：强制释放后界面必须立刻归位（不依赖 WS 帧）。
 *
 * 与用户报障一致：打开「进行中」卡详情 → 点「强制释放」。
 * 服务端响应是 `{ ...issue, comment }`，且**没有 WS 帧**（等价断线重连窗口丢帧）。
 * 断言：列表缓存里该项换成新值（卡片立刻离开「进行中」、占用徽标消失）、详情缓存只存 issue 字段。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { DetailPanel } from '../components/detail/DetailPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';
import type { Issue } from '@agentboard/shared';

const WS = 'ws-1';
const ID = 'i-release';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: ID,
  workspace_id: WS,
  title: '需要强制释放的卡',
  description: '',
  priority: '中',
  labels: [],
  status: '进行中',
  sort_order: 0,
  claimed_by: 'board-web-detail',
  claimed_at: 1_700_000_000_000,
  session_id: null,
  last_seen_comment_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...over,
} as Issue);

beforeEach(() => {
  useAppStore.setState({ workspaceId: WS, selectedLabelsByWorkspace: {} });
  usePanelStore.setState({ view: null, issueId: ID, sessionId: null });
});

describe('强制释放后界面归位（RELEASE-REFRESH）', () => {
  it('无 WS 帧时：列表与详情缓存都立刻换新值，详情缓存不含 comment 脏字段', async () => {
    const claimed = issue();
    const after = issue({ status: '待规划', claimed_by: null, claimed_at: null });
    let released = false;
    server.use(
      http.get(`/api/issues/${ID}`, () => HttpResponse.json(released ? after : claimed)),
      http.get(`/api/issues/${ID}/comments`, () => HttpResponse.json([])),
      http.get(`/api/issues/${ID}/dependencies`, () => HttpResponse.json([])),
      // 列表接口故意返回旧快照：模拟 refetch 落后/被旧快照覆盖的窗口（用户报障场景）
      http.get('/api/issues', () => HttpResponse.json([claimed])),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.get('/api/workspaces', () => HttpResponse.json([{ id: WS, name: '空间', path: 'D:/x' }])),
      http.post(`/api/issues/${ID}/release`, () => {
        released = true;
        return HttpResponse.json({
          ...after,
          comment: { id: 'c-1', issue_id: ID, author: 'system', content: '用户强制释放', ts: 1_700_000_000_100 },
        });
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
    qc.setQueryData(['issues', WS], [claimed]);
    render(
      <QueryClientProvider client={qc}>
        <DetailPanel />
      </QueryClientProvider>,
    );

    // F-09：先点「强制释放」展开行内确认，再点确认才真正发请求
    // D4：强制释放已收进 ⋯ 溢出菜单，先展开菜单再点菜单项
    await userEvent.click(await screen.findByTestId('actionbar-more'));
    await userEvent.click(await screen.findByTestId('release-btn'));
    await userEvent.click(await screen.findByTestId('release-confirm'));

    await waitFor(() => expect(released).toBe(true));
    // 修复前：列表缓存一直停在 'board-web-detail'（卡片仍显示占用、仍在「进行中」列）
    await waitFor(() => {
      const list = qc.getQueryData<Issue[]>(['issues', WS]);
      expect(list?.[0]?.claimed_by).toBeNull();
    });
    const detail = qc.getQueryData<Issue>(['issue', ID]) as (Issue & { comment?: unknown }) | undefined;
    expect(detail?.status).toBe('待规划');
    expect(detail?.comment).toBeUndefined();
  }, 20000);
});
