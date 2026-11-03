/**
 * KB-IMG-1：知识页图片上传/读取/删除（multipart、限额、可见性、回收）。
 *
 * 覆盖四类错误码（413/415/409/404）、common 页跨工作区可读、workspace 页跨区 403、
 * 删除页面后行 CASCADE + 文件回收。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { KNOWLEDGE_IMAGE_MAX_PER_PAGE, knowledgeAttachmentsRoot } from '../src/services/knowledgeImages.js';
import { parseMultipart } from '../src/services/multipart.js';

/** 最小 PNG：签名 + IHDR(width,height)，尺寸读取只依赖这两段 */
function png(width: number, height: number, paddingBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  return Buffer.concat([sig, ihdr, Buffer.alloc(paddingBytes)]);
}

function multipartBody(fields: Record<string, string>, file: { fieldName?: string; filename: string; contentType: string; data: Buffer }, boundary = '----agentboard-test'): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName ?? 'file'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  ));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('knowledge images (KB-IMG-1)', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsA: string;
  let wsB: string;
  let pageA: string;
  let commonPage: string;

  const mkPage = async (scope: 'workspace' | 'common', slug: string): Promise<string> => {
    const res = await request(app).post('/api/knowledge/pages').send({
      scope,
      ...(scope === 'workspace' ? { workspace_id: wsA } : {}),
      slug, title: `页-${slug}`, body_md: '正文', actor: 'tester',
      sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
      evidence: [{ source_id: 's', locator: 'issue:1', snapshot: 'verified' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  };

  const upload = async (pageId: string, file: { filename: string; contentType: string; data: Buffer }, fields: Record<string, string> = { scope: 'workspace', workspace_id: wsA }) =>
    request(app)
      .post(`/api/knowledge/pages/${pageId}/images`)
      .set('Content-Type', multipartBody(fields, file).contentType)
      .send(multipartBody(fields, file).body);

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kbimg-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
      attachmentStorageDir: join(root, 'attachments'),
    });
    app = created.app;
    wsA = createWorkspace(t.db, { name: 'A 空间', path: mkdtempSync(join(root, 'a-')) }).id;
    wsB = createWorkspace(t.db, { name: 'B 空间', path: mkdtempSync(join(root, 'b-')) }).id;
    pageA = await mkPage('workspace', 'img-a');
    commonPage = await mkPage('common', 'img-common');
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('uploadsPngAndReturnsUrlBytesAndSize', async () => {
    const res = await upload(pageA, { filename: 'a.png', contentType: 'image/png', data: png(120, 80) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ bytes: png(120, 80).length, width: 120, height: 80, mime: 'image/png' });
    expect(res.body.url).toBe(`/api/knowledge/images/${res.body.id}`);
    const row = t.db.prepare('SELECT storage_key, mime FROM knowledge_attachment WHERE id=?').get(res.body.id) as { storage_key: string; mime: string };
    expect(row.storage_key).toMatch(new RegExp(`^knowledge/${pageA}/[0-9a-f-]{36}\\.png$`));
    // 落盘路径 = dirname(db)/attachments/knowledge/...
    expect(existsSync(join(knowledgeAttachmentsRoot(t.db), row.storage_key))).toBe(true);
  });

  it('rejectsOversizeWith413AndNonImageWith415', async () => {
    const tooBig = await upload(pageA, { filename: 'big.png', contentType: 'image/png', data: png(10, 10, 5 * 1024 * 1024) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('IMAGE_TOO_LARGE');
    expect(tooBig.body.error.message).toContain('MiB');

    const notImage = await upload(pageA, { filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello world') });
    expect(notImage.status).toBe(415);
    expect(notImage.body.error.code).toBe('IMAGE_TYPE_UNSUPPORTED');
  });

  it('rejectsThe21stImageAndOversizeTotalWith409', async () => {
    for (let i = 0; i < KNOWLEDGE_IMAGE_MAX_PER_PAGE; i += 1) {
      const ok = await upload(pageA, { filename: `p${i}.png`, contentType: 'image/png', data: png(2, 2) });
      expect(ok.status, `第 ${i + 1} 张：${JSON.stringify(ok.body)}`).toBe(201);
    }
    const extra = await upload(pageA, { filename: 'p21.png', contentType: 'image/png', data: png(2, 2) });
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('IMAGE_LIMIT_EXCEEDED');
    expect(extra.body.error.message).toContain('最多 20 张');

    // 总量超限：把已存在的行撑到接近上限（只改 DB，不落大文件），再传一张
    t.db.prepare('UPDATE knowledge_attachment SET bytes = ? WHERE page_id = ?').run(49 * 1024 * 1024, pageA);
    t.db.prepare('DELETE FROM knowledge_attachment WHERE page_id=? AND id NOT IN (SELECT id FROM knowledge_attachment WHERE page_id=? LIMIT 1)').run(pageA, pageA);
    const overTotal = await upload(pageA, { filename: 'p22.png', contentType: 'image/png', data: png(2, 2, 2 * 1024 * 1024) });
    expect(overTotal.status).toBe(409);
    expect(overTotal.body.error.code).toBe('IMAGE_LIMIT_EXCEEDED');
    expect(overTotal.body.error.message).toContain('总量');
  });

  it('servesWithImmutableCacheAndEnforcesVisibility', async () => {
    const uploaded = await upload(pageA, { filename: 'a.png', contentType: 'image/png', data: png(4, 4) });
    const id = uploaded.body.id as string;
    const same = await request(app).get(`/api/knowledge/images/${id}?scope=workspace&workspace_id=${wsA}`);
    expect(same.status).toBe(200);
    expect(same.headers['cache-control']).toContain('immutable');
    expect(same.headers['content-type']).toContain('image/png');

    const cross = await request(app).get(`/api/knowledge/images/${id}?scope=workspace&workspace_id=${wsB}`);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('KNOWLEDGE_SCOPE_FORBIDDEN');

    // common 页的图片任何工作区都能读
    const commonUpload = await upload(commonPage, { filename: 'c.png', contentType: 'image/png', data: png(6, 6) }, { scope: 'common' });
    expect(commonUpload.status).toBe(201);
    const readable = await request(app).get(`/api/knowledge/images/${commonUpload.body.id}?scope=workspace&workspace_id=${wsB}`);
    expect(readable.status).toBe(200);

    expect((await request(app).get('/api/knowledge/images/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('deletesImageAndLeavesBodyUntouched', async () => {
    const uploaded = await upload(pageA, { filename: 'a.png', contentType: 'image/png', data: png(3, 3) });
    const id = uploaded.body.id as string;
    const before = t.db.prepare('SELECT body_md FROM knowledge_page WHERE id=?').get(pageA) as { body_md: string };
    const del = await request(app).delete(`/api/knowledge/images/${id}?scope=workspace&workspace_id=${wsA}`);
    expect(del.status).toBe(204);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_attachment WHERE id=?').get(id)).toEqual({ n: 0 });
    // 正文不被改写
    expect((t.db.prepare('SELECT body_md FROM knowledge_page WHERE id=?').get(pageA) as { body_md: string }).body_md).toBe(before.body_md);
    const again = await request(app).delete(`/api/knowledge/images/${id}?scope=workspace&workspace_id=${wsA}`);
    expect(again.status).toBe(404);

    const cross = await upload(pageA, { filename: 'b.png', contentType: 'image/png', data: png(3, 3) });
    expect((await request(app).delete(`/api/knowledge/images/${cross.body.id}?scope=workspace&workspace_id=${wsB}`)).status).toBe(403);
  });

  it('cascadesRowsAndReclaimsFilesWhenPageIsDeleted', async () => {
    const uploaded = await upload(pageA, { filename: 'a.png', contentType: 'image/png', data: png(8, 8) });
    const row = t.db.prepare('SELECT storage_key FROM knowledge_attachment WHERE id=?').get(uploaded.body.id) as { storage_key: string };
    const filePath = join(knowledgeAttachmentsRoot(t.db), row.storage_key);
    expect(existsSync(filePath)).toBe(true);

    const del = await request(app).post(`/api/knowledge/pages/${pageA}/actions`).send({
      scope: 'workspace', workspace_id: wsA, action: 'delete', expected_revision: 1, actor: 'tester',
    });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_attachment WHERE page_id=?').get(pageA) as { n: number }).n).toBe(0);
    // removePageFiles 是异步触发的，等它落盘
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(existsSync(filePath)).toBe(false);
  });

  it('parsesMultipartStrictly', () => {
    const good = multipartBody({ scope: 'workspace' }, { filename: 'x.png', contentType: 'image/png', data: png(1, 1) });
    const parsed = parseMultipart(good.body, good.contentType);
    expect(parsed.fields.scope).toBe('workspace');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.filename).toBe('x.png');
    expect(() => parseMultipart(good.body, 'application/json')).toThrow(/multipart/);
    expect(() => parseMultipart(good.body, 'multipart/form-data')).toThrow(/boundary/);
  });
});
