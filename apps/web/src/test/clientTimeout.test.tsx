/**
 * CR-2：Web REST 客户端超时。
 * 锁三件事：普通请求 15s 与上传 60s 都能真的触发超时（不只测正常路径）；
 * 超时映射成 ApiError(TIMEOUT, status=0) 与服务端 HTTP 错误可区分；错误横幅给出可辨识文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError, REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE, UPLOAD_TIMEOUT_MS, api } from '../api/client';
import { ErrorState } from '../components/ui/ErrorState';
import { errorText } from '../lib/errorCodeText';

/** 模拟「服务端接受连接但永不回包」：只有 abort 信号触发时 fetch 才失败 */
function stubHangingFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubJsonFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api client 超时', () => {
  beforeEach(() => {
    // 只伪造 setTimeout/clearTimeout：保留 FileReader 依赖的宿主任务队列，上传用例才能读到文件后再发请求
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('正常分支：请求返回数据，超时定时器被清理（不会再 abort）', async () => {
    const fetchMock = stubJsonFetch({ ok: true });
    await expect(api.get<{ ok: boolean }>('/api/ping')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 定时器已清理：越过超时点推进也不会产生新的失败
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('超时分支：15s 内不回包 → ApiError(TIMEOUT, status=0)，且未到点不报错', async () => {
    stubHangingFetch();
    let failure: unknown = null;
    const pending = api.get('/api/issues').catch((error: unknown) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(failure).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('TIMEOUT');
    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).message).toBe(TIMEOUT_MESSAGE);
  });

  it('测试环境不传 signal（MSW 跨 realm 会挂死），超时仍由竞速收口（CR2-01）', async () => {
    const fetchMock = stubHangingFetch();
    const pending = api.get('/api/issues').catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await pending;

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    // 浏览器产物里同一位置会带 signal 并 abort；jsdom 分支必须保持 undefined，否则整套用例超时
    expect(init.signal).toBeUndefined();
  });

  it('上传超时：大文件通道用 60s，不与普通请求共用 15s', async () => {
    const fetchMock = stubHangingFetch();
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    let failure: unknown = null;
    const pending = api.uploadAttachment('ws-1', file, 'image/png').catch((error: unknown) => {
      failure = error;
    });

    // FileReader 读完才发 fetch；先等本地读取完成（真实任务队列，不受伪造定时器影响）
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');

    // 普通请求的 15s 到点，上传仍应继续等待
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(failure).toBeNull();

    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
    await pending;
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('TIMEOUT');
    expect((failure as ApiError).status).toBe(0);
  });

  it('非超时网络错误原样抛，不伪装成超时', async () => {
    const networkError = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(networkError)));
    await expect(api.get('/api/ping')).rejects.toBe(networkError);
  });
});

describe('超时的用户可见提示', () => {
  it('错误横幅展示可重试文案，且与普通失败文案不同', () => {
    const timeout = new ApiError(TIMEOUT_MESSAGE, 'TIMEOUT', 0);
    expect(errorText(timeout)).toBe(TIMEOUT_MESSAGE);

    const { rerender } = render(<ErrorState error={timeout} testId="timeout-alert" />);
    expect(screen.getByTestId('timeout-alert')).toHaveTextContent('服务无响应，请稍后重试');

    rerender(<ErrorState error={new ApiError('内部错误', 'UNKNOWN', 500)} testId="timeout-alert" />);
    expect(screen.getByTestId('timeout-alert')).toHaveTextContent('内部错误');
  });
});
