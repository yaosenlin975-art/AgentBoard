/**
 * 星图控件面板（KB-GRAPH-P4）——照 `Docs/Obsidian-星图渲染逆向.md` B.2：
 * 面板宽 240px、右上角、可滚动且隐藏滚动条；四个折叠区 mod-filter / mod-color-groups / mod-display / mod-forces，默认收起；
 * 区头按钮 close（×）/ open（齿轮）/ animate（魔棒，仅全局图）/ reset（恢复默认）。
 * 颜色与边框全部来自 `index.css` 的 `--kb-graph-*` 变量（亮/暗两套），组件内不写死色值。
 */
import { useState } from 'react';
import { LOCAL_JUMPS_MAX, LOCAL_JUMPS_MIN } from '../../lib/localGraph';

export interface ForceSliders {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

/** 文档 A4 默认值 */
export const FORCE_SLIDER_DEFAULTS: ForceSliders = {
  centerStrength: 0.1,
  repelStrength: 1000,
  linkStrength: 1,
  linkDistance: 250,
};

export interface GraphControlsProps {
  localMode: boolean;
  localJumps: number;
  forelinks: boolean;
  backlinks: boolean;
  interlinks: boolean;
  hideOrphans: boolean;
  showIsolated: boolean;
  forces: ForceSliders;
  onLocalMode: (value: boolean) => void;
  onLocalJumps: (value: number) => void;
  onForelinks: (value: boolean) => void;
  onBacklinks: (value: boolean) => void;
  onInterlinks: (value: boolean) => void;
  onHideOrphans: (value: boolean) => void;
  onShowIsolated: (value: boolean) => void;
  onForces: (patch: Partial<ForceSliders>) => void;
  onReset: () => void;
}

const SLIDER_FIELDS: Array<{ key: keyof ForceSliders; label: string; min: number; max: number; step: number }> = [
  { key: 'centerStrength', label: '中心力', min: 0, max: 1, step: 0.01 },
  { key: 'repelStrength', label: '斥力', min: 0, max: 20000, step: 100 },
  { key: 'linkStrength', label: '连接力', min: 0, max: 1, step: 0.05 },
  { key: 'linkDistance', label: '连接距离', min: 30, max: 500, step: 10 },
];

const buttonClass =
  'rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700';

/** 折叠区：原生 <details> 默认收起（与文档 setCollapsed(!0) 一致），键盘可达 */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <details data-testid={`graph-section-${id}`} className="border-t border-[var(--kb-graph-menu-border)] px-2 py-1">
      <summary className="cursor-pointer select-none py-1 text-xs font-medium text-neutral-700 dark:text-neutral-200">{title}</summary>
      <div className="pb-2 pt-1 text-xs text-neutral-600 dark:text-neutral-300">{children}</div>
    </details>
  );
}

export function GraphControls(props: GraphControlsProps) {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <div data-testid="graph-controls" data-state="closed" className="ab-graph-controls is-close">
        <button
          type="button"
          data-testid="graph-controls-toggle"
          aria-label="打开星图设置"
          title="星图设置"
          className={buttonClass}
          onClick={() => setOpen(true)}
        >
          ⚙
        </button>
      </div>
    );
  }

  return (
    <div data-testid="graph-controls" data-state="open" className="ab-graph-controls" role="group" aria-label="星图设置">
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">星图设置</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="graph-controls-animate"
            aria-label="时间轴动画（未实现）"
            title="时间轴动画未实现（文档 D7）"
            aria-disabled
            className={`${buttonClass} opacity-40`}
            disabled
          >
            ✨
          </button>
          <button
            type="button"
            data-testid="graph-controls-reset"
            aria-label="恢复默认"
            title="恢复默认"
            className={buttonClass}
            onClick={props.onReset}
          >
            ↺
          </button>
          <button
            type="button"
            data-testid="graph-controls-close"
            aria-label="收起星图设置"
            title="收起"
            className={buttonClass}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </span>
      </div>

      <Section id="filter" title="过滤器">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-local-mode"
            checked={props.localMode}
            onChange={(event) => props.onLocalMode(event.target.checked)}
            className="size-3.5 accent-blue-600"
          />
          局部图（跟随聚焦节点）
        </label>
        <label className="mt-1 flex items-center gap-1">
          深度
          <select
            data-testid="graph-local-jumps"
            aria-label="局部图深度"
            value={props.localJumps}
            disabled={!props.localMode}
            onChange={(event) => props.onLocalJumps(Number(event.target.value))}
            className="rounded border border-neutral-300 bg-transparent px-1 py-0.5 text-xs dark:border-neutral-600"
          >
            {Array.from({ length: LOCAL_JUMPS_MAX - LOCAL_JUMPS_MIN + 1 }, (_, i) => LOCAL_JUMPS_MIN + i).map((jumps) => (
              <option key={jumps} value={jumps}>
                {jumps}
              </option>
            ))}
          </select>
        </label>
        {[
          ['graph-local-forelinks', '正向扩展', props.forelinks, props.onForelinks],
          ['graph-local-backlinks', '反向扩展', props.backlinks, props.onBacklinks],
          ['graph-local-interlinks', '相邻链接', props.interlinks, props.onInterlinks],
          ['graph-local-orphans', '隐藏孤立', props.hideOrphans, props.onHideOrphans],
        ].map(([testId, label, checked, onChange]) => (
          <label key={String(testId)} className="mt-1 flex items-center gap-1">
            <input
              type="checkbox"
              data-testid={String(testId)}
              checked={Boolean(checked)}
              disabled={!props.localMode}
              onChange={(event) => (onChange as (value: boolean) => void)(event.target.checked)}
              className="size-3.5 accent-blue-600"
            />
            {String(label)}
          </label>
        ))}
      </Section>

      <Section id="color-groups" title="颜色组">
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          颜色取自 `.graph-view.color-*` 语义色（CSS 变量，亮/暗两套）。本图固定「项目知识 / 公共经验」两组，暂不支持自定义颜色组（文档里的拖拽排序也跳过）。
        </p>
      </Section>

      <Section id="display" title="显示">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-controls-isolated"
            checked={props.showIsolated}
            onChange={(event) => props.onShowIsolated(event.target.checked)}
            className="size-3.5 accent-blue-600"
          />
          显示孤立点
        </label>
      </Section>

      <Section id="forces" title="力">
        {SLIDER_FIELDS.map((field) => (
          <label key={field.key} className="mt-1 flex items-center gap-1">
            <span className="w-14 shrink-0">{field.label}</span>
            <input
              type="range"
              data-testid={`graph-forces-${field.key}`}
              aria-label={field.label}
              min={field.min}
              max={field.max}
              step={field.step}
              value={props.forces[field.key]}
              onChange={(event) => props.onForces({ [field.key]: Number(event.target.value) } as Partial<ForceSliders>)}
              className="w-20"
            />
            <span className="w-10 tabular-nums text-right">{props.forces[field.key]}</span>
          </label>
        ))}
      </Section>
    </div>
  );
}
