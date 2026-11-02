# -*- coding: utf-8 -*-
r"""
trae_export.py —— 宿主机(Win)侧脚本：从 TRAE 进程内存提取 JWT 与设备档案，
写入青龙共享目录 D:\qinglong\data\scripts\.trae_token.json，
供容器内青龙定时任务 trae_checkin_ql.py 读取并完成每日签到。

用法：
  python trae_export.py            # 提取并写入共享 JSON
  python trae_export.py --dry-run  # 仅提取并预览（脱敏），不写文件

TRAE 没在运行时不再直接失败：脚本会自动启动 TRAE SOLO CN.exe，等内存里出现新 JWT
（凭据在磁盘，启动即免登录恢复，实测约 16 秒），取完再关掉本次启动的进程树。
用户原本开着的 TRAE 不会被关。可执行文件路径可用环境变量 TRAE_EXE 覆盖。

安全：
  - JWT 等同账号密码：不打印完整 token（脱敏）；只读取 TRAE 进程内存。
  - 网络仅访问 api.trae.cn 官方接口（由青龙脚本执行，本脚本不触网）。
"""
import sys
import os
import re
import json
import time
import ctypes
import subprocess
from datetime import datetime
from ctypes import wintypes as wt

SIZE_T = ctypes.c_ulonglong
OUT_FILE = r"D:\qinglong\data\scripts\.trae_token.json"

PROC_NAMES = ("TRAE SOLO CN.exe", "TRAE.exe", "trae.exe")

kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000

MEMORY_BASIC_INFORMATION = type("MBI", (ctypes.Structure,), {
    "_fields_": [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
    ],
})()


def log(*a):
    print("[trae-export] " + " ".join(str(x) for x in a), flush=True)


def redact(s):
    if not s:
        return "<empty>"
    if len(s) <= 18:
        return s[:4] + "***" + s[-2:]
    return s[:12] + "..." + s[-6:]


