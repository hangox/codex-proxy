# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [Unreleased]

## [1.0.5] - 2026-03-05

### Added

- GPT-5.4 + Codex Spark 模型支持：新增 `gpt-5.4`（4 种 effort: minimal/low/medium/high）和 `gpt-5.3-codex-spark`（minimal/low），`codex` 别名更新为 `gpt-5.4`
- 扩展推理等级：支持 `minimal`、`xhigh` 等新 effort 值，客户端发送的任意 `reasoning_effort` 均透传到后端
- 模型家族矩阵选择器：Dashboard 模型选择从平面下拉改为家族列表 + 推理等级按钮组，通过 `/v1/models/catalog` 端点获取完整目录
- 泛化模型识别：`isCodexCompatibleId()` 同时匹配 `gpt-X.Y-codex-*` 和裸 `gpt-X.Y` 格式，确保新模型命名规范变化时自动接入
- 代码示例动态 reasoning_effort：CodeExamples 组件根据选中的推理等级自动插入 `reasoning_effort` 参数

## [1.0.4] - 2026-03-05

### Fixed

- 移除后端已不支持的 `previous_response_id` 参数（发送会导致 HTTP 400）
- 清理已废弃的 `SessionManager`（仅服务于 `previous_response_id`，多轮对话通过完整消息历史实现）

## [1.0.3] - 2026-03-05

### Fixed

- macOS Electron 打开后 404：electron-builder 遵循 `.gitignore` 排除了 `dist-electron/server.mjs`，添加 `.ebignore` 覆盖打包过滤规则
- asar 包含多余的 `node_modules/` 和 `dist/`，现已排除
- GitHub Release 自动追加 Contributors 列表，设置 `generate_release_notes: false`

## [1.0.2] - 2026-03-04

### Changed

- Dashboard 模型选择器去重：移除 Anthropic SDK Setup 的独立模型下拉框，统一使用 API Configuration 的 Default Model
- 模型管理从纯静态 YAML 迁移至静态+动态混合架构（后端优先，YAML 兜底）
- 默认模型改为 `gpt-5.2-codex`
- Dashboard "Claude Code Quick Setup" 重命名为 "Anthropic SDK Setup"
- `/health` 端点精简，仅返回 pool 摘要（total / active）

### Fixed

- Anthropic 路由 `thinking`/`redacted_thinking` content block 验证失败：Claude Code `/compact` 发送含 extended thinking 的对话历史时触发 400 Zod 错误
- Anthropic 路由上下文 token 始终显示 0%：`message_delta` 事件缺少 `input_tokens`
- 工具 schema 缺少 `properties` 字段导致 400 错误（PR #22）
- 额度窗口刷新后 Dashboard 仍显示累计 Token
- 空响应重试循环中账号双重释放
- 强化提示词注入防护
- 构建脚本 `vite build --root web` 兼容性问题，改用 `npm run build:web`
- Docker 容器内代理自动检测失败：`detectLocalProxy()` 同时探测 `127.0.0.1` 和 `host.docker.internal`

## [1.0.1] - 2026-03-04

### Fixed

- Windows Electron 安装后无法启动：添加全局 try-catch + 错误对话框
- NSIS 安装无向导：改为 `oneClick: false` + 允许选择安装目录
- 桌面端 UI 静态资源路径错误：改为绝对路径
- macOS 无法退出应用：添加 `isQuitting` 标志 + `before-quit` 事件处理
- macOS 签名：依赖 electron-builder 默认 ad-hoc 签名

## [1.0.0] - 2026-03-04

### Added

- Electron 桌面应用：下载安装即用，无需 Node.js 环境
- 桌面端 UI 独立重设计（macOS / Windows 原生风格）
- Reasoning/Thinking 输出支持（OpenAI + Anthropic 路由）
- 图片输入支持（OpenAI / Anthropic / Gemini 透传）
- 每窗口使用量计数器 + 窗口时长显示
- 空响应检测 + 自动换号重试
- 动态模型列表（后端自动获取 + 静态 YAML 合并）
- 完整 Codex 模型目录（23 个静态模型）

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
