#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TRAE SOLO CN 每日积分自动签到 —— 青龙面板版
=====================================================
背景：TRAE 登录态（JWT）只存在于 Windows 宿主机的 TRAE 进程内存中，
青龙容器（Linux/Docker）无法直接扫描，故采用"导出 + 读取"两段式：

  1) 宿主机（Windows，TRAE 已登录且运行）执行导出脚本，将 JWT 与设备档案写入
     共享 JSON：D:\qinglong\data\scripts\.trae_token.json
     容器内路径：/ql/data/scripts/.trae_token.json

  2) 本脚本由青龙定时任务每日 08:30 执行，读取上述 JSON，调用官方接口签到：
       POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status  （查状态）
       POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim   （执行签到）
     认证头：Authorization: Cloud-IDE-JWT <JWT>（不是 Bearer），必填 x-device-id。
     幂等：先查 status，已签到视为成功，不重复领取。
     结果通过青龙 notify（SMTP 邮件）通知。

部署：
  1) 本文件放到青龙 scripts 目录（挂载 /ql/data/scripts）
  2) 新增加密变量（可选，默认 3 次重试）：
       TRAE_CHECKIN_MAX_RETRIES=3
  3) 新建定时任务，命令 task /ql/data/scripts/trae_checkin_ql.py，定时 30 8 * * *

安全：
  - token 视为密码：日志全部脱敏，不打印 Authorization、不落盘明文（仅内存使用）。
  - 仅访问 api.trae.cn 官方接口，强制绕过系统代理（直连）。
