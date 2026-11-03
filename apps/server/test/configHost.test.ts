/**
 * DOCKER-1：监听地址配置（AGENTBOARD_HOST）。
 * - 缺省仍是 127.0.0.1（安全口径不变）；只有显式设 env 才放宽（容器里设 0.0.0.0）。
 * - 非法值启动即抛错（不静默回落），避免"以为是容器可达、其实只绑回环"的事故。
 * - host 不进 config.json / settings 端点：它是启动期 env 覆盖项。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOST, loadConfig, parseHost, readSettings } from '../src/config.js';

let cfgDir: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-host-cfg-'));
  process.env.APPDATA = cfgDir;
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('AGENTBOARD_HOST', () => {
  it('不设 env：默认仍只监听 127.0.0.1', () => {
    const config = loadConfig({});
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.host).toBe('127.0.0.1');
  });

  it('显式设 0.0.0.0：监听全部接口', () => {
    expect(loadConfig({ AGENTBOARD_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('接受 IPv6 与主机名', () => {
    expect(loadConfig({ AGENTBOARD_HOST: '::' }).host).toBe('::');
    expect(loadConfig({ AGENTBOARD_HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ AGENTBOARD_HOST: 'localhost' }).host).toBe('localhost');
    expect(loadConfig({ AGENTBOARD_HOST: ' agentboard.local ' }).host).toBe('agentboard.local');
  });

  it('非法值明确报错（不静默回落 127.0.0.1）', () => {
    expect(() => loadConfig({ AGENTBOARD_HOST: '999.1.1.1' })).toThrow(/AGENTBOARD_HOST 非法/);
    expect(() => loadConfig({ AGENTBOARD_HOST: 'bad host!' })).toThrow(/AGENTBOARD_HOST 非法/);
    expect(() => loadConfig({ AGENTBOARD_HOST: 'http://0.0.0.0' })).toThrow(/AGENTBOARD_HOST 非法/);
  });

  it('空值等同未设置', () => {
    expect(loadConfig({ AGENTBOARD_HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig({ AGENTBOARD_HOST: '   ' }).host).toBe('127.0.0.1');
  });

  it('host 不落 config.json、不出现在 settings 端点读侧', () => {
    loadConfig({ AGENTBOARD_HOST: '0.0.0.0' });
    expect(readSettings()).not.toHaveProperty('host');
  });

  it('parseHost 边界', () => {
    expect(parseHost('127.0.0.1')).toBe('127.0.0.1');
    expect(parseHost('0.0.0.0')).toBe('0.0.0.0');
    expect(parseHost('fe80::1')).toBe('fe80::1');
    expect(parseHost('')).toBeNull();
    expect(parseHost('   ')).toBeNull();
    expect(parseHost('127.0.0.1:8787')).toBeNull();
    expect(parseHost('-bad.host')).toBeNull();
  });
});
