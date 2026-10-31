/**
 * 模型选择字段（新建会话弹窗 / 修改模型弹窗共用）：
 * react-query 拉 /api/clis/{cliId}/models（cliId 为空不拉）；models 非空渲染 <select>
 * （可选空值选项，末尾固定"手动输入…"，选中后切文本输入、旁有"返回列表"回下拉）；
 * models 为空 / 查询失败 / 加载中渲染纯文本输入框（现状行为）。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModelInfo } from '@agentboard/shared';
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
  const { data: models } = useQuery({
    queryKey: ['clis', cliId, 'models'],
    queryFn: () => api.get<ModelInfo[]>(`/api/clis/${cliId}/models`),
    enabled: cliId !== '',
  });
  // null = 自动推断（models 空、或当前值不在列表 → 输入框；否则下拉）。
  // 用户显式进入手动输入 / 在输入框键入后保持输入框视图（含清空），直至"返回列表"或下拉重新选中。
  const [view, setView] = useState<'select' | 'input' | null>(null);
  useEffect(() => {
    setView(null); // 切 CLI：模型列表变化，回到自动推断
  }, [cliId]);

  const list = models ?? [];
  const inList = list.some((m) => m.id === value);
  const effectiveView: 'select' | 'input' =
    view ?? (list.length === 0 || (value !== '' && !inList) ? 'input' : 'select');

  if (effectiveView === 'select') {
    return (
      <select
        data-testid={testid}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          if (e.target.value === MANUAL_OPTION) {
            setView('input');
            return;
          }
          setView(null);
          onChange(e.target.value);
        }}
        className={fieldCls}
      >
        {emptyOptionLabel !== undefined && <option value="">{emptyOptionLabel}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
        <option value={MANUAL_OPTION}>手动输入…</option>
      </select>
    );
  }

  return (
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
          onClick={() => setView('select')} // 强制回下拉（当前值不在列表时自动推断会留在输入框）
          className="shrink-0 rounded border border-neutral-300 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          返回列表
        </button>
      )}
    </div>
  );
}
