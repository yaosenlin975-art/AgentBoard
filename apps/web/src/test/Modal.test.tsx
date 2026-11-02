/**
 * Modal 居中契约（DIALOG-CENTER）：
 * - 通过 portal 挂到 document.body，避免祖先 transform（如侧栏 translate-x-0）成为 fixed 包含块导致偏到左上；
 * - overlay 用 fixed inset-0 + flex 居中；
 * - 移除工作空间弹窗的两个按钮：whitespace-nowrap + 最小宽度，文字不被折行。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Modal } from '../components/ui/Modal';
import { RemoveWorkspaceDialog } from '../components/workspace/RemoveWorkspaceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

describe('Modal 居中与层叠（DIALOG-CENTER）', () => {
  it('挂在 document.body（不受祖先 transform 影响），overlay 为 fixed 全屏 flex 居中', () => {
    render(
      <div style={{ transform: 'translateX(0)', width: 220 }}>
        <Modal open title="测试弹窗" onClose={vi.fn()}>
          <p>内容</p>
        </Modal>
      </div>,
    );
    const overlay = screen.getByTestId('modal-overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toContain('fixed');
    expect(overlay.className).toContain('inset-0');
    expect(overlay.className).toContain('items-center');
    expect(overlay.className).toContain('justify-center');
    // 祖先容器里不应再有 overlay
    expect(overlay.closest('div[style]')).toBeNull();
  });

  it('移除工作空间弹窗：两个按钮单行不换行且有最小宽度，弹窗可滚动', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RemoveWorkspaceDialog
          open
          workspace={{ id: 'ws-1', name: '主项目', path: 'D:\\demo', created_at: 1 }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole('dialog', { name: '移除工作空间' });
    expect(dialog.className).toContain('overflow-y-auto');
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '移除工作空间' });
    for (const button of [cancel, confirm]) {
      expect(button.className).toContain('whitespace-nowrap');
      expect(button.className).toMatch(/min-w-\[[0-9.]+rem\]/);
    }
  });
});
