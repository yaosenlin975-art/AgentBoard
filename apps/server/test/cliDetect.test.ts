import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { getCachedClis, invalidateClis, refreshClis } from '../src/services/cliDetect.js';

type DetectResult = { installed: boolean; version: string | null };

/** 构造只关心 detect 的 fake 适配器；id 必须取真实适配器 id 枚举 */
function fakeAdapter(
  id: AgentAdapter['id'],
  displayName: string,
  detect: (fn: (result: DetectResult) => void) => void,
) {
  let resolveDetect: ((result: DetectResult) => void) | undefined;
  return {
    id,
    displayName,
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
      { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '1.0.0' },
      { id: 'codex', displayName: 'Codex', installed: true, version: '0.2.0' },
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

    expect(clis[0]).toEqual({ id: 'codebuddy', displayName: 'CodeBuddy', installed: false, version: null });
    expect(clis[1]).toEqual({ id: 'codex', displayName: 'Codex', installed: true, version: '0.2.0' });
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

  it('detect 抛错向上传播且不写缓存', async () => {
    const ok = fakeAdapter('codebuddy', 'CodeBuddy', (resolve) =>
      resolve({ installed: true, version: '1.0.0' }),
    );
    const bad = {
      id: 'codex' as const,
      displayName: 'Codex',
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
