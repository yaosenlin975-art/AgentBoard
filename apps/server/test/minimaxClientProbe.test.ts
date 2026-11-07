/**
 * MINIMAX-PATH：MiniMax 客户端探测 + 能力矩阵三场景。
 *
 * 背景：provider 曾把默认 exe 写死成 `%LOCALAPPDATA%\Programs\MiniMax\MiniMax.exe`，
 * 本机实际装在 `D:\Program Files\MiniMax Code\MiniMax Code.exe`（HKCU 卸载项 `MiniMax Code 3.1.10`），
 * 于是能力矩阵误报 `CLIENT_NOT_INSTALLED`。
 *
 * 三场景：默认路径（LocalAppData）/ 非默认路径（其它盘，靠卸载注册表定位）/ 真未安装。
 * 探测注入 fs 与注册表读数，不依赖本机是否装了客户端。
 */
import { describe, expect, it } from 'vitest';
import {
  MINIMAX_CLIENT_EXE_ENV,
  defaultMinimaxExeCandidates,
  parseMinimaxRegistryEvidence,
  probeMinimaxClient,
  createMinimaxClientProbe,
  type MinimaxRegistryEvidence,
} from '../src/services/accounts/minimaxClientProbe.js';
import { accountProviderCapabilities, MINIMAX_SWITCH_UNAVAILABLE } from '../src/services/accounts/registry.js';
import { mergeAccountCapabilities } from '../src/api/accountRoutes.js';

const ENV = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };

/** 只让给定路径存在 */
const fsWith = (paths: readonly string[]) => async (path: string): Promise<boolean> => paths.includes(path);

const NO_REGISTRY: MinimaxRegistryEvidence = { displayName: null, installDirs: [] };

const minimaxCapability = (minimaxClient?: Parameters<typeof accountProviderCapabilities>[0]) =>
  accountProviderCapabilities(minimaxClient).find(item => item.app_id === 'minimax')!;

