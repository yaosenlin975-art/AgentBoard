//! 【DESKTOP-AUTOSTART】开机自启：壳侧命令 `autostart_status` / `autostart_set`。
//!
//! 与 CLI（`kb autostart`）**共用同一系统入口**，保证系统里只有一个自启项：
//! - Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 值名 `AgentBoard`；
//! - macOS：`~/Library/LaunchAgents/com.agentboard.server.plist`（label 同 CLI）；
//! - Linux：`~/.config/systemd/user/agentboard.service`。
//!
//! 因此不引入 `tauri-plugin-autostart`：它走自己的注册入口（mac 上另建 label），
//! 会与 CLI 的自启项并存，违反「同一入口」约束。
//!
//! owner 判定看入口内容指向谁：桌面应用（exe + `--autostart`）→ `desktop`；
//! `agentboard.vbs` / node 起 `apps/server/dist/index.js` 的旧串 → `cli`；同键指向别的东西 → `other`。

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Windows Run 键（用户级，免管理员）
#[cfg(windows)]
const WIN_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// Windows Run 键下的值名（与 CLI 共用）
#[cfg(windows)]
const WIN_VALUE_NAME: &str = "AgentBoard";
/// macOS LaunchAgent label（与 CLI 共用）
const LAUNCH_LABEL: &str = "com.agentboard.server";
/// Linux systemd user unit（与 CLI 共用）
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const SYSTEMD_UNIT: &str = "agentboard.service";

/// 自启状态（契约见卡 f21a02a7「桌面壳命令契约」）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AutoStartStatus {
    /// OS 支持且为已安装运行（tauri dev / 未打包运行没有稳定入口 → false）
    pub supported: bool,
    /// 登录后会自动拉起 AgentBoard
    pub enabled: bool,
    /// `desktop` / `cli` / `none` / `other` / `unknown`
    pub owner: &'static str,
    /// `hkcu-run` / `launchagent` / `systemd-user` / `unsupported`
    pub provider: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `autostart_status`：只读。「未安装」是正常返回（owner=none），读失败也走 `error` 字段，
/// 只有 IPC 本身失败才会 reject（Tauri 命令不返回 Result，就不会 reject）。
#[tauri::command]
pub fn autostart_status() -> AutoStartStatus {
    read_status()
}

/// `autostart_set`：开启/关闭桌面自启入口；成功返回回读后的最新状态。
/// 失败时 message 是 JSON 字符串 `{"code":"AUTOSTART_...","detail":"..."}`（契约见卡 f21a02a7）。
#[tauri::command]
pub fn autostart_set(enabled: bool, take_over: Option<bool>) -> Result<AutoStartStatus, String> {
    let take_over = take_over.unwrap_or(false);
    if !supported() {
        return Err(error_message("AUTOSTART_UNSUPPORTED", unsupported_detail()));
    }
    let current = read_status();
    if current.owner == "unknown" {
        return Err(error_message(
            "AUTOSTART_IO",
            current
                .error
                .clone()
                .unwrap_or_else(|| "无法读取当前开机自启状态".to_string()),
        ));
    }
    match plan_set(current.owner, enabled, take_over) {
        Ok(SetAction::Noop) => Ok(read_status()),
        Ok(SetAction::Write) => {
            write_desktop_entry()?;
            Ok(read_status())
        }
        Ok(SetAction::Remove) => {
            remove_desktop_entry()?;
            Ok(read_status())
        }
        Err(code) => Err(error_message(code, plan_detail(code, current.owner))),
    }
}

/// 写入/删除动作。计划是纯函数，契约表直接单测，不碰系统。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SetAction {
    Write,
    Remove,
    Noop,
}

/// 契约表（卡 f21a02a7）：显式列出每种 owner × enabled × takeOver 的结果。
fn plan_set(owner: &str, enabled: bool, take_over: bool) -> Result<SetAction, &'static str> {
    if enabled {
        match owner {
            "none" | "desktop" => Ok(SetAction::Write),
            "cli" if take_over => Ok(SetAction::Write),
            "cli" | "other" => Err("AUTOSTART_CONFLICT"),
            _ => Err("AUTOSTART_IO"),
        }
    } else {
        match owner {
            "none" => Ok(SetAction::Noop),
            "desktop" => Ok(SetAction::Remove),
            "cli" | "other" => Err("AUTOSTART_NOT_OWNED"),
            _ => Err("AUTOSTART_IO"),
        }
    }
}

