#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AgentBoard 账号凭据导出器（ACC-11）。

由服务端 `services/accounts/credentialImport.ts` 通过 `execFile('python', [...])` 调用，
**只在用户显式触发导入时运行**（不后台扫描、不开机扫描）。

输出契约（stdout 单行 JSON）：
    [{"platform": "workbuddy|trae|minimax", "account_key": "...", "display_hint": "...",
      "token": "...", "expires_at": 1793613258.13,
      "refresh_token": "...（仅 minimax 有）"}]
诊断信息一律写 stderr（不含 token）；退出码 0=成功（含 0 条）、2=环境不支持、3=读取失败。

平台来源：
- workbuddy / trae：Windows 进程内存扫描（只读），按 JWT 的 `sub` 去重 → 天然多账号；
- minimax：读 ~/.minimax/auth/<env>/<region>/<client>/auth.json（OAuth 记录，取有效期最晚一条）。

安全：不写任何明文临时文件；token 只在内存中传递，stderr 只输出脱敏片段。
"""
import argparse
import base64
import ctypes
import json
import os
import re
import sys
import time
from ctypes import wintypes

JWT_RE = re.compile(rb"(eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,})")
UTF16_EYJ = "eyJ".encode("utf-16le")
CHUNK = 4 * 1024 * 1024
OVERLAP = 64 * 1024
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
TH32CS_SNAPPROCESS = 0x2

PLATFORM_PROCESS_HINTS = {
    "workbuddy": ("workbuddy",),
    "trae": ("trae",),
}
MINIMAX_AUTH_ROOT = os.path.join(os.path.expanduser("~"), ".minimax", "auth")


def log(message):
    sys.stderr.write("[export-credentials] %s\n" % message)
    sys.stderr.flush()


def redact(token):
    if not token:
        return "<empty>"
    if len(token) <= 24:
        return token[:6] + "***"
    return token[:12] + "..." + token[-6:]


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


def _process_names():
    """返回 [(pid, exe_name_lower)]。非 Windows 返回空。"""
    if os.name != "nt":
        return []
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return []
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    result = []
    try:
        ok = kernel32.Process32First(snapshot, ctypes.byref(entry))
        while ok:
            result.append((int(entry.th32ProcessID), entry.szExeFile.decode("ascii", "ignore").lower()))
            ok = kernel32.Process32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return result


def _scan_process(pid):
    """只读扫描单个进程内存，返回去重后的 JWT 字符串列表。"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return []
    found = []
    seen = set()
    mbi = MEMORY_BASIC_INFORMATION()
    address = 0
    try:
        while address < 0x7FFFFFFFFFFF:
            if kernel32.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                address += 0x1000
                continue
            size = int(mbi.RegionSize)
            if size <= 0:
                address += 0x1000
                continue
            if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) not in (0x01, 0x00):  # 跳过 PAGE_NOACCESS / GUARD 之外的可读区
                offset = 0
                while offset < size:
                    want = min(CHUNK, size - offset)
                    buffer = ctypes.create_string_buffer(want)
                    read = ctypes.c_size_t()
                    if not kernel32.ReadProcessMemory(handle, ctypes.c_void_p(address + offset), buffer, want, ctypes.byref(read)):
                        break
                    data = buffer.raw[: read.value]
                    for match in JWT_RE.finditer(data):
                        token = match.group(1).decode("ascii", "ignore")
                        if token not in seen:
                            seen.add(token)
                            found.append(token)
                    position = 0
                    while True:
                        index = data.find(UTF16_EYJ, position)
                        if index < 0:
                            break
                        position = index + 2
                        segment = data[index:index + 4096].decode("utf-16le", "ignore")
                        for match in JWT_RE.finditer(segment.encode("ascii", "ignore")):
                            token = match.group(1).decode("ascii", "ignore")
                            if token not in seen:
                                seen.add(token)
                                found.append(token)
                    offset += CHUNK - OVERLAP
            address += size if size > 0 else 0x1000
    finally:
        kernel32.CloseHandle(handle)
    return found


