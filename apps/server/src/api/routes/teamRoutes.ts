/**
 * P3-A：专家团 REST（teams / team_members）。
 *
 * 端点：
 * - POST   /api/teams                       建团（lead 会话必须存在且属于同工作区）
 * - GET    /api/teams?workspace=<id>        按工作区列团（含成员快照，供 P3-B 侧栏）
 * - GET    /api/teams/:id                   团详情（成员 + 用量 + 成员会话元信息）
 * - POST   /api/teams/:id/members           加成员（服务端建成员会话，可绑 persona）
 * - DELETE /api/teams/:id/members/:sessionId 移除成员（保留会话历史，只解除绑定）
 * - POST   /api/teams/:id/stop              停止团队（成员统一停轮，之后拒绝派活）
 * - POST   /api/teams/:id/dispatch          向成员派活（护栏：团队状态 / 成员轮次 / token 预算）
 *
 * 所有写操作广播 WS `team_update`（ServerWsEvent；P3-B 才会并进前端 WsEvent）。
 */
import { Router } from 'express';
import type { ZodType } from 'zod';
import type { ServerWsEvent, TeamMemberSnapshot } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { EntityLocation } from '../../db/resolver.js';
import { getWorkspace } from '../../db/repos/workspace.js';
import { getPersona } from '../../db/repos/persona.js';
import { getSession, updateSession } from '../../db/repos/session.js';
import { upsertEntityLocator } from '../../db/repos/entityLocator.js';
import {
  createTeam,
  deleteMember,
  getMember,
  getTeam,
  insertMember,
  listMembers,
  listTeamsByWorkspace,
  memberUsage,
  setTeamStatus,
  type TeamMemberRow,
  type TeamRow,
} from '../../db/repos/team.js';
import { createSession, stopSession } from '../../services/sessionManager.js';
import {
  broadcastTeamUpdate,
  dispatchMemberTask,
  memberSnapshot,
} from '../../services/teamOrchestration.js';
import { addTeamMemberSchema, createTeamSchema, dispatchTeamTaskSchema } from '../schemas.js';

export interface TeamRouterDeps {
  /** 中心库：teams / team_members */
  db: Db;
  broadcast: (event: ServerWsEvent) => void;
  /** 工作区 → 实际库（成员会话行所在库） */
  dbForWorkspace: (workspaceId: string) => Db;
  locateSessionRouted: (sessionId: string) => EntityLocation<NonNullable<ReturnType<typeof getSession>>> | null;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

interface TeamDetail extends TeamRow {
  members: Array<TeamMemberSnapshot & { session: NonNullable<ReturnType<typeof getSession>> | null }>;
}

export function createTeamRouter(deps: TeamRouterDeps): Router {
  const { db, dbForWorkspace, locateSessionRouted } = deps;
  const router = Router();

  function requireTeam(teamId: string): TeamRow {
    const team = getTeam(db, teamId);
    if (!team) throw new NotFoundError('专家团不存在');
    return team;
  }

  function requireWorkspace(workspaceId: string): void {
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作区不存在');
  }

  /** 成员快照 + 成员会话元信息（会话可能已被删除：session 为 null，不 404） */
  function memberWithSession(row: TeamMemberRow): TeamDetail['members'][number] {
    return { ...memberSnapshot(row), session: locateSessionRouted(row.session_id)?.value ?? null };
  }

  function teamDetail(team: TeamRow): TeamDetail {
    return { ...team, members: listMembers(db, team.id).map(memberWithSession) };
  }

  router.post('/teams', (req, res) => {
    const body = parseBody(createTeamSchema, req.body);
    requireWorkspace(body.workspace_id);
    const lead = locateSessionRouted(body.lead_session_id);
    if (!lead) throw new ValidationError('lead_session_id 指向的会话不存在');
    if (lead.value.workspace_id !== body.workspace_id) {
      throw new ValidationError('lead 会话不属于该工作区');
    }
    const team = createTeam(db, body);
    broadcastTeamUpdate(db, team.id, 'created');
    res.status(201).json(teamDetail(team));
  });

  router.get('/teams', (req, res) => {
    const raw = req.query.workspace;
    if (typeof raw !== 'string' || raw === '') throw new ValidationError('缺少 workspace 查询参数');
    requireWorkspace(raw);
    res.json(listTeamsByWorkspace(db, raw).map(teamDetail));
  });

  router.get('/teams/:id', (req, res) => {
    res.json(teamDetail(requireTeam(req.params.id!)));
  });

  router.post('/teams/:id/members', async (req, res) => {
    const team = requireTeam(req.params.id!);
    if (team.status !== 'active') throw new ConflictError('专家团已停止，不能再添加成员');
    const body = parseBody(addTeamMemberSchema, req.body);
    if (body.persona_id !== undefined && getPersona(db, body.persona_id) === null) {
      throw new ValidationError('persona_id 指向的 persona 不存在');
    }
    // 成员会话走同一条建会话链路（自由会话、不绑 issue），再由本路由补 persona
    const session = await createSession({
      cli: body.cli,
      model: body.model ?? null,
      workspace_id: team.workspace_id,
      prompt: null,
    });
    upsertEntityLocator(db, 'session', session.id, team.workspace_id);
    if (body.persona_id !== undefined) {
      updateSession(dbForWorkspace(team.workspace_id), session.id, { persona_id: body.persona_id });
    }
    insertMember(db, {
      team_id: team.id,
      session_id: session.id,
      role: body.role,
      agent_name: body.agent_name,
    });
    broadcastTeamUpdate(db, team.id, 'member_added');
    res.status(201).json(teamDetail(getTeam(db, team.id)!));
  });

  router.delete('/teams/:id/members/:sessionId', async (req, res) => {
    const team = requireTeam(req.params.id!);
    const sessionId = req.params.sessionId!;
    if (!getMember(db, team.id, sessionId)) throw new NotFoundError('团队成员不存在');
    // 先停轮再解除绑定：停止失败（会话已删/适配器已退出）不阻止解绑
    try {
      await stopSession(sessionId);
    } catch {
      /* 会话不可用：直接解绑 */
    }
    deleteMember(db, team.id, sessionId);
    broadcastTeamUpdate(db, team.id, 'member_removed');
    res.json(teamDetail(getTeam(db, team.id)!));
  });

  router.post('/teams/:id/stop', async (req, res) => {
    const team = requireTeam(req.params.id!);
    setTeamStatus(db, team.id, 'stopped');
    for (const row of listMembers(db, team.id)) {
      try {
        await stopSession(row.session_id);
      } catch {
        /* 成员会话不可用：跳过，团队状态已置 stopped */
      }
    }
    broadcastTeamUpdate(db, team.id, 'stopped');
    res.json(teamDetail(getTeam(db, team.id)!));
  });

  router.post('/teams/:id/dispatch', async (req, res) => {
    const team = requireTeam(req.params.id!);
    const body = parseBody(dispatchTeamTaskSchema, req.body);
    const member = getMember(db, team.id, body.session_id);
    if (!member) throw new ValidationError('session_id 不是该团队的成员');
    const result = await dispatchMemberTask(db, team, member, body.prompt);
    res.status(202).json({
      ...result,
      usage: memberUsage(getMember(db, team.id, body.session_id)!),
    });
  });

  return router;
}
