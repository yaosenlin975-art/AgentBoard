/**
 * CR-8：config.json 原子写与损坏分支。
 * - 损坏 config.json：loadConfig 启动日志显式提示「配置文件损坏」、原文件逐字节保持原样、字段回落默认；
 * - writeSettings 原子替换：写入成功无 .tmp 残留；覆盖既有文件时旧字段保留、新字段生效；
 * - 写失败（临时文件路径被目录占位，真实 fs 失败）：writeSettings 抛错且原文件内容不变。
 * 构造损坏文件方式：向 <APPDATA>/AgentBoard/config.json 写入半截 JSON（如 `{"port": 8787, "dbPath": "D:/x`）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeSettings } from '../src/config.js';

describe('CR-8 config.json 原子写与损坏提示', () => {
  let appData: string;
  let previousAppData: string | undefined;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'agentboard-cr8-'));
    previousAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    rmSync(appData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const configDir = (): string => join(appData, 'AgentBoard');
  const configPath = (): string => join(configDir(), 'config.json');

  it('损坏 config.json：启动日志显式提示、原文件逐字节不变、字段回落默认', () => {
    mkdirSync(configDir(), { recursive: true });
    // 构造方式：进程写设置中途被杀留下的半截 JSON
    const corrupted = '{"port": 8787, "dbPath": "D:/custom/agentboard.db", "maxConc';
    writeFileSync(configPath(), corrupted, 'utf8');

    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((chunk) => {
      errs.push(String(chunk));
    });
    try {
      const config = loadConfig({ APPDATA: appData });
      expect(config.dbPath).toBe(join(configDir(), 'agentboard.db'));
      expect(config.port).toBe(8787);
      expect(errs.join('\n')).toContain('配置文件损坏');
      expect(errs.join('\n')).toContain('已按默认值启动');
      // 原文件保持原样：不自动覆盖、不修复改写
      expect(readFileSync(configPath(), 'utf8')).toBe(corrupted);
    } finally {
      spy.mockRestore();
    }
  });

  it('合法 config.json 不触发损坏提示', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ port: 9001 }, null, 2), 'utf8');
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((chunk) => {
      errs.push(String(chunk));
    });
    try {
      loadConfig({ APPDATA: appData });
      expect(errs.join('\n')).not.toContain('配置文件损坏');
    } finally {
      spy.mockRestore();
    }
  });

  it('writeSettings 原子替换：写入成功且无 .tmp 残留', () => {
    const merged = writeSettings({ port: 9999 });
    expect(merged.port).toBe(9999);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toMatchObject({ port: 9999 });
    expect(existsSync(`${configPath()}.tmp`)).toBe(false);
  });

  it('writeSettings 覆盖既有文件：旧字段保留、新字段生效', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ port: 8787 }, null, 2), 'utf8');
    writeSettings({ maxConcurrentTurns: 5 });
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as { port: number; maxConcurrentTurns: number };
    expect(parsed.port).toBe(8787);
    expect(parsed.maxConcurrentTurns).toBe(5);
    expect(existsSync(`${configPath()}.tmp`)).toBe(false);
  });

  it('写失败：临时文件路径被目录占位 → writeSettings 抛错且原文件内容不变', () => {
    mkdirSync(configDir(), { recursive: true });
    const original = '{"port": 8788}';
    writeFileSync(configPath(), original, 'utf8');
    // 真实 fs 失败：临时文件名被目录占住，writeFileSync 打不开该路径
    mkdirSync(`${configPath()}.tmp`);
    expect(() => writeSettings({ port: 7777 })).toThrow();
    // 原文件未被破坏
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
    rmSync(`${configPath()}.tmp`, { recursive: true, force: true });
  });
});
