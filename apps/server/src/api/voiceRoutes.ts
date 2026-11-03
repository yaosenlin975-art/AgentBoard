/**
 * VOICE-1：语音模型管理端点（设计 §服务端-模型管理）。
 *
 * | GET    | `/api/voice/models`                | 候选清单 + 本地状态 |
 * | POST   | `/api/voice/models/:id/download`    | 202 起下载；同 id 幂等复用进行中任务 |
 * | GET    | `/api/voice/models/:id/progress`    | SSE 进度；`?poll=1` 走一次性 JSON |
 * | DELETE | `/api/voice/models/:id`             | 删除已下载模型；下载中 409 |
 *
 * 绝不自动下载：本 router 只响应显式请求，启动/首次使用都不拉模型。
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/connection.js';
import {
  deleteVoiceModel,
  getVoiceModel,
  listVoiceModels,
  startVoiceModelDownload,
  voiceModelProgress,
  type VoiceModelDeps,
} from '../services/voiceModels.js';

export interface VoiceRouterOptions extends VoiceModelDeps {
  /** SSE 轮询间隔（ms），缺省 250 */
  sseIntervalMs?: number;
}

const TERMINAL = new Set(['downloaded', 'failed']);

export function createVoiceRouter(db: Db, options: VoiceRouterOptions = {}): Router {
  const router = Router();
  const sseIntervalMs = options.sseIntervalMs ?? 250;

  router.get('/models', (_req, res) => {
    res.json({ models: listVoiceModels(db, options) });
  });

  router.get('/models/:id', (req, res) => {
    res.json(getVoiceModel(db, String(req.params.id), options));
  });

  router.post('/models/:id/download', (req, res) => {
    const accepted = startVoiceModelDownload(db, String(req.params.id), options);
    // 已下载完成时也返回 202 语义上更稳：state 里明确写 downloaded，前端据此直接刷新
    res.status(202).json(accepted);
  });

  router.get('/models/:id/progress', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    // 先做一次存在性/未知模型校验（未知 → 404，与其它端点一致）
    voiceModelProgress(db, id, options);
    if (String(req.query.poll ?? '') === '1') {
      res.json(voiceModelProgress(db, id, options));
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    let closed = false;
    const send = (): void => {
      if (closed) return;
      const snapshot = voiceModelProgress(db, id, options);
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (TERMINAL.has(snapshot.state)) {
        closed = true;
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(send, sseIntervalMs);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    send();
  });

  router.delete('/models/:id', (req, res) => {
    res.json(deleteVoiceModel(db, String(req.params.id), options));
  });

  return router;
}