fn plan_detail(code: &str, owner: &str) -> String {
    match (code, owner) {
        ("AUTOSTART_CONFLICT", "cli") => {
            "开机自启当前由 CLI（kb autostart）注册；确认接管后带 takeOver:true 重试（会改写同一入口）".to_string()
        }
        ("AUTOSTART_CONFLICT", "other") => {
            "同一自启入口指向其它程序，桌面应用不会覆盖别人的启动项".to_string()
        }
        ("AUTOSTART_NOT_OWNED", "cli") => {
            "当前自启项由 CLI（kb autostart）注册，桌面应用不代删；请先执行 kb autostart uninstall".to_string()
        }
        ("AUTOSTART_NOT_OWNED", _) => {
            "同一自启入口指向其它程序，桌面应用不会改动它".to_string()
        }
        _ => "未知的自启状态".to_string(),
    }
}

/// 组成失败 message 的 JSON 字符串（前端按 `code` 分支）。
fn error_message(code: &str, detail: impl Into<String>) -> String {
    serde_json::json!({ "code": code, "detail": detail.into() }).to_string()
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

/// 当前平台的自启后端名；非三平台为 `unsupported`。
fn platform_provider() -> &'static str {
    if cfg!(windows) {
        "hkcu-run"
    } else if cfg!(target_os = "macos") {
        "launchagent"
    } else if cfg!(target_os = "linux") {
        "systemd-user"
    } else {
        "unsupported"
    }
}

/// OS 支持且是已安装运行：`tauri::is_dev()` 在未启用 custom-protocol 的构建（tauri dev / 普通
/// `cargo build`）为 true —— 那种运行没有稳定安装入口，开机自启写入后会指向 target 目录，不可用。
fn supported() -> bool {
    !tauri::is_dev() && platform_provider() != "unsupported"
}

fn unsupported_detail() -> String {
    if platform_provider() == "unsupported" {
        "当前系统不支持开机自启（仅 Windows / macOS / Linux）".to_string()
    } else {
        "开发模式（tauri dev / 未打包运行）没有稳定的安装入口，开机自启仅在已安装版本可用".to_string()
    }
}

/// 只读探测，任何读取失败都放进 `error`，不 reject。
fn read_status() -> AutoStartStatus {
    let provider = platform_provider();
    let mut status = AutoStartStatus {
        supported: supported(),
        enabled: false,
        owner: "none",
        provider,
        detail: None,
        error: None,
    };
    if tauri::is_dev() {
        status.detail = Some(unsupported_detail());
    }

    #[cfg(windows)]
    read_windows(&mut status);
    #[cfg(target_os = "macos")]
    read_macos(&mut status);
    #[cfg(target_os = "linux")]
    read_linux(&mut status);

    status
}

// ---- Windows ----

