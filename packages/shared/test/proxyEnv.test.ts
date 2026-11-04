/**
 * PROXY-ENV：`packages/shared/src/proxyEnv.ts` 的单一实现（启动器与服务端共用）。
 */
import { describe, expect, it } from 'vitest';
import { ensureProxyEnv, maskProxyHost, resolveProxyEnv } from '../src/proxyEnv.js';

describe('proxyEnv（PROXY-ENV）', () => {
  it('resolveProxyEnv：无代理 → proxy_var/proxy_host 为 null；enabled=false', () => {
    expect(resolveProxyEnv({})).toEqual({ enabled: false, proxy_var: null, proxy_host: null, node_env_proxy: null });
  });

  it('resolveProxyEnv：大/小写变量都认，host:port 脱敏且不含 userinfo', () => {
    expect(resolveProxyEnv({ HTTPS_PROXY: 'http://u:p@10.0.0.1:8080' })).toMatchObject({ enabled: true, proxy_var: 'HTTPS_PROXY', proxy_host: '10.0.0.1:8080' });
    expect(resolveProxyEnv({ http_proxy: '10.0.0.1:1080' })).toMatchObject({ enabled: true, proxy_var: 'HTTP_PROXY', proxy_host: '10.0.0.1:1080' });
    expect(JSON.stringify(resolveProxyEnv({ HTTPS_PROXY: 'http://u:p@10.0.0.1:8080' }))).not.toContain('u:p@');
  });

  it('maskProxyHost：无端口 / 非法值', () => {
    expect(maskProxyHost('http://proxy.local')).toBe('proxy.local');
    expect(maskProxyHost('   ')).toBeNull();
    expect(maskProxyHost('::::')).toBe('<无法解析的代理地址>');
  });

  it('ensureProxyEnv：有代理且未设置 → 注入 1', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://127.0.0.1:7897' };
    const info = ensureProxyEnv(env);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(info).toMatchObject({ enabled: true, node_env_proxy: '1' });
  });

  it('ensureProxyEnv：显式 0 不覆盖（用户主动关闭）', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://127.0.0.1:7897', NODE_USE_ENV_PROXY: '0' };
    const info = ensureProxyEnv(env);
    expect(env.NODE_USE_ENV_PROXY).toBe('0');
    expect(info.enabled).toBe(false);
  });

  it('ensureProxyEnv：无代理变量时不注入（不误改全局行为）', () => {
    const env: Record<string, string | undefined> = {};
    ensureProxyEnv(env);
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });
});
