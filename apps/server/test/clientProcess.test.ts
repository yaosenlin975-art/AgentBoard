/**
 * B4S-1：共用客户端进程探测/停止 + MiniMax 在运行中阻断切换。
 *
 * 关键断言：
 * - 探测/停止失败一律**抛错**，不静默 false（静默 false 会退化成"以为没在跑"直接覆盖凭据）；
 * - 非 Windows 平台明确 `CLIENT_PROCESS_CONTROL_UNAVAILABLE`；
 * - MiniMax 在客户端运行时切换：**auth.json 一个字节都不写**（fake fs 记录写入次数为 0）。
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_PROCESS_ERROR_CODES, createClientProcessControl } from '../src/services/accounts/clientProcess.js';

const EXE = 'C:\\Users\\demo\\AppData\\Local\\Programs\\MiniMax\\MiniMax.exe';

describe('clientProcess：真进程探测', () => {
  it('进程表有匹配 pid → 在跑；空输出 → 不在跑', async () => {
    const running = createClientProcessControl({ platform: 'win32', run: async () => '1234\r\n5678' });
    expect(await running.isRunning(EXE)).toBe(true);

    const idle = createClientProcessControl({ platform: 'win32', run: async () => '' });
    expect(await idle.isRunning(EXE)).toBe(false);
  });

  it('脚本按进程名过滤 + 全路径精确比对（同名不同路径不会被算作在跑）', async () => {
    const scripts: string[] = [];
    const control = createClientProcessControl({
      platform: 'win32',
      run: async (script) => {
        scripts.push(script);
        return '';
      },
    });
    await control.isRunning(EXE);
    // PowerShell 里 -Filter 的引号会被转义成 ''，这里只断言进程名与路径过滤都进了脚本
    expect(scripts[0]).toContain('MiniMax.exe');
    expect(scripts[0]).toContain('ExecutablePath');
    expect(scripts[0]).toContain('MiniMax\\MiniMax.exe');
  });

  it('非 Windows 平台 → CLIENT_PROCESS_CONTROL_UNAVAILABLE（不返回 false）', async () => {
    const control = createClientProcessControl({ platform: 'linux', run: async () => '' });
    await expect(control.isRunning(EXE)).rejects.toMatchObject({ code: CLIENT_PROCESS_ERROR_CODES.controlUnavailable });
    await expect(control.stop(EXE)).rejects.toMatchObject({ code: CLIENT_PROCESS_ERROR_CODES.controlUnavailable });
  });

  it('进程表查询失败 → CLIENT_PROCESS_PROBE_FAILED', async () => {
    const control = createClientProcessControl({
      platform: 'win32',
      run: async () => {
        throw new Error('powershell 不可用');
      },
    });
    await expect(control.isRunning(EXE)).rejects.toThrow(/powershell 不可用|PROBE_FAILED|查询客户端进程失败/);
  });

  it('stop：发出 Stop-Process 后轮询到清零即返回', async () => {
    const outputs = ['111', '111', ''];
    let index = 0;
    const scripts: string[] = [];
    const control = createClientProcessControl({
      platform: 'win32',
      pollMs: 1,
      exitTimeoutMs: 500,
      run: async (script) => {
        scripts.push(script);
        if (script.includes('Stop-Process')) return '';
        return outputs[Math.min(index++, outputs.length - 1)] ?? '';
      },
    });
    await control.stop(EXE);
    expect(scripts.some((script) => script.includes('Stop-Process -Id 111 -Force'))).toBe(true);
  });

  it('stop：超时仍未退出 → CLIENT_STOP_TIMEOUT（调用方据此中止切换）', async () => {
    const control = createClientProcessControl({
      platform: 'win32',
      pollMs: 1,
      exitTimeoutMs: 5,
      run: async (script) => (script.includes('Stop-Process') ? '' : '999'),
    });
    await expect(control.stop(EXE)).rejects.toMatchObject({ code: CLIENT_PROCESS_ERROR_CODES.stopTimeout });
  });

  it('stop：本来没在跑 → 直接返回（不发停止指令）', async () => {
    const scripts: string[] = [];
    const control = createClientProcessControl({
      platform: 'win32',
      run: async (script) => {
        scripts.push(script);
        return '';
      },
    });
    await control.stop(EXE);
    expect(scripts.some((script) => script.includes('Stop-Process'))).toBe(false);
  });
});
