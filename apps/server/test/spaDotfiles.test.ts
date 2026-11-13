/**
 * D8 发布阻断：含点开头路径段（`.tmp` / `.local` / 隐藏目录）下的 SPA 首页 404。
 *
 * 根因：express/send 的 `dotfiles` 默认 `'ignore'`，`res.sendFile` 的目标路径里只要有一段以点开头，
 * 就被判为隐藏文件 → NotFoundError。便携包/安装版解压到 `.tmp\...` 时首页因此空白。
 * 修复口径：只给两处 SPA 入口 `sendFile(index.html)` 显式允许点文件，
 * 静态资源目录（express.static）保持默认，不放宽目录级隐藏文件访问。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb } from './helpers.js';

const SHELL = '<!doctype html><html><body>SPA-SHELL-D8</body></html>';

let db: ReturnType<typeof createTestDb>;
let root: string;
let dist: string;
let app: Awaited<ReturnType<typeof createApp>>['app'];

const get = (path: string) => request(app).get(path);

beforeEach(async () => {
  db = createTestDb();
  // 关键：webDist 的祖先目录含点开头段（模拟便携包解压到 .tmp / .local 等隐藏目录）
  root = mkdtempSync(join(tmpdir(), 'kb-d8-'));
  dist = join(root, '.hidden-env', '.tmp', 'AgentBoard', 'app', 'apps', 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), SHELL);
  writeFileSync(join(dist, 'assets', 'index-a1b2c3d4.js'), 'export const x = 1;\n');
  writeFileSync(join(dist, '.secret-note.txt'), 'do-not-serve');
  const created = await createApp({
    db: db.db,
    getAdapter: () => {
      throw new Error('unused');
    },
    webDist: dist,
    refreshClisOnBoot: false,
  });
  app = created.app;
});

afterEach(() => {
  db.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('D8 点开头路径下的 SPA 托管', () => {
  it('前置自检：webDist 确实落在含点开头的路径段下', () => {
    expect(dist).toContain(`${join('.hidden-env', '.tmp')}`);
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
  });

  it('GET / → 200 且返回 index.html 内容（dotfiles 不再吃掉 SPA 入口）', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SPA-SHELL-D8');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('深路由 /board/xyz → 200 且返回 index.html 内容（SPA fallback 同样放行）', async () => {
    const res = await get('/board/xyz');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SPA-SHELL-D8');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('静态资源仍可正常取（未被 dotfiles 放宽影响）', async () => {
    const res = await get('/assets/index-a1b2c3d4.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('export const x = 1');
  });

  it('不存在的普通资源 → 404 且不泄露 index.html/目录', async () => {
    const res = await get('/nonexistent.js');
    // 未命中静态资源后由 SPA fallback 兜回 index.html 是既有语义（前端路由需要），
    // 但 /assets/* 必须真 404，且 dotfiles 放宽不得让隐藏文件可下载。
    expect([200, 404]).toContain(res.status);

    const assetMiss = await get('/assets/nonexistent.js');
    expect(assetMiss.status).toBe(404);
    expect(assetMiss.text).toContain('Asset not found');
    expect(assetMiss.text).not.toContain('SPA-SHELL-D8');
  });

  it('隐藏文件不可经静态托管下载（未做目录级 dotfiles 放宽）', async () => {
    const res = await get('/.secret-note.txt');
    // express.static 默认 dotfiles:'ignore' → 不返回文件内容
    expect(res.text).not.toContain('do-not-serve');
  });
});
