# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [Unreleased]

### Fixed

- Windows Electron 安装后无法启动：`app.on("ready")` 中 `setPaths` 导入等步骤无 try-catch，失败时静默退出无任何报错 — 现在包裹全局 try-catch + 错误对话框
- NSIS 安装无向导：`oneClick: true` 改为 `oneClick: false` + 允许选择安装目录
- 桌面端 UI 静态资源路径错误：`serveStatic` 使用硬编码相对路径 `"./public"`，Electron 打包后 `process.cwd()` 不是应用目录导致 404 — 改为绝对路径；`/desktop/assets/*` 路由增加 `rewriteRequestPath` 去除 `/desktop` 前缀
- Tray 图标路径在打包模式下可能找不到：改用 `app.getAppPath()` 定位 asar 内的图标，并将 `electron/assets/` 加入打包文件列表
- macOS 无法退出应用：窗口关闭处理器无条件 `preventDefault()` 导致 Dock/菜单栏的 Quit 被拦截 — 添加 `isQuitting` 标志 + `before-quit` 事件处理
- 退出时服务器关闭可能永久挂起：Tray Quit 添加 5 秒超时强制退出（与 CLI 的 10s 对齐）
- macOS 签名：移除 `identity: null` 和 `CSC_IDENTITY_AUTO_DISCOVERY=false`（它们会完全跳过签名导致"应用已损坏"），改为依赖 electron-builder 默认 ad-hoc 签名（`codesign -s -`），用户右键→打开即可运行

### Added

- 桌面端 UI 独立重设计：`desktop/` 目录包含全新原生风格组件，macOS 和 Windows 通过 CSS 变量（`platform-mac` / `platform-win`）呈现各自系统风格（圆角、阴影、暗色配色），与 web 端 UI 完全独立
- 共享逻辑层 `shared/`：hooks（use-accounts、use-status）、i18n、theme、utils、types 从 web 端抽取为共享模块，web 和 desktop 零重复代码
- `/desktop` 路由：Hono 后端新增桌面 UI 静态服务路由，Electron 加载 `/desktop` 而非 `/`，浏览器访问 `/` 仍为 web 端
- Electron 桌面应用：下载安装即用，无需 Node.js 环境；系统托盘常驻，窗口加载 Dashboard，OAuth 链接自动在默认浏览器打开
- 路径抽象层（`src/paths.ts`）：集中管理 config/data/bin/public 路径，CLI 模式默认 `process.cwd()`，Electron 模式通过 `setPaths()` 重定向到用户数据目录
- `startServer()` 导出：`src/index.ts` 提取核心启动逻辑为可复用函数，CLI 和 Electron 共用，返回 `{ close, port }` handle
- esbuild 构建链：Electron 主进程打包为单个 CJS 文件（`dist-electron/main.cjs`），规避 ESM+asar 兼容问题
- electron-builder 打包配置：支持 Windows (NSIS)、macOS (DMG)、Linux (AppImage)
- Reasoning/Thinking 输出支持：始终向 Codex API 发送 `summary: "auto"` 以获取推理摘要事件；OpenAI 路由在客户端发送 `reasoning_effort` 时以 `reasoning_content` 输出；Anthropic 路由在客户端发送 `thinking.type: enabled/adaptive` 时以 thinking block 输出；未知 SSE 事件记录到 debug 日志以便发现新事件类型
- 图片输入支持：OpenAI、Anthropic、Gemini 三种格式的图片内容现在可以正确透传到 Codex 后端（`input_image` + data URI），此前图片被静默丢弃
- 每窗口使用量计数器：Dashboard 主显示当前窗口内的请求数和 Token 用量，累计总量降为次要灰色小字；窗口过期时自动归零（时间驱动，零 API 开销），后端同步作为双保险校正
- 窗口时长显示：从后端同步 `limit_window_seconds`，AccountCard header 显示窗口时长 badge（如 `3h`），重置时间行追加窗口时长文字
- Dashboard 账号列表新增手动刷新按钮：点击重新拉取额度数据，刷新中按钮旋转并禁用；独立 `refreshing` 状态确保刷新时列表不清空；标题行右侧显示"更新于 HH:MM:SS"时间戳（桌面端可见）
- 空响应计数器：每个账号追踪 `empty_response_count`，通过 `GET /auth/accounts` 可查看，窗口重置时自动归零
- 空响应日志增强：日志中显示账号邮箱（`Account xxxx (email) | Empty response`），便于定位问题账号
- 空响应检测 + 自动换号重试：Codex API 返回 HTTP 200 但无内容时，非流式自动切换账号重试（最多 3 次），流式注入错误提示文本
- 自动提取 Chromium 版本：`extract-fingerprint.ts` 从 `package.json` 读取 Electron 版本，通过 `electron-to-chromium` 映射为 Chromium 大版本，`apply-update.ts` 自动更新 `chromium_version` 和 TLS impersonate profile
- 动态模型列表：后台从 Codex 后端自动获取模型目录，与静态 YAML 合并（`src/models/model-store.ts`、`src/models/model-fetcher.ts`）
- `/debug/models` 诊断端点，展示模型来源（static/backend）与刷新状态
- 完整 Codex 模型目录：GPT-5.3/5.2/5.1 全系列 base/high/mid/low/max/mini 变体（23 个静态模型）
- OpenCode 平台支持（`opencode.json` 配置文件）
- Vitest 测试框架（account-pool、codex-api、codex-event-extractor 单元测试）
- request-id 中间件注入全局请求链路 ID
- Dockerfile 安全加固（非 root 用户运行、HEALTHCHECK 探针）

