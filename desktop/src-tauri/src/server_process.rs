//! 【DESKTOP-1】server 进程编排：定位 node / 入口、健康探活、拉起、退出时停服并清理 `server.lock`。
//!
//! 进程模型（设计 §8.2）：**壳与 server 分离**。壳只负责生命周期，业务全部由独立的 node 进程处理；
//! 因此不涉及 Tauri/WebView2 内置运行时与 better-sqlite3 的 ABI 问题，也不把 server 跑进 WebView。
//!
//! 替换点（DESKTOP-2 便携包接线时只需要改下面两个候选列表）：
//! - `resolve_server_entry`：仓库内 = `apps/server/dist/index.js`；便携包 = `<stage>/app/apps/server/dist/index.js`
//! - `resolve_node`：仓库内 = PATH 上的 `node`；便携包 = `<stage>/runtime/node.exe`
//!
//! 平台：仅 Windows 实现。macOS（WKWebView、菜单栏托盘、darwin 版 node）留给 DESKTOP-3，
//! 本文件与壳层只保留配置/接口注释，不写实现代码。

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// 端口默认值：与 `apps/server/src/config.ts` 的 `DEFAULT_PORT` 保持一致。
/// 实际端口在启动时由 `resolve_port()` 从 `<configDir>/config.json` 读取（CR-6），读不到/非法时退回本值。
pub const DEFAULT_PORT: u16 = 8787;
/// 监听地址：与 server 默认一致（只监听回环）。
pub const HOST: &str = "127.0.0.1";

/// 窗口加载的地址（同源、无自定义协议、不改任何 API 契约）。
pub fn base_url(port: u16) -> String {
    format!("http://{HOST}:{port}")
}

/// 从 `<configDir>/config.json` 解析 port（CR-6）：与 server 端 `mergeValidFields` 同口径（整数且 >0）；
/// 上界取 u16（`SocketAddr` 解析所需，也是 server 实际可监听范围）。非法/缺失/损坏返回 None，由调用方退回默认。
fn parse_config_port(raw: &str) -> Option<u16> {
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    match parsed.get("port").and_then(|value| value.as_u64()) {
        Some(port) if (1..=u16::MAX as u64).contains(&port) => Some(port as u16),
        _ => None,
    }
}

/// 壳启动时的服务端口：读 `%APPDATA%\AgentBoard\config.json` 的 `port`；读不到或非法退回 8787。
/// 注：server 端 `AGENTBOARD_PORT` 环境变量可临时覆盖端口，壳侧不读该变量（卡面口径只读 config.json）。
pub fn resolve_port() -> u16 {
    let path = config_dir().join("config.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| parse_config_port(&raw))
        .unwrap_or(DEFAULT_PORT)
}

/// 命令行创建标志：CREATE_NO_WINDOW，避免 node 子进程弹出控制台黑窗。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 壳拉起的 server 句柄。
pub struct ServerHandle {
    /// `None` 表示服务在壳启动前就已经在跑（外部实例）：壳只复用，退出时不终止它。
    child: Option<Child>,
    /// 本次启动使用的端口（停服后等端口释放用）。
    port: u16,
}

/// `stop()` 的结果，区分「停了谁」，供调用方与验收判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// 停掉了壳自己 spawn 的子进程。
    StoppedChild { pid: u32 },
    /// 子进程句柄已失效，按 `server.lock` 里的当前 pid 停掉了接管者（服务自重启换 pid 后）。
    StoppedTakeover { pid: u32 },
    /// 什么都没停：外部实例复用（child=None），或没有可停的进程。
    NothingToStop,
}

