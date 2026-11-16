/**
 * MD-LINKS-2：markdown 软链接解析（issue / knowledge / log）+ 知识权限（common + 当前工作区）+ 未知 scheme 原样 + 点击开浮窗。
 * 用 MarkdownRenderer 直接渲染（它没有懒加载门控），断言数据与 store 事件。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import MarkdownRenderer from '../lib/markdownRenderer';
import { isExternalLink, parseMarkdownRef } from '../lib/markdownLinks';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const wsId = 'ws-current';

/** KB-PAGE-2 resolve 响应（渲染层只读这五个字段 + status） */
function resolvedRef(overrides: Partial<{
  id: string; title: string; scope: 'common' | 'workspace'; workspace_id: string | null; status: 'active' | 'archived'; revision: number;
}> = {}) {
  const base = { id: 'kp-common', title: 'BOM 守卫', scope: 'common' as const, workspace_id: null, status: 'active' as const, revision: 1 };
  const page = { ...base, ...overrides };
  return { ...page, link: { ref: `knowledge:${page.id}`, markdown: `[${page.title}](knowledge:${page.id})` } };
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
    issue_id: null,
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

describe('知识链接与权限（统一走 /api/knowledge/resolve）', () => {
  it('common 知识可点，点击打开知识浮窗', async () => {
    server.use(http.get('/api/knowledge/resolve', () => HttpResponse.json(resolvedRef())));
    renderMarkdown(`见 [BOM 守卫](knowledge:kp-common)`);
    await screen.findByTestId('md-link-knowledge-kp-common');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-common')).toHaveAttribute('data-link-state', 'ok'));

    await userEvent.click(screen.getByTestId('md-link-knowledge-kp-common'));
    expect(usePanelStore.getState()).toMatchObject({
      view: 'ref',
      refPanel: { kind: 'knowledge', id: 'kp-common', title: 'BOM 守卫' },
    });
  });

  it('当前工作区的知识可点；归档页可点并标注「已归档」', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () => HttpResponse.json(resolvedRef({ id: 'kp-mine', scope: 'workspace', workspace_id: wsId, title: '本区知识', status: 'archived' }))),
    );
    renderMarkdown(`[本区知识](knowledge:kp-mine)`);
    await screen.findByTestId('md-link-knowledge-kp-mine');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-mine')).toHaveAttribute('data-link-state', 'ok'));
    expect(screen.getByTestId('md-link-knowledge-kp-mine')).toHaveAttribute('title', '知识：本区知识（已归档）');
  });

  it('其它工作区的知识 → 403 → 不可点 + tooltip「无权限或不存在」', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () =>
        HttpResponse.json({ error: { code: 'KNOWLEDGE_SCOPE_FORBIDDEN', message: '无权访问' } }, { status: 403 }),
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

  it('不存在 → 404 → 不可点 + 同一文案（不静默变外链）', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () =>
        HttpResponse.json({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '不存在' } }, { status: 404 }),
      ),
    );
    renderMarkdown(`[缺失](knowledge:missing)`);
    const link = await screen.findByTestId('md-link-knowledge-missing');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'denied'));
    expect(link).toHaveAttribute('title', '无权限或不存在');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('同 slug 歧义 → 409 → 不可点 + 「链接有歧义」', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () =>
        HttpResponse.json({ error: { code: 'KNOWLEDGE_REF_AMBIGUOUS', message: '有歧义' } }, { status: 409 }),
      ),
    );
    renderMarkdown(`[歧义](knowledge:dup-slug)`);
    const link = await screen.findByTestId('md-link-knowledge-dup-slug');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'ambiguous'));
    expect(link).toHaveAttribute('title', '链接有歧义，请用完整 id');
  });

  it('软删页 → 410 → 不可点 + 「已删除（可查看历史版本）」，不冒充正常卡片', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () =>
        HttpResponse.json({ error: { code: 'KNOWLEDGE_DELETED', message: '已删除' } }, { status: 410 }),
      ),
    );
    renderMarkdown(`[已删](knowledge:gone)`);
    const link = await screen.findByTestId('md-link-knowledge-gone');
    await waitFor(() => expect(link).toHaveAttribute('data-link-state', 'deleted'));
    expect(link).toHaveAttribute('title', '已删除（可查看历史版本）');
    expect(link.tagName).not.toBe('BUTTON');
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
      http.get('/api/knowledge/resolve', () => HttpResponse.json(resolvedRef())),
      http.get(`/api/workspaces/${wsId}/changelog/log-1`, () => HttpResponse.json(changeLog())),
    );
    renderMarkdown('- [任务](issue:i-1)\n- [知识](knowledge:kp-common)\n- [日志](log:log-1)\n');
    expect(await screen.findByTestId('md-link-issue-i-1')).toHaveAttribute('data-link-state', 'ok');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-kp-common')).toHaveAttribute('data-link-state', 'ok'));
    await waitFor(() => expect(screen.getByTestId('md-link-log-log-1')).toHaveAttribute('data-link-state', 'ok'));
  });
});

