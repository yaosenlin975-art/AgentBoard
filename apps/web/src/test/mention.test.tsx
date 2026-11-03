import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { Composer } from '../components/chat/Composer';
import {
  detectMentionTrigger,
  fuzzyScore,
  insertMention,
  issueCandidates,
  rankMentionCandidates,
  skillCandidates,
} from '../lib/mention';

describe('mention 纯函数（触发 / 模糊匹配 / 插入）', () => {
  it('触发：行首与空白后的 / 触发技能，@ 触发任务', () => {
    expect(detectMentionTrigger('/mar', 4)).toEqual({ kind: 'skill', query: 'mar', start: 0, end: 4 });
    expect(detectMentionTrigger('看下 /mar', 7)).toEqual({ kind: 'skill', query: 'mar', start: 3, end: 7 });
    expect(detectMentionTrigger('看看 @缓存', 6)).toEqual({ kind: 'issue', query: '缓存', start: 3, end: 6 });
    expect(detectMentionTrigger('a\n/ka', 5)).toEqual({ kind: 'skill', query: 'ka', start: 2, end: 5 });
  });

  it('触发：词中 @ / （URL、邮箱）与 token 内空白都不触发', () => {
    expect(detectMentionTrigger('a/b', 3)).toBeNull();
    expect(detectMentionTrigger('mail@host', 9)).toBeNull();
    expect(detectMentionTrigger('/mar foo', 8)).toBeNull();
    expect(detectMentionTrigger('普通文本', 4)).toBeNull();
  });

  it('模糊匹配：前缀优先、子序列次之、不命中过滤；任务可用 id 命中', () => {
    expect(fuzzyScore('markdown-export', 'mar')?.matched).toBe('label');
    expect((fuzzyScore('markdown-export', 'mar')?.score ?? 0) > (fuzzyScore('mail-report', 'mar')?.score ?? 0)).toBe(true);
    expect(fuzzyScore('mcp-compressor', 'mar')).toBeNull();
    expect(fuzzyScore('patch', 'pth')?.matched).toBe('label');
    expect(fuzzyScore('修复登录', 'zz')).toBeNull();
    expect(fuzzyScore('任意标题', 'a1b2c3', 'a1b2c3d4-5678')?.matched).toBe('id');
  });

  it('排序：默认上限 50 条（CHAT-TRIGGER-8 由 8 放开）、同分按标题字典序', () => {
    const candidates = Array.from({ length: 80 }, (_, i) => ({
      id: `c${i}`,
      label: `候选 ${i}`,
      insert: `/${i}`,
    }));
    expect(rankMentionCandidates(candidates, '候选').length).toBe(50);
    // 显式传 limit 时仍受该值约束（调用方能力保留）
    expect(rankMentionCandidates(candidates, '候选', 12).length).toBe(12);
    const same = [
      { id: 'b', label: 'bbb', insert: '/b' },
      { id: 'a', label: 'aaa', insert: '/a' },
      { id: 'c', label: 'aaa', insert: '/c' },
    ];
    expect(rankMentionCandidates(same, '').map((x) => x.label)).toEqual(['aaa', 'aaa', 'bbb']);
  });

  it('插入：只替换触发区间、光标落在插入文本之后', () => {
    const trigger = detectMentionTrigger('看下 /mar 谢谢', 7)!;
    expect(insertMention('看下 /mar 谢谢', trigger, '/markdown-export')).toEqual({
      text: '看下 /markdown-export 谢谢',
      caret: '看下 /markdown-export'.length,
    });
    const at = detectMentionTrigger('@缓存', 3)!;
    expect(insertMention('@缓存', at, '@缓存策略').text).toBe('@缓存策略');
  });

  it('候选来源：技能插入 /name，任务插入 @标题且排除当前会话任务', () => {
    expect(skillCandidates([{ name: 'markdown-export', description: '导出' }])[0]).toEqual({
      id: 'markdown-export',
      label: 'markdown-export',
      hint: '导出',
      insert: '/markdown-export',
    });
    const issues = [
      { id: 'i1', title: '缓存策略' },
      { id: 'i2', title: '发布流程' },
    ];
    expect(issueCandidates(issues, 'i2').map((c) => c.insert)).toEqual(['@缓存策略']);
  });
});

