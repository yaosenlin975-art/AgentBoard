# 知识页图片上传 + 修改历史界面

状态：待批准。用户已确认四项决策。

## 1. 意图

知识页正文是 markdown，但没有上传通道：只能引用外部 URL。同时后端已有完整修订链（每次 `revise` 写 `knowledge_revision` 快照），界面却没入口——用户看不到谁在什么时候改了什么。

## 2. 已确认决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 图片存储 | **存文件 + 新表**：文件落 `dirname(db)/attachments/knowledge/<pageId>/`，元数据进 `knowledge_attachment` 表；不 base64 内嵌 body_md |
| D2 | 体积与数量 | 单张 **≤5MB**、每页 **≤20 张**、每页总量 ≤50MB；类型 PNG/JPEG/WebP/GIF |
| D3 | 超限处理 | **提交前客户端自动压缩**（canvas 缩放 + 重编码），压到 ≤5MB 再上传；压缩后仍超限则拒绝并提示；**服务端仍硬校验 5MB**，不信任前端 |
| D4 | 插入方式 | 编辑区支持**粘贴 / 拖拽 / 「插入图片」按钮**，成功后自动插入 `![说明](url)` |
| D5 | 历史界面 | **列表 + 只读预览 + 可恢复**：恢复＝以旧内容**新建一条 revision**，不删除历史 |

## 3. 数据模型

```sql
CREATE TABLE IF NOT EXISTS knowledge_attachment (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,          -- knowledge/<pageId>/<id>.<ext>
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  original_bytes INTEGER,             -- 客户端压缩前的原始大小（可空）
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_attachment_page ON knowledge_attachment(page_id);
```
- 文件目录与 DB 同源派生（沿用 DOCKER-2 的 `dirname(db)/attachments` 约定，容器只挂 `/data`）。
- 删除知识页 → 附件行随 CASCADE 消失，文件由既有清理任务回收（沿用评论附件的回收模式：先标记后删文件）。

## 4. API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/knowledge/pages/:id/images` | multipart 上传；校验类型/大小/张数/总量；返回 `{id, url, bytes, width, height}` |
| GET | `/api/knowledge/images/:attachmentId` | 读取（带 `Cache-Control: private, max-age=31536000, immutable`）；`scope` 校验同知识页（workspace / common） |
| DELETE | `/api/knowledge/images/:attachmentId` | 删除（仅页的可见范围成员可删；同时不自动改写 body_md，避免误删正文引用） |

- 上传要求 `expected_revision` 不做（与正文修订解耦），但要求 `workspace_id` / `scope` 与页一致。
- 错误码：`IMAGE_TOO_LARGE`(413)、`IMAGE_TYPE_UNSUPPORTED`(415)、`IMAGE_LIMIT_EXCEEDED`(409)、`PAGE_NOT_FOUND`(404)。

## 5. 客户端压缩

- 触发：选择/粘贴/拖拽得到文件后，若 `bytes > 5MB` 或边长 > 5000px，先压缩。
- 做法：`createImageBitmap` → canvas 按最长边 ≤3000px 等比缩放 → `toBlob('image/webp', 0.9)`；WebP 不支持则退回 JPEG 0.9；**不改变 PNG 透明度的场景优先保留 PNG**（图标类）。
- 交互：显示「压缩中…原始 7.2MB → 3.1MB」，用户可见；压缩失败或仍超限 → 明确提示并中止。
- 不引入新依赖（浏览器原生 API）。

## 6. 历史界面

- 入口：知识页详情顶部「历史（N）」按钮（N = revision 数）。
- 面板：右侧抽屉列出 `revision` 降序，列：`rev N` / `change_kind` / `actor` / `时间` / `change_note`。
- 点一条 → 只读预览（复用 `MarkdownView` 渲染 `body_snapshot`），有「与当前版本对比」入口（可选，本批不做 diff，只并排看）。
- 「恢复此版本」：走 `PUT /pages/:id`，body/title 用该快照，`change_note` 写 `恢复自 rN`，`expected_revision` 用当前 revision → 产生**新** revision，历史不删。
- 恢复前二次确认（不可通过 UI 撤销，但可再恢复回来）。

## 7. 非目标

- 不做图片裁剪/编辑、不做图床外链、不做富文本编辑器。
- 不做 revision 之间的逐行 diff（后续可加）。
- 不改 `body_md` 的 100k 字符上限。

## 8. 拆卡

1. **KB-IMG-1 服务端**：表 + 迁移 + 上传/读取/删除端点 + 4 个错误码 + 大小/类型/张数校验 + 文件清理 + `Docs/api.md`。
2. **KB-IMG-2 前端编辑**：粘贴/拖拽/按钮 + canvas 压缩（含前后大小提示）+ 插入 markdown + 失败提示。
3. **KB-IMG-3 前端展示与导出**：详情正文图片渲染（含加载失败兜底、点击放大可后置）、导出 Markdown 时把站内图片 URL 改写为绝对路径或打包说明。
4. **KB-HIST-UI**：历史入口 + 抽屉列表 + 只读预览 + 恢复此版本（含二次确认）。

## 9. 验收（父级）

- 上传 6MB PNG → 客户端压缩后可上传，服务端对未压缩直传返回 413。
- 每页第 21 张 → 409；超总量 → 409；非图片类型 → 415。
- 知识页删除后附件行消失、文件被回收（贴孤儿文件检查）。
- 历史：改 3 次后列表 3 条；恢复 r1 → revision 变 4 且内容等于 r1、r1~r3 仍在。
- 权限：common 页图片可被 workspace 用户读；跨工作区不可读（403）。
- test 无新增失败；`pnpm -r build` exit 0；各卡 1 条变异 RED。
