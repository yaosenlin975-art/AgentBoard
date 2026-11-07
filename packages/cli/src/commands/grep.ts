/**
 * [KB-GREP] `kb grep <pattern>`：本地按文件内容检索仓库（纯 Node，无额外运行时依赖）。
 *
 * 设计：knowledge:8922b413-d33f-4d9b-b16f-da7393d92506（D1–D10 已拍板）。
 * 退出码（本地命令例外，见 index.ts 的 EXIT_CODE_HELP）：0 命中 / 1 未命中 / 2 出错。
 *
 * 过滤语义（组合关系写死在这里，测试按此断言）：
 *  1. 遍历时先剪枝：符号链接（不跟随）→ 隐藏项（无 --hidden）→ 内置忽略目录（仅 --no-default-ignore 放开）→ --ignore。
 *  2. 文件先过 --glob（给了就必须至少命中一个），再过 --ignore。
 *  3. glob/ignore 模式作用于「相对搜索根的 POSIX 路径」；模式不含 `/` 时只比对 basename。
 *  4. --ignore 同时剪枝同名目录（如 `--ignore *.md` 只影响文件，`--ignore tmp` 剪掉 tmp 目录）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CommanderError } from 'commander';
import type { Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import { CliExitError } from '../errors.js';
import type { Ctx } from '../io.js';
import { matchCurrentWorkspace } from '../workspace.js';

/** 内置忽略目录集（D5：不读 .gitignore） */
export const DEFAULT_IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'dist-package', '.logs', '.agentboard', 'coverage', '.next', 'target',
] as const;

const NUL_PROBE_BYTES = 8192;
/** 单行输出文本上限：超长行只截断展示，匹配仍按整行做 */
const MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_MATCHES = 1000;
const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  /** 1 基的起止列（UTF-16 code unit，与 RegExp.exec().index 一致） */
  match: { start: number; end: number };
  context: { before: string[]; after: string[] };
}

export interface GrepResult {
  pattern: string;
  root: string;
  matches: GrepMatch[];
  stats: { files_scanned: number; files_skipped: number; matches: number };
  truncated: { hit: boolean; reason: 'max_matches' | 'timeout' | null };
}

export interface GrepOptions {
  root: string;
  pattern: string;
  fixedStrings?: boolean;
  ignoreCase?: boolean;
  globs?: string[];
  ignores?: string[];
  noDefaultIgnore?: boolean;
  hidden?: boolean;
  context?: number;
  /** 单文件命中上限；undefined 表示不限 */
  maxCount?: number;
  maxMatches?: number;
  maxFileSize?: number;
  timeoutMs?: number;
  binary?: 'skip' | 'list';
}

export interface GrepDeps {
  readFile(path: string): Buffer;
  readdir(path: string): Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>[];
  fileSize(path: string): number;
  now(): number;
}

const defaultDeps: GrepDeps = {
  readFile: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  fileSize: (path) => statSync(path).size,
  now: () => Date.now(),
};

export function escapeRegExpText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 编译模式；非法正则统一映射为退出码 2 */
export function compileGrepPattern(pattern: string, opts: { fixedStrings?: boolean; ignoreCase?: boolean } = {}): RegExp {
  const source = opts.fixedStrings === true ? escapeRegExpText(pattern) : pattern;
  try {
    return new RegExp(source, opts.ignoreCase === true ? 'gi' : 'g');
  } catch (err) {
    throw new CliExitError('GREP_INVALID_PATTERN', `正则无效：${(err as Error).message}`, 2);
  }
}

