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

export type AgentBoardSettings = AgentBoardConfig;

function defaultConfig(): AgentBoardConfig {
  return { port: DEFAULT_PORT, dbPath: defaultDbPath(), maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_TURNS };
}

/** 读 config.json 原始对象；缺失/损坏返回空（损坏不覆盖原文件） */
function readPersistedFile(): Partial<AgentBoardConfig> {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as Partial<AgentBoardConfig>;
    }
  } catch {
    // 损坏的配置文件按默认处理
  }
  return {};
}

/** 字段级容错合并：仅合法字段覆盖（非法回退默认/当前值）；loadConfig 与 settings 读写共用 */
function mergeValidFields(
  target: AgentBoardConfig,
  source: Partial<AgentBoardConfig>,
): AgentBoardConfig {
  if (typeof source.port === 'number' && Number.isInteger(source.port) && source.port > 0) {
    target.port = source.port;
  }
  if (typeof source.dbPath === 'string' && source.dbPath !== '') {
    target.dbPath = source.dbPath;
  }
  if (
    typeof source.maxConcurrentTurns === 'number' &&
    Number.isInteger(source.maxConcurrentTurns) &&
    source.maxConcurrentTurns >= 1
  ) {
    target.maxConcurrentTurns = source.maxConcurrentTurns;
  }
  return target;
}

/** 读取配置；文件缺失时写回默认；字段非法回退默认值；环境变量最后覆盖（测试用） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentBoardConfig {
  const path = configFilePath();
  const fileConfig = readPersistedFile();
  if (!existsSync(path)) {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
  }

  const config = mergeValidFields(defaultConfig(), fileConfig);

  if (env.AGENTBOARD_PORT !== undefined && env.AGENTBOARD_PORT !== '') {
    const port = Number(env.AGENTBOARD_PORT);
    if (Number.isInteger(port) && port > 0) config.port = port;
  }
  if (env.AGENTBOARD_DB !== undefined && env.AGENTBOARD_DB !== '') {
    config.dbPath = env.AGENTBOARD_DB;
  }
  return config;
}

/**
 * 设置端点读侧：文件持久化值 + 默认合并（字段非法回退默认；文件缺失不写回，与 loadConfig 的启动写回不同）。
 * 环境变量 AGENTBOARD_PORT / AGENTBOARD_DB 不参与：它们是启动期临时覆盖，
 * settings 端点只反映 config.json 持久化值——PATCH 写回的目标即 GET 回显的对象，避免回显与写回不一致。
 */
export function readSettings(): AgentBoardSettings {
  return mergeValidFields(defaultConfig(), readPersistedFile());
}

/** 设置端点写侧：读当前持久化值 → 合并 patch（内部字段级容错，与 routes 层 zod 校验并存）→ 写回 → 返回新持久化值 */
export function writeSettings(patch: Partial<AgentBoardSettings>): AgentBoardSettings {
  const merged = mergeValidFields(readSettings(), patch);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}
