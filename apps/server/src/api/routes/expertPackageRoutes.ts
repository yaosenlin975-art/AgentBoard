/**
 * P3-C：专家包导入 REST（WorkBuddy 包格式 → personas + 团队模板）。
 *
 * 端点：`POST /api/expert-packages/import`，体 `{ workspace_id, path }`：
 * - 解析本地目录（plugin.json / agents/*.md / teamInfo / settings.json，见 services/expertPackage.ts）
 * - 先整包校验再落库：每个专家 → 一行 `personas`（`source='import'`、`package_path=目录`）；
 *   有 teamInfo 时 → `teams` 一行模板（`source='import'`、`status='stopped'`）+ `team_members`
 *   指向导入的 persona（模板无真实会话，`import:` 前缀占位，`session` 恒为 null）
 * - 事务：任一写入失败整包回滚；同名团队模板或同目录重复导入 → 409，不产生重复行
 * - 成功广播 WS `team_update`（reason=`imported`）
 */
import { Router } from 'express';
import type { ZodType } from 'zod';
import type { TeamDetail, TeamMemberDetail } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { getWorkspace } from '../../db/repos/workspace.js';
import { createPersona, findImportedPersonaByPackagePath } from '../../db/repos/persona.js';
import {
  createImportedTeamTemplate,
  findImportedTeamByName,
  listMembers,
} from '../../db/repos/team.js';
import { broadcastTeamUpdate, memberSnapshot } from '../../services/teamOrchestration.js';
import { parseExpertPackage, type ExpertPackageAgent } from '../../services/expertPackage.js';
import { importExpertPackageSchema } from '../schemas.js';

export interface ExpertPackageRouterDeps {
  /** 中心库：personas（全局）+ teams / team_members */
  db: Db;
}

/** team_members.agent_name / role 的列宽口径（与 P3-A 的 zod 上限一致） */
const TEAM_FIELD_MAX_CHARS = 30;
/** personas.name 上限（与 createPersonaSchema 一致） */
const PERSONA_NAME_MAX_CHARS = 100;

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

/** persona 名（展示名优先，回落 frontmatter name；超 100 字整包拒绝） */
function personaName(agent: ExpertPackageAgent): string {
  const name = agent.displayName.trim() === '' ? agent.name : agent.displayName.trim();
  if (name.length > PERSONA_NAME_MAX_CHARS) {
    throw new ValidationError(`专家「${agent.name}」的显示名超过 ${PERSONA_NAME_MAX_CHARS} 字（persona 名称上限）`);
  }
  return name;
}

/** 模板成员的显示名：展示名 ≤30 用展示名，否则回落 frontmatter name（超 30 直接拒绝，不截断 @派活 标识） */
function memberAgentName(agent: ExpertPackageAgent): string {
  const display = agent.displayName.trim() === '' ? agent.name : agent.displayName.trim();
  const name = display.length <= TEAM_FIELD_MAX_CHARS ? display : agent.name;
  if (name.length > TEAM_FIELD_MAX_CHARS) {
    throw new ValidationError(`专家「${agent.name}」的名称超过 ${TEAM_FIELD_MAX_CHARS} 字（团队 @派活 上限）`);
  }
  return name;
}

/** 模板成员角色：frontmatter profession 优先，缺省主理人 / 成员 */
function memberRole(agent: ExpertPackageAgent, isLead: boolean): string {
  const role = agent.profession.trim() === '' ? (isLead ? '主理人' : '成员') : agent.profession.trim().slice(0, TEAM_FIELD_MAX_CHARS);
  return role;
}

export function createExpertPackageRouter(deps: ExpertPackageRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.post('/expert-packages/import', (req, res) => {
    const body = parseBody(importExpertPackageSchema, req.body);
    if (!getWorkspace(db, body.workspace_id)) throw new NotFoundError('工作空间不存在');

    // 解析在事务外完成：非法包直接 400，一行都不写
    const pkg = parseExpertPackage(body.path);

    const result = db.transaction(() => {
      const importedTeam = findImportedTeamByName(db, body.workspace_id, pkg.name);
      if (importedTeam) {
        throw new ConflictError(`同名专家包「${pkg.name}」已导入过（团队 ${importedTeam.id}），不重复导入`);
      }
      const importedPersona = findImportedPersonaByPackagePath(db, pkg.dir);
      if (importedPersona) {
        throw new ConflictError(`该目录的专家包已导入过（persona「${importedPersona.name}」），不重复导入`);
      }

      const personas = pkg.agents.map((agent) =>
        createPersona(db, {
          name: personaName(agent),
          description: agent.description,
          body_md: agent.body_md,
          source: 'import',
          package_path: pkg.dir,
        }),
      );
      const personaByName = new Map(pkg.agents.map((agent, index) => [agent.name, personas[index]!]));
      const agentByName = new Map(pkg.agents.map((agent) => [agent.name, agent]));

      if (pkg.team === null) {
        return { personas: personas.map((row) => ({ id: row.id, name: row.name })), team: null };
      }

      const templateMembers = [pkg.team.lead, ...pkg.team.members].map((ref, index) => {
        const agent = agentByName.get(ref)!;
        return {
          role: memberRole(agent, index === 0),
          agent_name: memberAgentName(agent),
          persona_id: personaByName.get(ref)!.id,
        };
      });
      const teamRow = createImportedTeamTemplate(db, {
        workspace_id: body.workspace_id,
        name: pkg.name,
        package_path: pkg.dir,
        ...(pkg.team.maxTurnsPerMember === null ? {} : { max_turns_per_member: pkg.team.maxTurnsPerMember }),
        members: templateMembers,
      });
      const team: TeamDetail = {
        id: teamRow.id,
        workspace_id: teamRow.workspace_id,
        name: teamRow.name,
        lead_session_id: teamRow.lead_session_id,
        status: teamRow.status,
        max_turns_per_member: teamRow.max_turns_per_member,
        budget_tokens: teamRow.budget_tokens,
        created_at: teamRow.created_at,
        updated_at: teamRow.updated_at,
        members: listMembers(db, teamRow.id).map<TeamMemberDetail>((row) => ({ ...memberSnapshot(row), session: null })),
      };
      return { personas: personas.map((row) => ({ id: row.id, name: row.name })), team };
    })();

    if (result.team !== null) broadcastTeamUpdate(db, result.team.id, 'imported');
    res.status(201).json({
      package: { name: pkg.name, path: pkg.dir, type: pkg.expertType },
      personas: result.personas,
      team: result.team,
    });
  });

  return router;
}
