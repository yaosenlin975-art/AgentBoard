//! 【DESKTOP-1】AgentBoard 桌面壳（Tauri v2）。
//!
//! 壳只做四件事：**窗口、托盘、单例、server 进程生命周期**。
//! - 窗口：本地启动页 → 健康检查通过后导航到服务地址（CR-6：端口读 config.json 的 port，缺省 8787）；
//! - 托盘：菜单含「显示」「退出」；关窗 = 隐藏到托盘，服务继续运行；
//! - 单例：Tauri 官方 `tauri-plugin-single-instance`（第二个实例直接退出，回调聚焦已有窗口）；
//! - 生命周期：目标端口未起时由壳用 node 拉起 server（见 `server_process.rs`），托盘「退出」时停服并释放 `server.lock`。
//!
//! 平台：Windows 与 macOS 共用同一套生命周期代码；窗口外观按平台分叉（B06）：
//! Windows 保留 `decorations(false)` 全自绘 ─□×，macOS 走原生红绿灯 overlay（`TitleBarStyle::Overlay`
//! + `hidden_title`），页面侧按壳注入的 `window.__AGENTBOARD_SHELL__` 隐藏自绘三键。

mod server_process;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// 主窗口 label：托盘 / 菜单 / 单例 / 重建都按这一个 key 找窗口。
const MAIN_WINDOW: &str = "main";

use server_process::ServerHandle;

/// 壳全局状态：启动结果、server 句柄、退出标记。
struct ShellState {
    boot: BootState,
    server: Mutex<Option<ServerHandle>>,
    /// 用户点了「退出」后置位：此时正在启动线程若刚拉起 server，必须立刻停掉，不能留下孤儿进程。
    quitting: AtomicBool,
    /// CR-6：启动时解析一次的服务端口（config.json 的 port，非法/缺失退回 8787）；探活与导航都用它。
    port: u16,
}

struct BootState {
    /// 本地启动页是否已加载完成（未完成前不 eval，避免把错误写进空白文档）。
    page_loaded: AtomicBool,
    /// 启动结果：`Ok(())` = 服务健康；`Err(msg)` = 可读失败原因。`take()` 保证只应用一次
    /// （导航到服务页本身会再触发一次 PageLoad Finished，重复应用会变成反复 location.replace）。
    outcome: Mutex<Option<Result<(), String>>>,
    /// 启动结论留档：窗口被销毁后重建时用它复现同一落地动作（`outcome` 已被 take 消费掉）。
    boot_ok: AtomicBool,
    boot_error: Mutex<Option<String>>,
}

/// 启动结果落地：页面已加载且结果已产生时，导航到服务页或把错误显示在本地页上，然后显示窗口。
fn apply_boot(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if !state.boot.page_loaded.load(Ordering::SeqCst) {
        return;
    }
    let outcome = {
        let mut slot = state.boot.outcome.lock().unwrap();
        slot.take()
    };
    let Some(outcome) = outcome else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match outcome {
        Ok(()) => {
            state.boot.boot_ok.store(true, Ordering::SeqCst);
            // 导航到既有服务页面（CR-6：端口来自 config.json）：同源、无自定义协议、无请求注入。
            let _ = window.eval(&format!("location.replace('{}')", server_process::base_url(state.port)));
        }
        Err(message) => {
            *state.boot.boot_error.lock().unwrap() = Some(message.clone());
            let json = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
            let _ = window.eval(&format!("window.__setShellError({json});"));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// 启动线程：探活/拉起 server，结果写回 BootState 并尝试落地。
fn start_server(app: AppHandle) {
    std::thread::spawn(move || {
        let port = app.state::<ShellState>().port;
        let result = match server_process::ensure_server(port) {
            Ok(handle) => {
                let state = app.state::<ShellState>();
                if state.quitting.load(Ordering::SeqCst) {
                    // 退出与启动竞态：用户已点退出，刚拉起的 server 必须立刻停掉。
                    let mut handle = handle;
                    let _ = handle.stop();
                } else {
                    *state.server.lock().unwrap() = Some(handle);
                }
                Ok(())
            }
            Err(message) => Err(message),
        };
        {
            let state = app.state::<ShellState>();
            *state.boot.outcome.lock().unwrap() = Some(result);
        }
        apply_boot(&app);
    });
}

/// 停服收尾（幂等）：先隐藏窗口，再终止壳自己拉起的 server 并确认 `server.lock` 释放。
fn shutdown(app: &AppHandle) {
    let state = app.state::<ShellState>();
    state.quitting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let handle = {
        let mut slot = state.server.lock().unwrap();
        slot.take()
    };
    if let Some(mut handle) = handle {
        // 外部实例（child=None）不终止；壳只停自己拉起的进程。
        let _ = handle.stop();
    }
}

/// E2（MAC-TRIAL-E2）：系统通知会话去重状态。首轮取数只建基线（不弹通知，避免应用启动把
/// 存量待验收/宽限全部重弹一遍）；之后只对「新进入」的 id 弹一次。前台聚焦时 web 内提醒
/// 已覆盖，同样并入集合（失焦后不补弹）——去重口径见卡 062f2bbb 评论。
#[derive(Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct NotifiedSet {
    seeded: AtomicBool,
    review: Mutex<std::collections::HashSet<String>>,
    grace: Mutex<std::collections::HashSet<String>>,
}

/// E2：一轮取数发现的新事件（标题已截断），空表示无新增。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct NotificationEvents {
    reviews: Vec<String>,
    graces: Vec<String>,
}

/// E2：差分纯函数（单测直接驱动）：本轮全量 (id, 标题) 与去重集合比较。
/// 首轮（未建基线）只入集合、返回空事件；决策问题文本截断到 80 字符。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn diff_notification_events(
    notified: &NotifiedSet,
    reviews: Vec<(String, String)>,
    graces: Vec<(String, String)>,
) -> NotificationEvents {
    let first_round = !notified.seeded.load(Ordering::SeqCst);
    let mut review_set = notified.review.lock().unwrap();
    let mut grace_set = notified.grace.lock().unwrap();
    if first_round {
        review_set.extend(reviews.into_iter().map(|(id, _)| id));
        grace_set.extend(graces.into_iter().map(|(id, _)| id));
        notified.seeded.store(true, Ordering::SeqCst);
        return NotificationEvents { reviews: Vec::new(), graces: Vec::new() };
    }
    let new_reviews = reviews
        .into_iter()
        .filter(|(id, _)| review_set.insert(id.clone()))
        .map(|(_, title)| title)
        .collect();
    let new_graces = graces
        .into_iter()
        .filter(|(id, _)| grace_set.insert(id.clone()))
        .map(|(_, question)| question.chars().take(80).collect())
        .collect();
    NotificationEvents { reviews: new_reviews, graces: new_graces }
}

