/**
 * personas 域 REST（P1-C）。
 * 覆盖：GET/POST /api/personas、PATCH/DELETE /api/personas/:id（builtin 只读：409）、
 * GET /api/cli-capabilities?adapter=<id>（probeCliCapabilities 能力探测；探测结果在 adapters 侧
 * 按命令名缓存 60s，本路由不重复缓存）。
 * persona 定义落中心库（全局资源，不随工作区库下沉；会话侧 persona_id 引用此处行）。
 */
import { Router } from 'express';
import type { ZodType } from 'zod';
import {
  CODEBUDDY_CMD,
  CODEX_CMD,
  DSH_CMD,
  OPENCODE_CMD,
  probeCliCapabilities,
} from '@agentboard/adapters';
import type { CliCapabilities } from '@agentboard/adapters';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { createPersona, deletePersona, getPersona, listPersonas, updatePersona } from '../../db/repos/persona.js';
import { createPersonaSchema, patchPersonaSchema } from '../schemas.js';

export interface PersonaRouterDeps {
  /** 中心库：personas 全局表 */
  db: Db;
}

/** zod 校验：失败抛 ValidationError（错误中间件 → 400） */
/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

/** adapter id → 本机 CLI 命令名（与各适配器 runTurn 同源常量；探测即 spawn `<命令> --help`） */
const ADAPTER_COMMANDS: Record<string, string> = {
  codebuddy: CODEBUDDY_CMD,
  codex: CODEX_CMD,
  opencode: OPENCODE_CMD,
  dsh: DSH_CMD,
};

export function createPersonaRouter(deps: PersonaRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  // ---- personas ----
  // 列表按 created_at 倒序（新建在前）；含 body_md（编辑器直接回填）
  router.get('/personas', (_req, res) => {
    res.json(listPersonas(db));
  });

  router.post('/personas', (req, res) => {
    const body = parseBody(createPersonaSchema, req.body);
    // id 用 randomUUID；路由只建 user 来源 persona（builtin/import 由包/导入流程落库）
    res.json(createPersona(db, { name: body.name, description: body.description, body_md: body.body_md, source: 'user' }));
  });

  router.patch('/personas/:id', (req, res) => {
    const existing = getPersona(db, req.params.id!);
    if (!existing) throw new NotFoundError('persona 不存在');
    // P1-C：builtin 包内置定义不可经 REST 改写（防篡改；删除同口径）
    if (existing.source === 'builtin') {
      throw new ConflictError('builtin persona 不可修改');
    }
    const body = parseBody(patchPersonaSchema, req.body);
    res.json(updatePersona(db, req.params.id!, body));
  });

  router.delete('/personas/:id', (req, res) => {
    const existing = getPersona(db, req.params.id!);
    if (!existing) throw new NotFoundError('persona 不存在');
    if (existing.source === 'builtin') {
      throw new ConflictError('builtin persona 不可删除');
    }
    deletePersona(db, req.params.id!);
    res.status(204).end();
  });

  // ---- CLI 能力探测（P1-C：persona/tool flag 注入前端提示用）----
  // probeCliCapabilities 在 adapters 侧按命令名缓存 60s；未安装/超时 → 全 false，不报错
  router.get('/cli-capabilities', async (req, res) => {
    const adapterId = req.query.adapter;
    if (typeof adapterId !== 'string' || adapterId === '') {
      throw new ValidationError('缺少 adapter 查询参数');
    }
    const command = ADAPTER_COMMANDS[adapterId];
    if (command === undefined) {
      throw new ValidationError(`未知 adapter: ${adapterId}（可用：${Object.keys(ADAPTER_COMMANDS).join(' / ')}）`);
    }
    const caps: CliCapabilities = await probeCliCapabilities(command);
    res.json({ adapter: adapterId, command, ...caps });
  });

  return router;
}
