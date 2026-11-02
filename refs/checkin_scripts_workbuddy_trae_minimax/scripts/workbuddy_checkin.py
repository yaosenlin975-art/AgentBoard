#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
WorkBuddy 每日积分自动签到 —— 青龙面板版
只使用 Python 标准库，无第三方依赖，支持多账号。

部署到青龙面板:
  1) 本文件放到青龙的 scripts 目录(本机映射 D:\qinglong\data\scripts)
  2) 令牌来源(按优先级):
     a) 令牌文件: 与本脚本同目录的 .workbuddy_token.json
        由宿主机 workbuddy_export.py 从 WorkBuddy 客户端内存自动提取并写入,
        格式 {"accounts": ["ACCESS_TOKEN#UID#备注", ...], "exported_at": "..."}
        —— 这是当前推荐方式, 环境变量里的旧令牌会被服务端吊销(2026-10-25 起三账号全 401)
     b) 环境变量 WORKBUDDY(兜底, 手工维护):
        格式: ACCESS_TOKEN#UID#备注   多账号用换行隔开
        例:
          eyJxxx.aaa.bbb#ef862ad8-...-xxx#主号
  3) 新建定时任务, 命令: task /ql/data/scripts/workbuddy_checkin.py  定时: 0 9,20 * * *
"""
import os
import random
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime

# 青龙内置通知模块（不可用时退回仅日志）
try:
    sys.path.insert(0, "/ql/scripts")
    sys.path.insert(0, "/ql/data/scripts")
    from notify import send
except Exception:  # noqa: BLE001
    send = None


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def notify(title, content):
    content = "%s\n\n时间: %s" % (content, datetime.now().strftime("%Y-%m-%d %H:%M"))
    log("通知正文[%s]:\n%s" % (title, content))
    if send:
        try:
            send(title, content)
            log(f"已发送通知: {title}")
        except Exception as e:  # noqa: BLE001
            log(f"发送通知失败: {e}")
    else:
        log(f"[通知未生效, 请确认 notify 可用] {title}: {content}")

# 接口域名（实测可用;网上流传的 copilot.tencent.com 已失效）
DOMAIN = os.environ.get("WORKBUDDY_DOMAIN", "www.codebuddy.cn")
CHECKIN_URL = f"https://{DOMAIN}/billing/meter/daily-checkin"
# 注意: /billing/meter/checkin-status 现在恒返回 active=false 且各字段为 0，
# 真实签到状态只有 checkin-activity-status 给。
STATUS_URL = f"https://{DOMAIN}/billing/meter/checkin-activity-status"
SUMMARY_URL = f"https://{DOMAIN}/billing/meter/get-user-resource-summary"
PACKAGES_URL = f"https://{DOMAIN}/billing/meter/get-user-resource-free-packages"
# 猫猫旅行（增长中心活动）：空闲时派出，到站后领取，每日一次，单次 5~10 积分
TRAVEL_STATUS_URL = f"https://{DOMAIN}/activity/growth/buddy/travel/status"
TRAVEL_CONFIG_URL = f"https://{DOMAIN}/activity/growth/buddy/travel/config"
TRAVEL_DEPART_URL = f"https://{DOMAIN}/activity/growth/buddy/travel/depart"
TRAVEL_CLAIM_URL = f"https://{DOMAIN}/activity/growth/buddy/travel/claim"

# 令牌文件(宿主机 workbuddy_export.py 自动导出, 与本脚本同目录)
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".workbuddy_token.json")


def num(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def api_request(url, token, body=None, method="POST"):
    data = json.dumps(body or {}).encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent",
                   "WorkBuddy/1.0 (com.codebuddy; build:200407; windows) ")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if error_body:
            try:
                return json.loads(error_body)
            except Exception:
                log(f"HTTP {e.code}: {error_body[:300]}")
        else:
            log(f"HTTP {e.code} {e.reason}")
        return None
    except Exception as e:
        log(f"请求异常: {e}")
        return None


def credit_report(token):
    """积分余额 + 最早到期的一笔。批次里 DeductionEndTime（扣减截止）就是过期时刻。"""
    try:
        summary = api_request(SUMMARY_URL, token, body={}) or {}
        packages = (summary.get("data") or {}).get("Packages") or []
        if not packages:
            return "积分余额: 未取到"
        codes = [p.get("PackageCode") for p in packages if p.get("PackageCode")]
        batch = api_request(PACKAGES_URL, token, body={
            "PageNumber": 1, "PageSize": 100, "PackageCodes": codes, "IsDisplayTotalInfo": True}) or {}
        now_ms = int(time.time() * 1000)
        rows = [(int(num(a.get("DeductionEndTime"))), num(a.get("CapacityRemain")),
                 a.get("PackageName") or "赠送批次")
                for a in ((batch.get("data") or {}).get("Accounts") or [])
                if num(a.get("CapacityRemain")) > 0 and int(num(a.get("DeductionEndTime"))) > now_ms]
        # ponytail: 只翻第一批 100 条批次，批次多于 100 时最早到期可能落在后面页
        unit = (packages[0].get("CapacityUnit") or "积分")
        lines = ["积分余额: %.1f %s（本周期发放 %.1f，%d 个资源包）" % (
            sum(num(p.get("CycleRemainCapacity")) for p in packages), unit,
            sum(num(p.get("CycleTotalCapacity")) for p in packages), len(packages))]
        if rows:
            end_ms, remain, name = min(rows)
            lines.append("最早到期: %s %g %s 于 %s 过期（还剩 %d 天），未过期批次共 %d 笔 %.1f %s" % (
                name, remain, unit,
                datetime.fromtimestamp(end_ms / 1000).strftime("%Y-%m-%d %H:%M"),
                (end_ms - now_ms) // 86400000, len(rows), sum(r[1] for r in rows), unit))
        else:
            lines.append("最早到期: 没有未过期余额批次")
        return "\n".join(lines)
    except Exception as e:  # noqa: BLE001
        return "积分余额/到期: 查询异常 %s" % repr(e)[:150]


def travel(token):
    """猫猫旅行：到站就领，空闲就随机挑个地点派出去。每日一次。"""
    status = (api_request(TRAVEL_STATUS_URL, token, method="GET") or {}).get("data") or {}
    state = status.get("state")
    if state == "arrived":
        res = api_request(TRAVEL_CLAIM_URL, token, body={}) or {}
        if res.get("code") == 0:
            return "领到旅行奖励 +%s 积分" % (res.get("data") or {}).get("reward_credit", "未知")
        return "领取失败: %s" % (res.get("msg") or "无响应")
    if state == "traveling":
        arrive = num(status.get("arrive_at"))
        name = (status.get("location") or {}).get("name") or "未知地点"
        return "仍在去%s的路上，%s 到站" % (
            name, datetime.fromtimestamp(arrive).strftime("%H:%M") if arrive else "稍后")
    if status.get("daily_limit_reached"):
        return "今日已派出过，不再重复"
    cfg = api_request(TRAVEL_CONFIG_URL, token, method="GET") or {}
    spots = [x for x in (cfg.get("data") or {}).get("locations") or [] if x.get("id")]
    if not spots:
        return "没有可选旅行地点，未派出"
    spot = random.choice(spots)
    res = api_request(TRAVEL_DEPART_URL, token, body={"location_id": spot["id"]}) or {}
    if res.get("code") == 0:
        return "已派猫猫去%s（%s~%s 小时到站，奖励 %s~%s 积分）" % (
            spot.get("name") or "未知地点", spot.get("duration_hours_min", "?"),
            spot.get("duration_hours_max", "?"), spot.get("reward_credit_min", "?"),
            spot.get("reward_credit_max", "?"))
    return "派出失败: %s" % (res.get("msg") or "无响应")


def claim(env_item):
    """执行单账号签到, 返回 (note, status, detail); status: success/already/failed"""
    try:
        parts = env_item.strip().split("#")
        token = parts[0].strip()
        note = parts[2].strip() if len(parts) > 2 else parts[0][:8]
    except Exception:
        return ("未知账号", "failed", "环境变量解析失败")

    if not token:
        return (note, "failed", "access_token 为空")

    log(f"账号: {note} 域名: {DOMAIN}")

    # 先查活动状态：既判断今日是否已签，也给出本期累计/连签天数
    progress = ""
    status = api_request(STATUS_URL, token, body={})
    data = (status or {}).get("data") or {}
    if data:
        progress = "本期累计 %s 积分，连签 %s 天，本周已签 %s 天" % (
            data.get("total_credits", "未知"), data.get("streak_days", 0),
            data.get("week_checkin_days", 0))
        if data.get("today_checked_in"):
            log("今日已签到，无需重复领取。")
            return (note, "already", "今日已签到，+%s 积分（%s）\n%s\n猫猫旅行: %s" % (
                data.get("today_credit", "未知"), progress, credit_report(token), travel(token)))
    else:
        log("查询签到状态失败，继续尝试直接签到")

    # 执行签到
    result = api_request(CHECKIN_URL, token, body={})
    if result is None:
        log("签到失败: 请求异常，请检查网络或 token 是否过期。")
        return (note, "failed", "请求异常，请检查网络或 token 是否过期")
    code = result.get("code", -1)
    if code == 10001:
        log("今日已签到(code=10001)，无需重复领取。")
        return (note, "already", "今日已签到（%s）\n%s\n猫猫旅行: %s" % (
            progress or "状态未取到", credit_report(token), travel(token)))
    if code == 0 and result.get("data"):
        data = result["data"]
        credit = data.get("credit", data.get("today_credit", "未知"))
        streak = data.get("streak_days")
        detail = "获得积分: +%s" % credit
        if streak:
            log(f"连续签到: {streak} 天")
            detail += "，连签 %s 天（%s）" % (streak, progress or "本期累计未取到")
        log(f"✅ 签到成功! {detail}")
        return (note, "success", detail + "\n" + credit_report(token)
                + "\n猫猫旅行: " + travel(token))
    log(f"签到失败: {result.get('msg','未知错误')} (code={code})")
    return (note, "failed", "%s (code=%s)" % (result.get("msg", "未知错误"), code))


def load_items():
    """加载待签到账号列表, 返回 (items, source)。

    优先级: 令牌文件 .workbuddy_token.json > 环境变量 WORKBUDDY。
    两种来源的行格式都是 ACCESS_TOKEN#UID#备注, claim() 无需区分。
    """
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, encoding="utf-8") as f:
                data = json.load(f)
            accounts = data.get("accounts") or []
            items = [str(x).strip() for x in accounts if str(x).strip()]
            if items:
                return items, "令牌文件 %s（导出于 %s）" % (
                    TOKEN_FILE, data.get("exported_at", "未知"))
            log("令牌文件存在但没有账号，回退环境变量 WORKBUDDY")
        except Exception as e:  # noqa: BLE001
            log("读取令牌文件失败(%s)，回退环境变量 WORKBUDDY" % e)

    raw = os.environ.get("WORKBUDDY", "")
    items = [x.strip() for x in raw.splitlines() if x.strip()]
    return items, "环境变量 WORKBUDDY"


def main():
    items, source = load_items()
    if not items:
        log("错误: 未找到可用令牌（令牌文件 %s 与环境变量 WORKBUDDY 均为空）" % TOKEN_FILE)
        notify("WorkBuddy 签到失败",
               "未找到可用令牌：令牌文件与环境变量 WORKBUDDY 均为空。\n"
               "请在宿主机运行 python D:\\qinglong\\workbuddy_export.py 导出令牌。")
        return 1
    log("令牌来源: %s，账号数: %d" % (source, len(items)))

    results = [claim(item) for item in items]
    success = [r for r in results if r[1] == "success"]
    failed = [r for r in results if r[1] == "failed"]
    already = [r for r in results if r[1] == "already"]

    def render(rs):
        out = []
        for note, _, detail in rs:
            lines = str(detail).split("\n")
            out.append("- %s: %s" % (note, lines[0]))
            out.extend("  " + line for line in lines[1:])
        return "\n".join(out)

    if success:
        parts = [render(success)]
        if already:
            parts.append("今日已签到:\n" + render(already))
        if failed:
            parts.append("签到失败:\n" + render(failed))
        notify("WorkBuddy 签到成功", "\n\n".join(parts))
    elif failed:
        parts = [render(failed)]
        if already:
            parts.append("今日已签到:\n" + render(already))
        notify("WorkBuddy 签到失败", "\n\n".join(parts))
    elif already:
        # 晚上收猫那次就是这种情形：签到没新增，但旅行结果必须报出来
        notify("WorkBuddy 签到结果", "今日已签到:\n" + render(already))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001
        import traceback
        notify("WorkBuddy 签到异常退出", traceback.format_exc()[-1500:])
        code = 1
    sys.exit(code)