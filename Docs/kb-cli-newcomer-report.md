# kb CLI 新人可用性实测报告

**总评**：只靠 `--help`，新人能独立走完「建卡 → 领卡 → 写完 → `done`」，但走不到「关闭」——CLI 没有任何命令能把卡改到 `已关闭`/`已废弃`，也没法改已建好的卡标题/描述/优先级；知识页 `create` 因为 `--sources/--evidence` 的 JSON 结构没有任何文档，实测需 4 次试错 + 写 `.cmd` 包装文件才成功。

测法：只读 `kb --help` 与各子命令 `--help`，未读 SKILL/README/api.md；全部操作在自建工作区 `kb-newcomer-test`（`D:\tools\tmp\kbtest-ws`，id `5eb8162c-6c96-4509-bb32-37a1c79b0174`）内完成；未触碰既有工作区。

试错记录（按发生顺序）：

| # | 我当时的意图 | 实际输入的命令 | 发生了什么 | 我误以为是什么 | --help 是否解决 | 严重度 | 一句话建议 |
|---|---|---|---|---|---|---|---|
| 1 | 看版本 | `kb --version` | `0.1.0`，exit 0 | — | — | — | 无 |
| 2 | 看有哪些工作区 | `kb list-spaces` | 8 行 `id/name/path` 表格，exit 0 | 以为会默认绑定当前目录的工作区 | 否 | P2 | `list-spaces` 标注当前 cwd 对应的工作区（`*` 前缀） |
| 3 | 建自己的工作区 | `kb create-space kb-newcomer-test 'D:\tools\tmp\kbtest-ws'` | `已创建工作空间: 5eb8162c…`，exit 0 | — | 是 | — | 无 |
| 4 | 想事后删掉沙盒工作区 | `kb delete-space kb-newcomer-test` / `kb remove-space …` | `error: unknown command 'delete-space'`，exit 1 | 以为一定有对应删除命令 | 否（根 help 也没提） | P1 | 提供 `delete-space`（含 `--dry-run`），或根 help 明确写「工作区只能建不能删」 |
| 5 | 建卡（带长描述） | `kb create-issue kb-newcomer-test '新人测试卡 A' -d $多行 -p 高 -l 'newcomer,test'` | `已创建任务: ae8c9499…` / `状态: 待规划` / `截止: （未设置）`，exit 0；`show` 回读三行描述与空行都在 | 看到 `-d` 写「多行走 UI 或 API」，以为 CLI 只能写单行 | 否（与实际能力矛盾） | P1 | `-d` 改成「多行直接传，或 `--description-stdin`」，别写「多行走 UI 或 API」 |
| 6 | 多行描述 | 同上（PowerShell here-string） | 描述保留换行，但描述里的 `"引号"` 写入后变成 `引号`（引号丢失） | 以为引号会被保留 | 否 | P2 | 明说 `-d` 值里的引号/反斜杠如何处理，或提供 `--description-stdin` |
| 7 | 标签怎么分隔 | `kb create-issue … -l 'a b, c'` | `show` 得 `标签: a, b, c`（空格与逗号都拆） | 以为只有逗号分隔 | 是（help 写了「逗号或空格分隔」） | — | 无 |
| 8 | 优先级写错值 | `kb create-issue … -p 紧急` | `priority: Invalid option: expected one of "低"\|"中"\|"高"`，exit 1 | 中文 CLI 里突然冒出 zod 英文报错，怀疑是内部崩溃 | 是（能猜出合法值） | P2 | 校验错误统一中文化：`优先级只能是 低/中/高` |
| 9 | 截止日期写错 | `kb create-issue … --due 2026-13-45` | `--due 不是有效日期时间：「2026-13-45」`，exit 1 | — | 是 | — | 无 |
| 10 | 截止日期写对 | `kb create-issue … --due 2026-12-01T09:30` | `截止: 2026-12-01 09:30` | — | 是 | — | 无 |
| 11 | 改已建好的卡的标题/描述/优先级/截止 | `kb update --help` / `kb edit --help` | **打印根 help 全文、exit 0** | 以为 `update` 存在、只是 help 排版如此 | 否（help 反而误导） | P1 | 未知子命令 + `--help` 必须 exit 非 0 并提示「未知命令」 |
| 12 | 同上，真跑一次 | `kb update <id>` | `error: unknown command 'update'`，exit 1 | — | — | — | 见 #11 |
| 13 | 改卡内容（确认无解） | `kb status set kb-newcomer-test 已关闭` | `error: unknown command 'set'`，exit 1 | 以为 `status` 既能管字典也能改卡状态 | 否 | P1 | `status` help 里写明「只管状态字典，不改卡状态」 |
| 14 | **把卡关闭**（循环最后一步） | `kb close/accept/approve/review/release/reopen <id>`（逐个试） | 全部 `error: unknown command 'close'` 等，exit 1 | 以为至少有个 `accept`/`close` 能过验收 | 否 | **P0** | 加 `kb close <id>`（→已关闭）与 `kb reopen <id>`（→待规划），或在 `done` 输出里给出关闭命令 |
| 15 | 列我的工作区任务 | `kb list-tasks --workspace kb-newcomer-test` | 表格含 `id/状态/优先级/labels/占用者/评论/parent_issue_id/标题`，exit 0 | 以为不传 `--workspace` 会用 cwd 的工作区 | 是（help 明说不传=聚合全部） | P2 | 不传时输出加一行提示「聚合了 N 个工作区」 |
| 16 | 按状态筛 | `kb list-tasks --workspace kb-newcomer-test --status 待规划` | 只列 `待规划`，exit 0 | — | 是 | — | 无 |
| 17 | 按状态筛（合法但无卡） | `… --status 进行中` | `（无任务）`，exit 0 | 以为会报错 | 是 | — | 无 |
| 18 | 按状态筛（瞎写） | `… --status 不存在的状态` | exit 1 + `未知状态：不存在的状态（工作区 kb-newcomer-test 可用状态：待规划 / 进行中 / 待验收 / 已关闭 / 已废弃）` | — | 是 | — | 无（这条做得很好） |
| 19 | 不传工作区但按状态筛 | `kb list-tasks --status 待规划 --json` | 跨全部工作区返回（含「任务看板」的卡） | 以为 `--status` 会按「本工作区」字典校验，但没传工作区时按哪个 workspace 校验没写 | 否 | P2 | help 补一句「不传 `--workspace` 时状态名须在所有工作区均有效」 |
| 20 | 看任务树 | `kb list-tasks --workspace kb-newcomer-test --tree` | 带 `层级` 列、子卡前缀 `↳`，exit 0 | — | 是 | — | 无 |
| 21 | 想连描述一起导出 | `kb list-tasks … --json` | JSON 里 `"description_omitted": true` | 以为 JSON 会给全字段 | 是（help 写 `--full`） | P2 | 直接默认给描述，`--full` 反而多余；或字段名改 `description_truncated` |
| 22 | 同上加 `--full` | `kb list-tasks … --full`（漏了 `--json`） | 输出与不带 `--full` **完全一样**，exit 0，无任何提示 | 以为 `--full` 对表格也生效 | 否（help 只说「`--json` 时」） | P2 | 非 `--json` 时传 `--full` 给出提示或直接报错 |
| 23 | 看单卡 | `kb show <id>` | 中文标签字段 + 评论列表；但 `created_at: 1793697519914` 原样毫秒，且多出 help 从未提过的 `resolved: true` | 不知道 `resolved` 是什么、和状态什么关系 | 否 | P2 | 时间同时给本地可读串；`show` 里解释或去掉 `resolved` |
| 24 | 领卡 | `kb claim <id>` | `领取成功（agent: kb-cli）` + 全字段 + `工作空间路径: D:\tools\tmp\kbtest-ws`，状态变 `进行中`，exit 0 | 不知道 `kb-cli` 从哪来（`KB_AGENT` 只在 `comment` 的 help 里提过） | 否 | P1 | 所有写操作 help 统一写「作者/占用者身份取 `KB_AGENT`，缺省 `kb-cli`」 |
| 25 | 重复领 | `kb claim <id>` 再来一次 | exit 2 + `已被占用` | — | 是（help 写了 409→2） | — | 无 |
| 26 | 想知道领卡时 `--no-knowledge` 干嘛 | `kb claim --help` | 只有 `--no-knowledge` / `--knowledge-query <query>` 两个裸选项名 | 以为领卡会自动检索知识页、但 help 没说默认行为 | 否 | P1 | 补一句「缺省自动按任务标题检索本工作区知识页并输出摘要；`--no-knowledge` 关闭」 |
| 27 | 领被阻塞的卡 | `kb dep add D ← B` 后 `kb claim D` | exit 2 + `存在未完成的前置任务：新人测试卡 B（前置）(ac349cd6)；完成后可领取` | — | 是 | — | 无 |
| 28 | 写多行中文评论 | `cmd /c "chcp 65001>nul && kb comment <id> --stdin < file.txt"` | `评论已写入: 30b28f29…` / `未唤醒（任务未被占用，仅留言）`，exit 0，换行与中文全保留 | **卡当时是 `进行中`、占用者 `kb-cli`，却说「未被占用」** | 否 | P1 | 改成真实原因（如「占用会话未绑定，无法唤醒」）或直接去掉这句 |
| 29 | 评论同时给文本和 stdin | `kb comment <id> 命令行文本 --stdin < file` | exit 1 + `评论内容 text 与 --stdin 二选一，不能同时使用` | — | 是 | — | 无 |
| 30 | 评论附带非图片 | `kb comment <id> img --image …\kb.md` | exit 1 + `仅支持 PNG、JPEG 或 WebP 图片` | — | 是（help 写了三种格式） | — | 无 |
| 31 | 给不存在的卡评论 | `kb comment 00000000-… hi` | exit 1 + `任务不存在` | — | — | — | 无 |
| 32 | 完成任务（带备注） | `kb done <id> --notes "多行…"` | `已完成: …` / `状态: 待验收（占用已释放，notes 落评论流）` + 知识页建议 + 完整 `knowledge create` 示例命令，exit 0 | — | 是（这段提示是全 CLI 唯一讲清知识页 slug 约定的地方） | — | 无（这条做得最好） |
| 33 | 完成备注写多行 | `kb done <id> --notes` 无 `--stdin` | 只能靠 shell 传参，`--stdin` 不存在 | 以为 `done` 和 `comment` 一样支持 `--stdin` | 否 | P1 | `done --notes-stdin` 或 `--notes-file` |
| 34 | 没领卡直接完成 | `kb done <未领的卡>` | exit 2 + `未被占用` | 以为能代替别人收尾、或有 `--force` | 否 | P1 | 明确「必须自己 claim 后才能 done」；给 `--force` 或 `kb claim --steal` |
| 35 | `--scope` 是什么 | `kb done --help` | `--scope <path>` 说明为「有并行占用时只提交声明范围内的改动」 | 不知道不传会怎样、和 git 有关吗 | 否 | P2 | 补「不传=不校验路径；传了且越界会被拒」并给一个示例 |
| 36 | 标记失败 | `kb fail <id> --reason "…"` | `已标记失败: …` / `状态: 待规划（占用已释放，reason 落评论流）`，exit 0 | — | 是 | — | 无 |
| 37 | 建子卡 | `kb create-issue --parent <父> kb-newcomer-test '子卡 C'` | 创建成功（选项可写在位置参数前），`--tree` 里正确出现 `↳ 子卡 C` | 以为 `--parent` 必须放最后 | 是 | — | 无 |
| 38 | 加依赖 | `kb dep add <被阻塞> <前置>` | `已建立依赖：A ← B`，`dep ls` 两侧都能看到，含 `解除` 列 | 参数顺序（谁是前置）只能靠箭头 `←` 猜 | 是（`dep add --help` 有 Arguments 说明） | — | 输出里把箭头换成人话：`A 需要先完成 B` |
| 39 | 依赖「已解除」语义 | `dep ls` 显示 `待验收 已解除`，但同卡 `--json` 里 `resolved: false` | 同一张卡两处结论相反 | 以为 `resolved` 就是「能否解锁下游」 | 否 | P2 | 统一术语：`待验收` 算解除，`resolved` 改名 `is_closed` |
| 40 | 移动层级 | `kb move-issue <卡> --parent <父>` / `--root` / `--parent 自身` | 前两个 exit 0；自引用 exit 1 + `父任务不能是自身或其后代` | — | 是 | — | 无 |
| 41 | 删卡（忘了 `--yes`） | `kb delete-issue <id>` | exit 1 + `将删除任务 …「labels测试」（状态: 待规划）。删除不可恢复，确认请重新执行并加 --yes` | — | 是 | — | 无（这条很好） |
| 42 | 删有子任务的卡 | `kb delete-issue <父> --yes` | exit 2 + `任务仍有子任务，请先移动或删除子任务` | — | 是 | — | 无 |
| 43 | 删卡成功 | `kb delete-issue <id> --yes` | `已删除任务: …（不可恢复）`，exit 0 | — | — | — | 无 |
| 44 | 加自定义状态 | `kb status add kb-newcomer-test 验证中 --kind started` | `已新增状态：验证中（kind=started，排序 50，id e389c899…）`，exit 0 | `--kind` 的五个值到底影响什么（哪一列、什么流转）help 没说 | 部分（help 列了五个值，没解释语义） | P1 | 补一句「kind 决定看板列与流转语义：open=待办列、started=进行中列、review=验收列、done=关闭列、deprecated=废弃列」 |
| 45 | 删自定义状态 | `kb status rm … 验证中` | exit 1 + `删除状态 验证中 前必须指定迁移目标（migrate_to），该状态下的卡会迁到目标状态` | — | 是 | — | 无 |
| 46 | 删（带迁移） | `kb status rm … 验证中 --migrate-to 待规划` | `已删除状态：验证中；0 张卡迁移到 待规划`，exit 0 | — | — | — | 无 |
| 47 | **建知识页** | `kb knowledge create --scope workspace --workspace … --slug kb-test-page --title 知识页测试 --stdin < kb.md` | exit 1 + `create 必须提供 --stdin、--sources 和 --evidence` | 完全不知道 `--sources/--evidence` 要什么 JSON —— `knowledge create --help` 里这两个选项**一个字的说明都没有** | 否 | **P0** | help 里给完整可粘贴示例：`--sources '[{"source_id":"s1","source_type":"file","locator":"docs/x.md","captured_at":1793697519914,"content_hash":"<64 位 hex>"}]' --evidence '[{"source_id":"s1","locator":"docs/x.md"}]'` |
| 48 | 试空数组 | `--sources "[]" --evidence "[]"` | **`看板服务未启动（默认 http://127.0.0.1:8787，用 --server 指定）` + 启动命令提示，exit 1**（服务其实正常，同一时刻 `list-spaces` 成功） | 真去重启服务，浪费十几分钟 | 否 | P1 | 客户端校验/参数错误绝不能复用「服务未启动」文案；先本地校验再连网 |
| 49 | 试空数组（正确引号） | `--sources [] --evidence []` | exit 1 + `sources: Too small: expected array to have >=1 items; evidence: Too small: expected array to have >=1 items` | 仍不知道对象内部字段叫什么 | 否 | P1 | 见 #47；同时把这些 zod 英文串中文化 |
| 50 | 猜字段（瞎试） | `--sources [{"a":1}] --evidence [{"b":2}]` | `error: too many arguments for 'create'. Expected 0 arguments but got 1.`（cmd 吃掉了引号） | 以为是 CLI 不接受 JSON | 否 | P1 | help 给出 Windows cmd/PowerShell 下的引号写法 |
| 51 | 猜出正确结构（第 4 次） | 写 `k1.cmd` 包一层：`--sources "[{""source_id"":""s1"",""source_type"":""file"",""locator"":""docs/x.md"",""captured_at"":1793697519914,""content_hash"":""000…0""}]" --evidence "[{""source_id"":""s1"",""locator"":""docs/x.md""}]"` | `239d49e2… [workspace] rev:1 t3` + 正文回显，exit 0 | 字段名全靠从别的工具（MCP）猜 | 否 | P0 | 同 #47 |
| 52 | JSON 写坏 | `--sources "[[["` | exit 1 + `Unexpected end of JSON input`（英文，不说是哪个参数） | 不知道哪个 flag 挂了 | 否 | P1 | `--sources 不是合法 JSON：…` |
| 53 | 列知识页 | `kb knowledge list --scope workspace --workspace …` | 先打印一行 `[] rev:` 再打印**原始 JSON**，exit 0 | 以为非 `--json` 模式会是人类可读表格 | 否 | P2 | 表格化：`slug / 标题 / 状态 / rev / 更新时间` |
| 54 | 读知识页 | `kb knowledge show <id> --scope workspace --workspace …` | `id [scope] rev:1 标题` + 正文，无字段标签 | 分不清哪段是标题 | 否 | P2 | 加 `标题:` / `状态:` 标签行 |
| 55 | 搜知识页 | `kb knowledge search 测试 --scope workspace --workspace …` | 直接返回整篇正文（无摘要/无 score） | 以为会给命中摘要 | 否 | P2 | 给标题 + 命中片段 + score |
| 56 | 改知识页 | `kb knowledge revise <id> --stdin < …` | exit 1 + `error: required option '--expected-revision <n>' not specified` | help 里 `--expected-revision` 与 `--title` 并列、看不出必填 | 部分 | P1 | 必填选项在 help 里标 `(必填)`，并在报错里给 `kb knowledge show` 查 rev 的提示 |
| 57 | 归档知识页 | `kb knowledge action <id> archive --expected-revision 1 …` | 成功但只回显 `rev:2` + 正文，**没说「已归档」** | 以为没生效 | 否 | P2 | 输出动作结果：`已归档 page，rev 1 → 2` |
| 58 | 动作名瞎写 | `kb knowledge action <id> frobnicate --expected-revision 2 …` | exit 1 + `action: Invalid option: expected one of "archive"\|"restore"\|"delete"` | 只有写错才知道合法动作是这三个 | 否 | P1 | `knowledge action --help` 直接列出 `archive\|restore\|delete` 及各自效果 |
| 59 | 删知识页 | `kb knowledge action <id> delete --expected-revision 2 …` | exit 0，`knowledge list --json` 变空 | — | — | — | 无 |
| 60 | 写变更日志 | `cmd /c "… kb changelog create --workspace … --title … --type 新增 --stdin < kb.md"` | `c63c56b0… [新增] 2026-11-03 09:21:26 rev:1 by:kb-cli`，exit 0 | **本地时间 17:21，输出写 09:21 —— 变更日志时间戳走 UTC，其余命令/看板走本地** | 否 | P1 | 输出统一本地时区并标 `+08:00`，或在 help 注明 UTC |
| 61 | 不传工作区写日志 | `kb changelog create --title 测试 --type 新增 --body 正文` | exit 1 + `error: required option '--workspace <id|名>' not specified` | — | 是（help 描述已强调显式） | — | 无 |
| 62 | 类型写 `历史` | `… --type 历史` | exit 1 + `change_type: Invalid option: expected one of "新增"\|"修复"\|"调整"`（而 `changelog list --type` 却接受 `历史`） | 以为 create 也能写历史 | 部分（help 写「历史类型仅供导入」） | P2 | 报错里直接说「历史类型只能由 `changelog import` 写入」 |
| 63 | 删测试日志 | `kb changelog delete <id> --expected-revision 1 --workspace …` | `已删除变更日志: …`，exit 0 | — | 是 | — | 无 |
| 64 | 想清空沙盒工作区 | （无命令，见 #4） | 只能留着 | — | 否 | P1 | 见 #4 |
| 65 | 打开自启/快捷方式 | 未执行 `kb autostart` / `kb shortcut` | 未验证（会写 HKCU Run 与桌面，超出本次范围） | — | — | — | help 里注明「会写入注册表/桌面，先 `--dry-run`」 |