"""
import sys
import os
import json
import re
import base64
import random
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

STATUS_URL = "https://api.trae.cn/trae/api/v2/ug/checkin_credits/status"
CLAIM_URL = "https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim"
ENT_USAGE_URL = "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage"
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".trae_token.json")

# 青龙内置通知模块（不可用时退回仅日志）
sys.path.insert(0, "/ql/scripts")
sys.path.insert(0, "/ql/data/scripts")
try:
    from notify import send
except Exception:  # noqa: BLE001
    send = None


def log(msg):
    print("[trae-ql] %s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


# 供邮件落款使用，main() 里填真实值
ACCOUNT = "未知账号"
JWT_LEFT = ""


def footer():
    """每封邮件都带上「谁的号 / 什么时候 / token 还剩多久」，方便事后排查。"""
    return "\n\n账号: %s\nJWT 剩余: %s\n时间: %s" % (
        ACCOUNT, JWT_LEFT or "未知", datetime.now().strftime("%Y-%m-%d %H:%M"))


def notify(title, content):
    content = (content or "") + footer()
    log("邮件正文[%s]:\n%s" % (title, content))
    try:
        if send:
            send(title, content)
            log("已发送邮件通知: %s" % title)
        else:
            log("[notify 不可用] %s: %s" % (title, content))
    except Exception as e:  # noqa: BLE001
        log("发送通知异常: %s" % e)


def jwt_payload(token):
    """解出 JWT payload，失败返回空 dict。"""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}


def jwt_exp(token):
    """解析 JWT payload 中的 exp（秒级时间戳），失败返回 None。"""
    exp = jwt_payload(token).get("exp")
    return float(exp) if exp else None


def load_creds():
    """读取宿主机导出的 token + 设备档案。成功返回 dev；失败返回 dict(err=说明)。"""
    if not os.path.exists(TOKEN_FILE):
        return None, "未找到 %s\n请先在宿主机(Win)运行导出脚本生成该文件。" % TOKEN_FILE
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        return None, "读取 %s 失败: %s" % (TOKEN_FILE, e)
    token = (data.get("token") or "").strip()
    if not token:
        return None, "token 为空，请重跑宿主机导出脚本。"
    dev = {
        "device_id": (data.get("device_id") or "").strip(),
        "device_brand": (data.get("device_brand") or "").strip(),
        "os_name": (data.get("os_name") or "").strip(),
        "device_cpu": (data.get("device_cpu") or "").strip(),
    }
    return token, dev  # 成功时第二个元素是 dict(设备档案)，首个是 token


def build_headers(auth, dev):
    h = {
        "Authorization": auth,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Preferenced-Language": "zh-CN",
        "User-Agent": "TRAE-Checkin/1.1 (qinglong)",
        "x-hub-version": "1",
    }
    if dev.get("device_id"):
        h["x-device-id"] = dev["device_id"]
    if dev.get("device_brand"):
        h["x-device-brand"] = dev["device_brand"]
    if dev.get("os_name"):
        h["x-device-type"] = dev["os_name"]
    if dev.get("device_cpu"):
        h["x-device-cpu"] = dev["device_cpu"]
    return h


def api_call(method, url, auth, dev):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    body = b"{}" if method == "POST" else None
    req = urllib.request.Request(url, data=body, headers=build_headers(auth, dev))
    try:
        r = opener.open(req, timeout=20)
        return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")
    except Exception as e:  # noqa: BLE001
        return "ERR", {"__error__": repr(e)}


def api_call_retry(method, url, auth, dev, max_retries=3, base_delay=2.0):
    """仅对网络错误 / 5xx 重试（指数退避）；业务响应立即返回。"""
    last = ("ERR", {"__error__": "未执行"})
    n = max(1, int(max_retries))
    for attempt in range(1, n + 1):
        st, body = api_call(method, url, auth, dev)
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
        raw = os.environ.get("TRAE_CHECKIN_MAX_RETRIES", "").strip()
        if raw:
            return max(1, int(raw))
    except Exception:  # noqa: BLE001
        pass
    return 3


def status_line(body):
    """把 status 面板压成邮件里的一行，好知道今天到底能拿/拿了多少积分。"""
    return "积分面板: 今日 %s，额外 %s，活动%s" % (
        body.get("credits", "未知"), body.get("extra_credits", "未知"),
        "已开启" if body.get("enable") else "未开启")


def num(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def credit_report(auth, dev, max_retries):
    """积分余额 + 最早到期的一笔。ent_usage 是官方唯一给余额和到期时间的接口。"""
    try:
        st, body = api_call_retry("GET", ENT_USAGE_URL, auth, dev, max_retries=max_retries)
        if not isinstance(st, int) or st >= 400:
            return "积分余额: 未取到（HTTP %s）" % st
        summary = body.get("usage_summary") or {}
        now = time.time()
        rows = []
        for pack in body.get("user_entitlement_pack_list") or []:
            base = pack.get("entitlement_base_info") or {}
            limit = num((base.get("quota") or {}).get("credits_limit"))
            end = num(base.get("end_time") or pack.get("expire_time"))
            if limit > 0 and end > now:
                rows.append((end, limit, pack.get("display_desc") or "积分包"))
        lines = ["积分余额: %.0f（额度 %.0f，已用 %.0f）" % (
            num(summary.get("total_amount")) - num(summary.get("consumed_amount")),
            num(summary.get("total_amount")), num(summary.get("consumed_amount")))]
        if rows:
            end, limit, name = min(rows)
            lines.append("最早到期: %s %g 积分于 %s 过期（还剩 %d 天），未过期批次共 %d 笔 %.0f 积分" % (
                name, limit, datetime.fromtimestamp(end).strftime("%Y-%m-%d %H:%M"),
                int(end - now) // 86400, len(rows), sum(r[1] for r in rows)))
        else:
            lines.append("最早到期: 没有带额度的未过期批次")
        return "\n".join(lines)
    except Exception as e:  # noqa: BLE001
        return "积分余额/到期: 查询异常 %s" % repr(e)[:150]


def main():
    global ACCOUNT, JWT_LEFT
    max_retries = env_max_retries()

    token, dev = load_creds()
    if not token:
        msg = dev if isinstance(dev, str) else "token 读取失败，请重跑宿主机导出脚本。"
        log("ERROR: " + msg)
        notify("TRAE 签到失败", msg)
        return 2

    auth = "Cloud-IDE-JWT " + token
    log("已读取 token（脱敏）: " + redact(token))
    claims = jwt_payload(token)
    ACCOUNT = str((claims.get("data") or {}).get("id") or claims.get("sub") or "未知账号(TRAE)")
    log("账号: %s" % ACCOUNT)

    exp = jwt_exp(token)
    if exp:
        remain_days = (exp - time.time()) / 86400.0
        JWT_LEFT = "%.1f 天" % remain_days
        log("JWT 剩余有效期约 %.1f 天" % remain_days)
        if remain_days < 7:
            log("注意：token 即将过期，请尽快重跑宿主机导出脚本。")

    log("查询签到状态(POST) ...")
    st, body = api_call_retry("POST", STATUS_URL, auth, {}, max_retries=max_retries)
    log("status 响应: %s %s" % (st, redact(body)))
    if st == "ERR":
        notify("TRAE 签到失败", "网络错误（已重试 %d 次），签到未完成，请检查网络后手动重跑。" % max_retries)
        return 1
    if isinstance(st, int) and st >= 500:
        notify("TRAE 签到失败", "服务端 5xx 错误（已重试 %d 次），签到未完成，请稍后重跑。" % max_retries)
        return 1
    if body.get("code") == 1001:
        notify("TRAE 签到失败", "登录态失效（code=1001），请打开 TRAE SOLO CN 登录并重跑宿主机导出脚本。")
        return 1
    if body.get("checked_in") is True:
        log("今日已签到")
        notify("TRAE 签到", "\n".join(["今日已签到", status_line(body),
                                       credit_report(auth, dev, max_retries)]))
        return 0

    log("尚未签到，执行 claim(POST) ...")
    # claim 需要设备档案头（status 不依赖，但 claim 缺 x-device-id 会 code=9004）
    st2, body2 = api_call_retry("POST", CLAIM_URL, auth, dev, max_retries=max_retries)
    log("claim 响应: %s %s" % (st2, redact(body2)))
    if st2 == "ERR":
        notify("TRAE 签到失败", "网络错误（已重试 %d 次），签到未完成。" % max_retries)
        return 1
    if isinstance(st2, int) and st2 >= 500:
        notify("TRAE 签到失败", "服务端 5xx 错误（已重试 %d 次），签到未完成。" % max_retries)
        return 1
    if body2.get("code") == 0 or body2.get("checked_in") is True:
        # claim 响应只有 code/message，积分数额要看签到前的 status 面板
        credits = body.get("credits")
        msg = "领取 %s 积分" % ("未知" if credits is None else credits)
        st3, body3 = api_call_retry("POST", STATUS_URL, auth, {}, max_retries=max_retries)
        msg += "\n%s" % ("已复查确认到账" if body3.get("checked_in") is True
                         else "⚠️ 复查状态未确认(HTTP %s)，请手动核对" % st3)
        msg += "\n" + status_line(body)
        msg += "\n" + credit_report(auth, dev, max_retries)
        log("签到成功，" + msg)
        notify("TRAE 签到成功", msg)
        return 0
    if body2.get("code") == 1001:
        notify("TRAE 签到失败", "登录态失效（code=1001），请打开 TRAE SOLO CN 登录并重跑宿主机导出脚本。")
        return 1
    if body2.get("code") == 9004:
        notify("TRAE 签到失败", "设备校验失败（code=9004）：设备档案缺失或已变，请重跑宿主机导出脚本。")
        return 1
    notify("TRAE 签到失败", "签到失败，响应: %s" % str(body2)[:300])
    return 1


def redact_json(obj):
    try:
        s = json.dumps(obj, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return str(obj)
    s = re.sub(r'("token"\s*:\s*")[^"]+(")', r'\1***\2', s)
    s = re.sub(r'("Authorization"\s*:\s*")[^"]+(")', r'\1***\2', s)
    return s


def redact(obj):
    """统一脱敏：str 走首尾打码；dict/list 走红action_json。"""
    if isinstance(obj, (dict, list)):
        return redact_json(obj)
    s = str(obj)
    if not s:
        return "<empty>"
    if len(s) <= 18:
        return s[:4] + "***" + s[-2:]
    return s[:12] + "..." + s[-6:]


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001
        import traceback
        notify("TRAE 签到异常退出", traceback.format_exc()[-1500:])
        code = 1
    sys.exit(code)