/// E2：拉取全部工作区里「新进入待验收」的卡与「新进入宽限」的决策。
/// 与 E1 同源端点：/api/workspaces、/api/issues?fields=id,title,status、/api/decisions?state=grace。
/// 任一请求失败返回 None（本轮跳过，不动去重集合）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn poll_notification_events(
    port: u16,
    notified: &NotifiedSet,
) -> Option<NotificationEvents> {
    let workspaces = server_process::http_get_json(port, "/api/workspaces")?;
    let mut reviews: Vec<(String, String)> = Vec::new();
    let mut graces: Vec<(String, String)> = Vec::new();
    for workspace in workspaces.as_array()? {
        let id = workspace.get("id")?.as_str()?;
        let issues = server_process::http_get_json(
            port,
            &format!("/api/issues?workspace={id}&fields=id,title,status"),
        )?;
        for issue in issues.as_array()? {
            if issue.get("status").and_then(|s| s.as_str()) == Some("待验收") {
                let id = issue.get("id")?.as_str()?.to_string();
                let title = issue
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("（无标题）")
                    .to_string();
                reviews.push((id, title));
            }
        }
        let decisions = server_process::http_get_json(
            port,
            &format!("/api/decisions?workspace_id={id}&state=grace"),
        )?;
        for decision in decisions.get("decisions")?.as_array()? {
            let id = decision.get("id")?.as_str()?.to_string();
            let question = decision
                .get("question")
                .and_then(|q| q.as_str())
                .unwrap_or("（无问题文本）")
                .to_string();
            graces.push((id, question));
        }
    }
    Some(diff_notification_events(notified, reviews, graces))
}

/// E2：发一条系统通知（tauri-plugin-notification，mac 落到通知中心 UNNotification）。
/// 权限被拒时 show() 报错：仅打日志不静默吞（降级 = Dock 角标 + web 内提醒仍可用，口径见卡评论）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn send_desktop_notification(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("系统通知发送失败（权限被拒？降级为角标+web 内提醒）：{error}");
    }
}

/// E2：系统通知轮询线程（mac-only）。30s 一轮；失败 5s 退避；主窗口前台聚焦时不弹
/// （web 内提醒已覆盖，且仍计入去重集合）。
fn spawn_notification_poller(app: AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    #[cfg(target_os = "macos")]
    {
        use std::time::{Duration, Instant};
        let port = app.state::<ShellState>().port;
        std::thread::spawn(move || {
            let mut next_wait = Duration::from_secs(5);
            loop {
                let quit = || app.state::<ShellState>().quitting.load(Ordering::SeqCst);
                let notified = app.state::<NotifiedSet>();
                match poll_notification_events(port, notified.inner()) {
                    Some(events) => {
                        next_wait = Duration::from_secs(30);
                        let focused = app
                            .get_webview_window(MAIN_WINDOW)
                            .map(|window| window.is_focused().unwrap_or(false))
                            .unwrap_or(false);
                        // 前台聚焦：web 内提醒负责，系统通知跳过（事件已在 poll 中并入去重集合）。
                        if !focused {
                            if !events.graces.is_empty() {
                                send_desktop_notification(
                                    &app,
                                    "AgentBoard 待决策进入宽限",
                                    &summarize_titles(&events.graces),
                                );
                            }
                            if !events.reviews.is_empty() {
                                send_desktop_notification(
                                    &app,
                                    "AgentBoard 卡进入待验收",
                                    &summarize_titles(&events.reviews),
                                );
                            }
                        }
                    }
                    None => {
                        next_wait = Duration::from_secs(5);
                    }
                }
                let deadline = Instant::now() + next_wait;
                while Instant::now() < deadline {
                    if quit() {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
                if quit() {
                    return;
                }
            }
        });
    }
}

/// E2：多条事件合成一条通知正文（首条全文 + 其余计数，避免轮询窗口内连发多条）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn summarize_titles(titles: &[String]) -> String {
    let mut summary = String::new();
    if let Some(first) = titles.first() {
        summary.push_str(first);
    }
    if titles.len() > 1 {
        summary.push_str(&format!("（等 {} 条）", titles.len()));
    }
    summary
}

/// E1（MAC-TRIAL-E1）：Dock 角标数 = 所有工作区的「待验收」issue 数 + 「open」待决策数之和。
/// 取数端点（全部只读 GET，与 kb stats / kb decisions 同源）：
/// - `GET /api/workspaces`：全部工作区 id；
/// - `GET /api/issues?workspace=<id>&fields=status`：逐区数 `status == "待验收"`；
/// - `GET /api/decisions?workspace_id=<id>&state=open&limit=1`：取 `counts.open`。
/// 任一请求失败返回 None（本轮不更新角标，不清零、不报错）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn dock_badge_count(port: u16) -> Option<i64> {
    let workspaces = server_process::http_get_json(port, "/api/workspaces")?;
    let mut total: i64 = 0;
    for workspace in workspaces.as_array()? {
        let id = workspace.get("id")?.as_str()?;
        let issues = server_process::http_get_json(
            port,
            &format!("/api/issues?workspace={id}&fields=status"),
        )?;
        total += review_issue_count(&issues)?;
        let decisions = server_process::http_get_json(
            port,
            &format!("/api/decisions?workspace_id={id}&state=open&limit=1"),
        )?;
        total += open_decision_count(&decisions)?;
    }
    Some(total)
}

