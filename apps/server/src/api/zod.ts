/**
 * KB-CR-2：zod issue → 中文文案（P4）。此前 routes.ts 与 knowledgeRoutes.ts 各一份，两份完全一致；
 * 对外文案逐字节不变，只收敛定义位置。
 */
export function zhZodIssue(rawIssue: unknown): string {
  const issue = (rawIssue ?? {}) as { code?: string; path?: Array<string | number>; message?: string; minimum?: unknown; maximum?: unknown; options?: unknown[]; expected?: unknown };
  const where = issue.path && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  const raw = (issue as { options?: unknown[]; values?: unknown[] });
  const list = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.values) ? raw.values : [];
  const options = list.map(String);
  switch (issue.code) {
    case 'invalid_value':
    case 'invalid_enum_value':
      return options.length > 0 ? `${where}取值必须是：${options.join(' / ')}` : `${where}${issue.message ?? '取值不合法'}`;
    case 'too_small':
      return `${where}不能小于 ${String(issue.minimum ?? '')}`.trim();
    case 'too_big':
      return `${where}不能大于 ${String(issue.maximum ?? '')}`.trim();
    case 'invalid_type':
      return `${where}类型不对（期望 ${String(issue.expected ?? '')}）`;
    case 'unrecognized_keys':
    case 'custom':
      return `${where}${issue.message ?? '参数不合法'}`;
    default:
      return `${where}${issue.message ?? '参数不合法'}`;
  }
}
