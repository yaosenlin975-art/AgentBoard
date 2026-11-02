# -*- coding: utf-8 -*-
r"""
workbuddy_export.py —— 宿主机(Win)侧脚本：从 WorkBuddy 桌面端进程内存提取当前有效的
Keycloak access token（多账号），校验后写入青龙共享目录
D:\qinglong\data\scripts\.workbuddy_token.json，
供容器内青龙定时任务 workbuddy_checkin.py 读取并完成每日签到/猫猫旅行。

背景：青龙里手工维护的环境变量 WORKBUDDY 会被服务端吊销（本机重新登录后旧会话全部
401，2026-10-25 起三账号同时失效），必须从正在登录的客户端取新令牌。

用法：
  python workbuddy_export.py            # 提取、校验并写入共享 JSON
  python workbuddy_export.py --dry-run  # 仅提取并预览（脱敏），不写文件

安全：
  - JWT 等同账号密码：日志脱敏，不打印完整 token。
  - 只读取 WorkBuddy 进程内存；网络仅访问 codebuddy.cn 官方接口做只读校验。
"""
import sys
import os
import re
import json
import time
import ctypes
import base64
import urllib.request
import urllib.error
import subprocess
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memjwt  # noqa: E402

OUT_FILE = r"D:\qinglong\data\scripts\.workbuddy_token.json"
STATUS_URL = "https://%s/billing/meter/checkin-activity-status" % (
    os.environ.get("WORKBUDDY_DOMAIN", "www.codebuddy.cn"))

PROC_NAMES = ("WorkBuddy.exe", "workbuddy.exe")

# 已知账号 sub -> 备注名。新版令牌不含 nickname/preferred_username，用它还原通知里的账号名。
ACCOUNT_ALIASES = {
    "ef862ad8-9691-4cbc-9e68-447e4b318aa6": "Mui",
    "405594c2-8b33-46fe-98e4-30d35458f719": "WorkBuddy-main",
    "257be34c-886a-49de-bce0-1a4e46355431": "CherylChen",
}

WORKBUDDY_EXES = (
    r"D:\Program Files\WorkBuddy\WorkBuddy.exe",
    r"C:\Program Files\WorkBuddy\WorkBuddy.exe",
    r"C:\Program Files (x86)\WorkBuddy\WorkBuddy.exe",
)


def log(*a):
    print("[workbuddy-export] " + " ".join(str(x) for x in a), flush=True)


def redact(s):
    if not s:
        return "<empty>"
    if len(s) <= 24:
        return s[:6] + "***"
    return s[:16] + "..." + s[-8:]


def app_pids():
    return memjwt.app_pids(PROC_NAMES)


def decode_jwt(token):
    return memjwt.decode_jwt(token)


def scan_pid(pid):
    """扫描单个进程内存，返回候选 JWT 列表（去重）。"""
    hits, _ = memjwt.scan_pid(pid)
    return hits


def collect_candidates():
    """扫所有 WorkBuddy 进程，返回按账号(sub)去重后的候选 [(claims, token), ...]。
    同一 sub 取 exp 最新的那枚。"""
    now = time.time()
    best = {}
    pids = app_pids()
    log("发现 %d 个 WorkBuddy 进程" % len(pids))
    for idx, pid in enumerate(pids, 1):
        t0 = time.time()
        try:
            tokens, scanned = memjwt.scan_pid(pid)
        except Exception as e:  # noqa: BLE001
            log("  [%d/%d] pid=%s 扫描异常: %s" % (idx, len(pids), pid, e))
            continue
        fresh = 0
        for tok in tokens:
            claims = decode_jwt(tok)
            if not claims or not claims.get("exp"):
                continue
            if float(claims["exp"]) < now - 3600:
                continue
            fresh += 1
            sub = claims.get("sub") or tok[:32]
            old = best.get(sub)
            if not old or float(claims["exp"]) > float(old[0]["exp"]):
                best[sub] = (claims, tok)
        log("  [%d/%d] pid=%s 扫了 %.0f MB，命中 %d 枚 JWT（其中有效 %d），耗时 %.1fs" % (
            idx, len(pids), pid, scanned / 1048576.0, len(tokens), fresh, time.time() - t0))
    return list(best.values())


def validate(token):
    """只读接口校验令牌有效性。返回 True/False。"""
    req = urllib.request.Request(STATUS_URL, data=b"{}", method="POST")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent",
                   "WorkBuddy/1.0 (com.codebuddy; build:200407; windows) ")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            return isinstance(res, dict) and bool(res.get("data"))
    except urllib.error.HTTPError:
        return False
    except Exception as e:  # noqa: BLE001
        log("校验请求异常: %s" % e)
        return False


def find_exe():
    for path in ((os.environ.get("WORKBUDDY_EXE") or "").strip(),) + WORKBUDDY_EXES:
        if path and os.path.exists(path):
            return path
    return None


def launch_and_wait(timeout=150):
    """WorkBuddy 没在跑就拉起来，等内存里出现可用 token。返回 (err, 本次启动的 pid)。"""
    exe = find_exe()
    if not exe:
        return "未找到 WorkBuddy 可执行文件（可用环境变量 WORKBUDDY_EXE 指定路径）", None
    log("WorkBuddy 未运行，自动启动: %s" % exe)
    proc = subprocess.Popen([exe], close_fds=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(8)
        if collect_candidates():
            return None, proc.pid
        log("  等待 WorkBuddy 恢复登录态…")
    return "启动后 %d 秒内内存里仍无可用 token（可能需要手动登录一次）" % timeout, proc.pid


def shutdown(pid):
    """只关本次自己拉起来的进程树，用户原本开着的 WorkBuddy 不动。"""
    subprocess.call(["taskkill", "/T", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("已关闭本次启动的 WorkBuddy (pid=%s)" % pid)


def main():
    dry_run = "--dry-run" in sys.argv
    launched = None
    cands = collect_candidates()
    if not cands:
        log("未找到 WorkBuddy 进程或内存中无有效 JWT -> 尝试自动启动 WorkBuddy")
        err, launched = launch_and_wait()
        if err:
            if launched:
                shutdown(launched)
            log("ERROR: " + err)
            return 2
        cands = collect_candidates()
        if not cands:
            if launched:
                shutdown(launched)
            log("ERROR: 启动后仍未提取到有效 JWT")
            return 2
    if launched:
        shutdown(launched)

    now = time.time()
    accounts = []
    for claims, tok in cands:
        exp = float(claims["exp"])
        note = (claims.get("nickname") or claims.get("preferred_username")
                or ACCOUNT_ALIASES.get(claims.get("sub", "")) or claims.get("sub", "?"))
        log("账号 %s: 有效期至 %s（%.1f 天）| token（脱敏）: %s" % (
            note, datetime.fromtimestamp(exp).strftime("%Y-%m-%d %H:%M"),
            (exp - now) / 86400.0, redact(tok)))
        if not validate(tok):
            log("账号 %s: 接口校验未通过（401/无数据），跳过" % note)
            continue
        accounts.append("%s#%s#%s" % (tok, claims.get("sub", ""), note))
    if not accounts:
        log("ERROR: 无任何通过校验的账号。请打开 WorkBuddy 确认已登录后重试。")
        return 3
    log("通过校验账号数: %d" % len(accounts))

    if dry_run:
        log("[DRY-RUN] 不写文件。将写入: " + OUT_FILE)
        return 0
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"accounts": accounts,
                   "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                  f, ensure_ascii=False, indent=1)
    log("已写入 " + OUT_FILE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
