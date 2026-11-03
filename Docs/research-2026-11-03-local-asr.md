# 本地 ASR（语音输入）方案调研

日期：2026-11-03 · 需求卡：`[VOICE-INPUT] 看板输入框长按语音输入（本地模型，设置内开关与模型下载）`
范围：**只调研不实施**。所有版本/体积数字均为 2026-11-03 当日通过 npm registry、GitHub API、Hugging Face API 实际查询所得（命令可复现，见每节「证据」）；识别质量类断言若没有一手评测数据，一律标「未证实」。

## 0. 需求约束（来自卡面）

- 交互：按住输入框 **400ms 未拖动** 开始、松手结束；语言**跟随系统**；结果**插入光标处**。
- 模型**本地运行**、由用户**主动下载**、开关与下载都在**设置界面**。
- 项目既有约束：不新增前端依赖需先报批；本机 8787 由 `pnpm server:ensure` 常驻；已有 Docker 单容器镜像（`Dockerfile`，`node:22-bookworm-slim`，better-sqlite3 ^12.11.1）。

## 1. 候选表

| 候选 | 版本 / 许可证 | 中文质量证据 | 模型体积 | 首次联网 | 平台 / 运行要求 | 移植成本 | 验证状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A1** `@huggingface/transformers`（原 `@xenova/transformers`）+ Whisper ONNX | **4.3.2** / **Apache-2.0**（npm registry 直读） | **未证实**（无一手中文 CER；Whisper 多语模型支持 zh，但 tiny/base/small 的中文准确率需自测） | q8 版（encoder+decoder_merged_quantized）：tiny **≈39MB**、base **≈73MB**、small **≈238MB**；fp32：tiny≈144MB、base≈277MB、small≈923MB | 是（模型默认从 HF Hub 拉；可用 `env.localModelPath`/`allowRemoteModels=false` 改为本地目录） | 浏览器；WASM 默认可用；WebGPU 可选加速；多线程 WASM 需 cross-origin isolation（COOP/COEP）；Edge/Chrome 现代版本均可 | 低（纯 JS+WASM，无原生依赖、无构建工具链） | 体积/版本已核实；**识别质量、实时性未实测** |
| **A2** `sherpa-onnx`（WASM 包） | **2.0.1** / **Apache-2.0** | **未证实**；sherpa-onnx 生态提供中文专用模型（见下） | 中文模型：`sherpa-onnx-paraformer-zh-2024-03-09` int8 **216.8MB**（fp32 784.5MB）；`streaming-zipformer-bilingual-zh-en` int8 encoder **173.5MB** + decoder **12.5MB** | 是（模型需自行下载布置） | 浏览器 WASM（含流式识别）；WASM SIMD/线程同样受 COOP/COEP 限制 | 中（wasm 产物 + 模型布置 + 分词/标点后处理） | 体积/版本已核实；质量未实测 |
| **B1** `whisper.cpp` CLI（Windows 预编译） | GitHub `ggml-org/whisper.cpp`，近期构建标签 `b5454`；**MIT** | **未证实**（同上；ggml tiny/base/small 与 ONNX 同源权重） | ggml：tiny **74.1MB**、base **141.1MB**、small **465MB** | 是（模型文件需下载；二进制本身随包） | **有 Windows 预编译**：`whisper-bin-Win32.zip`（**5.3MB**，x64 CPU）、`whisper-bin-win-cpu-arm64.zip`（4.2MB）、CUDA 变体 271–653MB；**注意** 语义化标签 `v1.9.5` 的 release **0 资产**，预编译只在 `b<number>` 标签下 | 中（子进程管理、模型分发、音频重采样、日志/超时解析） | 资产名与体积已核实；未实跑 |
| **B2** `sherpa-onnx-node` | **2.0.1** / **Apache-2.0** | **未证实**（可用中文 paraformer/zipformer 模型） | 平台包：`sherpa-onnx-win-x64` unpacked **22.1MB**、`sherpa-onnx-linux-x64` **31.7MB**（模型另算） | 是（模型需下载） | Node 原生模块，但**以 `optionalDependencies` 分发预编译**（win-x64/win-arm64/linux-x64/linux-arm64/darwin 全有），**无 node-gyp 构建脚本** | 低-中（Node 侧直接 `Float32Array` 输入，无需 ffmpeg） | 平台包与包装方式已核实；未实跑 |
| **C** 浏览器原生 `SpeechRecognition`（`webkitSpeechRecognition`） | 浏览器内置，无包 | 中英文质量最好（云端模型） | 0 | — | **默认是服务端识别**：MDN 明确「audio is sent to a web service，won't work offline」；另有 on-device 模式，但依赖引擎/OS 能力（Windows 走系统听写），可用性未证实 | 极低 | 非本地（默认路径），**不满足需求** |

