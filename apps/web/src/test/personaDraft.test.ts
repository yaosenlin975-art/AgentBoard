/**
 * PERSONA-LIB-2：`lib/personaDraft.ts` 的请求与错误码映射。
 * 重点：结构化字段回落空串、错误码中文化（不写「已回退」）、取消抛 DraftAbortError。
 */
import { describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import {
  PersonaDraftError,
  mapPersonaDraftError,
  requestPersonaDraft,
} from '../lib/personaDraft';
import { DraftAbortError } from '../lib/smartDraft';
import { server } from './server';

describe('personaDraft', () => {
  it('requestPersonaDraft 归一化缺省段落为空串', async () => {
    server.use(
      http.post('/api/personas/draft', () =>
        HttpResponse.json({
          name: '技术文档编辑',
          description: '把笔记改成说明',
          role: '你是技术文档编辑。',
          tone: null,
          boundary: null,
          domain: null,
          warnings: ['语气缺失', 42],
        }),
      ),
    );
    const draft = await requestPersonaDraft({ requirement: '技术文档编辑', adapter: 'codex' });
    expect(draft).toEqual({
      name: '技术文档编辑',
      description: '把笔记改成说明',
      role: '你是技术文档编辑。',
      tone: '',
      boundary: '',
      domain: '',
      warnings: ['语气缺失'],
    });
  });

  it('服务端错误码映射成可读中文', async () => {
    server.use(
      http.post('/api/personas/draft', () =>
        HttpResponse.json(
          { error: { code: 'PERSONA_DRAFT_FAILED', message: 'CLI 退出码 1' } },
          { status: 502 },
        ),
      ),
    );
    const error = await requestPersonaDraft({ requirement: 'x', adapter: 'codex' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PersonaDraftError);
    expect(mapPersonaDraftError(error, 'codex')).toContain('生成失败');
    expect(mapPersonaDraftError(error, 'codex')).toContain('可重试或直接手动填写');
  });

  it('取消时抛 DraftAbortError，映射为「已取消生成」', () => {
    expect(mapPersonaDraftError(new DraftAbortError(), 'dsh')).toBe('已取消生成');
  });

  it('422 / 504 / 503 的文案区分原因', () => {
    const mk = (code: string, status: number): PersonaDraftError => new PersonaDraftError('detail', code, status);
    expect(mapPersonaDraftError(mk('PERSONA_DRAFT_INVALID', 422), 'codex')).toContain('格式不合法');
    expect(mapPersonaDraftError(mk('DRAFT_TIMEOUT', 504), 'codex')).toContain('生成超时');
    expect(mapPersonaDraftError(mk('ADAPTER_UNAVAILABLE', 503), 'codex')).toContain('当前不可用');
  });
});
