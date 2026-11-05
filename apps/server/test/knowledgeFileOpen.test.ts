/**
 * PROV-B：知识页「打开本地文件」端点。
 *
 * 覆盖面按卡面验收口径逐条对应：
 *  · 路径越界四类拒绝：`..` / 绝对路径外溢（含 UNC）/ symlink 逃逸 / 非 file 协议
 *  · 正常路径放行（工作区内的仓库相对路径）
 *  · 打开失败降级：OPEN_FAILED + attempts，且响应永不回传文件内容、不提供目录遍历
 *
 * 铁律：单测**不真起**编辑器 / 资源管理器（spawn 全注入 fake）；真实 symlink 只在
 * 本机允许建链时跑（Windows 无开发者模式会 EPERM → 该例跳过，判定逻辑由注入的
 * realpath 假视图覆盖）。
 */
import express, { type Express } from 'express';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeRouter } from '../src/api/knowledgeRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { ApiError } from '../src/errors.js';
import {
  FileOpenErrorCode,
  findExecutableOnPath,
  openLocalFile,
  resolveLocalFile,
  type FileSystemDeps,
  type OpenProcessDeps,
  type ResolvedLocalFile,
  type SpawnedChild,
} from '../src/services/fileOpener.js';
import { createTestDb, type TestDb } from './helpers.js';

const SECRET = 'FILE_BODY_MUST_NEVER_LEAVE_THE_SERVER';
/** 默认 fs 视图就是真 fs（临时目录里的实体文件） */
const REAL_FS: FileSystemDeps = { statSync: (p) => statSync(p), realpathSync: (p) => realpathSync(p), platform: process.platform };

/** 本机能否建符号链接（Windows 未开开发者模式会 EPERM） */
function probeSymlinkCapability(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'ab-symcap-'));
  try {
    writeFileSync(path.join(probe, 'target.txt'), 'x');
    symlinkSync(path.join(probe, 'target.txt'), path.join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const SYMLINK_CAPABLE = probeSymlinkCapability();

/** 抛错断言：必须是带 code/status 的 ApiError（结构化 JSON 的前提） */
function expectApiError(run: () => unknown, code: string, status: number): ApiError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望抛出 ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.code).toBe(code);
  expect(err.status).toBe(status);
  return err;
}

/** 一个「仓库」形态的工作区根 + 根外的目录（越界用例的靶子） */
function makeFixture(): { root: string; outside: string; relFile: string; relDir: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-open-root-')));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-open-out-')));
  mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  writeFileSync(path.join(root, 'apps/web/src/App.tsx'), `${SECRET}\n`);
  writeFileSync(path.join(outside, 'elsewhere.ts'), `${SECRET}\n`);
  return { root, outside, relFile: 'apps/web/src/App.tsx', relDir: 'apps/web' };
}

type Fixture = ReturnType<typeof makeFixture>;

/** 在临时 bin 目录里造一个「PATH 上找得到」的可执行文件占位，并登记以便回收 */
function fakeBin(name: string, sink: string[]): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-open-bin-')));
  writeFileSync(path.join(dir, name), '@echo off\r\n');
  sink.push(dir);
  return dir;
}

/* ============================ fake 进程视图 ============================ */

function fakeChild(command: string, failed: boolean): SpawnedChild {
  return {
    once(event: 'spawn' | 'error', listener: (() => void) | ((error: unknown) => void)): void {
      // 延后派发：调用方要先挂完 spawn 与 error 两个监听
      setTimeout(() => {
        if (event === 'spawn' && !failed) (listener as () => void)();
        if (event === 'error' && failed) (listener as (e: unknown) => void)(new Error(`fake：起不来 ${command}`));
      }, 0);
    },
    unref(): void {},
  };
}

function makeProc(options: { pathDirs?: string[]; platform?: NodeJS.Platform; failWhen?: (command: string) => boolean } = {}): {
  deps: OpenProcessDeps;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps: OpenProcessDeps = {
    spawn: (command, args) => {
      calls.push({ command, args: [...args] });
      return fakeChild(command, options.failWhen?.(command) === true);
    },
    // pathDirs 为空 → PATH 探测恒失败（降级路径的用例就走这条路）
    env: { PATH: (options.pathDirs ?? []).join(path.delimiter), PATHEXT: '.EXE;.CMD;.BAT;.COM' },
    platform: options.platform ?? 'win32',
    existsSync: (p) => existsSync(p),
    timeoutMs: 30,
  };
  return { deps, calls };
}