## 统计

- **P0 阻断：2**（#14 无法关闭卡；#47/#51 知识页 `--sources/--evidence` 结构零文档）
- **P1 困惑：17**（#4、#5、#11、#13、#24、#26、#28、#33、#34、#44、#48、#49、#50、#52、#56、#58、#60）
- **P2 体验：15**（#2、#6、#8、#15、#19、#21、#22、#23、#35、#39、#53、#54、#55、#57、#62）
- 合计 **34 条**（另有 #1/#3/#7/#9/#10/#12/#16/#17/#18/#20/#25/#27/#29–#32/#36–#38/#40–#43/#45/#46/#59/#61/#63/#64 为正常行为，#65 未验证）

## 最该先改的 3 件事

1. **补上 `kb close` / `kb reopen`（P0）**。现在 `done` 之后卡永久停在 `待验收`，CLI 用户无法闭环；这直接掐断任务说明里的「建卡→领卡→做完→关闭」。顺带把 `kb update --title/--description/--priority/--due` 补上——建完卡发现标题写错，只能删掉重建。
2. **`kb knowledge create` 的 help 给出可粘贴示例（P0）**。`--sources` / `--evidence` 要求 1 条以上、字段含 `source_id/source_type/locator/captured_at/content_hash(64 hex)`，全靠试错；`knowledge *` 一族选项目前连描述都没有。
3. **把「服务未启动」从客户端错误路径里摘掉（P1）**。参数校验失败、JSON 解析失败都会命中「看板服务未启动 + pnpm … start」这条文案，是本次最浪费时间的误导；同时把所有 zod 英文报错（`Invalid option: expected one of …` / `Too small: expected array…`）中文化。

## 没能独立完成的环节

- **关闭卡**：无命令，卡在 `待验收`。
- **改卡内容**：无 `update`/`edit`。
- **建知识页**：第 4 次尝试（手写 `.cmd` 包装 + 猜 JSON 结构）才成功；纯 help 无法完成。
- **删除沙盒工作区**：无命令，`kb-newcomer-test`（`5eb8162c-6c96-4509-bb32-37a1c79b0174`，路径 `D:\tools\tmp\kbtest-ws`）已保留，卡/知识页/变更日志均已清空。
