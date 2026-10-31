/**
 * Task 8 实现完整 sessionManager（轮次编排/队列/并发/停止/重启恢复）；
 * 本文件当前仅钉注入接口，供 comments 服务与测试解耦。
 *
 * 语义（Pinned Contracts · 会话轮次规则）：
 * - 目标会话空闲：直接起轮，返回 { queued: false }
 * - 目标会话运行中：文本入内存队列，返回 { queued: true }
 */
export type SessionSender = (sessionId: string, text: string) => Promise<{ queued: boolean }>;
