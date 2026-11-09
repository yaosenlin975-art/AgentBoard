/**
 * ACC-INCOGNITO：无痕打开授权地址的服务端契约测试。
 *
 * 覆盖：URL 校验、Windows/macOS/Linux 三平台候选与刷新参数、无 Chromium 时的降级返回、
 * 全部候选失败时的 502，以及 RULE-3 接线探针（真实 createApp + 真实 HTTP 请求）。
 * 所有用例注入 fake spawn / existsSync，测试不会真的弹窗。
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb } from './helpers.js';
import { createApp } from '../src/index.js';
import {
  openAuthorizationUrlIncognito,
  type BrowserOpenerDeps,
  type SpawnedChild,
} from '../src/services/browserOpener.js';

interface SpawnCall {
  command: string;
  args: readonly string[];
}

const WIN_ENV: NodeJS.ProcessEnv = {
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};

const CHROME_PATH = 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

/** 造一个只实现 once/unref 的假子进程：按 spawn 是否失败决定先发哪个事件 */
function fakeChild(mode: 'spawned' | 'failed'): SpawnedChild {
  const spawnListeners: Array<() => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const child = {
    once(event: 'spawn' | 'error', listener: () => void | ((error: Error) => void)) {
      if (event === 'spawn') spawnListeners.push(listener as () => void);
      else errorListeners.push(listener as (error: Error) => void);
      return child;
    },
    unref() {},
  };
  setImmediate(() => {
    if (mode === 'failed') {
      const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      errorListeners.forEach((listener) => listener(error));
    } else {
      spawnListeners.forEach((listener) => listener());
    }
  });
  return child as unknown as SpawnedChild;
}

function makeFakeDeps(options: {
  installed?: string[];
  failCommands?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): { deps: BrowserOpenerDeps; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const deps: BrowserOpenerDeps = {
    platform: options.platform ?? 'win32',
    env: options.env ?? WIN_ENV,
    timeoutMs: 200,
    existsSync: (p) => (options.installed ?? []).includes(p),
    spawn: (command, args) => {
      calls.push({ command, args });
      return fakeChild((options.failCommands ?? []).includes(command) ? 'failed' : 'spawned');
    },
  };
  return { deps, calls };
}

describe('browser opener', () => {
  it('opensChromeIncognitoOnWindows', async () => {
    const { deps, calls } = makeFakeDeps({ installed: [CHROME_PATH] });
    const result = await openAuthorizationUrlIncognito('https://example.com/authorize?x=1', deps);
    expect(result).toEqual({ opened_with: 'chrome', mode: 'incognito', degraded_reason: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(CHROME_PATH);
    expect(calls[0].args).toContain('--incognito');
    expect(calls[0].args).toContain('https://example.com/authorize?x=1');
  });

  it('opensEdgeInPrivateOnWindows', async () => {
    const { deps, calls } = makeFakeDeps({ installed: [EDGE_PATH] });
    const result = await openAuthorizationUrlIncognito('https://example.com/authorize', deps);
    expect(result.opened_with).toBe('edge');
    expect(result.mode).toBe('incognito');
    expect(calls[0].args).toContain('--inprivate');
  });

  it('opensBraveIncognitoOnWindows', async () => {
    const { deps, calls } = makeFakeDeps({ installed: [BRAVE_PATH] });
    const result = await openAuthorizationUrlIncognito('https://example.com/authorize', deps);
    expect(result.opened_with).toBe('brave');
    expect(calls[0].args).toContain('--incognito');
  });

  it('usesMacAppBundleWithIncognitoArgs', async () => {
    const { deps, calls } = makeFakeDeps({
      platform: 'darwin',
      env: {},
      installed: ['/Applications/Google Chrome.app'],
    });
    const result = await openAuthorizationUrlIncognito('https://example.com/authorize', deps);
    expect(result).toEqual({ opened_with: 'chrome', mode: 'incognito', degraded_reason: null });
    expect(calls[0].command).toBe('open');
    expect(calls[0].args).toEqual(['-na', 'Google Chrome', '--args', '--incognito', 'https://example.com/authorize']);
  });

  it('fallsBackToSystemDefaultWithVisibleReason', async () => {
    const { deps, calls } = makeFakeDeps({ installed: [] });
    const url = 'https://example.com/authorize?code=abc&state=xyz';
    const result = await openAuthorizationUrlIncognito(url, deps);
    expect(result.opened_with).toBe('default');
    expect(result.mode).toBe('normal');
    expect(result.degraded_reason).not.toBeNull();
    expect(result.degraded_reason).toContain('非无痕');
    expect(calls[0]).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
  });

  it('rejectsNonHttpUrl', async () => {
    const { deps } = makeFakeDeps({ installed: [CHROME_PATH] });
    await expect(openAuthorizationUrlIncognito('file:///C:/secret.txt', deps)).rejects.toMatchObject({
      status: 400,
      code: 'BROWSER_URL_INVALID',
    });
  });

  it('rejectsOverlongUrl', async () => {
    const { deps } = makeFakeDeps({ installed: [CHROME_PATH] });
    const overlong = `https://example.com/${'x'.repeat(2048)}`;
    await expect(openAuthorizationUrlIncognito(overlong, deps)).rejects.toMatchObject({
      status: 400,
      code: 'BROWSER_URL_INVALID',
    });
  });

  it('returns502WithAttemptsWhenEveryCandidateFails', async () => {
    const { deps } = makeFakeDeps({ installed: [CHROME_PATH], failCommands: [CHROME_PATH, 'rundll32.exe'] });
    await expect(openAuthorizationUrlIncognito('https://example.com/authorize', deps)).rejects.toMatchObject({
      status: 502,
      code: 'BROWSER_OPEN_FAILED',
      details: { attempts: expect.any(Array) },
    });
  });

  it('isReachableThroughRealCreateApp', async () => {
    const t = createTestDb();
    try {
      const { deps, calls } = makeFakeDeps({ installed: [CHROME_PATH] });
      const created = await createApp({ db: t.db, refreshClisOnBoot: false, browserOpener: deps });
      const res = await request(created.app)
        .post('/api/browser/open-incognito')
        .send({ url: 'https://example.com/authorize' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ opened_with: 'chrome', mode: 'incognito', degraded_reason: null });
      expect(calls[0].args).toContain('--incognito');
    } finally {
      t.cleanup();
    }
  });
});