const skills = [
  { name: 'markdown-export', description: '导出文档' },
  { name: 'mail-report', description: '报表' },
  { name: 'mcp-compressor', description: '压缩' },
];
const issues = [
  { id: 'i-cache', title: '缓存策略', workspace_id: 'A', status: '待规划', labels: [], priority: '中' },
  { id: 'i-release', title: '发布流程', workspace_id: 'A', status: '进行中', labels: [], priority: '中' },
];

function mountComposer(onSend = vi.fn(async () => {})) {
  server.use(
    http.get('/api/skills', () => HttpResponse.json({ items: skills })),
    http.get('/api/issues', () => HttpResponse.json(issues)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Composer disabled={false} running={false} queuedCount={0} workspaceId="A" onSend={onSend} />
    </QueryClientProvider>,
  );
  return onSend;
}

const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;

describe('Composer 联想输入（CHAT-MENTION）', () => {
  it('输入 /mar 弹出技能候选，上下键 + Enter 只确认候选不发送', async () => {
    const onSend = mountComposer();
    fireEvent.change(input(), { target: { value: '/mar' } });
    const popover = await screen.findByTestId('mention-popover');
    expect(popover).toHaveAttribute('data-kind', 'skill');
    // 前缀命中的两个候选（markdown-export 前缀优先）
    expect(screen.getByTestId('mention-item-0')).toHaveTextContent('markdown-export');
    expect(screen.getByTestId('mention-item-1')).toHaveTextContent('mail-report');

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('mention-item-1')).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input().value).toBe('/mail-report'));
    expect(onSend).not.toHaveBeenCalled(); // 浮窗打开时 Enter 不发送
    expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument();
  });

  it('输入 @ 弹出当前工作区任务候选，匹配标题片段，选中插入 @标题', async () => {
    const onSend = mountComposer();
    fireEvent.change(input(), { target: { value: '看下 @发布' } });
    const popover = await screen.findByTestId('mention-popover');
    expect(popover).toHaveAttribute('data-kind', 'issue');
    expect(screen.getByTestId('mention-item-0')).toHaveTextContent('发布流程');

    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input().value).toBe('看下 @发布流程'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('浮窗关闭时 Enter 正常发送消息', async () => {
    const onSend = mountComposer();
    fireEvent.change(input(), { target: { value: '普通消息' } });
    expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('普通消息'));
  });

  it('无匹配时浮窗关闭且不阻塞输入', async () => {
    mountComposer();
    fireEvent.change(input(), { target: { value: '/zzzzz' } });
    await waitFor(() => expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument());
    expect(input().value).toBe('/zzzzz');
  });

  it('Esc 关闭浮窗，不改变输入内容', async () => {
    mountComposer();
    fireEvent.change(input(), { target: { value: '/mar' } });
    await screen.findByTestId('mention-popover');
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument());
    expect(input().value).toBe('/mar');
  });

  it('鼠标点击候选同样插入，且不发送', async () => {
    const onSend = mountComposer();
    fireEvent.change(input(), { target: { value: '@缓存' } });
    const item = await screen.findByTestId('mention-item-0');
    fireEvent.mouseDown(item);
    await waitFor(() => expect(input().value).toBe('@缓存策略'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('IME 组合期间不触发浮窗（即使查询能命中），组合结束后按最终文本触发', async () => {
    mountComposer();
    // 先确认 /mar 本身能命中，避免「因为没匹配所以没弹窗」的假通过
    fireEvent.change(input(), { target: { value: '/mar' } });
    expect(await screen.findByTestId('mention-popover')).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: '' } });

    fireEvent.compositionStart(input());
    fireEvent.change(input(), { target: { value: '/mar' } });
    expect(input().value).toBe('/mar');
    expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument(); // 组合中不触发

    fireEvent.compositionEnd(input(), { target: { value: '/mar', selectionStart: 4 } });
    expect(await screen.findByTestId('mention-popover')).toBeInTheDocument(); // 组合结束后恢复
  });

  it('词中 / 与 @ 不触发（URL / 邮箱场景）', async () => {
    mountComposer();
    fireEvent.change(input(), { target: { value: '见 http://a/b 与 mail@host' } });
    await waitFor(() => expect(screen.queryByTestId('mention-popover')).not.toBeInTheDocument());
  });
});
