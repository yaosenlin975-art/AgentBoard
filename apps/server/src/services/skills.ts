/**
 * `GET /api/skills`：只读列出「已安装技能」的 name/description。
 *
 * 根目录**固定**（默认 `~/.agents/skills`，测试可注入），不接受任何路径参数 —— 端点无法被用来读任意文件。
 * 只返回 frontmatter 的 name/description，不返回正文。
 * 缓存：整体结果 TTl 30s；TTL 内不读盘；过期后按每个 SKILL.md 的 mtime 决定是否重读（不是每次读全盘）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SkillSummary { name: string; description: string }
export interface ListSkillsOptions { root?: string; ttlMs?: number; now?: () => number }

export const DEFAULT_SKILLS_ROOT = join(homedir(), '.agents', 'skills');
const DEFAULT_TTL_MS = 30_000;

interface FileCacheEntry { mtimeMs: number; summary: SkillSummary }
interface RootCacheEntry { expiresAt: number; entries: SkillSummary[] }

const fileCache = new Map<string, FileCacheEntry>();
const rootCache = new Map<string, RootCacheEntry>();

/** 只取 frontmatter 顶层 key: value；嵌套块（缩进行）忽略 */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value.trim();
  }
  return fields;
}

function readSkillSummary(skillDir: string, fallbackName: string): SkillSummary {
  const file = join(skillDir, 'SKILL.md');
  try {
    const { mtimeMs } = statSync(file);
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.summary;
    const fields = parseFrontmatter(readFileSync(file, 'utf8'));
    const summary: SkillSummary = {
      name: fields.name && fields.name !== '' ? fields.name : fallbackName,
      description: fields.description ?? '',
    };
    fileCache.set(file, { mtimeMs, summary });
    return summary;
  } catch {
    // 目录里没有 SKILL.md 或不可读：整条跳过（返回 null 由调用方过滤）
    return { name: '', description: '' };
  }
}

export function listSkills(options: ListSkillsOptions = {}): SkillSummary[] {
  const root = options.root ?? DEFAULT_SKILLS_ROOT;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now?.() ?? Date.now();
  const cached = rootCache.get(root);
  if (cached && cached.expiresAt > now) return cached.entries.map(entry => ({ ...entry }));

  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    names = []; // 根不存在 / 不可读 → 空列表，不抛
  }

  const entries: SkillSummary[] = [];
  for (const name of names.sort()) {
    const summary = readSkillSummary(join(root, name), name);
    if (summary.name !== '') entries.push(summary);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  rootCache.set(root, { expiresAt: now + ttlMs, entries });
  return entries.map(entry => ({ ...entry }));
}

/** 测试用：清空缓存（不同用例的临时根目录互不影响） */
export function resetSkillsCache(): void {
  fileCache.clear();
  rootCache.clear();
}
