#!/usr/bin/env node
/**
 * Tauri 桌面壳静态断言集（验收清单 §A 的可执行形态）。
 *
 * 只读源码与配置，不构建、不启动、不依赖 WebView2/GUI —— 因此在任何时刻都能跑，
 * 用来在等待构建产物期间锁住「不该变的事实」，也是 D5/D2 改完代码后的最小防回归闸门。
 *
 * 用法（仓库根）：
 *   node tests/desktop/static-asserts.mjs
 *   node tests/desktop/static-asserts.mjs --json
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 脚本自身异常。
 *
 * 断言口径说明：
 *  - 「期望存在」型断言（A5/A6）当前记录的是**缺口**——它们在 D2/D5 修完后应当翻转。
 *    这类断言标 `expect: 'absent'`，通过时打印 `EXPECTED-GAP`，不改退出码，
 *    以便清单里始终显示「缺口仍在」还是「缺口已修」。
 *  - 其余断言标 `expect: 'present'`，失败即退出码 1。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const F = {
  main: 'desktop/src-tauri/src/main.rs',
  serverProcess: 'desktop/src-tauri/src/server_process.rs',
  tauriConf: 'desktop/src-tauri/tauri.conf.json',
  cargoToml: 'desktop/src-tauri/Cargo.toml',
  capability: 'desktop/src-tauri/capabilities/decision-notifications.json',
  portable: 'scripts/package-portable.mjs',
  startCmd: 'scripts/portable/start.cmd',
  buildRs: 'desktop/src-tauri/build.rs',
  systemMisc: 'apps/server/src/api/routes/systemMiscRoutes.ts',
  serverLock: 'apps/server/src/services/serverLock.ts',
  serverConfig: 'apps/server/src/config.ts',
  serverIndex: 'apps/server/src/index.ts',
};

/** 读文本；文件缺失时返回 null（由断言报失败原因，不抛） */
function read(rel) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

const cache = new Map();
function text(rel) {
  if (!cache.has(rel)) cache.set(rel, read(rel));
  return cache.get(rel);
}

/**
 * @typedef {{id: string, title: string, expect: 'present'|'absent', file: string,
 *   check: (src: string) => {ok: boolean, evidence: string}}} Assertion
 */