impl ServerHandle {
    /// 退出时停服。
    ///
    /// Windows 上 Node 的 SIGINT/SIGTERM 处理器无法跨进程投递（`Child::kill` 走 TerminateProcess，
    /// 不会触发 `process.on('exit')`），所以壳按「终止进程 + 壳侧补删锁」收尾：
    /// 1. 终止子进程并等待其真正消失；
    /// 2. 补一次「锁的第二意见」：`POST /api/system/restart` 会让服务换 pid 并接管 `server.lock`，
    ///    此时壳手里的 `Child` 是死句柄。若锁里是**另一个存活的 pid** 且端口对得上，按该 pid 终止接管者；
    /// 3. 等待端口不再响应 `/api/version`；
    /// 4. 删除「本次终止的那个 pid 写入的锁」或「持有者已死的陈旧锁」；持有者仍活着时一律不碰。
    ///
    /// 接管者二次终止只在本壳**确实 spawn 过**服务（`child.is_some()`）时执行：
    /// 外部实例（`child=None`）的复用语义不变——壳不终止它，也不碰它的锁。
    ///
    /// 这样退出后不会留下孤儿进程或陈旧锁，也不做「按名字杀 node」这类链式暴力清理。
    pub fn stop(&mut self) -> StopOutcome {
        let Some(mut child) = self.child.take() else {
            // 外部实例：壳只复用，退出时不终止它，也不碰它的锁。
            return StopOutcome::NothingToStop;
        };
        let child_pid = child.id();
        let _ = child.kill();

        // 等待进程退出：最多 8s，超时再补一次 kill（避免留下僵尸句柄）。
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        thread::sleep(Duration::from_millis(200));
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        drop(child);

        // 第二意见：restart 之后锁里是新 pid，且它仍在监听本端口。
        // 只在「锁 pid ≠ 子进程 pid」且「该 pid 存活」且「锁里 port 是本壳端口」时接管终止。
        let takeover_pid = decide_takeover(
            read_lock_info(&server_lock_path()),
            child_pid,
            self.port,
            is_pid_alive,
        );
        if let Some(pid) = takeover_pid {
            terminate_pid(pid);
        }

        // 端口应随进程消失；给 Windows 最多 5s 释放监听。
        let deadline = Instant::now() + Duration::from_secs(5);
        while is_healthy(Duration::from_millis(400), self.port) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(200));
        }

        // 删锁：优先按「实际终止的那个 pid」——接管者被停后它的锁就是可删的。
        let terminated_pid = takeover_pid.unwrap_or(child_pid);
        remove_lock_owned_by(terminated_pid);

        match takeover_pid {
            Some(pid) => StopOutcome::StoppedTakeover { pid },
            None => StopOutcome::StoppedChild { pid: child_pid },
        }
    }
}

/// 子进程 `AGENTBOARD_PORT` 的取值：**永远等于壳解析出的端口**。
///
/// 背景（D6）：`scripts/portable/start.cmd` 在调用壳**之前**就 `set "AGENTBOARD_PORT=8787"`，
/// 而壳只读 `config.json`（`resolve_port`）。两端对同一变量的态度不一致：
/// - 壳探 `config.json` 的端口（如 8899）
/// - 服务读环境变量且 env 优先于 `config.json`（`apps/server/src/config.ts` 的 `loadConfig`）→ 绑 8787
/// 于是壳永远探不到自己拉起的服务，60s 后假超时，而服务在 8787 继续跑成孤儿进程。
///
/// 修法：spawn 时显式把 `AGENTBOARD_PORT` 覆盖为壳端口，强制两端一致。
///
/// 为什么是「显式对齐」而不是「删除该变量」：`config.ts` 明确支持用 `AGENTBOARD_PORT`
/// 临时改端口（注释写的是「不写回 config.json」），删除会让用户的环境变量静默失效；
/// 对齐既消除冲突，又保住「服务监听端口 == 壳探测端口」这个不变量。
fn child_port_env(shell_port: u16) -> String {
    shell_port.to_string()
}

/// 外部传入的 `AGENTBOARD_PORT`（若存在且与壳端口不同），用于在错误文案里点明「被对齐过」。
fn ambient_port_mismatch(shell_port: u16) -> Option<String> {
    parse_ambient_port(env::var("AGENTBOARD_PORT").ok().as_deref(), shell_port)
}

/// `ambient_port_mismatch` 的纯函数内核（可单测，不读真实环境）。
fn parse_ambient_port(raw: Option<&str>, shell_port: u16) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = trimmed.parse::<u16>().ok()?;
    if parsed == shell_port {
        return None;
    }
    Some(trimmed.to_string())
}

