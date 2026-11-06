/** STORE-7：工作区卡片只读库状态徽标（未知 db_mode 有兜底文案，不崩）。 */
import { describe, expect, it } from 'vitest';
import { workspaceDbBadge } from '../components/workspace/WorkspaceCard';

describe('workspaceDbBadge', () => {
  it.each([
    ['localized', '本地库'],
    ['localizing', '迁移中'],
    ['failed', '失败'],
  ] as const)('%s → %s', (mode, label) => {
    expect(workspaceDbBadge({ db_mode: mode })?.label).toBe(label);
  });

  it('center 与缺省不显示徽标', () => {
    expect(workspaceDbBadge({ db_mode: 'center' })).toBeNull();
    expect(workspaceDbBadge({})).toBeNull();
  });

  it('已定义但未知的值给兜底文案，不抛错', () => {
    expect(workspaceDbBadge({ db_mode: 'future-mode' })?.label).toBe('库状态未知');
  });

  it('title 带上 db_path（仅只读展示）', () => {
    expect(workspaceDbBadge({ db_mode: 'localized', db_path: 'D:\\ws\\.agentboard\\agentboard.db' })?.title).toContain('D:\\ws\\');
  });
});
