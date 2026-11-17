---
id: 1dea0420-4d17-4ac3-b30e-a526a09d1464
slug: blind-test-second-pass-verification
title: "盲测报告的二次核验：前提、消费方、设计意图"
revision: 1
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: knowledge
category: solved
landed: landed
sources:
  - source_id: s1
    source_type: file
    locator: skills/using-agentboard/SKILL.md
    captured_at: 1794911549152
    content_hash: 07cb78f1e7004b8eb717bfccd4ce7cc32caea08625f33e02a59f573185d41cf9
  - source_id: s2
    source_type: file
    locator: skills/swing-dev/SKILL.md
    captured_at: 1794911549152
    content_hash: cff10287240d8f455061e7b112d1ca779e250efa5e15a9ecbfbec8b1ec668414
  - source_id: s3
    source_type: file
    locator: skills/brainstorming/SKILL.md
    captured_at: 1794911549152
    content_hash: c8b9963caff313d573e6c808fb7718eccd049ad963962150a810fe7be41d6d84
  - source_id: s4
    source_type: file
    locator: Docs/api.md
    captured_at: 1794911549152
    content_hash: e147456d8eb1238ecd772d65a1491edc32fb21dd50fc6e80caad6ca1421b411c
  - source_id: s5
    source_type: file
    locator: packages/cli/src/issueRef.ts
    captured_at: 1794911549152
    content_hash: bb483055e5ab34bbf5a7a93f627261c0ba174eb7f8e3671500c4d3bccd305fd0
  - source_id: s6
    source_type: file
    locator: packages/cli/src/commands/listSpaces.ts
    captured_at: 1794911549152
    content_hash: 63b4b96be44cba189975564fc0cbbb2b309ddc9fe650a58a6a0fd1cc97794c03
  - source_id: s7
    source_type: file
    locator: packages/cli/src/commands/decision.ts
    captured_at: 1794911549152
    content_hash: 46580fd0c37ae97a061e63ee175035ea2fb6bfe53acbd9fa038c9ae26f1e57f5
  - source_id: s8
    source_type: file
    locator: packages/cli/src/commands/listTasks.ts
    captured_at: 1794911549152
    content_hash: 4a5558312a3045b19625aebea76cf947902046b4f3b620ce38bd40424df08fa8
evidence:
  - source_id: s1
    locator: "skills/using-agentboard/SKILL.md:14"
  - source_id: s1
    locator: "skills/using-agentboard/SKILL.md:113"
  - source_id: s2
    locator: "skills/swing-dev/SKILL.md:87"
  - source_id: s3
    locator: "skills/brainstorming/SKILL.md:226"
  - source_id: s4
    locator: "Docs/api.md:656-659"
  - source_id: s5
    locator: "packages/cli/src/issueRef.ts:143-159"
  - source_id: s6
    locator: "packages/cli/src/commands/listSpaces.ts:16"
  - source_id: s7
    locator: "packages/cli/src/commands/decision.ts:351-362"
  - source_id: s8
    locator: "packages/cli/src/commands/listTasks.ts:292-298"
content_hash: 70b72ce05e8215ce32e95c157f8fcd9993357c9dc3b8c8e42f9dab760cd15487
expires_at: null
created_at: 1794911586548
updated_at: 1794911586548
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 盲测报告的二次核验：前提、消费方、设计意图

## 为什么需要二次核验

盲测（不知道项目背景的 agent 照文档实操）产出的条目**默认不可直接采信，也不可直接判为真缺陷**。P6 实测 11 条的效果分布：

| 判定 | 条数 | 含义 |
| --- | --- | --- |
| 文档错，改文档 | 6 | 报告对了，改文档即可 |
| 文档漏字段/口径 | 3 | 报告方向对，但描述不精确（需实测确认漏的是什么） |
| **报告前提不成立** | 1 | 报的"不对等"实测不存在，是设计 |
| **代码错、文档对** | 1 | 报的现象真实，但归属判反了 |
| **收益为零，不该改** | 1 | 现象真实，但改动对目标无增益 |

约 **1/3 需要二次核验才能定性**（前提不成立 / 归属判反 / 收益为零）。直接照报告改，会引入两类错误：把正确的实现改成错的，或把文档改成与代码不符。

## 三类核验动作（按顺序，命中即停）

### 1. 核「前提」：报告说的现象真的存在吗

盲测的激励结构偏向"提交观察"，不核对自己读到的文档是否指向同一段代码。典型：报告说"`show` 与 `claim` 文案不对等"，实测两者走同一解析器、输出逐字相同。

核验方式：**造最小对照矩阵**，把报告的每个断言当作一行实测。

