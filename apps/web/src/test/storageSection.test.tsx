/**
 * DB-3B-W：数据存储分区**接真端点**的用例（桩已移除）。
 * 覆盖：读端点渲染（含 truncated）、env 覆盖禁用、迁移阶段映射与五格点亮、
 * 完成/失败回滚态、TARGET_EXISTS 文案 + 覆盖勾选、迁移中禁止重复提交。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { StorageSection } from '../components/settings/StorageSection';
import {
  MIGRATION_ERROR_TEXT,
  formatBytes,
  migrationConfirmText,
  nextPollDelay,
  storageSourceLabel,
  toMigrationView,
  uiStageOf,
  usageSummary,
  validateTargetPath,
  type MigrationStatus,
  type StorageInfo,
} from '../lib/storageSettings';
import { server } from './server';

const INFO: StorageInfo = {
  db_path: 'C:\\Users\\x\\AppData\\Roaming\\AgentBoard\\agentboard.db',
  db_path_source: 'settings',
  attachments_dir: 'C:\\Users\\x\\AppData\\Roaming\\AgentBoard\\attachments',
  usage: { db_bytes: 14_684_160, wal_bytes: 4_770_992, shm_bytes: 32_768, attachments_bytes: 37_736_512, attachments_files: 170, total_bytes: 57_224_432 },
  migration_estimate: { issue_count: 606, attachment_count: 170, estimated_bytes: 57_224_432, required_bytes: 68_669_319 },
  truncated: false,
};

const status = (over: Partial<MigrationStatus>): MigrationStatus => ({
  migration_id: 'm-1', stage: 'preflight', stages: [], ok: null, code: null, message: '',
  retryable: false, backup_dir: null, from_db_path: INFO.db_path, to_db_path: 'D:\\AgentBoard\\agentboard.db',
  ...over,
});

function mockStorage(info: Partial<StorageInfo> = {}): void {
  server.use(http.get('/api/settings/storage', () => HttpResponse.json({ ...INFO, ...info })));
}

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StorageSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('存储分区：只读信息（真端点）', () => {
  it('渲染路径/来源/附件目录/占用与迁移量', async () => {
    mockStorage();
    renderSection();
    expect(await screen.findByTestId('settings-storage-current')).toHaveTextContent('agentboard.db');
    expect(screen.getByTestId('settings-storage-source')).toHaveTextContent('设置（持久化到 config.json）');
    expect(screen.getByTestId('settings-storage-attachments')).toHaveTextContent('attachments');
    const usage = screen.getByTestId('settings-storage-usage');
    expect(usage).toHaveTextContent('170 个文件');
    expect(usage).toHaveTextContent(formatBytes(INFO.usage!.total_bytes));
    expect(screen.getByTestId('settings-storage-estimate')).toHaveTextContent('606 张卡');
    expect(screen.queryByTestId('settings-storage-stub')).toBeNull();
  });

  it('truncated=true 且 usage=null → 「统计过大已省略」，不显示 0', async () => {
    mockStorage({ usage: null, migration_estimate: null, truncated: true });
    renderSection();
    const missing = await screen.findByTestId('settings-storage-usage-missing');
    expect(missing).toHaveTextContent('统计过大已省略');
    expect(missing).toHaveAttribute('data-truncated', 'true');
  });

  it('来源=env：输入框禁用 + 说明 + 提交禁用', async () => {
    mockStorage({ db_path_source: 'env' });
    renderSection();
    expect(await screen.findByTestId('settings-storage-target')).toBeDisabled();
    expect(screen.getByTestId('settings-storage-env-lock')).toHaveTextContent('AGENTBOARD_DB');
    expect(screen.getByTestId('settings-storage-submit')).toBeDisabled();
  });
});

describe('存储分区：迁移', () => {
  it('202 → 轮询 preflight→snapshot→verify→switch→restart→selfcheck→done → 完成态显示新路径', async () => {
    mockStorage();
    let polls = 0;
    const sequence = ['preflight', 'snapshot', 'verify', 'switch', 'restart', 'selfcheck', 'done'] as const;
    server.use(
      http.post('/api/settings/db-path/migrate', () => HttpResponse.json({ migration_id: 'm-1', backup_dir: 'D:\\backup\\m-1', stages: [], stage: 'preflight', message: '已启动' }, { status: 202 })),
      http.get('/api/settings/db-path/migrate/:id', () => {
        polls += 1;
        const index = Math.min(polls - 1, sequence.length - 1);
        const stage = sequence[index]!;
        return HttpResponse.json(status({
          stage,
          stages: sequence.slice(0, index + 1).map((s, i) => ({ stage: s, at: 1_700_000_000_000 + i })),
          ok: stage === 'done' ? true : null,
          message: stage === 'done' ? '迁移完成' : '进行中',
        }));
      }),
    );
    renderSection();
    await userEvent.type(await screen.findByTestId('settings-storage-target'), 'D:\\AgentBoard\\agentboard.db');
    await userEvent.click(screen.getByTestId('settings-storage-submit'));
    await userEvent.click(screen.getByTestId('settings-storage-confirm-yes'));

    const migrated = await screen.findByTestId('settings-storage-migrated', undefined, { timeout: 20000 });
    expect(migrated).toHaveTextContent('D:\\AgentBoard\\agentboard.db');
    for (const id of ['check', 'copy', 'verify', 'switch', 'selfcheck']) {
      expect(screen.getByTestId(`settings-storage-stage-${id}`).getAttribute('data-state')).toBe('done');
    }
    expect(polls).toBeGreaterThanOrEqual(7);
  }, 30000);

  it('失败并回滚：中文原因 + 「已回滚到原路径」', async () => {
    mockStorage();
    server.use(
      http.post('/api/settings/db-path/migrate', () => HttpResponse.json({ migration_id: 'm-2', backup_dir: null, stages: [], stage: 'preflight', message: '已启动' }, { status: 202 })),
      http.get('/api/settings/db-path/migrate/:id', () =>
        HttpResponse.json(status({
          migration_id: 'm-2', stage: 'rolled_back', ok: false, code: 'DB_MIGRATION_VERIFY_FAILED', message: '复制校验失败',
          stages: [{ stage: 'preflight', at: 1 }, { stage: 'snapshot', at: 2 }, { stage: 'rolled_back', at: 3 }],
        })),
      ),
    );
    renderSection();
    await userEvent.type(await screen.findByTestId('settings-storage-target'), 'D:\\AgentBoard\\agentboard.db');
    await userEvent.click(screen.getByTestId('settings-storage-submit'));
    await userEvent.click(screen.getByTestId('settings-storage-confirm-yes'));

    const failed = await screen.findByTestId('settings-storage-failed', undefined, { timeout: 15000 });
    expect(failed).toHaveTextContent(MIGRATION_ERROR_TEXT.DB_MIGRATION_VERIFY_FAILED!);
    expect(failed).toHaveTextContent('已回滚到原路径');
    expect(screen.getByTestId('settings-storage-migration')).toHaveAttribute('data-status', 'failed');
  }, 20000);

  it('TARGET_EXISTS：中文文案 + 覆盖勾选存在 + 可重试（按钮不禁用）', async () => {
    mockStorage();
    server.use(
      http.post('/api/settings/db-path/migrate', () =>
        HttpResponse.json({ error: { code: 'DB_MIGRATION_TARGET_EXISTS', message: '目标已存在同名数据库' } }, { status: 409 }),
      ),
    );
    renderSection();
    await userEvent.type(await screen.findByTestId('settings-storage-target'), 'D:\\AgentBoard\\agentboard.db');
    expect(screen.getByTestId('settings-storage-overwrite')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-storage-submit'));
    await userEvent.click(screen.getByTestId('settings-storage-confirm-yes'));

    const error = await screen.findByTestId('settings-storage-migrate-error');
    expect(error).toHaveTextContent(MIGRATION_ERROR_TEXT.DB_MIGRATION_TARGET_EXISTS!);
    expect(error).toHaveAttribute('data-busy', 'false');
    expect(screen.getByTestId('settings-storage-submit')).not.toBeDisabled();
  });

  it('迁移进行中：提交按钮禁用（禁止重复提交）', async () => {
    mockStorage();
    server.use(
      http.post('/api/settings/db-path/migrate', () => HttpResponse.json({ migration_id: 'm-3', backup_dir: null, stages: [], stage: 'preflight', message: '已启动' }, { status: 202 })),
      http.get('/api/settings/db-path/migrate/:id', () =>
        HttpResponse.json(status({ migration_id: 'm-3', stage: 'snapshot', message: '复制中', stages: [{ stage: 'preflight', at: 1 }, { stage: 'snapshot', at: 2 }] })),
      ),
    );
    renderSection();
    await userEvent.type(await screen.findByTestId('settings-storage-target'), 'D:\\AgentBoard\\agentboard.db');
    await userEvent.click(screen.getByTestId('settings-storage-submit'));
    await userEvent.click(screen.getByTestId('settings-storage-confirm-yes'));
    await screen.findByTestId('settings-storage-migrating');
    expect(screen.getByTestId('settings-storage-submit')).toBeDisabled();
  });
});

describe('纯函数', () => {
  it('阶段映射：restart→切换、cleanup/done→自检、rolled_back→失败', () => {
    expect(uiStageOf('preflight')).toBe('check');
    expect(uiStageOf('snapshot')).toBe('copy');
    expect(uiStageOf('verify')).toBe('verify');
    expect(uiStageOf('switch')).toBe('switch');
    expect(uiStageOf('restart')).toBe('switch');
    expect(uiStageOf('selfcheck')).toBe('selfcheck');
    expect(uiStageOf('done')).toBe('selfcheck');
    const view = toMigrationView(status({
      stage: 'rolled_back', ok: false, code: 'DB_MIGRATION_ROLLED_BACK', message: '回滚',
      stages: [{ stage: 'preflight', at: 1 }, { stage: 'snapshot', at: 2 }],
    }));
    expect(view.status).toBe('failed');
    expect(view.rolledBack).toBe(true);
    expect(view.reached).toEqual(['check', 'copy', 'selfcheck']);
  });

  it('七个错误码都有中文文案', () => {
    for (const code of ['NO_SPACE', 'VERIFY_FAILED', 'TARGET_EXISTS', 'SELFCHECK_FAILED', 'ROLLED_BACK', 'BUSY', 'ENV_OVERRIDDEN']) {
      expect(MIGRATION_ERROR_TEXT[`DB_MIGRATION_${code}`]).toBeTruthy();
    }
  });

  it('来源文案与占用汇总：truncated 不显示 0', () => {
    expect(storageSourceLabel('env')).toContain('AGENTBOARD_DB');
    expect(storageSourceLabel(null)).toBe('来源未知');
    expect(usageSummary({ ...INFO, usage: null, truncated: true })).toBe('统计过大已省略');
    expect(usageSummary({ ...INFO, usage: null, truncated: false })).toBe('服务端未提供统计');
  });

  it('路径校验与确认文案（数字来自服务端）', () => {
    expect(validateTargetPath('', 'c:/a.db')).toMatchObject({ ok: false });
    expect(validateTargetPath('relative/a.db', 'c:/a.db')).toMatchObject({ ok: false });
    expect(validateTargetPath('D:\\x\\agentboard.db', 'C:\\a\\agentboard.db')).toEqual({ ok: true });
    expect(migrationConfirmText(INFO.migration_estimate, 'D:\\b\\agentboard.db')).toContain('606 张卡');
    expect(migrationConfirmText(null, 'D:\\b\\agentboard.db')).toContain('未提供');
  });

  it('轮询退避：1s 起、上限 5s', () => {
    expect(nextPollDelay(0)).toBe(1000);
    expect(nextPollDelay(6000)).toBe(2000);
    expect(nextPollDelay(11000)).toBe(4000);
    expect(nextPollDelay(60000)).toBe(5000);
  });
});
