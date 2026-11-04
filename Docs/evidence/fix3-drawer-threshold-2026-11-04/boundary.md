# FIX-3 边界补验：767 / 768 / 769

环境：5174 dev + Edge headless（CDP 9333），`Emulation.setDeviceMetricsOverride` 精确设宽；每档点 `topbar-accounts` 打开抽屉后读数。
判定口径（设计 §4）：**≥768 挤压、<768 覆盖** → 768/769 必须 squeeze，767 必须 overlay。

## 数值

| 视口宽 | `matchMedia('(min-width:768px)')` | `data-mode` | 主区宽 | panel rect | 遮罩 | `body.overflow` | scrollW / clientW |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 767 | **false** | **overlay** | 591 | x=367 w=400 | **有** | **hidden** | 767 / 767 |
| 768 | **true** | **squeeze** | 192 | x=368 w=400 | 无 | `''` | 768 / 768 |
| 769 | **true** | **squeeze** | 193 | x=369 w=400 | 无 | `''` | 769 / 769 |

## 结论

- 边界行为与设计 §4 一致：`(min-width: 768px)` 命中 768/769（挤压），767 落到覆盖（遮罩 + 锁滚动）。
- **未改实现**：`DRAWER_SQUEEZE_MIN_WIDTH = 768` 与 `matchMedia` 语义天然给出「768 含在内」，无需额外修正。
- 三档 `scrollWidth == clientWidth`，窄屏无横向溢出；覆盖态 panel 宽 400 < 视口 767，`maxWidth: 100vw` 未触发（<768 更窄视口时才截断，已在 375 档验证为 w=375）。

## 截图

`boundary-767.png` / `boundary-768.png` / `boundary-769.png`（另附 `boundary.json` 原始读数）。

## 未验证

- 整 768 宽下的键盘操作（Tab 顺序、Esc 关抽屉后焦点回归）未逐一复测，仅验两态判定与布局数值。
