/**
 * M1：收口 45f972c9 的两处遗留。
 *
 * 遗留 1 —— 写入侧接受占位 hash：`content_hash` 的职责是「证明源文件就是这个 hash」，
 *   `0`×64 通过格式校验等于签了假承诺，reconcile 的源漂移检测对该条永久失效。
 *   判据用「唯一字符数 < 8」而非「必须含字母」：真实 sha256 理论上可能就是全数字。
 *
 * 遗留 2 —— revise 在坏页上的行为从未实测。fileRepo 有三处 assertNotExternallyEdited
 *   （revise / action / rename），这里验证 revise 的 409 与正常路径未被破坏。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeRestFixture } from './helpers.js';
import { validateKnowledgeContent } from '../src/services/knowledge.js';

const REAL_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ALL_ZEROS = '0'.repeat(64);
const FOUR_CHARS = '1234'.repeat(16);
const ALL_SIXTEEN = '0123456789abcdef'.repeat(4);
const ALL_DIGITS_LOW_ENTROPY = '0123456789012345'.repeat(4);

describe('M1-1 写入侧拒绝占位 content_hash（熵下限）', () => {
  const source = (content_hash: string) => ({
    source_id: 's', source_type: 'agent' as const, locator: 'issue:1',
    captured_at: 1, content_hash, snapshot: 'ok',
  });
  const base = { title: 'T', body_md: 'B', actor: 'tester', expires_at: null };

  const attempt = (content_hash: string) => () => validateKnowledgeContent({
    ...base, sources: [source(content_hash)], evidence: [{ source_id: 's', locator: 'issue:1' }],
  });

  it('0 × 64 被拒绝，文案给出唯一字符数与修法', () => {
    expect(attempt(ALL_ZEROS)).toThrow(/占位值/);
    expect(attempt(ALL_ZEROS)).toThrow(/唯一字符数 1 < 8/);
    expect(attempt(ALL_ZEROS)).toThrow(/填真实文件 sha256/);
  });

  it('1234 × 16（4 种唯一字符）被拒绝', () => {
    expect(attempt(FOUR_CHARS)).toThrow(/占位值/);
    expect(attempt(FOUR_CHARS)).toThrow(/唯一字符数 4 < 8/);
  });

  it('全部 16 进制字符各出现 4 次（15 种唯一字符）通过', () => {
    expect(attempt(ALL_SIXTEEN)).not.toThrow();
  });

  it('真实 sha256 通过', () => {
    expect(attempt(REAL_SHA256)).not.toThrow();
  });

  it('格式不符（长度/非 hex）仍按格式拒绝，错误信息走原有路径', () => {
    expect(attempt('abc')).toThrow(/content_hash/);
    expect(attempt('z'.repeat(64))).toThrow(/content_hash/);
  });

  it('边界：唯一字符数 7 拒绝、8 通过', () => {
    // 7 种：0-6 循环，凑满 64 位
    const seven = '0123456'.repeat(10).slice(0, 64);
    expect(new Set(seven).size).toBe(7);
    expect(attempt(seven)).toThrow(/唯一字符数 7 < 8/);
    // 8 种：0-7 循环
    const eight = '01234567'.repeat(8);
    expect(new Set(eight).size).toBe(8);
    expect(attempt(eight)).not.toThrow();
  });

  it('大小写混写不影响熵判定（02AB 循环仍被拒）', () => {
    const mixed = '02Ab'.repeat(16);
    expect(attempt(mixed)).toThrow(/占位值/);
  });

  it('多数字符全 0 但字符集够宽时不误报', () => {
    const sparse = `${'0'.repeat(56)}12345678`; // 64 位，9 种唯一字符
    expect(new Set(sparse).size).toBe(9);
    expect(attempt(sparse)).not.toThrow();
  });
});

describe('M1-2 revise 在坏页上必须 409，正常路径不受影响', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>;
  let a: string;
  let id: string;

  beforeEach(async () => {
    f = createKnowledgeRestFixture();
    a = f.a;
    const created = await request(f.app).post('/api/knowledge/pages').send({
      domain: 'knowledge', scope: 'workspace', workspace_id: a, slug: 'm1-page', title: 'M1 页',
      body_md: '原始正文', actor: 'tester',
      sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: REAL_SHA256, snapshot: 'ok' }],
      evidence: [{ source_id: 's', locator: 'issue:1' }],
    });
    expect(created.status).toBe(200);
    id = created.body.id as string;
  });
  afterEach(() => f.cleanup());

  it('手工改正文不动 hash → revise 返回 409 FILE_CONFLICT，不静默覆盖', async () => {
    const path = join(f.docsOf(a), 'm1-page.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('原始正文', '外部篡改的正文'), 'utf8');

    const res = await request(f.app).put(`/api/knowledge/pages/${id}`).send({
      scope: 'workspace', workspace_id: a, expected_revision: 1, body_md: '本想写入的新正文', actor: 'tester',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_FILE_CONFLICT');
    expect(res.body.error.message).toContain('外部修改');
    // 外部内容未被覆盖
    expect(readFileSync(path, 'utf8')).toContain('外部篡改的正文');
    expect(readFileSync(path, 'utf8')).not.toContain('本想写入的新正文');
  });

  it('正常页 revise → 成功，revision 递增', async () => {
    const res = await request(f.app).put(`/api/knowledge/pages/${id}`).send({
      scope: 'workspace', workspace_id: a, expected_revision: 1, body_md: '新正文', actor: 'tester',
    });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(2);
    expect(readFileSync(join(f.docsOf(a), 'm1-page.md'), 'utf8')).toContain('新正文');
  });

  it('坏页 archive 也 409（同一处 assertNotExternallyEdited）', async () => {
    const path = join(f.docsOf(a), 'm1-page.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('原始正文', '外部篡改'), 'utf8');
    const res = await request(f.app).post(`/api/knowledge/pages/${id}/actions`).send({
      scope: 'workspace', workspace_id: a, expected_revision: 1, action: 'archive', actor: 'tester',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_FILE_CONFLICT');
  });
});
