# -*- coding: utf-8 -*-
r"""
minimax_export.py —— 宿主机(Win)侧脚本：读取 MiniMax Code 本地登录凭据，
写入青龙共享目录 D:\qinglong\data\scripts\.minimax_token.json，
供容器内青龙定时任务 minimax_checkin_ql.py 读取并完成每日签到。

凭据来源（按优先级）：
  1) %USERPROFILE%\.minimax\auth\<buildEnv>\<region>\mcode-public\auth.json
     —— 当前有效的 OAuth 凭据（客户端 mcode-public，audience agent-backend）。
        accessToken 形如 mmoat_...，TTL 约 1 小时，由正在运行的 MiniMax Code
        自动续期并写回该文件（generation 字段会递增）。
  2) %USERPROFILE%\.minimax\local-runtime.auth.json（旧版 JWT，形如 eyJ...）
     —— 2026-09-09 之后不再更新，其中的 JWT 已于 2026-10-19 过期，仅作兜底。
  3) %APPDATA%\MiniMax\minimax-agent-cn-config.json（tokens.accessToken，通常为空）

注意：
  旧版脚本读的是 local-runtime.auth.json 的 JWT，但 MiniMax Code 3.1.1 已经
  换成 OAuth 令牌，新令牌只在 auth.json 里，旧脚本读到的永远是过期 JWT，
  导致 2026-10-19 起签到持续 401。

用法：
  python minimax_export.py            # 提取、校验并写入共享 JSON
  python minimax_export.py --dry-run  # 仅提取并预览（脱敏），不写文件
  python minimax_export.py --launch   # 令牌过期时允许拉起 MiniMax Code 等它续期

安全：
  - JWT / OAuth 令牌等同账号密码：日志脱敏，不打印完整 token。
  - 本脚本不触网（校验除外）；网络请求只访问官方只读接口。
"""
import sys
import os
import json
import glob
import time
import uuid
import subprocess
from datetime import datetime

OUT_FILE = r"D:\qinglong\data\scripts\.minimax_token.json"
SCRIPTS_DIR = r"D:\qinglong\data\scripts"
AUTH_ROOT = os.path.expanduser(r"~\.minimax\auth")
LEGACY_AUTH_FILE = os.path.expanduser(r"~\.minimax\local-runtime.auth.json")
CONFIG_FILE = os.path.expandvars(r"%APPDATA%\MiniMax\minimax-agent-cn-config.json")

MINIMAX_EXES = (
    r"D:\Program Files\MiniMax Code\MiniMax Code.exe",
    r"C:\Program Files\MiniMax Code\MiniMax Code.exe",
)

# 复用青龙签到脚本的签名实现做只读校验
sys.path.insert(0, SCRIPTS_DIR)
try:
    import minimax_checkin_ql as ql
except Exception:  # noqa: BLE001
    ql = None


def log(*a):
    print("[minimax-export] " + " ".join(str(x) for x in a), flush=True)


def redact(s):
    if not s:
        return "<empty>"
    if len(s) <= 24:
        return s[:6] + "***"
    return s[:16] + "..." + s[-8:]


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def find_oauth_auth_files():
    """列出 ~/.minimax/auth/<env>/<region>/<client>/auth.json。"""
    pattern = os.path.join(AUTH_ROOT, "*", "*", "*", "auth.json")
    return sorted(glob.glob(pattern))


def collect_oauth():
    """从 OAuth 凭据文件里挑有效期最晚的一条记录。"""
    best = None
    for path in find_oauth_auth_files():
        try:
            data = read_json(path)
        except Exception as e:  # noqa: BLE001
            log("读取 %s 失败: %s" % (path, e))
            continue
        for rec in (data.get("records") or {}).values():
            token = (rec.get("accessToken") or "").strip()
            if not token:
                continue
            expires = float(rec.get("expiresAtMs") or 0) / 1000.0
            if best is None or expires > best["expires_at"]:
                best = {
                    "token": token,
                    "refresh_token": (rec.get("refreshToken") or "").strip(),
                    "token_type": rec.get("tokenType") or "Bearer",
                    "expires_at": expires,
                    "expires_at_ms": rec.get("expiresAtMs"),
                    "generation": rec.get("generation"),
                    "login_epoch": rec.get("loginEpoch"),
                    "source": path,
                }
    return best


