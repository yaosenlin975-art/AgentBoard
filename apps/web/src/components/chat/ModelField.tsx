/**
 * 模型选择字段（新建会话弹窗 / 修改模型弹窗共用）：
 * react-query 拉 /api/clis/{cliId}/models（cliId 为空不拉）；models 非空渲染 <select>
 * （可选空值选项，末尾固定"手动输入…"，选中后切文本输入、旁有"返回列表"回下拉）；
 * 列表加载、失败、空值和当前值不在清单时保留可编辑值并提供状态提示与刷新。
 * CLI supportsModelSelection=false（如 dsh）→ 控件禁用并标注"由 profile 配置决定"（模型只读）。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CliInfo, ModelInfo } from '@agentboard/shared';
import { api } from '../../api/client';

/** "手动输入…"选项的哨兵 value（不与真实模型 id 冲突） */
const MANUAL_OPTION = '__manual__';

const fieldCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function ModelField({
  cliId,
  value,
  onChange,
  testid,
  placeholder = '输入模型 id',
  ariaLabel,
  emptyOptionLabel,
}: {
  cliId: string;
  value: string;
  onChange: (value: string) => void;
  /** 主控件（select/input）共用 testid；输入模式的"返回列表"按钮为 `${testid}-back` */
  testid: string;
  placeholder?: string;
  ariaLabel?: string;
  /** 非空时下拉渲染首项空值选项（value=''），供"留空清除"语义 */
  emptyOptionLabel?: string;
}) {
  const {
    data: models,
    isPending: modelsPending,
    isFetching: modelsFetching,
    isError: modelsError,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['clis', cliId, 'models'],
    queryFn: () => api.get<ModelInfo[]>(`/api/clis/${cliId}/models`),
    enabled: cliId !== '',
  });
  // 模型只读判定：queryKey ['clis'] 与顶栏/派发/新建会话弹窗共享缓存，命中即无额外请求
  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const modelReadOnly = clis?.find((c) => c.id === cliId)?.supportsModelSelection === false;
  // null = 自动推断（models 空、或当前值不在列表 → 输入框；否则下拉）。
  // 用户显式进入手动输入 / 在输入框键入后保持输入框视图（含清空），直至"返回列表"或下拉重新选中。
  const [view, setView] = useState<'select' | 'input' | null>(null);
  useEffect(() => {
    setView(null); // 切 CLI：模型列表变化，回到自动推断
  }, [cliId]);

  const list = models ?? [];
  const inList = list.some((m) => m.id === value);
  const valueNotInList = models !== undefined && value !== '' && !inList;
  const effectiveView: 'select' | 'input' =
    view ?? (list.length === 0 || valueNotInList ? 'input' : 'select');

  const modelListStatus = cliId === ''
    ? null
    : modelsError
      ? '模型列表加载失败，可重试或手动输入'
      : modelsPending
        ? '正在加载模型列表，可先手动输入'
        : modelsFetching
          ? '正在刷新模型列表'
          : list.length === 0
            ? '当前 CLI 未返回模型，可手动输入'
            : null;
  const refreshButton = cliId !== '' && !modelReadOnly ? (
    <button
      type="button"
      data-testid={`${testid}-refresh`}
      onClick={() => void refetchModels()}
      disabled={modelsFetching}
      className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
    >
      刷新模型列表
    </button>
  ) : null;
  const status = (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {modelListStatus !== null && (
        <p
          data-testid={`${testid}-state`}
          role={modelsError ? 'alert' : 'status'}
          className={`text-xs ${modelsError ? 'text-amber-700 dark:text-amber-300' : 'text-neutral-500 dark:text-neutral-400'}`}
        >
          {modelListStatus}
        </p>
      )}
      {valueNotInList && (
        <p data-testid={`${testid}-not-in-list`} role="status" className="text-xs text-amber-700 dark:text-amber-300">
          当前模型不在此 CLI 列表中
        </p>
      )}
      {refreshButton}
    </div>
  );

  // 模型只读（supportsModelSelection=false）：禁用当前形态的控件并标注，不提供切换/手输入口
  if (modelReadOnly) {
    const disabledCls = `${fieldCls} disabled:cursor-not-allowed disabled:opacity-60`;
    return (
      <div>
        {effectiveView === 'select' ? (
          <select data-testid={testid} aria-label={ariaLabel} value={value} disabled className={disabledCls}>
            {emptyOptionLabel !== undefined && <option value="">{emptyOptionLabel}</option>}
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-testid={testid}
            aria-label={ariaLabel}
            value={value}
            disabled
            placeholder={placeholder}
            className={disabledCls}
          />
        )}
        <p data-testid={`${testid}-readonly-hint`} className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          由 profile 配置决定
        </p>
        {status}
      </div>
    );
  }

  if (effectiveView === 'select') {
    return (
      <div>
        <select
          data-testid={testid}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => {
            if (e.target.value === MANUAL_OPTION) {
              setView('input');
              return;
            }
            if (e.target.value === value && valueNotInList) {
              setView('select');
              return;
            }
            setView(null);
            onChange(e.target.value);
          }}
          className={fieldCls}
        >
          {emptyOptionLabel !== undefined && <option value="">{emptyOptionLabel}</option>}
          {valueNotInList && <option value={value}>{value}（不在当前列表）</option>}
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
          <option value={MANUAL_OPTION}>手动输入…</option>
        </select>
        {status}
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-1">
        <input
          data-testid={testid}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => {
            setView('input'); // 输入中（含清空）保持在输入框视图，不自动弹回下拉
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className={fieldCls}
        />
        {list.length > 0 && (
          <button
            type="button"
            data-testid={`${testid}-back`}
            onClick={() => setView('select')}
            className="shrink-0 rounded border border-neutral-300 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
          >
            返回列表
          </button>
        )}
      </div>
      {status}
    </div>
  );
}
