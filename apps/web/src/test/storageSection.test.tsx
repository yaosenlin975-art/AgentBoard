/**
 * DB-3：数据存储分区的行为断言（端点仍是桩，见 `lib/storageSettings.ts` 的 `STORAGE_API`）。
 *
 * 覆盖：正常态（路径/来源占位/占用/附件目录）、env 覆盖态（输入禁用 + 说明）、
 * 路径校验（空/相对/非 .db/同名）、确认框文案带服务端数字、迁移中 → 完成、失败态回滚文案。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { migrationConfirmText, storageSourceLabel, validateTargetPath } from '../lib/storageSettings';
import * as contract from '../lib/storageSettings';
import { StorageSection } from '../components/settings/StorageSection';

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StorageSection />
    </QueryClientProvider>,
  );
};

afterEach(() => vi.restoreAllMocks());

describe('纯函数', () => {
  it('路径校验：空 / 相对 / 非 .db / 与当前相同都拒绝', () => {
    expect(validateTargetPath('', 'D:\\a\\agentboard.db')).toEqual({ ok: false, message: '路径不能为空' });
    expect(validateTargetPath('agentboard.db', 'D:\\a\\agentboard.db').ok).toBe(false);
    expect(validateTargetPath('D:\\b\\board.sqlite', 'D:\\a\\agentboard.db').ok).toBe(false);
    expect(validateTargetPath('D:\\a\\agentboard.db', 'D:\\a\\agentboard.db').ok).toBe(false);
    expect(validateTargetPath('D:\\b\\agentboard.db', 'D:\\a\\agentboard.db')).toEqual({ ok: true });
  });

  it('来源文案：null 明确写「待接口」', () => {
    expect(storageSourceLabel(null)).toContain('待接口');
    expect(storageSourceLabel('env')).toContain('AGENTBOARD_DB');
  });

  it('确认文案用服务端给的数字，缺失时写「未提供」而不是编造', () => {
    expect(migrationConfirmText({ issues: 214, attachments: 37, bytes: 1024 }, 'D:\\b\\agentboard.db')).toContain('214 张卡 / 37 个附件');
    expect(migrationConfirmText(null, 'D:\\b\\agentboard.db')).toContain('未提供');
  });
});

describe('分区渲染', () => {
  it('正常态：当前路径、来源占位、占用、附件目录、桩标注', async () => {
    renderSection();
    expect(await screen.findByTestId('settings-storage-current')).toHaveTextContent('agentboard.db');
    expect(screen.getByTestId('settings-storage-source')).toHaveTextContent('待接口');
    expect(screen.getByTestId('settings-storage-usage')).toHaveTextContent('MB');
    expect(screen.getByTestId('settings-storage-attachments')).toHaveTextContent('attachments');
    expect(screen.getByTestId('settings-storage-stub')).toBeInTheDocument();
  });

  it('确认框：先校验再确认，文案带服务端数字', async () => {
    renderSection();
    const input = await screen.findByTestId('settings-storage-target');
    fireEvent.change(input, { target: { value: 'D:\\AgentBoard\\agentboard.db' } });
    fireEvent.click(screen.getByTestId('settings-storage-submit'));
    const confirm = screen.getByTestId('settings-storage-confirm');
    expect(confirm).toHaveTextContent('214 张卡');
    expect(confirm).toHaveTextContent('服务会重启');
  });

  it('迁移完成态：阶段列表 + 新路径提示', async () => {
    renderSection();
    fireEvent.change(await screen.findByTestId('settings-storage-target'), { target: { value: 'D:\\AgentBoard\\agentboard.db' } });
    fireEvent.click(screen.getByTestId('settings-storage-submit'));
    fireEvent.click(screen.getByTestId('settings-storage-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('settings-storage-migrated')).toBeInTheDocument());
    expect(screen.getByTestId('settings-storage-stage-selfcheck')).toHaveAttribute('data-state', 'current');
  });

  it('失败态：错误码 + 已回滚文案', async () => {
    vi.spyOn(contract, 'startStorageMigration').mockResolvedValue({
      status: 'failed', stage: 'verify', target_path: 'D:\\AgentBoard\\agentboard.db', error_code: 'STORAGE_LOCKED', rolled_back: true,
    });
    renderSection();
    fireEvent.change(await screen.findByTestId('settings-storage-target'), { target: { value: 'D:\\AgentBoard\\agentboard.db' } });
    fireEvent.click(screen.getByTestId('settings-storage-submit'));
    fireEvent.click(screen.getByTestId('settings-storage-confirm-yes'));
    const failed = await screen.findByTestId('settings-storage-failed');
    expect(failed).toHaveTextContent('STORAGE_LOCKED');
    expect(failed).toHaveTextContent('已回滚到原路径');
  });

  it('env 覆盖态：输入禁用并说明由环境变量指定', async () => {
    vi.spyOn(contract, 'fetchStorageInfo').mockResolvedValue({
      db_path: 'D:\\env\\agentboard.db', db_path_source: 'env', attachments_dir: 'D:\\env\\attachments',
      usage: null, migration_estimate: null,
    });
    renderSection();
    const input = await screen.findByTestId('settings-storage-target');
    expect(input).toBeDisabled();
    expect(screen.getByTestId('settings-storage-env-lock')).toHaveTextContent('AGENTBOARD_DB');
    expect(screen.getByTestId('settings-storage-usage-missing')).toHaveTextContent('服务端未提供统计');
  });
});
