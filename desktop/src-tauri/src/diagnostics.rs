//! 【D14】壳侧诊断日志：把「壳做了什么决定、为什么」落盘到 `%APPDATA%\AgentBoard\logs\main.log`。
//!
//! ## 为什么自建而不用 `tauri-plugin-log`
//!
//! 该插件（`tauri-plugin-log` 2.10.2，Apache-2.0 OR MIT，rust-version 1.90）在 Rust 侧可直接用
//! （`pub use log;` + `attach_logger`），但**轮转模型与需求不符**：
//! - `RotationStrategy::KeepAll` → 改名成 `<name>_<yyyy-MM-dd_HH-mm-ss>.log`
//! - `KeepSome(n)` → 同上，再删旧 dated 文件
//! - `KeepOne`（默认）→ `fs::remove_file` 直接删除旧文件
//!
//! 三种策略都不产生 `.1` 后缀，做不到「5MB → main.log.1 保留一代」；且它默认
//! `max_file_size = 40000` 字节。为一条轮转约定引入一个依赖 + 一套用不上的 fern 过滤器，
//! 不如几十行自建追加器：行为可测、阈值可单测、不新增依赖。
//!
//! ## 落盘内容
//!
//! 只记「壳的决策与取证所需事实」：启动序列（mode/exe_dir/port 及来源/资源根）、端口探测三态、
//! 复用 vs spawn、子进程三要素（node/entry/PID）、启动失败原因、停服三态与终止 pid。
//! 不记业务数据、不记用户输入。
//!
//! ## 路径与轮转
//!
//! `<configDir>/logs/main.log`，即 `%APPDATA%\AgentBoard\logs\main.log` —— 与 `server.log` 同目录，
//! 且**不落安装根**（D6 修过的卸载残留问题不能回退）。
//! 单文件超过 [`MAX_BYTES`] 时轮转为 `main.log.1`（保留一代，覆盖旧 `.1`）。
//!
//! ## 线程
//!
//! 文件句柄放在 `Mutex` 里，可从任意线程写（启动线程、托盘线程、主线程的 `RunEvent::Exit`）。
//! 写失败静默忽略：日志不得影响壳的行为。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单文件上限：5MB。与用户可见的日志体积预期一致；超过即轮转为 `.1`。
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 全局单例，进程内只初始化一次。
static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

struct Sink {
    path: PathBuf,
    file: Option<fs::File>,
}

impl Sink {
    fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        Self { path, file }
    }

    /// 写一行；超过阈值先轮转。任何失败静默忽略。
    fn write_line(&mut self, line: &str) {
        if self.file.is_none() {
            // 首次打开失败（目录被占/权限）后仍重试，避免一次失败永久失声。
            if let Some(parent) = self.path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        let rotate_due = fs::metadata(&self.path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false);
        if rotate_due {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.write_all(b"\n");
            let _ = file.flush();
        }
    }

    /// `main.log` → `main.log.1`（覆盖旧 `.1`），然后重开新文件。
    fn rotate(&mut self) {
        self.file = None;
        let rotated = rotated_path(&self.path);
        // Windows 上删除已存在的 .1 再改名；失败则放弃本轮轮转（继续追加，不丢日志）。
        let _ = fs::remove_file(&rotated);
        if fs::rename(&self.path, &rotated).is_err() {
            return;
        }
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
    }
}

/// 轮转目标路径：`main.log` → `main.log.1`。
fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// 日志路径：`<configDir>/logs/main.log`。
pub fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("main.log")
}

/// 初始化（幂等）。重复调用只生效第一次。
pub fn init(config_dir: &Path) {
    let path = log_path(config_dir);
    let _ = SINK.get_or_init(|| Mutex::new(Sink::open(path)));
}

/// 时间戳：`YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC，与 server.log 的 `toISOString()` 同形，便于对齐时间轴）。
fn timestamp() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// 拼一行（不落盘）：`[时间戳] [级别] 消息`。抽出来便于单测格式。
pub fn format_line(level: &str, message: &str) -> String {
    format!("[{}] [{}] {}", timestamp(), level, message)
}

/// 写一行日志。未 `init` 时静默丢弃（不 panic：日志不得影响启动）。
pub fn log(level: &str, message: &str) {
    let line = format_line(level, message);
    // 同时打 stderr：debug 构建与 `--quit-after-ms` 验收时可直接在控制台看到。
    eprintln!("{line}");
    if let Some(sink) = SINK.get() {
        if let Ok(mut guard) = sink.lock() {
            guard.write_line(&line);
        }
    }
}

