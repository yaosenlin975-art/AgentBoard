/**
 * 按钮与表单控件的统一样式（KB-STYLE01）：主 / 次 / 危险三级 + 统一高度与间距。
 * 只收敛样式，不改任何行为；供知识库等页面复用，避免裸按钮。
 */
const BASE =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40';

/** 主操作（搜索、保存有效期） */
export const BUTTON_PRIMARY = `${BASE} border-transparent bg-blue-600 text-white hover:bg-blue-700`;

/** 次操作（分页、版本历史、归档、恢复） */
export const BUTTON_SECONDARY =
  `${BASE} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 ` +
  'dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800';

/** 破坏性操作（软删除） */
export const BUTTON_DANGER =
  `${BASE} border-red-300 bg-white text-red-600 hover:bg-red-50 ` +
  'dark:border-red-800 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950/40';

/** 输入框 / 下拉：与按钮同高，暗色下显式继承文本色 */
export const FIELD_CLASS =
  'h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none ' +
  'placeholder:text-neutral-400 focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900 ' +
  'dark:text-neutral-100 dark:placeholder:text-neutral-500';
