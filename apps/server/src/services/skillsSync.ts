/**
 * SKILLS-SYNC：把项目自带的 8 份配套技能复制到本机常见 agent skills 目录。
 *
 * 安全边界（不接受任意路径）：
 * - 目标目录只来自本文件的固定清单（`targetDefinitions`），接口只收 target_id；
 * - 源目录固定为仓库 `skills/`（便携包为 `app/rules/skills`），可用 `AGENTBOARD_SKILLS_SRC` 覆盖；
 * - 只写/只删 `<目标>/<8 个技能名>`，复制前逐条校验 `..` 与越界。
 *
 * 可逆：同步记录落 `<configDir>/skills-sync.json`（不往 agent 目录写额外文件），
 * 移除入口按记录/固定技能名删除。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config.js';
import { ApiError, ValidationError } from '../errors.js';

export const REQUIRED_SKILLS = [
  'using-agentboard',
  'writing-task',
  'executing-task',
  'handoff',
  'swing-dev',
  'ask-user',
  'brainstorming',
  'kb-curator',
] as const;
export type SkillName = (typeof REQUIRED_SKILLS)[number];
export type ConflictPolicy = 'overwrite' | 'skip' | 'backup';
export type TargetStatus = 'synced' | 'stale' | 'never' | 'unavailable';

export interface SkillsSyncOptions {
  /** 本机 home（测试注入临时目录；缺省 os.homedir） */
  homeDir?: string;
  /** 技能来源根（测试注入；缺省按仓库/便携包布局探测） */
  sourceRoot?: string;
  /** 同步记录目录（缺省 configDir()，测试注入临时目录） */
  stateDir?: string;
  /** 传入当前工作区路径时，额外枚举 `<工作区>/.agentboard/skills` */
  workspacePath?: string;
}

interface TargetDefinition {
  id: string;
  label: string;
  path: string;
  /** 该目标是否就是技能来源（同一物理目录时禁止复制/移除，避免自我覆盖） */
  scope: 'home' | 'workspace';
}

