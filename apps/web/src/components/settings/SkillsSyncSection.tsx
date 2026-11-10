/**
 * SKILLS-SYNC 设置分区：把项目自带的 8 份配套技能一键复制到本机常见 agent skills 目录。
 *
 * - 目标目录由服务端固定枚举（GET /api/settings/skills-sync/targets），前端只做勾选与状态展示；
 * - 复制（POST）遇 409 SKILLS_SYNC_CONFLICT 时弹「覆盖 / 跳过 / 备份后覆盖」三选再重提；
 * - 结果区展示每目标文件数、备份目录与逐文件错误；已同步目标提供移除（DELETE）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';

type TargetStatus = 'synced' | 'stale' | 'never' | 'unavailable';
type ConflictPolicy = 'overwrite' | 'skip' | 'backup';

interface TargetView {
  id: string;
  label: string;
  path: string;
  resolved_path: string | null;
  exists: boolean;
  creatable: boolean;
  shared_with: string[];
  is_source: boolean;
  status: TargetStatus;
  skills_present: number;
  synced_at: string | null;
}

interface ProbeResponse {
  source: { root: string; skill_count: number; file_count: number; hash: string };
  targets: TargetView[];
}

interface SyncSkillResult {
  name: string;
  files: number;
  bytes: number;
  status: 'copied' | 'overwritten' | 'backup_overwritten' | 'unchanged' | 'skipped';
}

interface SyncTargetResult {
  target_id: string;
  path: string;
  action: 'copied' | 'skipped' | 'nothing';
  backup_dir: string | null;
  skills: SyncSkillResult[];
  errors: Array<{ skill: string; file: string | null; message: string }>;
}

interface SyncResponse {
  results: SyncTargetResult[];
  summary: { targets: number; copied: number; skipped: number; errors: number; total_files: number };
}

interface ConflictItem {
  target_id: string;
  skill: string;
  reason: string;
}

const STATUS_LABEL: Record<TargetStatus, string> = {
  synced: '已同步',
  stale: '有差异',
  never: '未同步',
  unavailable: '不可用',
};

const POLICY_LABEL: Record<ConflictPolicy, string> = {
  overwrite: '覆盖',
  skip: '跳过',
  backup: '备份后覆盖',
};

/** 本地时间显示（服务端存 ISO） */
function formatSyncedAt(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusBadgeCls(status: TargetStatus): string {
  if (status === 'synced') return 'rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent';
  if (status === 'stale') return 'rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-ink-2';
  if (status === 'unavailable') return 'rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-ink-3';
  return 'rounded-full border border-hairline px-2 py-0.5 text-[10px] text-ink-3';
}

export function SkillsSyncSection() {
  const workspaceId = useAppStore((s) => s.workspaceId) ?? '';
  const queryClient = useQueryClient();
  const queryKey = ['settings-skills-sync', workspaceId];
  const [selected, setSelected] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const probe = useQuery({
    queryKey,
    // 未选择工作区时也能列 home 下的目标；只有「当前工作区」这一项依赖 workspaceId
    queryFn: () => api.get<ProbeResponse>(`/api/settings/skills-sync/targets${workspaceId === '' ? '' : `?workspace_id=${encodeURIComponent(workspaceId)}`}`),
    staleTime: 10_000,
  });

  const targets = probe.data?.targets ?? [];
  const targetById = new Map(targets.map((target) => [target.id, target]));

  const sync = useMutation({
    mutationFn: (body: { target_ids: string[]; conflict?: ConflictPolicy }) =>
      api.post<SyncResponse>('/api/settings/skills-sync', { ...body, ...(workspaceId === '' ? {} : { workspace_id: workspaceId }) }),
    onSuccess: (data) => {
      setConflicts(null);
      setError(null);
      setResult(data);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.code === 'SKILLS_SYNC_CONFLICT') {
        const details = cause.details as { conflicts?: ConflictItem[] } | undefined;
        setConflicts(details?.conflicts ?? []);
        setResult(null);
        setError(null);
        return;
      }
      setError(cause instanceof Error ? cause.message : '复制失败');
    },
  });

  const remove = useMutation({
    mutationFn: (targetId: string) =>
      api.del<{ target_id: string; removed: string[]; errors: Array<{ skill: string; message: string }> }>(
        `/api/settings/skills-sync/${encodeURIComponent(targetId)}${workspaceId === '' ? '' : `?workspace_id=${encodeURIComponent(workspaceId)}`}`,
      ),
    onSuccess: () => {
      setError(null);
      setResult(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '移除失败'),
    onSettled: () => setRemoving(null),
  });

  const usable = (target: TargetView): boolean => !target.is_source && (target.exists || target.creatable);
  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };
  const runSync = (conflict?: ConflictPolicy): void => {
    if (selected.length === 0) return;
    sync.mutate(conflict === undefined ? { target_ids: selected } : { target_ids: selected, conflict });
  };

  const busy = sync.isPending || remove.isPending;

  return (
    <section data-testid="settings-section-skills-sync" aria-labelledby="settings-section-skills-sync-title" className="mt-4 border-t border-hairline pt-3">
      <h3 id="settings-section-skills-sync-title" className="mb-1 text-xs font-medium text-ink-2">配套技能同步</h3>
      <p className="text-xs text-ink-3">
        把项目自带的 {probe.data?.source.skill_count ?? 8} 份看板技能（{probe.data?.source.file_count ?? '—'} 个文件）复制到本机常见 agent 的 skills 目录。目标目录由服务端枚举，不接受任意路径。
      </p>
      {probe.data !== undefined && (
        <p data-testid="settings-skills-sync-source" className="mt-0.5 truncate font-mono text-[10px] text-ink-3" title={probe.data.source.root}>
          来源：{probe.data.source.root}
        </p>
      )}

      {probe.isPending && <p data-testid="settings-skills-sync-loading" className="mt-1 text-xs text-ink-3">读取目标目录…</p>}
      {probe.isError && (
        <p data-testid="settings-skills-sync-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
          读取目标目录失败：{probe.error instanceof Error ? probe.error.message : '未知错误'}
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {targets.map((target) => {
          const syncedAt = formatSyncedAt(target.synced_at);
          const disabled = !usable(target) || busy;
          return (
            <li key={target.id} data-testid={`skills-sync-target-${target.id}`} className="rounded-lg border border-hairline bg-surface-card px-2 py-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={target.label}
                  data-testid={`skills-sync-check-${target.id}`}
                  checked={selected.includes(target.id)}
                  disabled={disabled}
                  onChange={() => toggle(target.id)}
                  className="h-3.5 w-3.5 accent-[var(--ab-accent)]"
                />
                <span className="text-sm text-ink">{target.label}</span>
                <span data-testid={`skills-sync-status-${target.id}`} className={statusBadgeCls(target.status)}>
                  {STATUS_LABEL[target.status]}
                  {target.status === 'stale' ? ` · ${target.skills_present}/${probe.data?.source.skill_count ?? 8}` : ''}
                </span>
                {syncedAt !== null && <span className="ml-auto text-[10px] text-ink-3">同步于 {syncedAt}</span>}
                {(target.status === 'synced' || target.status === 'stale') && !target.is_source && (
                  <button
                    type="button"
                    data-testid={`skills-sync-remove-${target.id}`}
                    disabled={busy}
                    onClick={() => {
                      setRemoving(target.id);
                      remove.mutate(target.id);
                    }}
                    className={`${BUTTON_SECONDARY} ${syncedAt === null ? 'ml-auto' : ''}`}
                  >
                    {removing === target.id ? '移除中…' : '移除'}
                  </button>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 pl-5">
                <span className="truncate font-mono text-[10px] text-ink-3" title={target.resolved_path ?? target.path}>
                  {target.path}
                </span>
                {target.is_source && <span className="text-[10px] text-ink-3">技能来源目录，禁止复制/移除</span>}
                {!target.exists && target.creatable && <span className="text-[10px] text-ink-3">目录不存在，复制时创建</span>}
                {!target.exists && !target.creatable && <span className="text-[10px] text-ink-3">父目录不可用</span>}
                {target.shared_with.length > 0 && (
                  <span data-testid={`skills-sync-shared-${target.id}`} className="text-[10px] text-ink-3">
                    与 {target.shared_with.map((id) => targetById.get(id)?.label ?? id).join('、')} 同一物理目录
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="skills-sync-copy"
          disabled={selected.length === 0 || busy}
          onClick={() => runSync()}
          className={BUTTON_PRIMARY}
        >
          {sync.isPending ? '复制中…' : `复制所选（${selected.length}）`}
        </button>
        <span className="text-[10px] text-ink-3">已存在同名技能时会先询问：覆盖 / 跳过 / 备份后覆盖。</span>
      </div>

      {conflicts !== null && (
        <div data-testid="skills-sync-conflict" className="mt-2 rounded-lg border border-hairline bg-surface-raised px-2 py-1.5">
          <p className="text-xs text-ink">目标已存在同名技能，请选择处理方式：</p>
          {conflicts.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[10px] text-ink-3">
              {conflicts.map((item) => (
                <li key={`${item.target_id}:${item.skill}`}>
                  {targetById.get(item.target_id)?.label ?? item.target_id} / {item.skill}：{item.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[10px] text-ink-3">服务端未返回明细；直接选择处理方式即可。</p>
          )}
          <div className="mt-1.5 flex gap-2">
            {(['overwrite', 'skip', 'backup'] as ConflictPolicy[]).map((policy) => (
              <button
                key={policy}
                type="button"
                data-testid={`skills-sync-conflict-${policy}`}
                disabled={sync.isPending}
                onClick={() => runSync(policy)}
                className={BUTTON_SECONDARY}
              >
                {POLICY_LABEL[policy]}
              </button>
            ))}
            <button type="button" disabled={sync.isPending} onClick={() => setConflicts(null)} className={BUTTON_SECONDARY}>
              取消
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" data-testid="skills-sync-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {result !== null && (
        <div data-testid="skills-sync-result" className="mt-2 rounded-lg border border-hairline bg-surface-card px-2 py-1.5">
          <p className="text-xs text-ink">
            完成：{result.results.length} 个目标，写入{' '}
            {result.results.reduce(
              (sum, item) => sum + item.skills.filter((skill) => skill.status !== 'unchanged' && skill.status !== 'skipped').reduce((inner, skill) => inner + skill.files, 0),
              0,
            )}{' '}
            个文件，错误 {result.summary.errors} 个。
          </p>
          <ul className="mt-1 space-y-1">
            {result.results.map((item) => {
              const written = item.skills.filter((skill) => skill.status !== 'skipped' && skill.status !== 'unchanged').length;
              const unchanged = item.skills.filter((skill) => skill.status === 'unchanged').length;
              const skipped = item.skills.filter((skill) => skill.status === 'skipped').length;
              return (
                <li key={item.target_id} data-testid={`skills-sync-result-${item.target_id}`} className="text-[11px] text-ink-2">
                  <span className="text-ink">{targetById.get(item.target_id)?.label ?? item.target_id}</span>
                  {'：'}
                  写入 {written} 个技能
                  {unchanged > 0 ? `，${unchanged} 个已是最新` : ''}
                  {skipped > 0 ? `，跳过 ${skipped} 个` : ''}
                  {item.backup_dir !== null && <span className="text-ink-3">（备份：{item.backup_dir}）</span>}
                  {item.errors.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5 text-[10px] text-red-600 dark:text-red-400">
                      {item.errors.map((issue) => (
                        <li key={`${item.target_id}:${issue.skill}:${issue.file ?? ''}`}>
                          {issue.skill}
                          {issue.file === null ? '' : ` / ${issue.file}`}：{issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
