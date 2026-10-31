/**
 * Task 9：配置加载（默认 %APPDATA%\AgentBoard\config.json，不存在用默认并写回；
 * 环境变量 AGENTBOARD_PORT / AGENTBOARD_DB 覆盖，不写回）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentBoardConfig {
  port: number;
  dbPath: string;
  maxConcurrentTurns: number;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_CONCURRENT_TURNS = 3;

/** Windows 用 %APPDATA%，非 Windows 回退 ~/.config */
export function appDataDir(): string {
  return process.env.APPDATA && process.env.APPDATA !== '' ? process.env.APPDATA : join(homedir(), '.config');
}

export function configDir(): string {
  return join(appDataDir(), 'AgentBoard');
}

export function configFilePath(): string {
  return join(configDir(), 'config.json');
}

export function defaultDbPath(): string {
  return join(configDir(), 'agentboard.db');
}

function defaultConfig(): AgentBoardConfig {
  return { port: DEFAULT_PORT, dbPath: defaultDbPath(), maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_TURNS };
}

/** 读取配置；文件缺失时写回默认；字段非法回退默认值；环境变量最后覆盖（测试用） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentBoardConfig {
  const path = configFilePath();
  let fileConfig: Partial<AgentBoardConfig> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        fileConfig = parsed as Partial<AgentBoardConfig>;
      }
    } catch {
      // 损坏的配置文件按默认处理，不覆盖原文件
    }
  } else {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
  }

  const config = defaultConfig();
  if (typeof fileConfig.port === 'number' && Number.isInteger(fileConfig.port) && fileConfig.port > 0) {
    config.port = fileConfig.port;
  }
  if (typeof fileConfig.dbPath === 'string' && fileConfig.dbPath !== '') {
    config.dbPath = fileConfig.dbPath;
  }
  if (
    typeof fileConfig.maxConcurrentTurns === 'number' &&
    Number.isInteger(fileConfig.maxConcurrentTurns) &&
    fileConfig.maxConcurrentTurns >= 1
  ) {
    config.maxConcurrentTurns = fileConfig.maxConcurrentTurns;
  }

  if (env.AGENTBOARD_PORT !== undefined && env.AGENTBOARD_PORT !== '') {
    const port = Number(env.AGENTBOARD_PORT);
    if (Number.isInteger(port) && port > 0) config.port = port;
  }
  if (env.AGENTBOARD_DB !== undefined && env.AGENTBOARD_DB !== '') {
    config.dbPath = env.AGENTBOARD_DB;
  }
  return config;
}
