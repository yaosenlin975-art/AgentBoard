import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from './server';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { KNOWLEDGE_SCOPE_KEY, resolveKnowledgeScope } from '../lib/knowledgeScope';

/** KB-SCOPE-DEFAULT：知识库默认范围 = 当前项目，用户切换后记住，无工作区退化为公共经验 */

function mount(workspaceId: string | null, workspaceName: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KnowledgePanel workspaceId={workspaceId} workspaceName={workspaceName} />
    </QueryClientProvider>,
  );
}

const scopeSelect = () => screen.getByLabelText('知识范围') as HTMLSelectElement;

beforeEach(() => {
  localStorage.clear();
  server.use(http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })));
});

describe('知识库默认范围（KB-SCOPE-DEFAULT）', () => {
  it('有工作区时默认选中「当前项目」，请求带 scope=workspace', async () => {
    let params: URLSearchParams | undefined;
    server.use(http.get('/api/knowledge/pages', ({ request }) => {
      params = new URL(request.url).searchParams;
      return HttpResponse.json({ items: [], next_offset: null });
    }));
    mount('ws-1', '任务看板');
    expect(scopeSelect().value).toBe('workspace');
    await waitFor(() => expect(params?.get('scope')).toBe('workspace'));
    expect(params?.get('workspace_id')).toBe('ws-1');
  });

  it('用户显式切换后记住选择，重开不再被拉回当前项目', async () => {
    const first = mount('ws-1');
    fireEvent.change(scopeSelect(), { target: { value: 'common' } });
    expect(localStorage.getItem(KNOWLEDGE_SCOPE_KEY)).toBe('common');

    first.unmount();
    mount('ws-1');
    expect(scopeSelect().value).toBe('common');

    // 「当前项目＋公共」同样被记住
    fireEvent.change(scopeSelect(), { target: { value: 'both' } });
    expect(localStorage.getItem(KNOWLEDGE_SCOPE_KEY)).toBe('both');
  });

  it('无工作区时退化为「公共经验」，并在空态说明退化原因', async () => {
    mount(null);
    expect(scopeSelect().value).toBe('common');
    const empty = await screen.findByTestId('knowledge-empty');
    expect(empty).toHaveTextContent('暂无知识');
    expect(empty).toHaveTextContent('未选择工作区');
    expect(empty).toHaveTextContent('公共经验');
    // 无工作区时不写入记忆，也不把非法范围带到下次
    expect(localStorage.getItem(KNOWLEDGE_SCOPE_KEY)).toBeNull();
  });

  it('项目范围空态说明当前项目名与可切换到全部', async () => {
    mount('ws-1', '任务看板');
    const empty = await screen.findByTestId('knowledge-empty');
    expect(empty).toHaveTextContent('当前范围是项目「任务看板」');
    expect(empty).toHaveTextContent('可切到「当前项目＋公共」');
  });
});

describe('resolveKnowledgeScope 存储口径', () => {
  const fake = (value: string | null) => ({ getItem: (key: string) => (key === KNOWLEDGE_SCOPE_KEY ? value : null) });

  it('记忆值非法/缺失时回落当前项目，无工作区恒为公共经验', () => {
    expect(resolveKnowledgeScope(true, fake(null))).toBe('workspace');
    expect(resolveKnowledgeScope(true, fake('bogus'))).toBe('workspace');
    expect(resolveKnowledgeScope(true, fake('common'))).toBe('common');
    expect(resolveKnowledgeScope(false, fake('workspace'))).toBe('common');
    expect(resolveKnowledgeScope(true, null)).toBe('workspace');
  });
});
