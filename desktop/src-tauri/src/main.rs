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
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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
    /// 启动结果：`Ok(())` = 服务健康；`Err(msg)` = 可读失败原因。`take()` 保证只应用一次。
    outcome: Mutex<Option<Result<(), String>>>,
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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match outcome {
        Ok(()) => {
            // 导航到既有 8787 页面：同源、无自定义协议、无请求注入。
            let _ = window.eval(&format!("location.replace('{}')", server_process::base_url()));
        }
        Err(message) => {
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 验收辅助参数：`--quit-after-ms <n>` 或 `--quit-after-ms=<n>`；默认不启用。
fn auto_quit_after_ms() -> Option<u64> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--quit-after-ms" {
            return args.next().and_then(|value| value.parse::<u64>().ok());
        }
        if let Some(value) = arg.strip_prefix("--quit-after-ms=") {
            return value.parse::<u64>().ok();
        }
    }
    None
}

fn main() {
    let builder = tauri::Builder::default()
        // 单例必须最先注册：第二个实例在插件初始化阶段就退出，不会进入 setup（也就不会拉起第二个 server）。
        // macOS 预留（DESKTOP-3）：同一插件在 mac 上同样可用，无需平台私有实现。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            app.manage(ShellState {
                boot: BootState {
                    page_loaded: AtomicBool::new(false),
                    outcome: Mutex::new(None),
                },
                server: Mutex::new(None),
                quitting: AtomicBool::new(false),
            });

            // 托盘：菜单「显示 / 退出」。
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // 显式读 icons/icon.png：不依赖「config 里有图标就一定有默认窗口图标」，保证托盘一定可见。
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
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
                .build(app)?;
            // 托盘句柄必须活到进程结束（TrayIcon 被 drop 会移除托盘），故意不释放。
            std::mem::forget(tray);

            // 窗口：先本地启动页（隐藏显示），健康检查通过后再导航到 8787。
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AgentBoard")
                .inner_size(1280.0, 860.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .visible(false)
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
