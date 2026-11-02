import { describe, expect, it } from 'vitest';
import { asChild, makeAutoChild } from './helpers.js';
import { setSpawnFn, type SpawnFn } from '../src/spawn.js';
import { ADAPTERS, getAdapter } from '../src/index.js';

describe('registry', () => {
  it('ADAPTERS 注册四家且顺序固定', () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(['codebuddy', 'codex', 'opencode', 'dsh']);
  });

  it('能力位 supportsModelSelection：dsh=false（模型只读），其余三家 true', () => {
    expect(ADAPTERS.map((a) => [a.id, a.supportsModelSelection])).toEqual([
      ['codebuddy', true],
      ['codex', true],
      ['opencode', true],
      ['dsh', false],
    ]);
  });

  it('未验证图片输入的 CLI 显式拒绝 attachments，不降级为纯文本', () => {
    for (const id of ['codex', 'opencode', 'dsh'] as const) {
      const adapter = getAdapter(id);
      expect(adapter.supportsImageInput?.('unverified')).toBe(false);
      expect(() => adapter.runTurn({
        cwd: '.', model: 'unverified', prompt: '保留原样',
        attachments: [{ path: 'D:\\synthetic.png', mimeType: 'image/png' }],
      })).toThrow('IMAGE_DELIVERY_UNVERIFIED');
    }
  });

  it('四家 detect 并行（Promise.all）：mock 命中 where + --version → 全部 installed', async () => {
    setSpawnFn(((cmd: string, args: string[]) => {
      if (cmd === 'where' || cmd === 'which') {
        const name = args[0] ?? 'unknown';
        return asChild(makeAutoChild([{ source: 'stdout', text: `C:\\mock\\bin\\${name}.exe\n` }], 0));
      }
      if (args.includes('--version')) {
        return asChild(makeAutoChild([{ source: 'stdout', text: '1.0.0\n' }], 0));
      }
      throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
    }) as unknown as SpawnFn);

    const results = await Promise.all(ADAPTERS.map(async (a) => ({ id: a.id, ...(await a.detect()) })));
    expect(results).toEqual([
      { id: 'codebuddy', installed: true, version: '1.0.0' },
      { id: 'codex', installed: true, version: '1.0.0' },
      { id: 'opencode', installed: true, version: '1.0.0' },
      { id: 'dsh', installed: true, version: '1.0.0' },
    ]);
  });

  it('getAdapter 返回对应适配器；未知 id 抛 Error', () => {
    for (const adapter of ADAPTERS) {
      expect(getAdapter(adapter.id)).toBe(adapter);
    }
    expect(() => getAdapter('nope' as never)).toThrow(Error);
    expect(() => getAdapter('nope' as never)).toThrow(/未知适配器/);
  });
});
