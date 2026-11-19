# 设计与 Git

## 设计页落库

### 文件导入

```powershell
kb knowledge import Docs/<design>.md --scope workspace --workspace <id> `
  --slug <slug> --category design --landed proposed --domain knowledge
```

### 正文管道

```powershell
Get-Content body.md -Raw |
  kb knowledge create --scope workspace --workspace <id> --title '<标题>' --slug <slug> `
    --domain knowledge --category design --landed proposed --stdin `
    --sources-file sources.json --evidence-file evidence.json
```

### 回读

```powershell
kb knowledge show <page-id> --scope workspace --workspace <id>
```

确认 id、slug、revision、正文。`create` 缺正文或 sources/evidence 任一退出 1；slug 已存在返回 2，改走 `revise`。

## Git 时序

设计落库发生在拆卡之前，`kb done` 尚不存在。批准后立即提交：

```powershell
git add .agentboard/Docs/<slug>.md Docs/<design>.md
git commit -m "design: <标题>（knowledge:<page-id>）"
```

逐个列文件，不用 `git add .agentboard/Docs/` 整目录。

验证：

```powershell
git log --oneline -1 -- .agentboard/Docs/<slug>.md
git status --porcelain -- .agentboard/Docs/
```

除 `.index.json` 外应为空。`.index.json` 是可重建索引，不提交。

## 失败

- `git` 不可用、非仓库、路径逃逸或 hook 拒绝：报告「设计已落库（knowledge:<page-id>）但未进 git」，附补救命令。
- 提交失败不改变设计批准事实，但必须显式标注未提交。

## 设计批准后的状态

设计页先以 `landed=proposed` 落库。实现推进时改为 `partial|landed`，不要让 done 门禁长期被 proposed 阻塞。
