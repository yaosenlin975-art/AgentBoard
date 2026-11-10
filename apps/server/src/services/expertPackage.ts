/**
 * P3-C：WorkBuddy 专家包解析（本地目录；只做格式兼容，不复制 WorkBuddy 代码）。
 *
 * 兼容的包结构（根目录，或 `.codebuddy-plugin/` 子目录）：
 * - `plugin.json`：`name`（必填）、`expertType`（agent|team）、`teamInfo{leadAgent, memberAgents[]}`
 * - `agents/*.md`：YAML frontmatter（`name` 必填，另有 displayName / description / profession / maxTurns）+ 正文即 persona body
 * - `settings.json`（可选）：合法 JSON 对象；`maxTurns` / `maxTurnsPerMember` 映射团队成员轮次上限
 *
 * 口径：解析阶段**先整包校验**，任何缺字段/坏 JSON 都抛 ValidationError（路由 → 400），
 * 调用方拿到完整结果后才在一个事务里落库，保证「非法包不半写」。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ValidationError } from '../errors.js';
import { PERSONA_BODY_MAX_CHARS } from '../api/schemas.js';

/** 单个 agents/*.md 的读取上限（persona 正文上限之外再有文件级护栏） */
const AGENT_FILE_MAX_BYTES = 1024 * 1024;
/** teams.name 的列宽口径（与 createTeamSchema 的 50 字一致） */
const PACKAGE_NAME_MAX_CHARS = 50;

export interface ExpertPackageAgent {
  /** frontmatter name：包内唯一标识，teamInfo 用它引用成员 */
  name: string;
  /** 展示名（缺省回落 name）；落 team_members.agent_name 与 personas.name */
  displayName: string;
  description: string;
  /** 专业/角色（落 template 成员的 role） */
  profession: string;
  /** frontmatter maxTurns（1–200，缺省 null） */
  maxTurns: number | null;
  /** frontmatter 之后的正文，即 persona body_md */
  body_md: string;
  /** agents 目录下的文件名（错误提示定位用） */
  file: string;
}

export interface ExpertPackageTeam {
  /** teamInfo.leadAgent（必填；主理人） */
  lead: string;
  /** teamInfo.memberAgents（去重后的普通成员） */
  members: string[];
  /** settings.json 的 maxTurns / maxTurnsPerMember（缺省 null → 用 teams 默认 20） */
  maxTurnsPerMember: number | null;
}

export interface ExpertPackage {
  /** plugin.json.name（同工作区内重复导入按它判重） */
  name: string;
  expertType: 'agent' | 'team';
  /** 解析用的绝对目录（落 personas.package_path / teams.package_path） */
  dir: string;
  agents: ExpertPackageAgent[];
  /** 仅 expertType='team' 或带 teamInfo 时有值 */
  team: ExpertPackageTeam | null;
}

/** 依次尝试的候选相对路径（根目录优先，其次 WorkBuddy 的 .codebuddy-plugin 布局） */
const PLUGIN_CANDIDATES = ['plugin.json', '.codebuddy-plugin/plugin.json'];
const AGENTS_DIR_CANDIDATES = ['agents', '.codebuddy-plugin/agents'];
const SETTINGS_CANDIDATES = ['settings.json', '.codebuddy-plugin/settings.json'];