### Changed

- Dashboard 模型选择器去重：移除 Anthropic SDK Setup 的独立模型下拉框，统一使用 API Configuration 的 Default Model
- 模型管理从纯静态 YAML 迁移至静态+动态混合架构（后端优先，YAML 兜底）
- 默认模型改为 `gpt-5.2-codex`
- Dashboard "Claude Code Quick Setup" 重命名为 "Anthropic SDK Setup"
- `/health` 端点精简，仅返回 pool 摘要（total / active）

### Fixed

- Anthropic 路由 `thinking`/`redacted_thinking` content block 验证失败：Claude Code `/compact` 发送含 extended thinking 的对话历史时触发 400 Zod 错误，现已添加到 schema
- Anthropic 路由上下文 token 始终显示 0%：`message_delta` 事件缺少 `input_tokens`，Claude Code 无法计算上下文占比，现在从 `response.completed` 提取后一并返回
- 工具 schema 缺少 `properties` 字段导致 400 错误：MCP 工具发送 `{"type":"object"}` 无 `properties` 时，Codex 后端拒绝请求；现在所有格式转换器（OpenAI/Anthropic/Gemini）统一注入 `properties: {}`（PR #22）
- 额度窗口刷新后 Dashboard 仍显示累计 Token：本地计数器从未按窗口重置，现在 `refreshStatus()` 每次 acquire/getAccounts 时检查 `window_reset_at`，过期自动归零窗口计数器
- 空响应重试循环中账号双重释放：外层 catch 使用原始 `entryId` 而非当前活跃账号，导致换号重试失败时 double-release（`proxy-handler.ts`）
- `apply-update.ts` 模型比较不再误报删除：静态提取只含 2 个硬编码模型，与 YAML 的 24 个比较会产生 22 个假删除，现在只报新增
- `update-checker.ts` 子进程超时保护：`fork()` 添加 5 分钟 kill timer，防止挂起导致 `_updateInProgress` 永久锁定
- `model-fetcher.ts` 初始定时器添加 try/finally，防止异常中断刷新循环
- `apply-update.ts` 移除 `any` 类型（`mutateYaml` 回调参数）
- `ExtractedFingerprint` 接口统一：提取到 `scripts/types.ts` 共享，`extract-fingerprint.ts` 和 `apply-update.ts` 共用
- 强化提示词注入防护：`SUPPRESS_PROMPT` 从弱 "ignore" 措辞改为声明式覆盖（"NOT applicable"、"standard OpenAI API model"），解决 mini 模型仍泄露 Codex Desktop 身份的问题
- 非流式请求错误处理：`collectTranslator` 抛出 generic Error 时返回 502 JSON 而非 500 HTML（`proxy-handler.ts`）
- `desktop-context.md` 提取损坏修复：`extractPrompts()` 的 end marker 从 `` `; `` 改为 `` `[,;)] `` 正则，防止压缩 JS 代码注入 instructions 导致 tool_calls 失效（#13）
- 清除 `config/prompts/desktop-context.md` 中第 71 行起被污染的 ~7KB JS 垃圾代码
- TLS 伪装 profile 确定性解析：用已知 Chrome profile 列表（`KNOWN_CHROME_PROFILES`）替代不可靠的 runtime 检测，确保 `--impersonate` 目标始终有效（如 `chrome137` → `chrome136`）
- FFI transport 硬编码 `"chrome136"` 改为使用统一解析的 profile（`getResolvedProfile()`）
- `getModels()` 死代码：`allModels` 作用域修复，消除不可达分支
- `reloadAllConfigs()` 异步 lazy import 改为同步直接导入，避免日志时序不准
- 模型合并 reasoning efforts 判断逻辑从 `length > 1` 改为显式标志
- `scheduleNext()` 添加 try/finally 防止异常中断刷新循环
- 未认证启动时抑制无意义的 warn 日志
- `getModelCatalog()` / `getModelAliases()` 返回浅拷贝，防止外部意外修改
- `ClaudeCodeSetup.tsx` 文件名与导出名不一致，重命名为 `AnthropicSetup.tsx`
- Dashboard 模型偏好从硬编码 `gpt-5.2-codex` 改为使用 `codex` 别名
- 构建脚本 `vite build --root web` 兼容性问题，改用 `npm run build:web`
- Docker 容器内代理自动检测失败：`detectLocalProxy()` 现在同时探测 `127.0.0.1`（裸机）和 `host.docker.internal`（Docker 容器→宿主机），零配置即生效

