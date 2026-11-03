# 正式页（8787）六项冒烟证据

- 时间：2026-11-04 03:22–03:30；浏览器：Edge 156 headless（CDP，1440×900）；目标 `http://127.0.0.1:8787/`
- 配置：暗色（`agentboard.theme=dark`）+ 工作区 `任务看板`（`e41eb0fb-…`）
- 脚本：`smoke.mjs`（1–3/5–6 项）+ `graph-check.mjs`（第 4 项，先切「星图」视图）；原始结果 `results.json`

| # | 用户报的修复 | 判定 | 证据 |
| --- | --- | --- | --- |
| ① | 顶栏显示路径而非版本号 | ✅ | `[data-testid=topbar-workspace-path]` = `D:\WorkSpaces\任务看板`；`header [data-testid=app-version]` 不存在（`versionInTopbar=false`）。截图 `1-topbar.png` |
| ② | 搜索框与标签栏在「日志」右侧同一行 | ✅ | `view-log` 盒 `x=220, right=268, midY=80`；搜索框 `x=276, midY=80`（间距 8px、同一行）；标签栏 `x=508, midY=80`。截图 `2-toolbar.png` |
| ③ | 知识库无「共享知识库」标题块、搜索栏一行 | ✅ | 全页文本无「共享知识库」；搜索框 `x=188,w=915,midY=165` 单行铺满。截图 `3-knowledge.png` |
| ④ | 星图首屏居中 | ✅ | 切「星图」（`knowledge-view-graph`）后 canvas `1406×480`，中心 `(720,499)` = 宿主容器中心，`dx=0, dy=0`。截图 `4-graph.png` |
| ⑤ | 日志视图无「工作区日志」标题与切换 | ✅ | 无「工作区日志」文本、无「历史/归档日志」切换；`hasTitle=false, hasTabs=false`。截图 `5-log.png` |
| ⑥ | 暗色「修改模型」弹窗文字可读 | ✅ | 弹窗标题 `rgb(239,233,222)` on `rgb(28,26,24)` = **14.36:1**；窗内最差项 = 保存按钮 `rgb(255,255,255)` on `rgb(21,93,252)` = **5.25:1**（全部 ≥4.5）。截图 `6-model-dark.png` |

## 部署核对

- `pnpm publish:web` → exit 0（`built in 5.47s`，脚本总耗时 15.9s）
- 8787 HTML 引用：`/assets/index-B-uIXKD9.js`、`/assets/index-DXt2E79q.css`
- 部署产物含本轮修复的硬标记：CSS 内 `#a09a90`、`#6b6257`、`#a04a08`、`color-scheme:dark`、`.text-neutral-500`、`optgroup` 全部命中
- 哈希未变说明：发布前 `apps/web/dist` 已在 03:06 由同源码 `npx vite build` 生成（内容一致），因此 `publish:web` 重建产物哈希相同；部署新鲜度以「HTML 引用的 CSS 内含上述标记」为准