def collect_legacy():
    """旧版 JWT 凭据（local-runtime.auth.json），已过期，仅兜底。"""
    if not os.path.exists(LEGACY_AUTH_FILE):
        return None
    try:
        auth = (read_json(LEGACY_AUTH_FILE).get("auth") or {})
    except Exception:  # noqa: BLE001
        return None
    token = (auth.get("accessToken") or "").strip()
    if not token:
        return None
    exp = None
    try:
        import base64
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = float(json.loads(base64.urlsafe_b64decode(payload)).get("exp") or 0) or None
    except Exception:  # noqa: BLE001
        pass
    return {
        "token": token,
        "refresh_token": "",
        "token_type": "Bearer",
        "expires_at": exp or 0.0,
        "expires_at_ms": int(exp * 1000) if exp else None,
        "generation": None,
        "login_epoch": None,
        "source": LEGACY_AUTH_FILE,
        "real_user_id": (auth.get("realUserID") or "").strip(),
        "user_name": (auth.get("userName") or "").strip(),
        "sub_user_name": (auth.get("subUserName") or "").strip(),
    }


def collect_config():
    """%APPDATA% 下的兜底来源。"""
    if not os.path.exists(CONFIG_FILE):
        return None
    try:
        cfg = read_json(CONFIG_FILE)
    except Exception:  # noqa: BLE001
        return None
    token = (((cfg.get("tokens") or {}).get("accessToken")) or "").strip()
    if not token:
        return None
    user = cfg.get("user") or {}
    return {
        "token": token,
        "refresh_token": "",
        "token_type": "Bearer",
        "expires_at": 0.0,
        "expires_at_ms": None,
        "generation": None,
        "login_epoch": None,
        "source": CONFIG_FILE,
        "real_user_id": (user.get("realUserID") or "").strip(),
        "user_name": (user.get("userName") or "").strip(),
        "sub_user_name": (user.get("subUserName") or "").strip(),
        "device_id": (user.get("deviceID") or "").strip(),
    }


def read_profile():
    """账号资料（real_user_id / user_name 等），token 过期时这些仍然有效。"""
    profile = {"real_user_id": "", "user_name": "", "sub_user_name": "", "device_id": "13218546"}
    for path in (LEGACY_AUTH_FILE, CONFIG_FILE):
        if not os.path.exists(path):
            continue
        try:
            data = read_json(path)
        except Exception:  # noqa: BLE001
            continue
        if path == LEGACY_AUTH_FILE:
            auth = data.get("auth") or {}
            profile["real_user_id"] = profile["real_user_id"] or (auth.get("realUserID") or "")
            profile["user_name"] = profile["user_name"] or (auth.get("userName") or "")
            profile["sub_user_name"] = profile["sub_user_name"] or (auth.get("subUserName") or "")
        else:
            user = data.get("user") or {}
            profile["real_user_id"] = profile["real_user_id"] or (user.get("realUserID") or "")
            profile["user_name"] = profile["user_name"] or (user.get("userName") or "")
            profile["sub_user_name"] = profile["sub_user_name"] or (user.get("subUserName") or "")
    return profile


def find_exe():
    for path in ((os.environ.get("MINIMAX_EXE") or "").strip(),) + MINIMAX_EXES:
        if path and os.path.exists(path):
            return path
    return None


