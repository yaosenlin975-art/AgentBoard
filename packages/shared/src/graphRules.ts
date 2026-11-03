/**
 * 星图关键词共现规则（GRAPH-EDGE-BUG / GRAPH-KEYWORD-ALIGN 的**唯一来源**）。
 *
 * 服务端 `apps/server/src/services/knowledgeGraph.ts` 里的同名常量必须与本文件保持一致
 * （该文件顶部有指向本文件的注释）；前端 `apps/web/src/lib/knowledgeGraph.ts` 直接 import 本文件，
 * 避免两套阈值再次漂移。
 */
export const GRAPH_KEYWORD_RULES = {
  /** 成边所需的最少共享「稀有」实体词数 */
  minTerms: 4,
  /** 成边所需的最少共享「稀有」trigram 数 */
  minTrigrams: 6,
  /** 通用词判定：df > max(2, ceil(页数 × ratio)) 的词/trigram 不参与成边 */
  dfRatio: 0.4,
  /** 相对重叠率：共享稀有词 / 较小文档稀有词数 */
  termRatio: 0.3,
  /** 相对重叠率：共享稀有 trigram / 较小文档稀有 trigram 数 */
  trigramRatio: 0.35,
} as const;

export type GraphKeywordRules = typeof GRAPH_KEYWORD_RULES;
