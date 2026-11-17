---
id: 955992f1-316f-4d40-b41f-f41acca85eb7
slug: error-text-proxy-for-code-version
title: "用错误文案反推代码版本：判别打到旧服务的技巧"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: infra
category: design
landed: landed
sources:
  - source_id: "file:Docs/api.md"
    source_type: file
    locator: Docs/api.md
    captured_at: 1794910888808
    content_hash: 35dda8b06e3b613bc74a872b3056a53492fd7aa6f91f5cf14cb3c03b9dd3af74
evidence:
  - source_id: "file:Docs/api.md"
    locator: Docs/api.md
content_hash: a5bf0e9ebcc4b984f379c03e80a2f6ca95cd365ed742a63645cafc2197298f7d
expires_at: null
created_at: 1794910912334
updated_at: 1794910912334
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

## 结论

用**错误文案反推代码版本**：不同时段的实现报不同措辞，看到旧措辞即可判定请求打到了旧服务进程，而不是自己引入了回归。比记环境变量名更可靠。

## 判例：export-legacy 的两个文案

| 文案 | 代码版本 | 含义 |
|---|---|---|
| `回读校验失败：<path> 正文与旧库行不一致（零丢失红线）` | **R1 之前** | 逐页「写盘 → 回读 → 校验」；CRLF 页必炸且已落盘 |
| `导出前校验失败：<file> 正文与旧库行不一致（零丢失红线）；未写入任何文件` | **R1 之后** | 两阶段：先全量内存校验，全过后才写盘 |

实测经过：S4 验证 CLI 时看到 `回读校验失败…正文与旧库行不一致`，第一反应是 R1 严重回归。实际是 CLI 默认打 `http://127.0.0.1:8787`（旧 dist 的看板进程），而我猜的环境变量 `AGENTBOARD_URL` 根本不生效——CLI 用的是 `--server <url>` 参数。

## 为什么这条比「记环境变量名」有用

- 环境变量名会随实现变化，且每个命令可能不同；文案是**代码自身的一部分**，改名必须同步改代码
- 文案差异同时告诉你**行为差异**（旧版是写盘后失败 = 半迁移；新版是未写任何文件），不只是版本号
- 排查时你手上只有报错文本这一个信息，从它反推比去翻配置更快

## 适用条件

只在「文案随修复一起改过」时成立。因此修复 bug 时**主动改写错误文案**是给未来埋线索：

- 不要保留容易与旧版混淆的措辞
- 在新文案里加进**只有新版才有的信息**（如上例的「导出前」与「未写入任何文件」）
- 阶段前缀（`导出前` / `回读`）比句子更长但更容易一眼分辨

## 验证 CLI 与新 dist 配合的正确做法

```
node packages/cli/dist/index.js knowledge export-legacy --server http://127.0.0.1:<临时端口> --to <临时目录>
```

必须显式 `--server`，不能假设环境变量。默认 `DEFAULT_BASE = 'http://127.0.0.1:8787'`（`packages/cli/src/api.ts:4`）。

