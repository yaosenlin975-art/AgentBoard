/**
 * POST /api/system/pick-folder：mock node:child_process.spawn 驱动（PowerShell 原生弹窗端点）。
 * 用最小 express 装配（不建库、不起 sessionManager），只覆盖该端点行为。
 */
import { EventEmitter } from 'node:events';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { apiNotFound, createRouter, errorHandler } from '../src/api/routes.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

/** 假子进程：stdout/stderr 流 + error/close 事件（手动触发，确定性时序） */
class FakeChild {
  stdout = makeStream();
  stderr = makeStream();
  private readonly events = new EventEmitter();

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  /** 进程结束：先吐 data 再触发 close */
  finish(code: number | null, stdout = '', stderr = ''): void {
    if (stdout !== '') this.stdout.emit('data', stdout);
    if (stderr !== '') this.stderr.emit('data', stderr);
    this.events.emit('close', code);
  }

  fail(err: Error): void {
    this.events.emit('error', err);
  }
}

function makeStream(): EventEmitter & { setEncoding: (enc: string) => unknown } {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => unknown };
  stream.setEncoding = () => stream;
  return stream;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createRouter({
      db: {} as never,
      getAdapter: () => {
        throw new Error('pick-folder 测试不会用到适配器');
      },
      broadcast: () => {},
    }),
  );
  app.use('/api', apiNotFound);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

/** 发起请求（supertest 在 then 时才派发，需显式 .then 启动）；用 waitFor 等 spawn 已被调用再收尾进程 */
function sendPick(): Promise<request.Response> {
  const pending = request(app).post('/api/system/pick-folder');
  return pending.then((res) => res);
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('POST /api/system/pick-folder', () => {
  it('选中路径：spawn powershell（-STA -Command 整段脚本）→ stdout → 200 {path}', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.finish(0, 'D:\\picked\\dir');

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'D:\\picked\\dir' });

    expect(spawnMock.mock.calls[0]![0]).toBe('powershell.exe');
    const args = spawnMock.mock.calls[0]![1] as unknown[];
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      expect.stringContaining('FolderBrowserDialog'),
    ]);
    expect(String(args[4])).toContain('选择工作空间文件夹');
    expect(String(args[4])).not.toContain('"');
    expect(spawnMock.mock.calls[0]![2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });

  it('取消（无输出、exit 0）→ 200 {path:null}', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.finish(0);

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: null });
  });

  it('spawn 报错（error 事件）→ 500 PICK_FOLDER_FAILED（stderr 摘要）', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.stderr.emit('data', 'some boom');
    child.fail(new Error('spawn powershell.exe ENOENT'));

    const res = await resPromise;
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'PICK_FOLDER_FAILED',
      message: '打开文件夹选择窗口失败: some boom',
    });
  });

  it('脚本失败（exit 1 + stderr）→ 500 PICK_FOLDER_FAILED', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.finish(1, '', 'Add-Type : 加载失败\r\n第二行');

    const res = await resPromise;
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'PICK_FOLDER_FAILED',
      message: '打开文件夹选择窗口失败: Add-Type : 加载失败',
    });
  });

  it('并发第二次调用 → 409 PICK_FOLDER_BUSY；结束后守卫复位可再次发起', async () => {
    const child1 = new FakeChild();
    spawnMock.mockReturnValue(child1);
    const firstPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const busy = await request(app).post('/api/system/pick-folder');
    expect(busy.status).toBe(409);
    expect(busy.body.error).toEqual({ code: 'PICK_FOLDER_BUSY', message: '已有选择窗口打开' });
    expect(spawnMock).toHaveBeenCalledTimes(1); // 守卫生效：未再 spawn

    child1.finish(0, 'D:\\done');
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ path: 'D:\\done' });

    // 守卫已复位：再次发起不被 409
    const child2 = new FakeChild();
    spawnMock.mockReturnValue(child2);
    const againPromise = sendPick();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    child2.finish(0, '');

    const res = await againPromise;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: null });
  });
});