describe('P2-04：[[wikilink]] 双 scheme 渲染（US-2）', () => {
  it('[[slug]] 渲染为可点知识链接，点击打开目标页', async () => {
    server.use(http.get('/api/knowledge/resolve', () => HttpResponse.json(resolvedRef())));
    renderMarkdown(`见 [[bom-guard]]`);
    await screen.findByTestId('md-link-knowledge-bom-guard');
    await waitFor(() => expect(screen.getByTestId('md-link-knowledge-bom-guard')).toHaveAttribute('data-link-state', 'ok'));
    expect(screen.getByTestId('md-link-knowledge-bom-guard').textContent).toContain('bom-guard');

    await userEvent.click(screen.getByTestId('md-link-knowledge-bom-guard'));
    expect(usePanelStore.getState()).toMatchObject({
      view: 'ref',
      refPanel: { kind: 'knowledge', id: 'kp-common', title: 'BOM 守卫' },
    });
  });

  it('[[slug|别名]] 显示别名并跳 slug；[[slug#h]] 归一到页级；resolve 歧义 → 灰文本', async () => {
    server.use(http.get('/api/knowledge/resolve', ({ request }) => {
      const ref = new URL(request.url).searchParams.get('ref');
      if (ref === 'alias-page') return HttpResponse.json(resolvedRef({ id: 'kp-alias', title: '别名页' }));
      return new HttpResponse(null, { status: 409 });
    }));
    renderMarkdown(`一 [[alias-page|看这个]] 二 [[alias-page#章节]]`);
    // 两个 wikilink 的 href 都归一到 knowledge:alias-page（heading 只展示）→ 同名 testid 两个元素
    await waitFor(() => {
      const nodes = screen.getAllByTestId('md-link-knowledge-alias-page');
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toHaveAttribute('data-link-state', 'ok');
    });
    expect(screen.getAllByTestId('md-link-knowledge-alias-page')[0]!.textContent).toContain('看这个');
    await userEvent.click(screen.getAllByTestId('md-link-knowledge-alias-page')[0]!);
    expect(usePanelStore.getState()).toMatchObject({ refPanel: { kind: 'knowledge', id: 'kp-alias' } });
  });

  it('代码块与行内代码里的 [[...]] 不转换', async () => {
    renderMarkdown('行内 `[[not-a-link]]` 与：\n\n```\n[[still-not-a-link]]\n```');
    expect(screen.queryByTestId('md-link-knowledge-not-a-link')).toBeNull();
    expect(screen.queryByTestId('md-link-knowledge-still-not-a-link')).toBeNull();
    await waitFor(() => expect(document.body.textContent).toContain('[[not-a-link]]'));
    expect(document.body.textContent).toContain('[[still-not-a-link]]');
  });

  it('未命中 slug：resolve 404 → 灰文本降级（不静默打开错页）', async () => {
    server.use(http.get('/api/knowledge/resolve', () => new HttpResponse(null, { status: 404 })));
    renderMarkdown(`见 [[missing-page]]`);
    const node = await screen.findByTestId('md-link-knowledge-missing-page');
    await waitFor(() => expect(node).toHaveAttribute('data-link-state', 'denied'));
  });
});
