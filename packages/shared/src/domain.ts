/**
 * KB-CR-1（P5）：知识页域词表的**唯一来源**。
 *
 * 设计约束：
 * - 词表只在这里定义；`apps/server`（migrations / repos）、`packages/cli` 一律从这里 import，
 *   禁止任何形式的手抄（含 `['accounts', …]` 字面量与重复的 union 类型）。
 * - 扩展词表只改本文件；DB 侧不加 CHECK（校验在服务层），避免改词表就要重建表。
 * - `null` 表示「未归类」，是合法状态；**创建时不允许**缺 domain（见 repos/knowledge.ts 的强制校验）。
 */

/** 域词表（封闭集合，顺序即文档展示顺序） */
export const KNOWLEDGE_DOMAINS = ['accounts', 'knowledge', 'board', 'chat', 'ui', 'infra'] as const;

export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

/** 面向人的词表提示（错误文案与 CLI 帮助共用，避免两处措辞漂移） */
export const KNOWLEDGE_DOMAIN_HINT = KNOWLEDGE_DOMAINS.join(' / ');

export function isKnowledgeDomain(value: unknown): value is KnowledgeDomain {
  return typeof value === 'string' && (KNOWLEDGE_DOMAINS as readonly string[]).includes(value);
}