function resolvedOf(fx: Fixture): ResolvedLocalFile {
  return { root: fx.root, absolutePath: path.resolve(fx.root, fx.relFile), relativePath: fx.relFile, line: undefined };
}

/* ============================ ① 路径安全边界 ============================ */

describe('PROV-B ①：resolveLocalFile 的路径越界拒绝（四类）', () => {
  let t: TestDb; let fx: Fixture; let ws: string; let bins: string[] = [];

  const resolve = (input: { workspace_id: string; path: string; line?: number }, deps: FileSystemDeps = REAL_FS) =>
    resolveLocalFile(t.db, input, deps);

  beforeEach(() => {
    t = createTestDb();
    fx = makeFixture();
    bins = [];
    ws = createWorkspace(t.db, { name: '仓库', path: fx.root }).id;
  });
  afterEach(() => {
    t.cleanup();
    bins.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.outside, { recursive: true, force: true });
  });

  it('放行：工作区内的仓库相对路径（返回绝对路径 + 归一化的相对路径）', () => {
    const file = resolve({ workspace_id: ws, path: fx.relFile, line: 12 });
    expect(file.absolutePath).toBe(path.resolve(fx.root, 'apps', 'web', 'src', 'App.tsx'));
    expect(file.relativePath).toBe(fx.relFile);
    expect(file.root).toBe(fx.root);
    expect(file.line).toBe(12);
  });

  it('放行：file:// 本机形态（剥掉协议后同样要落根内）', () => {
    const local = resolve({ workspace_id: ws, path: fx.relFile });
    const asUrl = resolve({ workspace_id: ws, path: `file://${local.absolutePath.split('\\').join('/')}` });
    expect(asUrl.absolutePath).toBe(local.absolutePath);
    expect(asUrl.relativePath).toBe(local.relativePath);
  });

  it('拒绝 ①：`..` 段——任何 fs 调用之前就拒', () => {
    for (const probe of ['../outside.ts', 'apps/../../outside.ts', path.join('apps', '..', '..', 'x.ts')]) {
      const err = expectApiError(() => resolve({ workspace_id: ws, path: probe }), FileOpenErrorCode.escape, 400);
      expect(err.message).toContain('..');
    }
  });

  it('拒绝 ②：绝对路径外溢（根外绝对路径 + UNC 共享）', () => {
    const outside = path.join(fx.outside, 'elsewhere.ts');
    expect(path.isAbsolute(outside)).toBe(true);
    expectApiError(() => resolve({ workspace_id: ws, path: outside }), FileOpenErrorCode.escape, 400);
    expectApiError(() => resolve({ workspace_id: ws, path: '\\\\fileserver\\share\\x.ts' }), FileOpenErrorCode.escape, 400);
  });

  it('拒绝 ③：symlink 逃逸（realpath 后重新比根）——注入假视图，任何机器都能跑', () => {
    const link = path.join(fx.root, 'apps/web/src/Link.tsx');
    const outsideFile = path.join(fx.outside, 'elsewhere.ts');
    writeFileSync(link, 'stub');
    const deps: FileSystemDeps = {
      statSync: REAL_FS.statSync,
      platform: REAL_FS.platform,
      // 假装 link 指向工作区外那份真实文件（stat 通过、realpath 出界）
      realpathSync: (p) => (path.resolve(p) === path.resolve(link) ? outsideFile : realpathSync(p)),
    };
    const err = expectApiError(() => resolve({ workspace_id: ws, path: 'apps/web/src/Link.tsx' }, deps), FileOpenErrorCode.escape, 400);
    expect(err.message).toContain('symlink');
  });

  it.runIf(SYMLINK_CAPABLE)('拒绝 ③b：真符号链接指向根外（能建链的机器上跑实体路径）', () => {
    const link = path.join(fx.root, 'apps/web/src/Real.tsx');
    try {
      symlinkSync(path.join(fx.outside, 'elsewhere.ts'), link);
    } catch (error) {
      // 探测通过但这次建链仍失败（权限抖动）：跳过断言，不当成失败
      console.warn('[knowledge-file-open] 跳过真实 symlink 用例：', (error as Error).message);
      return;
    }
    expectApiError(() => resolve({ workspace_id: ws, path: 'apps/web/src/Real.tsx' }), FileOpenErrorCode.escape, 400);
  });

  it('拒绝 ④：非 file 协议（http / cmd / ftp / mailto / 带主机名的 file://）', () => {
    for (const probe of ['http://evil.example/a.ts', 'https://evil.example/a.ts', 'cmd:/c calc', 'ftp://h/a', 'mailto:x@y.z']) {
      const err = expectApiError(() => resolve({ workspace_id: ws, path: probe }), FileOpenErrorCode.scheme, 400);
      expect(err.message).toContain('file');
    }
    expectApiError(() => resolve({ workspace_id: ws, path: 'file://evil-host/share/a.ts' }), FileOpenErrorCode.scheme, 400);
  });

  it('拒绝：目录不是文件（挡掉「打开一个目录」式遍历，且不回吐目录条目）', () => {
    const err = expectApiError(() => resolve({ workspace_id: ws, path: fx.relDir }), FileOpenErrorCode.notAFile, 400);
    expect(err.message).not.toContain('App.tsx');
  });

  it('拒绝：文件不存在 / 空路径 / 非法 line / 命令行元字符', () => {
    expectApiError(() => resolve({ workspace_id: ws, path: 'apps/web/src/Gone.tsx' }), FileOpenErrorCode.notFound, 404);
    expectApiError(() => resolve({ workspace_id: ws, path: '   ' }), FileOpenErrorCode.invalidPath, 400);
    expectApiError(() => resolve({ workspace_id: ws, path: fx.relFile, line: 0 }), 'VALIDATION_ERROR', 400);
    // 路径最终作为裸参数进 cmd.exe：含 & ; % 引号反引号的一律拒（前端降级为复制路径）
    for (const probe of ['apps/a&b.ts', 'apps/a;b.ts', 'apps/a"b.ts', 'apps/a%PATH%.ts', 'apps/a`b.ts', 'apps/a|b.ts']) {
      expectApiError(() => resolve({ workspace_id: ws, path: probe }), FileOpenErrorCode.invalidPath, 400);
    }
  });

  it('拒绝：workspace 不存在 / 登记的根目录已不在磁盘上', () => {
    expectApiError(() => resolve({ workspace_id: '00000000-0000-4000-8000-000000000000', path: fx.relFile }), FileOpenErrorCode.workspaceNotFound, 404);
    const ghost = createWorkspace(t.db, { name: '幽灵', path: path.join(fx.outside, 'not-here') }).id;
    expectApiError(() => resolve({ workspace_id: ghost, path: fx.relFile }), FileOpenErrorCode.workspacePathMissing, 404);
  });
});