describe('minimax client probe (MINIMAX-PATH)', () => {
  it('resolves the default LocalAppData install location', async () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\MiniMax\\MiniMax.exe';
    const status = await probeMinimaxClient({
      env: ENV,
      exists: fsWith([exe]),
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']),
      readRegistry: async () => NO_REGISTRY,
    });
    expect(status).toMatchObject({ installed: true, exe, source: 'default', reason_code: 'CLIENT_READY' });
    // ACC-SW-MAX：stop/start 已装配 → 定位到 exe 即 capture/switch 可用
    expect(minimaxCapability(status)).toMatchObject({ capture: true, switch: true, reason_code: 'OK' });
  });

  it('resolves a non-default install through the uninstall registry entry', async () => {
    const exe = 'D:\\Program Files\\MiniMax Code\\MiniMax Code.exe';
    const status = await probeMinimaxClient({
      env: ENV,
      exists: fsWith([exe]),
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']), // 本机默认候选全落空
      readRegistry: async () => ({ displayName: 'MiniMax Code 3.1.10', installDirs: ['D:\\Program Files\\MiniMax Code'] }),
    });
    expect(status).toMatchObject({ installed: true, exe, source: 'registry', reason_code: 'CLIENT_READY' });
    expect(status.message).toContain('卸载注册表');
    expect(minimaxCapability(status)).toMatchObject({ capture: true, switch: true, reason_code: 'OK' });
  });

  it('reports CLIENT_NOT_INSTALLED only when no candidate and no registry evidence exist', async () => {
    const status = await probeMinimaxClient({
      env: ENV,
      exists: async () => false,
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']),
      readRegistry: async () => NO_REGISTRY,
    });
    expect(status).toMatchObject({ installed: false, exe: null, reason_code: 'CLIENT_NOT_INSTALLED' });
    expect(status.message).toContain(MINIMAX_CLIENT_EXE_ENV);
    expect(minimaxCapability(status)).toMatchObject({ capture: false, switch: false, reason_code: 'CLIENT_NOT_INSTALLED' });
  });

  it('separates installed-elsewhere from not-installed', async () => {
    const status = await probeMinimaxClient({
      env: ENV,
      exists: async () => false,
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']),
      // 注册表说装过，但目录里既没有 MiniMax Code.exe 也没有 MiniMax.exe
      readRegistry: async () => ({ displayName: 'MiniMax Code 3.1.10', installDirs: ['E:\\Portable\\MiniMax'] }),
    });
    expect(status).toMatchObject({ installed: false, exe: null, reason_code: 'CLIENT_PATH_UNRESOLVED' });
    expect(status.message).toContain('无法定位可执行文件');
    expect(status.message).toContain(MINIMAX_CLIENT_EXE_ENV);
    expect(minimaxCapability(status)).toMatchObject({ capture: false, switch: false, reason_code: 'CLIENT_PATH_UNRESOLVED' });
  });

  it('honours the explicit AGENTBOARD_MINIMAX_EXE override first', async () => {
    const exe = 'F:\\Apps\\MiniMax Code\\MiniMax Code.exe';
    const status = await probeMinimaxClient({
      env: { ...ENV, [MINIMAX_CLIENT_EXE_ENV]: exe },
      exists: fsWith([exe]),
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']),
      readRegistry: async () => NO_REGISTRY,
    });
    expect(status).toMatchObject({ installed: true, exe, source: 'override', reason_code: 'CLIENT_READY' });
  });

  it('covers other drives in the default candidates', () => {
    const candidates = defaultMinimaxExeCandidates(ENV, ['C:', 'D:']);
    expect(candidates).toContain('D:\\Program Files\\MiniMax Code\\MiniMax Code.exe');
    expect(candidates).toContain('D:\\Program Files\\MiniMax\\MiniMax.exe');
    expect(candidates).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\MiniMax\\MiniMax.exe');
  });

  it('parses install dirs from reg query output and ignores the uninstaller', () => {
    const stdout = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\f2219de5',
      '    DisplayName    REG_SZ    MiniMax Code 3.1.10',
      '    UninstallString    REG_SZ    "D:\\Program Files\\MiniMax Code\\Uninstall MiniMax Code.exe" /currentuser',
      '    DisplayIcon    REG_SZ    D:\\Program Files\\MiniMax Code\\uninstallerIcon.ico',
      '    InstallLocation    REG_SZ    D:\\Program Files\\MiniMax Code',
    ].join('\r\n');
    const evidence = parseMinimaxRegistryEvidence(stdout);
    expect(evidence.displayName).toBe('MiniMax Code 3.1.10');
    expect(evidence.installDirs).toEqual(['D:\\Program Files\\MiniMax Code']);
  });

  it('caches the probe result until reset', async () => {
    let calls = 0;
    const probe = createMinimaxClientProbe({
      env: ENV,
      candidates: defaultMinimaxExeCandidates(ENV, ['C:']),
      exists: async () => { calls += 1; return false; },
      readRegistry: async () => NO_REGISTRY,
    });
    await probe.get();
    const afterFirst = calls;
    await probe.get();
    expect(calls).toBe(afterFirst);
    probe.reset();
    await probe.get();
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it('feeds the capability matrix through the injected probe (three scenarios end to end)', async () => {
    const cases = [
      // ACC-SW-MAX：installed → capture/switch 均可用（switch_reason=OK；聚合 reason_code 走 checkin 口径）
      { status: { installed: true, exe: 'C:\\x\\MiniMax.exe', source: 'default' as const, reason_code: 'CLIENT_READY' as const, message: '', probed: [] }, capture: true, switch: true, reason: 'CHECKIN_PROVIDER_UNVERIFIED' },
      { status: { installed: false, exe: null, source: null, reason_code: 'CLIENT_PATH_UNRESOLVED' as const, message: '', probed: [] }, capture: false, switch: false, reason: 'CLIENT_PATH_UNRESOLVED' },
      { status: { installed: false, exe: null, source: null, reason_code: 'CLIENT_NOT_INSTALLED' as const, message: '', probed: [] }, capture: false, switch: false, reason: 'CLIENT_NOT_INSTALLED' },
    ];
    for (const item of cases) {
      const row = mergeAccountCapabilities(undefined, item.status).find(capability => capability.app_id === 'minimax')!;
      expect({ capture: row.capture, reason_code: row.reason_code }).toEqual({ capture: item.capture, reason_code: item.reason });
      expect(row.capture_reason_code).toBe(item.capture ? 'OK' : item.reason);
      expect(row.switch).toBe(item.switch);
      expect(row.switch_reason_code).toBe(item.switch ? 'OK' : item.reason);
    }
  });

  it('keeps the static registration when no probe result is supplied', () => {
    // ACC-SW-MAX：未探测时不结论，switch 根因码保留 CLIENT_PROCESS_CONTROL_UNAVAILABLE
    expect(minimaxCapability()).toMatchObject({ capture: true, switch: false, reason_code: MINIMAX_SWITCH_UNAVAILABLE });
  });
});