/** glob → 正则：`**` 跨目录、`*` 不跨 `/`、`?` 单字符；模式不含 `/` 时由调用方对 basename 比对 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

function matchPathPattern(pattern: string, relPath: string): boolean {
  const target = pattern.includes('/') ? relPath : relPath.slice(relPath.lastIndexOf('/') + 1);
  return globToRegExp(pattern).test(target);
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function clipText(line: string): string {
  return line.length > MAX_TEXT_CHARS ? `${line.slice(0, MAX_TEXT_CHARS)}…` : line;
}

interface WalkState {
  matches: GrepMatch[];
  scanned: number;
  skipped: number;
  sizeSkipped: number;
  permissionSkipped: number;
  truncated: 'max_matches' | 'timeout' | null;
  done: boolean;
  deadline: number;
}

export interface GrepRun {
  result: GrepResult;
  warnings: string[];
}

/** 纯本地检索入口（不碰网络；deps 仅用于测试注入 EACCES / 时钟） */
export function runGrep(options: GrepOptions, overrides: Partial<GrepDeps> = {}): GrepRun {
  const deps: GrepDeps = { ...defaultDeps, ...overrides };
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contextLines = options.context ?? 0;
  const re = compileGrepPattern(options.pattern, { fixedStrings: options.fixedStrings, ignoreCase: options.ignoreCase });
  const pathRe = new RegExp(re.source, re.flags.replace('g', ''));
  const state: WalkState = {
    matches: [],
    scanned: 0,
    skipped: 0,
    sizeSkipped: 0,
    permissionSkipped: 0,
    truncated: null,
    done: false,
    deadline: deps.now() + timeoutMs,
  };

  walkDirectory(options.root, '', state, options, deps, re, pathRe, maxFileSize, maxMatches, contextLines);

  state.matches.sort((a, b) => (a.path === b.path ? a.line - b.line || a.column - b.column : a.path < b.path ? -1 : 1));
  const cwd = process.cwd();
  const relRoot = toPosix(relative(cwd, options.root)) || '.';
  const rootLabel = relRoot.startsWith('..') || isAbsolute(relRoot) ? toPosix(options.root) : relRoot;

  const result: GrepResult = {
    pattern: options.pattern,
    root: rootLabel,
    matches: state.matches,
    stats: { files_scanned: state.scanned, files_skipped: state.skipped, matches: state.matches.length },
    truncated: { hit: state.truncated !== null, reason: state.truncated },
  };

  const warnings: string[] = [];
  if (state.truncated === 'max_matches') warnings.push(`已达到 --max-matches ${maxMatches}，结果已截断（不算错误）`);
  if (state.truncated === 'timeout') warnings.push(`已达到 --timeout ${timeoutMs}ms，结果已截断（不算错误）`);
  if (state.sizeSkipped > 0) warnings.push(`跳过 ${state.sizeSkipped} 个超过 --max-file-size ${maxFileSize} 字节的文件`);
  if (state.permissionSkipped > 0) warnings.push(`跳过 ${state.permissionSkipped} 个无权限或被占用的文件/目录`);
  return { result, warnings };
}

function walkDirectory(
  dirAbs: string,
  relDir: string,
  state: WalkState,
  options: GrepOptions,
  deps: GrepDeps,
  re: RegExp,
  pathRe: RegExp,
  maxFileSize: number,
  maxMatches: number,
  contextLines: number,
): void {
  if (state.done) return;
  if (deps.now() > state.deadline) {
    state.truncated ??= 'timeout';
    state.done = true;
    return;
  }

  let entries: Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>[];
  try {
    entries = deps.readdir(dirAbs);
  } catch {
    state.skipped += 1;
    state.permissionSkipped += 1;
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (state.done) return;
    if (deps.now() > state.deadline) {
      state.truncated ??= 'timeout';
      state.done = true;
      return;
    }
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      // 不跟随符号链接：避免环与跨出搜索根
      state.skipped += 1;
      continue;
    }
    if (!options.hidden && entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      if (options.noDefaultIgnore !== true && (DEFAULT_IGNORED_DIRS as readonly string[]).includes(entry.name)) continue;
      if ((options.ignores ?? []).some((pattern) => matchPathPattern(pattern, relPath))) continue;
      walkDirectory(join(dirAbs, entry.name), relPath, state, options, deps, re, pathRe, maxFileSize, maxMatches, contextLines);
      continue;
    }
    if (!entry.isFile()) continue;

    const globs = options.globs ?? [];
    if (globs.length > 0 && !globs.some((pattern) => matchPathPattern(pattern, relPath))) continue;
    if ((options.ignores ?? []).some((pattern) => matchPathPattern(pattern, relPath))) continue;

    scanFile({ absPath: join(dirAbs, entry.name), relPath, state, options, deps, re, pathRe, maxFileSize, maxMatches, contextLines });
  }
}