### 证据（可复现）

- npm registry 直读：`@huggingface/transformers` latest **4.3.2**、`license=Apache-2.0`；`sherpa-onnx` 与 `sherpa-onnx-node` 均 **2.0.1 / Apache-2.0**；`sherpa-onnx-node@2.0.1` 的 `optionalDependencies` 含 `sherpa-onnx-win-x64 / -win-ia32 / -win-arm64 / -linux-x64 / -linux-arm64 / -darwin-x64 / -darwin-arm64`，`scripts` 里**没有** install/node-gyp 步骤。
- GitHub API：`ggml-org/whisper.cpp` → 最新语义化 tag `v1.9.5`（2026-10-06，assets **0**）；构建标签 `b5454` 12 个资产，其中 `whisper-bin-Win32.zip` 5.3MB、`whisper-bin-win-cpu-arm64.zip` 4.2MB、`whisper-bin-win-cuda-12.4.0-x64.zip` 653.2MB；仓库 `license=MIT`。
- Hugging Face API（tree）：`onnx-community/whisper-tiny|base|small` 的 `onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_quantized.onnx` = 9.7+29.3 / 22.1+51.2 / 88+149.5 MB；`ggerganov/whisper.cpp` 的 `ggml-tiny.bin` 74.1MB、`ggml-base.bin` 141.1MB、`ggml-small.bin` 465MB；中文模型 `csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/model.int8.onnx` 216.8MB、`…streaming-zipformer-bilingual-zh-en-2023-02-20` int8 encoder 173.5MB + decoder 12.5MB。
- MDN《Using the Web Speech API》：「By default, using speech recognition on a web page involves a server-based recognition engine. Your audio is sent to a web service for recognition processing, so it won't work offline.」→ **C 案默认不是本地**。

## 2. 推荐方案

**推荐 B2（`sherpa-onnx-node`，8687/8787 服务端本地识别）+ 前端只负责采集与插入**，理由按权重排序：

1. **「本地 + 用户主动下载」在 B 案下是天然成立的**：模型文件落在服务端数据目录（与 `AGENTBOARD_DB` 同级的 `models/`），设置界面调 `POST /api/asr/models/:id/download`（流式进度）+ `GET /api/asr/status`，前端不碰权重文件，也不需要 COOP/COEP；A 案虽可 `allowRemoteModels=false` + `localModelPath`，但模型要么打进 Web 产物（体积爆炸，small q8 就 238MB），要么额外做静态托管与 Cache API/IndexedDB 缓存管理，反而更复杂。
2. **原生依赖风险可控**：`sherpa-onnx-node` 用 `optionalDependencies` 分发**预编译**包（win-x64 22.1MB），没有 node-gyp 编译步骤 → 与既有 `better-sqlite3`（也是 prebuild 下载）不冲突；两者都是 N-API 模块，同进程共存风险低（**未实测**）。
3. **不需要 ffmpeg**：前端用 WebAudio 采集并按 16kHz 单声道 `Float32Array` 分块（`AudioWorklet`）经 WS 上传，`sherpa-onnx-node` 直接吃采样数组；B1 的 whisper.cpp CLI 则要么写临时 WAV、要么喂 stdin，且要做子进程生命周期管理。
4. **中文可选专用模型**：paraformer-zh(int8 216.8MB) 或 streaming zipformer 中英混(int8 ≈186MB)，比 whisper small(465MB/238MB) 更贴合「中文短句听写」；**但质量需自测**（见第 3 节）。
5. **A 案仍保留为降级选项**：若产品要求「零服务端改动 / 纯离线浏览器」，A1（transformers.js + whisper-base q8 ≈73MB）是最小可行体积；代价是首次下载走 HF Hub（国内网络需镜像或自托管）、多线程 WASM 需要 COOP/COEP、Edge 上 WebGPU 表现未验证。

