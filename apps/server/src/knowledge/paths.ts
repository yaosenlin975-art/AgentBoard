/**
 * P2-01（方向 B §7.2）：知识文件仓储的路径层。
 *
 * 布局（§7.1）：
 * - 工作区知识：`<工作区>/.agentboard/Docs/*.md`
 * - 公共知识：`~/.agentboard/Docs/*.md`（不进任何工作区 git）
 * - 附属布局：`<Docs>/_attachments/`（vault 自包含，§8 #3）、`<Docs>/.locks/<slug>.lock`（跨进程写锁）、
 *   `<Docs>/.index.json`（可重建检索索引，非事实源）。
 *
 * 逃逸校验沿用 SNAPSHOT_PATH_OUTSIDE_WORKSPACE 口径（resolve 后必须在 Docs 目录内）。
 * 目录解析可注入覆盖（测试注入临时目录；生产用默认实现），见 `DocsDirOverrides`。
 */
import { homedir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { workspaceStateDir } from '../db/resolver.js';
import { docFileNameFor, normalizeDocSlug } from '@agentboard/shared';

export const DOCS_DIR_NAME = 'Docs';
export const ATTACHMENTS_DIR_NAME = '_attachments';
export const LOCKS_DIR_NAME = '.locks';
export const INDEX_FILE_NAME = '.index.json';

export interface DocsDirOverrides {
  /** 工作区 Docs 目录（测试注入临时目录） */
  workspaceDocsDir?: (workspacePath: string) => string;
  /** 公共 Docs 目录（测试注入临时目录） */
  commonDocsDir?: () => string;
}

export function defaultWorkspaceDocsDir(workspacePath: string): string {
  return join(workspaceStateDir(workspacePath), DOCS_DIR_NAME);
}

/**
 * 公共 Docs 目录：生产 = `~/.agentboard/Docs`（不进任何工作区 git）。
 * vitest 进程内退换为每进程一个临时目录（懒建 + 缓存）：测试夹具未显式注入 commonDocsDir 时
 * 不会把测试页写进真实用户目录（P2-01 实测教训：导入类 REST 测试曾把 ~10MB 测试页写进 home）。
 */
let testCommonDocsDir: string | null = null;
export function defaultCommonDocsDir(): string {
  if (process.env.VITEST !== undefined) {
    if (testCommonDocsDir === null) testCommonDocsDir = mkdtempSync(join(tmpdir(), 'agentboard-test-common-docs-'));
    return testCommonDocsDir;
  }
  return join(homedir(), '.agentboard', DOCS_DIR_NAME);
}

export function resolveDocsDir(overrides: DocsDirOverrides | undefined, kind: 'workspace' | 'common', workspacePath: string | null): string {
  if (kind === 'workspace') {
    if (workspacePath === null || workspacePath === '') throw new Error('workspace scope 需要工作区路径');
    return (overrides?.workspaceDocsDir ?? defaultWorkspaceDocsDir)(workspacePath);
  }
  return (overrides?.commonDocsDir ?? defaultCommonDocsDir)();
}

/** slug → Docs 内文件绝对路径（文件名与 wikilink 归一同一函数，避免「存在却判 unresolved」） */
export function docFilePathFor(docsDir: string, slug: string): string {
  const filePath = join(docsDir, docFileNameFor(slug));
  assertInsideDocsDir(docsDir, filePath);
  return filePath;
}

/** 逃逸校验：resolve 后必须落在 docsDir 内（含 docsDir 本身） */
export function assertInsideDocsDir(docsDir: string, target: string): string {
  const root = resolve(docsDir);
  const resolved = resolve(target);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`路径必须位于 Docs 目录内（${root}），拒绝 ${resolved}`);
  }
  return resolved;
}

/** 跨进程锁文件：`<Docs>/.locks/<slug-norm>.lock` */
export function lockPathFor(docsDir: string, slug: string): string {
  return join(docsDir, LOCKS_DIR_NAME, `${normalizeDocSlug(slug)}.lock`);
}

/** 落盘检索索引：`<Docs>/.index.json` */
export function indexPathFor(docsDir: string): string {
  return join(docsDir, INDEX_FILE_NAME);
}

export function attachmentsDirFor(docsDir: string): string {
  return join(docsDir, ATTACHMENTS_DIR_NAME);
}
