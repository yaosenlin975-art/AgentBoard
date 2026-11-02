/**
 * WS-DUP-500：同一 path 重复创建 workspace 必须 409（原实现让 SQLite UNIQUE 约束异常冒泡成 500）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { ApiError } from '../src/errors.js';
import { createWorkspace, listWorkspaces } from '../src/db/repos/workspace.js';

describe('workspace duplicate path', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-dup-'));
    const adapter = new FakeAdapter();
    const resolver = (id: string): AgentAdapter => {
      if (id === 'fake') return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    };
    const created = await createApp({ db: t.db, getAdapter: resolver, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('duplicatePathReturns409WithExistingWorkspaceDetails', async () => {
    const first = await request(app).post('/api/workspaces').send({ name: '甲', path: spaceDir });
    expect(first.status).toBe(200);

    const duplicate = await request(app).post('/api/workspaces').send({ name: '乙', path: spaceDir });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WORKSPACE_PATH_EXISTS');
    expect(duplicate.body.error.message).toContain('已存在');
    expect(duplicate.body.error.details).toMatchObject({ id: first.body.id, name: '甲', path: spaceDir });
    // 不产生第二行
    expect(listWorkspaces(t.db)).toHaveLength(1);
  });

  it('duplicatePathSameNameAlso409', async () => {
    await request(app).post('/api/workspaces').send({ name: '甲', path: spaceDir });
    const duplicate = await request(app).post('/api/workspaces').send({ name: '甲', path: spaceDir });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WORKSPACE_PATH_EXISTS');
  });

  it('differentPathStillSucceeds', async () => {
    const second = join(spaceDir, 'sub');
    rmSync(second, { recursive: true, force: true });
    require('node:fs').mkdirSync(second, { recursive: true });
    expect((await request(app).post('/api/workspaces').send({ name: '甲', path: spaceDir })).status).toBe(200);
    const created = await request(app).post('/api/workspaces').send({ name: '乙', path: second });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: '乙', path: second });
    expect(listWorkspaces(t.db)).toHaveLength(2);
  });

  it('repoThrowsApiErrorNotSqliteError', () => {
    const first = createWorkspace(t.db, { name: '甲', path: spaceDir });
    const error = (() => {
      try {
        createWorkspace(t.db, { name: '乙', path: spaceDir });
        return null;
      } catch (caught) { return caught; }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe('WORKSPACE_PATH_EXISTS');
    expect((error as ApiError).details).toMatchObject({ id: first.id, name: '甲' });
    expect(listWorkspaces(t.db)).toHaveLength(1);
  });

  it('unrelatedInsertErrorsAreNotMasked', () => {
    // 非 path 唯一约束的错误必须原样抛出（不被误判成 409）
    vi.spyOn(t.db, 'prepare').mockImplementationOnce(() => { throw new Error('boom 非约束错误'); });
    const error = (() => {
      try {
        createWorkspace(t.db, { name: '甲', path: spaceDir });
        return null;
      } catch (caught) { return caught; }
    })();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('boom');
    expect(error).not.toBeInstanceOf(ApiError);
  });
});
