/**
 * P2-03：详情页嵌入渲染——splitKnowledgeBody 纯函数 + KnowledgeBodyView 组件。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from './server';
import { attachmentNameOf, imageSegmentToMarkdown, splitKnowledgeBody, KnowledgeBodyView } from '../components/knowledge/knowledgeEmbed';

describe('splitKnowledgeBody（纯函数）', () => {
  it('切段：md / 图片 / 页嵌入', () => {
    const segments = splitKnowledgeBody('前言\n![[_attachments/x.png]]\n中段\n![[目标页]]\n尾部');
    expect(segments).toEqual([
      { kind: 'md', text: '前言\n' },
      { kind: 'image', name: 'x.png', raw: '![[_attachments/x.png]]' },
      { kind: 'md', text: '\n中段\n' },
      { kind: 'page', target: '目标页', raw: '![[目标页]]' },
      { kind: 'md', text: '\n尾部\n' },
    ]);
  });

  it('代码块内的 ![[...]] 不切段（fence 感知）', () => {
    const segments = splitKnowledgeBody('```md\n![[inside]]\n```\n![[outside]]');
    expect(segments.filter(segment => segment.kind !== 'md')).toEqual([{ kind: 'page', target: 'outside', raw: '![[outside]]' }]);
  });

  it('别名/锚点归一到目标（alias 通道丢弃）', () => {
    const segments = splitKnowledgeBody('![[目标页|显示名]] 与 ![[目标页#节]]');
    expect(segments.filter(segment => segment.kind === 'page')).toEqual([
      { kind: 'page', target: '目标页', raw: '![[目标页|显示名]]' },
      { kind: 'page', target: '目标页', raw: '![[目标页#节]]' },
    ]);
  });

  it('attachmentNameOf：相对路径取 basename 归一', () => {
    expect(attachmentNameOf('_attachments/a/b.png')).toBe('b.png');
    expect(attachmentNameOf('x.png')).toBe('x.png');
  });

  it('imageSegmentToMarkdown：带 scope 鉴权参数', () => {
    expect(imageSegmentToMarkdown('x.png', 'workspace', 'ws-1'))
      .toBe('![x.png](/api/knowledge/attachments/x.png?scope=workspace&workspace_id=ws-1)');
    expect(imageSegmentToMarkdown('x.png', 'common', null))
      .toBe('![x.png](/api/knowledge/attachments/x.png?scope=common)');
  });
});

function mount(body: string, scope: 'workspace' | 'common' = 'workspace', workspaceId: string | null = 'ws-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KnowledgeBodyView body={body} scope={scope} workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

describe('KnowledgeBodyView（组件）', () => {
  it('图片段转换为附件端点 URL（MarkdownImage 渲染契约由 knowledgeImages.test.tsx 覆盖）', () => {
    // splitKnowledgeBody 正确产出 image 段 + imageSegmentToMarkdown 带鉴权参数 = 渲染链路的输入契约
    const segments = splitKnowledgeBody('见 ![[_attachments/x.png]]');
    expect(segments[0]).toEqual({ kind: 'md', text: '见 ' });
    expect(segments[1]).toEqual({ kind: 'image', name: 'x.png', raw: '![[_attachments/x.png]]' });
    expect(imageSegmentToMarkdown('x.png', 'workspace', 'ws-1'))
      .toBe('![x.png](/api/knowledge/attachments/x.png?scope=workspace&workspace_id=ws-1)');
  });

  it('页嵌入块 resolve 成功后渲染目标页标题与正文', async () => {
    server.use(
      http.get('/api/knowledge/resolve', () => HttpResponse.json({ state: 'resolved', id: 'target-1', scope: 'workspace', workspace_id: 'ws-1', slug: 'target', title: '目标页', revision: 1, redirect_to: null })),
      http.get('/api/knowledge/pages/target-1', () => HttpResponse.json({ id: 'target-1', title: '目标页', body_md: '目标页正文', revision: 1, scope: 'workspace', workspace_id: 'ws-1' })),
    );
    mount('前文 ![[target]] 尾文');
    await waitFor(() => expect(screen.getByTestId('kb-embed-title')).toHaveTextContent('目标页'));
    expect(screen.getByTestId('kb-embed-block')).toHaveTextContent('目标页正文');
  });

  it('页嵌入 resolve 失败 → 未解析占位（不跳转、不崩溃）', async () => {
    server.use(http.get('/api/knowledge/resolve', () => HttpResponse.json({ state: 'not_found', message: '知识页不存在' })));
    mount('![[ghost]]');
    expect(await screen.findByTestId('kb-embed-missing')).toHaveTextContent('ghost');
  });
});
