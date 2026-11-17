/**
 * G5：客户端错误上报接线。
 *
 * 覆盖卡面六项：恰好 1 次请求与字段完整、指纹去重、500 不重试、开关关闭 0 请求、
 * 超 10 条截断并留一条本地记录、sendBeacon 优先；外加 componentDidCatch 走同一路径。
 *
 * 这里注入 `send` 与 `resolveInstanceId`，不发真网络——真实落盘验证在测试页 + 临时端口服务上做。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppErrorBoundary } from '../components/shell/AppErrorBoundary';
import {
  clearClientErrors,
  getClientErrors,
  pushClientError,
  setClientErrorSink,
} from '../lib/errorBuffer';
import {
  DIAGNOSTICS_DISABLED_KEY,
  DIAGNOSTICS_ENDPOINT,
  REPORT_BATCH_LIMIT,
  createErrorReporter,
  errorFingerprint,
  installErrorReporting,
  isDiagnosticsDisabled,
  toPayload,
  type DiagnosticPayload,
} from '../lib/errorReporting';

const INSTANCE = 'inst-test-0001';

function makeReporter(overrides: {
  sendImpl?: (payload: DiagnosticPayload, unloading: boolean) => Promise<boolean>;
  instanceId?: string;
} = {}) {
  const sent: DiagnosticPayload[] = [];
  const reporter = createErrorReporter({
    resolveInstanceId: async () => overrides.instanceId ?? INSTANCE,
    send: async (payload, unloading) => {
      sent.push(payload);
      return overrides.sendImpl === undefined ? true : overrides.sendImpl(payload, unloading);
    },
  });
  return { reporter, sent };
}

beforeEach(() => {
  cleanup();
  clearClientErrors();
  localStorage.clear();
  setClientErrorSink(null);
});

afterEach(() => {
  cleanup();
  clearClientErrors();
  localStorage.clear();
  setClientErrorSink(null);
  vi.restoreAllMocks();
});

describe('上报体与去重', () => {
  it('触发一次错误 → 恰好 1 次上报，字段完整', async () => {
    const { reporter, sent } = makeReporter();
    reporter.handle({
      ts: 1700000000000,
      kind: 'react',
      message: 'boom-once',
      stack: 'Error: boom-once\n  at Foo',
      url: 'http://127.0.0.1:5174/',
      source: 'react-boundary',
    });
    await reporter.flush();

    expect(sent).toHaveLength(1);
    const payload = sent[0]!;
    expect(payload.instance_id).toBe(INSTANCE);
    expect(payload.kind).toBe('react');
    expect(payload.message).toBe('boom-once');
    expect(payload.stack).toBe('Error: boom-once\n  at Foo');
    expect(payload.client_ts).toBe(1700000000000);
    expect(payload.url).toBe('http://127.0.0.1:5174/');
    // 契约内字段之外不许多带（服务端 .strict()）
    expect(Object.keys(payload).every((key) => [
      'instance_id', 'kind', 'message', 'stack', 'source', 'url', 'user_agent', 'client_ts', 'app_version', 'context',
    ].includes(key))).toBe(true);
  });

  it('相同 message+stack 连抛 3 次 → 只上报 1 次', async () => {
    const { reporter, sent } = makeReporter();
    const entry = { ts: 1, kind: 'error' as const, message: 'loop-boom', stack: 'same-stack', url: 'u' };
    reporter.handle(entry);
    reporter.handle({ ...entry, ts: 2 });
    reporter.handle({ ...entry, ts: 3 });
    await reporter.flush();

    expect(sent).toHaveLength(1);
    expect(reporter.reportedCount()).toBe(1);
  });

  it('message 相同但 stack 不同 → 各报一次（指纹含 stack）', async () => {
    const { reporter, sent } = makeReporter();
    reporter.handle({ ts: 1, kind: 'error', message: 'same-msg', stack: 'stack-A', url: 'u' });
    reporter.handle({ ts: 2, kind: 'error', message: 'same-msg', stack: 'stack-B', url: 'u' });
    await reporter.flush();
    expect(sent).toHaveLength(2);
  });

  it('stack 缺省时上报体不带 stack 字段（不是空串）', () => {
    const payload = toPayload({ ts: 1, kind: 'rejection', message: 'no-stack', stack: '', url: 'u' }, INSTANCE);
    expect('stack' in payload).toBe(false);
    expect(payload.source).toBeUndefined();
  });

  it('空 stack 与有 stack 的指纹不同（避免把「无栈」与「有栈」合并）', () => {
    const a = errorFingerprint({ ts: 1, kind: 'error', message: 'm', stack: '', url: 'u' });
    const b = errorFingerprint({ ts: 1, kind: 'error', message: 'm', stack: 'x', url: 'u' });
    expect(a).not.toBe(b);
  });
});

describe('失败与开关', () => {
  it('上报返回 500（send 返回 false）→ 不抛错、不重试', async () => {
    const { reporter, sent } = makeReporter({ sendImpl: async () => false });
    reporter.handle({ ts: 1, kind: 'error', message: 'five-hundred', stack: 's', url: 'u' });

    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);

    // 再 flush 一次也不重发（已记指纹）
    await reporter.flush();
    expect(sent).toHaveLength(1);
  });

  it('send 抛异常 → 吞掉，不影响后续', async () => {
    const { reporter, sent } = makeReporter({
      sendImpl: async () => {
        throw new Error('network down');
      },
    });
    reporter.handle({ ts: 1, kind: 'error', message: 'throws', stack: 's', url: 'u' });
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(getClientErrors()).toHaveLength(0);
  });

  it('diagnostics.disabled=1 → 0 次请求', async () => {
    localStorage.setItem(DIAGNOSTICS_DISABLED_KEY, '1');
    expect(isDiagnosticsDisabled()).toBe(true);
    const { reporter, sent } = makeReporter();
    reporter.handle({ ts: 1, kind: 'error', message: 'disabled', stack: 's', url: 'u' });
    await reporter.flush();
    expect(sent).toHaveLength(0);
  });

  it('拿不到 instance_id → 不发请求', async () => {
    const { reporter, sent } = makeReporter({ instanceId: '' });
    reporter.handle({ ts: 1, kind: 'error', message: 'no-instance', stack: 's', url: 'u' });
    await reporter.flush();
    expect(sent).toHaveLength(0);
  });
});

describe('批量上限', () => {
  it(`超过 ${REPORT_BATCH_LIMIT} 条 → 只报 ${REPORT_BATCH_LIMIT} 条，缓冲里留一条「丢弃」记录`, async () => {
    const { reporter, sent } = makeReporter();
    for (let i = 0; i < REPORT_BATCH_LIMIT + 5; i += 1) {
      reporter.handle({ ts: i, kind: 'error', message: `bulk-${i}`, stack: `s${i}`, url: 'u' });
    }
    await reporter.flush();

    expect(sent).toHaveLength(REPORT_BATCH_LIMIT);
    const dropRecord = getClientErrors().find((entry) => entry.message.includes('未上报'));
    expect(dropRecord).toBeDefined();
    expect(dropRecord?.message).toContain('5 条');
    expect(dropRecord?.source).toBe('diagnostics-reporter');
  });
});

describe('sendBeacon 降级', () => {
  it('卸载途中优先 sendBeacon；不可用时降级 fetch', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });

    // 直接验默认发送实现：用 installErrorReporting 挂 pagehide 后触发
    const reporter = createErrorReporter({
      resolveInstanceId: async () => INSTANCE,
      // 这里不覆盖 send，走 defaultSend
    });
    reporter.handle({ ts: 1, kind: 'error', message: 'beacon-path', stack: 's', url: 'u' });

    // 正常态走 fetch：jsdom 无 fetch 会抛 → 静默 false，不发 beacon
    await reporter.flush();
    expect(beacon).not.toHaveBeenCalled();

    // 卸载态：pagehide 后 useBeacon
    const installed = installErrorReporting({
      resolveInstanceId: async () => INSTANCE,
    });
    window.dispatchEvent(new Event('pagehide'));
    installed.handle({ ts: 2, kind: 'error', message: 'beacon-after-pagehide', stack: 's2', url: 'u' });
    await installed.flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe(DIAGNOSTICS_ENDPOINT);
    expect(blob).toBeInstanceOf(Blob);
  });
});

describe('与 G3 的边界串联', () => {
  it('componentDidCatch 走同一条上报路径', async () => {
    const { reporter, sent } = makeReporter();
    setClientErrorSink(reporter.handle);

    function Boom(): null {
      throw new Error('from-boundary');
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument();

    await reporter.flush();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]?.kind).toBe('react');
    expect(sent[0]?.message).toContain('from-boundary');
    expect(sent[0]?.source).toBe('react-boundary');
  });

  it('关闭上报时兜底 UI 详情区显示「诊断上报已关闭」', () => {
    localStorage.setItem(DIAGNOSTICS_DISABLED_KEY, '1');
    function Boom(): null {
      throw new Error('disabled-banner');
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.queryByTestId('app-error-diagnostics-disabled')).toBeNull();
    // 展开后才显示
    fireEvent.click(screen.getByTestId('app-error-details-toggle'));
    expect(screen.queryByTestId('app-error-diagnostics-disabled')).not.toBeNull();
  });
});
