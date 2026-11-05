import type { MessageDiffFile, MessageToolMeta } from '@agentboard/shared';

/**
 * CHAT-TURN1（契约 #8）：`message.meta_json` 的服务端口径工具。
 *
 * 本卡不改执行器，所以只填「服务端可观测」的部分：
 * - `duration_ms`：该步从 tool 事件到下一步/轮次收尾的墙钟时间（不是 CLI 上报的工具耗时）；
 * - `status`：`ok` = 期间没出现 error 事件、轮次也没以非零退出收尾；否则 `failed`；
 * - `output_summary` / `diff`：需要 CLI 的工具结果与 git 出口，本卡留 null，由后续卡填真值；
 * - `tool_call_id`：适配器不提供调用 id，这里用轮次内稳定的 `step_id` 充当关联键
 *   （`diff` 与后续 step ledger 按同一键对齐；将来适配器给出真实 id 时替换）。
 */

/** 契约 #8：单文件 patch 行数上限（超出截断，完整内容走 git 出口） */
export const META_PATCH_MAX_LINES = 400;

/** meta_json 里单条摘要的字符上限：一条 tool 观测不应撑大消息列表载荷 */
export const META_SUMMARY_MAX_CHARS = 200;

/** 按行截断 unified diff：保留前 `maxLines` 行，`truncated` 让前端知道还有下文（不伪造尾部内容） */
export function truncatePatchForFile(patch: string, maxLines = META_PATCH_MAX_LINES): { patch: string; truncated: boolean } {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) return { patch, truncated: false };
  return { patch: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/** 文件级 diff 归一：逐文件截断 patch，add/del 计数原样保留 */
export function normalizeDiffFiles(files: MessageDiffFile[], maxLines = META_PATCH_MAX_LINES): MessageDiffFile[] {
  return files.map((file) => {
    if (file.patch === null) return { ...file, truncated: false };
    const cut = truncatePatchForFile(file.patch, maxLines);
    return { ...file, patch: cut.patch, truncated: cut.truncated };
  });
}

/**
 * 无 CLI usage 来源时的估算口径（契约 #21，恒 `estimated=true`）：约 4 字符 = 1 token。
 * 只用于让成本/上下文脚注有随流式增长的形状，**不是**计费依据；适配器给出真实 token 后即被替换。
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(Array.from(text).length);
}

/** 流式增量只带长度时用这一条（与 estimateTokens 同一口径） */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 本卡写工具消息时的初始观测（耗时与成败在步骤收口时回填） */
export function initialToolMeta(stepId: string): MessageToolMeta {
  return { status: 'ok', duration_ms: null, output_summary: null, tool_call_id: stepId, diff: null };
}
