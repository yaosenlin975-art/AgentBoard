/**
 * DB-3B-W：设置里的「数据存储」分区 —— 接真端点（DB-3 已交付，桩已移除）。
 *
 * 四个状态都要能看见：正常（路径/来源/占用/附件目录）、迁移中（五格阶段 + 新路径）、
 * 完成（新路径）、失败（中文原因 + 是否已回滚）。
 * 统计数字全部来自服务端（`GET /api/settings/storage`）；`truncated` 或缺失时写「统计过大已省略」。
 * env 覆盖态（`AGENTBOARD_DB` 生效）下输入框禁用并说明原因——不给一个改了也不生效的入口。
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as storageContract from '../../lib/storageSettings';
import {
  MIGRATION_ERROR_TEXT,
  STORAGE_MIGRATION_STAGES,
  migrationConfirmText,
  migrationErrorText,
  storageSourceLabel,
  usageSummary,
  validateTargetPath,
  type StorageInfo,
  type StorageMigration,
} from '../../lib/storageSettings';

export function StorageSection() {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ['settings-storage'], queryFn: storageContract.fetchStorageInfo, staleTime: 30_000 });
  const [target, setTarget] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [migration, setMigration] = useState<StorageMigration | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // FOLDER-PICK：原生目录选择在途（端点有单例守卫，请求期间必须禁用按钮）
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(false);

  const data: StorageInfo | undefined = info.data;
  const envLocked = data?.db_path_source === 'env';
  const validation = useMemo(
    () => (data === undefined ? null : validateTargetPath(target, data.db_path)),
    [target, data],
  );

  const runMigration = async (): Promise<void> => {
    setConfirming(false);
    setFailure(null);
    setBusy(true);
    try {
      const started = await storageContract.startStorageMigration(target.trim(), overwrite);
      if (started.migrationId === null) {
        setFailure('迁移已受理但服务端未返回 migration_id，无法跟踪进度');
        return;
      }
      // 迁移会重启服务：先按「进行中」渲染，再轮询到终态
      setMigration({
        migrationId: started.migrationId,
        status: 'running',
        stage: 'check',
        reached: ['check'],
        targetPath: target.trim(),
        errorCode: null,
        message: started.message,
        rolledBack: false,
        backupDir: null,
      });
      if (pollRef.current) return;
      pollRef.current = true;
      try {
        const final = await storageContract.pollMigration(started.migrationId, (view) => setMigration(view));
        if (final !== null) {
          setMigration(final);
          if (final.status === 'succeeded') void queryClient.invalidateQueries({ queryKey: ['settings-storage'] });
        }
      } finally {
        pollRef.current = false;
      }
    } catch (error) {
      const code = error instanceof storageContract.StorageApiError ? error.code : null;
      setFailure(migrationErrorText(code, error instanceof Error ? error.message : '迁移请求失败'));
    } finally {
      setBusy(false);
    }
  };

  const migrating = busy || migration?.status === 'running';
  const submitDisabled = envLocked || migrating || validation === null || !validation.ok;
  const isBusyCode = failure !== null && failure.includes(MIGRATION_ERROR_TEXT.DB_MIGRATION_BUSY!);

  return (
    <section data-testid="settings-storage" className="mt-4 border-t border-hairline pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-ink-2">数据存储</h3>
      </div>

      {info.isPending && <p data-testid="settings-storage-loading" className="text-xs text-ink-3">读取存储信息…</p>}
      {info.isError && (
        <p role="alert" data-testid="settings-storage-error" className="text-xs text-red-600 dark:text-red-400">
          读取存储信息失败：{info.error instanceof Error ? info.error.message : '未知错误'}
        </p>
      )}

      {data && (
        <div className="space-y-1.5 text-xs">
          <p data-testid="settings-storage-current" className="break-all text-ink">
            <span className="text-ink-3">中心库路径：</span>
            <span className="font-mono">{data.db_path}</span>
          </p>
          <p data-testid="settings-storage-source" className="text-ink-3">
            来源：<span className={data.db_path_source === 'env' ? 'text-accent' : ''}>{storageSourceLabel(data.db_path_source)}</span>
          </p>
          <p data-testid="settings-storage-attachments" className="break-all text-ink-3">
            附件目录：<span className="font-mono text-ink-2">{data.attachments_dir}</span>
          </p>
          <p
            data-testid={data.usage === null ? 'settings-storage-usage-missing' : 'settings-storage-usage'}
            data-truncated={data.truncated ? 'true' : 'false'}
            className="tabular-nums text-ink-3"
          >
            占用：<span className="text-ink">{usageSummary(data)}</span>
          </p>
          {data.migration_estimate !== null && (
            <p data-testid="settings-storage-estimate" className="tabular-nums text-ink-3">
              迁移量：{data.migration_estimate.issue_count} 张卡 · {data.migration_estimate.attachment_count} 个附件 · 需{' '}
              {storageContract.formatBytes(data.migration_estimate.required_bytes)} 可用空间
            </p>
          )}
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-1.5">
          <div className="text-xs text-ink-2">
            <label htmlFor="settings-storage-target">新的中心库路径</label>
            {/* FOLDER-PICK：窄屏（375）下按钮换行到输入框下方，不与输入框重叠 */}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <input
              id="settings-storage-target"
              data-testid="settings-storage-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={envLocked || migrating}
              placeholder="D:\\AgentBoard\\agentboard.db"
              className="min-w-0 flex-1 basis-48 rounded-md border border-hairline bg-surface-card px-2 py-1 text-xs text-ink outline-none focus:border-accent disabled:opacity-60"
            />
            <button
              type="button"
              data-testid="settings-storage-pick"
              disabled={envLocked || migrating || picking}
              aria-busy={picking}
              onClick={() => {
                setPickError(null);
                setPicking(true);
                void storageContract.pickFolder()
                  .then((picked) => { if (picked !== null) setTarget(picked); })
                  .catch((error: unknown) => setPickError(error instanceof Error ? error.message : '选择文件夹失败'))
                  .finally(() => setPicking(false));
              }}
              className="shrink-0 rounded-md border border-hairline px-2 py-1 text-xs text-ink disabled:opacity-40"
            >
              {picking ? '选择中…' : '选择…'}
            </button>
            </div>
            {pickError !== null && (
              <p role="alert" data-testid="settings-storage-pick-error" className="mt-1 text-xs text-red-600 dark:text-red-400">{pickError}</p>
            )}
          </div>
          {envLocked && (
            <p data-testid="settings-storage-env-lock" className="text-xs text-accent">
              数据库位置由环境变量 <span className="font-mono">AGENTBOARD_DB</span> 指定，无法在此修改（改环境变量后重启服务）。
            </p>
          )}
          {!envLocked && validation !== null && !validation.ok && target !== '' && (
            <p data-testid="settings-storage-validation" className="text-xs text-accent">{validation.message}</p>
          )}
          {!envLocked && (
            <label className="flex items-center gap-1.5 text-xs text-ink-3">
              <input
                type="checkbox"
                data-testid="settings-storage-overwrite"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
                disabled={migrating}
                className="h-3.5 w-3.5 accent-[var(--ab-accent)]"
              />
              覆盖目标位置的同名数据库
            </label>
          )}
          <button
            type="button"
            data-testid="settings-storage-submit"
            disabled={submitDisabled}
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-hairline bg-surface-card px-2.5 py-1 text-xs text-ink ab-transition hover:bg-surface-raised disabled:opacity-40"
          >
            {migrating ? '迁移进行中…' : '迁移到该位置'}
          </button>
        </div>
      )}

      {confirming && data && (
        <div data-testid="settings-storage-confirm" role="dialog" aria-label="确认迁移" className="mt-2 rounded-lg border border-hairline bg-surface-raised p-2.5 text-xs text-ink">
          <p>{migrationConfirmText(data.migration_estimate, target.trim())}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="settings-storage-confirm-yes" onClick={() => void runMigration()} className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink">
              确认迁移
            </button>
            <button type="button" data-testid="settings-storage-confirm-no" onClick={() => setConfirming(false)} className="rounded-lg px-2.5 py-1 text-xs text-ink-3">
              取消
            </button>
          </div>
        </div>
      )}

      {failure !== null && (
        <p role="alert" data-testid="settings-storage-migrate-error" data-busy={isBusyCode ? 'true' : 'false'} className="mt-2 text-xs text-red-600 dark:text-red-400">
          {failure}
        </p>
      )}

      {migration && (
        <div data-testid="settings-storage-migration" data-status={migration.status} className="mt-2 rounded-lg border border-hairline p-2.5 text-xs">
          <p className="break-all text-ink-2">
            迁移目标：<span className="font-mono text-ink">{migration.targetPath ?? '—'}</span>
          </p>
          <ol data-testid="settings-storage-stages" className="mt-1.5 flex flex-wrap gap-2 text-xs">
            {STORAGE_MIGRATION_STAGES.map((stage) => {
              const reachedIndex = migration.reached.indexOf(stage.id);
              // 完成态：所有到达过的格子都算 done（不再留一格「进行中」）；进行中/失败才用 current 标当前格
              const state = reachedIndex === -1
                ? 'todo'
                : migration.status === 'succeeded'
                  ? 'done'
                  : stage.id === migration.stage
                    ? 'current'
                    : 'done';
              return (
                <li
                  key={stage.id}
                  data-testid={`settings-storage-stage-${stage.id}`}
                  data-state={state}
                  className={`tabular-nums ${state === 'current' ? 'font-medium text-accent' : state === 'done' ? 'text-ink-2' : 'text-ink-3 opacity-60'}`}
                >
                  {state === 'done' ? '✓ ' : ''}{stage.label}
                </li>
              );
            })}
          </ol>
          {migration.status === 'running' && (
            <p data-testid="settings-storage-migrating" className="mt-1.5 text-ink-2">
              迁移进行中（服务会重启，进度自动刷新）…
            </p>
          )}
          {migration.status === 'succeeded' && (
            <p data-testid="settings-storage-migrated" className="mt-1.5 break-all text-ink">
              迁移完成：新路径 <span className="font-mono">{migration.targetPath ?? '—'}</span>
              {migration.backupDir !== null && <>（备份在 <span className="font-mono text-ink-3">{migration.backupDir}</span>）</>}
            </p>
          )}
          {migration.status === 'failed' && (
            <p data-testid="settings-storage-failed" role="alert" className="mt-1.5 text-red-600 dark:text-red-400">
              迁移失败：{migration.message}
              {migration.rolledBack ? '（已回滚到原路径）' : ''}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
