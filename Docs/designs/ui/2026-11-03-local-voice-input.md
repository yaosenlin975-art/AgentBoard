# 本地语音输入（长按说话）
- status: proposed
- date: 2026-11-03
- card: -
- supersedes: -

状态：已定方案（B：本地服务端跑模型），待实现。

## 需求（用户口径）

1. 看板**所有输入框**支持鼠标**长按语音输入**。
2. 触发：在输入框内按住 **400ms 且期间未拖动**开始录音，**松手结束**；按下即拖动=文字选择，不触发。
3. 语言：**跟随系统语言**（`navigator.language` → `zh-CN` / `en-US` 等，映射到模型可选语言；模型不支持该语言时提示可切换）。
4. 结果：**直接插入光标处**（有选中文本则替换），可 `Ctrl+Z` 撤销。
5. **本地模型**：不调云端；模型由用户在设置里**主动下载**；**功能开关**与**模型下载**都在设置界面。

## 选型（已定 B）

`sherpa-onnx-node` 2.0.1（Apache-2.0，win-x64 预编译 22.1MB，`optionalDependencies` 分发，无 node-gyp）跑在服务端进程；模型落 `<data-dir>/models`（与 DB 同源派生，容器只挂 `/data`）。

- 浏览器只负责采集：`AudioWorklet` → 16kHz 单声道 Float32 分块 → WebSocket 上行；**不需要 ffmpeg**。
- 候选模型（用户自行选择下载，**不预置、不自动下载**）：
  - `sherpa-onnx-streaming-zipformer-bilingual-zh-en-int8`：中英混说，推荐默认项；int8 三个 onnx 合计 198,214,476 B（encoder 181,895,032 + decoder 13,091,040 + joiner 3,228,404）+ tokens.txt 56,317 B（GitHub 归档为 511,274,346 B）
  - `sherpa-onnx-paraformer-zh-int8`：中文更强，非流式；`model.int8.onnx` 243,371,218 B + tokens.txt 75,756 B（GitHub 归档为 234,051,698 B）

> VOICE-5 决策（2026-11-03）：**改为按文件从 HuggingFace 下载，不下载 tar.bz2 归档**。原因：GitHub release 两个归档的 `digest` 字段为 null（上游没发布 sha256），只能验大小；而 HF 每个 onnx 都有 LFS sha256（已写入 `packages/shared/src/voiceModels.ts` 并固定 revision），校验强度更高、可逐文件续传、零解包零新增依赖。`tokens.txt` 上游只发 git blob（无 sha256）→ 用弱校验（字节数 + 内容非空 + 首行含空格或 `<`），代码与 `Docs/api.md` 均标注为弱校验。
- 备选（不采用，仅记录）：`@huggingface/transformers` 4.3.2 + Whisper ONNX（浏览器 WASM，模型进浏览器缓存、多线程需 COOP/COEP）。

**未验证**：中文识别质量（CER/RTF）、sherpa-onnx-node 与 better-sqlite3 同进程共存、流式延迟。上述需真实语音样本，本机不下载模型，故未测。

## 服务端

### 模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/voice/models` | 候选清单 + 本地状态（`downloaded`/`bytes`/`sha256` 校验结果），不返回下载地址以外的敏感信息 |
| POST | `/api/voice/models/:id/download` | 开始下载（202）；同 id 重复调用幂等复用进行中的任务 |
| GET | `/api/voice/models/:id/progress` | SSE 进度（`bytes`/`total`/`state`/`error`）；也支持轮询 `?poll=1` |
| DELETE | `/api/voice/models/:id` | 删除已下载模型（占用中拒绝 409） |

- 目录：`dirname(db)/models/<model-id>/`；下载到 `.part` 再原子改名，校验大小与 sha256 后标记 `downloaded`。
- 失败：网络中断/空间不足/校验不符 → 明确错误码（`VOICE_DOWNLOAD_FAILED`/`VOICE_NO_SPACE`/`VOICE_CHECKSUM_MISMATCH`），保留 `.part` 供续传或清理。
- **不自动下载**：任何情况下不在启动或首次使用时偷偷拉模型。

