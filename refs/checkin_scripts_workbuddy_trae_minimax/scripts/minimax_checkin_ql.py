#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MiniMax Code 每日积分自动签到 —— 青龙面板版
=====================================================
背景：MiniMax Code 桌面端登录后 JWT 落盘于 Windows 宿主机本地文件，
青龙容器（Linux/Docker）无法直接读取，采用"导出 + 读取"两段式：

  1) 宿主机（Windows）执行导出脚本，将 JWT 等凭据写入
     D:\\qinglong\\data\\scripts\\.minimax_token.json
     容器内路径：/ql/data/scripts/.minimax_token.json

  2) 本脚本由青龙定时任务每日执行，调用官方接口签到：
       GET  https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status （查面板）
       POST https://agent.minimaxi.com/minimax-cloud/api/v1/signin/claim  （领积分）
     认证头（2026-10-26 实测修正）：
       MiniMax Code 3.1.1 已从旧 JWT 换成 OAuth 客户端 mcode-public 的令牌，
       形如 mmoat_...（旧 JWT 形如 eyJ...）。
         - token 头：                旧 JWT 时代唯一有效的头，新令牌放这里返回 401
         - Authorization: Bearer    新令牌唯一有效的头
       两者同时带上即可兼容两种令牌（实测 HTTP 200）。
     令牌有效期：
       - 旧 JWT 有 exp 字段（约 30 天）
       - 新 OAuth 令牌无 exp，expiresAtMs 由导出脚本写入凭据文件，TTL 约 1 小时
       所以导出必须紧贴签到时刻执行（计划任务 08:00 导出，08:40 签到）。
     请求需带桌面端签名头（与客户端一致，逆向自 MiniMax Code v3.0.69）：
       yy          = md5(encodeURIComponent(path?qs) + "_" + body + md5(str(unix_ms)) + "ooui")
       x-timestamp = unix_ms // 1000
       x-signature = md5(f"{unix_sec}I*7Cf%WZ#S&%1RlZJ&C2{body}")
     幂等：先查 status，今日 status==3(已领) 视为成功，不重复领取。
     结果通过青龙 notify（SMTP 邮件）通知。

部署：
  1) 本文件放到青龙 scripts 目录（挂载 /ql/data/scripts）
  2) 宿主机先运行 minimax_auto_refresh.bat 生成 .minimax_token.json
  3) 新建定时任务，命令 task /ql/data/scripts/minimax_checkin_ql.py，定时 40 8 * * *

安全：
  - token 视为密码：日志全部脱敏，不打印 token 明文。
  - 仅访问 agent.minimaxi.com 官方接口，强制绕过系统代理（直连）。
"""
import sys
import os
import json
import re
import base64
import hashlib
import time
import urllib.parse
import urllib.request
from datetime import datetime

BASE = "https://agent.minimaxi.com"
STATUS_PATH = "/minimax-cloud/api/v1/signin/status"
CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim"
MEMBERSHIP_PATH = "/matrix/api/v1/commerce/get_membership_info"
CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details"
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".minimax_token.json")

SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2"
YY_SUFFIX = "ooui"
TIMEZONE_OFFSET = 28800  # 客户端时区 UTC+8，与服务端"今日"对齐

# 状态枚举（@mavis/shared daily-signin）
DAY_STATUS_CLAIMABLE = 2
DAY_STATUS_CLAIMED = 3

# 青龙内置通知模块（不可用时退回仅日志）
sys.path.insert(0, "/ql/scripts")
sys.path.insert(0, "/ql/data/scripts")
try:
    from notify import send
except Exception:  # noqa: BLE001
    send = None


def log(msg):
    print("[minimax-ql] %s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


# 供邮件落款使用，main() 里填真实值
ACCOUNT = "未知账号"
JWT_LEFT = ""
TOKEN_WARN = ""    # token 快过期时把提醒顶进标题，别埋在正文里


def footer():
    """每封邮件都带上「谁的号 / 什么时候 / 令牌还剩多久」，方便事后排查。"""
    return "\n\n账号: %s\n令牌剩余: %s\n时间: %s" % (
        ACCOUNT, JWT_LEFT or "未知", datetime.now().strftime("%Y-%m-%d %H:%M"))


def notify(title, content):
    content = (content or "") + footer()
    title = TOKEN_WARN + title
    log("邮件正文[%s]:\n%s" % (title, content))
    try:
        if send:
            send(title, content)
            log("已发送邮件通知: %s" % title)
        else:
            log("[notify 不可用] %s: %s" % (title, content))
    except Exception as e:  # noqa: BLE001
        log("发送通知异常: %s" % e)


def redact(s):
    if not s:
        return "<empty>"
    if len(s) <= 18:
        return s[:4] + "***" + s[-2:]
    return s[:12] + "..." + s[-6:]


def redact_json(obj):
    try:
        s = json.dumps(obj, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return str(obj)
    return re.sub(r'("token"\s*:\s*")[^"]+(")', r"\1***\2", s)


def jwt_exp(token):
    """解析 JWT payload 中的 exp（秒级时间戳），失败返回 None。"""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        obj = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8", "replace"))
        exp = obj.get("exp")
        return float(exp) if exp else None
    except Exception:  # noqa: BLE001
        return None


def token_expiry(token, creds):
    """返回令牌到期时间戳（秒）。兼容两种令牌：
       - 旧 JWT：payload 里的 exp
       - 新 OAuth（mmoat_*）：凭据文件里的 expires_at_ms
    拿不到返回 None。"""
    exp = jwt_exp(token)
    if exp:
        return exp
    try:
        ms = creds.get("expires_at_ms")
        if ms:
            return float(ms) / 1000.0
    except Exception:  # noqa: BLE001
        pass
    return None


def md5(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def js_encode_component(s):
    """JS encodeURIComponent：! ' ( ) * ~ - _ . 不转义。"""
    return urllib.parse.quote(s, safe="-_.!~*'()")


