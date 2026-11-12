/**
 * CLI-DEFAULT-MODEL-3：设置页「各 CLI 默认模型」分区（独立 section + 独立保存，不并入主表单）。
 * - 行数据：GET /api/clis（queryKey ['clis'] 与顶栏/弹窗共享缓存）；未安装的 CLI 标注（未安装）仍可配置。
 * - 每 CLI 一行：displayName + 复用 ModelField（下拉 + 手动输入 / 空清单文本输入 / dsh 只读由 profile 决定 /
 *   值不在清单黄色提示——保存由服务端裁决 MODEL-DEFAULT 校验）。
 * - 空值选项 = 不配置语义（「使用 <cli> 自身默认」），保存为 '' 即删键（MODEL-1 口径）。
 * - 保存：PATCH /api/settings {"cliDefaultModels": {…}}（只含本分区字段）；成功 invalidate ['settings']；
 *   400/422 展示服务端 message（testid=cli-default-model-error），保留用户输入不回滚。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo } from '@agentboard/shared';
import { api } from '../../api/client';
import { ModelField } from '../chat/ModelField';

interface SettingsPayload {
  port: number;
  dbPath: string;
  maxConcurrentTurns: number;
  /** MODEL-1：各 CLI 默认模型（缺省 {}；旧服务端无该字段按未配置处理） */
  cliDefaultModels?: Record<string, string>;
}

export function CliDefaultModelSection() {
  const queryClient = useQueryClient();
  const { data: clis } = useQuery({ queryKey: ['clis'], queryFn: () => api.get<CliInfo[]>('/api/clis') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsPayload>('/api/settings') });

  const persisted = settings?.cliDefaultModels ?? {};
  // 编辑态：null = 未改动（直接展示持久化值）；改动后为全量草稿（保存按按键合并，'' 为删键）
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 设置重新拉取（保存成功失效缓存/外部变更）后丢弃过期草稿基线，避免拿旧值比较出假脏
  useEffect(() => {
    setDraft(null);
  }, [settings]);

  const values = draft ?? persisted;
  const dirty =
    draft !== null && JSON.stringify(normalizeMap(draft)) !== JSON.stringify(normalizeMap(persisted));

  const save = useMutation({
    mutationFn: (body: { cliDefaultModels: Record<string, string> }) =>
      api.patch<SettingsPayload>('/api/settings', body),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: unknown) => {
      // 保留用户输入不回滚；展示服务端 message（MODEL-1 的 400 VALIDATION_ERROR / 422 MODEL_UNAVAILABLE）
      const message =
        typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : '保存失败';
      setError(message);
      setSaved(false);
    },
  });

  const change = (cliId: string, value: string): void => {
    setSaved(false);
    setError(null);
    setDraft({ ...values, [cliId]: value });
  };

  return (
    <section data-testid="settings-section-cli-default-model" className="mt-4 border-t border-hairline pt-3">
      <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        各 CLI 默认模型
        <span data-testid="cli-default-model-badge" className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium normal-case text-ink-3">
          新建会话/派发未显式选模型时使用
        </span>
      </h3>
      <p className="mb-2 text-xs text-ink-3">
        留空即不配置（使用该 CLI 自身默认）；显式选择的模型始终优先于这里的默认值。
      </p>
      {(clis ?? []).map((cli) => (
        <label key={cli.id} className="mb-2 block text-sm">
          <span className="mb-1 flex items-center gap-2 text-ink-2">
            {cli.displayName}
            {!cli.installed && <span className="text-xs text-ink-3">（未安装）</span>}
          </span>
          <ModelField
            cliId={cli.id}
            value={values[cli.id] ?? ''}
            onChange={(value) => change(cli.id, value)}
            testid={`cli-default-model-${cli.id}`}
            ariaLabel={`${cli.displayName} 默认模型`}
            emptyOptionLabel={`使用 ${cli.displayName} 自身默认`}
          />
        </label>
      ))}
      {error !== null && (
        <p role="alert" data-testid="cli-default-model-error" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" data-testid="cli-default-model-saved" className="text-sm text-accent">
          已保存
        </p>
      )}
      <div className="flex justify-end pt-1">
        <button
          type="button"
          data-testid="cli-default-model-save"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ cliDefaultModels: normalizeMap(values) })}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-colors duration-150 hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          保存默认模型
        </button>
      </div>
    </section>
  );
}

/** 空串键规整：把 '' 视为显式删键保留（服务端口径），只剔除 undefined；键排序保证脏检查稳定 */
function normalizeMap(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
