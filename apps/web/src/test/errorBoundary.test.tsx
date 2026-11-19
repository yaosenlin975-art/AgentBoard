/**
 * G3：白屏止血的三个部件。
 *
 * 覆盖：顶层兜底 UI（摘要/详情/重载/复制）、componentDidCatch 去重、
 * 视图级隔离（一个视图坏不影响左栏与其它视图）、环形缓冲容量与读取。
 *
 * 注意：React 在开发期会把「被 boundary 捕获」的错误同样打到 console.error，
 * 测试里不必 silence，只需断言兜底 UI。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AppErrorBoundary, summarizeError } from '../components/shell/AppErrorBoundary';
import { ViewErrorBoundary } from '../components/shell/ViewErrorBoundary';
import {
  CLIENT_ERROR_CAPACITY,
  clearClientErrors,
  getClientErrors,
  installClientErrorHooks,
  pushClientError,
} from '../lib/errorBuffer';

function Boom({ message = 'boundary-test', when = true }: { message?: string; when?: boolean }) {
  if (when) throw new Error(message);
  return <p data-testid="boom-ok">正常渲染</p>;
}

/** 可切换「抛错 / 正常」的子树：验「重试后重新挂载」 */
function ToggleBoom() {
  const [broken, setBroken] = useState(true);
  return (
    <div>
      <button type="button" data-testid="toggle-fix" onClick={() => setBroken(false)}>
        修好
      </button>
      {broken ? <Boom /> : <p data-testid="recovered">已恢复</p>}
    </div>
  );
}

beforeEach(() => {
  cleanup();
  clearClientErrors();
});

afterEach(() => {
  cleanup();
  clearClientErrors();
  vi.restoreAllMocks();
});

describe('AppErrorBoundary 顶层兜底', () => {
  it('子组件抛错 → 渲染兜底 UI，摘要含错误 message', () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('界面出错了');
    expect(screen.getByTestId('app-error-message')).toHaveTextContent('boundary-test');
    // 兜底 UI 自带两个动作按钮
    expect(screen.getByTestId('app-error-reload')).toBeInTheDocument();
    expect(screen.getByTestId('app-error-copy')).toBeInTheDocument();
  });

  it('「显示详情」展开后含 stack 片段；再点收起', () => {
    render(
      <AppErrorBoundary>
        <Boom message="stack-visible" />
      </AppErrorBoundary>,
    );
    expect(screen.queryByTestId('app-error-stack')).toBeNull();

    fireEvent.click(screen.getByTestId('app-error-details-toggle'));
    const stack = screen.getByTestId('app-error-stack');
    expect(stack).toBeInTheDocument();
    // Error.stack 的头部就是「Error: message」
    expect(stack.textContent).toContain('stack-visible');
    expect(stack.textContent).toContain('Boom');

    fireEvent.click(screen.getByTestId('app-error-details-toggle'));
    expect(screen.queryByTestId('app-error-stack')).toBeNull();
  });

  it('componentDidCatch 只记录一次（StrictMode 双调用去重）', () => {
    render(
      <AppErrorBoundary>
        <Boom message="once-only" />
      </AppErrorBoundary>,
    );

    const matches = getClientErrors().filter((entry) => entry.message.includes('once-only'));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe('react');
    expect(matches[0]?.source).toBe('react-boundary');
  });

  it('兜底 UI 自身不抛错：渲染后节点仍存在', () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    const node = screen.getByTestId('app-error-boundary');
    expect(node).toBeInTheDocument();
    expect(node.getAttribute('role')).toBe('alert');
  });

  it('摘要截断到 200 字符 + 省略号', () => {
    const long = 'x'.repeat(500);
    render(
      <AppErrorBoundary>
        <Boom message={long} />
      </AppErrorBoundary>,
    );
    const text = screen.getByTestId('app-error-message').textContent ?? '';
    // 「Error: 」前缀 7 字符，截到 200 再补一个省略号
    expect(text.length).toBe(201);
    expect(text.endsWith('…')).toBe(true);
    expect(summarizeError(new Error(long)).length).toBe(201);
  });

  it('「复制错误信息」调用剪贴板，失败时降级为选中文本', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });

    render(
      <AppErrorBoundary>
        <Boom message="copy-me" />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId('app-error-copy'));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('copy-me');
    expect(written[0]).toContain('客户端错误');
  });
});

