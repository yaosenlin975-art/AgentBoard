/**
 * 看板拖拽光标（CURSOR-WHITE）。
 *
 * 背景：CSS 的 `cursor: grab / grabbing` 在 Windows 上由 Chromium 合成一张**纯白手掌位图**，没有描边，
 * 遇到白色页面背景就完全看不见（用户当场截图就是这个）。仓库里没有任何自定义 `url(...)` 光标，
 * 所以问题不是「自定义 SVG 只有白填充」，而是原生 grab 位图本身在浅底不可见。
 *
 * 做法：给看板卡片与拖拽浮层换上**双色自定义光标**——白色填充 + 深色描边（#111），
 * 因此浅色背景靠描边、深色背景靠填充都看得见，一套资源覆盖两种主题，不需要为 dark 再维护一份。
 * 末尾保留 `, grab` / `, grabbing` 作为兜底（浏览器不支持 SVG 光标时仍退化到原行为）。
 */

const HAND_FILL = '%23ffffff';
const HAND_STROKE = '%23111111';

/** 手指 + 手掌轮廓（24×24，热点 8,4）：白色填充 + 深色描边 */
function handPath(open: boolean): string {
  const fingerHeight = open ? 9 : 6;
  const fingerY = open ? [2.5, 1.5, 3, 5.5] : [5.5, 4.5, 6, 8];
  return [
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>`,
    `<g fill='${HAND_FILL}' stroke='${HAND_STROKE}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>`,
    `<rect x='8' y='${fingerY[0]}' width='3' height='${fingerHeight}' rx='1.5'/>`,
    `<rect x='11.5' y='${fingerY[1]}' width='3' height='${fingerHeight + 1}' rx='1.5'/>`,
    `<rect x='15' y='${fingerY[2]}' width='3' height='${fingerHeight}' rx='1.5'/>`,
    `<rect x='4.5' y='${fingerY[3]}' width='3' height='${fingerHeight - 2}' rx='1.5'/>`,
    `<path d='M4.5 11.5h13.5v4.2a5.3 5.3 0 0 1-5.3 5.3h-2.9a5.3 5.3 0 0 1-5.3-5.3z'/>`,
    `</g></svg>`,
  ].join('');
}

function asCursor(open: boolean, fallback: string): string {
  return `url("data:image/svg+xml,${handPath(open)}") 8 4, ${fallback}`;
}

/** 可拖拽（悬停卡片） */
export const GRAB_CURSOR = asCursor(true, 'grab');
/** 拖拽中（浮层跟随指针） */
export const GRABBING_CURSOR = asCursor(false, 'grabbing');