/// 确保服务在跑：已健康则复用；否则用 node 拉起 `apps/server/dist/index.js` 并等待健康检查通过。
///
/// 单例口径：壳自身由 `tauri-plugin-single-instance` 保证唯一；server 由 `server.lock` 保证唯一。
/// 因此第二个壳不会走到这里，而这里若发现目标端口已健康，也不会再起第二个 server 进程。
pub fn ensure_server(port: u16) -> Result<ServerHandle, String> {
    if is_healthy(Duration::from_millis(1200), port) {
        return Ok(ServerHandle { child: None, port });
    }

    let entry = resolve_server_entry()?;
    let node = resolve_node();
    let cwd = repo_root_for(&entry);

    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .current_dir(&cwd)
        // D6：显式对齐端口，不让外部 AGENTBOARD_PORT 把服务带到别的端口上
        .env("AGENTBOARD_PORT", child_port_env(port))
        // D6-2：服务日志落 APPDATA，不在安装根产生 .logs（卸载残留）
        .env("AGENTBOARD_LOG", server_log_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动服务进程（{}）：{error}", node.display()))?;
    let child_pid = child.id();

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if is_healthy(Duration::from_millis(1200), port) {
            return Ok(ServerHandle { child: Some(child), port });
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "服务进程启动后立即退出（{status}）。\n{}",
                startup_diagnostics(port, child_pid, &entry)
            ));
        }
        if Instant::now() >= deadline {
            // 不静默 kill：先记下要停的 PID，杀掉后在文案里明确告知是否真的停干净。
            let _ = child.kill();
            let _ = child.wait();
            // 杀完再探一次端口：杀不干净时文案必须升级，不能谎报「已停止」。
            let port_still_held = is_port_listening(port);
            let head = if port_still_held {
                format!(
                    "等待服务健康检查超时（60 秒）。已尝试停止本次启动的服务进程（PID {child_pid}），\
                     但端口仍被占用，可能需要手动结束 PID {child_pid} 或占用该端口的其它进程。"
                )
            } else {
                format!("等待服务健康检查超时（60 秒）。已停止本次启动的服务进程（PID {child_pid}）。")
            };
            return Err(format!("{head}\n{}", startup_diagnostics(port, child_pid, &entry)));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// 启动失败的诊断文案：壳期望端口、被对齐掉的外部端口、入口、日志、以及人工兜底指引。
fn startup_diagnostics(port: u16, child_pid: u32, entry: &Path) -> String {
    let mut lines = vec![
        format!("壳期望端口：{port}（来自 config.json 的 port，缺省 {DEFAULT_PORT}）"),
        format!("服务地址：{}", base_url(port)),
        format!("服务入口：{}", entry.display()),
        format!("服务日志：{}", log_path_display()),
        format!("子进程 PID：{child_pid}"),
    ];
    if let Some(ambient) = ambient_port_mismatch(port) {
        lines.push(format!(
            "注意：外部环境变量 AGENTBOARD_PORT={ambient} 与壳端口 {port} 不一致，已按壳端口对齐后启动服务"
        ));
    }
    lines.push(format!(
        "排查建议：确认 {port} 端口未被其它程序占用；若你从 start.cmd 启动，请改用 start-server.cmd <端口> 显式指定端口"
    ));
    lines.join("\n")
}

/// 端口是否仍有人监听（只要能建立 TCP 连接就算，不管对方是什么程序）。
///
/// 与 `is_healthy` 的区别：这里不校验 HTTP 响应，只回答「端口还被占着吗」，
/// 用于 kill 之后判断是否真的停干净——被杀进程的 socket 有时会短暂残留。
fn is_port_listening(port: u16) -> bool {
    let Ok(addr) = format!("{HOST}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

/// 健康探活：请求 `GET /api/version`，要求 200 且 `name=agentboard-server`。
///
/// 项目没有 `/api/health` 端点（卡面已核对），`/api/version` 是现存探活口径；
/// 这里用 std TcpStream 手写最小 HTTP 请求，避免为一次探活引入 reqwest/tokio 这类重依赖。
pub fn is_healthy(timeout: Duration, port: u16) -> bool {
    let Ok(addr) = format!("{HOST}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut socket) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = socket.set_read_timeout(Some(timeout));
    let _ = socket.set_write_timeout(Some(timeout));
    let request = format!("GET /api/version HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
    if socket.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = Vec::new();
    if socket.read_to_end(&mut body).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&body);
    let status_ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    status_ok && text.contains("\"name\":\"agentboard-server\"")
}

/// 服务入口候选（第一个存在即用）。环境变量 `AGENTBOARD_SERVER_ENTRY` 供测试/排障显式指定。
fn resolve_server_entry() -> Result<PathBuf, String> {
    if let Some(raw) = env::var_os("AGENTBOARD_SERVER_ENTRY") {
        let path = PathBuf::from(raw);
        if path.exists() {
            return Ok(path);
        }
    }
    let exe_dir = current_exe_dir();
    let candidates = [
        // 开发期：desktop/src-tauri/target/{debug,release}/agentboard-desktop.exe → 仓库根
        exe_dir.join("../../../../apps/server/dist/index.js"),
        // 便携包（DESKTOP-2 接线）：<stage>/app/desktop/agentboard-desktop.exe → <stage>/app/apps/server/dist/index.js
        exe_dir.join("../apps/server/dist/index.js"),
        exe_dir.join("apps/server/dist/index.js"),
    ];
    for candidate in candidates.iter() {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "未找到服务入口 apps/server/dist/index.js（已查找：{}）。请先在仓库根构建 server（pnpm -r build）。",
        candidates[0].display()
    ))
}

/// node 候选：环境变量 `AGENTBOARD_NODE` → 包内 `runtime/node.exe` → PATH 上的 `node`。
fn resolve_node() -> PathBuf {
    if let Some(raw) = env::var_os("AGENTBOARD_NODE") {
        let path = PathBuf::from(raw);
        if path.exists() {
            return path;
        }
    }
    let exe_dir = current_exe_dir();
    let candidates = [
        exe_dir.join("node.exe"),
        // 便携包：<stage>/app/desktop/... → <stage>/runtime/node.exe
        exe_dir.join("../../runtime/node.exe"),
        exe_dir.join("../runtime/node.exe"),
        exe_dir.join("runtime/node.exe"),
    ];
    for candidate in candidates.iter() {
        if candidate.exists() {
            return candidate.clone();
        }
    }
    PathBuf::from("node")
}

fn current_exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 入口 = `<root>/apps/server/dist/index.js` → 上溯四级到仓库/包根（server 日志固定落 `<cwd>/.logs`）。
fn repo_root_for(entry: &Path) -> PathBuf {
    let mut dir = entry;
    for _ in 0..4 {
        match dir.parent() {
            Some(parent) => dir = parent,
            None => break,
        }
    }
    dir.to_path_buf()
}

/// 服务日志路径：`<configDir>/logs/server.log`，即 `%APPDATA%\AgentBoard\logs\server.log`。
///
/// 为什么不在 cwd：壳把子进程 cwd 设为安装根（`repo_root_for`），服务端默认日志是
/// `<cwd>/.logs/server.log`（`apps/server/src/services/serverLog.ts`），于是日志落进**安装目录**，
/// 卸载时因文件仍被持有而留下空的 `.logs` 目录残留。
///
/// 改到 APPDATA 后有两点一致性收益：
/// - 与壳自身的 `main.log` 同目录（`%APPDATA%\AgentBoard\logs\`），排障只看一处；
/// - 与 `scripts/portable/start.cmd` 的既有约定一致（它本来就设
///   `AGENTBOARD_LOG=%APPDATA%\AgentBoard\logs\server.log`），两种启动方式不再产生两处日志。
fn server_log_path() -> PathBuf {
    config_dir().join("logs").join("server.log")
}

/// 文案里展示的服务日志路径。
fn log_path_display() -> String {
    server_log_path().display().to_string()
}

/// 配置目录：与 `apps/server/src/config.ts` 的 `configDir()` 同口径（`%APPDATA%\AgentBoard`）。
fn config_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            if !appdata.is_empty() {
                return PathBuf::from(appdata).join("AgentBoard");
            }
        }
        if let Some(home) = env::var_os("USERPROFILE") {
            return PathBuf::from(home).join(".config").join("AgentBoard");
        }
        PathBuf::from(".config").join("AgentBoard")
    }
    // macOS 预留（DESKTOP-3）：WKWebView 壳的数据/锁落点（~/Library/Application Support/AgentBoard）在此分支实现。
    #[cfg(not(windows))]
    {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        home.join(".config").join("AgentBoard")
    }
}

