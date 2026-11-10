/**
 * 共享浮层栈（SETTINGS-LAYOUT）：`Modal` 与 `DrawerPanel` 共用同一份栈，
 * 保证 Esc 只关最上层——设置抽屉打开人设面板时，Esc 先关人设面板而不连带关设置。
 *
 * 模块级数组按打开顺序入栈（先开的在下），出栈按 token 移除（允许乱序卸载）。
 * 纯内存结构，不进入 store，避免持久化/刷新副作用。
 */
const overlayStack: symbol[] = [];

export function pushOverlay(token: symbol): void {
  overlayStack.push(token);
}

export function removeOverlay(token: symbol): void {
  const index = overlayStack.indexOf(token);
  if (index !== -1) overlayStack.splice(index, 1);
}

/** 只有栈顶浮层响应 Esc；下层浮层保持打开 */
export function isTopOverlay(token: symbol): boolean {
  return overlayStack[overlayStack.length - 1] === token;
}
