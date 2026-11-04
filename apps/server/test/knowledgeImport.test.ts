/**
 * KBIMP-1：知识页文本导入（md / txt / json）。
 * 覆盖：三种格式的标题/正文/slug/来源构造、json 单对象与数组、限额、slug 冲突 409 + 建议。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { IMPORT_MAX_BODY_CHARS, IMPORT_MAX_BYTES, assertContentLimits, mdTitle, slugifyTitle, txtTitle } from '../src/services/knowledgeImport.js';

describe('knowledge import (KBIMP-1)', () => {
  let t: TestDb;
  let app: Express;
  let ws: string;

  const post = (body: Record<string, unknown>) => request(app).post('/api/knowledge/pages/import').send(body);

  beforeEach(async () => {
    t = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    ws = createWorkspace(t.db, { name: '导入空间', path: mkdtempSync(join(tmpdir(), 'agentboard-kbimp-')) }).id;
  });

  afterEach(() => { /* TestDb 内部按需清理 */ });

  it('md：标题取首个 # 一级标题，正文原样，来源/证据自动构造且不带 snapshot', async () => {
    const content = '# 缓存策略\n\n正文第一段。\n';
    const res = await post({ scope: 'workspace', workspace_id: ws, format: 'md', content, filename: 'cache.md' });
    expect(res.status).toBe(200);
    const page = res.body.pages[0];
    expect(page.title).toBe('缓存策略');
    expect(page.body_md).toBe(content);
    expect(page.slug).toBe('缓存策略');
    expect(page.category).toBe('legacy');
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]).toMatchObject({ source_type: 'file', locator: 'cache.md' });
    expect(page.sources[0].snapshot).toBeUndefined();
    expect(page.evidence[0]).toMatchObject({ locator: 'cache.md' });
    expect(page.evidence[0].snapshot).toBeUndefined();
    expect(res.body.warnings).toEqual([]);
  });

  it('txt：标题取首行（≤80 字符）或文件名，正文原样', async () => {
    const res = await post({ scope: 'workspace', workspace_id: ws, format: 'txt', content: '第一行就是标题\n正文\n' });
    expect(res.status).toBe(200);
    expect(res.body.pages[0].title).toBe('第一行就是标题');
    expect(res.body.pages[0].body_md).toBe('第一行就是标题\n正文\n');

    const byFile = await post({ scope: 'workspace', workspace_id: ws, format: 'txt', content: '没有标题的行\n', filename: 'notes.txt' });
    expect(byFile.body.pages[0].title).toBe('没有标题的行');
  });

  it('json 单对象：body 映射成正文并带上 category/landed', async () => {
    const res = await post({
      scope: 'workspace', workspace_id: ws, format: 'json',
      content: JSON.stringify({ title: 'JSON 导入页', body: '正文 **加粗**', category: 'design', landed: 'proposed' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.pages[0]).toMatchObject({ title: 'JSON 导入页', body_md: '正文 **加粗**', category: 'design', landed: 'proposed' });
  });

  it('json 数组：逐条建页，不支持的字段进 warnings', async () => {
    const res = await post({
      scope: 'workspace', workspace_id: ws, format: 'json',
      content: JSON.stringify([
        { title: 'A 页', body_md: 'A 正文', extra_field: 1 },
        { title: 'B 页', body: 'B 正文' },
      ]),
    });
    expect(res.status).toBe(200);
    expect(res.body.pages.map((p: { title: string }) => p.title)).toEqual(['A 页', 'B 页']);
    expect(res.body.warnings.join(' ')).toContain('extra_field');
  });

  it('json 形状非法（数组里是字符串）→ 400，不把整段 JSON 塞正文', async () => {
    const res = await post({ scope: 'workspace', workspace_id: ws, format: 'json', content: JSON.stringify(['纯字符串']) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('不是对象');
  });

  it('正文超过 10 万字符 → 413 IMPORT_BODY_TOO_LONG', async () => {
    const tooLong = await post({ scope: 'workspace', workspace_id: ws, format: 'txt', content: 'x'.repeat(IMPORT_MAX_BODY_CHARS + 1) });
    expect(tooLong.status).toBe(413);
    expect(tooLong.body.error.code).toBe('IMPORT_BODY_TOO_LONG');
  });

  it('请求体超过全局 JSON 上限 → 413（当前由 express.json 的默认 100kb 先拒，见文档「已知限制」）', async () => {
    const big = 'a'.repeat(IMPORT_MAX_BYTES + 1);
    const tooLarge = await post({ scope: 'workspace', workspace_id: ws, format: 'txt', content: big });
    expect(tooLarge.status).toBe(413);
    // 全局 body-parser 先于路由拒绝，错误码来自既有映射（ATTACHMENT_TOO_LARGE），非本接口自定义
    expect(['IMPORT_TOO_LARGE', 'ATTACHMENT_TOO_LARGE']).toContain(tooLarge.body.error.code);
  });

  it('服务层限额：>1MB 与空内容在进入 adapter 前就被拒（assertContentLimits）', () => {
    expect(() => assertContentLimits('a'.repeat(IMPORT_MAX_BYTES + 1))).toThrowError(/IMPORT_TOO_LARGE|超过单次上限/);
    expect(() => assertContentLimits('   ')).toThrowError();
  });

  it('slug 冲突 → 409 且给建议 slug', async () => {
    const first = await post({ scope: 'workspace', workspace_id: ws, format: 'md', content: '# 重复标题\n第一版\n' });
    expect(first.status).toBe(200);
    const duplicate = await post({ scope: 'workspace', workspace_id: ws, format: 'md', content: '# 重复标题\n第二版\n' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('KNOWLEDGE_EXISTS');
    expect(duplicate.body.error.message).toContain('重复标题-2');
  });

  it('scope=workspace 缺 workspace_id → 400；common 不需要 workspace_id', async () => {
    const missing = await post({ scope: 'workspace', format: 'txt', content: 'x' });
    expect(missing.status).toBe(400);
    const common = await post({ scope: 'common', format: 'txt', content: '公共页正文' });
    expect(common.status).toBe(200);
    expect(common.body.pages[0].scope).toBe('common');
    expect(common.body.pages[0].workspace_id).toBeNull();
  });

  it('纯函数：slugifyTitle / mdTitle / txtTitle 的边界', () => {
    expect(slugifyTitle('缓存 策略/v2')).toBe('缓存-策略/v2');
    expect(slugifyTitle('   ')).toMatch(/^import-[0-9a-f]{8}$/);
    expect(mdTitle('# 标题\n正文')).toBe('标题');
    expect(mdTitle('前言\n# 后面的标题\\n')).toBeNull();
    expect(mdTitle('没有标题\n正文')).toBeNull();
    expect(txtTitle('\n\n首行\n第二行')).toBe('首行');
    expect(txtTitle('a'.repeat(200))?.length).toBe(80);
  });
});
