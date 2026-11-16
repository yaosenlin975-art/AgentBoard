/**
 * P2-01（方向 B §7.2）：Docs 目录扫描与单文件读取。
 *
 * - 只认顶层 `*.md`；跳过 `_attachments/`、`.locks/`、`.index.json`、其它点前缀文件与子目录。
 * - 单文件读取失败（IO/解析）不抛给扫描：返回 `error`，由索引层收录为 issues（reconcile 报告），
 *   不让一个坏文件阻断整个知识库读取（Obsidian 里写一半的文件很常见）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeFileParseError, parseKnowledgeDocument, type KnowledgeFileMeta } from '@agentboard/shared';
import { assertInsideDocsDir } from './paths.js';

export interface ScannedFileInfo {
  fileName: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** 列出 Docs 顶层待索引的 md 文件（按文件名排序，保证扫描顺序确定） */
export function listDocFiles(docsDir: string): ScannedFileInfo[] {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = readdirSync(docsDir, { withFileTypes: true });
  } catch {
    return []; // Docs 目录还不存在（未建库）→ 空索引
  }
  const files: ScannedFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const path = join(docsDir, entry.name);
    try {
      const stat = statSync(path);
      files.push({ fileName: entry.name, path, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      /* stat 失败（竞态删除）：跳过，下次扫描再判 */
    }
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export interface ReadDocResult {
  meta: KnowledgeFileMeta;
  body_md: string;
  raw: string;
}

/** 读取并解析单个知识文件（含逃逸校验）；解析失败抛 KnowledgeFileParseError，IO 失败原样抛 */
export function readDocFile(docsDir: string, filePath: string): ReadDocResult {
  assertInsideDocsDir(docsDir, filePath);
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body_md } = parseKnowledgeDocument(raw);
  return { meta, body_md, raw };
}

/** 判断错误是否为 front matter 解析失败（reconcile 分类用） */
export function isParseIssue(error: unknown): error is KnowledgeFileParseError {
  return error instanceof KnowledgeFileParseError;
}
