# -*- coding: utf-8 -*-
r"""
memjwt.py —— 宿主机(Win) 进程内存 JWT 扫描器（共享模块）。

WorkBuddy / MiniMax Code 这类 Electron 客户端的登录令牌只存在于进程内存里，
落盘文件要么过期要么为空，只能从内存里捞。供 workbuddy_export.py 与
minimax_memory_export.py 共用，避免两套扫描逻辑各自漂移。

实现要点（都是踩过的坑）：
  1. 单个已提交区域可能上百 MB（V8 堆），必须分块整段读完，
     只读前 16MB 会漏掉绝大部分堆内容。
  2. 分块之间要留重叠（OVERLAP），否则恰好跨块边界的令牌会被截断。
  3. UTF-16（V8 双字节字符串）兜底必须「按块」判断，不能按进程累计判断——
     早期版本因为累计判断，导致某区块命中一枚旧令牌后，后续所有区块都不再扫宽字符，
     漏掉了真正的活令牌。
  4. 宽字符扫描直接找 UTF-16 的 "eyJ" 字节标记再对齐解码，
     避免整块 decode 造成的对齐错位，也省内存。

安全：扫描结果可能包含敏感令牌，调用方负责脱敏输出。
"""
import re
import time
import ctypes
from ctypes import wintypes as wt

SIZE_T = ctypes.c_ulonglong

CHUNK = 16 * 1024 * 1024
OVERLAP = 256 * 1024

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
    ]
})

JWT_RE = re.compile(
    rb"(?:^|[^A-Za-z0-9_\-])"
    rb"(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{5,})")

UTF16_EYJ = b"e\x00y\x00J\x00"

kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi


def enum_pids():
    arr = (wt.DWORD * 8192)()
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


def app_pids(names):
    """按进程名（不含 .exe 的比较用 lower）筛出目标 pid 列表。"""
    wanted = {n.lower() for n in names}
    pids = []
    for pid in enum_pids():
        if pid == 0:
            continue
        name = pid_name(pid)
        if name and name.lower() in wanted:
            pids.append(pid)
    return pids


def _scan_chunk(data, out, seen):
    """扫描一个数据块：先按 ASCII 扫，块内没命中再按 UTF-16 扫。"""
    hit = 0
    for m in JWT_RE.finditer(data):
        v = m.group(1).decode("ascii", "ignore")
        if v not in seen:
            seen.add(v)
            out.append(v)
        hit += 1
    if hit:
        return
    # UTF-16LE：先定位 "eyJ" 的宽字符字节，再对齐解码，避免整块 decode 的错位问题
    pos = 0
    while True:
        i = data.find(UTF16_EYJ, pos)
        if i < 0:
            break
        pos = i + 2
        seg = data[i:i + 4096].decode("utf-16le", errors="ignore")
        for m in JWT_RE.finditer(seg.encode("ascii", "ignore")):
            v = m.group(1).decode("ascii", "ignore")
            if v not in seen:
                seen.add(v)
                out.append(v)


def scan_pid(pid, progress=None):
    """扫描单个进程内存，返回 (tokens, bytes_scanned)。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return [], 0
    out = []
    seen = set()
    total = 0
    mbi = MEMORY_BASIC_INFORMATION()
    addr = 0
    try:
        while addr < 0x7FFFFFFFF000:
            if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                       ctypes.sizeof(mbi)) == 0:
                addr += 0x1000
                continue
            size = int(mbi.RegionSize)
            if size <= 0:
                addr += 0x1000
                continue
            if mbi.State == MEM_COMMIT:
                step = CHUNK - OVERLAP
                off = 0
                while off < size:
                    want = min(CHUNK, size - off)
                    buf = ctypes.create_string_buffer(want)
                    read = SIZE_T()
                    if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr + off),
                                                      buf, want, ctypes.byref(read)):
                        break
                    data = buf[:read.value]
                    if data:
                        total += len(data)
                        _scan_chunk(data, out, seen)
                    off += step
                    if progress and off % (64 * 1024 * 1024) < step:
                        progress(pid, total, len(out))
            addr = addr + size
            if addr <= 0:
                break
    finally:
        kernel32.CloseHandle(h)
    return out, total


def decode_jwt(token):
    """解析 JWT payload，失败返回 None。"""
    import base64
    import json
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:  # noqa: BLE001
        return None
