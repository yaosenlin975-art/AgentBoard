/**
 * ARCH-01：CLI / MCP 能力对照表防漂移。
 *
 * 解析 `packages/cli/src/index.ts`（含其注册的知识 / 变更日志 / 决策命令模块）的顶层命令名，
 * 与 `Docs/api.md`「CLI / MCP 能力对照」表格行做集合比对：
 * - 表里少一行 → 红；
 * - CLI 新增顶层命令但没登记 → 红；
 * - 「MCP 版」列出现 有/无/永不提供 之外的值 → 红。
 * 新增命令时：在 `index.ts` 注册 + 在本表加一行，两处同时改。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliSrcRoot = join(projectRoot, 'packages', 'cli', 'src');

/** `program.command('x')`，容忍换行（如 `program\n  .command('ask')`） */
const COMMAND_RE = /program\s*\.\s*command\(\s*'([^']+)'/g;
const MARKS = new Set(['有', '无', '永不提供']);

function collectCommands(source: string, into: Set<string>): void {
  for (const match of source.matchAll(COMMAND_RE)) into.add(match[1]!);
}

function cliTopLevelCommands(): Set<string> {
  const indexSource = readFileSync(join(cliSrcRoot, 'index.ts'), 'utf8');
  const commands = new Set<string>();
  collectCommands(indexSource, commands);

  // `registerXxxCommands(program, …)` 在各自模块里注册顶层命令；从 import 列表找出这些模块
  const importRe = /import\s*\{([^}]+)\}\s*from\s*'\.\/commands\/([^']+)\.js';/g;
  for (const match of indexSource.matchAll(importRe)) {
    if (!/register\w+Commands/.test(match[1]!)) continue;
    collectCommands(readFileSync(join(cliSrcRoot, 'commands', `${match[2]!}.ts`), 'utf8'), commands);
  }
  return commands;
}

function parityTable(): { commands: Set<string>; invalidMarks: string[]; malformedRows: string[] } {
  const lines = readFileSync(join(projectRoot, 'Docs', 'api.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line.includes('CLI / MCP 能力对照'));
  expect(start, 'Docs/api.md 缺少「CLI / MCP 能力对照」小节').toBeGreaterThan(-1);
  const nextHeading = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const section = lines.slice(start + 1, nextHeading < 0 ? lines.length : nextHeading);

  const commands = new Set<string>();
  const invalidMarks: string[] = [];
  const malformedRows: string[] = [];
  for (const line of section) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    const command = /^`kb ([^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (command === undefined) continue; // 表头 / 分隔行
    commands.add(command);
    if (cells.length < 4) malformedRows.push(line);
    const mark = cells[2] ?? '';
    if (!MARKS.has(mark)) invalidMarks.push(`${command} → ${mark || '（空）'}`);
  }
  return { commands, invalidMarks, malformedRows };
}

describe('CLI / MCP 能力对照表（ARCH-01 防漂移）', () => {
  it('表格覆盖全部 CLI 顶层命令，且每行标注 有/无/永不提供', () => {
    const cliCommands = [...cliTopLevelCommands()].sort();
    const { commands, invalidMarks, malformedRows } = parityTable();

    expect(cliCommands.length).toBeGreaterThan(0);
    expect([...commands].sort()).toEqual(cliCommands);
    expect(invalidMarks).toEqual([]);
    expect(malformedRows).toEqual([]);
  });
});