```powershell
# P6 第 10 条：把 id 形态作为变量，同一组输入跑两个命令
foreach ($r in @('8e2f4c9','abc','zzzz','00000000-0000-4000-8000-000000000000')) {
  kb show  $r 2>&1 | Out-String   # 与
  kb claim $r 2>&1 | Out-String   # 逐行对比
}
```

判据：**两个命令在同一输入上输出不同**才算"不对等"。都报"任务不存在"不是不对等。

### 2. 核「消费方」：改之前先扫谁在用

报告建议"改成 X"时，先扫现有形状的依赖方。**关键不是"有没有依赖"，而是"依赖的是不是可替换的东西"**。

```powershell
# 扫全仓消费方
Get-ChildItem packages,apps,scripts -Recurse -Include '*.ts','*.js','*.mjs' |
  Select-String -Pattern '\.decisions\b|\.items\b'
```

P6 第 5 条的实际发现分三层，价值递增：

1. `packages/cli/src/commands/decision.ts:351-362` 透传并对每条覆写 `capabilities` — 表层依赖
2. `apps/server/src/**/decisionApi.test.ts:262-331` 断言 `body.decisions[0]` — 测试依赖
3. **`counts` 是跨区逐区之和的核心载荷，`{items,next_offset}` 里没有它的位置** — 依赖的是不可替换的东西

第 3 层才是否决改动的理由。只看到第 1 层会说"有依赖，要同步改"（改动可行但成本高）；看到第 3 层才能说"改形状收益为零"。

### 3. 核「设计意图」：这是 bug 还是契约

报告把"我不理解的行为"记成缺陷。核验方式：**读实现，找那条分支的注释与命名**。

P6 第 10 条的根因：

```typescript
// packages/cli/src/issueRef.ts
const HEX_REF = /^[0-9a-f]{1,35}$/i;
export function isShortIssueRef(ref: string): boolean {
  return HEX_REF.test(ref.trim());
}
```

非十六进制串（`zzzz`）**不进前缀解析分支**，直接当完整 id 请求服务端 → 落"任务不存在"。1–7 位十六进制串才走"前缀至少 8 位"文案。这是"两种 id 形态"的设计，不是文案不一致。

判据：**能不能找到一条分支/常量/注释解释这个行为**。能找到 = 设计；找不到 = 缺陷。

## 归属判定表

报的现象为真时，还要判它该改文档还是改代码。P6 第 9 条是反例：报告说"`--all` 打错提示"，实测 `api.md:458` 已明确写"`--all` 跨区盘点同样适用缺省收敛"——**文档对，代码错**（`listTasks.ts:298` 无条件打印单区文案）。照着报告改文档会把正确内容改错。

| 实测现象 | 文档说 | 结论 |
| --- | --- | --- |
| 行为与文档不符 | 无相关描述 | 文档缺，补文档 |
| 行为与文档不符 | 有且正确 | **代码错**，报给该模块 owner |
| 行为与文档不符 | 有但过期 | 文档过期，改文档 |
| 行为与文档相符 | 有 | 不是问题，报告误判 |

## 「不改」的合格理由

拒绝修改时必须给**对目标零收益**的理由，不是"问题小"。

- ✗ 「这是小问题，不值得改」
- ✓ 「顶层 description 已含子命令摘要；`changelog` 有 6 个子命令，塞进顶栏只会拉长 help；对『照文档实操』零收益」

## 验证成本本身要计入证据

跑测试时若工作树有他人未提交的改动，测试结果不可信——**"跑了但结论不可用"不等于"验证过"**。同理，`kb done --scope` 必须只提交自己改的路径，否则会把他人在飞改动卷进本次提交。

诚实记录为"未验证"或"不可验证"，比跑一个掺入无关变量的测试更有价值。

## 证据

- `skills/using-agentboard/SKILL.md:14` — id 合法形态只有两种（P6 第 10 条补入）
- `skills/using-agentboard/SKILL.md:113` — `kb stats [--workspace <id>]` 可选（P6 第 8 条）
- `skills/swing-dev/SKILL.md:87` — close/done/fail 接受 ≥8 位前缀（P6 第 1 条）
- `skills/brainstorming/SKILL.md:226` — `--category` 缺省落 `open`（P6 第 2 条）
- `Docs/api.md:656-659` — 列表类信封 + `decisions` 特例单列（P6 第 5、6 条）
- `packages/cli/src/issueRef.ts:143-159` — `HEX_REF` 与非前缀透传分支（第 10 条根因）
- `packages/cli/src/commands/listSpaces.ts:16` — `--current` 只过滤后走统一信封（第 4 条）
- `packages/cli/src/commands/decision.ts:351-362` — `{decisions,counts,capabilities}` 的 shaping（第 5 条否决依据）
- `packages/cli/src/commands/listTasks.ts:292-298` — 无条件打印单区收敛提示（第 9 条，代码错）

