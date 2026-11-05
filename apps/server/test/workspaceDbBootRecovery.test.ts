/**
 * STORE-4d：启动恢复遍历 + 单例按库懒创建 + 账号固定中心。
 *
 * 真多库（中心库 + 两个 localized 工作区库文件）+ createWorkspaceDbRouting 装配：
 * - recoverOnBoot(中心库, routing)：中心库与工作区库的运行中会话全部收敛、占用释放、system 评论落各自库；
 * - initSessionManager routing：会话行落「工作区当前库」，sendToSession/stopSession 按会话跨库解析不串库；
 * - AttachmentStore routing：upload 行+文件按库落位（懒创建目录缓存按库隔离），issue/session 维度按行探测跨库定位，processCleanup 遍历全部库；
 * - 账号/凭据路径恒为中心目录（SecretVault.root / attachments.storageDir 不随 localized 工作区漂移）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { createSession as insertSessionRow, getSession } from '../src/db/repos/session.js';
import { listMessagesBySession } from '../src/db/repos/message.js';
import { addComment, listCommentsByIssue } from '../src/db/repos/comment.js';
import { bindAttachmentsToSession } from '../src/db/repos/attachment.js';
import { closeWorkspaceDbs, createWorkspaceDbRouting, type WorkspaceDbRouting } from '../src/db/resolver.js';
import { recoverOnBoot, createSession, initSessionManager, resetSessionManager, sendToSession, stopSession } from '../src/services/sessionManager.js';
import { AttachmentStore, DEFAULT_ATTACHMENT_QUOTA_BYTES, DEFAULT_ATTACHMENT_STAGED_TTL_MS, DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS } from '../src/services/attachments.js';
import { createApp } from '../src/index.js';

let t: TestDb;
let root: string;
let routing: WorkspaceDbRouting;
let instanceSeq = 0;
/** 夹具直开的工作区库句柄（afterEach 统一关，避免 Windows 目录占用导致 rmSync EPERM） */
const fixtureDbs: Db[] = [];

interface WsFixture {
  id: string;
  db: Db;
  dbPath: string;
  attachmentsDir: string;
}

/** 真 localized 工作区库：`<root>/<name>/.agentboard/agentboard.db` + workspace 行副本 + meta 镜像（localize 终态同款） */
function makeLocalizedWorkspace(name: string, options: { keepOpen: boolean } = { keepOpen: true }): WsFixture {
  const wsPath = join(root, name);
  const stateDir = join(wsPath, '.agentboard');
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, 'agentboard.db');
  const db = openDb(dbPath);
  initSchema(db);
  const id = createWorkspace(t.db, { name, path: wsPath }).id;
  t.db.prepare("UPDATE workspace SET db_mode='localized' WHERE id=?").run(id);
  const row = t.db.prepare('SELECT * FROM workspace WHERE id=?').get(id) as Record<string, unknown>;
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO workspace (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c] as never));
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized','1')").run(id);
  if (options.keepOpen) fixtureDbs.push(db);
  else db.close();
  return { id, db, dbPath, attachmentsDir: join(dirname(dbPath), 'attachments') };
}

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

let adapter: FakeAdapter;

beforeEach(() => {
  t = createTestDb();
  root = mkdtempSync(join(tmpdir(), 'agentboard-4d-'));
  adapter = new FakeAdapter();
  routing = createWorkspaceDbRouting(t.db, { instanceId: `inst-4d-${++instanceSeq}`, port: 0 });
  let clock = 2_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  resetSessionManager();
  closeWorkspaceDbs(`inst-4d-${instanceSeq}`);
  resetSessionManager();
  for (const db of fixtureDbs) {
    try { db.close(); } catch { /* 已关 */ }
  }
  fixtureDbs.length = 0;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  t.cleanup();
});