pub fn info(message: impl AsRef<str>) {
    log("info", message.as_ref());
}

pub fn warn(message: impl AsRef<str>) {
    log("warn", message.as_ref());
}

pub fn error(message: impl AsRef<str>) {
    log("error", message.as_ref());
}

#[cfg(test)]
mod tests {
    use super::{format_line, log_path, rotated_path, Sink, MAX_BYTES};
    use std::fs;
    use std::path::Path;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ab-diag-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn log_path_is_under_config_dir_logs() {
        let path = log_path(Path::new("C:\\Users\\u\\AppData\\Roaming\\AgentBoard"));
        let text = path.to_string_lossy().replace('\\', "/");
        assert!(text.ends_with("AgentBoard/logs/main.log"), "实际 {text}");
        // 不得落在兜底 .logs（安装根残留的根因）
        assert!(!text.contains("/.logs/"), "实际 {text}");
    }

    #[test]
    fn rotated_path_appends_dot_one() {
        let rotated = rotated_path(Path::new("C:\\data\\logs\\main.log"));
        assert_eq!(rotated.to_string_lossy(), "C:\\data\\logs\\main.log.1");
    }

    #[test]
    fn max_bytes_is_five_megabytes() {
        assert_eq!(MAX_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn format_line_has_timestamp_and_level() {
        let line = format_line("info", "端口探测 free");
        assert!(line.starts_with('['), "实际 {line}");
        assert!(line.contains("] [info] "), "实际 {line}");
        assert!(line.ends_with("端口探测 free"), "实际 {line}");
        // ISO-8601 UTC 形态，可与 server.log 对齐
        assert!(line.contains('T') && line.contains('Z'), "实际 {line}");
    }

    #[test]
    fn sink_writes_line_to_disk() {
        let dir = temp_dir("write");
        let path = log_path(&dir);
        let mut sink = Sink::open(path.clone());
        sink.write_line("[t] [info] hello");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("hello"), "实际 {text}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sink_rotates_to_dot_one_when_over_limit() {
        let dir = temp_dir("rotate");
        let path = log_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // 预置一个达到阈值的文件
        fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();

        let mut sink = Sink::open(path.clone());
        sink.write_line("[t] [info] after-rotate");

        let rotated = rotated_path(&path);
        assert!(rotated.exists(), "应生成 main.log.1");
        assert_eq!(
            fs::metadata(&rotated).unwrap().len(),
            MAX_BYTES,
            ".1 应是轮转前的内容"
        );
        let fresh = fs::read_to_string(&path).unwrap();
        assert!(fresh.contains("after-rotate"), "新文件应只含轮转后的行，实际 {fresh}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sink_keeps_only_one_rotation() {
        let dir = temp_dir("keepone");
        let path = log_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rotated = rotated_path(&path);

        // 第一次轮转
        fs::write(&path, vec![b'a'; MAX_BYTES as usize]).unwrap();
        Sink::open(path.clone()).write_line("[t] [info] first");
        // 第二次轮转：旧 .1 应被覆盖而不是累积成 .2
        fs::write(&path, vec![b'b'; MAX_BYTES as usize]).unwrap();
        Sink::open(path.clone()).write_line("[t] [info] second");

        assert!(rotated.exists());
        assert!(!rotated_path(&rotated).exists(), "不应产生 .1.1 / .2");
        let kept = fs::read(&rotated).unwrap();
        assert_eq!(kept.len(), MAX_BYTES as usize);
        assert_eq!(kept[0], b'b', "保留的应是最近一次轮转的内容");
        fs::remove_dir_all(&dir).ok();
    }

    /// 走真实公开入口 `init` + `info`：证明「初始化后调用 info 会落到 <configDir>/logs/main.log」。
    /// 用唯一临时 configDir，不碰真实 %APPDATA%。
    #[test]
    fn init_then_info_writes_to_main_log() {
        let dir = temp_dir("init");
        // init 是 OnceLock 幂等：同一测试进程内多次调用只生效第一次，
        // 因此这里只断言首次初始化的目录里出现 main.log。
        super::init(&dir);
        super::info("D14 探针：启动序列落盘验证");
        super::warn("D14 探针：warn 级");
        super::error("D14 探针：error 级");

        let path = log_path(&dir);
        assert!(path.exists(), "init 后应创建 main.log");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("D14 探针"), "应写入消息体，实际 {text}");
        assert!(text.contains("[info]") || text.contains("[warn]") || text.contains("[error]"));
        fs::remove_dir_all(&dir).ok();
    }
}
