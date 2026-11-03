/**
 * MD-LINKS-2：markdown 软链接解析（issue / knowledge / log）+ 知识权限（common + 当前工作区）+ 未知 scheme 原样 + 点击开浮窗。
 * 用 MarkdownRenderer 直接渲染（它没有懒加载门控），断言数据与 store 事件。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { KnowledgePage, WorkspaceChangeLog } from '@agentboard/shared';
import MarkdownRenderer from '../lib/markdownRenderer';
import { isExternalLink, parseMarkdownRef } from '../lib/markdownLinks';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const wsId = 'ws-current';

function knowledgePage(overrides: Partial<KnowledgePage> = {}): KnowledgePage {
  return {
    id: 'kp-common',
    scope: 'common',
    workspace_id: null,
    slug: 'bom-guard',
    title: 'BOM 守卫',
    body_md: '正文',
    status: 'active',
    revision: 1,
    created_by: 'user',
    updated_by: 'user',
    created_at: 1,
    updated_at: 1,
    expires_at: null,
    ...overrides,
  } as KnowledgePage;
}

function changeLog(): WorkspaceChangeLog {
  return {
    id: 'log-1',
    workspace_id: wsId,
    origin_workspace_id: wsId,
    origin_workspace_name: '项目',
    origin_workspace_path: 'D:/p',
    title: '日志标题',
    body_md: '日志正文',
    change_type: '新增',
    occurred_at: 1,
    created_by: 'user',
    updated_by: 'user',
    created_at: 1,
    updated_at: 1,
    revision: 1,
    legacy_source_key: null,
  };
}

function renderMarkdown(md: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MarkdownRenderer>{md}</MarkdownRenderer>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: wsId, wsStatus: 'open' });
  usePanelStore.setState({ view: null, issueId: null, refPanel: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
});

describe('parseMarkdownRef / isExternalLink', () => {
  it('识别三种 scheme，未知与空值返回 null', () => {
    expect(parseMarkdownRef('issue:3f8da34e-fb8c-4b9e-bac5-1c601b850d7f')).toEqual({
      kind: 'issue',
      ref: '3f8da34e-fb8c-4b9e-bac5-1c601b850d7f',
    });
    expect(parseMarkdownRef('knowledge:bom-guard')).toEqual({ kind: 'knowledge', ref: 'bom-guard' });
    expect(parseMarkdownRef('log:log-1')).toEqual({ kind: 'log', ref: 'log-1' });
    expect(parseMarkdownRef('ISSUE:abc')).toEqual({ kind: 'issue', ref: 'abc' });
    expect(parseMarkdownRef('foo:bar')).toBeNull();
    expect(parseMarkdownRef('https://example.com')).toBeNull();
    expect(parseMarkdownRef('issue:')).toBeNull();
    expect(parseMarkdownRef(undefined)).toBeNull();
  });

  it('http(s)/mailto 视为外链', () => {
    expect(isExternalLink('https://example.com')).toBe(true);
    expect(isExternalLink('http://x')).toBe(true);
    expect(isExternalLink('mailto:a@b.c')).toBe(true);
    expect(isExternalLink('issue:abc')).toBe(false);
    expect(isExternalLink(undefined)).toBe(false);
  });
});

describe('任务链接', () => {
  it('[标题](issue:uuid) 渲染可点元素，点击打开任务详情浮窗', async () => {
    const id = '3f8da34e-fb8c-4b9e-bac5-1c601b850d7f';
    renderMarkdown(`见 [子卡](issue:${id})`);
    const link = screen.getByTestId(`md-link-issue-${id}`);
    expect(link).toHaveAttribute('data-link-state', 'ok');
    expect(link.tagName).toBe('BUTTON');

    await userEvent.click(screen.getByTestId(`md-link-issue-${id}`));
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: id, rightOpen: true });
  });
});

describe('知识链接与权限', () => {
  it('common 知识可点，点击打开知识浮窗', async () => {
    server.use(http.get('/api/knowledge/pages/kp-common', () => HttpResponse.json(knowledgePage())));
    renderMarkdown(`见 [BOM 守卫](knowledge:kp-common)`);
    await screen.findByTestId('md-link-knowledge-kp-common');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-common')).toHaveAttribute('data-link-state', 'ok'));

    await userEvent.click(screen.getByTestId('md-link-knowledge-kp-common'));
    expect(usePanelStore.getState()).toMatchObject({
      view: 'ref',
      refPanel: { kind: 'knowledge', id: 'kp-common', title: 'BOM 守卫' },
    });
  });

  it('当前工作区的知识可点', async () => {
    server.use(
      http.get('/api/knowledge/pages/kp-mine', () =>
        HttpResponse.json(knowledgePage({ id: 'kp-mine', scope: 'workspace', workspace_id: wsId, title: '本区知识' })),
      ),
    );
    renderMarkdown(`[本区知识](knowledge:kp-mine)`);
    await screen.findByTestId('md-link-knowledge-kp-mine');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-mine')).toHaveAttribute('data-link-state', 'ok'));
  });

  it('其它工作区的知识 → 不可点 + tooltip「无权限或不存在」', async () => {
    server.use(
      http.get('/api/knowledge/pages/kp-other', () =>
        HttpResponse.json(knowledgePage({ id: 'kp-other', scope: 'workspace', workspace_id: 'ws-other', title: '别人的' })),
      ),
    );
    renderMarkdown(`[别人的](knowledge:kp-other)`);
    const link = await screen.findByTestId('md-link-knowledge-kp-other');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'denied'));
    expect(link).toHaveAttribute('title', '无权限或不存在');
    expect(link.tagName).not.toBe('BUTTON');
    await userEvent.click(link);
    expect(usePanelStore.getState().view).toBeNull();
  });

  it('不存在的知识 → 不可点 + 同一文案（不静默变外链）', async () => {
    server.use(
      http.get('/api/knowledge/pages/missing', () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: '不存在' } }, { status: 404 }),
      ),
    );
    renderMarkdown(`[缺失](knowledge:missing)`);
    const link = await screen.findByTestId('md-link-knowledge-missing');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'denied'));
    expect(link).toHaveAttribute('title', '无权限或不存在');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('日志链接', () => {
  it('当前工作区日志可点，点击打开日志浮窗', async () => {
    server.use(http.get(`/api/workspaces/${wsId}/changelog/log-1`, () => HttpResponse.json(changeLog())));
    renderMarkdown(`[日志](log:log-1)`);
    await screen.findByTestId('md-link-log-log-1');
    // 从 loading 到 ok 会把 span 换成 button（DOM 节点被替换），断言一律重新查询
    await waitFor(() => expect(screen.getByTestId('md-link-log-log-1')).toHaveAttribute('data-link-state', 'ok'));

    await userEvent.click(screen.getByTestId('md-link-log-log-1'));
    expect(usePanelStore.getState()).toMatchObject({
      view: 'ref',
      refPanel: { kind: 'log', id: 'log-1', title: '日志标题' },
    });
  });

  it('日志不存在 → 不可点 + tooltip', async () => {
    server.use(
      http.get(`/api/workspaces/${wsId}/changelog/nope`, () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: '不存在' } }, { status: 404 }),
      ),
    );
    renderMarkdown(`[无](log:nope)`);
    const link = await screen.findByTestId('md-link-log-nope');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'denied'));
    expect(link).toHaveAttribute('title', '无权限或不存在');
  });
});

describe('未知 scheme 与普通外链', () => {
  it('未知 scheme 原样文本（不外链、无 href）', async () => {
    renderMarkdown(`[怪链接](foo:bar)`);
    const node = await screen.findByTestId('md-link-unknown');
    expect(node.textContent).toBe('怪链接');
    expect(node.tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('http 外链保持普通 a[target=_blank]', async () => {
    renderMarkdown(`[官网](https://example.com)`);
    const link = await screen.findByRole('link', { name: '官网' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('三种软链接同时出现时各自独立渲染', async () => {
    server.use(
      http.get('/api/knowledge/pages/kp-common', () => HttpResponse.json(knowledgePage())),
      http.get(`/api/workspaces/${wsId}/changelog/log-1`, () => HttpResponse.json(changeLog())),
    );
    renderMarkdown('- [任务](issue:i-1)\n- [知识](knowledge:kp-common)\n- [日志](log:log-1)\n');
    expect(await screen.findByTestId('md-link-issue-i-1')).toHaveAttribute('data-link-state', 'ok');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-common')).toHaveAttribute('data-link-state', 'ok'));
    await waitFor(() => expect(screen.getByTestId('md-link-log-log-1')).toHaveAttribute('data-link-state', 'ok'));
  });
});