fn server_lock_path() -> PathBuf {
    config_dir().join("server.lock")
}

#[derive(Deserialize)]
struct LockFile {
    pid: u32,
    /// 缺省容忍：旧锁或坏锁没有 port 时不参与「接管者二次终止」判定（保守不终止）。
    #[serde(default)]
    port: Option<u16>,
}

fn read_lock_pid(path: &Path) -> Option<u32> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<LockFile>(&raw).ok().map(|lock| lock.pid)
}

/// 读锁里的 `pid` + `port`（第二意见判定用）；不存在/损坏返回 None。
fn read_lock_info(path: &Path) -> Option<LockFile> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<LockFile>(&raw).ok()
}

/// 「第二意见」判定：该不该按锁里的 pid 再终止一次。
///
/// 只在这三条同时成立时返回 `Some(pid)`：
/// 1. 锁存在且可解析；
/// 2. `pid` 与壳手里的子进程 pid **不同**（相同说明就是自己的子进程，走 Child::kill 已覆盖）；
/// 3. 锁里的 `port` 与本壳端口一致（防止误杀另一个 AgentBoard 实例）；
/// 4. 该 pid 存活（已死则只是陈旧锁，交给 remove_lock_owned_by 清）。
///
/// `alive` 注入是为了可单测（真实调用传 `is_pid_alive`）。
fn decide_takeover(
    lock: Option<LockFile>,
    child_pid: u32,
    port: u16,
    alive: impl Fn(u32) -> bool,
) -> Option<u32> {
    let lock = lock?;
    if lock.pid == child_pid {
        return None;
    }
    if lock.port != Some(port) {
        return None;
    }
    if !alive(lock.pid) {
        return None;
    }
    Some(lock.pid)
}

