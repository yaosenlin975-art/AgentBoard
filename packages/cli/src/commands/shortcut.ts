/**
 * kb shortcut：Windows 桌面快捷方式（AgentBoard.lnk → wscript.exe agentboard.vbs open）。
 * 经 PowerShell WScript.Shell COM 创建（[Environment]::GetFolderPath('Desktop') 处理 OneDrive 重定向）；
 * 零 npm 依赖；脚本经 spawn 参数数组传递（-Command 单引号转义），不经 shell。
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../io.js';
import { firstLine, type Runner, spawnRunner } from '../winrun.js';
import { defaultPaths, isVbsConfigured, readVbsText, requireWindows, type AutostartPaths } from './autostart.js';

/** 桌面快捷方式文件名 */
export const SHORTCUT_NAME = 'AgentBoard.lnk';

/** 桌面路径查询脚本（含 OneDrive 重定向场景） */
export const DESKTOP_PS = "try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{};[Environment]::GetFolderPath('Desktop')";

/** PowerShell 单引号字符串转义（' → ''） */
export function psQuote(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

/** 建快捷方式的 PowerShell 脚本（分号串联单行；输出 lnk 全路径供 CLI 回显） */
export function buildShortcutScript(vbsPath: string, repoRoot: string, iconPath: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    '$shell=New-Object -ComObject WScript.Shell',
    "$desktop=[Environment]::GetFolderPath('Desktop')",
    `$lnkPath=Join-Path $desktop ${psQuote(SHORTCUT_NAME)}`,
    '$lnk=$shell.CreateShortcut($lnkPath)',
    "$lnk.TargetPath='wscript.exe'",
    `$lnk.Arguments=${psQuote(`"${vbsPath}" open`)}`,
    `$lnk.WorkingDirectory=${psQuote(repoRoot)}`,
    `$lnk.IconLocation=${psQuote(iconPath)}`,
    `$lnk.Description=${psQuote('AgentBoard 任务看板')}`,
    '$lnk.Save()',
    '[Console]::Out.Write($lnkPath)',
  ].join('; ');
}

/** 查询真实桌面目录 */
export async function getDesktopPath(run: Runner): Promise<string> {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DESKTOP_PS]);
  const path = res.stdout.trim();
  if (res.code !== 0 || path === '') throw new Error(`获取桌面路径失败：${firstLine(res.stderr)}`);
  return path;
}

export interface ShortcutOptions {
  runner?: Runner;
  paths?: AutostartPaths;
}

/** 创建：ico 缺失报错；vbs 未配置（未 kb autostart install）报错；已存在同名 lnk 覆盖提示 */
export async function createShortcut(ctx: Ctx, opts: ShortcutOptions = {}): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const paths = opts.paths ?? defaultPaths();
  if (!existsSync(paths.iconPath)) {
    throw new Error(`图标缺失：${paths.iconPath}，先构建 apps/web/public/agentboard.ico`);
  }
  if (!isVbsConfigured(readVbsText(paths.vbsPath))) {
    throw new Error('scripts/agentboard.vbs 未配置（常量仍为占位符），先执行 kb autostart install');
  }
  const desktop = await getDesktopPath(run);
  if (existsSync(join(desktop, SHORTCUT_NAME))) ctx.io.write(`桌面已存在 ${SHORTCUT_NAME}，覆盖\n`);
  const script = buildShortcutScript(paths.vbsPath, paths.repoRoot, paths.iconPath);
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (res.code !== 0) throw new Error(`创建快捷方式失败：${firstLine(res.stderr)}`);
  ctx.io.write(`已创建桌面快捷方式：${res.stdout.trim() || join(desktop, SHORTCUT_NAME)}\n`);
}

/** 移除：桌面存在 AgentBoard.lnk 才删 */
export async function removeShortcut(ctx: Ctx, opts: ShortcutOptions = {}): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const desktop = await getDesktopPath(run);
  const lnkPath = join(desktop, SHORTCUT_NAME);
  if (!existsSync(lnkPath)) {
    ctx.io.write(`桌面不存在 ${SHORTCUT_NAME}，无需移除\n`);
    return;
  }
  unlinkSync(lnkPath);
  ctx.io.write(`已移除桌面快捷方式：${lnkPath}\n`);
}