**「设置里下载模型」在两种方案下的落地差异**

| 关注点 | A（浏览器 WASM） | B（Node 本地，推荐） |
| --- | --- | --- |
| 下载动作 | 页面内 `fetch` 权重 → `caches`/IndexedDB 缓存；需自建进度与校验（sha256） | 服务端 `fetch` 到 `<data>/models/<id>/`，进度用 SSE/WS 推送；天然可复用 curl/断点续传 |
| 存储位置 | 浏览器 profile（换浏览器/清缓存即丢） | 数据卷（Docker 挂 `/data` 即随卷持久化） |
| 多客户端 | 每台机器各下一次 | 一次下载，局域网各端共用 |
| 体积对产物的影响 | 若内置则 Web 产物暴涨（small q8 238MB）；外置则需静态托管 | 与 Web 产物无关；Docker 镜像 +22.1MB(win)/+31.7MB(linux) 原生包 + 模型卷 |

## 3. 风险与未验证项

**未验证（必须实测后才能对外声称）**

1. **中文识别质量**：本机没有中文语音样本集，也没有跑过任何模型 → tiny/base/small 与 paraformer/zipformer 的中文 CER **全部未证实**。落地前需自建 20–50 条真实任务描述语音（覆盖中英混、专有名词、数字），逐模型算 CER，再决定默认模型与「够不够用」的结论。
2. **实时性/延迟**：A 案 WASM 在 Edge 上的解码速度、B 案 Node 侧 RTF（实时率）均未测；长按录 3–10s 的常见长度需要 p95 延迟数据。
3. **浏览器能力**：WASM 多线程需 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`（会影响现有 8787 页面与静态资源，需评估）；WebGPU 在 Edge 的可用性与功耗未测。
4. **原生模块共存**：`sherpa-onnx-node` 与 `better-sqlite3` 同进程未实测（理论都是 N-API，风险低但没证据）。
5. **Web Speech API 的 on-device 路径**：MDN 提到可指定 on-device 识别，但 Edge/Windows 上是否可用、是否真离线、中文质量如何 **未证实**；默认路径已明确走云（不能作为「本地」方案）。
6. **模型许可与再分发**：whisper 权重（MIT/见模型卡）、paraformer/zipformer 权重（Apache-2.0，需逐模型卡确认）在「随产品分发」与「用户下载」两种模式下的义务未逐项核对。
7. **Docker**：镜像增量只算了原生包（+31.7MB linux）；若把默认中文模型打进镜像则再 +186~217MB，是否接受需产品定；不打包则首启需联网下载。

**工程风险**

- 交互与输入法冲突：长按 400ms 与移动端「长按选择文本」、桌面右键菜单、拖拽选区互相干扰，需要 pointer 事件 + `touch-action`/`user-select` 细节设计（未设计）。
- 光标插入：`textarea`/`input` 的 `selectionStart/End` 在 React 受控组件里需保留并恢复；跨输入框（详情面板、评论框、新建弹窗、搜索框）要统一封装，否则行为不一致。
- 语言跟随系统：`navigator.language` 只给 BCP-47 标签（`zh-CN`），ASR 语言选择还要映射到模型（whisper 用 `language=zh`，paraformer 为中文专用）；混说中英时是否强制单语需实测。
- 权限与首次使用：麦克风权限被拒、设备无输入、系统静音三种失败态都要可读提示（不要在长按后静默失败）。

## 4. 下一步建议（本卡之外）

1. 先做 **B2 最小验证**：装 `sherpa-onnx-node` + 一个 int8 中文模型，用 20 条真实语音算 CER 与 RTF；同时验证与 better-sqlite3 同进程。
2. 并行做 **A1 对照**：transformers.js + whisper-base q8，只测同一批样本的 CER 与浏览器端耗时（判断「服务端方案是否值得」）。
3. 两项数据出来后，再决定：默认模型、是否内置模型、设置页下载流的协议（SSE vs WS）、以及长按交互的最终细节。