/// 只删除「本子进程写入的锁」或「持有者已死的陈旧锁」；持有者仍活着时一律不动（避免误删接管者的锁）。
fn remove_lock_owned_by(pid: u32) -> bool {
    let path = server_lock_path();
    // 最多等 3s：给 server 自己释放，也给外部启动器的瞬时竞态一个窗口。
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !path.exists() {
            return true;
        }
        match read_lock_pid(&path) {
            Some(lock_pid) if lock_pid == pid => {
                if fs::remove_file(&path).is_ok() {
                    return true;
                }
            }
            Some(lock_pid) => {
                if is_pid_alive(lock_pid) {
                    // 已被别的活实例接管：壳不碰它的锁。
                    return false;
                }
                // 陈旧锁（例如并发的启动器进程刚写了锁就退出）：清掉，避免下次启动被误判「有活实例」。
                if fs::remove_file(&path).is_ok() {
                    return true;
                }
            }
            None => {
                // 读取与删除之间的竞态：文件已消失说明 server 自己释放了。
                if !path.exists() {
                    return true;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(150));
    }
    !path.exists()
}

/// pid 是否存活。用 `tasklist` 判定（不引入额外 crate；判定失败时按「活着」保守处理，宁可不删锁）。
fn is_pid_alive(pid: u32) -> bool {
    let mut command = Command::new("tasklist");
    command
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(output) = command.output() else {
        return true;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().any(|line| {
        line.split(',')
            .nth(1)
            .map(|field| field.trim().trim_matches('"') == pid.to_string())
            .unwrap_or(false)
    })
}

/// 按 pid 终止「非本壳 Child 句柄」的进程（restart 后的接管者）。
///
/// 用 `taskkill /PID <pid> /T /F`：`/T` 连带该进程的子进程（agent CLI），`/F` 强制，
/// 等价于 `Child::kill` 的 TerminateProcess，不引入额外 crate。
/// 只按精确 pid 收，不做「按映像名杀 node」。
fn terminate_pid(pid: u32) {
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command.status();
}

#[cfg(test)]
mod tests {
    use super::{
        child_port_env, decide_takeover, log_path_display, parse_ambient_port, parse_config_port,
        server_log_path, LockFile, DEFAULT_PORT,
    };

    #[test]
    fn valid_port_is_parsed() {
        assert_eq!(parse_config_port("{ \"port\": 8790 }"), Some(8790));
        assert_eq!(parse_config_port(&format!("{{ \"dbPath\": \"x\", \"port\": {DEFAULT_PORT} }}")), Some(DEFAULT_PORT));
        assert_eq!(parse_config_port("{ \"port\": 65535 }"), Some(65535));
    }

    #[test]
    fn missing_file_or_field_falls_back_to_default() {
        assert_eq!(parse_config_port("{ \"dbPath\": \"x\" }"), None);
        assert_eq!(parse_config_port(""), None);
        assert_eq!(parse_config_port("not json"), None);
        assert_eq!(parse_config_port("[]"), None);
    }

    #[test]
    fn illegal_port_falls_back_to_default() {
        // 与 server 端 mergeValidFields 同口径：整数且 >0；u16 上界为本机 SocketAddr 解析所需
        assert_eq!(parse_config_port("{ \"port\": 0 }"), None);
        assert_eq!(parse_config_port("{ \"port\": -1 }"), None);
        assert_eq!(parse_config_port("{ \"port\": 65536 }"), None);
        assert_eq!(parse_config_port("{ \"port\": \"8790\" }"), None);
        assert_eq!(parse_config_port("{ \"port\": 1.5 }"), None);
    }

    fn lock(pid: u32, port: Option<u16>) -> Option<LockFile> {
        Some(LockFile { pid, port })
    }

    #[test]
    fn takeover_detected_when_lock_pid_differs_and_alive() {
        // restart 后：壳的 child=100（死句柄），锁里是接管者 200 且在跑 → 应按 200 二次终止
        assert_eq!(decide_takeover(lock(200, Some(8787)), 100, 8787, |_| true), Some(200));
    }

    #[test]
    fn no_takeover_when_lock_pid_is_own_child() {
        // 锁里就是自己的子进程：Child::kill 已覆盖，不重复终止
        assert_eq!(decide_takeover(lock(100, Some(8787)), 100, 8787, |_| true), None);
    }

    #[test]
    fn no_takeover_when_lock_holder_is_dead() {
        // 陈旧锁：pid 已死，只交给 remove_lock_owned_by 清理，不 kill
        assert_eq!(decide_takeover(lock(200, Some(8787)), 100, 8787, |_| false), None);
    }

    #[test]
    fn no_takeover_for_other_port() {
        // 锁指向另一个端口（另一个 AgentBoard 实例）：不碰，避免误杀
        assert_eq!(decide_takeover(lock(200, Some(9000)), 100, 8787, |_| true), None);
    }

    #[test]
    fn no_takeover_when_lock_missing_or_port_absent() {
        assert_eq!(decide_takeover(None, 100, 8787, |_| true), None);
        // 旧锁/坏锁没有 port：保守不终止
        assert_eq!(decide_takeover(lock(200, None), 100, 8787, |_| true), None);
    }

    // ---- D6：端口对齐 ----

    #[test]
    fn child_port_env_equals_shell_port() {
        // spawn 时注入的 AGENTBOARD_PORT 必须等于壳解析出的端口（覆盖外部传入的任何值）
        assert_eq!(child_port_env(8899), "8899");
        assert_eq!(child_port_env(DEFAULT_PORT), "8787");
    }

    #[test]
    fn ambient_port_mismatch_flags_conflicting_value() {
        // start.cmd 预设 8787、壳端口 8899 → 文案里要点明被对齐，便于排障
        assert_eq!(parse_ambient_port(Some("8787"), 8899), Some("8787".to_string()));
    }

    #[test]
    fn ambient_port_mismatch_ignores_same_value() {
        // 两边一致：不是问题，不写进文案
        assert_eq!(parse_ambient_port(Some("8899"), 8899), None);
        assert_eq!(parse_ambient_port(Some(" 8899 "), 8899), None);
    }

    #[test]
    fn ambient_port_mismatch_ignores_unset_or_garbage() {
        assert_eq!(parse_ambient_port(None, 8787), None);
        assert_eq!(parse_ambient_port(Some(""), 8787), None);
        assert_eq!(parse_ambient_port(Some("   "), 8787), None);
        // 非法值不参与对齐提示（服务端也会忽略它）
        assert_eq!(parse_ambient_port(Some("abc"), 8787), None);
        assert_eq!(parse_ambient_port(Some("70000"), 8787), None);
    }

    // ---- D6-2：服务日志落点 ----

    #[test]
    fn server_log_path_is_under_appdata_not_install_root() {
        let path = server_log_path();
        let text = path.to_string_lossy().replace('\\', "/");
        // 必须在 AgentBoard 配置目录下的 logs/server.log
        assert!(
            text.ends_with("AgentBoard/logs/server.log"),
            "服务日志应落在 <配置目录>/logs/server.log，实际 {text}"
        );
        // 不得再是 <cwd>/.logs/server.log（安装根残留的根因）
        assert!(!text.contains("/.logs/"), "不应落在兜底 .logs 目录，实际 {text}");
    }

    #[test]
    fn log_path_display_matches_server_log_path() {
        assert_eq!(log_path_display(), server_log_path().display().to_string());
    }
}
