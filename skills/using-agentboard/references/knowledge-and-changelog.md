# 知识页与变更日志

## 写什么

写可复用的设计、接口、状态机、数据口径、验证方法和真实坑。

不写完成进度、关闭了哪些卡、剩余待办、个人日志或按日期组织的流水。

## 页面粒度

- 按领域分页：服务端与数据、前端与交互、测试与门禁、坑与注意点等。
- slug 语义化且稳定，例如 `agentboard-server-data`；不要用 `handoff-<uuid>`。
- 同主题先 `kb knowledge list/search/resolve`，命中则 `revise`，不新建同义页。
- `category` 取 `design|solved|pinned|open`；设计页显式写 `--landed proposed|partial|landed`。

## 文件事实源

- 工作区页：`<workspace>/.agentboard/Docs/<slug>.md`。
- 公共页：`<configDir>/Docs/<slug>.md`。
- 文件写入成功即命令成功；不要依赖 `page_commit`。
- 改 slug 只用 `kb knowledge rename`；直接改名会让 reconcile 报冲突。
- 外部编辑或 hash 冲突先 `kb knowledge reconcile`，不要手工伪造 revision。

## 新建与修订

新建示例：

```powershell
Get-Content body.md -Raw |
  kb knowledge create --scope workspace --workspace <id> --title '<标题>' --slug <slug> `
    --domain knowledge --category design --landed proposed --stdin `
    --sources-file sources.json --evidence-file evidence.json
```

- `--domain`：`accounts|knowledge|board|chat|ui|infra`。
- `sources` 与 `evidence` 各至少 1 条。
- `revise` 必须带当前 `--expected-revision`；旧值退出 2。
- 写完 `kb knowledge show <page-id>` 回读 id、scope、revision、正文。

## 来源与证据

- `source_id` 稳定且唯一；file 来源的 locator 是仓库相对路径，保存真实 sha256。
- evidence locator 写「路径 + 可选行号」；非文件证据只用 `cmd:` / `issue:` / `agent:`。
- file 来源和指向它的 evidence 不带 snapshot；snapshot 只用于 url/agent 且不超过 2 KiB。
- 同一证据不重复登记。

## 引用

- 正文和看板内用 `[[slug]]`；显示别名 `[[slug|别名]]`。
- 跨改名或机器可读用 `knowledge:<uuid>`。
- 禁止把仓库文档路径或 `file://` 链接当知识引用；文件路径只用于定位要修改的代码或文档。

## 变更日志

- 用户可见改动必须有日志；标题一行，正文说明用户可见变化。
- 归属本卡时传 `--issue <完整 UUID>`，否则 done 门禁不认。
- `done --close-record` 是最短路径：先写日志，失败则 done 不执行。