def decode_jwt_claims(token):
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload + padding).decode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001
        return {}


def collect_from_processes(platform, pids=None, names=None):
    hints = tuple(names) if names else PLATFORM_PROCESS_HINTS.get(platform, ())
    if not hints:
        return []
    if os.name != "nt":
        log("%s 需要 Windows 进程内存扫描，当前平台不支持" % platform)
        return []
    accounts = {}
    targets = [(pid, '') for pid in (pids or [])]
    if not pids:
        targets = [(pid, name) for pid, name in _process_names() if any(hint in name for hint in hints)]
    for pid, name in targets:
        for token in _scan_process(pid):
            claims = decode_jwt_claims(token)
            subject = str(claims.get("sub") or "").strip()
            if not subject:
                continue
            expires = claims.get("exp")
            entry = {
                "platform": platform,
                "account_key": subject,
                "display_hint": (claims.get("nickname") or claims.get("preferred_username") or subject)[:120],
                "token": token,
                "expires_at": float(expires) if isinstance(expires, (int, float)) else None,
            }
            previous = accounts.get(subject)
            if previous is None or (entry["expires_at"] or 0) > (previous["expires_at"] or 0):
                accounts[subject] = entry
    return list(accounts.values())


def collect_minimax():
    if not os.path.isdir(MINIMAX_AUTH_ROOT):
        log("未找到 minimax 凭据目录：%s" % MINIMAX_AUTH_ROOT)
        return []
    best = None
    pattern = os.path.join(MINIMAX_AUTH_ROOT, "*", "*", "*", "auth.json")
    import glob

    for path in sorted(glob.glob(pattern)):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception as error:  # noqa: BLE001
            log("读取 %s 失败：%s" % (path, error))
            continue
        for record_key, record in (data.get("records") or {}).items():
            token = str(record.get("accessToken") or "").strip()
            if not token:
                continue
            expires_at = record.get("expiresAtMs")
            expires = float(expires_at) / 1000.0 if isinstance(expires_at, (int, float)) else None
            entry = {
                "platform": "minimax",
                # account_key 用凭据记录键（如 com.minimax...clientId），不含 token
                "account_key": str(record.get("clientId") or record_key)[:200],
                "display_hint": str(record.get("audience") or record_key)[:120],
                "token": token,
                "expires_at": expires,
            }
            # ACC-FIX-3：带上 refresh_token，服务端 401 时可自行续期（不写日志、不回显）
            refresh_token = str(record.get("refreshToken") or "").strip()
            if refresh_token:
                entry["refresh_token"] = refresh_token
            if best is None or (expires or 0) > (best["expires_at"] or 0):
                best = entry
    return [best] if best else []


def main(argv=None):
    parser = argparse.ArgumentParser(description="导出本机账号凭据（只读，显式触发）")
    parser.add_argument("--platform", choices=["workbuddy", "trae", "minimax", "all"], default="all")
    parser.add_argument("--json", action="store_true", help="输出单行 JSON（服务端只用这种模式）")
    # 仅用于验证/调试：显式指定要扫描的 pid 或进程名子串（缺省按平台真实进程名）
    parser.add_argument("--pid", action="append", type=int, default=[], help="【仅测试/调试用，生产调用不得传入】只扫描指定 pid（可重复）")
    parser.add_argument("--process-name", action="append", default=[], help="【仅测试/调试用，生产调用不得传入】按进程名子串扫描（可重复）")
    args = parser.parse_args(argv)

    platforms = ["workbuddy", "trae", "minimax"] if args.platform == "all" else [args.platform]
    results = []
    for platform in platforms:
        try:
            if platform == "minimax":
                found = collect_minimax()
            else:
                found = collect_from_processes(platform, pids=args.pid, names=args.process_name)
        except Exception as error:  # noqa: BLE001
            log("%s 导出异常：%s" % (platform, error))
            found = []
        log("%s: 发现 %d 个账号（token %s）" % (platform, len(found), ", ".join(redact(item["token"]) for item in found) or "-"))
        results.extend(found)

    sys.stdout.write(json.dumps(results, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