### 识别会话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/voice/session` | 创建识别会话（body: `{ model_id?, language }`）→ `{ session_id, sample_rate: 16000 }`；模型缺失 → 409 `VOICE_MODEL_MISSING` |
| WS | `/api/voice/session/:id` | 上行二进制帧（16k mono Float32/Int16），下行 JSON 事件 `partial` / `final` / `error` |
| POST | `/api/voice/session/:id/stop` | 结束会话，返回最终文本（WS 不可用时的回退路径） |

- 单进程内**串行**使用识别器（同一时间一个识别任务），其它请求排队并给 `queued` 事件；并发上限 1 可配。
- 会话空转 15s 自动关闭。

## 前端

### 长按手势（统一封装）

- 新增 `useLongPressVoice(targetRef)` / `<VoiceInput>` 包装器，**不逐个输入框复制实现**。
- 判定：`pointerdown` 起计时 400ms；期间 `pointermove` 位移 > 6px 或 `pointerup` 提前 → 取消，让原生选择照常工作；计时到点才 `navigator.mediaDevices.getUserMedia({ audio })`。
- 录音中：输入框保持焦点，显示小状态条（`正在听…` + 音量条 + `松手结束`），`pointerup`/`pointercancel`/`Escape` 结束；指针移出输入框（`pointerleave`）**不结束也不取消**，否则手抖/浮层遮挡会让转写白录。
- 插入：把 `final` 文本插入 `selectionStart`（有选择则替换），派发一次 `input` 事件保持受控组件同步，并 `setSelectionRange` 落在插入文本末尾。
- 撤销：一次插入作为一个连续编辑，`Ctrl+Z` 可整体回退（用 `document.execCommand('insertText')` 或原生 setter + `input` 事件，实现时在卡里说明选择理由）。

### 接入范围

搜索框、新建任务标题/描述、评论框、聊天输入、知识页编辑器、标签输入、截止日期旁的自由文本等**所有 `input[type=text/search]`、`textarea`、`contenteditable`**，通过统一包装器接入；`type=date/checkbox` 等非文本控件不接。

### 设置界面

「语音输入」分区：总开关（默认关）、语言（跟随系统 / 手动指定）、模型列表（名称、体积、状态、下载按钮、进度条、删除）、占用空间合计、权限说明与「检测麦克风」按钮。

### 错误态（必须有中文可读文案）

`VOICE_MODEL_MISSING`（去设置里下载模型）、`VOICE_PERMISSION_DENIED`（浏览器麦克风权限被拒，如何解除）、`VOICE_NO_DEVICE`（未检测到麦克风）、`VOICE_UNSUPPORTED`（浏览器不支持 AudioWorklet/WS 时隐藏入口或提示）、`VOICE_NO_SPEECH`（转写为空，提示靠近麦克风重试）、`VOICE_INSERT_FAILED`（识别成功但目标输入框已丢失/不可插入）。后两者不得静默丢弃。

## 验收

- 长按 400ms 未拖动 → 开始录音（`getUserMedia` 被调用 1 次）；按住后拖动 > 6px → **不**触发且能正常选择文字。
- 无模型时：长按给出 `VOICE_MODEL_MISSING` 引导，不静默失败。
- 下载流程：进度事件序列单调递增、完成状态为 `downloaded`、sha256 校验通过；中断后 `.part` 保留且可续。
- 设置开关关闭后，长按**不**触发任何录音。
- 插入位置正确（光标处/替换选中），`Ctrl+Z` 一次回退整段。
- **未验证（本轮）**：真实中文识别质量（无模型）、流式延迟、多客户端并发。

## 非目标

- 不做唤醒词、不做常驻监听、不做云端识别、不做说话人分离。
- 不预置模型、不在安装/首次使用时自动下载。