export interface FileManifest {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillManifest {
  name: SkillName;
  files: FileManifest[];
  hash: string;
}

export interface SkillSyncError {
  skill: string;
  file: string | null;
  message: string;
}

export interface TargetView {
  id: string;
  label: string;
  path: string;
  /** 已存在时的实体路径（junction/软链接按 target 解析）；不存在为 null */
  resolved_path: string | null;
  exists: boolean;
  /** 不存在但父目录存在 → 可创建 */
  creatable: boolean;
  /** 与其它目标指向同一物理目录时的目标 id 列表 */
  shared_with: string[];
  /** 该目标就是技能来源目录（禁止复制/移除） */
  is_source: boolean;
  status: TargetStatus;
  skills_present: number;
  synced_at: string | null;
}

export interface SyncOptions extends SkillsSyncOptions {
  targetIds: string[];
  conflict?: ConflictPolicy;
}

export interface SyncTargetResult {
  target_id: string;
  path: string;
  resolved_path: string | null;
  action: 'copied' | 'skipped' | 'nothing';
  backup_dir: string | null;
  skills: Array<{ name: string; files: number; bytes: number; status: 'copied' | 'overwritten' | 'backup_overwritten' | 'unchanged' | 'skipped' }>;
  errors: SkillSyncError[];
}

export interface SyncOutcome {
  results: SyncTargetResult[];
  summary: { targets: number; copied: number; skipped: number; errors: number; total_files: number };
}

export interface ConflictItem {
  target_id: string;
  skill: string;
  reason: string;
}

interface SyncStateEntry {
  path: string;
  resolved_path: string | null;
  synced_at: string;
  source_root: string;
  source_hash: string;
  skill_count: number;
  file_count: number;
  /** 本工具真实写入过的技能名（移除只删这些，避免误删用户既有的 junction / 手工安装） */
  written: string[];
}
interface SyncState {
  version: 1;
  targets: Record<string, SyncStateEntry>;
}

// ---- 清单与路径工具 ----

/** 递归列出目录下所有文件（相对路径用 `/`，排序稳定） */
function walkFiles(root: string, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 读取单个技能的完整清单（文件数 / 大小 / 逐文件 sha256） */
function readSkillManifest(sourceRoot: string, name: SkillName): SkillManifest {
  const dir = join(sourceRoot, name);
  const files = walkFiles(dir).map((rel) => ({
    path: rel,
    size: statSync(join(dir, rel)).size,
    sha256: sha256File(join(dir, rel)),
  }));
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}:${file.sha256}\n`);
  return { name, files, hash: digest.digest('hex') };
}

export function resolveSourceRoot(explicit?: string): string {
  const moduleRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const candidates = [
    explicit,
    process.env.AGENTBOARD_SKILLS_SRC,
    join(moduleRoot, 'skills'),
    join(moduleRoot, 'rules', 'skills'),
    join(homedir(), '.agents', 'skills'),
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'using-agentboard', 'SKILL.md'))) return resolve(candidate);
  }
  return resolve(candidates[0] ?? join(moduleRoot, 'skills'));
}

/** 读取 8 份技能清单；缺任一 SKILL.md 即报来源不完整（不静默复制半套） */
export function readSkillManifests(sourceRoot: string): SkillManifest[] {
  const missing = REQUIRED_SKILLS.filter((name) => !existsSync(join(sourceRoot, name, 'SKILL.md')));
  if (missing.length > 0) {
    throw new ApiError(409, 'SKILLS_SYNC_SOURCE_INCOMPLETE', `技能来源不完整：缺少 ${missing.join('、')} 的 SKILL.md（来源 ${sourceRoot}）`, {
      source_root: sourceRoot,
      missing,
    });
  }
  return REQUIRED_SKILLS.map((name) => readSkillManifest(sourceRoot, name));
}

function targetDefinitions(opts: SkillsSyncOptions): TargetDefinition[] {
  const home = opts.homeDir ?? homedir();
  const list: TargetDefinition[] = [
    { id: 'agents', label: '通用技能库 ~/.agents/skills', path: join(home, '.agents', 'skills'), scope: 'home' },
    { id: 'claude', label: 'Claude Code ~/.claude/skills', path: join(home, '.claude', 'skills'), scope: 'home' },
    // 本机 Cursor 实际使用 skills-cursor（实测为 junction → ~/.agents/skills），不是网传的 skills
    { id: 'cursor', label: 'Cursor ~/.cursor/skills-cursor', path: join(home, '.cursor', 'skills-cursor'), scope: 'home' },
    { id: 'trae-cn', label: 'Trae CN ~/.trae-cn/skills', path: join(home, '.trae-cn', 'skills'), scope: 'home' },
    { id: 'trae', label: 'Trae ~/.trae/skills', path: join(home, '.trae', 'skills'), scope: 'home' },
    { id: 'codex', label: 'Codex ~/.codex/skills', path: join(home, '.codex', 'skills'), scope: 'home' },
    { id: 'qoder', label: 'Qoder ~/.qoder/skills', path: join(home, '.qoder', 'skills'), scope: 'home' },
    { id: 'windsurf', label: 'Windsurf ~/.codeium/windsurf/skills', path: join(home, '.codeium', 'windsurf', 'skills'), scope: 'home' },
  ];
  if (opts.workspacePath !== undefined && opts.workspacePath !== '') {
    list.push({
      id: 'workspace',
      label: '当前工作区 .agentboard/skills',
      path: join(opts.workspacePath, '.agentboard', 'skills'),
      scope: 'workspace',
    });
  }
  return list;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 删除技能目录：目标是软链接/junction 时只删链接本身，绝不跟进去删真实目录 */
function removeSkillDir(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) {
    unlinkSync(path);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/** 目录判定必须跟随软链接/junction：本机 Cursor/Codex/Trae 的 skills 都是指向 ~/.agents/skills 的 junction */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 目标不存在时是否可创建：最近的已存在祖先是目录即可（mkdir -p 能落地） */
function hasCreatableParent(path: string): boolean {
  let current = dirname(path);
  while (current !== path) {
    if (existsSync(current)) return isDirectory(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** 目录与给定清单是否完全一致（文件集合 / 大小 / sha256） */
function matchesManifest(dir: string, manifest: SkillManifest): boolean {
  let files: string[];
  try {
    files = walkFiles(dir);
  } catch {
    return false;
  }
  if (files.length !== manifest.files.length) return false;
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const rel of files) {
    const want = expected.get(rel);
    if (want === undefined) return false;
    const full = join(dir, rel);
    if (statSync(full).size !== want.size) return false;
    if (sha256File(full) !== want.sha256) return false;
  }
  return true;
}

// ---- 同步记录 ----

function stateFilePath(stateDir: string | undefined): string {
  return join(stateDir ?? configDir(), 'skills-sync.json');
}

function readState(stateDir: string | undefined): SyncState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(stateDir), 'utf8')) as Partial<SyncState>;
    if (parsed.version === 1 && typeof parsed.targets === 'object' && parsed.targets !== null) {
      return { version: 1, targets: parsed.targets as Record<string, SyncStateEntry> };
    }
  } catch {
    // 记录缺失/损坏都按「从未同步」处理：身份与内容判定不依赖它
  }
  return { version: 1, targets: {} };
}

function writeState(stateDir: string | undefined, state: SyncState): void {
  const file = stateFilePath(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

// ---- 探测 ----

export interface ProbeOutcome {
  source: { root: string; skill_count: number; file_count: number; skills: Array<{ name: string; files: number }>; hash: string };
  targets: TargetView[];
}

export function probeTargets(opts: SkillsSyncOptions = {}): ProbeOutcome {
  const sourceRoot = resolveSourceRoot(opts.sourceRoot);
  const manifests = readSkillManifests(sourceRoot);
  const sourceReal = safeRealpath(sourceRoot);
  const state = readState(opts.stateDir);
  const definitions = targetDefinitions(opts);

  const resolvedByTarget = new Map<string, string>();
  for (const def of definitions) {
    const real = safeRealpath(def.path);
    if (real !== null) resolvedByTarget.set(def.id, real);
  }

  const targets: TargetView[] = definitions.map((def) => {
    const real = resolvedByTarget.get(def.id) ?? null;
    const shared = [...resolvedByTarget.entries()]
      .filter(([id, value]) => id !== def.id && real !== null && value === real)
      .map(([id]) => id);
    const exists = isDirectory(def.path);
    const creatable = !exists && hasCreatableParent(def.path);
    const isSource = sourceReal !== null && real === sourceReal;
    let present = 0;
    let identical = 0;
    if (exists) {
      for (const manifest of manifests) {
        const dir = join(def.path, manifest.name);
        if (!isDirectory(dir)) continue;
        present += 1;
        if (matchesManifest(dir, manifest)) identical += 1;
      }
    }
    const status: TargetStatus = !exists
      ? (creatable ? 'never' : 'unavailable')
      : identical === manifests.length
        ? 'synced'
        : present === 0
          ? 'never'
          : 'stale';
    const entry = state.targets[def.id];
    return {
      id: def.id,
      label: def.label,
      path: def.path,
      resolved_path: real,
      exists,
      creatable,
      shared_with: shared,
      is_source: isSource,
      status,
      skills_present: present,
      synced_at: entry !== undefined && entry.path === def.path ? entry.synced_at : null,
    };
  });

  const sourceHash = createHash('sha256');
  for (const manifest of manifests) sourceHash.update(`${manifest.name}:${manifest.hash}\n`);
  return {
    source: {
      root: sourceRoot,
      skill_count: manifests.length,
      file_count: manifests.reduce((sum, manifest) => sum + manifest.files.length, 0),
      skills: manifests.map((manifest) => ({ name: manifest.name, files: manifest.files.length })),
      hash: sourceHash.digest('hex'),
    },
    targets,
  };
}

// ---- 复制 ----

function requireTarget(definitions: TargetDefinition[], id: string): TargetDefinition {
  const def = definitions.find((item) => item.id === id);
  if (def === undefined) {
    throw new ValidationError(`未知目标目录：${id}（可用：${definitions.map((item) => item.id).join(' / ')}）`);
  }
  return def;
}

/** 复制单个技能目录（只落相对路径，拒绝 `..` 与绝对路径注入） */
function copySkill(sourceDir: string, destDir: string, manifest: SkillManifest): void {
  for (const file of manifest.files) {
    const normalized = file.path.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new ApiError(500, 'SKILLS_SYNC_BAD_SOURCE', `技能 ${manifest.name} 含非法相对路径：${file.path}`);
    }
    const target = join(destDir, ...normalized.split('/'));
    if (!target.startsWith(destDir + sep)) {
      throw new ApiError(500, 'SKILLS_SYNC_BAD_SOURCE', `技能 ${manifest.name} 的文件越出目标目录：${file.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(sourceDir, ...normalized.split('/'))));
  }
}

