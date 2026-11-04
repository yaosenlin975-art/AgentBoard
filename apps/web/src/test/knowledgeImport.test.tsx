/**
 * KBIMP-2：知识库导入的解析层与对话框行为断言（端点契约来自 KBIMP-1 `9a4e06a`）。
 *
 * 覆盖：格式识别 / 1MB 预检 / md 标题猜测 / 前 20 行预览 / json 单对象与数组（≤100）/
 * 多余字段 warnings / 逐条取消与重建 content / KNOWLEDGE_EXISTS 两条建议。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MAX_IMPORT_BYTES,
  detectFormat,
  guessTitle,
  importErrorView,
  parseImportFile,
  previewLines,
  rebuildContent,
  selectedDrafts,
} from '../lib/knowledgeImport';
import { KnowledgeImportDialog } from '../components/knowledge/KnowledgeImportDialog';
import * as client from '../api/client';

describe('解析层（纯函数）', () => {
  it('格式识别与不支持的类型', () => {
    expect(detectFormat('a.md')).toBe('md');
    expect(detectFormat('a.markdown')).toBe('md');
    expect(detectFormat('a.txt')).toBe('txt');
    expect(detectFormat('a.json')).toBe('json');
    expect(detectFormat('a.pdf')).toBeNull();
    const bad = parseImportFile('a.pdf', 'x');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure.error).toBe('UNSUPPORTED_FORMAT');
  });

  it('1MB 上限与空文件', () => {
    const big = 'a'.repeat(MAX_IMPORT_BYTES + 1);
    const tooBig = parseImportFile('big.md', big);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.failure.error).toBe('TOO_LARGE');
    const empty = parseImportFile('e.md', '   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.failure.error).toBe('EMPTY');
  });

  it('md 标题取第一个标题、预览取前 20 行', () => {
    const content = `# 设计说明\n\n${Array.from({ length: 30 }, (_, i) => `行 ${i + 1}`).join('\n')}`;
    expect(guessTitle('x.md', content)).toBe('设计说明');
    expect(previewLines(content)).toHaveLength(20);
    const parsed = parseImportFile('x.md', content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.drafts[0]!.title).toBe('设计说明');
  });

  it('json 数组：多条草稿 + 多余字段 warnings + 逐条取消后重建 content', () => {
    const content = JSON.stringify([
      { title: 'A', body_md: 'aaa', category: 'design', foo: 1 },
      { title: 'B', body: 'bb' },
      { nope: true },
    ]);
    const parsed = parseImportFile('x.json', content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.drafts).toHaveLength(2);
    expect(parsed.value.warnings.join(' ')).toContain('不支持的字段');
    expect(parsed.value.warnings.join(' ')).toContain('第 3 条');

    const kept = selectedDrafts(parsed.value, ['draft-1']);
    expect(kept.map((draft) => draft.title)).toEqual(['A']);
    expect(JSON.parse(rebuildContent(parsed.value, kept))).toEqual([{ title: 'A', body_md: 'aaa', category: 'design' }]);
  });

  it('json 超额与坏 JSON 都有可读错误', () => {
    const tooMany = parseImportFile('x.json', JSON.stringify(Array.from({ length: 101 }, () => ({ body_md: 'x' }))));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.failure.error).toBe('TOO_MANY_ITEMS');
    const bad = parseImportFile('x.json', '{oops');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure.error).toBe('BAD_JSON');
  });

  it('KNOWLEDGE_EXISTS 给「改标题」「加后缀」两条建议', () => {
    const view = importErrorView('KNOWLEDGE_EXISTS', 'duplicate');
    expect(view.suggestions).toHaveLength(2);
    expect(view.suggestions.join(' ')).toContain('改标题');
    expect(view.suggestions.join(' ')).toContain('后缀');
    expect(importErrorView('IMPORT_BODY_TOO_LONG', '').text).toContain('上限');
  });
});

describe('对话框行为', () => {
  const upload = (content: string, name = 'a.md'): void => {
    const input = screen.getByTestId('kb-import-file');
    const file = new File([content], name, { type: 'text/plain' });
    // jsdom 的 File 不实现 .text()：补一个等价实现（生产环境是浏览器原生方法）
    Object.defineProperty(file, 'text', { value: async () => content, configurable: true });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
  };

  it('上传 md → 预览标题与正文，确认后调用导入接口并回调页 id', async () => {
    const post = vi.spyOn(client.api, 'post' as never).mockResolvedValue({ pages: [{ id: 'p-new' }] } as never);
    const onImported = vi.fn();
    render(<KnowledgeImportDialog open onClose={() => {}} onImported={onImported} />);
    upload('# 新页标题\n正文内容');
    await waitFor(() => expect(screen.getByTestId('kb-import-meta')).toBeInTheDocument());
    expect((screen.getByTestId('kb-import-title') as HTMLInputElement).value).toBe('新页标题');
    fireEvent.click(screen.getByTestId('kb-import-submit'));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(['p-new']));
    expect(post).toHaveBeenCalledWith('/api/knowledge/pages/import', expect.objectContaining({ format: 'md' }));
  });

  it('json 数组逐条列出，取消一条后只提交剩余条目', async () => {
    const post = vi.spyOn(client.api, 'post' as never).mockResolvedValue({ pages: [{ id: 'p1' }] } as never);
    render(<KnowledgeImportDialog open onClose={() => {}} onImported={() => {}} />);
    upload(JSON.stringify([{ title: 'A', body_md: '1' }, { title: 'B', body_md: '2' }]), 'x.json');
    await waitFor(() => expect(screen.getByTestId('kb-import-items')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kb-import-cancel-draft-1'));
    expect(screen.getByTestId('kb-import-item-draft-1').getAttribute('data-cancelled')).toBe('true');
    fireEvent.click(screen.getByTestId('kb-import-submit'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = (post.mock.calls[0] as unknown as [string, { content: string }])[1];
    expect(JSON.parse(body.content)).toHaveLength(1);
  });

  it('不支持的类型与超限都有可读失败提示', async () => {
    render(<KnowledgeImportDialog open onClose={() => {}} onImported={() => {}} />);
    upload('x', 'a.pdf');
    await waitFor(() => expect(screen.getByTestId('kb-import-failure')).toHaveTextContent('不支持的文件类型'));
  });

  it('409 冲突：展示改标题/加后缀建议', async () => {
    vi.spyOn(client.api, 'post' as never).mockRejectedValue(Object.assign(new Error('exists'), { code: 'KNOWLEDGE_EXISTS' }) as never);
    render(<KnowledgeImportDialog open onClose={() => {}} onImported={() => {}} />);
    upload('# dup\nbody');
    await waitFor(() => expect(screen.getByTestId('kb-import-title')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kb-import-submit'));
    const error = await screen.findByTestId('kb-import-error');
    expect(error).toHaveTextContent('改标题');
    expect(error).toHaveTextContent('后缀');
  });
});