def load_creds():
    if not os.path.exists(TOKEN_FILE):
        return None, "未找到 %s\n请先在宿主机(Win)运行 minimax_auto_refresh.bat 生成该文件。" % TOKEN_FILE
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        return None, "读取 %s 失败: %s" % (TOKEN_FILE, e)
    token = (data.get("token") or "").strip()
    if not token:
        return None, "token 为空，请重跑宿主机导出脚本 minimax_auto_refresh.bat。"
    exp = token_expiry(token, data)
    if exp and exp <= time.time():
        return None, ("令牌已于 %s 过期，请重跑宿主机导出脚本 minimax_auto_refresh.bat。"
                      % datetime.fromtimestamp(exp).strftime("%Y-%m-%d %H:%M"))
    return data, None


def build_query(creds, unix_ms):
    """与 MiniMax Code 桌面端 axios 拦截器参数一致（顺序敏感）。"""
    return [
        ("device_platform", "web"),
        ("biz_id", "3"),
        ("app_id", "3001"),
        ("version_code", "22201"),
        ("unix", unix_ms),  # Date.parse(new Date().toString()) 秒级精度
        ("timezone_offset", TIMEZONE_OFFSET),
        ("is_desktop", "1"),
        ("desktop_version", ""),
        ("sys_language", "zh"),
        ("lang", "zh"),
        ("uuid", creds.get("uuid") or str(os.urandom(8).hex())),
        ("device_id", creds.get("device_id") or "32165019"),
        ("os_name", "Windows"),
        ("browser_name", "Chrome"),
        ("device_memory", "16"),
        ("cpu_core_num", "12"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("user_id", creds.get("real_user_id") or "0"),
        ("op_ticket", "undefined"),
        ("screen_width", "1920"),
        ("screen_height", "1080"),
        ("client", "desktop"),
    ]


def api_call(method, path, token, creds, extra_params=()):
    """签名请求。GET body 为空串；POST body 为 '{}'。extra_params 拼在公共参数前面。"""
    unix_ms = int(time.time()) * 1000
    params = list(extra_params) + build_query(creds, unix_ms)
    qs = urllib.parse.urlencode(params)
    signed_path = path + "?" + qs
    body = "{}" if method == "POST" else ""
    yy = md5(js_encode_component(signed_path) + "_" + body + md5(str(unix_ms)) + YY_SUFFIX)
    unix_sec = unix_ms // 1000
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "token": token,
        # 新令牌（mmoat_*）只认 Authorization: Bearer；旧 JWT（eyJ*）只认 token 头。
        # 两个头都带，实测新旧令牌都能拿到 200。
        "Authorization": "Bearer " + token,
        "yy": yy,
        "x-timestamp": str(unix_sec),
        "x-signature": md5("{}{}{}".format(unix_sec, SIGNATURE_SALT, body)),
        "User-Agent": "MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) MiniMax/3.0.69 Chrome/148.0.7778.280 Safari/537.36",
        "Origin": BASE,
        "Referer": BASE + "/",
    }
    data = body.encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(BASE + signed_path, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        r = opener.open(req, timeout=20)
        return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")
        except Exception:  # noqa: BLE001
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return "ERR", {"__error__": repr(e)}


def api_call_retry(method, path, token, creds, max_retries=3, base_delay=2.0, extra_params=()):
    """仅对网络错误 / 5xx 重试（指数退避）；业务响应立即返回。"""
    last = ("ERR", {"__error__": "未执行"})
    n = max(1, int(max_retries))
    for attempt in range(1, n + 1):
        st, body = api_call(method, path, token, creds, extra_params)
        if isinstance(st, int) and st < 500:
            return st, body
        if st == "ERR":
            log("第 %d/%d 次网络错误: %s" % (attempt, n, body.get("__error__")))
        else:
            log("第 %d/%d 次服务端 HTTP %s，准备重试" % (attempt, n, st))
        if attempt < n:
            delay = base_delay * (2 ** (attempt - 1))
            log("退避 %.1f 秒后重试..." % delay)
            time.sleep(delay)
        last = (st, body)
    return last


def env_max_retries():
    try:
        raw = os.environ.get("MINIMAX_CHECKIN_MAX_RETRIES", "").strip()
        if raw:
            return max(1, int(raw))
    except Exception:  # noqa: BLE001
        pass
    return 3


def today_day(days):
    for d in days or []:
        if d.get("is_today"):
            return d
    return None


def panel_progress(days):
    """把 7 天签到面板压成一行：已领几天、累计多少积分、今天算第几天。"""
    days = days or []
    if not days:
        return ""
    got = [d for d in days if d.get("status") == DAY_STATUS_CLAIMED]
    total = sum(int(d.get("points") or 0) + int(d.get("bonus_points") or 0) for d in got)
    return "本期进度: 已领 %d/%d 天，累计 %d 积分，今天是第 %s 天" % (
        len(got), len(days), total, (today_day(days) or {}).get("day_no", "?"))


def num(value):
    """服务端把积分为千分位字符串发（\"21,176.718\"），统一转 float。"""
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def credit_report(token, creds, max_retries):
    """积分余额 + 最早到期的一笔积分。查询失败只影响这两行，不影响签到结果。"""
    try:
        st, body = api_call_retry("POST", MEMBERSHIP_PATH, token, creds, max_retries=max_retries)
        summary = body.get("op_credit_summary") or {}
        if not summary:
            return "积分余额: 未取到（HTTP %s）" % st

        details, page, total_count = [], 1, None
        while page <= 5:
            # ponytail: 500 条明细封顶，一天一笔也要签一年多才触顶；超了就按 total_count 翻页
            st2, body2 = api_call_retry(
                "GET", CREDIT_DETAILS_PATH, token, creds, max_retries=max_retries,
                extra_params=[("page_number", str(page)), ("page_size", "100"), ("include_expired", "true")])
            rows = body2.get("details")
            if rows is None:
                break
            details.extend(rows)
            total_count = num(body2.get("total_count"))
            if len(details) >= total_count:
                break
            page += 1

        now_ms = int(time.time() * 1000)
        live = [d for d in details
                if num(d.get("remaining_amount")) > 0 and num(d.get("expire_at_ms")) > now_ms]
        lines = ["积分余额: %.1f（赠送 %.1f / 购买 %.1f）" % (
            num(summary.get("total_remaining_amount")), num(summary.get("free_remaining_amount")),
            num(summary.get("purchased_remaining_amount")))]
        if live:
            soon = min(live, key=lambda d: num(d.get("expire_at_ms")))
            left = int(num(soon.get("expire_at_ms")) - now_ms) // 86400000
            lines.append("最早到期: %.1f 积分于 %s 过期（还剩 %d 天），未过期批次共 %d 笔 %.1f 积分" % (
                num(soon.get("remaining_amount")),
                datetime.fromtimestamp(num(soon.get("expire_at_ms")) / 1000).strftime("%Y-%m-%d %H:%M"),
                left, len(live), sum(num(d.get("remaining_amount")) for d in live)))
        elif details:
            lines.append("最早到期: 已无未过期积分")
        else:
            lines.append("最早到期: 未取到积分明细")
        return "\n".join(lines)
    except Exception as e:  # noqa: BLE001
        return "积分余额/到期: 查询异常 %s" % repr(e)[:150]


def main():
    global ACCOUNT, JWT_LEFT, TOKEN_WARN
    max_retries = env_max_retries()

    creds, err = load_creds()
    if not creds:
        log("ERROR: " + err)
        notify("MiniMax Code 签到失败", err)
        return 2
    token = creds["token"]
    ACCOUNT = "%s (%s)" % (creds.get("sub_user_name") or creds.get("user_name") or "未知账号",
                           creds.get("user_name") or "-")
    log("已读取 token（脱敏）: " + redact(token))
    if creds.get("sub_user_name") or creds.get("user_name"):
        log("账号: %s" % ACCOUNT)

    exp = token_expiry(token, creds)
    if exp:
        remain_s = exp - time.time()
        if remain_s < 86400:
            JWT_LEFT = "%.0f 分钟" % (remain_s / 60.0)
        else:
            JWT_LEFT = "%.1f 天" % (remain_s / 86400.0)
        log("令牌剩余有效期约 %s" % JWT_LEFT)
        if remain_s <= 0:
            TOKEN_WARN = "【token 已过期】"
            log("警告：token 已过期，请重跑宿主机 minimax_auto_refresh.bat。")
        elif remain_s < 300:
            TOKEN_WARN = "【token 只剩 %.0f 分钟】" % (remain_s / 60.0)
            log("警告：token 即将过期，请重跑宿主机 minimax_auto_refresh.bat。")
        elif jwt_exp(token) and remain_s < 5 * 86400:
            TOKEN_WARN = "【token 只剩 %.0f 天】" % (remain_s / 86400.0)
            log("警告：token 即将过期，请重跑宿主机 minimax_auto_refresh.bat。")

    log("查询签到面板(GET status) ...")
    st, body = api_call_retry("GET", STATUS_PATH, token, creds, max_retries=max_retries)
    log("status 响应: %s %s" % (st, redact_json(body)))
    if st == "ERR":
        notify("MiniMax Code 签到失败", "网络错误（已重试 %d 次），签到未完成，请检查网络后手动重跑。" % max_retries)
        return 1
    if isinstance(st, int) and st >= 500:
        notify("MiniMax Code 签到失败", "服务端 5xx 错误（已重试 %d 次），签到未完成，请稍后重跑。" % max_retries)
        return 1
    if st == 401:
        notify("MiniMax Code 签到失败", "登录态失效（HTTP 401），请打开 MiniMax Code 重新登录后重跑宿主机导出脚本。")
        return 1
    if body.get("base_resp", {}).get("status_code") != 0:
        msg = body.get("base_resp", {}).get("status_msg") or str(body)[:200]
        notify("MiniMax Code 签到失败", "查询签到面板失败: %s" % msg)
        return 1

    days = body.get("data", {}).get("days") or []
    day = today_day(days)
    if day and day.get("status") == DAY_STATUS_CLAIMED:
        log("今日已签到（今日 + %s 积分）" % day.get("points"))
        notify("MiniMax Code 签到", "\n".join(
            ["今日已签到（+%s 积分）" % day.get("points"), panel_progress(days),
             credit_report(token, creds, max_retries)]))
        return 0
    if day and day.get("status") not in (DAY_STATUS_CLAIMABLE, DAY_STATUS_CLAIMED):
        # 1=未开始 / 4=禁用：无可领项
        log("今日无可领签到项（status=%s）" % day.get("status"))
        notify("MiniMax Code 签到", "\n".join(
            ["今日无可领签到项（status=%s），可能活动未开放。" % day.get("status"), panel_progress(days),
             credit_report(token, creds, max_retries)]))
        return 0

    log("今日可领，执行 claim(POST) ...")
    st2, body2 = api_call_retry("POST", CLAIM_PATH, token, creds, max_retries=max_retries)
    log("claim 响应: %s %s" % (st2, redact_json(body2)))
    if st2 == "ERR":
        notify("MiniMax Code 签到失败", "网络错误（已重试 %d 次），签到未完成。" % max_retries)
        return 1
    if isinstance(st2, int) and st2 >= 500:
        notify("MiniMax Code 签到失败", "服务端 5xx 错误（已重试 %d 次），签到未完成。" % max_retries)
        return 1
    if st2 == 401:
        notify("MiniMax Code 签到失败", "登录态失效（HTTP 401），请打开 MiniMax Code 重新登录后重跑宿主机导出脚本。")
        return 1
    base = body2.get("base_resp", {})
    if base.get("status_code") != 0:
        notify("MiniMax Code 签到失败", "签到失败: %s" % (base.get("status_msg") or str(body2)[:200]))
        return 1
    data = body2.get("data", {})
    points = data.get("points")
    claim_result = data.get("claim_result")
    if claim_result == 1:
        msg = "领取 %s 积分" % ("未知" if points is None else points)
    elif claim_result == 2:
        msg = "今日已签到（重复领取返回）"
    else:
        msg = "claim_result=%s points=%s" % (claim_result, points)
    expire_ms = data.get("expire_at_ms")
    if expire_ms:
        msg += "\n积分有效期至 %s" % datetime.fromtimestamp(expire_ms / 1000).strftime("%Y-%m-%d")
    msg += "\n" + panel_progress(data.get("panel", {}).get("days") or days)
    msg += "\n" + credit_report(token, creds, max_retries)
    log("签到成功，" + msg)
    notify("MiniMax Code 签到成功", msg)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001
        import traceback
        notify("MiniMax Code 签到异常退出", traceback.format_exc()[-1500:])
        code = 1
    sys.exit(code)
