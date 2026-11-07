/**
 * 工作空间卡片（WS-REORDER）：名称/路径/统计 + 拖拽把手 + 操作菜单（AUDIT-WS I-11 / WS-DRAWER-01）。
 * 拖拽由外层 WorkspaceList 的 DndContext 提供；上/下移与置顶走同一提交路径（乐观更新 + 失败回滚）。
 *
 * 布局：卡片容器（边框 + 最小高度）内含内容按钮（名称/路径/统计）与右上角 ⋮ 菜单；
 * 内容本身是 <button>，按钮不可嵌套，所以菜单触发器与面板都是它的兄弟节点、绝对锚在卡片右上角。
 * 名称与路径只让出「一个 28px 触发器 + 边距」的右侧空间（pr-10 = 40px；旧版为四个行内控件让出 pr-32 = 128px），
 * 因此相似仓库名（Networks… / Frameworks…）在 260px 抽屉里也能分辨；
 * 名称行 `min-w-0 flex-1 truncate` 优先占位、置顶徽标 shrink-0 排其后，路径整行 truncate 且 title 给全文。
 * 置顶 / 上移 / 下移 / 移除 收进 kebab 菜单（role=menu + role=menuitem），命中区 ≥28×28
 * （触发器 h-7 w-7，菜单项 min-h-7）。审计原文的「编辑」是对行内控件的概称：本卡原无重命名功能
 * （服务端无工作区改名端点），不新增；收进菜单的是 置顶/上移/下移/移除。
 *
 * 浮层口径：复用仓库既有做法（LabelFilterBar「更多」浮层 / MentionPopover），绝对定位贴在触发器下方、
 * 下方空间不足时朝上开；关闭 = 文档级 mousedown 判外部 + Esc（Esc 后焦点回触发器），
 * 菜单内 ↑↓/Home/End 漫游，Tab 离开即收起。
 * 不用 overlay/useDismissable：它在 open=false 的首次挂载也会把焦点抢回触发按钮，
 * 抽屉里每张卡各抢一次会打乱「抽屉打开时焦点落在搜索框」的既有行为。
 *
 * 颜色全部走 unslop 令牌（surface-card / hairline / ink-2 / accent-soft / accent），
 * 破坏性项沿用 ui/buttonStyles 的 BUTTON_DANGER 文案色（text-red-600 / dark:text-red-400），组件内不写死色值。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { RemoveWorkspaceDialog } from './RemoveWorkspaceDialog';
import { GRAB_CURSOR } from '../../lib/cursor';
import { useWorkspaceStatuses } from '../../lib/workspaceStatuses';

/** 菜单高度估算（4 项 × 28px + 内边距与描边）：下方放不下且上方更宽敞时朝上开 */
const MENU_HEIGHT_ESTIMATE = 144;

/** 菜单项选择器：menuitem 与 menuitemcheckbox（置顶是开关项）都要能键盘漫游 */
const MENU_ITEM_SELECTOR = '[role^="menuitem"]:not([disabled])';

/** 菜单项：28px 命中区（min-h-7）、整行可点；禁用口径同 BUTTON_SECONDARY */
const MENU_ITEM_CLASS =
  'flex min-h-7 w-full items-center rounded-none px-2 py-1.5 text-left text-xs text-ink-2 ' +
  'transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 ' +
  'focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none';

/** 菜单容器：与 LabelFilterBar 浮层同一套描边/底色/阴影令牌 */
const MENU_PANEL_CLASS =
  'absolute right-1 z-30 w-40 rounded-md border border-hairline bg-surface-card py-1 shadow-lg';

/**
 * STORE-7：工作区库只读徽标（只展示，不提供切换按钮——走哪个库由服务端判定）。
 * `undefined`（旧服务端/既有夹具）不显示；已定义但不认识的值给兜底文案，绝不因未知状态崩。
 */
export function workspaceDbBadge(
  workspace: Pick<Workspace, 'db_mode' | 'db_path'>,
): { label: string; title: string } | null {
  const path = workspace.db_path !== undefined && workspace.db_path !== '' ? `：${workspace.db_path}` : '';
  switch (workspace.db_mode) {
    case undefined:
    case 'center':
      return null;
    case 'localized':
      return { label: '本地库', title: `本地库${path}` };
    case 'localizing':
      return { label: '迁移中', title: '数据库迁移进行中，该工作区写请求暂时冻结' };
    case 'failed':
      return { label: '失败', title: '上次迁移失败，等待恢复；读走中心库，写被阻断' };
    default:
      return { label: '库状态未知', title: `未知库状态：${String(workspace.db_mode)}${path}` };
  }
}

