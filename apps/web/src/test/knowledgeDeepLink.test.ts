/**
 * BORROW-3.2：深链解析纯函数（/k/:id/:slug 与 ?kb=<id>；id 权威、slug 忽略）。
 */
import { describe, expect, it } from 'vitest';
import { parseKnowledgeDeepLink } from '../lib/knowledgeDeepLink';

const ORIGIN = 'https://board.example.com';

describe('parseKnowledgeDeepLink（BORROW-3.2）', () => {
  it('/k/<id> 与 /k/<id>/<任意slug> 都解析出 id（slug 不符不报错）', () => {
    const id = '3d82b2bc-3ba1-4872-be41-1b47776bff46';
    expect(parseKnowledgeDeepLink(`${ORIGIN}/k/${id}`)?.pageId).toBe(id);
    expect(parseKnowledgeDeepLink(`${ORIGIN}/k/${id}/not-the-real-slug`)?.pageId).toBe(id);
    expect(parseKnowledgeDeepLink(`${ORIGIN}/k/${id}/`)?.pageId).toBe(id);
    // 短 id 前缀同样透传（交 resolve 解析）
    expect(parseKnowledgeDeepLink(`${ORIGIN}/k/3d82b2bc`)?.pageId).toBe('3d82b2bc');
  });

  it('?kb=<id> 解析出 id；空值不视为深链', () => {
    const id = '3d82b2bc-3ba1-4872-be41-1b47776bff46';
    expect(parseKnowledgeDeepLink(`${ORIGIN}/?kb=${id}`)?.pageId).toBe(id);
    expect(parseKnowledgeDeepLink(`${ORIGIN}/?kb=${id}&other=1`)?.pageId).toBe(id);
    expect(parseKnowledgeDeepLink(`${ORIGIN}/?kb=%20`)).toBeNull();
    expect(parseKnowledgeDeepLink(`${ORIGIN}/?kb=`)).toBeNull();
  });

  it('非深链路径与非法 URL 返回 null', () => {
    expect(parseKnowledgeDeepLink(`${ORIGIN}/`)).toBeNull();
    expect(parseKnowledgeDeepLink(`${ORIGIN}/board?x=1`)).toBeNull();
    expect(parseKnowledgeDeepLink('not a url')).toBeNull();
  });
});
