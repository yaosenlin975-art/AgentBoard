/**
 * 安全批量追加（OCR B3）。
 *
 * `target.push(...source)` 会把 source 的元素作为实参逐个压栈，
 * 长度超 ~125k 时抛 `RangeError: Maximum call stack size exceeded`。
 * 已知会在真实规模触发的路径：
 * - 知识图聚合（边数 = 页数 × 出链数，GRAPH_MAX_PAGES=5000 × 每页 ≥26 即越阈值）
 * - `walkDir` / `walkFiles` 递归遍历出的整个目录树（12 万文件即越阈值）
 * - SQL 参数展开（用户提供的 id 列表无上限）
 *
 * 逐项追加语义完全等价，且无长度上限。
 */
export function pushAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}
