import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { migrateAttachmentKind } from '../src/db/migrations/attachments.js';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'ascii');
const TXT = Buffer.from('hello generic file');

interface StagedResponse {
  id: string;
  workspace_id: string;
  file_name: string;
  mime_type: string;
  kind: 'image' | 'file';
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

/** 旧库（D7 前）的 attachment DDL：mime_type 带三图片白名单 CHECK、无 kind 列 */
const LEGACY_ATTACHMENT_DDL = `
  CREATE TABLE attachment (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    status TEXT NOT NULL CHECK (status IN ('staged','attached')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

describe('attachment kind 迁移（D7）', () => {
  let t: TestDb;

  afterEach(() => {
    t.cleanup();
  });

  function downgradeToLegacy(db: TestDb['db']): void {
    // DROP attachment 会让引用它的两个跨表触发器被重新解析而报 no such table——先摘掉再降级
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER IF EXISTS comment_attachment_delete_image');
    db.exec('DROP TRIGGER IF EXISTS session_attachment_delete_image');
    db.exec('DROP TABLE attachment');
    db.exec(LEGACY_ATTACHMENT_DDL);
    db.exec(`
      CREATE TRIGGER attachment_queue_cleanup
        BEFORE DELETE ON attachment
        BEGIN
          INSERT OR IGNORE INTO attachment_cleanup(storage_key,size_bytes,queued_at)
          VALUES (old.storage_key,old.size_bytes,CAST(strftime('%s','now') AS INTEGER)*1000);
        END;
      CREATE TRIGGER comment_attachment_delete_image
        AFTER DELETE ON comment_attachment
        BEGIN
          DELETE FROM attachment WHERE id=old.attachment_id;
        END;
      CREATE TRIGGER session_attachment_delete_image
        AFTER DELETE ON session_attachment
        BEGIN
          DELETE FROM attachment WHERE id=old.attachment_id;
        END;
    `);
  }

  it('旧库存量按 mime 三态推导 kind=image；重建后 mime 白名单 CHECK 移除且可重入', () => {
    t = createTestDb();
    const db = t.db;
    downgradeToLegacy(db);
    db.prepare("INSERT INTO workspace(id,name,path,created_at) VALUES ('ws-1','w','C:/w',1)").run();
    const insert = db.prepare(`INSERT INTO attachment(id,workspace_id,storage_key,file_name,mime_type,size_bytes,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,'staged',1,2)`);
    insert.run('a-png', 'ws-1', '11111111-1111-4111-8111-111111111111', 'a.png', 'image/png', 1);
    insert.run('a-jpg', 'ws-1', '22222222-2222-4222-8222-222222222222', 'a.jpg', 'image/jpeg', 1);
    insert.run('a-webp', 'ws-1', '33333333-3333-4333-8333-333333333333', 'a.webp', 'image/webp', 1);

    migrateAttachmentKind(db);

    const rows = db.prepare('SELECT id,kind,mime_type FROM attachment ORDER BY id').all() as Array<{ id: string; kind: string; mime_type: string }>;
    expect(rows).toEqual([
      { id: 'a-jpg', kind: 'image', mime_type: 'image/jpeg' },
      { id: 'a-png', kind: 'image', mime_type: 'image/png' },
      { id: 'a-webp', kind: 'image', mime_type: 'image/webp' },
    ]);
    // 新表：mime 无白名单 CHECK（任意 MIME 可写），kind 两值 CHECK 兜底
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachment'").get() as { sql: string }).sql;
    expect(tableSql).not.toMatch(/mime_type[^,]*CHECK/i);
    expect(tableSql).toMatch(/kind TEXT NOT NULL CHECK \(kind IN \('image','file'\)\)/);
    db.prepare(`INSERT INTO attachment(id,workspace_id,storage_key,file_name,mime_type,kind,size_bytes,status,created_at,expires_at)
      VALUES ('a-txt','ws-1','44444444-4444-4444-8444-444444444444','a.txt','text/plain','file',1,'staged',1,2)`).run();

    // 可重入：再跑一次是 no-op
    migrateAttachmentKind(db);
    expect((db.prepare('SELECT COUNT(*) AS count FROM attachment').get() as { count: number }).count).toBe(4);

    // 重建后触发器原样装回：attachment_queue_cleanup 照常入清理台账
    db.exec("DELETE FROM attachment WHERE id='a-txt'");
    expect(db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup WHERE storage_key=?').get('44444444-4444-4444-8444-444444444444')).toMatchObject({ count: 1 });
    // 跨表触发器（正文引用 attachment）也在
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('comment_attachment_delete_image','session_attachment_delete_image','attachment_queue_cleanup')").all() as Array<{ name: string }>;
    expect(triggers).toHaveLength(3);
  });

  it('新库（已含 kind 列）重复执行迁移是 no-op，数据保持不变', () => {
    t = createTestDb();
    const db = t.db;
    db.prepare("INSERT INTO workspace(id,name,path,created_at) VALUES ('ws-1','w','C:/w',1)").run();
    db.prepare(`INSERT INTO attachment(id,workspace_id,storage_key,file_name,mime_type,kind,size_bytes,status,created_at,expires_at)
      VALUES ('a-1','ws-1','55555555-5555-4555-8555-555555555555','a.txt','text/plain','file',1,'staged',1,2)`).run();

    migrateAttachmentKind(db);

    expect((db.prepare('SELECT COUNT(*) AS count FROM attachment').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT kind FROM attachment WHERE id=?').get('a-1')).toMatchObject({ kind: 'file' });
  });
});

describe('通用附件上传 / 下载 / 路径索引 API（D7）', () => {
  let t: TestDb;
  let app: Express;
  let spaceDirs: string[];
  let storageRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    t = createTestDb();
    spaceDirs = [];
    storageRoot = mkdtempSync(join(tmpdir(), 'agentboard-kind-store-'));
    storageDir = join(storageRoot, '.superpowers', 'attachments');
    mkdirSync(storageDir, { recursive: true });
    const created = await createApp({ db: t.db, refreshClisOnBoot: false, attachmentStorageDir: storageDir });
    app = created.app;
  });

  afterEach(() => {
    t.cleanup();
    for (const dir of spaceDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function createWorkspace(name: string): Promise<string> {
    const path = mkdtempSync(join(tmpdir(), 'agentboard-kind-space-'));
    spaceDirs.push(path);
    const response = await request(app).post('/api/workspaces').send({ name, path });
    expect(response.status).toBe(200);
    return response.body.id as string;
  }

  async function createIssue(workspaceId: string, title = 'kind issue'): Promise<string> {
    const response = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title }));
    expect(response.status).toBe(200);
    return response.body.id as string;
  }

  async function upload(workspaceId: string, contentType: string, fileName: string, bytes: Buffer): Promise<StagedResponse> {
    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', contentType)
      .set('X-File-Name', fileName)
      .send(bytes);
    expect(response.status).toBe(201);
    return response.body as StagedResponse;
  }

  it('非图片 MIME 上传落 kind=file；workspace 下载按 kind 给 attachment 下载建议', async () => {
    const workspaceId = await createWorkspace('generic-file');
    const staged = await upload(workspaceId, 'text/plain', 'notes.txt', TXT);
    expect(staged).toMatchObject({ mime_type: 'text/plain', kind: 'file', file_name: 'notes.txt', size_bytes: TXT.length });

    const download = await request(app).get(`/api/workspaces/${workspaceId}/attachments/${staged.id}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/text\/plain/);
    expect(download.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''notes.txt`);
    // supertest 对 text/plain 按字符串解析响应体
    expect(download.text).toBe(TXT.toString());
  });

  it('图片上传仍是 kind=image 且 inline；issue 级下载同样按 kind 分流', async () => {
    const workspaceId = await createWorkspace('kind-disposition');
    const issueId = await createIssue(workspaceId);
    const image = await upload(workspaceId, 'image/png', 'screen.png', PNG);
    expect(image.kind).toBe('image');
    const inline = await request(app).get(`/api/workspaces/${workspaceId}/attachments/${image.id}`);
    expect(inline.headers['content-disposition']).toBe(`inline; filename*=UTF-8''screen.png`);

    const file = await upload(workspaceId, 'text/plain', 'notes.txt', TXT);
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [image.id, file.id] });
    const issueFile = await request(app).get(`/api/issues/${issueId}/attachments/${file.id}`);
    expect(issueFile.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''notes.txt`);
    const issueImage = await request(app).get(`/api/issues/${issueId}/attachments/${image.id}`);
    expect(issueImage.headers['content-disposition']).toBe(`inline; filename*=UTF-8''screen.png`);
  });

  it('声明图片 MIME 但签名不符仍 400；非图片超 10 MiB 413 且不落盘', async () => {
    const workspaceId = await createWorkspace('kind-guards');
    const fakeImage = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'fake.png')
      .send(Buffer.from('not a PNG'));
    expect(fakeImage.status).toBe(400);
    expect(fakeImage.body.error.code).toBe('ATTACHMENT_INVALID_IMAGE');

    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    const tooLarge = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'text/plain')
      .send(bytes);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(readdirSync(storageDir)).toHaveLength(0);
  });

  it('列表端点分页返回 id/file_name/kind/size_bytes/url（固定 workspace URL），评论与会话关联都入列', async () => {
    const workspaceId = await createWorkspace('path-index');
    const issueId = await createIssue(workspaceId);
    const png = await upload(workspaceId, 'image/png', 'screen.png', PNG);
    const txt1 = await upload(workspaceId, 'text/plain', 'a.txt', TXT);
    const txt2 = await upload(workspaceId, 'text/plain', 'b.txt', TXT);
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [png.id, txt1.id] });

    // 会话通道：session.issue_id 指向该卡，附件经 session_attachment 绑定
    const now = Date.now();
    t.db.prepare("INSERT INTO session(id,workspace_id,issue_id,cli,status,created_at) VALUES ('sess-1',?,?,'codex','运行中',?)").run(workspaceId, issueId, now);
    t.db.prepare('UPDATE attachment SET status=? WHERE id=?').run('attached', txt2.id);
    t.db.prepare('INSERT INTO session_attachment(session_id,attachment_id,position) VALUES (?, ?, 0)').run('sess-1', txt2.id);
    // created_at 控序：txt2（会话）最新，png 次之，txt1 最旧
    t.db.prepare('UPDATE attachment SET created_at=? WHERE id=?').run(now - 1000, png.id);
    t.db.prepare('UPDATE attachment SET created_at=? WHERE id=?').run(now - 2000, txt1.id);

    const firstPage = await request(app).get(`/api/issues/${issueId}/attachments?limit=2`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.next_offset).toBe(2);
    expect(firstPage.body.items).toEqual([
      { id: txt2.id, file_name: 'b.txt', kind: 'file', size_bytes: TXT.length, url: `/api/workspaces/${workspaceId}/attachments/${txt2.id}` },
      { id: png.id, file_name: 'screen.png', kind: 'image', size_bytes: PNG.length, url: `/api/workspaces/${workspaceId}/attachments/${png.id}` },
    ]);
    const secondPage = await request(app).get(`/api/issues/${issueId}/attachments?limit=2&offset=2`);
    expect(secondPage.body.items).toEqual([
      { id: txt1.id, file_name: 'a.txt', kind: 'file', size_bytes: TXT.length, url: `/api/workspaces/${workspaceId}/attachments/${txt1.id}` },
    ]);
    expect(secondPage.body.next_offset).toBeNull();

    // 未关联（staged）附件不进列表；未知 issue 404
    const stagedOnly = await upload(workspaceId, 'text/plain', 'staged.txt', TXT);
    const relist = await request(app).get(`/api/issues/${issueId}/attachments`);
    expect(relist.body.items).toHaveLength(3);
    expect(relist.body.items.find((item: { id: string }) => item.id === stagedOnly.id)).toBeUndefined();
    expect((await request(app).get('/api/issues/iss-unknown/attachments')).status).toBe(404);
  });

  it('配额对通用文件仍生效：占满后下一个上传 413', async () => {
    const workspaceId = await createWorkspace('kind-quota');
    const created = await createApp({
      db: t.db,
      refreshClisOnBoot: false,
      attachmentStorageDir: storageDir,
      attachmentQuotaBytes: TXT.length,
    });
    app = created.app;
    const uploadOnce = () => request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'text/plain')
      .set('X-File-Name', 'notes.txt')
      .send(TXT);
    expect((await uploadOnce()).status).toBe(201);
    const second = await uploadOnce();
    expect(second.status).toBe(413);
    expect(second.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    expect(readdirSync(storageDir)).toHaveLength(1);
  });
});