/// `reg query` 输出 → `REG_SZ` 行里的值；没有该行返回 None。
fn parse_reg_query_value(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if let Some(index) = line.find("REG_SZ") {
            let value = line[index + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 桌面写入的 Run 值：`"<exe>" --autostart`（路径含空格必须带双引号）。
fn build_windows_value(exe: &Path) -> String {
    format!("\"{}\" --autostart", exe.display())
}

/// 从启动值里取可执行文件 token（处理带引号与不带引号两种写法）。
fn executable_token(value: &str) -> &str {
    if let Some(rest) = value.strip_prefix('"') {
        rest.split('"').next().unwrap_or(rest)
    } else {
        value.split_whitespace().next().unwrap_or(value)
    }
}

/// 值指向谁：`desktop` / `cli` / `other`。
fn classify_windows_value(value: &str, exe: &Path) -> &'static str {
    let lower = value.to_lowercase();
    if lower.contains("agentboard.vbs") {
        return "cli";
    }
    if lower.contains("--autostart") {
        let target = Path::new(executable_token(value));
        let target_stem = target
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .to_lowercase();
        let exe_stem = exe
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !target_stem.is_empty() && target_stem == exe_stem {
            return "desktop";
        }
        return "other";
    }
    if lower.contains("node") && lower.contains("index.js") {
        return "cli";
    }
    "other"
}

#[cfg(windows)]
fn windows_add_args(value: &str) -> Vec<String> {
    vec![
        "add".to_string(),
        WIN_RUN_KEY.to_string(),
        "/v".to_string(),
        WIN_VALUE_NAME.to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        value.to_string(),
        "/f".to_string(),
    ]
}

#[cfg(windows)]
fn windows_delete_args() -> Vec<String> {
    vec![
        "delete".to_string(),
        WIN_RUN_KEY.to_string(),
        "/v".to_string(),
        WIN_VALUE_NAME.to_string(),
        "/f".to_string(),
    ]
}

#[cfg(windows)]
fn read_windows(status: &mut AutoStartStatus) {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(format!("无法定位当前程序路径：{error}"));
            return;
        }
    };
    let output = match run(
        "reg.exe",
        &["query", WIN_RUN_KEY, "/v", WIN_VALUE_NAME],
    ) {
        Ok(output) => output,
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(error);
            return;
        }
    };
    match parse_reg_query_value(&output.stdout) {
        Some(value) => {
            status.owner = classify_windows_value(&value, &exe);
            status.enabled = status.owner == "desktop" || status.owner == "cli";
            status.detail = Some(format!("注册表 {WIN_RUN_KEY}\\{WIN_VALUE_NAME} = {value}"));
        }
        None => {
            // reg query 对「值不存在」返回 1：按未安装处理（与 CLI 同口径），不当读取失败。
            status.owner = "none";
            status.enabled = false;
            status.detail = Some(format!(
                "注册表 {WIN_RUN_KEY} 下没有 {WIN_VALUE_NAME} 值（未安装）"
            ));
        }
    }
}

#[cfg(windows)]
fn write_desktop_entry() -> Result<(), String> {
    let exe = current_exe()?;
    let value = build_windows_value(&exe);
    let output = run("reg.exe", &windows_add_args(&value))
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if output.code != 0 {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("写入注册表失败：{}", first_line(&output.stderr)),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn remove_desktop_entry() -> Result<(), String> {
    let output = run("reg.exe", &windows_delete_args())
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    // 1 = 值已不存在：目标语义是「不再自启」，幂等成功。
    if output.code != 0 && output.code != 1 {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("删除注册表值失败：{}", first_line(&output.stderr)),
        ));
    }
    Ok(())
}

/// 写系统失败的 code：权限类单列，其余归 IO。
fn process_failure_code(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if lower.contains("access is denied") || lower.contains("denied") || stderr.contains("拒绝访问")
    {
        "AUTOSTART_PERMISSION"
    } else {
        "AUTOSTART_IO"
    }
}

// ---- macOS ----

#[cfg(target_os = "macos")]
fn launch_plist_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| error_message("AUTOSTART_IO", "HOME 环境变量未设置，无法定位 LaunchAgents"))?;
    Ok(Path::new(&home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCH_LABEL}.plist")))
}

/// LaunchAgent plist：ProgramArguments=[<app exe>, "--autostart"]、RunAtLoad=true、KeepAlive=false
/// （与 B11 同口径：不自带崩溃重启，避免与 server 单例锁打架）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_launch_agent_plist(exe: &Path) -> String {
    let exe = xml_escape(&exe.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
"#
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// plist 内容指向谁：`desktop`（--autostart）/ `cli`（node 起 server 入口）/ `other`。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn classify_launch_plist(content: &str) -> &'static str {
    if content.contains("--autostart") {
        return "desktop";
    }
    if content.contains("agentboard.vbs") || content.contains("apps/server/dist/index.js") {
        return "cli";
    }
    "other"
}

