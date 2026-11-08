/**
 * system 杂域 REST（CR-10d 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：GET /api/version（SERVER-SINGLETON/RESTART-HARDENING 自报）、GET /api/skills、
 * GET /api/clis 与 /api/clis/:id/models、POST/GET /api/system/center-snapshot/*（STORE-6 中心库快照）、
 * POST /api/system/pick-folder（Windows 原生文件夹选择，模块级并发守卫随域迁入）。
 * 注意与 ../systemRoutes.ts（createSystemRouter：/system/restart 重启服务）分工：本文件是
 * version/skills/clis/center-snapshot/pick-folder 杂域，挂载点在 /system/restart 所属路由之前，
 * 两者无同路径冲突。
 */
import { spawn } from 'node:child_process';
import { Router } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { SERVER_VERSION } from '../../version.js';
import { resolveProxyEnv } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { listOpenWorkspaceDbs } from '../../db/resolver.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { centerSnapshotDir, exportCenterSnapshot, validateCenterSnapshot } from '../../services/centerSnapshot.js';
import { listSkills } from '../../services/skills.js';
import { getCachedClis } from '../../services/cliDetect.js';

export interface SystemMiscRouterDeps {
  /** 中心库：center-snapshot 的源库 */
  db: Db;
  getAdapter: (cliId: string) => AgentAdapter;
  /** DB-2B：当前进程实际使用的库路径（缺省 db.name；测试注入） */
  currentDbPath: string | null;
  /** SERVER-SINGLETON：实例标识（`/api/version` 输出；测试可注入） */
  instance?: { instanceId: string; dbPath: string; startedAt: number };
  /** 已安装技能根目录（仅测试注入；生产固定 ~/.agents/skills） */
  skillsRoot?: string;
}

// ---- POST /api/system/pick-folder（Windows 原生文件夹选择） ----

/** pick-folder 并发守卫：同一时刻只允许一个选择窗口（finally 复位） */
let pickFolderInFlight = false;

/**
 * PowerShell 弹 FolderBrowserDialog：单引号 PS 字符串、无双引号，-Command 参数整体
 * 经 spawn 参数数组传递不经 shell；OK 时 stdout 只输出 SelectedPath（UTF-8，无换行）。
 */
const PICK_FOLDER_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description='选择工作空间文件夹'",
  '$d.ShowNewFolderButton=$true',
  'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}',
].join('; ');

function pickFolderErrorDetail(stderr: string, fallback: string): string {
  const firstLine = stderr.trim().split(/\r?\n/, 1)[0];
  return (firstLine && firstLine !== '' ? firstLine : fallback).slice(0, 200);
}

/** spawn powershell 弹窗；选中 → 路径，取消/无输出 → null，spawn 或脚本失败 → reject */
function pickFolderViaPowerShell(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', PICK_FOLDER_PS_SCRIPT],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(
        new ApiError(
          500,
          'PICK_FOLDER_FAILED',
          `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, err.message)}`,
        ),
      );
    });
    child.on('close', (code) => {
      const picked = stdout.trim();
      if (picked !== '') {
        resolve(picked);
        return;
      }
      if (code !== 0) {
        reject(
          new ApiError(
            500,
            'PICK_FOLDER_FAILED',
            `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, `exit code ${code}`)}`,
          ),
        );
        return;
      }
      resolve(null); // 用户取消（无输出）
    });
  });
}

export function createSystemMiscRouter(deps: SystemMiscRouterDeps): Router {
  const { db, getAdapter, currentDbPath } = deps;
  const router = Router();

  // ---- version ----
  // pid：RESTART-HARDENING —— 客户端据它区分「新进程已接管」与「已回退旧进程」，端口占用检查也靠它识别自身
  router.get('/version', (_req, res) => {
    // PROXY-ENV：出站代理是否生效（只读、脱敏）。客户端/诊断脚本据此判断「为什么外网请求超时」
    const proxy = resolveProxyEnv(process.env);
    res.json({
      name: 'agentboard-server',
      version: SERVER_VERSION,
      pid: process.pid,
      // SERVER-SINGLETON：判定「端口上的实例是不是同一个 DB 的同一个进程」
      instance_id: deps.instance?.instanceId ?? null,
      db_path: deps.instance?.dbPath ?? currentDbPath,
      started_at: deps.instance?.startedAt ?? null,
      proxy_env: { enabled: proxy.enabled, proxy_var: proxy.proxy_var, proxy_host: proxy.proxy_host, node_env_proxy: proxy.node_env_proxy },
      // STORE-1（M1）：排障要能看出「本实例服务哪些库」——中心库 + 当前已打开的工作区库
      db_scope: { center_db_path: deps.instance?.dbPath ?? currentDbPath, localized_open: listOpenWorkspaceDbs() },
    });
  });

  // ---- 已安装技能（只读、固定根、不接受路径参数）----
  router.get('/skills', (_req, res) => {
    res.json(listSkills({ root: deps.skillsRoot }));
  });

  // ---- system ----
  /**
   * STORE-6：中心库全局快照（工作区注册表 / 成员 / 账号与签到元数据 / scope=common 知识页及历史）。
   * 落在中心库同级的 center-snapshot/；账号引用一律 ***（导出后自检，防泄露）。
   */
  router.post('/system/center-snapshot/export', (_req, res) => {
    res.json(exportCenterSnapshot({ db, centerDbPath: currentDbPath ?? db.name }));
  });
  /** STORE-6：只读校验中心库快照（manifest / 哈希 / 行数 / 脱敏自检） */
  router.get('/system/center-snapshot/validate', (_req, res) => {
    const checked = validateCenterSnapshot(centerSnapshotDir(currentDbPath ?? db.name));
    res.json({ ok: true, dir: checked.dir, manifest: checked.manifest, tables: checked.tables });
  });

  // 原生文件夹选择（Windows PowerShell FolderBrowserDialog）；同一时刻仅允许一个窗口
  router.post('/system/pick-folder', async (_req, res) => {
    if (pickFolderInFlight) {
      throw new ApiError(409, 'PICK_FOLDER_BUSY', '已有选择窗口打开');
    }
    pickFolderInFlight = true;
    try {
      res.json({ path: await pickFolderViaPowerShell() });
    } finally {
      pickFolderInFlight = false;
    }
  });

  // ---- clis ----
  router.get('/clis', (_req, res) => {
    res.json(getCachedClis());
  });

  router.get('/clis/:id/models', async (req, res) => {
    let adapter: AgentAdapter;
    try {
      adapter = getAdapter(req.params.id!);
    } catch {
      throw new NotFoundError(`未知 CLI: ${req.params.id}`);
    }
    res.json(await adapter.listModels());
  });

  return router;
}