/// `GET /api/issues?…&fields=status` 的数组 → 「待验收」条数（非数组返回 None）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn review_issue_count(issues: &serde_json::Value) -> Option<i64> {
    Some(
        issues
            .as_array()?
            .iter()
            .filter(|issue| issue.get("status").and_then(|s| s.as_str()) == Some("待验收"))
            .count() as i64,
    )
}

/// `GET /api/decisions?…&state=open` 的响应 → `counts.open`（缺失返回 None）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn open_decision_count(decisions: &serde_json::Value) -> Option<i64> {
    decisions.pointer("/counts/open")?.as_i64()
}

/// E1：把角标数挂到 mac Dock（`set_badge_count`：0/None 都会移除角标，归零即消失）。
/// 仅 mac 实装（tao 只在 mac 实现 Dock badge；Windows 任务栏对应的是 overlay icon，不在本卡范围）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn apply_dock_badge(app: &AppHandle, count: i64) {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_badge_count(Some(count));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, count);
    }
}

/// E1：Dock 角标轮询线程。成功取数后 30s 一轮；服务未就绪/瞬时失败 5s 退避重试（不清角标）。
/// 轮询期间每秒检查 `quitting`，退出即时收线。非 mac 平台不起线程（无 Dock 可挂）。
fn spawn_dock_badge_poller(app: AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    #[cfg(target_os = "macos")]
    {
        use std::time::{Duration, Instant};
        let port = app.state::<ShellState>().port;
        std::thread::spawn(move || {
            let poll_every = Duration::from_secs(30);
            let retry_every = Duration::from_secs(5);
            let mut next_wait = retry_every;
            loop {
                let quit = || app.state::<ShellState>().quitting.load(Ordering::SeqCst);
                match dock_badge_count(port) {
                    Some(count) => {
                        apply_dock_badge(&app, count);
                        next_wait = poll_every;
                    }
                    None => {
                        next_wait = retry_every;
                    }
                }
                let deadline = Instant::now() + next_wait;
                while Instant::now() < deadline {
                    if quit() {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
                if quit() {
                    return;
                }
            }
        });
    }
}

/// 退出前等启动线程收口（B11）：壳刚启动、server 还没健康就点退出时，`shutdown` 抢不到句柄
/// （还在 `ensure_server` 的健康等待里），靠 `start_server` 线程的竞态分支停掉刚拉起的 server；
/// 若不等它出结果就 `exit`，后台线程随进程死亡，刚 spawn 的 server 成孤儿（端口/`server.lock`
/// 不释放；LaunchAgent KeepAlive 场景还会与 launchd 再拉起的实例争端口形成拉锯）。
/// `boot.outcome` 置位时竞态分支已执行完毕，此时退出是安全的。上限 70s 覆盖 `ensure_server`
/// 自身的 60s 健康超时；只在退出线程里调用，不进 `RunEvent::Exit`（事件线程不可阻塞）。
fn wait_boot_settled(app: &AppHandle) {
    let state = app.state::<ShellState>();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(70);
    while std::time::Instant::now() < deadline {
        if state.boot.outcome.lock().unwrap().is_some() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// 窗口当前所处的可观察状态。托盘点击/菜单「显示」/第二实例启动都先判这一态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowPhase {
    /// 隐藏到托盘（关窗后）：`show` + `unminimize` + `set_focus`。
    Hidden,
    /// 最小化（还在任务栏）：`unminimize` + `set_focus`，不要多余的 `show`。
    Minimized,
    /// 正常可见：只补 `set_focus`。
    Visible,
    /// 已销毁（webview 不存在）：只 `show` 会空操作，必须重建窗口。
    Destroyed,
}

/// 唤醒动作。顺序即执行顺序，单测直接断言这张表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeStep {
    Show,
    Unminimize,
    SetFocus,
    Recreate,
    Abort,
}

/// 由可观察状态推导动作序列。
///
/// - `quitting`：退出流程进行中，显示窗口没有意义（服务正在停），一律 Abort；
/// - `Destroyed`：走**本进程内重建窗口**，不是「第二个实例的单例重建」——单例只拦第二个进程，
///   对本进程内被销毁的 webview 无效，`show` 也只会静默失败；
/// - 其余按 Hidden / Minimized / Visible 三态给最小动作集。
fn wake_steps(phase: WindowPhase, quitting: bool) -> Vec<WakeStep> {
    if quitting {
        return vec![WakeStep::Abort];
    }
    match phase {
        WindowPhase::Destroyed => vec![WakeStep::Recreate],
        WindowPhase::Hidden => vec![WakeStep::Show, WakeStep::Unminimize, WakeStep::SetFocus],
        WindowPhase::Minimized => vec![WakeStep::Unminimize, WakeStep::SetFocus],
        WindowPhase::Visible => vec![WakeStep::SetFocus],
    }
}

fn window_phase(window: &WebviewWindow) -> WindowPhase {
    if window.is_minimized().unwrap_or(false) {
        WindowPhase::Minimized
    } else if window.is_visible().unwrap_or(false) {
        WindowPhase::Visible
    } else {
        WindowPhase::Hidden
    }
}

/// 唯一的唤醒入口：托盘左键、托盘菜单「显示」、第二实例启动三处都调它，
/// 避免「菜单一套逻辑、图标另一套逻辑」走偏。
fn wake_main_window(app: &AppHandle) {
    let quitting = app.state::<ShellState>().quitting.load(Ordering::SeqCst);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        for step in wake_steps(WindowPhase::Destroyed, quitting) {
            if let WakeStep::Recreate = step {
                if let Err(error) = recreate_main_window(app) {
                    eprintln!("重建主窗口失败：{error}");
                }
            }
        }
        return;
    };
    for step in wake_steps(window_phase(&window), quitting) {
        match step {
            WakeStep::Show => {
                let _ = window.show();
            }
            WakeStep::Unminimize => {
                let _ = window.unminimize();
            }
            WakeStep::SetFocus => {
                let _ = window.set_focus();
            }
            WakeStep::Recreate | WakeStep::Abort => {}
        }
    }
}

/// 窗口被销毁后的重建路径：同一进程内重新建 `main` 窗口。
/// 启动已成功则直接加载服务页（端口取 ShellState.port）；启动失败则回到本地页并复现同一错误文案；启动未完成则等启动线程落地。
fn recreate_main_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    state.boot.page_loaded.store(false, Ordering::SeqCst);
    let url = if state.boot.boot_ok.load(Ordering::SeqCst) {
        WebviewUrl::External(
            server_process::base_url(state.port)
                .parse()
                .map_err(|error| format!("服务地址解析失败：{error}"))?,
        )
    } else {
        WebviewUrl::App("index.html".into())
    };
    let window = build_main_window(app, url, true).map_err(|error| error.to_string())?;
    if let Some(message) = state.boot.boot_error.lock().unwrap().clone() {
        let json = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
        let _ = window.eval(&format!("window.__setShellError({json});"));
    }
    Ok(())
}