/** 复制后自检：文件数 / 大小 / sha256 全对才算成功；错误精确到技能与文件 */
function verifyCopied(destDir: string, manifest: SkillManifest): SkillSyncError[] {
  const errors: SkillSyncError[] = [];
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  let actual: string[];
  try {
    actual = walkFiles(destDir);
  } catch {
    return [{ skill: manifest.name, file: null, message: '目标目录不可读' }];
  }
  if (actual.length !== manifest.files.length) {
    errors.push({ skill: manifest.name, file: null, message: `文件数不一致：期望 ${manifest.files.length}，实际 ${actual.length}` });
  }
  for (const rel of actual) {
    const want = expected.get(rel);
    if (want === undefined) {
      errors.push({ skill: manifest.name, file: rel, message: '目标多出源中不存在的文件' });
      continue;
    }
    const full = join(destDir, rel);
    if (statSync(full).size !== want.size) {
      errors.push({ skill: manifest.name, file: rel, message: `大小不一致：期望 ${want.size}，实际 ${statSync(full).size}` });
    } else if (sha256File(full) !== want.sha256) {
      errors.push({ skill: manifest.name, file: rel, message: 'sha256 不一致' });
    }
  }
  for (const file of manifest.files) {
    if (!actual.includes(file.path)) errors.push({ skill: manifest.name, file: file.path, message: '文件未落盘' });
  }
  return errors;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 冲突预检：目标下同名技能目录存在且内容与源不一致 → 需要用户选策略 */
export function findConflicts(opts: SkillsSyncOptions, targetIds: string[]): ConflictItem[] {
  const sourceRoot = resolveSourceRoot(opts.sourceRoot);
  const manifests = readSkillManifests(sourceRoot);
  const definitions = targetDefinitions(opts);
  const conflicts: ConflictItem[] = [];
  for (const id of targetIds) {
    const def = requireTarget(definitions, id);
    if (!isDirectory(def.path)) continue;
    for (const manifest of manifests) {
      const dir = join(def.path, manifest.name);
      if (!isDirectory(dir)) continue;
      if (!matchesManifest(dir, manifest)) {
        conflicts.push({ target_id: id, skill: manifest.name, reason: '目标已存在同名技能且内容与源不一致' });
      }
    }
  }
  return conflicts;
}

export function syncSkills(opts: SyncOptions): SyncOutcome {
  const sourceRoot = resolveSourceRoot(opts.sourceRoot);
  const manifests = readSkillManifests(sourceRoot);
  const definitions = targetDefinitions(opts);
  const state = readState(opts.stateDir);
  const sourceReal = safeRealpath(sourceRoot);
  const sourceHash = manifests.map((manifest) => `${manifest.name}:${manifest.hash}`).join('\n');

  // 目标 id 先全部校验（未知 id 不产生半截写入）
  const selected = opts.targetIds.map((id) => requireTarget(definitions, id));
  if (selected.length === 0) throw new ValidationError('至少选择一个目标目录');

  if (opts.conflict === undefined) {
    const conflicts = findConflicts(opts, opts.targetIds);
    if (conflicts.length > 0) {
      throw new ApiError(409, 'SKILLS_SYNC_CONFLICT', '目标已存在同名技能：请选择覆盖 / 跳过 / 备份后覆盖', { conflicts });
    }
  }

  const results: SyncTargetResult[] = [];
  for (const def of selected) {
    const result: SyncTargetResult = {
      target_id: def.id,
      path: def.path,
      resolved_path: safeRealpath(def.path),
      action: 'nothing',
      backup_dir: null,
      skills: [],
      errors: [],
    };
    // 来源即目标：直接拒绝，绝不先删后拷（会毁掉唯一一份）
    if (sourceReal !== null && result.resolved_path === sourceReal) {
      result.errors.push({ skill: '*', file: null, message: '该目录就是技能来源目录，已跳过以免覆盖自身' });
      results.push(result);
      continue;
    }
    if (!isDirectory(def.path)) {
      try {
        mkdirSync(def.path, { recursive: true });
      } catch (error) {
        result.errors.push({ skill: '*', file: null, message: `无法创建目标目录 ${def.path}：${error instanceof Error ? error.message : String(error)}` });
        results.push(result);
        continue;
      }
      result.resolved_path = safeRealpath(def.path);
    }

    let action: SyncTargetResult['action'] = 'nothing';
    for (const manifest of manifests) {
      const sourceDir = join(sourceRoot, manifest.name);
      const destDir = join(def.path, manifest.name);
      const exists = isDirectory(destDir);
      if (exists && matchesManifest(destDir, manifest)) {
        result.skills.push({ name: manifest.name, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), status: 'unchanged' });
        continue;
      }
      let status: 'copied' | 'overwritten' | 'backup_overwritten' | 'skipped' = 'copied';
      if (exists) {
        if (opts.conflict === 'skip') {
          result.skills.push({ name: manifest.name, files: manifest.files.length, bytes: 0, status: 'skipped' });
          continue;
        }
        if (opts.conflict === 'backup') {
          const backupDir = result.backup_dir ?? join(def.path, `.agentboard-backup-${timestamp()}`);
          mkdirSync(backupDir, { recursive: true });
          const backupTarget = join(backupDir, manifest.name);
          removeSkillDir(backupTarget);
          for (const rel of walkFiles(destDir)) {
            const target = join(backupTarget, ...rel.split('/'));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, readFileSync(join(destDir, ...rel.split('/'))));
          }
          result.backup_dir = backupDir;
          status = 'backup_overwritten';
        } else {
          status = 'overwritten';
        }
        removeSkillDir(destDir);
      }
      try {
        mkdirSync(destDir, { recursive: true });
        copySkill(sourceDir, destDir, manifest);
        result.errors.push(...verifyCopied(destDir, manifest));
      } catch (error) {
        result.errors.push({ skill: manifest.name, file: null, message: error instanceof Error ? error.message : String(error) });
      }
      result.skills.push({
        name: manifest.name,
        files: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        status,
      });
      action = 'copied';
    }
    if (action === 'nothing' && result.skills.some((skill) => skill.status === 'skipped')) action = 'skipped';
    result.action = action;
    results.push(result);
  }

  // 只在整目标无错误且有真实写入时记录同步时间（有错就保持「未同步」，避免假绿）
  const syncedAt = new Date().toISOString();
  for (const result of results) {
    if (result.errors.length > 0 || result.action !== 'copied') continue;
    const previous = state.targets[result.target_id]?.written ?? [];
    const writtenNow = result.skills
      .filter((skill) => skill.status !== 'unchanged' && skill.status !== 'skipped')
      .map((skill) => skill.name);
    state.targets[result.target_id] = {
      path: result.path,
      resolved_path: result.resolved_path,
      synced_at: syncedAt,
      source_root: sourceRoot,
      source_hash: sourceHash,
      skill_count: manifests.length,
      file_count: manifests.reduce((sum, manifest) => sum + manifest.files.length, 0),
      written: [...new Set([...previous, ...writtenNow])].sort(),
    };
  }
  writeState(opts.stateDir, state);

  return {
    results,
    summary: {
      targets: results.length,
      copied: results.filter((result) => result.action === 'copied' && result.errors.length === 0).length,
      skipped: results.filter((result) => result.action === 'skipped').length,
      errors: results.reduce((sum, result) => sum + result.errors.length, 0),
      total_files: results.reduce((sum, result) => sum + result.skills.reduce((inner, skill) => inner + (skill.status === 'skipped' ? 0 : skill.files), 0), 0),
    },
  };
}