def launch_and_wait(timeout=150):
    """令牌过期时拉起 MiniMax Code，等它续期并写回 auth.json。
    返回 (err, 新的凭据dict)。不关闭客户端——它可能正跑着用户的会话。"""
    exe = find_exe()
    if not exe:
        return "未找到 MiniMax Code 可执行文件（可用环境变量 MINIMAX_EXE 指定路径）", None
    log("令牌已过期，自动启动 MiniMax Code 等它续期: %s" % exe)
    subprocess.Popen([exe], close_fds=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(6)
        rec = collect_oauth()
        if rec and rec["expires_at"] > time.time() + 60:
            return None, rec
        log("  等待 MiniMax Code 续期…")
    return "启动后 %d 秒内凭据仍未续期（可能需要手动登录一次）" % timeout, None


def validate(token, creds):
    """调用官方只读签到面板接口验证令牌。返回 (ok, 说明)。"""
    if ql is None:
        return True, "未加载签到脚本，跳过校验"
    try:
        st, body = ql.api_call("GET", ql.STATUS_PATH, token, creds)
    except Exception as e:  # noqa: BLE001
        return False, "校验异常 %s" % repr(e)[:120]
    if st == 200 and isinstance(body, dict):
        code = (body.get("base_resp") or {}).get("status_code")
        if code == 0:
            return True, "HTTP 200 / status_code=0"
        return False, "HTTP 200 但 status_code=%s" % code
    return False, "HTTP %s" % st


def main():
    dry_run = "--dry-run" in sys.argv
    allow_launch = "--launch" in sys.argv

    rec = collect_oauth() or collect_legacy() or collect_config()
    if not rec:
        log("ERROR: 未找到任何 MiniMax 凭据（查过 %s、%s、%s）" % (
            AUTH_ROOT, LEGACY_AUTH_FILE, CONFIG_FILE))
        log("请先打开 MiniMax Code 登录一次。")
        return 1

    now = time.time()
    if rec["expires_at"] and rec["expires_at"] <= now + 120:
        log("当前令牌已过期（来源 %s）" % rec["source"])
        if allow_launch:
            err, fresh = launch_and_wait()
            if err:
                log("ERROR: " + err)
                return 2
            rec = fresh
        else:
            log("ERROR: 令牌已过期，且未启用 --launch，不会自动拉起 MiniMax Code。")
            log("请手动打开 MiniMax Code（登录态正常即可），稍后重跑本脚本。")
            return 2

    profile = read_profile()
    creds = {
        "token": rec["token"],
        "real_user_id": rec.get("real_user_id") or profile["real_user_id"] or "0",
        "user_name": rec.get("user_name") or profile["user_name"] or "",
        "sub_user_name": rec.get("sub_user_name") or profile["sub_user_name"] or "",
        "device_id": rec.get("device_id") or profile["device_id"] or "13218546",
        "uuid": str(uuid.uuid4()),
    }
    exp = rec["expires_at"]
    log("来源: %s" % rec["source"])
    if exp:
        log("有效期至 %s（剩余 %.0f 分钟）" % (
            datetime.fromtimestamp(exp).strftime("%Y-%m-%d %H:%M"), (exp - now) / 60.0))
    else:
        log("凭据未带有效期信息")
    if rec.get("generation") is not None:
        log("generation: %s" % rec["generation"])
    log("token（脱敏）: %s" % redact(rec["token"]))
    log("账号: %s (%s)" % (creds["sub_user_name"] or "未知", creds["user_name"] or "-"))

    ok, why = validate(rec["token"], creds)
    if not ok:
        log("ERROR: 官方接口校验未通过（%s）" % why)
        return 3
    log("校验通过（%s）" % why)

    payload = {
        "token": rec["token"],
        "token_type": rec.get("token_type") or "Bearer",
        "expires_at_ms": rec.get("expires_at_ms") or (int(exp * 1000) if exp else None),
        "refresh_token": rec.get("refresh_token") or "",
        "generation": rec.get("generation"),
        "real_user_id": creds["real_user_id"],
        "user_name": creds["user_name"],
        "sub_user_name": creds["sub_user_name"],
        "device_id": creds["device_id"],
        "uuid": creds["uuid"],
        "source": rec["source"],
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    if dry_run:
        log("[DRY-RUN] 不写文件。将写入: " + OUT_FILE)
        return 0
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log("已写入 " + OUT_FILE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
