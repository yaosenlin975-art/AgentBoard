/**
 * MINIMAX-PATH：provider 的 preflight 走探测结果（而不是写死的默认 exe）。
 * 与 `minimaxDesktopProvider.test.ts`（切换/回滚契约）分文件，避免与本机路径无关的用例互相牵制。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { MinimaxDesktopProvider } from '../src/services/accounts/minimaxDesktopProvider.js';
import type { MinimaxClientStatus } from '../src/services/accounts/minimaxClientProbe.js';
import type { CheckinVault } from '../src/services/accounts/checkinProvider.js';

const AUTH_FILE = 'C:\\Users\\u\\.minimax\\auth\\prod\\cn\\mcode-public\\auth.json';
const NON_DEFAULT_EXE = 'D:\\Program Files\\MiniMax Code\\MiniMax Code.exe';

const status = (patch: Partial<MinimaxClientStatus>): MinimaxClientStatus => ({
  installed: false, exe: null, source: null, reason_code: 'CLIENT_NOT_INSTALLED', message: '未检测到 MiniMax 客户端安装', probed: [], ...patch,
});

function makeProvider(t: TestDb, probeStatus: MinimaxClientStatus | Error, opts: { clientExe?: string } = {}) {
  const exists = vi.fn(async (path: string) => path === AUTH_FILE || path === NON_DEFAULT_EXE);
  const get = vi.fn(async () => {
    if (probeStatus instanceof Error) throw probeStatus;
    return probeStatus;
  });
  const provider = new MinimaxDesktopProvider({
    db: t.db,
    vault: {} as CheckinVault,
    paths: { authFile: AUTH_FILE, clientExe: opts.clientExe ?? '' },
    fs: {
      exists,
      readFile: async () => Buffer.from(JSON.stringify({ records: { c1: { accessToken: 't', expiresAtMs: 1 } } })),
      writeFile: async () => {},
      rename: async () => {},
      copyFile: async () => {},
      remove: async () => {},
    },
    clientProbe: { get },
  });
  return { provider, exists, get };
}

describe('minimax provider client path (MINIMAX-PATH)', () => {
  it('preflights against the probed non-default exe', async () => {
    const t = createTestDb();
    try {
      const { provider, exists } = makeProvider(t, status({ installed: true, exe: NON_DEFAULT_EXE, source: 'registry', reason_code: 'CLIENT_READY' }));
      const result = await provider.preflight();
      expect(result.authFile).toBe(AUTH_FILE);
      expect(exists).toHaveBeenCalledWith(NON_DEFAULT_EXE);
    } finally {
      t.cleanup();
    }
  });

  it('fails with CLIENT_NOT_INSTALLED and the config hint when nothing is installed', async () => {
    const t = createTestDb();
    try {
      const { provider } = makeProvider(t, status({
        reason_code: 'CLIENT_NOT_INSTALLED',
        message: '未检测到 MiniMax 客户端安装；用环境变量 AGENTBOARD_MINIMAX_EXE 指定 exe 绝对路径',
      }));
      await expect(provider.preflight()).rejects.toMatchObject({ code: 'CLIENT_NOT_INSTALLED' });
      await expect(provider.preflight()).rejects.toThrow(/AGENTBOARD_MINIMAX_EXE/);
    } finally {
      t.cleanup();
    }
  });

  it('fails with CLIENT_PATH_UNRESOLVED when the install exists but the exe cannot be located', async () => {
    const t = createTestDb();
    try {
      const { provider } = makeProvider(t, status({
        reason_code: 'CLIENT_PATH_UNRESOLVED',
        message: '检测到 MiniMax 已安装，但无法定位可执行文件；用环境变量 AGENTBOARD_MINIMAX_EXE 指定 exe 绝对路径',
      }));
      await expect(provider.preflight()).rejects.toMatchObject({ code: 'CLIENT_PATH_UNRESOLVED' });
    } finally {
      t.cleanup();
    }
  });

  it('keeps an explicitly configured clientExe authoritative (no probe call)', async () => {
    const t = createTestDb();
    try {
      const { provider, get } = makeProvider(t, status({ installed: false }), { clientExe: NON_DEFAULT_EXE });
      const result = await provider.preflight();
      expect(result.authFile).toBe(AUTH_FILE);
      expect(get).not.toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });
});
