import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import { ConflictError, NotFoundError } from '../../errors.js';

/** P3-A：专家团行（teams 表；落中心库，workspace_id 标归属） */
export interface TeamRow {
  id: string;
  workspace_id: string;
  name: string;
  lead_session_id: string;
  status: 'active' | 'stopped';
  max_turns_per_member: number;
  budget_tokens: number;
  created_at: number;
  updated_at: number;
}

/** P3-A：团队成员行（team_members 表；session 行在归属工作区库，本表只存 id） */
export interface TeamMemberRow {
  team_id: string;
  session_id: string;
  role: string;
  agent_name: string;
  status: 'idle' | 'working' | 'done' | 'failed';
  usage_json: string;
  turns: number;
  created_at: number;
}

export interface TeamUsage {
  turns: number;
  tokens: number;
  tool_calls: number;
}

export interface CreateTeamInput {
  workspace_id: string;
  name: string;
  lead_session_id: string;
  max_turns_per_member?: number;
  budget_tokens?: number;
}

export interface AddMemberInput {
  team_id: string;
  session_id: string;
  role: string;
  agent_name: string;
}

const EMPTY_USAGE: TeamUsage = { turns: 0, tokens: 0, tool_calls: 0 };

/** usage_json 解析：坏 JSON 按全零处理（历史行/手改行不炸读取） */
export function parseTeamUsage(json: string | null | undefined): TeamUsage {
  if (!json) return { ...EMPTY_USAGE };
  try {
    const raw = JSON.parse(json) as Partial<TeamUsage>;
    return {
      turns: Number.isFinite(raw.turns) ? Number(raw.turns) : 0,
      tokens: Number.isFinite(raw.tokens) ? Number(raw.tokens) : 0,
      tool_calls: Number.isFinite(raw.tool_calls) ? Number(raw.tool_calls) : 0,
    };
  } catch {
    return { ...EMPTY_USAGE };
  }
}

/** 团队成员累计用量（列表/护栏共用；轮次取 usage.turns，与行内 turns 同源写入） */
export function memberUsage(row: TeamMemberRow): TeamUsage {
  return { ...parseTeamUsage(row.usage_json), turns: row.turns };
}

export function teamTotalTokens(members: TeamMemberRow[]): number {
  return members.reduce((sum, row) => sum + parseTeamUsage(row.usage_json).tokens, 0);
}

export function createTeam(db: Db, input: CreateTeamInput): TeamRow {
  const existing = getTeamByLeadSession(db, input.lead_session_id);
  if (existing) throw new ConflictError('该会话已是另一个专家团的主理人（lead）');
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO teams (id, workspace_id, name, lead_session_id, status, max_turns_per_member, budget_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspace_id,
      input.name,
      input.lead_session_id,
      input.max_turns_per_member ?? 20,
      input.budget_tokens ?? 200_000,
      now,
      now,
    );
  } catch (err) {
    // 并发下唯一索引兜底（预检与插入之间的窗口）
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ConflictError('该会话已是另一个专家团的主理人（lead）');
    }
    throw err;
  }
  return getTeam(db, id)!;
}

export function getTeam(db: Db, id: string): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined) ?? null;
}

export function getTeamByLeadSession(db: Db, leadSessionId: string): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE lead_session_id = ?').get(leadSessionId) as TeamRow | undefined) ?? null;
}

export function listTeamsByWorkspace(db: Db, workspaceId: string): TeamRow[] {
  return db
    .prepare('SELECT * FROM teams WHERE workspace_id = ? ORDER BY created_at DESC, id DESC')
    .all(workspaceId) as TeamRow[];
}

export function setTeamStatus(db: Db, id: string, status: TeamRow['status']): TeamRow {
  const row = db.prepare('UPDATE teams SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  if (row.changes !== 1) throw new NotFoundError('专家团不存在');
  return getTeam(db, id)!;
}

export function listMembers(db: Db, teamId: string): TeamMemberRow[] {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at, session_id')
    .all(teamId) as TeamMemberRow[];
}

export function getMember(db: Db, teamId: string, sessionId: string): TeamMemberRow | null {
  return (
    (db.prepare('SELECT * FROM team_members WHERE team_id = ? AND session_id = ?').get(teamId, sessionId) as
      | TeamMemberRow
      | undefined) ?? null
  );
}

/** 按成员会话反查归属（turn 结束回传 lead 用；唯一索引保证至多一行） */
export function getMemberBySession(db: Db, sessionId: string): TeamMemberRow | null {
  return (db.prepare('SELECT * FROM team_members WHERE session_id = ?').get(sessionId) as TeamMemberRow | undefined) ?? null;
}

export function insertMember(db: Db, input: AddMemberInput): TeamMemberRow {
  if (getMemberBySession(db, input.session_id)) {
    throw new ConflictError('该会话已是其他专家团的成员');
  }
  try {
    db.prepare(
      `INSERT INTO team_members (team_id, session_id, role, agent_name, status, usage_json, turns, created_at)
       VALUES (?, ?, ?, ?, 'idle', '{}', 0, ?)`,
    ).run(input.team_id, input.session_id, input.role, input.agent_name, Date.now());
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ConflictError('该会话已是其他专家团的成员');
    }
    throw err;
  }
  return getMember(db, input.team_id, input.session_id)!;
}

export function updateMemberStatus(
  db: Db,
  teamId: string,
  sessionId: string,
  status: TeamMemberRow['status'],
): TeamMemberRow {
  const row = db.prepare('UPDATE team_members SET status = ? WHERE team_id = ? AND session_id = ?').run(status, teamId, sessionId);
  if (row.changes !== 1) throw new NotFoundError('团队成员不存在');
  return getMember(db, teamId, sessionId)!;
}

/** 派活计数 +1 并置于 working（护栏判定与自增在同一语句，避免并发重复派活绕过上限） */
export function recordMemberDispatch(db: Db, teamId: string, sessionId: string): TeamMemberRow {
  const row = db
    .prepare('UPDATE team_members SET turns = turns + 1, status = ? WHERE team_id = ? AND session_id = ?')
    .run('working', teamId, sessionId);
  if (row.changes !== 1) throw new NotFoundError('团队成员不存在');
  return getMember(db, teamId, sessionId)!;
}

/** 轮次结束累计用量（tokens/tool_calls 累加；轮次以 turns 列为准，这里不再重复加） */
export function addMemberUsage(db: Db, teamId: string, sessionId: string, delta: Pick<TeamUsage, 'tokens' | 'tool_calls'>): TeamMemberRow {
  const member = getMember(db, teamId, sessionId);
  if (!member) throw new NotFoundError('团队成员不存在');
  const current = parseTeamUsage(member.usage_json);
  const next: TeamUsage = {
    turns: member.turns,
    tokens: current.tokens + Math.max(0, delta.tokens),
    tool_calls: current.tool_calls + Math.max(0, delta.tool_calls),
  };
  db.prepare('UPDATE team_members SET usage_json = ? WHERE team_id = ? AND session_id = ?').run(
    JSON.stringify(next),
    teamId,
    sessionId,
  );
  return getMember(db, teamId, sessionId)!;
}

export function deleteMember(db: Db, teamId: string, sessionId: string): void {
  const row = db.prepare('DELETE FROM team_members WHERE team_id = ? AND session_id = ?').run(teamId, sessionId);
  if (row.changes !== 1) throw new NotFoundError('团队成员不存在');
}
