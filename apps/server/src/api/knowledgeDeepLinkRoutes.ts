/**
 * BORROW-3.2：知识深链路由（/k/:id 与 /k/:id/:slug）。
 * id 为权威、slug 只做可读性（任意值忽略，不符不报错）。
 * 服务端预检只做存在性三态：uuid 形状直查库（404 不存在 / 410 已删除 / 其余回 SPA 壳）；
 * 非 uuid 引用（短 id 前缀等）一律回壳，由前端 resolve 解析（支持 both + 当前工作区）。
 * 工作区页的权限 403 由前端 detail API 承担——深链无工作区上下文，服务端预判会误伤本工作区
 * 合法深链；既有 403 守卫不回显标题（knowledgeResolve.test 覆盖）。
 */
import { join } from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import type { Db } from '../db/connection.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createKnowledgeDeepLinkRoutes(db: Db, webDist: string): Router {
  const router = express.Router();
  const sendShell = (res: Response): void => {
    // 与 SPA fallback 同口径：HTML 一律 no-cache
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(webDist, 'index.html'), (err) => {
      if (err) res.status(404).type('text/plain').send('index.html missing');
    });
  };
  const handle = (req: Request, res: Response): void => {
    const raw = req.params.id;
    // express 5 路径参数类型含 string[]（通配残留）；本路由只有具名参数，非 string 一律按不存在处理
    const id = typeof raw === 'string' ? raw : '';
    if (UUID_RE.test(id)) {
      const row = db.prepare('SELECT status FROM knowledge_page WHERE id=?').get(id) as { status: string } | undefined;
      if (row === undefined) {
        res.status(404).type('text/plain').send('知识页不存在');
        return;
      }
      if (row.status === 'deleted') {
        res.status(410).type('text/plain').send('知识页已删除（可查看历史版本）');
        return;
      }
    }
    sendShell(res);
  };
  router.get('/k/:id', handle);
  router.get('/k/:id/:slug', handle);
  return router;
}