describe('STORE-4d 启动恢复遍历（recoverOnBoot 全库覆盖）', () => {
  it('中心库与两个 localized 工作区库的运行中会话全部收敛：置失败、收口轮次、释放占用、system 评论落各自库', async () => {
    const wsB = makeLocalizedWorkspace('ws-b');
    const wsC = makeLocalizedWorkspace('ws-c');
    // 中心库：运行中会话 + 占用中的 issue（issue↔session 双向绑定，与派发链路落库形态一致）
    const centerWs = createWorkspace(t.db, { name: '中心区', path: join(root, 'center-ws') }).id;
    const centerIssue = createIssue(t.db, { workspace_id: centerWs, title: '中心任务' });
    const centerSession = insertSessionRow(t.db, { workspace_id: centerWs, issue_id: centerIssue.id, cli: 'fake', status: '运行中' });
    t.db.prepare("UPDATE issue SET status='进行中', claimed_by='fake', session_id=? WHERE id=?").run(centerSession.id, centerIssue.id);
    // 工作区库 B：运行中会话 + 占用中的 issue（行在工作区库）
    const wsIssue = createIssue(wsB.db, { workspace_id: wsB.id, title: '区任务' });
    const wsSession = insertSessionRow(wsB.db, { workspace_id: wsB.id, issue_id: wsIssue.id, cli: 'fake', status: '运行中' });
    wsB.db.prepare("UPDATE issue SET status='进行中', claimed_by='fake', session_id=? WHERE id=?").run(wsSession.id, wsIssue.id);
    // 工作区库 C：无运行中会话（遍历覆盖但不误伤）

    await recoverOnBoot(t.db, routing);

    // 中心库收敛
    expect(getSession(t.db, centerSession.id)?.status).toBe('失败');
    const centerAfter = getIssue(t.db, centerIssue.id);
    expect(centerAfter?.claimed_by).toBeNull();
    expect(centerAfter?.session_id).toBeNull();
    expect(listCommentsByIssue(t.db, centerIssue.id).some((c) => c.author === 'system' && c.content === '服务重启，会话中断')).toBe(true);

    // 工作区库 B 收敛（恢复遍历全覆盖：不漏工作区库）
    expect(getSession(wsB.db, wsSession.id)?.status).toBe('失败');
    expect(getSession(t.db, wsSession.id)).toBeNull();
    const wsAfter = getIssue(wsB.db, wsIssue.id);
    expect(wsAfter?.claimed_by).toBeNull();
    expect(wsAfter?.session_id).toBeNull();
    expect(listCommentsByIssue(wsB.db, wsIssue.id).some((c) => c.author === 'system' && c.content === '服务重启，会话中断')).toBe(true);
    // 工作区库 C 未受影响（无会话即无改动，不报错）
    expect(wsC.db.prepare('SELECT COUNT(*) AS n FROM session').get()).toMatchObject({ n: 0 });
  });

  it('未传 scope 时保持单库语义（既有调用不回归）', async () => {
    const centerWs = createWorkspace(t.db, { name: '单库区', path: join(root, 'single') }).id;
    const session = insertSessionRow(t.db, { workspace_id: centerWs, cli: 'fake', status: '运行中' });
    await recoverOnBoot(t.db);
    expect(getSession(t.db, session.id)?.status).toBe('失败');
  });
});

describe('STORE-4d sessionManager 按库懒创建缓存', () => {
  it('会话行落工作区库；send/stop 按会话解析所在库不串库；中心区会话仍落中心库', async () => {
    const wsB = makeLocalizedWorkspace('ws-b');
    const centerWs = createWorkspace(t.db, { name: '中心区', path: join(root, 'center-ws') }).id;
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3, routing });

    const wsSession = await createSession({ cli: 'fake', workspace_id: wsB.id, prompt: '第一条' });
    await settle();
    // 会话行在工作区库，不在中心库（懒缓存按库隔离）
    expect(getSession(t.db, wsSession.id)).toBeNull();
    expect(getSession(wsB.db, wsSession.id)?.workspace_id).toBe(wsB.id);
    // 消息落工作区库
    expect(listMessagesBySession(wsB.db, wsSession.id).map((m) => m.role)).toEqual(['user', 'assistant']);

    // 中心区会话仍落中心库（未下沉区回中心库）
    const centerSession = await createSession({ cli: 'fake', workspace_id: centerWs, prompt: '中心会话' });
    await settle();
    expect(getSession(t.db, centerSession.id)?.workspace_id).toBe(centerWs);
    expect(getSession(wsB.db, centerSession.id)).toBeNull();

    // 跨库解析：向工作区库会话续发（缓存命中路径），消息落工作区库而非中心库
    await sendToSession(wsSession.id, '第二条');
    await settle();
    const wsMessages = listMessagesBySession(wsB.db, wsSession.id).map((m) => m.content);
    expect(wsMessages).toContain('第二条');
    expect(listMessagesBySession(t.db, wsSession.id)).toHaveLength(0);

    // stop 按会话解析所在库
    await stopSession(wsSession.id);
    expect(getSession(wsB.db, wsSession.id)?.status).toBe('已结束');
    // 中心库会话行不受影响（首轮已完成落终态，行仍在中心库）
    expect(getSession(t.db, centerSession.id)?.workspace_id).toBe(centerWs);
    expect(getSession(wsB.db, centerSession.id)).toBeNull();
  });
});