/// 窗口外观分叉（B06）：Windows 全自绘，macOS 原生红绿灯 overlay。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowChrome {
    /// 是否保留系统原生窗口装饰（标题栏 + 边框）。
    decorations: bool,
    /// 是否把标题栏设为 overlay（红绿灯浮在内容上、标题隐藏）；仅 macOS 生效。
    overlay_titlebar: bool,
}

/// 由目标平台推导窗口外观。抽成纯函数便于在 Windows 上断言 mac 分支的取值。
fn window_chrome(target_os: &str) -> WindowChrome {
    match target_os {
        // macOS：保留原生装饰，红绿灯悬浮左上角；页面自绘三键由注入的 nativeTitleBar 关闭。
        "macos" => WindowChrome {
            decorations: true,
            overlay_titlebar: true,
        },
        // Windows（及其它平台）：无边框 + 页面自绘 ─□×（WINTITLE-01 既有行为）。
        _ => WindowChrome {
            decorations: false,
            overlay_titlebar: false,
        },
    }
}

/// 页面侧读取的壳信息（`window.__AGENTBOARD_SHELL__`）。抽函数便于断言两平台取值。
fn shell_init_script(platform: &str, chrome: WindowChrome) -> String {
    format!(
        "window.__AGENTBOARD_SHELL__ = {{ platform: \"{platform}\", nativeTitleBar: {} }};",
        chrome.overlay_titlebar
    )
}

/// E4：菜单文案集中定义（本地化收尾）。抽成纯数据便于在 Windows 上单测，
/// 防止后续改菜单时把文案回退成英文或漏掉「服务」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MenuLabels {
    services: &'static str,
    hide_template: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit_template: &'static str,
    close_window: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    fullscreen: &'static str,
    minimize: &'static str,
    maximize: &'static str,
}

/// 菜单文案（简体中文，与页面 UI 语言一致；`{app}` 为应用名占位）。
fn menu_labels() -> MenuLabels {
    MenuLabels {
        services: "服务",
        hide_template: "隐藏 {app}",
        hide_others: "隐藏其他",
        show_all: "全部显示",
        quit_template: "退出 {app}",
        close_window: "关闭窗口",
        undo: "撤销",
        redo: "重做",
        cut: "剪切",
        copy: "复制",
        paste: "粘贴",
        select_all: "全选",
        fullscreen: "进入全屏",
        minimize: "最小化",
        maximize: "缩放",
    }
}