## [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

### Added

- 原生 function_call / tool_calls 支持（所有协议）

### Fixed

- 格式错误的 chat payload 返回 400 `invalid_json` 错误

## [v0.7.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.7.0) - 2026-02-22

### Added

- `developer` 角色支持（OpenAI 协议）
- 数组格式 content 支持
- tool / function 消息兼容（所有协议）
- 模型响应中自动过滤 Codex Desktop 指令

### Changed

- 清理无用代码、未使用配置，修复类型违规

### Fixed

- 启动日志显示配置的 `proxy_api_key` 而非随机哈希
- 首次 OAuth 登录后 `useStatus` 未刷新

## [v0.6.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.6.0) - 2026-02-21

### Added

- libcurl-impersonate FFI 传输层，Chrome TLS 指纹
- pnpm / bun 包管理器支持

### Changed

- README 快速开始按平台重组

### Fixed

- Docker 构建完整修复链（代理配置、BuildKit 冲突、host 网络、源码复制顺序、layer 优化）
- `.env` 行内注释被误解析为 JWT token
- Anthropic / Gemini 代码示例跟随所选模型
- `proxy_api_key` 配置未在前端和认证验证中使用
- 删除按钮始终可见，不被状态徽章遮挡

## [v0.5.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.5.0) - 2026-02-20

### Added

- Dashboard 暗色 / 亮色主题切换
- 国际化支持（中文 / 英文）
- 自动代理检测（mihomo / clash / v2ray）
- 局域网登录分步教程
- Preact + Vite 前端架构
- Docker 容器部署支持
- 共享代理处理器，消除路由重复

### Changed

- Dashboard 重写为 Tailwind CSS
- 协议 / 语言两级标签页（OpenAI / Anthropic / Gemini × Python / cURL / Node.js）
- 内联 SVG 图标替换字体图标
- 系统字体替换 Google Fonts
- 架构审计修复（P0-P2 稳定性与可靠性）

### Fixed

- 移除所有 `any` 类型
- 修复图标文字闪烁（FOUC）
- 修复未认证时的重定向循环
- 移除虚假的 Claude / Gemini 模型别名，使用动态目录
- Dashboard 配置改为只读，修复 HTTP 复制按钮
- 恢复模型下拉选择器

## [v0.4.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.4.0) - 2026-02-19

### Added

- Anthropic Messages API 兼容路由（`POST /v1/messages`）
- Google Gemini API 兼容路由
- 桌面端上下文注入（模拟 Codex Desktop 请求特征）
- 多轮对话会话管理
- 自动更新检查管道（Appcast 轮询 + 版本提取）
- 中英双语 README

## [v0.3.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.3.0) - 2026-02-18

### Added

- curl-impersonate TLS 指纹模拟
- Chromium 版本自动检测与动态 `sec-ch-ua` 生成
- 请求时序 jitter 随机化
- Dashboard 实时代码示例与配额显示

### Fixed

- curl 请求修复

## [v0.2.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.2.0) - 2026-02-17

### Added

- Dashboard 多账户管理 UI
- OAuth PKCE 登录流程（固定 `localhost:1455` 回调）
- 架构审计：伪装加固、自动更新机制、健壮性提升

### Changed

- 硬编码值提取到配置文件
- 清理无用代码

## [v0.1.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.1.0) - 2026-02-17

### Added

- OpenAI `/v1/chat/completions` → Codex Responses API 反向代理核心
- 配额 API 查询（`/auth/accounts?quota=true`）
- Cloudflare TLS 指纹绕过
- SSE 流式响应转换
- 模型列表端点（`GET /v1/models`）
- 健康检查端点（`GET /health`）
