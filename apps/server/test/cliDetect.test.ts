import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, CliCapabilities } from '@agentboard/adapters';
import { probeCliCapabilities } from '@agentboard/adapters';
import { getCachedClis, invalidateClis, refreshClis } from '../src/services/cliDetect.js';

// CHAT-STREAM-PROBE：拦截 --help 能力探测（codebuddy token 校准路径），其余导出保持真实
vi.mock('@agentboard/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentboard/adapters')>();
  return { ...actual, probeCliCapabilities: vi.fn() };
});

type DetectResult = { installed: boolean; version: string | null };

/** 构造只关心 detect 的 fake 适配器；id 必须取真实适配器 id 枚举 */
function fakeAdapter(
  id: AgentAdapter['id'],
  displayName: string,
  detect: (fn: (result: DetectResult) => void) => void,
  supportsModelSelection = true,
  streaming?: AgentAdapter['streaming'],
) {
  let resolveDetect: ((result: DetectResult) => void) | undefined;
  return {
    id,
    displayName,
    supportsModelSelection,
    ...(streaming !== undefined ? { streaming } : {}),
    detect: vi.fn(
      () =>
        new Promise<DetectResult>((resolve) => {
          resolveDetect = resolve;
          detect(resolve);
        }),
    ),
    listModels: vi.fn(async () => []),
    runTurn: () => {
      throw new Error('unused');
    },
  } satisfies AgentAdapter;
}

beforeEach(() => {
  invalidateClis();
});

describe('refreshClis', () => {
  it('并行探测全部适配器（互不等待）且结果按适配器顺序', async () => {
    const a = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) => {
      // a 的探测挂起，等 b 先 resolve，验证并行不串行
      setTimeout(() => resolve({ installed: true, version: '1.0.0' }), 0);
    });
    const b = fakeAdapter('codex', 'Codex', (resolve) => {
      resolve({ installed: true, version: '0.2.0' });
    });

    const pending = refreshClis([a, b]);
    // 调用即触发全部 detect，不等待前一个完成
    expect(a.detect).toHaveBeenCalledOnce();
    expect(b.detect).toHaveBeenCalledOnce();

    const clis = await pending;
    expect(clis).toEqual([
      { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '1.0.0', supportsModelSelection: true },
      { id: 'codex', displayName: 'Codex', installed: true, version: '0.2.0', supportsModelSelection: true },
    ]);
  });

  it('true/false 混合：installed 与 version 逐项映射，未装 version=null', async () => {
    const a = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: false, version: null }),
    );
    const b = fakeAdapter('codex', 'Codex', (resolve) =>
      resolve({ installed: true, version: '0.2.0' }),
    );

    const clis = await refreshClis([a, b]);

    expect(clis[0]).toEqual({
      id: 'codebuddy',
      displayName: 'CodeBuddy',
      installed: false,
      version: null,
      supportsModelSelection: true,
    });
    expect(clis[1]).toEqual({
      id: 'codex',
      displayName: 'Codex',
      installed: true,
      version: '0.2.0',
      supportsModelSelection: true,
    });
  });

  it('全部 false：结果与缓存一致', async () => {
    const adapters = (['codebuddy', 'codex', 'opencode', 'dsh'] as const).map((id) =>
      fakeAdapter(id, id, (resolve) => resolve({ installed: false, version: null })),
    );

    const clis = await refreshClis(adapters);

    expect(clis).toHaveLength(4);
    for (const info of clis) {
      expect(info.installed).toBe(false);
      expect(info.version).toBeNull();
    }
    expect(getCachedClis()).toEqual(clis);
  });

  it('载荷透传 supportsModelSelection：逐适配器携带能力位（dsh 型 false 透传为 false）', async () => {
    const a = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) => resolve({ installed: true, version: '1.0.0' }), true);
    const d = fakeAdapter('dsh', 'DSH', (resolve) => resolve({ installed: true, version: '0.2.4' }), false);

    const clis = await refreshClis([a, d]);

    expect(clis).toEqual([
      { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '1.0.0', supportsModelSelection: true },
      { id: 'dsh', displayName: 'DSH', installed: true, version: '0.2.4', supportsModelSelection: false },
    ]);
  });

  it('detect 抛错向上传播且不写缓存', async () => {
    const ok = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: true, version: '1.0.0' }),
    );
    const bad = {
      id: 'codex' as const,
      displayName: 'Codex',
      supportsModelSelection: true,
      detect: vi.fn(async () => {
        throw new Error('探测崩溃');
      }),
      listModels: vi.fn(async () => []),
      runTurn: () => {
        throw new Error('unused');
      },
    } satisfies AgentAdapter;

    await expect(refreshClis([ok, bad])).rejects.toThrow('探测崩溃');
    expect(getCachedClis()).toEqual([]);
  });

  it('CHAT-STREAM-PROBE：streaming 静态声明透传（block/none/未声明）', async () => {
    const c = fakeAdapter('codex', 'Codex', (resolve) => resolve({ installed: true, version: '0.2.0' }), true, 'block');
    const o = fakeAdapter('opencode', 'OpenCode', (resolve) => resolve({ installed: true, version: '2.2.0' }), true, 'none');
    const d = fakeAdapter('dsh', 'DSH', (resolve) => resolve({ installed: true, version: '0.2.4' }), false);

    const clis = await refreshClis([c, o, d]);

    expect(clis.map((x) => x.streaming)).toEqual(['block', 'none', undefined]);
    expect(probeCliCapabilities).not.toHaveBeenCalled(); // 非 token 声明不触发探测
  });

  it('CHAT-STREAM-PROBE：codebuddy token 经 --help 探测校准，探测未命中降级 block；未安装不探测', async () => {
    const caps = (partialMessages: boolean): CliCapabilities => ({
      personaFlag: true,
      toolFlags: true,
      permissionFlags: [],
      partialMessages,
    });
    const a = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) => resolve({ installed: true, version: '2.179.2' }), true, 'token');

    vi.mocked(probeCliCapabilities).mockResolvedValueOnce(caps(true));
    const hit = await refreshClis([a]);
    expect(hit[0]!.streaming).toBe('token');

    vi.mocked(probeCliCapabilities).mockResolvedValueOnce(caps(false)); // 老 CLI：help 无该参数
    const miss = await refreshClis([a]);
    expect(miss[0]!.streaming).toBe('block');

    const offline = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) => resolve({ installed: false, version: null }), true, 'token');
    await refreshClis([offline]);
    expect(probeCliCapabilities).toHaveBeenCalledTimes(2); // 未安装不探测
  });
});

describe('缓存', () => {
  it('初始为空；refresh 后 getCachedClis 返回同一份结果；invalidate 清空', async () => {
    expect(getCachedClis()).toEqual([]);

    const adapter = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: true, version: '1.0.0' }),
    );
    const clis = await refreshClis([adapter]);
    expect(getCachedClis()).toEqual(clis);

    invalidateClis();
    expect(getCachedClis()).toEqual([]);
  });

  it('重复 refresh 覆盖旧缓存', async () => {
    const first = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: false, version: null }),
    );
    await refreshClis([first]);

    const second = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: true, version: '2.0.0' }),
    );
    const clis = await refreshClis([second]);

    expect(getCachedClis()).toEqual(clis);
    expect(getCachedClis()[0]!.installed).toBe(true);
  });
});