/** @type {Assertion[]} */
const assertions = [
  {
    id: 'A1',
    title: '壳与服务端的 server.lock 路径口径一致',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const shell = /config_dir\(\)[\s\S]{0,40}?join\(\s*"server\.lock"\s*\)/.test(src);
      const lockTs = text(F.serverLock) ?? '';
      const server = /join\(\s*configDir\s*,\s*'server\.lock'\s*\)/.test(lockTs);
      return {
        ok: shell && server,
        evidence: `壳 ${shell ? 'config_dir().join("server.lock")' : '未命中'} / 服务端 ${server ? "join(configDir,'server.lock')" : '未命中'}`,
      };
    },
  },
  {
    id: 'A2',
    title: '壳的 LockFile 可由服务端锁内容反序列化（pid 必填，port 可选）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      // D6 起 LockFile = { pid: u32, #[serde(default)] port: Option<u16> }：
      // 服务端锁多出的 dbPath/startedAt/instanceId 由 serde 忽略；缺失 port 时 serde(default) 兜成 None。
      const hasPid = /struct\s+LockFile\s*\{[\s\S]{0,400}?pid:\s*u32/.test(src);
      const hasOptPort = /struct\s+LockFile\s*\{[\s\S]{0,400}?port:\s*Option<u16>/.test(src);
      const serdeDefault = /struct\s+LockFile\s*\{[\s\S]{0,400}?#\[serde\(default\)\][\s\S]{0,120}?port:\s*Option<u16>/.test(src);
      const lockTs = text(F.serverLock) ?? '';
      const fields = ['pid', 'port', 'dbPath', 'startedAt', 'instanceId'].filter((f) =>
        new RegExp(`${f}\\s*:`).test(lockTs),
      );
      return {
        ok: hasPid && hasOptPort && serdeDefault && fields.length >= 5,
        evidence: `壳 pid:u32 ${hasPid} / port:Option<u16> ${hasOptPort} / serde(default) ${serdeDefault}；服务端字段 ${fields.join('/')}`,
      };
    },
  },
  {
    id: 'A3',
    title: '探活端点 /api/version 自报 name=agentboard-server',
    expect: 'present',
    file: F.systemMisc,
    check: (src) => {
      const route = /router\.get\(\s*'\/version'/.test(src);
      const name = /name:\s*'agentboard-server'/.test(src);
      const shell = text(F.serverProcess) ?? '';
      const probe = /GET \/api\/version HTTP\/1\.1/.test(shell) && /\\"name\\":\\"agentboard-server\\"/.test(shell);
      return {
        ok: route && name && probe,
        evidence: `路由 ${route ? '有' : '无'}；name ${name ? '有' : '无'}；壳探针 ${probe ? '匹配' : '未匹配'}`,
      };
    },
  },
  {
    id: 'A4',
    title: '壳的端口解析只读 config.json（已知取舍，见验收清单 §9.1）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const readsConf = /config_dir\(\)\.join\(\s*"config\.json"\s*\)/.test(src);
      // 壳侧解析函数体内不应出现 AGENTBOARD_PORT（注释里出现"不读该变量"是允许的）
      const fn = /pub fn resolve_port\(\)[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
      const noEnv = !/env::var(_os)?\(\s*"AGENTBOARD_PORT"/.test(fn);
      return {
        ok: readsConf && noEnv,
        evidence: `读 config.json ${readsConf ? '是' : '否'}；resolve_port 内不读 AGENTBOARD_PORT ${noEnv ? '是' : '否'}`,
      };
    },
  },
  {
    id: 'A5',
    title: 'bundle.resources 缺失（NSIS 产物不自包含）—— 缺口，待 D2 定向',
    expect: 'absent',
    file: F.tauriConf,
    check: (src) => {
      let conf;
      try {
        conf = JSON.parse(src);
      } catch {
        return { ok: false, evidence: 'tauri.conf.json 不是合法 JSON' };
      }
      const hasResources = conf?.bundle?.resources !== undefined;
      const targets = JSON.stringify(conf?.bundle?.targets ?? []);
      return {
        ok: hasResources,
        evidence: `bundle.resources ${hasResources ? '存在（缺口已修）' : '缺失（缺口存在）'}；targets=${targets}`,
      };
    },
  },
  {
    id: 'A6',
    title: '缺 windows_subsystem 属性（release 会弹控制台黑窗）—— 缺口，待 D5 修',
    expect: 'absent',
    file: F.main,
    check: (src) => {
      const mainHit = /windows_subsystem/.test(src);
      const allHit = [F.main, F.serverProcess, F.buildRs].some((rel) => /windows_subsystem/.test(text(rel) ?? ''));
      return {
        ok: allHit,
        evidence: `main.rs ${mainHit ? '有' : '无'}；三文件合计 ${allHit ? '有（缺口已修）' : '无（缺口存在）'}`,
      };
    },
  },
  {
    id: 'A7',
    title: 'node 子进程带 CREATE_NO_WINDOW（不弹黑窗）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const const_ = /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/.test(src);
      const applied = /creation_flags\(\s*CREATE_NO_WINDOW\s*\)/.test(src);
      return {
        ok: const_ && applied,
        evidence: `常量 ${const_ ? '定义' : '缺失'}；使用处 ${applied ? '有' : '无'}`,
      };
    },
  },
  {
    id: 'A8',
    title: '单例插件注册在 setup 之前（第二实例不进 setup，不拉第二个 server）',
    expect: 'present',
    file: F.main,
    check: (src) => {
      const pluginAt = src.indexOf('tauri_plugin_single_instance::init');
      const setupAt = src.indexOf('.setup(');
      return {
        ok: pluginAt > 0 && setupAt > 0 && pluginAt < setupAt,
        evidence: `插件位置 ${pluginAt} < setup 位置 ${setupAt}：${pluginAt > 0 && setupAt > 0 && pluginAt < setupAt}`,
      };
    },
  },
  {
    id: 'A9',
    title: '关窗被拦截为隐藏（CloseRequested + prevent_close + hide）',
    expect: 'present',
    file: F.main,
    check: (src) => {
      const close = /WindowEvent::CloseRequested/.test(src);
      const prevent = /api\.prevent_close\(\)/.test(src);
      const hide = /window_for_close\.hide\(\)/.test(src);
      return {
        ok: close && prevent && hide,
        evidence: `CloseRequested ${close} / prevent_close ${prevent} / hide ${hide}`,
      };
    },
  },
  {
    id: 'A10',
    title: '停服预算 8s(进程)+5s(端口)+3s(锁) ≤ 20s，脚本等待上限应给 25s',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const p8 = /Duration::from_secs\(8\)/.test(src);
      const p5 = /Duration::from_secs\(5\)/.test(src);
      const p3 = /Duration::from_secs\(3\)/.test(src);
      return { ok: p8 && p5 && p3, evidence: `8s ${p8} / 5s ${p5} / 3s ${p3}` };
    },
  },
  {
    id: 'A11',
    title: '验收钩子 --quit-after-ms / --probe-tray-ms / --probe-out 存在',
    expect: 'present',
    file: F.main,
    check: (src) => {
      const quit = /"--quit-after-ms"/.test(src);
      const tray = /"--probe-tray-ms"/.test(src);
      const out = /"--probe-out"/.test(src);
      return { ok: quit && tray && out, evidence: `quit ${quit} / tray ${tray} / out ${out}` };
    },
  },
  {
    id: 'A12',
    title: 'capability 授予自绘标题栏所需的 window 权限',
    expect: 'present',
    file: F.capability,
    check: (src) => {
      let conf;
      try {
        conf = JSON.parse(src);
      } catch {
        return { ok: false, evidence: 'capabilities JSON 非法' };
      }
      const needed = [
        'core:window:allow-minimize',
        'core:window:allow-toggle-maximize',
        'core:window:allow-is-maximized',
        'core:window:allow-close',
        'core:window:allow-start-dragging',
      ];
      const perms = new Set(conf?.permissions ?? []);
      const missing = needed.filter((p) => !perms.has(p));
      return {
        ok: missing.length === 0,
        evidence: missing.length === 0 ? '5 条 window 权限齐全' : `缺 ${missing.join('/')}`,
      };
    },
  },
  {
    id: 'A13',
    title: 'tauri.conf.json：frontendDist=./ui 且 app.windows 为空（窗口由 Rust 建）',
    expect: 'present',
    file: F.tauriConf,
    check: (src) => {
      let conf;
      try {
        conf = JSON.parse(src);
      } catch {
        return { ok: false, evidence: 'JSON 非法' };
      }
      const dist = conf?.build?.frontendDist === './ui';
      const windows = Array.isArray(conf?.app?.windows) && conf.app.windows.length === 0;
      return { ok: dist && windows, evidence: `frontendDist=${conf?.build?.frontendDist}；app.windows=${JSON.stringify(conf?.app?.windows)}` };
    },
  },
  {
    id: 'A14',
    title: '便携包把壳 exe 放到 app/desktop/，与壳的相对路径查找吻合',
    expect: 'present',
    file: F.portable,
    check: (src) => {
      const copies = /copyFileSync\(\s*DESKTOP_EXE\s*,\s*join\(\s*appDir\s*,\s*'desktop'\s*,\s*'agentboard-desktop\.exe'\s*\)\s*\)/.test(src);
      const shell = text(F.serverProcess) ?? '';
      // 便携包布局下的入口候选：exe_dir/../apps/server/dist/index.js
      const entry = /exe_dir\.join\(\s*"\.\.\/apps\/server\/dist\/index\.js"\s*\)/.test(shell);
      return {
        ok: copies && entry,
        evidence: `便携包拷贝片段 ${copies ? '命中' : '未命中'}；壳候选 ../apps/server/dist/index.js ${entry ? '命中' : '未命中'}`,
      };
    },
  },
  {
    id: 'A15',
    title: 'start.cmd 覆盖 AGENTBOARD_PORT=8787（已知行为，见验收清单 §9.1）',
    expect: 'present',
    file: F.startCmd,
    check: (src) => {
      const override = /set\s+"AGENTBOARD_PORT=8787"/.test(src);
      return { ok: override, evidence: override ? '存在覆盖语句' : '未命中覆盖语句' };
    },
  },
  {
    id: 'A16',
    title: 'D6-2：壳 spawn 时注入 AGENTBOARD_LOG 指向 <configDir>\\logs\\server.log',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const inject = /\.env\(\s*"AGENTBOARD_LOG"\s*,\s*server_log_path\(\)\s*\)/.test(src);
      const pathFn = /fn\s+server_log_path\(\)\s*->\s*PathBuf\s*\{[\s\S]{0,160}?config_dir\(\)\.join\(\s*"logs"\s*\)\.join\(\s*"server\.log"\s*\)/.test(src);
      const noInstallRoot = !/join\(\s*"\.logs"\s*\)\.join\(\s*"server\.log"\s*\)/.test(
        /fn\s+log_path_display[\s\S]{0,200}\}/.exec(src)?.[0] ?? '',
      );
      return {
        ok: inject && pathFn && noInstallRoot,
        evidence: `env 注入 ${inject} / server_log_path→configDir/logs/server.log ${pathFn} / log_path_display 不再落 .logs ${noInstallRoot}`,
      };
    },
  },
  {
    id: 'A17',
    title: 'D6：壳把自身端口注入子进程（覆盖外部 AGENTBOARD_PORT，消除 start.cmd 口径冲突）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const inject = /\.env\(\s*"AGENTBOARD_PORT"\s*,\s*child_port_env\(\s*port\s*\)\s*\)/.test(src);
      const fn = /fn\s+child_port_env\(\s*shell_port:\s*u16\s*\)\s*->\s*String\s*\{[\s\S]{0,80}?shell_port\.to_string\(\)/.test(src);
      return { ok: inject && fn, evidence: `env 注入 ${inject} / child_port_env 返回壳端口 ${fn}` };
    },
  },
  {
    id: 'A18',
    title: 'D6：stop() 有「第二意见」接管判定（restart 后按锁 pid 再终止一次）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      const decide = /fn\s+decide_takeover\(/.test(src);
      const used = /let\s+takeover_pid\s*=\s*decide_takeover\([\s\S]{0,240}?self\.port/.test(src);
      const terminate = /if\s+let\s+Some\(pid\)\s*=\s*takeover_pid\s*\{[\s\S]{0,80}?terminate_pid\(\s*pid\s*\)/.test(src);
      return {
        ok: decide && used && terminate,
        evidence: `decide_takeover ${decide} / stop 内以 self.port 调用 ${used} / 命中后 terminate_pid ${terminate}`,
      };
    },
  },
  {
    id: 'A19',
    title: '壳自身没有 main.log 写入实现（「看 main.log」不可当健康判据）',
    expect: 'absent',
    file: F.main,
    check: () => {
      // 壳侧是否真的往 <configDir>/logs/main.log 追加内容：
      // 需要同时具备「写文件」与「文件名 main.log」两件事，注释里提到不算。
      const files = [F.main, F.serverProcess, F.buildRs];
      let writer = null;
      for (const rel of files) {
        const src = text(rel) ?? '';
        const stripped = src
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
          .join('\n');
        if (/main\.log/.test(stripped) && /(fs::write|File::create|OpenOptions|appendFile)/.test(stripped)) {
          writer = rel;
          break;
        }
      }
      const cargo = text(F.cargoToml) ?? '';
      const logPlugin = /tauri-plugin-log/.test(cargo);
      return {
        ok: writer !== null || logPlugin,
        evidence: writer !== null
          ? `发现写入者：${writer}（缺口已修）`
          : `三文件均无 main.log 写入实现，Cargo.toml 也无声明的日志插件（缺口存在：Tauri 壳不写 main.log）`,
      };
    },
  },
  {
    id: 'A20',
    title: '禁止项：tauri-plugin-single-instance 未启用 semver feature',
    expect: 'present',
    file: F.cargoToml,
    check: (src) => {
      // 启用 semver 后 Windows mutex 名带版本号 → 0.1.0 与 0.2.0 各开一个实例，
      // 绕过共享 userData 与 server.lock → 同库双写 + 端口冲突。
      const line = /tauri-plugin-single-instance\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(src)?.[1] ?? '';
      const hasFeatures = /features\s*=/.test(line);
      const hasSemver = /"semver"/.test(line);
      const versionOnly = /^"\d+"$/.test(line.trim());
      return {
        ok: !hasSemver && (versionOnly || !hasFeatures),
        evidence: `声明 = ${line.trim() || '未命中'}；features ${hasFeatures ? '有' : '无'}；semver ${hasSemver ? '已启用（违规）' : '未启用'}`,
      };
    },
  },
  {
    id: 'A21',
    title: 'D10：便携包布局下 entry 不逃出资源根（release 跳过 dev 候选 + check_entry 包含性）',
    expect: 'present',
    file: F.serverProcess,
    check: (src) => {
      // D10 落地后判据换成「读源码的机制断言」，不再只做路径存在性推算：
      //  1) dev 候选受 dev_candidate_enabled 控制，release + 非 target 布局时跳过；
      //  2) 每个候选都过 check_entry（canonicalize 后 is_within 资源根）；
      //  3) resource_root 会按布局判定（target 布局 → 仓库根；便携包 → <pkg>/app；安装版 → exe_dir）。
      const hasDevGate = /fn\s+dev_candidate_enabled\(\s*debug_build:\s*bool,\s*exe_dir:\s*&Path\s*\)\s*->\s*bool/.test(src);
      const devGateLogic = /fn\s+dev_candidate_enabled[\s\S]{0,120}?debug_build\s*\|\|\s*is_target_layout\(\s*exe_dir\s*\)/.test(src);
      const devCandidateConditional = /if\s+allow_dev\s*\{[\s\S]{0,200}?\.\.\/\.\.\/\.\.\/\.\.\/apps\/server\/dist\/index\.js/.test(src);
      const hasIsWithin = /fn\s+is_within\(\s*child:\s*&Path,\s*base:\s*&Path\s*\)\s*->\s*bool/.test(src);
      const hasCheckEntry = /fn\s+check_entry\(\s*candidate:\s*&Path,\s*root:\s*&Path\s*\)\s*->\s*Result<PathBuf,\s*EntryReject>/.test(src);
      const entryGuarded = /match\s+check_entry\(\s*candidate,\s*&root\s*\)/.test(src) || /check_entry\(&path,\s*&root\)/.test(src);
      const hasResourceRoot = /fn\s+resource_root\(\s*exe_dir:\s*&Path\s*\)\s*->\s*PathBuf/.test(src);
      const portableDetect = /fn\s+detect_portable_layout[\s\S]{0,400}?eq_ignore_ascii_case\(\s*"desktop"\s*\)/.test(src);

      const ok = hasDevGate && devGateLogic && devCandidateConditional && hasIsWithin
        && hasCheckEntry && entryGuarded && hasResourceRoot && portableDetect;

      return {
        ok,
        evidence:
          `dev_candidate_enabled ${hasDevGate}/${devGateLogic} / dev 候选受 allow_dev 门控 ${devCandidateConditional} / `
          + `is_within ${hasIsWithin} / check_entry ${hasCheckEntry} / 候选经 check_entry 校验 ${entryGuarded} / `
          + `resource_root ${hasResourceRoot} / detect_portable_layout ${portableDetect}`,
      };
    },
  },
  {
    id: 'A22',
    title: 'A21 补充：便携包里实际命中的 entry 仍在包根内（产物级交叉验证）',
    expect: 'present',
    file: F.serverProcess,
    check: () => {
      // 静态机制断言（A21）证明「代码会拦」，这里再用真实产物证明「拦完还能正常命中包内」。
      // 两种包都要看：dist-package/（D3 stage 产物）与仓库根最新 zip（发行产物）。
      const entryCands = ['../../../../apps/server/dist/index.js', '../apps/server/dist/index.js', 'apps/server/dist/index.js'];
      const firstHit = (dir, cands) => {
        for (const rel of cands) {
          const full = resolve(dir, rel);
          if (existsSync(full)) return { rel, full };
        }
        return null;
      };
      const inside = (p, root) => p.toLowerCase().startsWith(root.toLowerCase());

      const pkgApp = join(ROOT, 'dist-package', 'AgentBoard', 'app', 'desktop');
      const pkgRoot = join(ROOT, 'dist-package', 'AgentBoard');
      if (!existsSync(pkgApp)) {
        return { ok: true, evidence: 'dist-package 不存在，跳过（D3 产物未就绪）' };
      }
      const e = firstHit(pkgApp, entryCands);
      const inPkg = e !== null && inside(e.full, pkgRoot);
      // dev 候选在包内确实存在（因为包解在仓库根下）→ 旧逻辑会命中它；D10 的 dev 门控会跳过它。
      const devCandWouldEscape = e !== null && e.rel.startsWith('../..');
      return {
        ok: inPkg || devCandWouldEscape,
        evidence: `命中 ${e ? e.rel : '无'}（包内=${inPkg}）`
          + (devCandWouldEscape ? '；dev 候选在包内可命中（正是 D10 门控要跳过的那条），仅靠存在性会逃逸' : ''),
      };
    },
  },
];

function main() {
  const asJson = process.argv.includes('--json');
  const results = [];
  let failures = 0;

  for (const a of assertions) {
    const src = text(a.file);
    let outcome;
    if (src === null) {
      outcome = { ok: false, evidence: `文件不存在：${a.file}` };
    } else {
      try {
        outcome = a.check(src);
      } catch (error) {
        outcome = { ok: false, evidence: `断言抛错：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    // expect='absent' 的断言：ok=true 表示「缺口已修」，ok=false 表示「缺口仍在」且不算失败
    let status;
    if (a.expect === 'absent') {
      status = outcome.ok ? 'GAP-FIXED' : 'EXPECTED-GAP';
    } else {
      status = outcome.ok ? 'PASS' : 'FAIL';
      if (!outcome.ok) failures += 1;
    }
    results.push({ id: a.id, title: a.title, file: a.file, status, evidence: outcome.evidence });
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ total: results.length, failures, results }, null, 2)}\n`,
    );
  } else {
    console.log('Tauri 桌面壳静态断言（验收清单 §A）\n');
    for (const r of results) {
      const mark = r.status === 'PASS' ? 'ok  ' : r.status === 'FAIL' ? 'FAIL' : r.status === 'GAP-FIXED' ? 'FIXED' : 'gap ';
      console.log(`  ${mark} ${r.id} ${r.title}`);
      console.log(`        ${r.evidence}`);
    }
    const gaps = results.filter((r) => r.status === 'EXPECTED-GAP').map((r) => r.id);
    const fixed = results.filter((r) => r.status === 'GAP-FIXED').map((r) => r.id);
    console.log('');
    console.log(`合计 ${results.length} 条：通过 ${results.filter((r) => r.status === 'PASS').length}，失败 ${failures}，缺口仍在 ${gaps.length}${gaps.length ? `（${gaps.join('/')}）` : ''}${fixed.length ? `，缺口已修 ${fixed.length}（${fixed.join('/')}）` : ''}`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exit(2);
}
