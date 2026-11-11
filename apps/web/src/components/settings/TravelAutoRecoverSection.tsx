/**
 * 设置 → 猫猫旅行自动回收开关（SETTINGS-TRAVEL）。
 *
 * 读写 `settings.travelAutoRecover`（后端默认 true）：`PATCH /api/settings` 即时生效，
 * ticker 每轮实时读取，无需重启。与「服务与并发」表单互不依赖——本分区自己发请求、
 * 自己失效 `['settings']` 缓存，不参与底部「保存」按钮的 dirty 判定。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';

interface TravelSettings {
  travelAutoRecover?: boolean;
}

export function TravelAutoRecoverSection() {
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);

  // 与 SettingsDialog 共用 ['settings'] 缓存（同 key 自动去重，不额外发请求）
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<TravelSettings>('/api/settings'),
  });
  const enabled = settingsQuery.data?.travelAutoRecover ?? true;

  const save = useMutation({
    mutationFn: (next: boolean) => api.patch('/api/settings', { travelAutoRecover: next }),
    onSuccess: () => {
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : '保存失败'),
  });

  const disabled = settingsQuery.isLoading || save.isPending;

  return (
    <section
      data-testid="settings-section-travel"
      aria-labelledby="settings-section-travel-title"
      className="mt-4 border-t border-hairline pt-3"
    >
      <h3
        id="settings-section-travel-title"
        className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3"
      >
        猫猫旅行
        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium normal-case text-accent">
          即时生效，无需保存
        </span>
      </h3>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id="settings-travel-auto-recover-label" className="text-sm text-ink">
            自动回收猫猫旅行
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            签到成功派出后约 3 小时 45 分自动回收（4 小时窗口内有效）；关闭后不再自动回收。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="settings-travel-auto-recover"
          aria-checked={enabled}
          aria-labelledby="settings-travel-auto-recover-label"
          disabled={disabled}
          onClick={() => save.mutate(!enabled)}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? 'border-accent bg-accent' : 'border-hairline bg-surface-raised'
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-3.5 rounded-full bg-surface-card shadow transition-[left] duration-150 motion-reduce:transition-none ${
              enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {settingsQuery.isError && (
        <p role="alert" data-testid="settings-travel-read-error" className="mt-2 text-sm text-ink-2">
          读取设置失败
        </p>
      )}
      {saveError !== null && (
        <p role="alert" data-testid="settings-travel-save-error" className="mt-2 text-sm text-ink-2">
          {saveError}
        </p>
      )}
    </section>
  );
}
