/**
 * 按钮与表单控件的统一样式（KB-STYLE01）：主 / 次 / 危险三级 + 统一高度与间距。
 * 只收敛样式，不改任何行为；供知识库等页面复用，避免裸按钮。
 *
 * BUTTON-PALETTE：全部走 unslop 令牌（`--ab-*` → `@theme inline` 的 `--color-*`），
 * 与 A2W 能力徽标、选中态 tab 同一套色板 —— 主按钮不再用旧的 Tailwind 蓝。
 * 焦点环也从旧蓝改到 `accent`，避免同一控件上出现两种强调色相。
 */
const BASE =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border px-3 text-xs font-medium ab-transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40';

/** 主操作（保存、确认、搜索）——唯一强调色 */
export const BUTTON_PRIMARY = `${BASE} border-transparent bg-accent text-accent-ink hover:opacity-90`;

/** 次操作（分页、版本历史、归档、恢复）——发丝线 + 卡片/抬起底色 + 正文墨色 */
export const BUTTON_SECONDARY = `${BASE} border-hairline bg-surface-card text-ink hover:bg-surface-raised`;

/** 破坏性操作（软删除）——保留语义红，不并入强调色 */
export const BUTTON_DANGER =
  `${BASE} border-hairline bg-surface-card text-red-600 hover:bg-surface-raised ` +
  'dark:text-red-400 dark:hover:bg-surface-raised';

/** 输入框 / 下拉：与按钮同高，焦点走 accent 令牌 */
export const FIELD_CLASS =
  'h-8 rounded-lg border border-hairline bg-surface-card px-2 text-sm text-ink outline-none ' +
  'placeholder:text-ink-3 focus:border-accent';
