/**
 * CHUNK-CACHE：静态资源缓存头与 `/assets/*` 404 语义。
 *
 * 背景：旧页面引用旧 hash chunk，而 dist 已重建 → 浏览器报
 * `Failed to fetch dynamically imported module: …/assets/pixiGraph-*.js`。
 * 服务端侧要做三件事：带 hash 的产物可长缓存、HTML 必须 no-cache、
 * `/assets/*` 未命中必须真 404（text/plain），不能被 SPA fallback 兜成 HTML 200。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { createTestDb } from './helpers.js';

let db: ReturnType<typeof createTestDb>;
let dist: string;
let app: Awaited<ReturnType<typeof createApp>>['app'];

const hashedJs = 'pixiGraph-a1b2c3d4.js';
const unhashedJs = 'runtime.js';

const get = (path: string) => request(app).get(path);

beforeEach(async () => {
  db = createTestDb();
  dist = mkdtempSync(join(tmpdir(), 'kb-chunk-cache-'));
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>app</body></html>');
  writeFileSync(join(dist, 'assets', hashedJs), 'export const x = 1;\n');
  writeFileSync(join(dist, 'assets', unhashedJs), 'export const y = 2;\n');
  writeFileSync(join(dist, 'favicon-1a2b3c4d.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const created = await createApp({ db: db.db, getAdapter: () => { throw new Error('unused'); }, webDist: dist, refreshClisOnBoot: false });
  app = created.app;
});

afterEach(() => {
  db.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

describe('静态缓存头（CHUNK-CACHE）', () => {
  it('带 hash 的 /assets chunk：immutable 长缓存 + ETag', async () => {
    const res = await get(`/assets/${hashedJs}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers.etag).toBeTruthy();
  });

  it('index.html：no-cache（允许 304），不带 immutable', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });

  it('/assets 未命中：真 404 + text/plain，且不被 SPA fallback 兜成 HTML 200', async () => {
    const res = await get('/assets/does-not-exist.js');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.text;
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<!doctype');
    expect(body).toContain('Asset not found');
  });

  it('带 hash 的根级静态资源（图标）也长缓存；未带 hash 的用 no-cache', async () => {
    const hashed = await get('/favicon-1a2b3c4d.svg');
    expect(hashed.status).toBe(200);
    expect(hashed.headers['cache-control']).toContain('immutable');
    const unhashed = await get(`/assets/${unhashedJs}`);
    expect(unhashed.status).toBe(200);
    // /assets 整目录视为构建产物（Vite 下都在 assets/ 且带 hash），未命中已单独 404
    expect(unhashed.headers['cache-control']).toContain('immutable');
  });

  it('非 /api 的普通 GET 仍回 index.html（no-cache）', async () => {
    const res = await get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