// ---- 移除 ----

export interface RemoveOutcome {
  target_id: string;
  path: string;
  removed: string[];
  errors: SkillSyncError[];
  also_cleared: string[];
  state_cleared: boolean;
}

export function removeSynced(opts: SkillsSyncOptions, targetId: string): RemoveOutcome {
  const definitions = targetDefinitions(opts);
  const def = requireTarget(definitions, targetId);
  const sourceReal = safeRealpath(resolveSourceRoot(opts.sourceRoot));
  const targetReal = safeRealpath(def.path);
  if (sourceReal !== null && targetReal === sourceReal) {
    throw new ApiError(409, 'SKILLS_SYNC_SOURCE_TARGET', '该目录就是技能来源目录，不允许移除');
  }
  const removed: string[] = [];
  const errors: SkillSyncError[] = [];
  // 只删本工具写过的技能：目标里用户已有的 junction / 手工安装不进 written，移除时保持不动
  const state = readState(opts.stateDir);
  const written = state.targets[targetId]?.written ?? [];
  for (const name of REQUIRED_SKILLS) {
    if (!written.includes(name)) continue;
    const dir = join(def.path, name);
    if (!isDirectory(dir)) continue;
    try {
      removeSkillDir(dir);
      removed.push(name);
    } catch (error) {
      errors.push({ skill: name, file: null, message: error instanceof Error ? error.message : String(error) });
    }
  }
  // 同步记录：本目标 + 与它同一物理目录的目标一起清掉（否则会留下假的「已同步」时间）
  const alsoCleared = Object.keys(state.targets).filter((id) => id !== targetId && targetReal !== null && state.targets[id]?.resolved_path === targetReal);
  const cleared = alsoCleared.length > 0 || state.targets[targetId] !== undefined;
  for (const id of [targetId, ...alsoCleared]) delete state.targets[id];
  if (cleared) writeState(opts.stateDir, state);
  return { target_id: def.id, path: def.path, removed, errors, also_cleared: alsoCleared, state_cleared: cleared };
}
