# 智能创建执行方式补 CodeBuddy（c9505527）

日期：2026-11-04 · 卡：`c9505527-f35e-499a-943f-00dbb1a11b0c` · 父卡 `935fc96a`

## 1. 服务端是否已接受 codebuddy：**未接受（两处）**

| 位置 | 现状 |
|---|---|
| `apps/server/src/api/schemas.ts:117` | `adapter: z.enum(['dsh', 'codex', 'opencode'])` —— `codebuddy` 会被 zod 直接 **400** |
| `apps/server/src/services/smartCreateDraft.ts:15` | `DRAFT_ADAPTERS = ['dsh', 'codex', 'opencode']` —— 服务端 id 白名单同样缺一个 |

命名一致：`/api/clis` 的 id 是 **`codebuddy`**（不是 `codebuddy_desktop`）；`/api/clis` 实测四项全可用（`codebuddy:2.179.2`、`codex:codex-cli 0.166.0`、`opencode:v2.2.5`、`dsh:0.2.1-rc.5`）。

**服务端改动已交 board-server**（不属本卡范围，未触碰）。

## 2. 前端改动

- `apps/web/src/lib/smartDraft.ts:12,19`：`DRAFT_ADAPTERS` 增加 `'codebuddy'`，`ADAPTER_LABEL.codebuddy = 'CodeBuddy'`。
- `apps/web/src/components/topbar/NewIssueDialog.tsx`：
  - `:185-186` 新增 `selectedCli` / `adapterUnavailable`（**按 `/api/clis` 实时判断**，`installed === false` 才算不可用；列表未返回时不误伤）。
  - `:364` 不可用的执行方式在 `<option>` 上 **disabled**（点不到），文本追加「（本机不可用）」。
  - `:375` 提示文案改为「请先在设置里安装/登录该 CLI，或换一个执行方式」。
  - `:561` 「生成草稿」按钮 `disabled={requirement.trim() === '' || adapterUnavailable}`。
- 失败态沿用既有 502/422/504/503 文案体系，未新增错误码。

## 3. 真机证据（5174，1440×900）

```
/api/clis      → codebuddy:true:2.179.2 / codex:true:codex-cli 0.166.0 / opencode:true:v2.2.5 / dsh:true:0.2.1-rc.5
执行方式下拉    → dsh(可用) / codex(可用) / opencode(可用) / codebuddy(可用，text="CodeBuddy")
选中 codebuddy → adapter=codebuddy，需求为空时「生成草稿」disabled（缺需求，符合预期）
真实点一次生成 → smart-message = 「请求参数不合法：adapter: 取值必须是：dsh / codex / opencode」
                 回退手动表单（aria-selected=true），需求原文保留在描述里
console error  → 0
```

即：**前端已就绪**，失败态可读且不静默；等 board-server 扩完 enum 后即可真实生成。

## 4. 测试

- `apps/web/src/test/smartCreate.test.tsx`
  - 新增「执行方式含 CodeBuddy + 按 /api/clis 实时判断可用性（不可用禁用 + 给原因）」；
  - 新增「所选执行方式不可用 → 生成按钮禁用并显示原因」；
  - 旧「dsh 不可用」用例改为断言 **option disabled** + 强制历史选中时仍有提示；
  - 「三种错误码」用例补 `/api/clis` mock 并调整 msw 注册顺序（先注册后 render，否则首帧查询拿到默认全 false 列表会把生成按钮禁掉）。
- `smartCreate.test.tsx` → **8 passed**。
- **变异 RED**：把 `adapterUnavailable` 恒置 `false` → 「所选执行方式不可用」用例红（`expect(element).toBeDisabled()`），还原后 8/8。

## 5. 门禁

- 全量 `pnpm --filter @agentboard/web test` → **741 passed / 2 failed**：基线 `knowledge.test.tsx` + `detail.test.tsx` DispatchDialog（他线在飞）。
- `npx vite build` → **exit 0**（636ms）。

## 6. 未验证 / 待办

- **真实生成草稿（codebuddy）**：服务端 enum 未扩，目前稳定 400；等 board-server 的 `schemas.ts` + `smartCreateDraft.ts` 扩值后补一次真实调用（注意额度）。
- 服务端扩值后需同步确认：`codebuddy` 在 `smartCreateDraft` 的 adapter 分支里能正确 `getAdapter('codebuddy')` 并跑通 120s 超时与重试逻辑。
