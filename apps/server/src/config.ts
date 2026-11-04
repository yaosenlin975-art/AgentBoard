/**
 * Task 9：配置加载（默认 %APPDATA%\AgentBoard\config.json，不存在用默认并写回；
 * 环境变量 AGENTBOARD_PORT / AGENTBOARD_DB / AGENTBOARD_HOST 覆盖，不写回）。
 * DOCKER-1：监听地址由 AGENTBOARD_HOST 提供，缺省仍为 127.0.0.1（安全口径不变）；非法值启动即报错。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_ATTACHMENT_STAGED_TTL_MS,
} from './services/attachments.js';

export interface AgentBoardConfig {
  port: number;
  dbPath: string;
  maxConcurrentTurns: number;
  attachmentQuotaBytes: number;
  attachmentStagedTtlMs: number;
  attachmentCleanupIntervalMs: number;
}

/** WorkBuddy 计费区域（ACC-KB-A1）：决定签到/额度打哪个计费域 */
export type WorkbuddyRegion = 'cn' | 'global';

/** 运行期配置：持久化设置 + 启动期 env 覆盖项（host / workbuddyRegion 不落 config.json，settings 端点不暴露） */
export interface AgentBoardRuntimeConfig extends AgentBoardConfig {
  host: string;
  workbuddyRegion: WorkbuddyRegion;
}

export const DEFAULT_PORT = 8787;
/** 只监听回环：保持既有安全口径，容器里才通过 env 显式放宽到 0.0.0.0 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAX_CONCURRENT_TURNS = 3;
/** 默认区域固定 cn：三份独立证据（知识实测 / verification 文档 / refs 脚本）都指向 CN 计费域 */
export const DEFAULT_WORKBUDDY_REGION: WorkbuddyRegion = 'cn';

/** 校验区域取值：只接受 cn / global；空值/非法返回 null（调用方决定报错还是取默认） */
export function parseWorkbuddyRegion(raw: string): WorkbuddyRegion | null {
  const value = raw.trim().toLowerCase();
  return value === 'cn' || value === 'global' ? value : null;
}

/** 校验监听地址：IPv4/IPv6 字面量或主机名；空值/非法返回 null */
export function parseHost(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  // 纯数字点样式只接受合法 IPv4（999.1.1.1 这类必须拒绝，不能被当成主机名）
  if (/^[0-9.]+$/.test(value)) return isIP(value) === 4 ? value : null;
  // 含冒号只接受合法 IPv6
  if (value.includes(':')) return isIP(value) === 6 ? value : null;
  if (isIP(value) !== 0) return value;
  // 主机名：字母数字与 '-'，点分段，段首尾不能是 '-'
  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
  return hostname.test(value) ? value : null;
}

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

/**
 * 附件目录派生（DOCKER-2）：恒为 DB 文件所在目录下的 `attachments`。
 * - 非容器环境 DB 在 %APPDATA%\AgentBoard\agentboard.db → 仍是 %APPDATA%\AgentBoard\attachments（老用户路径不变）；
 * - 容器里 AGENTBOARD_DB=/data/agentboard.db → /data/attachments，只需挂一个卷。
 */
export function attachmentsDirFor(dbPath: string): string {
  return join(dirname(dbPath), 'attachments');
}

export type AgentBoardSettings = AgentBoardConfig;

function defaultConfig(): AgentBoardConfig {
  return {
    port: DEFAULT_PORT,
    dbPath: defaultDbPath(),
    maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_TURNS,
    attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
    attachmentStagedTtlMs: DEFAULT_ATTACHMENT_STAGED_TTL_MS,
    attachmentCleanupIntervalMs: DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  };
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
  if (Number.isSafeInteger(source.attachmentQuotaBytes) && source.attachmentQuotaBytes! >= 1) {
    target.attachmentQuotaBytes = source.attachmentQuotaBytes!;
  }
  if (Number.isSafeInteger(source.attachmentStagedTtlMs) && source.attachmentStagedTtlMs! >= 1) {
    target.attachmentStagedTtlMs = source.attachmentStagedTtlMs!;
  }
  if (Number.isSafeInteger(source.attachmentCleanupIntervalMs) && source.attachmentCleanupIntervalMs! >= 1) {
    target.attachmentCleanupIntervalMs = source.attachmentCleanupIntervalMs!;
  }
  return target;
}

/** 读取配置；文件缺失时写回默认；字段非法回退默认值；环境变量最后覆盖（测试用） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentBoardRuntimeConfig {
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
  // DOCKER-1：监听地址只由 env 提供（不写回 config.json）；非法值直接抛错，启动即退出，不静默回落
  let host = DEFAULT_HOST;
  const rawHost = env.AGENTBOARD_HOST;
  if (rawHost !== undefined && rawHost.trim() !== '') {
    const parsed = parseHost(rawHost);
    if (parsed === null) {
      throw new Error(`AGENTBOARD_HOST 非法：${rawHost}（需 IPv4/IPv6 字面量或主机名，缺省为 ${DEFAULT_HOST}）`);
    }
    host = parsed;
  }
  // ACC-KB-A1：计费区域 env 覆盖（不落 config.json；非法值启动即报错，避免静默打到错误域）
  let workbuddyRegion = DEFAULT_WORKBUDDY_REGION;
  const rawRegion = env.AGENTBOARD_WORKBUDDY_REGION;
  if (rawRegion !== undefined && rawRegion.trim() !== '') {
    const parsedRegion = parseWorkbuddyRegion(rawRegion);
    if (parsedRegion === null) {
      throw new Error(`AGENTBOARD_WORKBUDDY_REGION 非法：${rawRegion}（可选 cn / global，缺省为 ${DEFAULT_WORKBUDDY_REGION}）`);
    }
    workbuddyRegion = parsedRegion;
  }
  return { ...config, host, workbuddyRegion };
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
