# Board UI 验收进度（2026-11-02）

## DND01

- 文件：`apps/web/src/components/board/Board.tsx`、`IssueCard.tsx`、`apps/web/src/test/board.test.tsx`
- 实现：用 dnd-kit `DragOverlay` 将卡片预览 portal 到 `document.body`，复用卡片展示体；拖动开始时读取卡片宽度，取消和放下时清理预览。原排序、占用禁拖及失败回滚逻辑未改。
- 定向验证：`pnpm --filter @agentboard/web exec vitest run src/test/board.test.tsx`，16/16 通过。新增键盘拖动测试验证预览脱离 Board 容器，取消后预览移除。
- 待验收：真实指针跨列、列内、横纵滚动、拖动取消及窄屏无遮挡。

## SIDEBAR01

- 文件：`apps/web/src/App.tsx`、`apps/web/src/test/App.test.tsx`
- 实现：侧栏总宽在 260px 与 40px 控制轨间过渡，工作空间列表左滑；flex 主区同步释放空间。控制按钮始终保留，折叠内容设为 `aria-hidden` 和 `inert`，动画支持 `prefers-reduced-motion`；保留移动端工作空间选择器。
- 定向验证：`pnpm --filter @agentboard/web exec vitest run src/test/App.test.tsx`，2/2 通过。验证宽度、控制按钮焦点、折叠内容不可聚焦及 reduced-motion 类。
- 待验收：展开、中途、收起无覆盖；快速连续切换、窗口缩放、键盘及 390px 窄屏。

## PANEL-MOTION01

- 文件：`apps/web/src/components/right/RightPanel.tsx`、`apps/web/src/test/RightPanel.test.tsx`、`apps/web/src/test/chat.test.tsx`、`apps/web/src/test/unreadCollector.test.tsx`
- 实现：右面板宽度与内容平移同步收放；面板在窄视口受 `100vw - 40px` 限制；聊天与详情实例持续挂载，非活动视图和收起面板使用 `aria-hidden`、`inert`，切视图/收放后恢复焦点。拖宽期间关闭 width transition 保持跟手，释放后恢复收放过渡及原宽度持久化。
- 未读核查：`unreadCollector` 是独立的 wsBus 订阅，不依赖 ChatPanel 挂载；只有用户选择会话时 `openChat` 清零。收起期间 ChatPanel 不触发该动作，未读测试验证原未读保留、新消息递增、展开后手动切换会话再清零。
- 定向验证：`pnpm --filter @agentboard/web exec vitest run src/test/RightPanel.test.tsx src/test/App.test.tsx src/test/chat.test.tsx src/test/detail.test.tsx src/test/unreadCollector.test.tsx`，5 个文件、58/58 通过。专属测试覆盖拖宽即时响应、pointerup 恢复动画及宽度持久化。
- 待验收：真实聊天/详情切换与收放、流式内容、草稿及焦点恢复、拖宽、窄屏与 reduced-motion。

## 共享验收

- 三项此前均已领取并完成定向自验；用户统一释放后，父代理重新只分配 PANEL-MOTION01。DND01 与 SIDEBAR01 未重新领取。
- 未运行 web build，未启动或重启服务；等待父代理统一冻结后运行共享 build 与真实浏览器验收。
- 浏览器验收未完成前，PANEL-MOTION01 保持领取，不标记待验收。