#[cfg(target_os = "macos")]
fn read_macos(status: &mut AutoStartStatus) {
    let path = match launch_plist_path() {
        Ok(path) => path,
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(error);
            return;
        }
    };
    if !path.exists() {
        status.owner = "none";
        status.detail = Some(format!("{LAUNCH_LABEL} LaunchAgent 未安装"));
        return;
    }
    match fs::read_to_string(&path) {
        Ok(content) => {
            status.owner = classify_launch_plist(&content);
            status.enabled = status.owner == "desktop" || status.owner == "cli";
            let loaded = matches!(run("launchctl", &["list", LAUNCH_LABEL]), Ok(output) if output.code == 0);
            status.detail = Some(format!(
                "LaunchAgent {LAUNCH_LABEL}（{}，launchctl {})",
                path.display(),
                if loaded { "已加载" } else { "未加载" }
            ));
        }
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(format!("读取 LaunchAgent plist 失败：{error}"));
        }
    }
}

#[cfg(target_os = "macos")]
fn mac_uid() -> Result<String, String> {
    let output = run("id", &["-u"]).map_err(|error| error_message("AUTOSTART_IO", error))?;
    let uid = output.stdout.trim().to_string();
    if output.code != 0 || uid.is_empty() {
        return Err(error_message(
            "AUTOSTART_IO",
            format!("无法确定当前 uid：{}", first_line(&output.stderr)),
        ));
    }
    Ok(uid)
}

#[cfg(target_os = "macos")]
fn write_desktop_entry() -> Result<(), String> {
    let exe = current_exe()?;
    let plist = launch_plist_path()?;
    if let Some(dir) = plist.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            error_message(io_code(&error), format!("创建 LaunchAgents 目录失败：{error}"))
        })?;
    }
    fs::write(&plist, build_launch_agent_plist(&exe))
        .map_err(|error| error_message(io_code(&error), format!("写入 plist 失败：{error}")))?;
    let uid = mac_uid()?;
    let label_target = format!("gui/{uid}/{LAUNCH_LABEL}");
    // 未加载不算失败：bootout 之后再 bootstrap，重复开启幂等且新 plist 生效。
    let _ = run("launchctl", &["bootout", label_target.as_str()]);
    let output = run(
        "launchctl",
        &["bootstrap", &format!("gui/{uid}"), &plist.display().to_string()],
    )
    .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if output.code != 0 {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("launchctl bootstrap 失败：{}", first_line(&output.stderr)),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_desktop_entry() -> Result<(), String> {
    let plist = launch_plist_path()?;
    if !plist.exists() {
        return Ok(());
    }
    let uid = mac_uid()?;
    let output = run("launchctl", &["bootout", &format!("gui/{uid}/{LAUNCH_LABEL}")])
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if output.code != 0 && !is_launch_not_loaded(&output.stderr) {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("launchctl bootout 失败：{}", first_line(&output.stderr)),
        ));
    }
    fs::remove_file(&plist)
        .map_err(|error| error_message(io_code(&error), format!("删除 plist 失败：{error}")))?;
    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_launch_not_loaded(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("could not find") || lower.contains("no such process") || lower.contains("not find")
}

// ---- Linux ----

#[cfg(target_os = "linux")]
fn systemd_unit_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| error_message("AUTOSTART_IO", "HOME 环境变量未设置，无法定位 systemd user unit"))?;
    Ok(Path::new(&home)
        .join(".config")
        .join("systemd")
        .join("user")
        .join(SYSTEMD_UNIT))
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// systemd user unit：ExecStart="<app exe>" --autostart、Restart=no（与 B11/KeepAlive=false 同口径）。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn build_systemd_unit(exe: &Path) -> String {
    format!(
        r#"[Unit]
Description=AgentBoard desktop
After=network.target

[Service]
Type=simple
ExecStart={} --autostart
Restart=no

[Install]
WantedBy=default.target
"#,
        systemd_quote(&exe.display().to_string())
    )
}

/// unit 内容指向谁：`desktop`（--autostart）/ `cli`（node 起 server 入口）/ `other`。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn classify_systemd_unit(content: &str) -> &'static str {
    if content.contains("--autostart") {
        return "desktop";
    }
    if content.contains("agentboard.vbs") || content.contains("apps/server/dist/index.js") {
        return "cli";
    }
    "other"
}

