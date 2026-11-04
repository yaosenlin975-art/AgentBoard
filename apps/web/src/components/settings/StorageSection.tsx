/**
 * DB-3：设置里的「数据存储」分区（前端先行，端点待 DB-2B `4719248b`）。
 *
 * 三个状态都要能看见：正常（当前路径/来源/占用/附件目录）、迁移中（阶段进度）、失败（错误码 + 已回滚）。
 * 所有统计数字（卡片数 / 附件数 / 体积）**都来自服务端**（本卡用桩数据并明示），前端只做格式化与展示。
 * env 覆盖态（`AGENTBOARD_DB` 生效）下输入框禁用并说明原因——不给一个改了也不生效的入口。
 */
import { useMemo, useState } from 'react';
// 走命名空间调用：便于测试用 vi.spyOn 替换契约层实现（也方便 DB-2B 落地后整体切换）
import * as storageContract from '../../lib/storageSettings';
import { useQuery } from '@tanstack/react-query';
import {
  formatBytes,
  migrationConfirmText,
  STORAGE_MIGRATION_STAGES,
  storageSourceLabel,
  STUB_NOTICE,
  STORAGE_API,
  validateTargetPath,
  type StorageInfo,
  type StorageMigration,
} from '../../lib/storageSettings';

export function StorageSection() {
  const info = useQuery({ queryKey: ['settings-storage'], queryFn: storageContract.fetchStorageInfo, staleTime: 30_000 });
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [migration, setMigration] = useState<StorageMigration | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const data: StorageInfo | undefined = info.data;
  const envLocked = data?.db_path_source === 'env';
  const validation = useMemo(
    () => (data === undefined ? null : validateTargetPath(target, data.db_path)),
    [target, data],
  );

  const runMigration = async (): Promise<void> => {
    setConfirming(false);
    setFailure(null);
    try {
      const started = await storageContract.startStorageMigration(target.trim());
      // 桩模式：把「刚发起」的 running 直接推进到完成，便于看「迁移中 → 完成」两态；
      // 服务端明确返回 failed 时保持原样（错误码/回滚标记以服务端为准，前端不覆盖）
      if (STORAGE_API.stub && started.status === 'running') {
        setMigration({ ...started, status: 'succeeded', stage: 'selfcheck' });
      } else {
        setMigration(started);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '迁移请求失败');
    }
  };

  return (
    <section data-testid="settings-storage" className="mt-4 border-t border-hairline pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-ink-2">数据存储</h3>
        {STORAGE_API.stub && (
          <span data-testid="settings-storage-stub" className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-ink-3">
            {STUB_NOTICE}
          </span>
        )}
      </div>

      {info.isPending && <p data-testid="settings-storage-loading" className="text-xs text-neutral-500 dark:text-neutral-400">读取存储信息…</p>}
      {info.isError && (
        <p role="alert" data-testid="settings-storage-error" className="text-xs text-red-600 dark:text-red-400">
          读取存储信息失败：{info.error instanceof Error ? info.error.message : '未知错误'}
        </p>
      )}

      {data && (
        <div className="space-y-1.5 text-xs">
          <p data-testid="settings-storage-current" className="break-all text-ink">
            <span className="text-ink-3">当前路径：</span>
            <span className="font-mono">{data.db_path}</span>
          </p>
          <p data-testid="settings-storage-source" className="text-ink-3">
            来源：<span className={data.db_path_source === 'env' ? 'text-accent' : ''}>{storageSourceLabel(data.db_path_source)}</span>
          </p>
          <p data-testid="settings-storage-attachments" className="break-all text-ink-3">
            附件目录：<span className="font-mono text-ink-2">{data.attachments_dir}</span>
          </p>
          {data.usage === null ? (
            <p data-testid="settings-storage-usage-missing" className="text-ink-3">
              占用：服务端未提供统计（前端不自行扫描或估算）
            </p>
          ) : (
            <p data-testid="settings-storage-usage" className="tabular-nums text-ink-3">
              占用 <span className="text-ink">{formatBytes(data.usage.total_bytes)}</span>
              （db {formatBytes(data.usage.db_bytes)} · wal {formatBytes(data.usage.wal_bytes)} · shm {formatBytes(data.usage.shm_bytes)} · 附件 {formatBytes(data.usage.attachments_bytes)}）
            </p>
          )}
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-1.5">
          <label className="block text-xs text-ink-2">
            新的数据库位置
            <input
              data-testid="settings-storage-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={envLocked}
              placeholder="D:\\AgentBoard\\agentboard.db"
              className="mt-1 w-full rounded-md border border-hairline bg-surface-card px-2 py-1 text-xs text-ink outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
          {envLocked && (
            <p data-testid="settings-storage-env-lock" className="text-xs text-accent">
              当前由环境变量 <span className="font-mono">AGENTBOARD_DB</span> 指定：改了也不会生效，请改环境变量后重启服务。
            </p>
          )}
          {!envLocked && validation !== null && !validation.ok && target !== '' && (
            <p data-testid="settings-storage-validation" className="text-xs text-amber-700 dark:text-amber-300">{validation.message}</p>
          )}
          <button
            type="button"
            data-testid="settings-storage-submit"
            disabled={envLocked || validation === null || !validation.ok}
            onClick={() => setConfirming(true)}
            className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink disabled:opacity-40"
          >
            迁移到该位置
          </button>
        </div>
      )}

      {confirming && data && (
        <div data-testid="settings-storage-confirm" role="dialog" aria-label="确认迁移" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p>{migrationConfirmText(data.migration_estimate, target.trim())}</p>
          <div className="mt-1.5 flex gap-2">
            <button type="button" data-testid="settings-storage-confirm-yes" onClick={() => void runMigration()} className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-accent-ink">确认迁移</button>
            <button type="button" data-testid="settings-storage-confirm-no" onClick={() => setConfirming(false)} className="rounded px-2 py-1 text-[11px] text-ink-3">取消</button>
          </div>
        </div>
      )}

      {failure !== null && (
        <p role="alert" data-testid="settings-storage-migrate-error" className="mt-2 text-xs text-red-600 dark:text-red-400">{failure}</p>
      )}

      {migration && (
        <div data-testid="settings-storage-migration" data-status={migration.status} className="mt-2 rounded-md border border-hairline p-2 text-xs">
          <p className="text-ink-2">
            迁移目标：<span className="font-mono text-ink">{migration.target_path}</span>
          </p>
          <ol data-testid="settings-storage-stages" className="mt-1 flex flex-wrap gap-2 text-[11px]">
            {STORAGE_MIGRATION_STAGES.map((stage) => {
              const index = STORAGE_MIGRATION_STAGES.findIndex((item) => item.id === migration.stage);
              const state = STORAGE_MIGRATION_STAGES.findIndex((item) => item.id === stage.id) < index ? 'done' : stage.id === migration.stage ? 'current' : 'todo';
              return (
                <li key={stage.id} data-testid={`settings-storage-stage-${stage.id}`} data-state={state}
                  className={state === 'done' ? 'text-ink-3' : state === 'current' ? 'text-accent' : 'text-ink-3 opacity-60'}>
                  {stage.label}
                </li>
              );
            })}
          </ol>
          {migration.status === 'running' && <p data-testid="settings-storage-migrating" className="mt-1 text-ink-2">迁移进行中，请勿关闭窗口…</p>}
          {migration.status === 'succeeded' && (
            <p data-testid="settings-storage-migrated" className="mt-1 text-ink">
              迁移完成：新路径 <span className="font-mono">{migration.target_path}</span>（服务已重启）
            </p>
          )}
          {migration.status === 'failed' && (
            <p data-testid="settings-storage-failed" role="alert" className="mt-1 text-red-600 dark:text-red-400">
              迁移失败：{migration.error_code ?? '未知错误'}
              {migration.rolled_back ? '；已回滚到原路径' : '；未回滚，请人工检查'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
