# KBIMP-3 三格式端到端导入验收（2026-11-04）

环境：5174 dev（vite，proxy `/api` → 8787）+ Edge 156 headless（CDP 9333）+ 8787 重启后（`POST /api/system/restart`）。
方法：CDP `DOM.setFileInputFiles` 把 **真实文件**塞进 `input[data-testid="kb-import-file"]`，点「确认导入」走完整 UI 链路（`Docs/evidence/kbimp3-e2e-2026-11-04/e2e-import.mjs`）。

## 1. 四种样例的实际导入结果（`kb knowledge show` 复核）

| 样例 | 页 id | 标题 | body_md 字符数 | slug | sources / evidence |
| --- | --- | --- | --- | --- | --- |
| `samples/sample.md` | `28c37f99-c897-4d72-ab6b-e65ef1990a1d` | KBIMP-3 Markdown 样例 | 51 | `KBIMP-3-Markdown-样例` | 1 / 1 |
| `samples/sample.txt` | `edb00f59-c28e-45ac-aee0-ea70a191a900` | 纯文本样例：第一行作为标题 | 20 | `纯文本样例-第一行作为标题` | 1 / 1 |
| `samples/sample.json`（单对象） | `87842a47-218a-44fc-b2f3-473703d69cbb`（数组第 2 条，见下） | KBIMP-3 数组样例 B | 7 | `KBIMP-3-数组样例-B` | 1 / 1 |
| `samples/sample-array.json`（数组 2 条） | `bb0e9127-d9d4-413b-815b-461987527082` | KBIMP-3 数组样例 A | 7 | `KBIMP-3-数组样例-A` | 1 / 1 |
| ″ | `87842a47-218a-44fc-b2f3-473703d69cbb` | KBIMP-3 数组样例 B | 7 | `KBIMP-3-数组样例-B` | 1 / 1 |

- 前端预览与识别都正确：`Markdown · 0.1 KB · 识别到 1 页` / `纯文本 · 0.1 KB` / `JSON · 0.1 KB · 识别到 1 页` / `JSON · 0.2 KB · **识别到 2 页**`（数组逐条列出，两条均可单独取消）。
- 单对象 `sample.json` 的页 id 与数组 B 相同：**单对象导入先于数组执行，两次都尝试建同 slug，第二次被 409 拒**——脚本里把「单对象」与「数组」用了同名标题正是本次演练暴露的问题（见 §3 结论 ①）。

## 2. 冲突演练（同标题再导一次）

服务端直连复核（`POST /api/knowledge/pages/import`，标题与已建页相同）：

```
status=409
{"error":{"code":"KNOWLEDGE_EXISTS","message":"范围内已存在 slug「KBIMP-3-Markdown-样例」（公共库）；可改用「KBIMP-3-Markdown-样例-2」或先归档同 slug 的旧页"}}
```

前端对 `KNOWLEDGE_EXISTS` 的展示由 KBIMP-2 单测覆盖（`kb-import-error` 内出现「改标题」「后缀」两条建议，`knowledgeImport.test.tsx` 的 409 用例）。

## 3. 超限演练（100KB～1MB 是否真能过）

| 请求 | 结果 | 结论 |
| --- | --- | --- |
| 500 KB 正文（请求体 500,110 B） | `status=413`，body `{"error":{"code":"IMPORT_BODY_TOO_LONG","message":"正文 500024 字符，超过单页上限 100000 字符"}}` | **不属于 parser 层 413**：路由级 2MB parser 已生效（没有 `entity.too.large`）；被拒是因单页正文上限 10 万字符 |
| >1MB 文本 | 前端 `kb-import-failure` 直接拦截（`TOO_LARGE`，不再发请求） | 前端预检有效 |

结论：`100KB～1MB` 的请求**能过 parser**，但会被「单页正文 ≤100000 字符」的业务上限按 413 `IMPORT_BODY_TOO_LONG` 拒；两者语义不同，前端已分别给文案。

## 4. 发现的两个问题（未在本卡修，交对应卡）

① **json 逐条的 `category` / `landed` 没有落库**：`sample.json` 带 `category: "design"`、`landed: "proposed"`，`sample-array.json` 第 1 条带 `category: "solved"`，导入后三页均为 `category=legacy`、`landed=null`。前端 `rebuildContent()` 已把每条的 category/landed 写进 content（单测覆盖），故怀疑服务端 `planImport`/`createKnowledgePage` 只取顶层 `input.category/landed`，未按条目透传 → 属 KBIMP-1（服务端）范围。
② 同一批次里若两条 slug 相同（脚本里单对象与数组都用了同名标题），后一条静默 409 只在服务端返回里体现，前端只显示成功条目的 id —— 批量导入的「部分失败」需要在 UI 明示失败条目（也属 KBIMP-2/后续卡）。

## 5. 截图与产物

- `e2e-import.mjs`：可复现脚本（CDP 塞文件 + 走 UI 提交）
- `md.png` / `txt.png` / `json-single.png` / `json-array.png` / `conflict.png` / `oversize-blocked.png`
- `result.json`：脚本原始输出（含每步预览字段）
- 样例：`apps/server/test/fixtures/knowledge-import/{sample.md,sample.txt,sample.json,sample-array.json,sample-500kb.md}`（KB-DOC-1 已从 `Docs/verification/samples/` 移入测试夹具目录）

## 6. 清理

按卡面要求保留 1 页作常态样例（`28c37f99-c897-4d72-ab6b-e65ef1990a1d` Markdown 样例），其余导入页已 `knowledge action delete` 软删。

## 未验证

- 375px 窄屏下的导入流程未跑（本卡只验宽屏 1440）。
- `category/landed` 落库问题只做了字段观测，未定位到服务端具体行。
