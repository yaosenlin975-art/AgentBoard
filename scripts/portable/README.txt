AgentBoard 便携版（Windows x64）
===============================

不需要安装 Node.js：包内自带 Node 运行时（runtime\node.exe，MIT 许可）。
包内同时携带配套工作流规则（app\rules\），对方的 agent 可按同一套流程作业。

一、怎么启动
------------
1. 把整个 AgentBoard 文件夹解压到任意可写目录（例如 D:\AgentBoard）。
   不要直接在 zip 里双击运行，必须先解压；也不要解压到以“.”开头的隐藏目录。
   覆盖解压（升级）是安全的：数据不在包内，见第二节。
2. 双击 start.cmd（推荐）：打开独立桌面窗口，无浏览器标签页。
   需要系统已安装 Microsoft Edge WebView2 Runtime（Windows 11 自带，Windows 10 多数已随
   Edge 安装）。缺失或桌面壳起不来时，脚本会给出明确提示，并自动退回
   “前台起服务 + 默认浏览器”模式，不会让用户完全用不了。
3. 需要前台看日志 / 排障时，用旧版前台模式：双击 start-server.cmd，或命令行执行
   start.cmd server（行为与旧版 start.cmd 一致：控制台窗口 + 手动打开浏览器）。
   也可以在命令行指定端口：start.cmd 8899（等价于 start-server.cmd 8899）
   （start-desktop.cmd 是兼容别名，等价于不带参数的 start.cmd）
4. 浏览器打开 http://127.0.0.1:8787 （或你用 start.cmd 指定的端口）。
5. 停止服务：
   桌面窗口：点关闭 = 收进系统托盘（服务继续跑）；右键托盘图标 →「退出」= 停服并释放单例锁。
   前台模式：关闭那个黑窗口，或在窗口里按 Ctrl+C。

首次启动会自动建库、自动执行数据库迁移，不需要任何登录或初始化操作。

二、数据存在哪
--------------
默认全部在 %APPDATA%\AgentBoard\ 下（即 C:\Users\<你>\AppData\Roaming\AgentBoard）：
  agentboard.db          主数据库
  attachments\           附件
  config.json            端口等设置
  logs\server.log        服务日志

换机器/换目录不影响数据；卸载时删掉这个文件夹即可（不可恢复）。
不要把这个数据目录放进网盘同步或同时被两个进程使用。

三、首次要配什么
----------------
基本不用配。打开页面后：
  - 新建工作区（工作区路径必须是一个已存在的目录）；
  - 或在命令行用 kb 创建（见第五节）。
可选设置：设置页里可改端口、并发数、附件配额等（写入 config.json）。
环境变量可临时覆盖：AGENTBOARD_PORT、AGENTBOARD_DB、AGENTBOARD_HOST、AGENTBOARD_LOG。

四、携带的规则（让对方的 agent 按同一套工作流作业）
--------------------------------------------------
包内 app\rules\ 固定携带：
  AGENTS.md                    项目规则索引（权威文档优先级）
  README.md                    本仓库 README（运行/端口/构建口径）
  Docs\api.md                  HTTP API 与 CLI 契约（含退出码）
  skills\using-agentboard\     看板工作流唯一权威（工作区边界、kb 命令速查）
  skills\writing-task\         拆卡 / 建卡
  skills\executing-task\       执行已派卡
  skills\handoff\              交接
  skills\swing-dev\            机动巡检
  ../rules-manifest.json       文件清单 + sha256（自检依据）

安装到对方机器（两种方式，二选一）：
  A. 复制到 agent 的技能目录：
     把 app\rules\skills\* 复制到 %USERPROFILE%\.agents\skills\
     把 app\rules\AGENTS.md 复制到 AgentBoard 工作区的根目录（或 agent 全局规则目录）
  B. 不复制，直接指定技能根：
     set AGENTBOARD_SKILL_ROOT=<解压目录>\app\rules\skills
     （using-agentboard 会按该变量解析权威文档；工作区仍按 cwd\skills 优先）

自检：双击 check-rules.cmd，或执行 runtime\node.exe app\verify-rules.mjs。
输出 [rules] OK：<文件数> 个文件，5 个技能，kb --help 可用，退出码 0；
缺文件、内容被改（哈希不符）或 kb --help 失败时退出码 1 并逐条列出。

五、怎么用 CLI（kb）
--------------------
包内自带 CLI：app\cli\kb.cmd
  app\cli\kb.cmd --help                     查看全部命令与退出码
  app\cli\kb.cmd list-spaces
  app\cli\kb.cmd create-space 我的项目 D:\work\myproject
  app\cli\kb.cmd --server http://127.0.0.1:8899 list-spaces   (服务不是默认端口时)
  app\cli\kb.cmd knowledge --help / create-issue --help / dep --help   分族帮助
注意：kb 的全局选项（--server / --json）要放在子命令前面。
kb claim 成功会在“当前工作目录”下写 .agentboard\claims\ 记录，属于本地状态，可随时删除。

六、已知限制
------------
- 桌面入口固定使用 8787（壳内置按 8787 探活），会覆盖 config.json 里的自定义端口；
  需要换端口请用前台模式：start.cmd 8899（或 start-server.cmd 8899）。
- 桌面入口依赖系统的 WebView2 Runtime，包内不携带该运行时；缺失时给出提示并退回浏览器模式。
- 端口被占用时服务会启动失败：改用 start.cmd 8899 换端口，或先释放 8787。
- 同一台机器、同一 %APPDATA% 只允许一个实例（单例锁）。要多开：复制一份 APPDATA 指向不同目录，
  再配合不同的 AGENTBOARD_DB 与端口。
- 语音识别：内置了 sherpa-onnx 原生模块，但仍需在界面里下载模型后才能用；模型不在包内。
- 账户 / 秘书类功能依赖本机已安装的对应客户端（WorkBuddy、MiniMax 等）及其路径；
  凭据导出功能还需要本机 Python 与仓库里的 scripts\accounts 脚本，本包未附带，会不可用。
- kb autostart / kb shortcut 依赖原仓库的目录结构，便携包内不支持。
- 仅支持 Windows x64。
