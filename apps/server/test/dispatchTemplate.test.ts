/**
 * ARCH-05：派发 prompt 模板外置——解析/校验单测 + 派发链路接线验证。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { DISPATCH_PROMPT_TEMPLATE } from '../src/services/dispatch.js';
import {
  DEFAULT_DISPATCH_PROMPT_TEMPLATE,
  DISPATCH_PROMPT_ENV,
  DISPATCH_PROMPT_FILE_NAME,
  REQUIRED_PLACEHOLDERS,
  loadDispatchPromptTemplate,
} from '../src/services/dispatchTemplate.js';
import { initSessionManager, resetSessionManager } from '../src/services/sessionManager.js';
import { createRouter, errorHandler } from '../src/api/routes.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-dispatch-prompt-'));
  tempDirs.push(dir);
  return dir;
}

/** 覆盖用模板：自定义文案 + 全部必需占位符 */
function customTemplate(label: string): string {
  return `自定义派发文案 ${label}
任务 ID：{{issue_id}}
标题：{{title}}
描述：
{{description}}
工作目录：{{workspace_path}}（workspace {{workspace_id}}）`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadDispatchPromptTemplate', () => {
  it('数据目录无模板文件：用内置默认值，正文与 DISPATCH_PROMPT_TEMPLATE 逐字一致', () => {
    const dir = tempDir();
    const loaded = loadDispatchPromptTemplate({ env: {}, dataDir: dir });

    expect(loaded.source).toBe('default');
    expect(loaded.path).toBe(join(dir, DISPATCH_PROMPT_FILE_NAME));
    expect(loaded.template).toBe(DEFAULT_DISPATCH_PROMPT_TEMPLATE);
    expect(loaded.template).toBe(DISPATCH_PROMPT_TEMPLATE);
    for (const placeholder of REQUIRED_PLACEHOLDERS) {
      expect(DEFAULT_DISPATCH_PROMPT_TEMPLATE).toContain(placeholder);
    }
  });

  it('数据目录文件覆盖生效', () => {
    const dir = tempDir();
    const path = join(dir, DISPATCH_PROMPT_FILE_NAME);
    writeFileSync(path, customTemplate('FILE'), 'utf8');

    const loaded = loadDispatchPromptTemplate({ env: {}, dataDir: dir });

    expect(loaded.source).toBe('file');
    expect(loaded.path).toBe(path);
    expect(loaded.template).toBe(customTemplate('FILE'));
  });

  it('文件缺必需占位符：抛错并点名缺失占位符与文件路径（不回退默认值）', () => {
    const dir = tempDir();
    const path = join(dir, DISPATCH_PROMPT_FILE_NAME);
    const broken = customTemplate('BROKEN').replaceAll('{{issue_id}}', '任务');
    writeFileSync(path, broken, 'utf8');

    let message = '';
    try {
      loadDispatchPromptTemplate({ env: {}, dataDir: dir });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('{{issue_id}}');
    expect(message).toContain(path);
  });

  it('env 覆盖优先于数据目录默认文件', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, DISPATCH_PROMPT_FILE_NAME), customTemplate('DATA'), 'utf8');
    const envDir = tempDir();
    const envPath = join(envDir, 'custom-prompt.md');
    writeFileSync(envPath, customTemplate('ENV'), 'utf8');

    const loaded = loadDispatchPromptTemplate({ env: { [DISPATCH_PROMPT_ENV]: envPath }, dataDir });

    expect(loaded.source).toBe('file');
    expect(loaded.path).toBe(envPath);
    expect(loaded.template).toContain('自定义派发文案 ENV');
    expect(loaded.template).not.toContain('自定义派发文案 DATA');
  });

  it('env 指向的文件不存在：回落内置默认并给出 warning（不抛错）', () => {
    const dataDir = tempDir();
    const missing = join(tempDir(), 'nope.md');

    const loaded = loadDispatchPromptTemplate({ env: { [DISPATCH_PROMPT_ENV]: missing }, dataDir });

    expect(loaded.source).toBe('default');
    expect(loaded.template).toBe(DEFAULT_DISPATCH_PROMPT_TEMPLATE);
    expect(loaded.path).toBe(missing);
    expect(loaded.warning).toContain(missing);
  });

  it('文件带 UTF-8 BOM：剥掉 BOM 后正常解析', () => {
    const dir = tempDir();
    const path = join(dir, DISPATCH_PROMPT_FILE_NAME);
    writeFileSync(path, `\uFEFF${customTemplate('BOM')}`, 'utf8');

    const loaded = loadDispatchPromptTemplate({ env: {}, dataDir: dir });

    expect(loaded.source).toBe('file');
    expect(loaded.template.charCodeAt(0)).not.toBe(0xfeff);
    expect(loaded.template).toBe(customTemplate('BOM'));
  });
});

describe('派发链路使用注入的启动期模板', () => {
  let t: TestDb;
  let wsId: string;
  let adapter: FakeAdapter;

  beforeEach(() => {
    t = createTestDb();
    wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\demo' }).id;
    adapter = new FakeAdapter();
    initSessionManager(t.db, (id: string) => {
      if (id === 'fake') return adapter as AgentAdapter;
      throw new Error(`未知适配器 id: ${id}`);
    }, { maxConcurrentTurns: 3 });
  });

  afterEach(() => {
    resetSessionManager();
    t.cleanup();
  });

  it('POST /api/sessions 派发时使用 createRouter 注入的模板，知识块仍是精确后缀', async () => {
    const template = customTemplate('WIRED');
    const app = express();
    app.use(express.json());
    // 仅覆盖派发链路，附件存储未装配（本用例不涉及图片）
    const routerDeps = {
      db: t.db,
      getAdapter: (id: string) => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      broadcast: () => {},
      dispatchPromptTemplate: template,
    } as unknown as Parameters<typeof createRouter>[0];
    app.use('/api', createRouter(routerDeps));
    app.use(errorHandler);

    const issue = createIssue(t.db, { workspace_id: wsId, title: '实现登录', description: '支持邮箱登录' });
    const res = await request(app).post('/api/sessions').send({ issue_id: issue.id, cli: 'fake' });
    await settle();

    expect(res.status).toBe(200);
    expect(adapter.calls).toHaveLength(1);
    const expected = template
      .replaceAll('{{issue_id}}', issue.id)
      .replaceAll('{{title}}', '实现登录')
      .replaceAll('{{description}}', '支持邮箱登录')
      .replaceAll('{{workspace_path}}', 'D:\\ws\\demo')
      .replaceAll('{{workspace_id}}', wsId);
    // 无知识命中/无评论 → 无附加段，prompt 即渲染后的模板
    expect(adapter.calls[0]!.prompt).toBe(expected);
  });
});