/// 把 `{app}` 占位替换为应用名。
fn fill_app(template: &str, app_name: &str) -> String {
    template.replace("{app}", app_name)
}

/// B05：macOS 应用菜单中文化（默认菜单 File/Edit/View/Window/Help 全英文）。
/// 结构对齐 Tauri `Menu::default` 的 mac 段（App/文件/编辑/显示/窗口/帮助），全部用 PredefinedMenuItem
/// 保留系统默认行为与快捷键，只改文案；「帮助」与官方默认同为空子菜单。
/// E4：「服务」子菜单只在 macOS 构造（系统服务是 App 菜单的 mac 惯例位置；Windows 无菜单栏、不构造该项），
/// 文案统一走 `menu_labels()`。
/// 菜单在所有平台构造（Windows 编译期即校验本函数），仅 macOS 挂为菜单栏应用菜单。
fn localized_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_name = app.package_info().name.clone();
    let version = app.package_info().version.to_string();
    let labels = menu_labels();

    let about_item = PredefinedMenuItem::about(
        app,
        None,
        Some(AboutMetadata {
            name: Some(app_name.clone()),
            version: Some(version),
            ..Default::default()
        }),
    )?;
    let sep_about = PredefinedMenuItem::separator(app)?;
    // 服务子菜单由 AppKit 提供（mac 才有），Windows 上不构造。
    #[cfg(target_os = "macos")]
    let services_item = PredefinedMenuItem::services(app, Some(labels.services))?;
    #[cfg(target_os = "macos")]
    let sep_services = PredefinedMenuItem::separator(app)?;
    let hide_template = fill_app(labels.hide_template, &app_name);
    let hide_item = PredefinedMenuItem::hide(app, Some(&hide_template))?;
    let hide_others_item = PredefinedMenuItem::hide_others(app, Some(labels.hide_others))?;
    let show_all_item = PredefinedMenuItem::show_all(app, Some(labels.show_all))?;
    let sep_hide = PredefinedMenuItem::separator(app)?;
    let quit_template = fill_app(labels.quit_template, &app_name);
    let quit_item = PredefinedMenuItem::quit(app, Some(&quit_template))?;

    let mut app_items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&about_item, &sep_about];
    #[cfg(target_os = "macos")]
    {
        app_items.push(&services_item);
        app_items.push(&sep_services);
    }
    app_items.push(&hide_item);
    app_items.push(&hide_others_item);
    app_items.push(&show_all_item);
    app_items.push(&sep_hide);
    app_items.push(&quit_item);
    let app_submenu = Submenu::with_items(app, app_name.clone(), true, &app_items)?;
    let file_submenu = Submenu::with_items(
        app,
        "文件",
        true,
        &[&PredefinedMenuItem::close_window(app, Some(labels.close_window))?],
    )?;
    let edit_submenu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(labels.undo))?,
            &PredefinedMenuItem::redo(app, Some(labels.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(labels.cut))?,
            &PredefinedMenuItem::copy(app, Some(labels.copy))?,
            &PredefinedMenuItem::paste(app, Some(labels.paste))?,
            &PredefinedMenuItem::select_all(app, Some(labels.select_all))?,
        ],
    )?;
    let view_submenu = Submenu::with_items(
        app,
        "显示",
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some(labels.fullscreen))?],
    )?;
    // 窗口/帮助子菜单必须用官方同款 id（WINDOW_SUBMENU_ID / HELP_SUBMENU_ID）：
    // macOS 挂菜单时 Tauri 按这两个 id 调 set_as_windows_menu_for_nsapp / set_as_help_menu_for_nsapp，
    // 换成自动 id 会导致「窗口」菜单失去系统自动窗口列表、「帮助」失去 NSApp 关联（丢系统默认项）。
    let window_submenu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(labels.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(labels.maximize))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(labels.close_window))?,
        ],
    )?;
    // 「帮助」与官方默认菜单一致：mac 上为空子菜单（占位保持五项齐全）。
    let help_submenu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "帮助", true, &[])?;
    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

/// B07：托盘图标字节按平台分流。Windows 沿用 tray.ico（HICON 多帧，按 DPI 缩放）；
/// macOS 用单色 Template PNG（黑 + alpha，icon_as_template 由系统按菜单栏深浅色自动反色），
/// 按 ScaleFactor 选 1x/@2x 贴物理像素。两侧签名一致，调用点在所有平台编译。
#[cfg(target_os = "macos")]
fn tray_icon_bytes(app: &AppHandle) -> &'static [u8] {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    if scale >= 2.0 {
        include_bytes!("../icons/tray@2x.png")
    } else {
        include_bytes!("../icons/tray.png")
    }
}

#[cfg(not(target_os = "macos"))]
fn tray_icon_bytes(_app: &AppHandle) -> &'static [u8] {
    include_bytes!("../icons/tray.ico")
}

