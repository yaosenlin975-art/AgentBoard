/**
 * 标签规范化（TAG-HYGIENE / TAG-CLEANUP-EXEC）——与服务端 CLI 侧同一套规则：
 * CLI 实现见 `packages/cli/src/commands/createIssue.ts:parseLabels`（`[,，\s]+` 拆分、trim、丢空、去重）。
 *
 * 服务端在请求边界（zod schema transform）统一走这里，保证 `PATCH /api/issues` 直接传带空格的标签
 * 也会被拆成多个，不再有「非 CLI 写入路径落进带空格标签」的缺口。
 * 标签本身不含空格是硬约定：想表达短语请拆成领域词。
 */
export function normalizeLabels(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const part of item.split(/[,，\s]+/u)) {
      const label = part.trim();
      if (label === '' || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}