interface ScanArgs {
  absPath: string;
  relPath: string;
  state: WalkState;
  options: GrepOptions;
  deps: GrepDeps;
  re: RegExp;
  pathRe: RegExp;
  maxFileSize: number;
  maxMatches: number;
  contextLines: number;
}

function scanFile(args: ScanArgs): void {
  const { absPath, relPath, state, options, deps, re, maxFileSize, maxMatches, contextLines } = args;
  let size: number;
  try {
    size = deps.fileSize(absPath);
  } catch {
    state.skipped += 1;
    state.permissionSkipped += 1;
    return;
  }
  if (size > maxFileSize) {
    state.skipped += 1;
    state.sizeSkipped += 1;
    return;
  }

  let buffer: Buffer;
  try {
    buffer = deps.readFile(absPath);
  } catch {
    state.skipped += 1;
    state.permissionSkipped += 1;
    return;
  }
  state.scanned += 1;

  const probe = buffer.subarray(0, Math.min(NUL_PROBE_BYTES, buffer.length));
  if (probe.includes(0)) {
    // 二进制：skip 丢弃；list 只在路径本身命中模式时列出（line/column 记 1，text 为空）
    if (options.binary === 'list' && args.pathRe.test(relPath)) {
      const column = relPath.search(args.pathRe) + 1;
      const matched = args.pathRe.exec(relPath);
      const start = matched ? matched.index + 1 : 1;
      const end = matched ? matched.index + matched[0].length + 1 : 1;
      pushMatch(state, maxMatches, {
        path: relPath,
        line: 1,
        column: column > 0 ? column : start,
        text: '',
        match: { start, end },
        context: { before: [], after: [] },
      });
    } else {
      state.skipped += 1;
    }
    return;
  }

  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n').map(stripCr);
  // 文件以换行结尾时去掉末尾空行，避免上下文多出一行「超出 EOF」的空行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const found: GrepMatch[] = [];
  let perFile = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index % 256 === 0 && deps.now() > state.deadline) {
      state.truncated ??= 'timeout';
      state.done = true;
      break;
    }
    const line = lines[index]!;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      if (match[0] === '') {
        re.lastIndex += 1;
        continue;
      }
      found.push({
        path: relPath,
        line: index + 1,
        column: match.index + 1,
        text: clipText(line),
        match: { start: match.index + 1, end: match.index + match[0].length + 1 },
        context: { before: [], after: [] },
      });
      perFile += 1;
      if (options.maxCount !== undefined && perFile >= options.maxCount) break;
      if (state.matches.length + found.length >= maxMatches) break;
    }
    if (options.maxCount !== undefined && perFile >= options.maxCount) break;
    if (state.matches.length + found.length >= maxMatches) {
      state.truncated ??= 'max_matches';
      state.done = true;
      break;
    }
  }

  if (contextLines > 0) {
    for (const item of found) {
      const before: string[] = [];
      const after: string[] = [];
      for (let i = Math.max(0, item.line - 1 - contextLines); i < item.line - 1; i += 1) before.push(clipText(lines[i]!));
      for (let i = item.line; i < Math.min(lines.length, item.line + contextLines); i += 1) after.push(clipText(lines[i]!));
      item.context = { before, after };
    }
  }

  for (const item of found) {
    if (state.matches.length >= maxMatches) {
      state.truncated ??= 'max_matches';
      state.done = true;
      break;
    }
    state.matches.push(item);
  }
}

function pushMatch(state: WalkState, maxMatches: number, item: GrepMatch): void {
  if (state.matches.length >= maxMatches) {
    state.truncated ??= 'max_matches';
    state.done = true;
    return;
  }
  state.matches.push(item);
}

function parseIntegerOption(value: string | undefined, fallback: number, name: string, min: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new CliExitError('GREP_INVALID_OPTION', `${name} 必须是 ≥${min} 的整数（收到 ${value}）`, 2);
  }
  return parsed;
}