describe('STORE-4d AttachmentStore 按库懒创建缓存', () => {
  const policy = {
    attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
    attachmentStagedTtlMs: DEFAULT_ATTACHMENT_STAGED_TTL_MS,
    attachmentCleanupIntervalMs: DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  };
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('upload 行+文件按库落位；目录懒创建按库隔离不串目录', async () => {
    const wsB = makeLocalizedWorkspace('ws-b');
    const centerWs = createWorkspace(t.db, { name: '中心区', path: join(root, 'center-ws') }).id;
    const centerDir = join(root, 'center-attachments');
    const store = new AttachmentStore(t.db, centerDir, policy, routing);

    const upWs = await store.upload(wsB.id, 'image/png', 'a.png', bytes);
    // 行在工作区库，文件在工作区库目录；中心库无该行
    expect(wsB.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upWs.id)).toMatchObject({ n: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upWs.id)).toMatchObject({ n: 0 });
    const wsFiles = readdirSync(wsB.attachmentsDir);
    expect(wsFiles).toHaveLength(1);
    expect(store.workspacePath(wsB.id, upWs.id)).toBe(join(wsB.attachmentsDir, wsFiles[0]!));

    const upCenter = await store.upload(centerWs, 'image/png', 'b.png', bytes);
    // 行与文件在中心库/中心目录；工作区库不受影响
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upCenter.id)).toMatchObject({ n: 1 });
    expect(wsB.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upCenter.id)).toMatchObject({ n: 0 });
    expect(readdirSync(centerDir)).toHaveLength(1);
    expect(store.workspacePath(centerWs, upCenter.id)).toBe(join(centerDir, readdirSync(centerDir)[0]!));
    // 读回不串库：各自 workspace 维度读各自的行与目录
    expect(store.workspaceMime(wsB.id, upWs.id)).toBe('image/png');
    expect(store.workspaceMime(centerWs, upCenter.id)).toBe('image/png');
  });

  it('issue/session 维度按行探测跨库定位（先中心后 fan-out）', async () => {
    const wsB = makeLocalizedWorkspace('ws-b');
    const centerDir = join(root, 'center-attachments');
    const store = new AttachmentStore(t.db, centerDir, policy, routing);
    const upWs = await store.upload(wsB.id, 'image/png', 'a.png', bytes);

    // session 维度：行绑在会话上（工作区库），探测跨库定位
    const session = insertSessionRow(wsB.db, { workspace_id: wsB.id, cli: 'fake', status: '已结束' });
    bindAttachmentsToSession(wsB.db, wsB.id, session.id, [upWs.id], Date.now());
    const sessionPath = store.sessionPath(session.id, upWs.id);
    expect(sessionPath).toContain(dirname(wsB.dbPath));
    expect(store.sessionMime(session.id, upWs.id)).toBe('image/png');

    // issue 维度：行绑在评论上（工作区库），探测跨库定位
    const issue = createIssue(wsB.db, { workspace_id: wsB.id, title: '区任务' });
    const comment = addComment(wsB.db, { issue_id: issue.id, author: 'agent:fake', content: '带图评论' });
    wsB.db.prepare('INSERT INTO comment_attachment (comment_id, attachment_id) VALUES (?,?)').run(comment.id, upWs.id);
    const issuePath = store.issuePath(issue.id, upWs.id);
    expect(issuePath).toContain(dirname(wsB.dbPath));
    expect(store.issueMime(issue.id, upWs.id)).toBe('image/png');

    // 中心库行仍可直接命中（探测先中心）
    const centerWs = createWorkspace(t.db, { name: '中心区', path: join(root, 'center-ws') }).id;
    const upCenter = await store.upload(centerWs, 'image/png', 'b.png', bytes);
    expect(store.workspacePath(centerWs, upCenter.id)).toContain(centerDir);
  });

  it('processCleanup 遍历中心库与工作区库：过期 staged 行各自清理，文件按库删除', async () => {
    const wsB = makeLocalizedWorkspace('ws-b');
    const centerDir = join(root, 'center-attachments');
    const store = new AttachmentStore(t.db, centerDir, policy, routing);
    const upWs = await store.upload(wsB.id, 'image/png', 'a.png', bytes);
    const upCenterWs = createWorkspace(t.db, { name: '中心区', path: join(root, 'center-ws') }).id;
    const upCenter = await store.upload(upCenterWs, 'image/png', 'b.png', bytes);
    // 两库的 staged 行都置为已过期
    const expired = Date.now() - 1000;
    wsB.db.prepare('UPDATE attachment SET expires_at=? WHERE id=?').run(expired, upWs.id);
    t.db.prepare('UPDATE attachment SET expires_at=? WHERE id=?').run(expired, upCenter.id);

    await store.processCleanup();

    // 行与文件按库各自清理（目录清空）
    expect(wsB.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upWs.id)).toMatchObject({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM attachment WHERE id=?').get(upCenter.id)).toMatchObject({ n: 0 });
    expect(existsSync(wsB.attachmentsDir) ? readdirSync(wsB.attachmentsDir).length : 0).toBe(0);
    expect(existsSync(centerDir) ? readdirSync(centerDir).length : 0).toBe(0);
  });
});

describe('STORE-4d 账号/凭据路径恒为中心目录', () => {
  it('存在 localized 工作区时 SecretVault 与附件根目录仍固定中心库旁', async () => {
    makeLocalizedWorkspace('ws-b', { keepOpen: false });
    const created = await createApp({
      db: t.db,
      getAdapter: fakeResolver,
      adapters: [adapter],
      refreshClisOnBoot: false,
      workspaceRouting: routing,
    });
    expect(created.secretVault.root).toBe(resolve(dirname(t.db.name), 'accounts'));
    expect(created.attachments.storageDir).toBe(resolve(dirname(t.db.name), 'attachments'));
  });
});
