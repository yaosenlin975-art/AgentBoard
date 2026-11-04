/**
 * BORROW-1.2：UI 基元（EmptyState / ErrorState / Skeleton）与 errorCodeText。
 * 锁三件事：空态=说明+下一步、错误码转中文不裸奔、骨架行只做真实加载画法。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Skeleton } from '../components/ui/Skeleton';
import { errorCodeText, errorText } from '../lib/errorCodeText';
import { ApiError } from '../api/client';

describe('errorCodeText / errorText', () => {
  it('登记过的码转中文，未登记的码原样保留', () => {
    expect(errorCodeText('TASK_NOT_FOUND')).toBe('任务不存在');
    expect(errorCodeText('STALE_FENCE')).toContain('重新领取');
    expect(errorCodeText('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
  });

  it('errorText：ApiError 码优先转中文；普通 Error 保留 message；字符串透传；兜底', () => {
    expect(errorText(new ApiError('任务不存在', 'TASK_NOT_FOUND', 404))).toBe('任务不存在');
    expect(errorText(new ApiError('内部细节', 'SOME_FUTURE_CODE', 500))).toBe('内部细节');
    expect(errorText(new Error('网络断了'))).toBe('网络断了');
    expect(errorText('直接文案')).toBe('直接文案');
    expect(errorText(undefined, '兜底文案')).toBe('兜底文案');
  });
});

describe('EmptyState 基元', () => {
  it('说明 + 下一步动作 + testId 锚点', () => {
    render(<EmptyState testId="x-empty" title="暂无任务" hint="把卡片拖到本列" />);
    expect(screen.getByTestId('x-empty')).toBeInTheDocument();
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
    expect(screen.getByText('把卡片拖到本列')).toBeInTheDocument();
  });

  it('hint 可省略；compact 为小高度变体', () => {
    const { rerender } = render(<EmptyState title="暂无" />);
    expect(screen.queryByText(/拖|新建/)).not.toBeInTheDocument();
    rerender(<EmptyState title="暂无" compact />);
    expect(screen.getByText('暂无').parentElement?.className).toContain('py-4');
  });
});

describe('ErrorState 基元', () => {
  it('role=alert；ApiError 码转中文；prefix 拼语境', () => {
    render(<ErrorState error={new ApiError('任务不存在', 'TASK_NOT_FOUND', 404)} prefix="加载任务树" testId="e1" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('e1')).toHaveTextContent('加载任务树：任务不存在');
  });

  it('message 直传（RefPanel 404/403 特判文案场景）；纯文本渲染，URL 无 <a>（V-02）', () => {
    render(<ErrorState message="无权限或不存在" testId="e2" />);
    expect(screen.getByTestId('e2')).toHaveTextContent('无权限或不存在');
    render(<ErrorState message="请求失败：http://127.0.0.1:8787/api/xxx?token=abc" testId="e3" />);
    expect(screen.getByTestId('e3').querySelectorAll('a')).toHaveLength(0);
  });

  it('onDismiss 渲染关闭按钮并可点击', () => {
    const onDismiss = vi.fn();
    render(<ErrorState message="失败" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('Skeleton 基元', () => {
  it('testid 落在 ul；rows 控制行数；pulse 只在 li 上', () => {
    render(<Skeleton testId="s1" rows={3} />);
    const ul = screen.getByTestId('s1');
    expect(ul.tagName).toBe('UL');
    expect(ul.querySelectorAll('li')).toHaveLength(3);
    expect(ul.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });

  it('closest("ul") 兼容既有 knowledge-skeleton 断言（rounded-2xl）', () => {
    render(<Skeleton testId="knowledge-skeleton" rows={3} />);
    expect(screen.getByTestId('knowledge-skeleton').closest('ul')?.className).toContain('rounded-2xl');
  });
});
