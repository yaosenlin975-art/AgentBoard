/**
 * ACC-UI-05：展开层账号行与签到批次面板的视觉约束（机器可验证部分）。
 * 目的：防止把 unslop 收好的 chrome 又写回多色相/一次性色值。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'components/settings/AccountCard.tsx',
  'components/settings/OneClickCheckin.tsx',
  'components/settings/CheckinBatchPanel.tsx',
];

/** 禁止出现的多色相工具类（红只用于破坏性操作，不在此列） */
const BANNED = /blue-|purple-|indigo-|green-100|amber-[0-9]/;

describe('账号展开层视觉约束（ACC-UI-05）', () => {
  for (const relative of FILES) {
    it(`${relative} 不含多色相工具类`, () => {
      const source = readFileSync(join(__dirname, '..', relative), 'utf8');
      const hits = source
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => BANNED.test(line) && !line.trimStart().startsWith('*'))
        .map(({ line, index }) => `${relative}:${index + 1}: ${line.trim()}`);
      expect(hits).toEqual([]);
    });
  }

  it('AccountCard 使用令牌表面与发丝线（surface-card / hairline），不再用 neutral 边框', () => {
    const source = readFileSync(join(__dirname, '..', FILES[0]!), 'utf8');
    expect(source).toContain('bg-surface-card');
    expect(source).toContain('border-hairline');
    expect(source).not.toContain('border-neutral-200');
  });

  it('签到批次面板：面板 16 / 卡片 12 的嵌套圆角，计数用 tabular-nums', () => {
    const panel = readFileSync(join(__dirname, '..', FILES[1]!), 'utf8');
    const batch = readFileSync(join(__dirname, '..', FILES[2]!), 'utf8');
    expect(panel).toContain('rounded-2xl');   // 16：外层面板
    expect(batch).toContain('rounded-xl');    // 12：批次卡片
    expect(batch).toContain('tabular-nums');
  });
});
