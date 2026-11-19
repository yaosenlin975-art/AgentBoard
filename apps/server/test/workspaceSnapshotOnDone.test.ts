import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createTestDb, issuePayload, type TestDb } from './helpers.js';
import { validateWorkspaceSnapshot } from '../src/services/workspaceSnapshot.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('done 自动导出看板快照', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let repo: string;
  let workspaceId: string;

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-done-snapshot-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Fixture User']);
    git(repo, ['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, ['add', '--', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: '快照空间', path: repo }).id;
  });

  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('done 将看板快照与业务文件一起提交，且不含运行库与附件', async () => {
    const created = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title: '同步评论与依赖' }));
    const issueId = created.body.id as string;
    await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    await request(app).post(`/api/issues/${issueId}/comments`).send({ workspace_id: workspaceId, author: 'fake', content: '收尾评论' });
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');

    const res = await request(app).post(`/api/issues/${issueId}/done`).send({
      workspace_id: workspaceId,
      agent_id: 'fake',
      notes: 'done',
      scope_paths: ['feature.txt'],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(res.body.git_commit.status).toBe('committed');
    const snapshotDir = join(repo, '.agentboard', 'snapshot');
    const checked = validateWorkspaceSnapshot(snapshotDir);
    expect(checked.rows.get('issue')?.length).toBe(1);
    expect(readFileSync(join(snapshotDir, 'issue_comments.jsonl'), 'utf8')).toContain('收尾评论');
    const files = git(repo, ['show', '--name-only', '--pretty=format:', '-1']).split('\n').filter(Boolean);
    expect(files).toContain('feature.txt');
    expect(files).toContain('.agentboard/snapshot/manifest.json');
    expect(files.some(file => file.endsWith('.db') || file.includes('/attachments/'))).toBe(false);
    expect(existsSync(join(repo, '.agentboard', 'agentboard.db'))).toBe(false);
  });

  it('快照导出失败不阻断 done，且结果明确为未提交', async () => {
    const created = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title: '快照失败可观测' }));
    const issueId = created.body.id as string;
    await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    writeFileSync(join(repo, 'failure.txt'), 'failure\n');
    // 让快照的临时落盘父目录无法创建：.agentboard 已被同名文件占位
    writeFileSync(join(repo, '.agentboard'), 'blocked');

    const res = await request(app).post(`/api/issues/${issueId}/done`).send({
      workspace_id: workspaceId,
      agent_id: 'fake',
      notes: '',
      scope_paths: ['failure.txt'],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(res.body.git_commit).toMatchObject({ status: 'not-committed', reason: 'COMMIT_FAILED' });
    expect(res.body.git_commit.note).toContain('看板快照导出失败');
  });
});