/// 建主窗口并挂关窗隐藏/页面加载回调；首次启动与重建共用，保证两条路径窗口行为一致。
fn build_main_window(
    app: &AppHandle,
    url: WebviewUrl,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let chrome = window_chrome(std::env::consts::OS);
    // mut 只在 macOS 目标用到（下面 overlay 分支重绑 builder）；Windows 编译时该分支不编译。
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, url)
        .title("AgentBoard")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        // B06：窗口外观按平台分叉——
        // Windows：去掉系统原生标题栏，改由页面自绘（WindowTitleBar / 启动页 winbar），三键行为保持一致；
        // macOS：保留原生装饰并把标题栏设为 overlay（红绿灯浮在内容左上角、标题隐藏），
        //        页面侧据初始化脚本注入的 `nativeTitleBar` 隐藏自绘 ─□×，避免双份控件。
        .decorations(chrome.decorations)
        // 页面侧判断依据：由壳注入，不靠 UA 嗅探（WKWebView/WebView2 的 UA 会随系统版本漂移）。
        .initialization_script(shell_init_script(std::env::consts::OS, chrome))
        .center()
        .visible(visible)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let handle = webview.app_handle().clone();
                handle
                    .state::<ShellState>()
                    .boot
                    .page_loaded
                    .store(true, Ordering::SeqCst);
                apply_boot(&handle);
            }
        });
    // overlay 标题栏 API 只在 macOS 目标上存在（tauri 源码用 cfg 门禁），其它平台不编译这段。
    #[cfg(target_os = "macos")]
    if chrome.overlay_titlebar {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let window = builder.build()?;

    // 关窗 = 隐藏到托盘；服务继续跑（不触发退出）。
    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_close.hide();
        }
    });

    Ok(window)
}

/// 验收辅助参数：`--quit-after-ms <n>` 或 `--quit-after-ms=<n>`；默认不启用。
fn auto_quit_after_ms() -> Option<u64> {
    arg_value("--quit-after-ms").and_then(|value| value.parse::<u64>().ok())
}

/// 验收辅助参数：`--probe-tray-ms <n>`（隐藏后走托盘唤醒路径并记录窗口状态）、`--probe-out <path>`。
/// 不启用时完全不参与运行；启用时只影响验证流程，不改变托盘/窗口语义。
fn auto_probe_tray_ms() -> Option<u64> {
    arg_value("--probe-tray-ms").and_then(|value| value.parse::<u64>().ok())
}

/// 读取 `--name value` 或 `--name=value` 形式的参数值。
fn arg_value(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            return Some(value.to_string());
        }
    }
    None
}

/// 记录主窗口的可观察状态；`exists=false` 表示 webview 已被销毁。
fn window_snapshot(app: &AppHandle) -> serde_json::Value {
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => serde_json::json!({
            "exists": true,
            "visible": window.is_visible().unwrap_or(false),
            "minimized": window.is_minimized().unwrap_or(false),
            "focused": window.is_focused().unwrap_or(false),
        }),
        None => serde_json::json!({
            "exists": false,
            "visible": false,
            "minimized": false,
            "focused": false,
        }),
    }
}

/// 验收探针：等窗口就绪 → 隐藏 → 走与托盘左键完全相同的 `wake_main_window` → 落盘三段状态后退出。
fn run_tray_probe(app: AppHandle, delay_ms: u64, out_path: std::path::PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let before = window_snapshot(&app);
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
        let hidden = window_snapshot(&app);
        wake_main_window(&app);
        std::thread::sleep(std::time::Duration::from_millis(800));
        let after = window_snapshot(&app);
        let report = serde_json::json!({
            "before": before,
            "hidden": hidden,
            "after_wake": after,
        });
        match std::fs::write(&out_path, serde_json::to_string_pretty(&report).unwrap_or_default()) {
            Ok(()) => eprintln!("托盘探针结果已写入 {}", out_path.display()),
            Err(error) => eprintln!("托盘探针结果写入失败：{error}"),
        }
        shutdown(&app);
        wait_boot_settled(&app);
        app.exit(0);
    });
}

