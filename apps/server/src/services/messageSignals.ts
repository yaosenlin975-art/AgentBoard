/**
 * AUDIT-SRV（F-03 / F-04 / F-06）：会话消息的三类内容信号，纯函数、可单测。
 *
 * - `buildSessionPreview`：会话列表首条用户消息预览（F-03）。
 * - `classifySessionError` / `looksLikeErrorOutput`：把 CLI 打印出来的额度/限流/鉴权失败归成 error 事件（F-04）。
 * - `detectEncodingLost`：识别「原始编码不可用」（F-06）。实测损坏在**写入前**就发生（CLI stdout 编码丢失后
 *   存进库的已是 `0x3F`，不是 U+FFFD），因此这里只做标记，不做清洗——清洗修不回原文。
 */
import type { SessionErrorCode } from '@agentboard/shared';

/** 首条预览上限（含省略号，即输出长度 ≤ 该值） */
export const SESSION_PREVIEW_MAX = 80;

/** markdown 图片：预览里折叠成 `[图片]`，避免列表出现一长串 /api/... 路径 */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

export function buildSessionPreview(content: string, max = SESSION_PREVIEW_MAX): string {
  const flattened = content.replace(MARKDOWN_IMAGE, '[图片]').replace(/\s+/g, ' ').trim();
  if (flattened === '') return '';
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max - 1)}…`;
}

export interface SessionErrorSignal { code: SessionErrorCode; retryable: boolean }

const QUOTA = /(额度已用尽|额度不足|额度已用完|余额不足|quota\s*(?:exceeded|exhausted)|insufficient\s*quota)/i;
const AUTH = /(unauthori[sz]ed|invalid\s*api\s*key|api\s*key\s*invalid|鉴权失败|未授权|认证失败)/i;
const CONTEXT = /(context\s*(?:length|window)|too\s*many\s*tokens|maximum\s*context|上下文(?:超长|过长))/i;
// 裸 429 不单独算限流特征：否则短回答里「讲解 429 是什么」会被误判成错误；
// 真正的 429 失败输出通常以 429 / Error 开头（HTTP_ERROR_LEAD）或带下方特征词。
const RATE = /(rate\s*limit|too\s*many\s*requests|限流|请求过于频繁)/i;
const HTTP_ERROR_LEAD = /^(?:429|401|403|5\d\d|Error|ERROR|error)[\s:：]/;

/** 归类：强特征词优先于裸 429（额度失败文案里通常也带 429） */
export function classifySessionError(text: string): SessionErrorSignal | null {
  const body = text.trim();
  if (body === '') return null;
  if (QUOTA.test(body)) return { code: 'QUOTA_EXCEEDED', retryable: false };
  if (AUTH.test(body)) return { code: 'AUTH_FAILED', retryable: false };
  if (CONTEXT.test(body)) return { code: 'CONTEXT_OVERFLOW', retryable: false };
  if (RATE.test(body)) return { code: 'RATE_LIMITED', retryable: true };
  if (HTTP_ERROR_LEAD.test(body)) return { code: 'UNKNOWN_ERROR', retryable: true };
  return null;
}

/**
 * 正文能否当错误处理（F-04 的关键取舍）：CLI 把额度失败当普通 stdout 打印，服务端只能从文本判定，
 * 门槛必须够严，否则「讲解 429 是什么」的正常回答会被误判成错误：
 * 短（≤400 字）、行数少（≤3 行）、且以 HTTP 错误码/Error 开头或命中额度/限流特征词。
 */
export function looksLikeErrorOutput(text: string): boolean {
  const body = text.trim();
  if (body === '' || body.length > 400) return false;
  if (body.split('\n').length > 3) return false;
  if (!HTTP_ERROR_LEAD.test(body) && !QUOTA.test(body) && !RATE.test(body)) return false;
  return classifySessionError(body) !== null;
}

/** U+FFFD：明确的解码失败标记 */
const REPLACEMENT_CHAR = '\uFFFD';
/** 连续三个及以上半角问号：编码丢失后按 0x3F 落库的典型形态（实测 `??? OK ????,??????`） */
const LOSSY_QUESTION_RUN = /\?{3,}/;

export function detectEncodingLost(content: string): boolean {
  if (content.includes(REPLACEMENT_CHAR)) return true;
  return LOSSY_QUESTION_RUN.test(content);
}
