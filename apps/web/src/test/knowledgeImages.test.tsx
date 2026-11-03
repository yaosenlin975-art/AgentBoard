/**
 * KB-IMG-3：正文图片渲染（限宽 + 失败兜底）、打印适配、导出绝对地址。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '../lib/markdown';
import { MarkdownImage } from '../lib/markdownRenderer';
import { absolutizeImageUrls, buildKnowledgeMarkdown } from '../lib/knowledgeExport';
import type { KnowledgePage } from '@agentboard/shared';

const page = (body: string): KnowledgePage => ({
  id: 'p1',
  scope: 'workspace',
  workspace_id: 'A',
  slug: 'p1',
  title: '图文页',
  body_md: body,
  status: 'active',
  revision: 2,
  expires_at: null,
  created_by: 'u',
  updated_by: 'u',
  created_at: 1,
  updated_at: 2,
  sources: [],
  evidence: [],
});

describe('正文图片渲染（KB-IMG-3）', () => {
  it('图片带 max-width:100% 不撑破版面，alt 保留', () => {
    // 直接渲染图片组件：jsdom 会立刻对不可达 src 触发 error，故同步取 DOM 断言属性契约
    const { container } = render(<MarkdownImage src="/api/knowledge/images/img1" alt="大图" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/knowledge/images/img1');
    expect(img.getAttribute('alt')).toBe('大图');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.style.maxWidth).toBe('100%');
    expect(img.className).toContain('max-w-full');
    expect(img.className).toContain('h-auto');
  });

  it('加载失败 → 占位块并显示 alt 文本（可读兜底）', async () => {
    render(<MarkdownView>{'![透明图标](/api/knowledge/images/broken)'}</MarkdownView>);
    const img = await screen.findByTestId('md-image');
    fireEvent.error(img);
    const fallback = await screen.findByTestId('md-image-fallback');
    expect(fallback).toHaveTextContent('透明图标（加载失败）');
    expect(fallback.getAttribute('aria-label')).toContain('图片加载失败');
    expect(screen.queryByTestId('md-image')).toBeNull();
  });

  it('没有 alt 时用「图片」兜底文案', async () => {
    render(<MarkdownView>{'![](/api/knowledge/images/x)'}</MarkdownView>);
    fireEvent.error(await screen.findByTestId('md-image'));
    expect(await screen.findByTestId('md-image-fallback')).toHaveTextContent('图片（加载失败）');
  });
});

describe('导出 Markdown 的图片处理（KB-IMG-3：绝对地址 + 说明）', () => {
  it('站内图片 URL 改绝对地址，并附「需登录可见」说明', () => {
    const markdown = buildKnowledgeMarkdown(page('正文\n\n![图](/api/knowledge/images/abc?w=1)\n'), {
      workspaceName: 'A',
      exportedAt: 0,
      imageBaseUrl: 'https://board.example.com',
    });
    expect(markdown).toContain('![图](https://board.example.com/api/knowledge/images/abc?w=1)');
    expect(markdown).toContain('需登录本看板后在同一浏览器中打开链接才能显示');
  });

  it('外链图片与正文其它内容不动；无站内图片时不加说明', () => {
    const markdown = buildKnowledgeMarkdown(page('![外链](https://cdn.example.com/a.png)'), { exportedAt: 0, imageBaseUrl: 'https://board.example.com' });
    expect(markdown).toContain('![外链](https://cdn.example.com/a.png)');
    expect(markdown).not.toContain('需登录本看板');
  });

  it('absolutizeImageUrls：只改站内图片路径，空 base 原样返回', () => {
    expect(absolutizeImageUrls('![a](/api/knowledge/images/1) ![b](https://x/y.png)', 'https://h')).toBe(
      '![a](https://h/api/knowledge/images/1) ![b](https://x/y.png)',
    );
    expect(absolutizeImageUrls('![a](/api/knowledge/images/1)', '')).toBe('![a](/api/knowledge/images/1)');
    expect(absolutizeImageUrls('![a](/api/knowledge/images/1)', 'https://h/')).toBe('![a](https://h/api/knowledge/images/1)');
  });
});