function readJsonObject(file: string, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ValidationError(`专家包 ${label} 读取失败：${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ValidationError(`专家包 ${label} 不是合法 JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`专家包 ${label} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function readOptionalJsonObject(baseDir: string, candidates: string[], label: string): { file: string; value: Record<string, unknown> } | null {
  for (const relative of candidates) {
    const file = join(baseDir, relative);
    if (existsSync(file) && statSync(file).isFile()) {
      return { file, value: readJsonObject(file, label) };
    }
  }
  return null;
}

/** 极简 frontmatter 解析：只认 `key: value` 标量行，值两端的引号会被剥掉（专家包实际形态） */
function parseFrontmatter(text: string, file: string): { meta: Record<string, string>; body: string } {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    throw new ValidationError(`专家包 ${file} 缺少 frontmatter（首行须为 ---）`);
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) {
    throw new ValidationError(`专家包 ${file} 的 frontmatter 未闭合（缺少结束 ---）`);
  }
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value !== '') meta[match[1]!] = value;
  }
  return { meta, body: lines.slice(close + 1).join('\n').trim() };
}

function parseMaxTurns(raw: string | undefined, where: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new ValidationError(`专家包 ${where} 的 maxTurns 必须是 1–200 的整数`);
  }
  return value;
}

function parseAgentFile(file: string, relative: string): ExpertPackageAgent {
  if (statSync(file).size > AGENT_FILE_MAX_BYTES) {
    throw new ValidationError(`专家包 ${relative} 超过单文件上限 ${AGENT_FILE_MAX_BYTES} 字节`);
  }
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'), relative);
  const name = meta.name;
  if (name === undefined) {
    throw new ValidationError(`专家包 ${relative} 的 frontmatter 缺少 name`);
  }
  if (body === '') {
    throw new ValidationError(`专家包 ${relative} 的正文（persona 内容）为空`);
  }
  if (body.length > PERSONA_BODY_MAX_CHARS) {
    throw new ValidationError(`专家包 ${relative} 的正文超过 ${PERSONA_BODY_MAX_CHARS} 字（persona 上限）`);
  }
  return {
    name,
    displayName: meta.displayName ?? name,
    description: meta.description ?? '',
    profession: meta.profession ?? '',
    maxTurns: parseMaxTurns(meta.maxTurns, relative),
    body_md: body,
    file: relative,
  };
}

/**
 * 解析本地专家包目录。目录/文件缺失、JSON 损坏、缺字段、引用不存在的成员一律 400。
 */
export function parseExpertPackage(dirInput: string): ExpertPackage {
  const dir = resolve(dirInput);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ValidationError(`专家包目录不存在或不是目录：${dir}`);
  }

  const plugin = readOptionalJsonObject(dir, PLUGIN_CANDIDATES, 'plugin.json');
  if (plugin === null) {
    throw new ValidationError(`专家包缺少 plugin.json（已尝试：${PLUGIN_CANDIDATES.join(' / ')}）`);
  }
  const rawName = plugin.value.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw new ValidationError('专家包 plugin.json 缺少 name');
  }
  const name = rawName.trim();
  if (name.length > PACKAGE_NAME_MAX_CHARS) {
    throw new ValidationError(`专家包名称「${name}」超过 ${PACKAGE_NAME_MAX_CHARS} 字`);
  }

  const rawType = plugin.value.expertType;
  if (rawType !== undefined && rawType !== 'agent' && rawType !== 'team') {
    throw new ValidationError('专家包 plugin.json 的 expertType 只能是 agent 或 team');
  }

  // ---- agents/*.md ----
  const agentsDir = AGENTS_DIR_CANDIDATES.map((relative) => join(dir, relative)).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isDirectory(),
  );
  if (agentsDir === undefined) {
    throw new ValidationError(`专家包缺少 agents 目录（已尝试：${AGENTS_DIR_CANDIDATES.join(' / ')}）`);
  }
  const files = readdirSync(agentsDir).filter((file) => file.endsWith('.md')).sort();
  if (files.length === 0) {
    throw new ValidationError('专家包的 agents 目录下没有 *.md 专家定义');
  }
  const agents = files.map((file) => parseAgentFile(join(agentsDir, file), `agents/${file}`));
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.name)) {
      throw new ValidationError(`专家包内专家 name 重复：${agent.name}`);
    }
    seen.add(agent.name);
  }

  // ---- settings.json（可选）----
  const settings = readOptionalJsonObject(dir, SETTINGS_CANDIDATES, 'settings.json');
  let maxTurnsPerMember: number | null = null;
  if (settings !== null) {
    const raw = settings.value.maxTurnsPerMember ?? settings.value.maxTurns;
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw) || raw < 1 || raw > 200) {
        throw new ValidationError('专家包 settings.json 的 maxTurns 必须是 1–200 的整数');
      }
      maxTurnsPerMember = raw;
    }
  }

  // ---- teamInfo ----
  const teamInfo = plugin.value.teamInfo;
  const expertType: ExpertPackage['expertType'] = rawType ?? (teamInfo === undefined ? 'agent' : 'team');
  let team: ExpertPackageTeam | null = null;
  if (teamInfo !== undefined) {
    if (typeof teamInfo !== 'object' || teamInfo === null || Array.isArray(teamInfo)) {
      throw new ValidationError('专家包 plugin.json 的 teamInfo 必须是对象');
    }
    const info = teamInfo as Record<string, unknown>;
    const lead = typeof info.leadAgent === 'string' ? info.leadAgent.trim() : '';
    if (lead === '') {
      throw new ValidationError('专家包 teamInfo 缺少 leadAgent');
    }
    const rawMembers = info.memberAgents ?? [];
    if (!Array.isArray(rawMembers) || rawMembers.some((item) => typeof item !== 'string')) {
      throw new ValidationError('专家包 teamInfo.memberAgents 必须是字符串数组');
    }
    const members = (rawMembers as string[]).map((item) => item.trim()).filter((item) => item !== '');
    for (const ref of [lead, ...members]) {
      if (!seen.has(ref)) {
        throw new ValidationError(`专家包 teamInfo 引用了不存在的专家：${ref}`);
      }
    }
    team = { lead, members: [...new Set(members)].filter((ref) => ref !== lead), maxTurnsPerMember };
  } else if (expertType === 'team') {
    throw new ValidationError('专家包 expertType=team 但缺少 teamInfo（leadAgent 必填）');
  }

  return { name, expertType, dir, agents, team };
}