#[cfg(target_os = "linux")]
fn read_linux(status: &mut AutoStartStatus) {
    let path = match systemd_unit_path() {
        Ok(path) => path,
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(error);
            return;
        }
    };
    if !path.exists() {
        status.owner = "none";
        status.detail = Some(format!("systemd user unit {SYSTEMD_UNIT} 未安装"));
        return;
    }
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            status.owner = "unknown";
            status.error = Some(format!("读取 systemd unit 失败：{error}"));
            return;
        }
    };
    status.owner = classify_systemd_unit(&content);
    let enabled = matches!(
        run("systemctl", &["--user", "is-enabled", SYSTEMD_UNIT]),
        Ok(output) if output.code == 0
    );
    status.enabled = enabled && (status.owner == "desktop" || status.owner == "cli");
    status.detail = Some(format!(
        "systemd user unit {SYSTEMD_UNIT}（{}，{}）",
        path.display(),
        if enabled { "已启用" } else { "未启用" }
    ));
}

#[cfg(target_os = "linux")]
fn write_desktop_entry() -> Result<(), String> {
    let exe = current_exe()?;
    let unit = systemd_unit_path()?;
    if let Some(dir) = unit.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            error_message(io_code(&error), format!("创建 systemd user 目录失败：{error}"))
        })?;
    }
    fs::write(&unit, build_systemd_unit(&exe))
        .map_err(|error| error_message(io_code(&error), format!("写入 unit 失败：{error}")))?;
    let reload = run("systemctl", &["--user", "daemon-reload"])
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if reload.code != 0 {
        return Err(error_message(
            process_failure_code(&reload.stderr),
            format!("systemctl --user daemon-reload 失败：{}", first_line(&reload.stderr)),
        ));
    }
    let output = run("systemctl", &["--user", "enable", "--now", SYSTEMD_UNIT])
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if output.code != 0 {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("systemctl --user enable --now 失败：{}", first_line(&output.stderr)),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_desktop_entry() -> Result<(), String> {
    let unit = systemd_unit_path()?;
    if !unit.exists() {
        return Ok(());
    }
    let output = run("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT])
        .map_err(|error| error_message("AUTOSTART_IO", error))?;
    if output.code != 0 && !is_systemd_not_loaded(&output.stderr) {
        return Err(error_message(
            process_failure_code(&output.stderr),
            format!("systemctl --user disable 失败：{}", first_line(&output.stderr)),
        ));
    }
    fs::remove_file(&unit)
        .map_err(|error| error_message(io_code(&error), format!("删除 unit 失败：{error}")))?;
    let _ = run("systemctl", &["--user", "daemon-reload"]);
    Ok(())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_systemd_not_loaded(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not loaded")
        || lower.contains("no such file")
        || lower.contains("does not exist")
        || lower.contains("could not be found")
}

// ---- 平台无关兜底 ----

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn write_desktop_entry() -> Result<(), String> {
    Err(error_message("AUTOSTART_UNSUPPORTED", unsupported_detail()))
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn remove_desktop_entry() -> Result<(), String> {
    Err(error_message("AUTOSTART_UNSUPPORTED", unsupported_detail()))
}

// ---- 公共 IO ----

struct CommandOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// 跑外部命令并收 stdout/stderr。Windows 上隐藏控制台窗口（壳是 GUI 进程）。
fn run<S: AsRef<std::ffi::OsStr>>(program: &str, args: &[S]) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法执行 {program}：{error}"))?;
    Ok(CommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error_message("AUTOSTART_IO", format!("无法定位当前程序路径：{error}")))
}

#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn io_code(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        "AUTOSTART_PERMISSION"
    } else {
        "AUTOSTART_IO"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_value_quotes_path_and_appends_flag() {
        let value = build_windows_value(Path::new(r"C:\Program Files\AgentBoard\AgentBoard.exe"));
        assert_eq!(
            value,
            r#""C:\Program Files\AgentBoard\AgentBoard.exe" --autostart"#
        );
    }

    #[test]
    fn classifies_desktop_value_by_exe_stem() {
        let exe = Path::new(r"C:\Program Files\AgentBoard\AgentBoard.exe");
        assert_eq!(
            classify_windows_value(r#""C:\Program Files\AgentBoard\AgentBoard.exe" --autostart"#, exe),
            "desktop"
        );
    }

    #[test]
    fn classifies_cli_value_via_vbs_or_node() {
        let exe = Path::new(r"C:\Program Files\AgentBoard\AgentBoard.exe");
        assert_eq!(
            classify_windows_value(r#"wscript.exe "D:\repo\scripts\agentboard.vbs" autostart"#, exe),
            "cli"
        );
        assert_eq!(
            classify_windows_value(r#""C:\node.exe" "D:\repo\apps\server\dist\index.js""#, exe),
            "cli"
        );
    }

    #[test]
    fn classifies_foreign_value_as_other() {
        let exe = Path::new(r"C:\Program Files\AgentBoard\AgentBoard.exe");
        assert_eq!(
            classify_windows_value(r#""C:\Other\OtherApp.exe" --autostart"#, exe),
            "other"
        );
        assert_eq!(classify_windows_value(r#""C:\Other\OtherApp.exe""#, exe), "other");
    }

    #[test]
    fn parses_reg_query_value() {
        let stdout = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    AgentBoard    REG_SZ    \"C:\\App\\AgentBoard.exe\" --autostart\r\n\r\n";
        assert_eq!(
            parse_reg_query_value(stdout).as_deref(),
            Some(r#""C:\App\AgentBoard.exe" --autostart"#)
        );
        assert_eq!(parse_reg_query_value("未找到"), None);
    }

    #[test]
    fn plan_matches_the_contract_table() {
        // enabled=true
        assert_eq!(plan_set("none", true, false), Ok(SetAction::Write));
        assert_eq!(plan_set("desktop", true, false), Ok(SetAction::Write));
        assert_eq!(plan_set("cli", true, false), Err("AUTOSTART_CONFLICT"));
        assert_eq!(plan_set("cli", true, true), Ok(SetAction::Write));
        assert_eq!(plan_set("other", true, false), Err("AUTOSTART_CONFLICT"));
        assert_eq!(plan_set("other", true, true), Err("AUTOSTART_CONFLICT"));
        // enabled=false
        assert_eq!(plan_set("none", false, false), Ok(SetAction::Noop));
        assert_eq!(plan_set("desktop", false, false), Ok(SetAction::Remove));
        assert_eq!(plan_set("cli", false, true), Err("AUTOSTART_NOT_OWNED"));
        assert_eq!(plan_set("other", false, false), Err("AUTOSTART_NOT_OWNED"));
        // 读失败不能盲写
        assert_eq!(plan_set("unknown", true, false), Err("AUTOSTART_IO"));
        assert_eq!(plan_set("unknown", false, false), Err("AUTOSTART_IO"));
    }

    #[test]
    fn launch_agent_plist_contract() {
        let plist = build_launch_agent_plist(Path::new("/Applications/AgentBoard.app/Contents/MacOS/AgentBoard"));
        assert!(plist.contains("<string>com.agentboard.server</string>"));
        assert!(plist.contains("<string>/Applications/AgentBoard.app/Contents/MacOS/AgentBoard</string>"));
        assert!(plist.contains("<string>--autostart</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <false/>"));
        assert_eq!(classify_launch_plist(&plist), "desktop");
        assert_eq!(
            classify_launch_plist("<string>/usr/local/bin/node</string><string>/repo/apps/server/dist/index.js</string>"),
            "cli"
        );
        assert_eq!(classify_launch_plist("<string>/usr/bin/other</string>"), "other");
    }

    #[test]
    fn systemd_unit_contract() {
        let unit = build_systemd_unit(Path::new("/opt/AgentBoard/AgentBoard"));
        assert!(unit.contains("ExecStart=\"/opt/AgentBoard/AgentBoard\" --autostart"));
        assert!(unit.contains("Restart=no"));
        assert!(unit.contains("WantedBy=default.target"));
        assert_eq!(classify_systemd_unit(&unit), "desktop");
        assert_eq!(
            classify_systemd_unit("ExecStart=/usr/bin/node /repo/apps/server/dist/index.js"),
            "cli"
        );
        assert_eq!(classify_systemd_unit("ExecStart=/usr/bin/other"), "other");
    }

    #[test]
    fn error_message_is_json_with_code_and_detail() {
        let message = error_message("AUTOSTART_CONFLICT", "冲突");
        let parsed: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(parsed["code"], "AUTOSTART_CONFLICT");
        assert_eq!(parsed["detail"], "冲突");
    }
}