fn main() {
    let builder = tauri::Builder::default()
        // 单例必须最先注册：第二个实例在插件初始化阶段就退出，不会进入 setup（也就不会拉起第二个 server）。
        // macOS 预留（DESKTOP-3）：同一插件在 mac 上同样可用，无需平台私有实现。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二实例：不新建窗口，只把已有窗口唤到前台（与托盘/菜单同一函数）。
            wake_main_window(app);
        }))
        // DEC-7：系统通知插件。Tauri v2 的插件必须在 builder 上注册，仅给 capabilities 权限不够；
        // 权限范围见 capabilities/decision-notifications.json（只覆盖 main 窗口与 127.0.0.1:8787）。
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(ShellState {
                boot: BootState {
                    page_loaded: AtomicBool::new(false),
                    outcome: Mutex::new(None),
                    boot_ok: AtomicBool::new(false),
                    boot_error: Mutex::new(None),
                },
                server: Mutex::new(None),
                quitting: AtomicBool::new(false),
                // CR-6：启动时解析一次端口；探活/导航/重建窗口统一取这里，不再硬编码 8787。
                port: server_process::resolve_port(),
            });

            // B05：macOS 应用菜单中文化。所有平台都构造（Windows 编译期校验），
            // 仅 mac 挂为菜单栏应用菜单；Windows 无菜单栏，构造后丢弃不挂（行为不变）。
            let app_menu = localized_app_menu(app.handle())?;
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu)?;
            #[cfg(not(target_os = "macos"))]
            drop(app_menu);

            // 托盘：菜单「显示 / 退出」。
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // 托盘图标按平台分流（B07）：
            // - Windows 沿用 icons/tray.ico（16/20/24/32/40/48/64 多帧，专为小尺寸重绘的看板剪影；HICON 按位深+面积取帧），
            //   不再拿 1024×1024 的应用图标当托盘图（那在小尺寸缩放后细节全糊）。
            // - macOS 菜单栏惯例是单色 Template Image（黑 + alpha）：配合 icon_as_template 由系统按菜单栏深浅色自动反色，
            //   彩色 ico 在 mac 菜单栏会被压到极小且与菜单栏前景色无关，几乎不可见（本卡现象）。
            //   按 ScaleFactor 选 tray.png（1x=16px）/ tray@2x.png（2x=32px）；tray-icon 恒把托盘高度归一到 18pt，
            //   两档贴物理像素（18/36px）避免 1x 资产在 retina 上放大发糊。
            let tray_icon = tauri::image::Image::from_bytes(tray_icon_bytes(app.handle()))?;
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                // B07：mac 上作为 Template Image 渲染（自动适配深浅色菜单栏）；其它平台该开关无效。
                .icon_as_template(cfg!(target_os = "macos"))
                .menu(&menu)
                // 左键不再弹菜单：左键 = 显示并聚焦窗口；右键仍是菜单。
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => wake_main_window(app),
                    "quit" => {
                        let handle = app.clone();
                        // 停服可能等待数秒：放到后台线程，避免冻结托盘/窗口事件循环。
                        std::thread::spawn(move || {
                            shutdown(&handle);
                            wait_boot_settled(&handle);
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                // 左键单击（Windows 会同时发 Down/Up，只取 Up，避免一次点击触发两遍）。
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        wake_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            // 托盘句柄必须活到进程结束（TrayIcon 被 drop 会移除托盘），故意不释放。
            std::mem::forget(tray);

            // 窗口：先本地启动页（隐藏显示），健康检查通过后再导航到服务页（CR-6：端口读 config.json）。
            build_main_window(app.handle(), WebviewUrl::App("index.html".into()), false)?;

            start_server(app.handle().clone());

            // E1：Dock 角标轮询（仅 mac 起线程）：服务未就绪时线程内部自行退避重试。
            spawn_dock_badge_poller(app.handle().clone());

            // E2：系统通知（mac 通知中心）：卡进入待验收 / 待决策进入宽限时弹系统通知。
            app.manage(NotifiedSet::default());
            spawn_notification_poller(app.handle().clone());

            // 验收辅助（默认不启用）：无 GUI 抓屏权限时，用 `--quit-after-ms <n>` 定时触发
            // 与托盘「退出」完全相同的 shutdown + exit 路径，便于自动化验证「退出后进程消失、锁释放、端口关闭」。
            // 该参数只影响触发时机，不改变停服语义；不带参数时行为与正常托盘退出一致。
            if let Some(delay_ms) = auto_quit_after_ms() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    shutdown(&handle);
                    wait_boot_settled(&handle);
                    handle.exit(0);
                });
            }

            // 验收辅助（默认不启用）：无 GUI 抓屏权限时，用它把「隐藏 → 托盘唤醒」走一遍并落盘窗口状态。
            if let Some(delay_ms) = auto_probe_tray_ms() {
                let out_path = arg_value("--probe-out")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("tray-probe.json"));
                run_tray_probe(app.handle().clone(), delay_ms, out_path);
            }

            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("构建 AgentBoard 桌面壳失败")
        .run(|app, event| {
            // 兜底：任何非托盘路径导致的退出，也先停服再走。
            if let RunEvent::Exit = event {
                shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        open_decision_count, review_issue_count, shell_init_script, wake_steps, window_chrome,
        WakeStep, WindowPhase,
    };

    #[test]
    fn hidden_window_shows_unminimizes_and_focuses() {
        assert_eq!(
            wake_steps(WindowPhase::Hidden, false),
            vec![WakeStep::Show, WakeStep::Unminimize, WakeStep::SetFocus]
        );
    }

    #[test]
    fn minimized_window_does_not_call_show() {
        assert_eq!(
            wake_steps(WindowPhase::Minimized, false),
            vec![WakeStep::Unminimize, WakeStep::SetFocus]
        );
    }

    #[test]
    fn visible_window_only_refocuses() {
        assert_eq!(
            wake_steps(WindowPhase::Visible, false),
            vec![WakeStep::SetFocus]
        );
    }

    #[test]
    fn destroyed_window_recreates_instead_of_show() {
        let steps = wake_steps(WindowPhase::Destroyed, false);
        assert_eq!(steps, vec![WakeStep::Recreate]);
        assert!(!steps.contains(&WakeStep::Show));
    }

    #[test]
    fn quitting_aborts_for_every_phase() {
        for phase in [
            WindowPhase::Hidden,
            WindowPhase::Minimized,
            WindowPhase::Visible,
            WindowPhase::Destroyed,
        ] {
            assert_eq!(wake_steps(phase, true), vec![WakeStep::Abort]);
        }
    }

    #[test]
    fn macos_keeps_native_traffic_lights() {
        let chrome = window_chrome("macos");
        assert!(chrome.decorations, "macOS 必须保留原生装饰才有红绿灯");
        assert!(chrome.overlay_titlebar, "macOS 标题栏应为 overlay");
    }

    #[test]
    fn windows_keeps_self_drawn_titlebar() {
        let chrome = window_chrome("windows");
        assert!(!chrome.decorations, "Windows 保持无边框自绘标题栏");
        assert!(!chrome.overlay_titlebar);
    }

    #[test]
    fn init_script_exposes_native_titlebar_flag() {
        let mac = shell_init_script("macos", window_chrome("macos"));
        assert!(mac.contains("platform: \"macos\""), "{mac}");
        assert!(mac.contains("nativeTitleBar: true"), "{mac}");
        let win = shell_init_script("windows", window_chrome("windows"));
        assert!(win.contains("nativeTitleBar: false"), "{win}");
    }

    /// E4：菜单文案必须保持中文且包含「服务」；`{app}` 占位要能替换成应用名。
    #[test]
    fn menu_labels_stay_localized_and_include_services() {
        let labels = super::menu_labels();
        assert_eq!(labels.services, "服务");
        assert_eq!(super::fill_app(labels.hide_template, "AgentBoard"), "隐藏 AgentBoard");
        assert_eq!(super::fill_app(labels.quit_template, "AgentBoard"), "退出 AgentBoard");
        let all = [
            ("services", labels.services),
            ("hide_others", labels.hide_others),
            ("show_all", labels.show_all),
            ("close_window", labels.close_window),
            ("undo", labels.undo),
            ("redo", labels.redo),
            ("cut", labels.cut),
            ("copy", labels.copy),
            ("paste", labels.paste),
            ("select_all", labels.select_all),
            ("fullscreen", labels.fullscreen),
            ("minimize", labels.minimize),
            ("maximize", labels.maximize),
        ];
        for (name, value) in all {
            assert!(!value.is_empty(), "{name} 不能为空");
            assert!(
                value.chars().any(|c| c as u32 > 0x2E80),
                "{name} 必须是中文：{value}"
            );
        }
    }

    #[test]
    fn dock_badge_counts_review_issues_from_fields_status_array() {
        let issues = serde_json::json!([
            { "status": "待验收" },
            { "status": "已关闭" },
            { "status": "待验收" },
            { "status": "进行中" },
            { "status": "待规划" }
        ]);
        assert_eq!(review_issue_count(&issues), Some(2));
        assert_eq!(review_issue_count(&serde_json::json!([])), Some(0));
        // 非 JSON 数组（接口形态变化）→ None：本轮不更新角标
        assert_eq!(review_issue_count(&serde_json::json!({ "items": [] })), None);
    }

    #[test]
    fn dock_badge_reads_open_decisions_from_counts() {
        let decisions = serde_json::json!({
            "decisions": [],
            "counts": { "grace": 1, "open": 3, "stale_open": 0, "answered_recent": 0 }
        });
        assert_eq!(open_decision_count(&decisions), Some(3));
        assert_eq!(
            open_decision_count(&serde_json::json!({ "decisions": [] })),
            None
        );
    }

    /// E1 取数链路对账（只读 GET，依赖本机 8787 看板服务在跑；CI/无服务环境跳过：
    /// `cargo test -- --ignored` 显式执行）。与 `kb stats --workspace <id>` 的待验收 +
    /// `kb decisions --state open` 条数同源，数字一致（角标为全部工作区之和）。
    #[test]
    #[ignore = "依赖本机 8787 看板服务（只读 GET）"]
    fn dock_badge_count_against_live_server() {
        let count = super::dock_badge_count(8787);
        assert!(count.is_some(), "取数失败：workspaces/issues/decisions 任一请求未通过");
        assert!(count.unwrap() >= 0);
    }

    #[test]
    fn notification_first_round_seeds_baseline_without_events() {
        let notified = super::NotifiedSet::default();
        let events = super::diff_notification_events(
            &notified,
            vec![("card-1".into(), "存量卡".into())],
            vec![("dec-1".into(), "存量决策？".into())],
        );
        assert!(events.reviews.is_empty() && events.graces.is_empty());
        assert!(notified.seeded.load(std::sync::atomic::Ordering::SeqCst));
        // 同一批再次差分：已入基线，不重复弹
        let again = super::diff_notification_events(
            &notified,
            vec![("card-1".into(), "存量卡".into())],
            vec![("dec-1".into(), "存量决策？".into())],
        );
        assert!(again.reviews.is_empty() && again.graces.is_empty());
    }

    #[test]
    fn notification_new_ids_appear_once_and_grace_question_truncates() {
        let notified = super::NotifiedSet::default();
        super::diff_notification_events(&notified, vec![], vec![]); // 建基线
        let long_question = "问".repeat(120);
        let events = super::diff_notification_events(
            &notified,
            vec![("card-2".into(), "新完成的卡".into())],
            vec![("dec-2".into(), long_question.clone())],
        );
        assert_eq!(events.reviews, vec!["新完成的卡".to_string()]);
        assert_eq!(events.graces.len(), 1);
        assert_eq!(events.graces[0].chars().count(), 80);
        // 重复出现同一 id：不再弹
        let repeat = super::diff_notification_events(
            &notified,
            vec![("card-2".into(), "新完成的卡".into())],
            vec![("dec-2".into(), long_question)],
        );
        assert!(repeat.reviews.is_empty() && repeat.graces.is_empty());
    }
}
