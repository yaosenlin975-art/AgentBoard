/**
 * P3-A：专家团编排（lead 每轮注入名册、@成员 派活、成员结果回传 lead、成本护栏）。
 *
 * 数据在中心库（teams / team_members），成员会话行在归属工作区库；本服务只做编排，
 * 起轮复用 sessionManager 的 `createSession` / `sendToSession`，**不新增子代理通道**
 * （v1 禁用 CLI 内生子代理，成员消息一律经 lead 中转，见设计 §7.1 / §7.3）。
 *
 * 接线：`index.ts` 装配 `initTeamOrchestration` 并把 `handleSessionTurnEnded` 挂到
 * sessionManager 的轮次结束监听上；REST 在 `api/routes/teamRoutes.ts`。
 */
import type { Db } from '../db/connection.js';
import type { ServerWsEvent, TeamMemberSnapshot, TeamUpdateEvent } from '@agentboard/shared';
import { ConflictError } from '../errors.js';
import {
  addMemberUsage,
  getMember,
  getMemberBySession,
  getTeam,
  getTeamByLeadSession,
  listMembers,
  memberUsage,
  parseTeamUsage,
  recordMemberDispatch,
  teamTotalTokens,
  updateMemberStatus,
  type TeamMemberRow,
  type TeamRow,
} from '../db/repos/team.js';
import { listTurnsBySession } from '../db/repos/sessionTurn.js';
import { sendToSession } from './sessionManager.js';

interface OrchestrationDeps {
  /** 中心库：teams / team_members */
  center: Db;
  /** 工作区 → 实际库（成员会话行与 session_turn 所在库） */
  getDbForWorkspace: (workspaceId: string) => Db;
  broadcast: (event: ServerWsEvent) => void;
}

let deps: OrchestrationDeps | null = null;

export function initTeamOrchestration(input: OrchestrationDeps): void {
  deps = input;
}

function requireDeps(): OrchestrationDeps {
  if (deps === null) throw new Error('专家团编排未装配（initTeamOrchestration 未调用）');
  return deps;
}

/** 成员快照（REST 详情与 WS team_update 同形） */
export function memberSnapshot(row: TeamMemberRow): TeamMemberSnapshot {
  return {
    session_id: row.session_id,
    role: row.role,
    agent_name: row.agent_name,
    status: row.status,
    usage: memberUsage(row),
  };
}

export function teamSnapshot(center: Db, team: TeamRow): TeamUpdateEvent {
  return {
    type: 'team_update',
    team_id: team.id,
    status: team.status,
    members: listMembers(center, team.id).map(memberSnapshot),
    reason: 'snapshot',
  };
}

/** 广播团队快照（找不到团就静默跳过：删除/清理竞态不炸调用方） */
export function broadcastTeamUpdate(center: Db, teamId: string, reason: string): void {
  const team = getTeam(center, teamId);
  if (!team) return;
  const event: TeamUpdateEvent = { ...teamSnapshot(center, team), reason };
  requireDeps().broadcast(event);
}

/**
 * lead 每轮注入的名册块。非 lead 会话返回 null（调用方不加前缀）。
 * 文案保持简短：成员状态与用量是 lead 编排唯一需要的上下文。
 */
export function buildRosterBlock(center: Db, leadSessionId: string): string | null {
  const team = getTeamByLeadSession(center, leadSessionId);
  if (!team) return null;
  const members = listMembers(center, team.id);
  if (members.length === 0) {
    return [
      `## 专家团「${team.name}」（team: ${team.id}）`,
      '当前没有成员；先在团队视图添加成员，再用 `@成员名: 任务` 派活。',
    ].join('\n');
  }
  return [
    `## 专家团「${team.name}」（team: ${team.id}，状态 ${team.status === 'active' ? '进行中' : '已停止'}）`,
    ...members.map((row) => {
      const usage = memberUsage(row);
      return `- ${row.role}「${row.agent_name}」｜${row.status}｜轮次 ${row.turns}/${team.max_turns_per_member}｜tokens ${usage.tokens}（session: ${row.session_id}）`;
    }),
    '派活：单独一行写 `@成员名: 任务内容`；服务端会为该成员会话起一轮，结果自动回传给你。成员不直接对话，一切经你中转。',
  ].join('\n');
}

/** 从 lead 文本里提取派活指令：`@成员名: 任务`（行内首个匹配，任务取到行尾） */
export function extractDispatchDirectives(text: string): Array<{ agent_name: string; prompt: string }> {
  const directives: Array<{ agent_name: string; prompt: string }> = [];
  const pattern = /^\s*@([^\s:：@]+)\s*[:：]\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const agentName = match[1]!.trim();
    const prompt = match[2]!.trim();
    if (agentName !== '' && prompt !== '') directives.push({ agent_name: agentName, prompt });
  }
  return directives;
}

export interface DispatchResult {
  team_id: string;
  member: TeamMemberSnapshot;
  queued: boolean;
}

