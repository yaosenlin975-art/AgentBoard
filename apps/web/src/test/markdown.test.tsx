/**
 * 统一 markdown 渲染（MD-COMMENT）：GFM 语义（表格 / 任务列表 / 删除线）+ 代码高亮 + 原始 HTML 字面量。
 * MarkdownView 走 React.lazy：首屏先渲染纯文本 fallback，再切成真实结构 —— 用例一律等待真实元素出现。
 * 评论、详情描述、工作区日志共用同一实现，任一处退回裸 react-markdown 都会让这些断言失败。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MarkdownView } from '../lib/markdown';

const FULL = [
  '## 标题二',
  '',
  '段落 **粗体** *斜体* `行内代码` ~~删除线~~ [链接](https://example.com)。',
  '',
  '| 名称 | 数量 |',
  '| --- | ---: |',
  '| 甲 | 1 |',
  '',
  '- [ ] 未完成',
  '- [x] 已完成',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '<div class="raw-html-probe">原始 HTML</div>',
].join('\n');

/** 等懒加载 chunk 落地：以 table 出现作为「真实渲染完成」的信号 */
async function renderFull() {
  const utils = render(<MarkdownView>{FULL}</MarkdownView>);
  await waitFor(() => expect(utils.container.querySelector('table')).not.toBeNull(), { timeout: 5000 });
  return utils;
}

describe('MarkdownView（GFM + 高亮，懒加载）', () => {
  it('懒加载期间先渲染纯文本 fallback，不闪空白', () => {
    const { container } = render(<MarkdownView>{FULL}</MarkdownView>);
    const fallback = container.querySelector('[data-testid="markdown-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('标题二');
  });

  it('表格渲染为真实 table/th/td，而不是管道字面量', async () => {
    const { container } = await renderFull();
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
    expect(container.textContent).not.toContain('| --- |');
  });

  it('任务列表渲染为 checkbox，已完成项被勾选', async () => {
    const { container } = await renderFull();
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect(container.querySelectorAll('li.task-list-item')).toHaveLength(2);
    expect(container.textContent).not.toContain('[ ]');
  });

  it('删除线渲染为 del 元素', async () => {
    const { container } = await renderFull();
    expect(container.querySelectorAll('del')).toHaveLength(1);
    expect(container.querySelector('del')?.textContent).toBe('删除线');
    expect(container.textContent).not.toContain('~~删除线~~');
  });

  it('围栏代码块带 highlight.js 高亮类', async () => {
    const { container } = await renderFull();
    expect(container.querySelector('pre code')).not.toBeNull();
    expect(container.querySelectorAll('pre code.hljs')).toHaveLength(1);
  });

  it('原始 HTML 保持字面量（不渲染、不执行）', async () => {
    const { container } = await renderFull();
    expect(container.querySelector('.raw-html-probe')).toBeNull();
    expect(container.textContent).toContain('<div class="raw-html-probe">');
  });

  it('compact 档与自定义 className 落到容器上，且容器始终带 markdown-body', async () => {
    const { container } = render(<MarkdownView compact className="rounded border">{'文字'}</MarkdownView>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('markdown-body');
    expect(root.className).toContain('markdown-body-compact');
    expect(root.className).toContain('rounded');
    await waitFor(() => expect(screen.getByText('文字')).toBeInTheDocument());
  });
});

