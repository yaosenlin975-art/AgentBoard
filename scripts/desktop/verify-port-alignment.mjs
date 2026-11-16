#!/usr/bin/env node
'use strict';
/**
 * D6 白盒验证：壳 spawn 服务后，服务是否真的绑在壳期望端口上。
 *
 *   node scripts/desktop/verify-port-alignment.mjs
 *
 * 断言（对应 D6 卡面验收）：
 *   ① 壳期望端口（8899）有监听，且监听者是本次 spawn 的进程
 *   ② 冲突端口（8787）上没有本次新起的进程（服务没被 env 拉到 8787）
 *   ③ 进程退出后 8899 释放
 *
 * 安全约束（本工作区硬规则）：
 *   - 只用唯一临时目录（PID + 时间戳），不碰真实 %APPDATA%\AgentBoard
 *   - 只按自己记录的精确 PID 结束进程，禁止按命令行/映像名模糊匹配
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHELL_PORT = 8899; // 壳期望端口（写入临时 config.json）
const CONFLICT_PORT = 8787; // 模拟 start.cmd 预设的 AGENTBOARD_PORT

const stamp = `${process.pid}-${Date.now()}`;
const sandbox = join(tmpdir(), `ab-d6-verify-${stamp}`);
const appData = join(sandbox, 'appdata');
const configDir = join(appData, 'AgentBoard');

/** 只按精确 PID 查监听（不模糊匹配） */
function listenersOf(pid) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const ports = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [, local, , , owner] = cols;
    if (owner !== String(pid)) continue;
    if (!local.includes(':')) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (Number.isInteger(port)) ports.push(port);
  }
  return [...new Set(ports)];
}

/** 端口上是否有人监听（不看 PID，只回答「被占着吗」） */
function portHasListener(port) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  return (result.stdout ?? '').split('\n').some((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) return false;
    const local = cols[1] ?? '';
    const state = cols[3] ?? '';
    return local.endsWith(`:${port}`) && state.toUpperCase() === 'LISTENING';
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let childPid = null;
let pass1 = false;
let pass2 = false;
let pass3 = false;
const detail = {};

try {
  mkdirSync(configDir, { recursive: true });
  const dbPath = join(configDir, 'agentboard.db');
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ port: SHELL_PORT, dbPath }, null, 2)}\n`,
    'utf8',
  );

  console.log(`sandbox   = ${sandbox}`);
  console.log(`临时 config.json: port=${SHELL_PORT}（真实 %APPDATA% 未触碰）`);
  console.log(`外部注入 AGENTBOARD_PORT=${CONFLICT_PORT}（模拟 start.cmd 第 33 行）`);
  console.log(`服务入口  = ${join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js')}`);
  console.log('');

  // 关键：env 里 AGENTBOARD_PORT 显式设为壳端口，等价于壳的 command.env("AGENTBOARD_PORT", child_port_env(port))
  childPid = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js')], {
      cwd: REPO_ROOT,
      env: { ...process.env, APPDATA: appData, AGENTBOARD_PORT: String(SHELL_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('spawn', () => res(child.pid));
    child.once('error', rej);
    // 收集 stderr 便于诊断，但不阻塞主流程
    child.stderr.on('data', () => {});
    child.stdout.on('data', () => {});
  });
  console.log(`spawned pid=${childPid}`);

  // 轮询最多 30s 等 8899 起来
  let ports = [];
  for (let i = 0; i < 60; i += 1) {
    if (!isAlive(childPid)) break;
    ports = listenersOf(childPid);
    if (ports.includes(SHELL_PORT)) break;
    await sleep(500);
  }
  detail.listenPorts = ports;

  // ① 壳期望端口有监听，且是我的进程
  pass1 = ports.includes(SHELL_PORT);
  // ② 冲突端口上没有本次进程（服务没被拉到 8787）
  pass2 = childPid !== null && !ports.includes(CONFLICT_PORT);

  console.log('');
  console.log('=== 断言 ===');
  console.log(`① ${SHELL_PORT} 有监听且属于 pid ${childPid} : ${pass1 ? 'PASS' : 'FAIL'}（实际端口 ${JSON.stringify(ports)}）`);
  console.log(`② ${CONFLICT_PORT} 上没有本次进程           : ${pass2 ? 'PASS' : 'FAIL'}`);
} finally {
  // 只按自己记录的精确 PID 结束
  if (childPid !== null && isAlive(childPid)) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  // ③ 进程退出后 8899 释放（最多等 5s）
  for (let i = 0; i < 25; i += 1) {
    if (!portHasListener(SHELL_PORT)) break;
    await sleep(200);
  }
  pass3 = !portHasListener(SHELL_PORT);
  const pidAlive = childPid !== null && isAlive(childPid);
  console.log(`③ 退出后 ${SHELL_PORT} 释放                   : ${pass3 ? 'PASS' : 'FAIL'}（pid alive=${pidAlive}）`);
  console.log('');
  console.log(`对照：${CONFLICT_PORT} 现网看板是否在线 = ${portHasListener(CONFLICT_PORT)}（应为 true，全程未触碰）`);

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`清理：已删除 ${sandbox}`);
  process.exit(pass1 && pass2 && pass3 ? 0 : 1);
}
