import { describe, expect, it } from 'vitest';
import {
  buildSessionPreview,
  classifySessionError,
  detectEncodingLost,
  looksLikeErrorOutput,
  SESSION_PREVIEW_MAX,
} from '../src/services/messageSignals.js';

describe('messageSignals（AUDIT-SRV F-03/F-04/F-06）', () => {
  it('预览：压空白、折叠 markdown 图片、截断 ≤80 且带省略号', () => {
    expect(buildSessionPreview('  第一行\n\n第二行  ')).toBe('第一行 第二行');
    expect(buildSessionPreview('![截图](/api/attachments/a1.png) 看图')).toBe('[图片] 看图');
    const long = 'x'.repeat(SESSION_PREVIEW_MAX + 5);
    const preview = buildSessionPreview(long);
    expect(preview.length).toBeLessThanOrEqual(SESSION_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
    expect(buildSessionPreview('')).toBe('');
  });

  it('错误归类：额度优先于裸 429，鉴权/上下文不可重试，限流与未知可重试', () => {
    expect(classifySessionError('额度已用尽 429 Too Many Requests')).toEqual({ code: 'QUOTA_EXCEEDED', retryable: false });
    expect(classifySessionError('HTTP 401 invalid api key')).toEqual({ code: 'AUTH_FAILED', retryable: false });
    expect(classifySessionError('context length exceeded')).toEqual({ code: 'CONTEXT_OVERFLOW', retryable: false });
    expect(classifySessionError('429 rate limit')).toEqual({ code: 'RATE_LIMITED', retryable: true });
    expect(classifySessionError('Error: something broke')).toEqual({ code: 'UNKNOWN_ERROR', retryable: true });
    expect(classifySessionError('讲解一下 429 是什么')).toBeNull();
    expect(classifySessionError('')).toBeNull();
  });

  it('正文当错误：仅短、少行、且以错误码/Error 开头或命中额度/限流特征', () => {
    expect(looksLikeErrorOutput('429 Too Many Requests')).toBe(true);
    expect(looksLikeErrorOutput('余额不足，请充值')).toBe(true);
    // 正常回答里提到 429 但篇幅长 → 不当错误
    expect(looksLikeErrorOutput('讲解 429 是什么\n'.concat('正文'.repeat(300)))).toBe(false);
    // 多行长文 → 不当错误
    expect(looksLikeErrorOutput('429\n1\n2\n3\n4')).toBe(false);
    // 短但无错误特征 → 不当错误
    expect(looksLikeErrorOutput('好的，我来解释一下')).toBe(false);
  });

  it('编码丢失：U+FFFD 或连续三个以上问号', () => {
    expect(detectEncodingLost('正常文本')).toBe(false);
    expect(detectEncodingLost('?? 两个问号')).toBe(false);
    expect(detectEncodingLost('??? OK ????,??????')).toBe(true);
    expect(detectEncodingLost('乱码 \uFFFD 标记')).toBe(true);
  });
});
