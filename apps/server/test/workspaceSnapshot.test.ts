/**
 * STORE-5（M4a）：工作区文本快照导出 / 校验 / 导入。
 *
 * 覆盖卡面验收：
 * ① 同一库连续导出两次，除 manifest.exported_at 外零 diff（默认不含 messages）
 * ② 空工作区库 import 成功，行数一致
 * ③ 快照内部引用断链 → import 明确「不可导入」
 * ④ manifest 哈希不匹配 → import 拒绝
 * ⑤ enable 完成后 snapshot/ 自动生成且自校验通过
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { getDbForWorkspace, resetResolverState, workspaceStateDir } from '../src/db/resolver.js';
import { initSchema } from '../src/db/schema.js';
import { openDb } from '../src/db/connection.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import {
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from '../src/services/workspaceSnapshot.js';

describe('STORE-5（M4a）工作区文本快照', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;

  beforeEach(async () => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store5-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(root, 'attachments'), { recursive: true });
    ws = createWorkspace(t.db, { name: '快照区', path: wsPath }).id;
    for (const title of ['卡一', '卡二', '卡三']) {
      createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
    }
    createKnowledgePage(t.db, {
      domain: 'knowledge',
      scope: 'workspace',
      workspace_id: ws,
      slug: 'ws-page',
      title: '本区页',
      body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
      actor: 'tester',
    } as never);
    const result = await localizeWorkspace(t.db, {
      workspaceId: ws,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      attachmentsDir: join(root, 'attachments'),
    });
    expect(result.state).toBe('localized');
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const workspaceDb = () => {
    const resolution = getDbForWorkspace(
      { centerDb: t.db, instanceId: 'inst-store5', port: 0, openWorkspaceDbs: true },
      { id: ws, path: wsPath, dbMode: 'localized' },
    );
    expect(resolution.decision.target).toBe('workspace');
    return resolution.db;
  };

  /** 同 workspace_id 的全新工作区库：只保留 workspace 行 + meta（模拟 clone 后的空库） */
  const freshTarget = (name: string) => {
    const dir = join(root, name);
    const wsDir = join(dir, 'workspace');
    mkdirSync(wsDir, { recursive: true });
    const db = openDb(join(dir, 'agentboard.db'));
    initSchema(db);
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO workspace (id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)').run(ws, name, wsDir, Date.now(), 0);
    db.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized', '1')").run(ws);
    return { db, wsDir, close: () => db.close() };
  };

  const snapshotDir = () => join(workspaceStateDir(wsPath), 'snapshot');
  const readManifest = () => JSON.parse(readFileSync(join(snapshotDir(), 'manifest.json'), 'utf8')) as {
    exported_at: string;
    included_tables: string[];
    files: Array<{ file: string; rows: number; sha256: string }>;
  };

  it('⑤ enable 完成后自动生成 snapshot/，manifest 自校验通过且行数与库一致', () => {
    expect(existsSync(join(snapshotDir(), 'manifest.json'))).toBe(true);
    const checked = validateWorkspaceSnapshot(snapshotDir());
    expect(checked.manifest.included_tables).not.toContain('message');
    expect(checked.rows.get('issue')?.length).toBe(3);
    expect(checked.rows.get('knowledge_page')?.length).toBe(1);
    expect(existsSync(join(snapshotDir(), 'messages.jsonl'))).toBe(false);
    // 时间列落 ISO：issue 的 created_at 是字符串
    expect(typeof checked.rows.get('issue')?.[0]?.['created_at']).toBe('string');
  });

  it('① 连续导出两次：除 manifest.exported_at 外零 diff（默认不含 messages）', () => {
    const wdb = workspaceDb();
    try {
      const first = exportWorkspaceSnapshot({ db: wdb, workspacePath: wsPath });
      const firstFiles = new Map(first.manifest.files.map(item => [item.file, readFileSync(join(first.dir, `${item.file}.jsonl`), 'utf8')]));
      const second = exportWorkspaceSnapshot({ db: wdb, workspacePath: wsPath });
      const secondFiles = new Map(second.manifest.files.map(item => [item.file, readFileSync(join(second.dir, `${item.file}.jsonl`), 'utf8')]));
      expect([...secondFiles.keys()]).toEqual([...firstFiles.keys()]);
      for (const [file, content] of firstFiles) expect(secondFiles.get(file)).toBe(content);
      expect(second.manifest.files).toEqual(first.manifest.files);
      expect(second.manifest.included_tables).toEqual(first.manifest.included_tables);
      expect(second.manifest.included_tables).not.toContain('message');
      expect(second.manifest.exported_at >= first.manifest.exported_at).toBe(true);
    } finally {
      wdb.close();
    }
  });

  it('--include-messages：清单追加 messages 表并生成 messages.jsonl', () => {
    const wdb = workspaceDb();
    try {
      const result = exportWorkspaceSnapshot({ db: wdb, workspacePath: wsPath, includeMessages: true });
      expect(result.manifest.included_tables).toContain('message');
      expect(result.manifest.files.map(item => item.file)).toContain('messages');
      expect(existsSync(join(result.dir, 'messages.jsonl'))).toBe(true);
    } finally {
      wdb.close();
    }
  });

  it('② 空工作区库 import 成功，行数与快照一致（status/issue/knowledge 全还原）', () => {
    const target = freshTarget('import-empty');
    try {
      const result = importWorkspaceSnapshot({ db: target.db, dir: snapshotDir(), workspaceId: ws, workspacePath: target.wsDir });
      expect(result.rows).toBeGreaterThan(0);
      expect(result.backupPath).toBeNull();
      const count = (table: string) => (target.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('issue')).toBe(3);
      expect(count('knowledge_page')).toBe(1);
      expect(count('workspace_status')).toBeGreaterThan(0);
      const checked = validateWorkspaceSnapshot(snapshotDir());
      expect(count('issue')).toBe(checked.rows.get('issue')?.length);
      // 时间列还原为 epoch 毫秒
      const row = target.db.prepare('SELECT created_at FROM issue LIMIT 1').get() as { created_at: number };
      expect(typeof row.created_at).toBe('number');
    } finally {
      target.close();
    }
  });

  it('目标库非空且未加 replace → 409 SNAPSHOT_TARGET_NOT_EMPTY', () => {
    const wdb = workspaceDb();
    try {
      expect(() => importWorkspaceSnapshot({ db: wdb, dir: snapshotDir(), workspaceId: ws, workspacePath: wsPath }))
        .toThrowError(/目标工作区库非空/);
      try {
        importWorkspaceSnapshot({ db: wdb, dir: snapshotDir(), workspaceId: ws, workspacePath: wsPath });
      } catch (error) {
        expect((error as { code?: string }).code).toBe('SNAPSHOT_TARGET_NOT_EMPTY');
      }
    } finally {
      wdb.close();
    }
  });

  it('--replace 覆盖非空目标：先 VACUUM INTO 备份，行数回到快照', () => {
    const target = freshTarget('import-replace');
    try {
      createIssue(target.db, { workspace_id: ws, title: '多余卡', description: '', priority: '中', labels: [] } as never);
      const result = importWorkspaceSnapshot({
        db: target.db, dir: snapshotDir(), workspaceId: ws, workspacePath: target.wsDir, replace: true,
      });
      expect(result.backupPath).not.toBeNull();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(3);
      expect(target.db.prepare('SELECT 1 FROM issue WHERE title=?').get('多余卡')).toBeUndefined();
    } finally {
      target.close();
    }
  });

  it('④ manifest 哈希不匹配 → 校验与导入都明确「不可导入」', () => {
    const path = join(snapshotDir(), 'issues.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{}\n`, 'utf8');
    expect(() => validateWorkspaceSnapshot(snapshotDir())).toThrowError(/快照不可导入：issues\.jsonl 哈希不符/);
    const target = freshTarget('import-tamper');
    try {
      expect(() => importWorkspaceSnapshot({ db: target.db, dir: snapshotDir(), workspaceId: ws, workspacePath: target.wsDir }))
        .toThrowError(/快照不可导入/);
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(0);
    } finally {
      target.close();
    }
  });

  it('③ 快照内部引用断链（删掉被评论引用的 issue 后导出）→ import 拒绝并整体回滚', () => {
    const wdb = workspaceDb();
    try {
      // 造一条评论，再绕过外键写入一个不存在的 issue_id：导出允许（库为准），导入必须拒绝
      wdb.pragma('foreign_keys = OFF');
      wdb.prepare('INSERT INTO issue_comment (id, issue_id, author, content, ts) VALUES (?, ?, ?, ?, ?)')
        .run('comment-1', 'missing-issue', 'tester', '断链评论', Date.now());
      wdb.pragma('foreign_keys = ON');
      exportWorkspaceSnapshot({ db: wdb, workspacePath: wsPath });
    } finally {
      wdb.close();
    }
    // 修复：上面的评论引用了不存在的卡，正是断链场景；空库导入应失败
    const target = freshTarget('import-broken');
    try {
      expect(() => importWorkspaceSnapshot({ db: target.db, dir: snapshotDir(), workspaceId: ws, workspacePath: target.wsDir }))
        .toThrowError(/快照不可导入/);
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(0);
    } finally {
      target.close();
    }
  });

  it('③b 删掉被评论引用的 issue 行（卡面口径）→ import 拒绝，报明表名并整体回滚', () => {
    const wdb = workspaceDb();
    let orphanIssueId = '';
    try {
      orphanIssueId = (wdb.prepare('SELECT id FROM issue ORDER BY created_at LIMIT 1').get() as { id: string }).id;
      wdb.prepare('INSERT INTO issue_comment (id, issue_id, author, content, ts) VALUES (?, ?, ?, ?, ?)')
        .run('comment-orphan', orphanIssueId, 'tester', '父卡被删后残留的评论', Date.now());
      wdb.pragma('foreign_keys = OFF');
      wdb.prepare('DELETE FROM issue WHERE id = ?').run(orphanIssueId);
      wdb.pragma('foreign_keys = ON');
      // 库为准：导出不拦断链（库内允许的历史脏数据），导入必须拒绝
      exportWorkspaceSnapshot({ db: wdb, workspacePath: wsPath });
    } finally {
      wdb.close();
    }
    expect(readFileSync(join(snapshotDir(), 'issue_comments.jsonl'), 'utf8')).toContain('comment-orphan');
    const target = freshTarget('import-orphan');
    try {
      expect(() => importWorkspaceSnapshot({ db: target.db, dir: snapshotDir(), workspaceId: ws, workspacePath: target.wsDir }))
        .toThrowError(/快照不可导入：issue_comments\.jsonl 写入 issue_comment 失败/);
      const count = (table: string) => (target.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      // 整体回滚：断链表与被引用表都不留半成品（事务回滚，非部分导入）
      expect(count('issue_comment')).toBe(0);
      expect(count('issue')).toBe(0);
      expect(count('issue_dependency')).toBe(0);
    } finally {
      target.close();
    }
  });

  it('workspace_id 不一致 → SNAPSHOT_WORKSPACE_MISMATCH', () => {
    const target = freshTarget('import-other');
    try {
      expect(() => importWorkspaceSnapshot({
        db: target.db, dir: snapshotDir(), workspaceId: 'another-workspace', workspacePath: target.wsDir,
      })).toThrowError(/manifest\.workspace_id/);
    } finally {
      target.close();
    }
  });
});
