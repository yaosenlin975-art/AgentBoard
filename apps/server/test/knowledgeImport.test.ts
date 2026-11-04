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

  // KB-CR-1：导入即建页，domain 必填；这里统一给默认域，缺省/非法域由下方专门用例覆盖
  const post = (body: Record<string, unknown>) => request(app).post('/api/knowledge/pages/import').send({ domain: 'knowledge', ...body });

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
    expect(page.category).toBe('open');
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

  // ---- KBIMP-1B2：json 数组逐条 category/landed ----

  it('逐条 category/landed 生效（design/proposed + solved）', async () => {
    const content = JSON.stringify([
      { title: '设计页', body_md: '设计正文', category: 'design', landed: 'proposed' },
      { title: '解决页', body_md: '解决正文', category: 'solved' },
    ]);
    const res = await post({ scope: 'common', format: 'json', content });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.pages.map((p: { category: string; landed: string | null }) => ({ category: p.category, landed: p.landed })))
      .toEqual([{ category: 'design', landed: 'proposed' }, { category: 'solved', landed: null }]);
  });

  it('逐条优先于顶层：顶层 solved + 逐条 design/partial；逐条缺省才继承顶层', async () => {
    const content = JSON.stringify([
      { title: '逐条设计', body_md: '正文一', category: 'design', landed: 'partial' },
      { title: '继承顶层', body_md: '正文二' },
    ]);
    const res = await post({ scope: 'common', format: 'json', content, category: 'solved', landed: 'landed' });
    expect(res.status).toBe(200);
    expect(res.body.pages.map((p: { category: string; landed: string | null }) => ({ category: p.category, landed: p.landed })))
      .toEqual([{ category: 'design', landed: 'partial' }, { category: 'solved', landed: null }]);
  });

  it('逐条显式 null 表示「未落地」，不继承顶层 landed', async () => {
    const content = JSON.stringify([{ title: '显式空', body_md: '正文', category: 'design', landed: null }]);
    const res = await post({ scope: 'common', format: 'json', content, landed: 'landed' });
    expect(res.status).toBe(200);
    expect(res.body.pages[0]).toMatchObject({ category: 'design', landed: 'proposed' });
  });

  it('design 缺 landed → proposed；非 design 类 landed 恒为 null', async () => {
    const content = JSON.stringify([
      { title: '设计无落地', body_md: '正文', category: 'design' },
      { title: '解决类带落地', body_md: '正文', category: 'solved', landed: 'landed' },
    ]);
    const res = await post({ scope: 'common', format: 'json', content });
    expect(res.status).toBe(200);
    expect(res.body.pages[0]).toMatchObject({ category: 'design', landed: 'proposed' });
    expect(res.body.pages[1]).toMatchObject({ category: 'solved', landed: null });
  });

  it('逐条非法 category / landed → 400 且指明条序号与可选值', async () => {
    const badCategory = await post({
      scope: 'common',
      format: 'json',
      content: JSON.stringify([
        { title: '正常', body_md: '正文一', category: 'design' },
        { title: '越界', body_md: '正文二', category: 'bogus' },
      ]),
    });
    expect(badCategory.status).toBe(400);
    expect(badCategory.body.error.message).toContain('第 2 条');
    expect(badCategory.body.error.message).toContain('bogus');
    expect(badCategory.body.error.message).toContain('design / solved / pinned / open / legacy');

    const badLanded = await post({
      scope: 'common',
      format: 'json',
      content: JSON.stringify([{ title: '落地越界', body_md: '正文', category: 'design', landed: 'done' }]),
    });
    expect(badLanded.status).toBe(400);
    expect(badLanded.body.error.message).toContain('第 1 条');
    expect(badLanded.body.error.message).toContain('done');
    expect(badLanded.body.error.message).toContain('landed / partial / proposed');
  });

  it('纯函数：planImport 保留逐条字段（不经过 HTTP 也一样）', async () => {
    const { planImport } = await import('../src/services/knowledgeImport.js');
    const planned = planImport({
      scope: 'common',
      format: 'json',
      domain: 'knowledge',
      content: JSON.stringify([
        { title: 'A', body_md: 'a', category: 'design', landed: 'partial' },
        { title: 'B', body_md: 'b', category: 'solved' },
      ]),
    });
    expect(planned.drafts.map((d) => ({ category: d.category, landed: d.landed })))
      .toEqual([{ category: 'design', landed: 'partial' }, { category: 'solved', landed: undefined }]);
  });

  // ---- IMPORT-LIMIT-S：单文件 10MB / 正文 200 万字符 ----

  it('9MB 文件（json 多页，每页 <200 万字符）导入通过：验证单文件 10MB 放行', async () => {
    const perPage = 1_870_000; // 5 页 ≈ 9.35M 字符 ≈ 8.9MB 请求体
    const pages = Array.from({ length: 5 }, (_, i) => ({ title: `9MB 页 ${i + 1}`, body_md: 'x'.repeat(perPage), slug: `limit-9mb-${i + 1}` }));
    const res = await post({ scope: 'common', format: 'json', content: JSON.stringify(pages), filename: 'ok-9mb.json' });
    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(5);
    for (const page of res.body.pages) expect(page.body_md.length).toBe(perPage);
  }, 120_000);

  it('200 万字符正文通过，且 GET 回读长度一致（不截断）', async () => {
    const body = 'y'.repeat(2_000_000);
    const res = await post({ scope: 'common', format: 'txt', content: body, title: '两百万页', slug: 'limit-2m' });
    expect(res.status).toBe(200);
    const id = res.body.pages[0].id as string;
    const read = await request(app).get(`/api/knowledge/pages/${id}`).query({ scope: 'common' });
    expect(read.status).toBe(200);
    expect(read.body.body_md.length).toBe(2_000_000);
    expect(read.body.body_md).toBe(body);
  }, 60_000);

  it('200 万零 1 字符 → 413 IMPORT_BODY_TOO_LONG，文案给「当前 N / 上限 2,000,000」', async () => {
    const res = await post({ scope: 'common', format: 'txt', content: 'z'.repeat(2_000_001), title: '超一字', slug: 'limit-2m-plus' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('IMPORT_BODY_TOO_LONG');
    expect(res.body.error.message).toContain('2000001');
    expect(res.body.error.message).toContain('2,000,000');
  }, 60_000);

  it('超过 10MB 内容 → 413 IMPORT_TOO_LARGE（业务层，文案写明 10MB）', async () => {
    // 11MB：先过 12MB parser，再由业务层 assertContentLimits 拒（不走 parser）
    const res = await post({ scope: 'common', format: 'txt', content: 'w'.repeat(11 * 1024 * 1024), title: '11MB 页', slug: 'limit-11mb' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('IMPORT_TOO_LARGE');
    expect(res.body.error.message).toContain('10MB');
  }, 120_000);

  it('常量口径：单文件 10MB / 正文 2,000,000', async () => {
    const mod = await import('../src/services/knowledgeImport.js');
    expect(mod.IMPORT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(mod.IMPORT_MAX_BODY_CHARS).toBe(2_000_000);
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

  // KB-CR-1：导入路径与创建同口径（domain 必填）
  it('KB-CR-1：缺 domain / 空串 / 非法词表 → 400 且文案列出可选域', async () => {
    const missing = await request(app).post('/api/knowledge/pages/import')
      .send({ scope: 'common', format: 'txt', content: '正文', title: '无域页', slug: 'no-domain-import' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('domain');
    expect(missing.body.error.message).toContain('knowledge');

    const empty = await post({ scope: 'common', format: 'txt', content: '正文', title: '空域页', slug: 'empty-domain-import', domain: '' });
    expect(empty.status).toBe(400);

    const bogus = await post({ scope: 'common', format: 'txt', content: '正文', title: '错域页', slug: 'bogus-domain-import', domain: 'bogus' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.message).toContain('domain 只能是');
  });

  it('KB-CR-1：domain 落库；json 条目内 domain 覆盖顶层，缺省条目继承顶层', async () => {
    const res = await post({
      scope: 'workspace', workspace_id: ws, format: 'json', domain: 'board', filename: 'multi.json',
      content: JSON.stringify([
        { title: '顶层域页', body: '继承 board', slug: 'import-domain-top' },
        { title: '条目域页', body: '覆盖 infra', slug: 'import-domain-item', domain: 'infra' },
      ]),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pages.map((p: { domain: string }) => p.domain)).toEqual(['board', 'infra']);
  });
});
