/**
 * Modal 焦点闭环（AUDIT-P1 / I-03）：
 * - 打开后焦点落在内容区首个可聚焦字段（跳过头部「关闭」按钮）；
 * - Tab / Shift+Tab 在 dialog 内闭环，背景可聚焦元素不可达；
 * - Esc / 取消 / 提交关闭后焦点回到触发按钮；
 * - 共用 Modal 实现让第二个弹窗同样生效，且不会重复聚焦。
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { Modal } from '../components/ui/Modal';
import { NewIssueDialog } from '../components/topbar/NewIssueDialog';
import { NewWorkspaceDialog } from '../components/workspace/NewWorkspaceDialog';
import { server } from './server';

function renderWithQuery(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function NewIssueHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="bg-trigger" onClick={() => setOpen(true)}>
        新建任务
      </button>
      <button data-testid="bg-other">背景其他按钮</button>
      <NewIssueDialog open={open} workspaceId="ws-1" onClose={() => setOpen(false)} />
    </>
  );
}

function NewWorkspaceHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="bg-trigger" onClick={() => setOpen(true)}>
        新增工作空间
      </button>
      <button data-testid="bg-other">背景其他按钮</button>
      <NewWorkspaceDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** dialog 内的 Tab 序列（与 Modal 实现同一选择器口径） */
function tabbablesIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])',
    ),
  );
}

describe('Modal 焦点闭环（AUDIT-P1 / I-03）', () => {
  it('验收 1：打开新建任务弹窗后 document.activeElement 是标题输入框', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewIssueHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    expect(document.activeElement).toBe(within(dialog).getByTestId('new-issue-title'));
  });

  it('验收 2：Tab / Shift+Tab 只在 dialog 内循环，背景可聚焦元素不可达', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewIssueHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    // 注意 DOM 顺序：头部「关闭」按钮在内容之前
    const items = tabbablesIn(dialog);
    const first = items[0]!;
    const last = items[items.length - 1]!;
    expect(items.length).toBeGreaterThan(1);

    // 最后一个元素 Tab → 回到 dialog 第一个（不落到背景）
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // 第一个元素 Shift+Tab → 回到 dialog 最后一个
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // 连续 Tab 多轮：始终留在 dialog 内，背景触发/其他按钮都不被聚焦到
    within(dialog).getByTestId('new-issue-title').focus();
    const bgTrigger = screen.getByTestId('bg-trigger');
    const bgOther = screen.getByTestId('bg-other');
    for (let i = 0; i < 15; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(bgTrigger);
      expect(document.activeElement).not.toBe(bgOther);
    }
  });

  it('验收 3：Esc 关闭后焦点回到触发按钮', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewIssueHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    expect(within(dialog).getByTestId('new-issue-title')).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('验收 3：取消关闭后焦点回到触发按钮', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewIssueHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('验收 3：提交关闭后焦点回到触发按钮', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/issues', () =>
        HttpResponse.json({
          id: 'iss-new',
          workspace_id: 'ws-1',
          title: '新任务',
          description: '',
          priority: '中',
          labels: [],
          status: '待规划',
          sort_order: 0,
          parent_issue_id: null,
          claimed_by: null,
          claimed_at: null,
          session_id: null,
          comment_count: 0,
          created_at: 1,
          updated_at: 1,
        }),
      ),
    );
    renderWithQuery(<NewIssueHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    await user.type(within(dialog).getByTestId('new-issue-title'), '新任务');
    // CARD-FACE（9bbffd8）起描述必填：不填会被客户端拦截，弹窗不会关闭
    await user.type(within(dialog).getByTestId('new-issue-description'), '目标：验证焦点闭环');
    await user.click(within(dialog).getByTestId('new-issue-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('验收 4：第二个使用 Modal 的弹窗（新增工作空间）同样首字段聚焦 / Tab 闭环 / 关闭归还', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NewWorkspaceHarness />);

    const trigger = screen.getByTestId('bg-trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '新增工作空间' });
    const nameInput = within(dialog).getByLabelText('工作空间名称');
    expect(document.activeElement).toBe(nameInput);

    // Tab 闭环：最后一个可聚焦元素 Tab 回到 dialog 第一个
    const items = tabbablesIn(dialog);
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增工作空间' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('共用实现只聚焦一次：首个字段仅收到一次 focus，Tab 移走后不被抢回', async () => {
    const user = userEvent.setup();
    const onFirstFocus = vi.fn();
    const onSecondFocus = vi.fn();
    renderWithQuery(
      <>
        <button data-testid="bg-trigger">背景按钮</button>
        <Modal open title="焦点计数" onClose={vi.fn()}>
          <input aria-label="字段一" onFocus={onFirstFocus} />
          <input aria-label="字段二" onFocus={onSecondFocus} />
        </Modal>
      </>,
    );

    const first = screen.getByLabelText('字段一');
    const second = screen.getByLabelText('字段二');
    expect(first).toHaveFocus();
    expect(onFirstFocus).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(second).toHaveFocus();
    // 焦点移到第二字段后没有被 Modal 抢回第一字段（没有重复聚焦）
    expect(first).not.toHaveFocus();
    expect(onFirstFocus).toHaveBeenCalledTimes(1);
    expect(onSecondFocus).toHaveBeenCalledTimes(1);
  });
});
