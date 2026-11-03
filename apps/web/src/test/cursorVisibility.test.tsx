/**
 * CURSOR-WHITE 回归：看板卡片/拖拽浮层的光标必须是双色自定义光标。
 *
 * 背景：CSS 原生 `cursor: grab/grabbing` 在 Windows 上由 Chromium 合成**纯白手掌位图**（无描边），
 * 白色页面背景上完全看不见。修复后改用 data-URI SVG（白色填充 + 深色描边 #111），
 * 浅底靠描边、深底靠填充都可见，一套资源覆盖深浅主题。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { IssueCard, IssueCardPreview } from '../components/board/IssueCard';
import { GRAB_CURSOR, GRABBING_CURSOR } from '../lib/cursor';

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: `任务${id}`,
    description: '',
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

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  localStorage.clear();
});

describe('看板拖拽光标可见性（CURSOR-WHITE）', () => {
  it('自定义光标是 data-URI SVG，且带白填充 + 深色描边', () => {
    for (const cursor of [GRAB_CURSOR, GRABBING_CURSOR]) {
      expect(cursor).toContain('data:image/svg+xml');
      expect(cursor).toContain('%23ffffff'); // 白色填充
      expect(cursor).toContain('%23111111'); // 深色描边
      // 兜底：浏览器不支持 SVG 光标时退化到原生 grab/grabbing
      expect(cursor).toMatch(/, (grab|grabbing)$/);
      // 带热点坐标
      expect(cursor).toMatch(/\) \d+ \d+, /);
    }
  });

  it('卡片用自定义 grab 光标，不再用原生 cursor-grab 类', () => {
    render(
      <QueryClientProvider client={qc}>
        <IssueCard issue={makeIssue('c1')} sessionRunning={false} />
      </QueryClientProvider>,
    );
    const card = screen.getByTestId('issue-card-c1');
    expect(card.style.cursor).toContain('data:image/svg+xml');
    expect(card.className).not.toContain('cursor-grab');
  });

  it('占用中的卡仍是禁止光标（不可拖动）', () => {
    render(
      <QueryClientProvider client={qc}>
        <IssueCard issue={makeIssue('c2', { claimed_by: 'agent:codex', claimed_at: 1 })} sessionRunning={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('issue-card-c2').style.cursor).toBe('not-allowed');
  });

  it('拖拽浮层用 grabbing 双色光标', () => {
    render(
      <QueryClientProvider client={qc}>
        <IssueCardPreview issue={makeIssue('c3')} sessionRunning={false} />
      </QueryClientProvider>,
    );
    const overlay = screen.getByTestId('drag-overlay-c3');
    expect(overlay.style.cursor).toContain('data:image/svg+xml');
    expect(overlay.className).not.toContain('cursor-grabbing');
  });
});
