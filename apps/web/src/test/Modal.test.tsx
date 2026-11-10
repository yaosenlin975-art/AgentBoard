/**
 * Modal 居中契约（DIALOG-CENTER）：
 * - 通过 portal 挂到 document.body，避免祖先 transform（如侧栏 translate-x-0）成为 fixed 包含块导致偏到左上；
 * - overlay 用 fixed inset-0 + flex 居中；
 * - 移除工作空间弹窗的两个按钮：whitespace-nowrap + 最小宽度，文字不被折行。
 * SETTINGS-LAYOUT：placement=side 贴锚定面板右缘并排（无深色遮罩），放不下降级 right；嵌套 Esc 只关最上层。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../components/ui/Modal';
import { RemoveWorkspaceDialog } from '../components/workspace/RemoveWorkspaceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function stubViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
}

/** 造一个固定右缘的锚定元素（jsdom 没有真实布局，getBoundingClientRect 全 0） */
function stubAnchor(right: number): HTMLElement {
  const anchor = document.createElement('div');
  anchor.setAttribute('data-testid', 'settings-anchor');
  anchor.getBoundingClientRect = () => ({
    right, left: right - 540, top: 0, bottom: 900, width: 540, height: 900, x: right - 540, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
});

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

describe('Modal 并排落位（SETTINGS-LAYOUT）', () => {
  it('placement=side：贴在锚定面板右缘，无深色遮罩，hairline 分隔', () => {
    stubViewport(1440);
    const anchor = stubAnchor(788);
    try {
      render(
        <Modal open title="新建人设" onClose={vi.fn()} placement="side" anchorSelector='[data-testid="settings-anchor"]'>
          <p>内容</p>
        </Modal>,
      );
      const side = screen.getByTestId('modal-side');
      expect(side.style.left).toBe('788px');
      expect(side.style.width).toBe('480px');
      expect(screen.queryByTestId('modal-overlay')).toBeNull();
      const dialog = screen.getByRole('dialog', { name: '新建人设' });
      expect(dialog.className).toContain('border-l');
      expect(dialog.className).toContain('border-hairline');
    } finally {
      anchor.remove();
    }
  });

  it('剩余空间不足时自动降级为覆盖式右侧抽屉', () => {
    stubViewport(1024);
    const anchor = stubAnchor(788);
    try {
      render(
        <Modal open title="新建人设" onClose={vi.fn()} placement="side" anchorSelector='[data-testid="settings-anchor"]'>
          <p>内容</p>
        </Modal>,
      );
      expect(screen.queryByTestId('modal-side')).toBeNull();
      expect(screen.getByTestId('modal-overlay')).toBeInTheDocument();
    } finally {
      anchor.remove();
    }
  });

  it('找不到锚定元素时降级为覆盖式右侧抽屉', () => {
    stubViewport(1440);
    render(
      <Modal open title="新建人设" onClose={vi.fn()} placement="side" anchorSelector='[data-testid="missing-anchor"]'>
        <p>内容</p>
      </Modal>,
    );
    expect(screen.queryByTestId('modal-side')).toBeNull();
    expect(screen.getByTestId('modal-overlay')).toBeInTheDocument();
  });

  it('嵌套浮层：Esc 只关最上层', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <>
        <Modal open title="外层" onClose={outerClose}><p>外</p></Modal>
        <Modal open title="内层" onClose={innerClose}><p>内</p></Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});
