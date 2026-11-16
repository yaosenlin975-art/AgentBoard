'use strict';

/**
 * 进程 / 端口 / HTTP 观测工具（只读，不结束任何非自己启动的进程）。
 *
 * 残留进程判定必须按「进程树」而不是按名字：本机常年跑着别的 node.exe
 * （例如看板服务 PID 18716），按名字判会把别人的进程算成自己的残留。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');

/** 跑一条 PowerShell 命令并返回 stdout（一次性，无 shell 注入面：命令由本文件常量拼出） */
function powershell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    ps.stdout.on('data', (c) => {
      out += c.toString('utf8');
    });
    ps.stderr.on('data', (c) => {
      err += c.toString('utf8');
    });
    ps.once('error', reject);
    ps.once('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`powershell 退出码 ${code}：${err.trim()}`));
    });
  });
}

/**
 * 全量进程快照（PowerShell CIM）。
 * @returns {Promise<Array<{pid: number, ppid: number, name: string, commandLine: string}>>}
 */
async function snapshotProcesses() {
  const raw = await powershell(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  );
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const parsed = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    name: String(p.Name ?? ''),
    commandLine: String(p.CommandLine ?? ''),
  }));
}

/**
 * 取某个根进程的全部后代（含根）。
 * @param {Array} snapshot snapshotProcesses() 的结果
 * @param {number} rootPid
 */
function processTree(snapshot, rootPid) {
  const byParent = new Map();
  for (const p of snapshot) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = snapshot.find((p) => p.pid === pid);
    if (self) result.push(self);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}

/** 进程是否存活（0 号信号探测；Windows 上 EPERM 也算活着） */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 轮询直到 predicate 为真或超时；返回是否命中 */
async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 端口当前监听者 PID 列表（Get-NetTCPConnection；无监听返回空数组） */
async function listeningPids(port) {
  // 末尾 exit 0：Get-NetTCPConnection 查不到时会把 $LASTEXITCODE 置 1，不能当成脚本失败
  const raw = await powershell(
    `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; exit 0`,
  );
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Number(line));
}

/** GET 一个本地 URL，返回 { status, body }；连接失败返回 { status: 0, body: '' } */
function httpGet(url, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

/** 等端口上的 AgentBoard 就绪（GET /api/workspaces 返回 200 + 数组） */
async function waitAgentBoardReady(port, { timeoutMs = 40000 } = {}) {
  let last = 'none';
  const ok = await waitFor(
    async () => {
      const res = await httpGet(`http://127.0.0.1:${port}/api/workspaces`, { timeoutMs: 1500 });
      last = `status=${res.status}`;
      if (res.status !== 200) return false;
      try {
        return Array.isArray(JSON.parse(res.body));
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 300 },
  );
  return { ok, detail: last };
}

/** 读 /api/clis（服务未就绪返回 null） */
async function fetchClis(port) {
  const res = await httpGet(`http://127.0.0.1:${port}/api/clis`, { timeoutMs: 5000 });
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** 只保留 System32（受限 PATH 场景的最小可运行环境） */
function restrictedPath() {
  const winDir = process.env.SystemRoot ?? 'C:\\Windows';
  return `${winDir}\\System32;${winDir}\\System32\\Wbem`;
}

module.exports = {
  powershell,
  snapshotProcesses,
  processTree,
  isAlive,
  waitFor,
  listeningPids,
  httpGet,
  waitAgentBoardReady,
  fetchClis,
  restrictedPath,
};