def enum_pids():
    arr = (wt.DWORD * 4096)()
    cb = wt.DWORD()
    if psapi.EnumProcesses(ctypes.byref(arr), ctypes.sizeof(arr), ctypes.byref(cb)) == 0:
        return []
    return list(arr[: cb.value // ctypes.sizeof(wt.DWORD)])


def pid_name(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(260)
        psapi.GetModuleBaseNameW(h, None, buf, 260)
        return buf.value
    finally:
        kernel32.CloseHandle(h)


def trae_pids():
    pids = []
    for pid in enum_pids():
        if pid == 0:
            continue
        name = pid_name(pid)
        if name and name in PROC_NAMES:
            pids.append(pid)
    return pids


def scan_pid(pid):
    """扫描单个进程内存，返回候选 token 列表：[(kind, value), ...]"""
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return []
    hits = []
    seen = set()
    mbi = MEMORY_BASIC_INFORMATION
    addr = 0
    try:
        while addr < 0x7FFFFFFFF000:
            if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                addr += 0x1000
                continue
            if mbi.State == MEM_COMMIT and mbi.RegionSize > 0:
                size = mbi.RegionSize
                if size > 16 * 1024 * 1024:
                    size = 16 * 1024 * 1024
                buf = ctypes.create_string_buffer(size)
                read = SIZE_T()
                if kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(read)):
                    data = buf[:read.value]
                    for m in re.finditer(rb"Cloud-IDE-JWT\s+([A-Za-z0-9_.\-]+)", data):
                        v = m.group(1).decode("ascii", "ignore")
                        if v not in seen:
                            seen.add(v)
                            hits.append(("cloudide", v))
                    for m in re.finditer(rb'"token":"([A-Za-z0-9_.\-]+\.[A-Za-z0-9_.\-]+\.[A-Za-z0-9_.\-]+)"', data):
                        v = m.group(1).decode("ascii", "ignore")
                        if v not in seen:
                            seen.add(v)
                            hits.append(("rawjwt", v))
            addr = addr + mbi.RegionSize
            if addr <= 0:
                break
    finally:
        kernel32.CloseHandle(h)
    return hits


def extract_token():
    """从所有 TRAE 进程内存提取最优 token。优先 cloudide 形态。返回 (token, err)。"""
    pids = trae_pids()
    if not pids:
        return None, "未找到 TRAE 进程（请先打开并登录 TRAE SOLO CN）"
    cloudide, rawjwt = [], []
    for pid in pids:
        try:
            for kind, val in scan_pid(pid):
                (cloudide if kind == "cloudide" else rawjwt).append(val)
        except Exception as e:  # noqa: BLE001
            log("扫描进程 %s 异常: %s" % (pid, e))
    if cloudide:
        return cloudide[0], None
    if rawjwt:
        return rawjwt[0], None
    return None, "进程内存中未找到可用 token（TRAE 可能尚未完成登录）"


def extract_device_profile():
    """从 TRAE 进程内存提取设备档案（claim 需设备绑定，缺则 code=9004）。"""
    prof = {}
    pats = {
        "device_id": rb'device_id["\':\s]+([0-9]{10,20})',
        "device_brand": rb'"device_brand"\s*:\s*"([^"]+)"',
        "device_cpu": rb'"device_cpu"\s*:\s*"([^"]+)"',
        "os_name": rb'"os_name"\s*:\s*"([^"]+)"',
    }
    for pid in trae_pids():
        h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            continue
        mbi = MEMORY_BASIC_INFORMATION
        addr = 0
        try:
            while addr < 0x7FFFFFFFF000:
                if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                    addr += 0x1000
                    continue
                if mbi.State == MEM_COMMIT and mbi.RegionSize > 0:
                    size = min(mbi.RegionSize, 16 * 1024 * 1024)
                    buf = ctypes.create_string_buffer(size)
                    rd = SIZE_T()
                    if kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(rd)):
                        d = buf[:rd.value]
                        for key, pat in pats.items():
                            if key not in prof:
                                m = re.search(pat, d)
                                if m:
                                    value = m.group(1).decode("utf-8", "ignore").strip()
                                    # 内存里会扫到 "..." 这类占位垃圾，发出去会让 claim 带上假设备头
                                    if len(value) >= 2 and not set(value) <= set(".-_ "):
                                        prof[key] = value
                addr = addr + mbi.RegionSize
                if addr <= 0:
                    break
        finally:
            kernel32.CloseHandle(h)
        if all(k in prof for k in pats):
            break
    return prof


TRAE_EXES = (
    r"D:\Program Files\TRAE SOLO CN\TRAE SOLO CN.exe",
    r"C:\Program Files\TRAE SOLO CN\TRAE SOLO CN.exe",
)


def find_exe():
    for path in ((os.environ.get("TRAE_EXE") or "").strip(),) + TRAE_EXES:
        if path and os.path.exists(path):
            return path
    return None


def launch_and_wait(timeout=150):
    """TRAE 没在跑就把它拉起来，等内存里出现可用 token。返回 (token, err, 本次启动的 pid)。"""
    exe = find_exe()
    if not exe:
        return None, "未找到 TRAE 可执行文件（可用环境变量 TRAE_EXE 指定路径）", None
    log("TRAE 未运行，自动启动: %s" % exe)
    proc = subprocess.Popen([exe], close_fds=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(8)
        token, _ = extract_token()
        if token:
            return token, None, proc.pid
        log("  等待 TRAE 恢复登录态…")
    return None, "启动后 %d 秒内内存里仍无可用 token（可能需要手动登录一次）" % timeout, proc.pid


def shutdown(pid):
    """只关本次自己拉起来的进程树，用户原本开着的 TRAE 不动。"""
    subprocess.call(["taskkill", "/T", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("已关闭本次启动的 TRAE (pid=%s)" % pid)


def main():
    dry_run = "--dry-run" in sys.argv
    launched = None
    token, err = extract_token()
    if err:
        log(err + " -> 尝试自动启动 TRAE 刷新")
        token, err, launched = launch_and_wait()
        if err:
            if launched:
                shutdown(launched)
            log("ERROR: " + err)
            return 2
    log("已提取 token（脱敏）: " + redact(token))
    dev = extract_device_profile()
    log("设备档案: %s" % ({k: v for k, v in dev.items() if v}) or "<empty>")
    if launched:
        shutdown(launched)

    if dry_run:
        log("[DRY-RUN] 不写文件。将写入: " + OUT_FILE)
        return 0

    payload = {
        "token": token,
        "device_id": dev.get("device_id", ""),
        "device_brand": dev.get("device_brand", ""),
        "os_name": dev.get("os_name", ""),
        "device_cpu": dev.get("device_cpu", ""),
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    try:
        os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        log("已写入: " + OUT_FILE)
        if not dev.get("device_id"):
            log("警告：未取到 device_id，青龙签到 claim 可能失败(code=9004)，请重试本脚本。")
        return 0
    except Exception as e:  # noqa: BLE001
        log("写入失败: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())