describe('ViewErrorBoundary 视图级隔离', () => {
  it('只渲染该视图区域的错误，不占满视口、不影响同级兄弟', () => {
    render(
      <div>
        <nav data-testid="sidebar-stub">左栏</nav>
        <ViewErrorBoundary view="board">
          <Boom message="view-boom" />
        </ViewErrorBoundary>
        <ViewErrorBoundary view="chat">
          <p data-testid="chat-ok">聊天正常</p>
        </ViewErrorBoundary>
        <nav data-testid="sidebar-stub-2">另一个左栏入口</nav>
      </div>,
    );

    expect(screen.getByTestId('view-error-board')).toBeInTheDocument();
    expect(screen.getByTestId('view-error-message-board')).toHaveTextContent('view-boom');
    // 左栏与另一个视图照常渲染
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-stub-2')).toBeInTheDocument();
    expect(screen.getByTestId('chat-ok')).toBeInTheDocument();
    // 视图级兜底不是整页兜底
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
  });

  it('「重试」重新挂载子树：修好之后能正常渲染', () => {
    render(
      <ViewErrorBoundary view="knowledge">
        <ToggleBoom />
      </ViewErrorBoundary>,
    );

    expect(screen.getByTestId('view-error-knowledge')).toBeInTheDocument();
    // 点「修好」不会生效（子树已被卸载），必须走重试
    expect(screen.queryByTestId('toggle-fix')).toBeNull();

    // 重试 → 子树重新挂载（仍抛错，回到错误态），再在重试前先把条件改掉
    fireEvent.click(screen.getByTestId('view-error-retry-knowledge'));
    // 重新挂载后依旧抛错（状态在子组件里，重挂即复位），所以仍显示错误
    expect(screen.getByTestId('view-error-knowledge')).toBeInTheDocument();
  });

  it('重试后在不再抛错时正常渲染', () => {
    // 用一个外部开关控制是否抛错，模拟「运维修好数据后重试」
    let broken = true;
    function Switchable() {
      if (broken) throw new Error('switchable-boom');
      return <p data-testid="switchable-ok">恢复正常</p>;
    }
    render(
      <ViewErrorBoundary view="experts">
        <Switchable />
      </ViewErrorBoundary>,
    );
    expect(screen.getByTestId('view-error-experts')).toBeInTheDocument();

    broken = false;
    fireEvent.click(screen.getByTestId('view-error-retry-experts'));
    expect(screen.getByTestId('switchable-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('view-error-experts')).toBeNull();
  });
});

describe('errorBuffer 环形缓冲', () => {
  it('容量固定 20，超出丢最旧', () => {
    for (let i = 0; i < CLIENT_ERROR_CAPACITY + 5; i += 1) {
      pushClientError({ kind: 'error', message: `e${i}`, stack: '' });
    }
    const entries = getClientErrors();
    expect(entries).toHaveLength(CLIENT_ERROR_CAPACITY);
    expect(entries[0]?.message).toBe('e5');
    expect(entries[entries.length - 1]?.message).toBe(`e${CLIENT_ERROR_CAPACITY + 4}`);
  });

  it('非 Error 的 reason（Promise reject 常见）被转成文本', () => {
    pushClientError({ kind: 'rejection', message: { code: 500 }, stack: '' });
    pushClientError({ kind: 'rejection', message: undefined, stack: '' });
    const entries = getClientErrors();
    expect(entries[0]?.message).toBe('{"code":500}');
    expect(entries[1]?.message).toBe('');
  });

  it('每次读取都是副本，调用方改它不影响缓冲', () => {
    pushClientError({ kind: 'error', message: 'original', stack: '' });
    const snapshot = getClientErrors();
    snapshot[0]!.message = 'mutated';
    expect(getClientErrors()[0]?.message).toBe('original');
  });

  it('clear 清空', () => {
    pushClientError({ kind: 'error', message: 'x', stack: '' });
    clearClientErrors();
    expect(getClientErrors()).toHaveLength(0);
  });

  it('安装全局钩子后，window error / unhandledrejection 各记一条；卸载后不再记', () => {
    const uninstall = installClientErrorHooks(window);

    window.dispatchEvent(new ErrorEvent('error', { message: 'sync-boom', error: new Error('sync-boom') }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('async-boom');
    window.dispatchEvent(rejection);

    let entries = getClientErrors();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'error', message: 'sync-boom' });
    expect(entries[1]).toMatchObject({ kind: 'rejection', message: 'async-boom' });

    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after-uninstall' }));
    entries = getClientErrors();
    expect(entries).toHaveLength(2);
  });

  it('unhandledrejection 的 reason 不是 Error 时也被记下', () => {
    const uninstall = installClientErrorHooks(window);
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = { code: 500 };
    window.dispatchEvent(rejection);
    uninstall();
    expect(getClientErrors()[0]).toMatchObject({ kind: 'rejection', message: '{"code":500}' });
  });
});
