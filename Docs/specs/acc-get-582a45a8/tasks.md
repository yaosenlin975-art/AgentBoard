# ACC-GET（582a45a8）任务清单

- [ ] T1 `accountRoutes.ts`：`DesktopProvider` 放宽为可选方法 + `requireProvider` 按 capture/switch 重载；缺失方法返回 503
- [ ] T2 `index.ts`：`desktopProviders` 类型同步；缺省装配 `TraeDesktopProvider`
- [ ] T3 `traeProvider.ts`：抽出 `readTraePayload`（原文仅进程内）；新增 `jwtSubject` 与 `TraeDesktopProvider.captureCurrent`（identity 去重、vault checkin、审计）
- [ ] T4 `credentialImport.ts`：导出 `createDefaultExportRunner`（行为不变）
- [ ] T5 新建 `workbuddyCheckinSource.ts`：插件线明文 JWT（按 `sub` 匹配 identity_hash）→ 导出脚本兜底
- [ ] T6 `workbuddyDesktopProvider.ts`：捕获时解析 token、写 `checkin` vault、回填 `checkin_credential_ref`/capability；取不到则 `CHECKIN_CREDENTIAL_UNAVAILABLE` 并清理快照
- [ ] T7 `operationRunner.ts`：补固定 safe 错误码
- [ ] T8 测试：`fakeWorkbuddy.ts` 注入 token source；WorkBuddy 捕获/回填/失败/无明文；Trae 捕获/幂等/无明文；API 200；平台矩阵
- [ ] T9 验证：定向 server 测试 + `pnpm --filter @agentboard/web build` + 全量测试（标注基线）
- [ ] T10 提交（信息含 `582a45a8`）、`git show --stat` 核对、`kb done` 置「待验收」+ 评论回填哈希与未验证项