async function resolveGrepRoot(ctx: Ctx, pathOption: string | undefined): Promise<string> {
  if (pathOption !== undefined && isAbsolute(pathOption)) return resolve(pathOption);
  let workspaceRoot: string;
  try {
    const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
    workspaceRoot = matchCurrentWorkspace(spaces).path;
  } catch (err) {
    // 本地检索不强依赖看板服务：解析不到工作区时回退 cwd，并明确告知
    ctx.io.writeErr(`提示：无法解析当前工作区（${(err as Error).message}），搜索根回退到当前目录\n`);
    workspaceRoot = process.cwd();
  }
  return pathOption === undefined ? workspaceRoot : resolve(workspaceRoot, pathOption);
}

export interface GrepCliOptions {
  path?: string;
  glob?: string[];
  ignore?: string[];
  fixedStrings?: boolean;
  noDefaultIgnore?: boolean;
  hidden?: boolean;
  ignoreCase?: boolean;
  context?: string;
  maxCount?: string;
  maxMatches?: string;
  maxFileSize?: string;
  timeout?: string;
  binary?: string;
}

export async function grep(ctx: Ctx, pattern: string, options: GrepCliOptions): Promise<void> {
  const root = await resolveGrepRoot(ctx, options.path);
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(root);
  } catch {
    throw new CliExitError('GREP_ROOT_NOT_FOUND', `搜索根不存在：${root}`, 2);
  }
  if (!rootStat.isDirectory()) throw new CliExitError('GREP_ROOT_NOT_DIRECTORY', `搜索根不是目录：${root}`, 2);

  const binary = options.binary ?? 'skip';
  if (binary !== 'skip' && binary !== 'list') {
    throw new CliExitError('GREP_INVALID_OPTION', `--binary 只接受 skip 或 list（收到 ${binary}）`, 2);
  }

  const run = runGrep({
    root,
    pattern,
    fixedStrings: options.fixedStrings === true,
    ignoreCase: options.ignoreCase === true,
    globs: options.glob ?? [],
    ignores: options.ignore ?? [],
    noDefaultIgnore: options.noDefaultIgnore === true,
    hidden: options.hidden === true,
    context: parseIntegerOption(options.context, 0, '--context', 0),
    maxCount: options.maxCount === undefined ? undefined : parseIntegerOption(options.maxCount, 0, '--max-count', 1),
    maxMatches: parseIntegerOption(options.maxMatches, DEFAULT_MAX_MATCHES, '--max-matches', 1),
    maxFileSize: parseIntegerOption(options.maxFileSize, DEFAULT_MAX_FILE_SIZE, '--max-file-size', 1),
    timeoutMs: parseIntegerOption(options.timeout, DEFAULT_TIMEOUT_MS, '--timeout', 1),
    binary,
  });

  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(run.result, null, 2)}\n`);
  } else {
    renderText(run.result, ctx);
  }
  for (const warning of run.warnings) ctx.io.writeErr(`${warning}\n`);
  if (run.result.matches.length === 0) {
    // 未命中是正常结论：静默退出 1（不写 stderr）
    throw new CommanderError(1, 'kb.grep.no_match', '');
  }
}

/** 文本输出：命中 `path:line:col:text`，上下文 `path-line-text`，不同文件/不连续区间用 `--` 分隔 */
function renderText(result: GrepResult, ctx: Ctx): void {
  let lastPath = '';
  let lastLine = 0;
  const emitContext = (path: string, line: number, text: string): void => {
    if (line > lastLine) {
      ctx.io.write(`${path}-${line}-${text}\n`);
      lastLine = line;
    }
  };
  for (const item of result.matches) {
    if (item.path !== lastPath) {
      if (lastPath !== '') ctx.io.write('--\n');
      lastPath = item.path;
      lastLine = 0;
    }
    const before = item.context.before;
    for (let i = 0; i < before.length; i += 1) emitContext(item.path, item.line - before.length + i, before[i]!);
    if (item.line > lastLine) {
      ctx.io.write(`${item.path}:${item.line}:${item.column}:${item.text}\n`);
      lastLine = item.line;
    }
    const after = item.context.after;
    for (let i = 0; i < after.length; i += 1) emitContext(item.path, item.line + 1 + i, after[i]!);
  }
}