export function WorkspaceCard({
  workspace,
  onMoveUp,
  onMoveDown,
  onTogglePin,
  pinned = false,
  canMoveUp = false,
  canMoveDown = false,
  statusCounts,
}: {
  workspace: Workspace;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /**
   * PERF-4b：由 WorkspaceList 的 counts 聚合按 workspace_id 下发。
   * `undefined` = counts 还在加载（先按 0 渲染，不发请求）；`null` = counts 不可用（404/失败），
   * 才回落到本卡自己的全量 `GET /api/issues`。
   */
  statusCounts?: Record<string, number> | null;
}) {
  const selected = useAppStore((s) => s.workspaceId === workspace.id);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const dbBadge = workspaceDbBadge(workspace);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAbove, setMenuAbove] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { data: issues } = useQuery({
    queryKey: ['issues', workspace.id],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspace.id)}`),
    // PERF-4b：只有 counts 不可用（null）时才回落旧全量；加载中（undefined）不发请求，避免 N+1
    enabled: statusCounts === null,
  });
  const sortable = useSortable({ id: workspace.id });
  // 与 IssueCard 同一写法：不用 @dnd-kit/utilities（未在 apps/web 依赖里声明）
  const sortableStyle = {
    transform: sortable.transform ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)` : undefined,
    transition: sortable.transition,
  };

  // SYS2：统计格读工作区状态字典（含「已废弃」与自定义状态），不再写死四列；
  // 字典外的历史状态归「其他」，保证统计加总 = 该工作区任务总数。
  // PERF-4b：计数优先用 counts 聚合（statusCounts），仅在其不可用（null）时回落到全量 issues。
  const { names: statusNames } = useWorkspaceStatuses(workspace.id);
  const counts = new Map<string, number>(statusNames.map((s) => [s, 0]));
  let otherCount = 0;
  if (statusCounts !== undefined && statusCounts !== null) {
    for (const [status, count] of Object.entries(statusCounts)) {
      if (counts.has(status)) counts.set(status, count);
      else otherCount += count;
    }
  } else {
    for (const issue of issues ?? []) {
      const key = issue.status as string;
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      else otherCount += 1;
    }
  }
  const statCells = statusNames.map((name) => ({ key: name, label: name, count: counts.get(name) ?? 0 }));
  if (otherCount > 0) statCells.push({ key: '其他', label: '其他', count: otherCount });
  // 超过 4 格换行（3 列两行），不横向溢出
  const statColumnClass = statCells.length <= 4 ? 'grid-cols-4' : 'grid-cols-3';

  /** restoreFocus：Esc 关闭把焦点还给触发器；点菜单项 / 点外部时不抢焦点 */
  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  function toggleMenu(): void {
    if (menuOpen) {
      closeMenu(true);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    const spaceBelow = rect === undefined ? Number.POSITIVE_INFINITY : window.innerHeight - rect.bottom;
    setMenuAbove(spaceBelow < MENU_HEIGHT_ESTIMATE && (rect?.top ?? 0) > spaceBelow);
    setMenuOpen(true);
  }

  // 菜单打开期间：点外部关闭、Esc 关闭并回收焦点（口径同 LabelFilterBar「更多」浮层）
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeMenu(true);
    };
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      closeMenu(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [menuOpen, closeMenu]);

  // 打开后焦点进第一个可用菜单项，键盘用户可直接 Enter
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)?.focus();
  }, [menuOpen]);

  /** role=menu 的箭头键漫游；Tab 视为离开菜单，直接收起 */
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        items[(current + 1 + items.length) % items.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case 'Tab':
        closeMenu(false);
        break;
      default:
        break;
    }
  }

  /** 菜单项点击：先执行动作再收起（移除项会开 Modal，焦点由 Modal 接管） */
  function runItem(action: (() => void) | undefined): void {
    action?.();
    closeMenu(false);
  }

  return (
    <div
      role="listitem"
      data-testid={`workspace-row-${workspace.id}`}
      ref={sortable.setNodeRef}
      style={sortableStyle}
      // 菜单打开时抬升本行层序，避免面板被后面的卡片盖住
      className={`relative mb-2 ${menuOpen ? 'z-30' : ''} ${sortable.isDragging ? 'z-10 opacity-80' : ''}`}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          data-testid={`workspace-drag-${workspace.id}`}
          aria-label={`拖拽排序 ${workspace.name}`}
          title="拖拽排序"
          ref={sortable.setActivatorNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          // I-11：把手命中区从纯文字宽度抬到 28px 高（w-6 h-7）
          className="mt-0.5 inline-flex h-7 w-6 shrink-0 items-center justify-center rounded text-xs text-ink-3 transition-colors hover:bg-accent-soft hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          // CURSOR-REUSE：复用 lib/cursor 的双色拖拽光标（原生 grab 在 Windows 是无描边白手掌，白底不可见）
          style={{ cursor: GRAB_CURSOR }}
        >
          ⋮⋮
        </button>
        <div
          data-workspace-card={workspace.id}
          className={`relative min-h-[6.5rem] min-w-0 flex-1 rounded-md border ab-transition ${
            selected
              ? 'border-accent bg-accent-soft'
              : 'border-hairline hover:bg-surface-raised'
          }`}
        >
          <button
            type="button"
            data-testid={`workspace-card-${workspace.id}`}
            aria-pressed={selected}
            onClick={() => selectWorkspace(workspace.id)}
            className="block w-full rounded-md px-3 pb-2 pt-3 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {/* 名称行：pr-10 只为 28px 触发器让位；名称 flex-1 + min-w-0 + truncate 优先占满，
                置顶徽标 shrink-0 排其后 → 相似名称先拿宽度，不会被控件挤成同一段省略号 */}
            <div className="flex min-w-0 items-center gap-1 pr-10">
              <div
                data-testid={`workspace-card-name-${workspace.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={workspace.name}
              >
                {workspace.name}
              </div>
              {dbBadge !== null && (
                <span
                  data-testid={`workspace-db-badge-${workspace.id}`}
                  aria-label={`${workspace.name} 的库状态：${dbBadge.label}`}
                  className="shrink-0 rounded bg-surface-raised px-1 text-[10px] font-medium text-ink-2"
                  title={dbBadge.title}
                >
                  {dbBadge.label}
                </span>
              )}
              {pinned && onTogglePin !== undefined && (
                <span
                  data-testid={`workspace-pinned-badge-${workspace.id}`}
                  aria-label={`已置顶 ${workspace.name}`}
                  className="shrink-0 rounded bg-accent-soft px-1 text-[10px] font-medium text-accent"
                  title="已置顶"
                >
                  置顶
                </span>
              )}
            </div>
            {/* 路径：整行 truncate，title 给全文，长路径不撑破卡片 */}
            <div
              data-testid={`workspace-card-path-${workspace.id}`}
              className="min-w-0 truncate text-xs text-ink-3"
              title={workspace.path}
            >
              {workspace.path}
            </div>
            <div className={`mt-2 grid ${statColumnClass} gap-1 text-center text-[11px]`}>
              {statCells.map((cell) => (
                <div
                  key={cell.key}
                  data-testid={`stat-${cell.key}`}
                  className="rounded bg-surface-raised py-1"
                >
                  <div className="font-semibold">{cell.count}</div>
                  <div className="whitespace-nowrap text-ink-3">{cell.label}</div>
                </div>
              ))}
            </div>
          </button>

          <div
            data-testid={`workspace-card-actions-${workspace.id}`}
            className="absolute right-1 top-1 flex items-center"
          >
            <button
              type="button"
              ref={triggerRef}
              data-testid={`workspace-card-menu-${workspace.id}`}
              aria-label={`工作区操作 ${workspace.name}`}
              title="工作区操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={toggleMenu}
              // I-11：kebab 触发器命中区 28×28
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-xs text-ink-3 ab-transition hover:bg-accent-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              ⋮
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                aria-label={`${workspace.name} 的操作`}
                data-testid={`workspace-card-menu-panel-${workspace.id}`}
                onKeyDown={onMenuKeyDown}
                className={`${MENU_PANEL_CLASS} ${menuAbove ? 'bottom-9' : 'top-9'}`}
              >
                {onTogglePin !== undefined && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    data-testid={`workspace-pin-${workspace.id}`}
                    aria-checked={pinned}
                    aria-label={`${pinned ? '取消置顶' : '置顶'} ${workspace.name}`}
                    onClick={() => runItem(onTogglePin)}
                    className={`${MENU_ITEM_CLASS} ${pinned ? 'text-accent' : ''}`}
                  >
                    {pinned ? '取消置顶' : '置顶'}
                  </button>
                )}
                {onMoveUp !== undefined && onMoveDown !== undefined && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`workspace-move-up-${workspace.id}`}
                      aria-label={`上移 ${workspace.name}`}
                      title={canMoveUp ? '上移' : '已在最前'}
                      disabled={!canMoveUp}
                      onClick={() => runItem(onMoveUp)}
                      className={MENU_ITEM_CLASS}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`workspace-move-down-${workspace.id}`}
                      aria-label={`下移 ${workspace.name}`}
                      title={canMoveDown ? '下移' : '已在最后'}
                      disabled={!canMoveDown}
                      onClick={() => runItem(onMoveDown)}
                      className={MENU_ITEM_CLASS}
                    >
                      下移
                    </button>
                  </>
                )}
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`workspace-remove-${workspace.id}`}
                  aria-label={`移除工作空间 ${workspace.name}`}
                  // 破坏性项沿用 BUTTON_DANGER 的文案色（token 口径，不写死色值）
                  className={`${MENU_ITEM_CLASS} text-red-600 dark:text-red-400`}
                  onClick={() => runItem(() => setRemoveOpen(true))}
                >
                  移除工作空间
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <RemoveWorkspaceDialog
        workspace={workspace}
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
      />
    </div>
  );
}

