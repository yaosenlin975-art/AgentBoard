---
id: bcdb3a62-fd3e-4195-b52d-0d0093979273
slug: parallel-full-suite-not-a-gate
title: "并行全量测试不可作门禁：隔离复跑区分真失败与负载敏感"
revision: 10
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: infra
category: design
landed: landed
sources:
  - source_id: "file:apps/server/test/graphPerf.test.ts"
    source_type: file
    locator: apps/server/test/graphPerf.test.ts
    captured_at: 1794910931604
    content_hash: 437c6d49ab6b6ba34d4ebaf6d1a2ad8aa49d773de60f6aa335d5ba6fbd626043
evidence:
  - source_id: "file:apps/server/test/graphPerf.test.ts"
    locator: apps/server/test/graphPerf.test.ts
content_hash: 9bc1bf894dcfc83120763a671a733a618ecb67ca88389479e277fd2884ad13b8
expires_at: null
created_at: 1794910931741
updated_at: 1794912796797
created_by: kb-cli
updated_by: kb-cli
change_note: "rename cli-consistency-probe → parallel-full-suite-not-a-gate"
---

## 结论

`vitest run` 全量并行跑出的红绿**不可作为门禁判据**。必须对每个失败文件做**隔离复跑**，才能区分「真失败」与「并行负载敏感」。

## 实测数据（apps/server，197 个测试文件）

| 跑法 | 失败 |
|---|---|
| 全量并行 | `37 failed / 160 passed`，`65 failed / 1823 passed`（用例级） |
| 逐个隔离复跑 | **真实失败 5 个**，其余 32 个文件全绿 |

同一份代码、同一台机器，两个数字差 13 倍。原因不是代码坏了，是并行时机器负载改变了计时与调度。

## 哪些用例在并行下必红

两类：

**1. 计时断言（性能预算守卫）**
```
graphPerf: 24 页 <200ms、200 页 <800ms
```
并行时 CPU 被其它 worker 抢占，断言必然超时。**隔离复跑连跑 3 次全绿。**

**2. 时间戳/排序断言**
```
workspaceOrder: getWorkspacesOrdersBySortOrderThenCreatedAt
```
依赖 `created_at` 的相对顺序，并行时同一毫秒内创建多个对象 → 排序不稳定。**3 次复跑中 1 次红。**

## 正确的失败归因流程

1. 全量跑，收集 `FAIL` 行提取文件清单
2. 对每个文件**单独** `vitest run test/<file>.test.ts`
3. 隔离仍红 → 真失败，继续查根因
4. 隔离转绿 → 负载敏感，记录但不修

样本量提醒：`workspaceOrder` 这类抖动型要**复跑 3 次**才能定性，单次绿不能证明稳定。

## 对 CI 的启示

若要拿测试当门禁：

- 性能预算类断言应在**串行/独占**环境跑，或放宽阈值到并行下的可信区间
- 时间戳排序断言应改成不依赖真实时钟（注入固定 `now`）
- 「全量绿」这个目标本身可能不现实——先测出清单，再决定哪些是可信门禁

## 相关判例

同一轮里 `knowledgePerfC2C3` 全量时 4 failed，隔离 6 passed。若当时按全量结果去「修」，就会给没问题的代码打补丁。这与「卡面假设可能错，证伪比照做有价值」是同一类问题：**测量方式本身有偏差时，照偏差结果修只会制造新缺陷。**

