/**
 * ACC-INCOGNITO：无痕打开授权地址的 REST 入口。
 * 挂载点见 api/routes.ts（`/api` 前缀），完整路径：POST /api/browser/open-incognito。
 */
import { Router } from 'express';
import {
  defaultBrowserOpenerDeps,
  openAuthorizationUrlIncognito,
  type BrowserOpenerDeps,
} from '../services/browserOpener.js';

export function createBrowserRouter(deps: BrowserOpenerDeps = defaultBrowserOpenerDeps): Router {
  const router = Router();

  router.post('/browser/open-incognito', async (req, res) => {
    const result = await openAuthorizationUrlIncognito(req.body?.url, deps);
    res.json(result);
  });

  return router;
}
