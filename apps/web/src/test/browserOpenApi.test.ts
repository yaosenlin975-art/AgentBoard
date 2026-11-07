/**
 * ACC-INCOGNITO：browserOpenApi 的契约测试。
 * 只验证客户端封装（路径 / body / 返回值透传 / 错误透传），不发真实请求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../api/client', () => ({ api: { post: mocks.post } }));

import { browserOpenApi } from '../api/browserOpen';

describe('browserOpenApi', () => {
  beforeEach(() => {
    mocks.post.mockReset();
  });

  it('postsAuthorizationUrlToIncognitoEndpointAndReturnsResult', async () => {
    const payload = { opened_with: 'chrome' as const, mode: 'incognito' as const, degraded_reason: null };
    mocks.post.mockResolvedValue(payload);

    const result = await browserOpenApi.openIncognito('https://example.com/authorize');

    expect(mocks.post).toHaveBeenCalledWith('/api/browser/open-incognito', { url: 'https://example.com/authorize' });
    expect(result).toEqual(payload);
  });

  it('returnsDegradedResultWithoutSwallowingIt', async () => {
    const payload = {
      opened_with: 'default' as const,
      mode: 'normal' as const,
      degraded_reason: '未找到 Chrome / Edge / Brave，已用系统默认浏览器普通窗口打开（非无痕）',
    };
    mocks.post.mockResolvedValue(payload);

    await expect(browserOpenApi.openIncognito('https://example.com/authorize')).resolves.toEqual(payload);
  });

  it('rethrowsApiErrorWithCodeAndMessage', async () => {
    const error = Object.assign(new Error('没有可用的浏览器可以打开授权地址'), {
      name: 'ApiError',
      code: 'BROWSER_OPEN_FAILED',
      status: 502,
    });
    mocks.post.mockRejectedValue(error);

    await expect(browserOpenApi.openIncognito('https://example.com/authorize')).rejects.toBe(error);
  });
});