/**
 * 向成员派活：护栏（团队状态 / 成员轮次 / 团队 token 预算）→ 计数 +1 → 起轮 → 广播。
 * 护栏不通过抛 409（ConflictError），调用方（REST/lead 指令）据此回报。
 */
export async function dispatchMemberTask(center: Db, team: TeamRow, member: TeamMemberRow, prompt: string): Promise<DispatchResult> {
  if (team.status !== 'active') {
    throw new ConflictError('专家团已停止，不能再派活（重新创建团队或恢复后再试）');
  }
  if (member.turns >= team.max_turns_per_member) {
    throw new ConflictError(
      `成员「${member.agent_name}」轮次已达上限 ${team.max_turns_per_member}（成本护栏），拒绝新派活`,
    );
  }
  const members = listMembers(center, team.id);
  const used = teamTotalTokens(members);
  if (used >= team.budget_tokens) {
    throw new ConflictError(`团队 token 预算已用尽（${used}/${team.budget_tokens}），拒绝新派活`);
  }
  const counted = recordMemberDispatch(center, team.id, member.session_id);
  const result = await sendToSession(member.session_id, prompt);
  broadcastTeamUpdate(center, team.id, 'dispatch');
  return { team_id: team.id, member: memberSnapshot(counted), queued: result.queued };
}

/**
 * 处理 lead 消息里的 `@成员: 任务` 指令（后台执行，不阻塞 lead 的发送响应）。
 * 单个成员失败（护栏/会话不可用）不影响其它成员，也不回滚 lead 消息。
 */
export function dispatchLeadDirectives(center: Db, leadSessionId: string, text: string): void {
  const team = getTeamByLeadSession(center, leadSessionId);
  if (!team || team.status !== 'active') return;
  const directives = extractDispatchDirectives(text);
  if (directives.length === 0) return;
  const members = listMembers(center, team.id);
  for (const directive of directives) {
    const member = members.find((row) => row.agent_name === directive.agent_name);
    if (!member) continue;
    void dispatchMemberTask(center, team, member, directive.prompt).catch(() => {
      // 护栏/会话中断：状态已由广播/成员行体现，lead 下一次名册注入能看到；不静默重试
      broadcastTeamUpdate(center, team.id, 'guardrail');
    });
  }
}

/** 一轮结束的用量：取该会话最后一轮的 usage_json 与计划步骤数（tool_calls） */
function turnUsageOf(db: Db, sessionId: string): { tokens: number; tool_calls: number } {
  const turns = listTurnsBySession(db, sessionId);
  const last = turns[turns.length - 1];
  if (!last) return { tokens: 0, tool_calls: 0 };
  const usage = last.usage_json;
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  return { tokens: Number.isFinite(tokens) ? tokens : 0, tool_calls: last.plan_json?.length ?? 0 };
}

/**
 * 成员轮次结束：累计用量 → 成员置 done/failed → 广播 → 把结果回传 lead（lead 若仍在跑则排队）。
 * 非团队成员会话直接忽略。
 */
export async function handleSessionTurnEnded(info: { session_id: string; ok: boolean; assistant_text: string }): Promise<void> {
  if (!deps) return;
  const { center, getDbForWorkspace } = deps;
  const member = getMemberBySession(center, info.session_id);
  if (!member) return;
  const team = getTeam(center, member.team_id);
  if (!team) return;
  const usage = turnUsageOf(getDbForWorkspace(team.workspace_id), info.session_id);
  addMemberUsage(center, team.id, member.session_id, usage);
  updateMemberStatus(center, team.id, member.session_id, info.ok ? 'done' : 'failed');
  broadcastTeamUpdate(center, team.id, info.ok ? 'member_done' : 'member_failed');
  if (team.status !== 'active') return;
  const body = info.assistant_text.trim();
  const relay = [
    `## 成员回报（${member.role}「${member.agent_name}」）`,
    `状态：${info.ok ? '已完成' : '失败'}`,
    body === '' ? '（本轮无正文输出）' : body,
  ].join('\n');
  try {
    await sendToSession(team.lead_session_id, relay);
  } catch {
    // lead 会话已删除/不可用：成员结果已落成员会话消息，不因回传失败回滚状态
  }
}

/** 团队累计用量（REST 详情回显；直接由成员行聚合，不重复读库） */
export function summarizeMembers(members: TeamMemberRow[]): { members: TeamMemberSnapshot[]; tokens: number } {
  return {
    members: members.map(memberSnapshot),
    tokens: members.reduce((sum, row) => sum + parseTeamUsage(row.usage_json).tokens, 0),
  };
}

/** 成员行存在性断言（路由用；避免把「团存在、成员不存在」当 404 团处理） */
export function requireMember(center: Db, teamId: string, sessionId: string): TeamMemberRow {
  const member = getMember(center, teamId, sessionId);
  if (!member) throw new ConflictError('该会话不是这个专家团的成员');
  return member;
}