/* ============================ ② PATH 探测与打开顺序 ============================ */

describe('PROV-B ②：打开顺序 code -g → explorer /select, → 系统默认', () => {
  let fx: Fixture; let bins: string[] = [];
  beforeEach(() => { fx = makeFixture(); bins = []; });
  afterEach(() => {
    bins.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.outside, { recursive: true, force: true });
  });

  it('PATH 上有 code → 用 VS Code，并带 -g <绝对路径>:<行号>', async () => {
    const bin = fakeBin('code.exe', bins);
    const { deps, calls } = makeProc({ pathDirs: [bin] });
    const result = await openLocalFile({ ...resolvedOf(fx), line: 125 }, deps);
    expect(result.opened_with).toBe('vscode');
    expect(calls).toHaveLength(1);
    expect(path.basename(calls[0]!.command).toLowerCase()).toBe('code.exe');
    expect(calls[0]!.args).toEqual(['-g', `${path.resolve(fx.root, fx.relFile)}:125`]);
  });

  it('没有行号时 -g 只带路径；.cmd 形态走 cmd.exe 包装（Node 直投 .cmd 会 EINVAL）', async () => {
    const bin = fakeBin('code.cmd', bins);
    const { deps, calls } = makeProc({ pathDirs: [bin] });
    expect(await openLocalFile(resolvedOf(fx), deps)).toMatchObject({ opened_with: 'vscode' });
    expect(calls[0]!.command).toBe('cmd.exe');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['/d', '/c', path.join(bin, 'code.cmd')]);
    expect(calls[0]!.args.slice(3)).toEqual(['-g', path.resolve(fx.root, fx.relFile)]);
  });

  it('同一目录里多形态时优先真 .exe（能直接 spawn，不必绕 cmd.exe）', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-open-bin-')));
    bins.push(dir);
    writeFileSync(path.join(dir, 'code.cmd'), '@echo off\r\n');
    writeFileSync(path.join(dir, 'code.exe'), '');
    const { deps } = makeProc({ pathDirs: [dir] });
    expect(findExecutableOnPath('code', deps)).toBe(path.join(dir, 'code.exe'));
  });

  it('PATH 目录按顺序取先命中的（第一个目录里的 code.cmd 就够用）', () => {
    const first = fakeBin('code.cmd', bins);
    const second = fakeBin('code.exe', bins);
    const { deps } = makeProc({ pathDirs: [first, second] });
    expect(findExecutableOnPath('code', deps)).toBe(path.join(first, 'code.cmd'));
  });

  it('PATH 上没有 code → 退到 explorer /select,<path>', async () => {
    const bin = fakeBin('explorer.exe', bins);
    const { deps, calls } = makeProc({ pathDirs: [bin] });
    expect(await openLocalFile(resolvedOf(fx), deps)).toMatchObject({ opened_with: 'explorer' });
    expect(calls[0]!.args).toEqual([`/select,${path.resolve(fx.root, fx.relFile)}`]);
  });

  it('非 Windows：explorer 记 skipped，系统默认用 xdg-open / open', async () => {
    const linuxBins = [...bins];
    const linux = makeProc({ pathDirs: [fakeBin('xdg-open', linuxBins)], platform: 'linux' });
    const result = await openLocalFile(resolvedOf(fx), linux.deps);
    expect(result.opened_with).toBe('system_default');
    expect(linux.calls[0]!.args).toEqual([path.resolve(fx.root, fx.relFile)]);
    expect(result.attempts.find((a) => a.method === 'explorer')).toMatchObject({ status: 'skipped' });

    const macBins = [...bins];
    const mac = makeProc({ pathDirs: [fakeBin('open', macBins)], platform: 'darwin' });
    expect(await openLocalFile(resolvedOf(fx), mac.deps)).toMatchObject({ opened_with: 'system_default' });
  });

  it('三种方式全失败 → OPEN_FAILED（结构化 details.attempts，供前端降级）', async () => {
    const { deps } = makeProc({ pathDirs: [fakeBin('code.exe', bins), fakeBin('explorer.exe', bins)], failWhen: () => true });
    let caught: unknown = null;
    try {
      await openLocalFile(resolvedOf(fx), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(500);
    expect(err.code).toBe(FileOpenErrorCode.openFailed);
    expect(err.message).toContain('已降级为复制路径');
    const attempts = (err.details as { attempts: Array<{ method: string; status: string }> }).attempts;
    expect(attempts.map((a) => a.method)).toEqual(['vscode', 'explorer', 'system_default']);
    expect(attempts.every((a) => a.status === 'failed' || a.status === 'skipped')).toBe(true);
  });

  it('code 起不来 → 继续 explorer（逐个失败不短路整条链）', async () => {
    const { deps, calls } = makeProc({
      pathDirs: [fakeBin('code.exe', bins), fakeBin('explorer.exe', bins)],
      failWhen: (command) => command.toLowerCase().endsWith('code.exe'),
    });
    expect(await openLocalFile(resolvedOf(fx), deps)).toMatchObject({ opened_with: 'explorer' });
    expect(calls.map((c) => path.basename(c.command).toLowerCase())).toEqual(['code.exe', 'explorer.exe']);
  });

  it('PATH 空 + Linux：全 skipped，OPEN_FAILED 且一次 spawn 都不发', async () => {
    const { deps, calls } = makeProc({ pathDirs: [], platform: 'linux' });
    const err = await openLocalFile(resolvedOf(fx), deps).then(() => null, (error: unknown) => error as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe(FileOpenErrorCode.openFailed);
    expect(calls).toHaveLength(0);
    expect((err?.details as { attempts: Array<{ status: string }> }).attempts.map((a) => a.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('PATH 空 + Windows：系统默认仍能起（cmd.exe 由系统解析），因此不会误报 OPEN_FAILED', async () => {
    const { deps, calls } = makeProc({ pathDirs: [] });
    expect(await openLocalFile(resolvedOf(fx), deps)).toMatchObject({ opened_with: 'system_default' });
    expect(calls).toEqual([{ command: 'cmd.exe', args: ['/d', '/c', 'start', '', path.resolve(fx.root, fx.relFile)] }]);
  });
});

/* ============================ ③ REST 契约 ============================ */

describe('PROV-B ③：POST /api/knowledge/files/open 的响应契约', () => {
  let t: TestDb; let fx: Fixture; let ws: string; let app: Express;
  let calls: Array<{ command: string; args: string[] }> = [];
  let bins: string[] = [];

  function mount(options: { pathDirs?: string[]; failWhen?: (command: string) => boolean } = {}): void {
    const proc = makeProc(options);
    calls = proc.calls;
    app = express();
    app.use(express.json());
    app.use('/api/knowledge', createKnowledgeRouter(t.db, { openProcess: proc.deps }));
    app.use(errorHandler);
  }

  beforeEach(() => {
    t = createTestDb();
    fx = makeFixture();
    bins = [];
    ws = createWorkspace(t.db, { name: '仓库', path: fx.root }).id;
    mount({ pathDirs: [fakeBin('code.exe', bins)] });
  });
  afterEach(() => {
    t.cleanup();
    bins.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.outside, { recursive: true, force: true });
  });

  it('放行：200 + opened_with + 工作区相对路径；响应里没有文件内容', async () => {
    const res = await request(app).post('/api/knowledge/files/open').send({ workspace_id: ws, path: fx.relFile, line: 12 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, opened_with: 'vscode', path: fx.relFile, line: 12 });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(calls[0]!.args).toEqual(['-g', `${path.resolve(fx.root, 'apps/web/src/App.tsx')}:12`]);
  });

  it('越界与非法都是结构化 JSON 错误（status + code + 中文 message），且不带内容', async () => {
    const probes: Array<[Record<string, unknown>, number, string]> = [
      [{ workspace_id: ws, path: '../outside.ts' }, 400, FileOpenErrorCode.escape],
      [{ workspace_id: ws, path: path.join(fx.outside, 'elsewhere.ts') }, 400, FileOpenErrorCode.escape],
      [{ workspace_id: ws, path: 'http://evil.example/a.ts' }, 400, FileOpenErrorCode.scheme],
      [{ workspace_id: ws, path: fx.relDir }, 400, FileOpenErrorCode.notAFile],
      [{ workspace_id: ws, path: 'apps/web/src/Gone.tsx' }, 404, FileOpenErrorCode.notFound],
      [{ workspace_id: 'nope', path: fx.relFile }, 404, FileOpenErrorCode.workspaceNotFound],
      [{ workspace_id: ws, path: fx.relFile, root: fx.outside }, 400, 'VALIDATION_ERROR'],
      [{ workspace_id: ws, path: fx.relFile, line: 0 }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of probes) {
      const res = await request(app).post('/api/knowledge/files/open').send(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(typeof res.body.error.message).toBe('string');
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(JSON.stringify(res.body)).not.toContain('App.tsx');
    }
  });

  it('打开全失败 → 500 OPEN_FAILED + attempts；前端拿到的仍是结构化错误', async () => {
    mount({ pathDirs: [fakeBin('explorer.exe', bins)], failWhen: () => true });
    const res = await request(app).post('/api/knowledge/files/open').send({ workspace_id: ws, path: fx.relFile });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(FileOpenErrorCode.openFailed);
    expect(res.body.error.message).toContain('复制路径');
    expect(res.body.error.details.attempts.map((a: { method: string }) => a.method)).toEqual(['vscode', 'explorer', 'system_default']);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('不提供目录遍历：路径给到工作区里的目录也被拒，且不回吐条目名', async () => {
    const res = await request(app).post('/api/knowledge/files/open').send({ workspace_id: ws, path: 'apps' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(FileOpenErrorCode.notAFile);
    expect(JSON.stringify(res.body)).not.toContain('App.tsx');
  });
});
