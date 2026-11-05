//! 【DESKTOP-1】AgentBoard 桌面壳（Tauri v2）。
//!
//! 壳只做四件事：**窗口、托盘、单例、server 进程生命周期**。
//! - 窗口：本地启动页 → 健康检查通过后导航到 `http://127.0.0.1:8787`（不改任何 API 契约）；
//! - 托盘：菜单含「显示」「退出」；关窗 = 隐藏到托盘，服务继续运行；
//! - 单例：Tauri 官方 `tauri-plugin-single-instance`（第二个实例直接退出，回调聚焦已有窗口）；
//! - 生命周期：8787 未起时由壳用 node 拉起 server（见 `server_process.rs`），托盘「退出」时停服并释放 `server.lock`。
//!
//! 平台：仅 Windows 实现。macOS 的窗口/菜单栏托盘/node 二进制差异留给 DESKTOP-3，
//! 本文件只在单例与托盘处保留注释，不写 mac 实现代码。

mod server_process;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
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
}

struct BootState {
    /// 本地启动页是否已加载完成（未完成前不 eval，避免把错误写进空白文档）。
    page_loaded: AtomicBool,
    /// 启动结果：`Ok(())` = 服务健康；`Err(msg)` = 可读失败原因。`take()` 保证只应用一次
    /// （导航到 8787 本身会再触发一次 PageLoad Finished，重复应用会变成反复 location.replace）。
    outcome: Mutex<Option<Result<(), String>>>,
    /// 启动结论留档：窗口被销毁后重建时用它复现同一落地动作（`outcome` 已被 take 消费掉）。
    boot_ok: AtomicBool,
    boot_error: Mutex<Option<String>>,
}

/// 启动结果落地：页面已加载且结果已产生时，导航到 8787 或把错误显示在本地页上，然后显示窗口。
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
            // 导航到既有 8787 页面：同源、无自定义协议、无请求注入。
            let _ = window.eval(&format!("location.replace('{}')", server_process::base_url()));
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
        let result = match server_process::ensure_server() {
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
/// 启动已成功则直接加载 8787；启动失败则回到本地页并复现同一错误文案；启动未完成则等启动线程落地。
fn recreate_main_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    state.boot.page_loaded.store(false, Ordering::SeqCst);
    let url = if state.boot.boot_ok.load(Ordering::SeqCst) {
        WebviewUrl::External(
            server_process::base_url()
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

/// 建主窗口并挂关窗隐藏/页面加载回调；首次启动与重建共用，保证两条路径窗口行为一致。
fn build_main_window(
    app: &AppHandle,
    url: WebviewUrl,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, url)
        .title("AgentBoard")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
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
        })
        .build()?;

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
            });

            // 托盘：菜单「显示 / 退出」。
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // 托盘用独立资源 icons/tray.ico（16/20/24/32/40/48/64 多帧，专为小尺寸重绘的看板剪影），
            // 不再拿 1024×1024 的应用图标当托盘图（那在小尺寸缩放后细节全糊）。
            // 取舍：Windows 托盘走 HICON，Tauri 的 ico 解码（image crate）取「位深最高 + 面积最大」的一帧（这里是 64×64），
            // 再由系统按 DPI 缩到 16/20/24/32；多帧保留是为了同一文件可直接交给 Windows/安装器与未来按 DPI 选帧，
            // 不需要为每种缩放再生成一套资源。
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.ico"))?;
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
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

            // 窗口：先本地启动页（隐藏显示），健康检查通过后再导航到 8787。
            build_main_window(app.handle(), WebviewUrl::App("index.html".into()), false)?;

            start_server(app.handle().clone());

            // 验收辅助（默认不启用）：无 GUI 抓屏权限时，用 `--quit-after-ms <n>` 定时触发
            // 与托盘「退出」完全相同的 shutdown + exit 路径，便于自动化验证「退出后进程消失、锁释放、端口关闭」。
            // 该参数只影响触发时机，不改变停服语义；不带参数时行为与正常托盘退出一致。
            if let Some(delay_ms) = auto_quit_after_ms() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    shutdown(&handle);
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
    use super::{wake_steps, WakeStep, WindowPhase};

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
}
