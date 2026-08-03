<div align="center">

  <h1>Codex Proxy</h1>
  <h3>您的本地 Codex 编程助手中转站</h3>
  <p>将 Codex Desktop 的能力以 OpenAI / Anthropic / Gemini 标准协议对外暴露，无缝接入任意 AI 客户端。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-快速开始">快速开始</a> &bull;
    <a href="#-核心功能">核心功能</a> &bull;
    <a href="#-可用模型">可用模型</a> &bull;
    <a href="#-客户端接入">客户端接入</a> &bull;
    <a href="#-配置说明">配置说明</a> &bull;
    <a href="#-贡献致谢">贡献致谢</a>
  </p>

  <p>
    <strong>简体中文</strong> |
    <a href="./README_EN.md">English</a>
  </p>

  <br>

  <a href="https://x.com/IceBearMiner"><img src="https://img.shields.io/badge/Follow-@IceBearMiner-000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://github.com/icebear0828/codex-proxy/issues"><img src="https://img.shields.io/github/issues/icebear0828/codex-proxy?style=flat-square" alt="Issues"></a>
  <a href="#-赞赏--交流"><img src="https://img.shields.io/badge/赞赏-微信-07C160?style=flat-square&logo=wechat&logoColor=white" alt="赞赏"></a>

  <br><br>

  <table>
    <tr>
      <td align="center">
        <img src="./.github/assets/donate.png" width="180" alt="微信赞赏码"><br>
        <sub>☕ 赞赏</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/wechat.png" width="180" alt="微信交流群"><br>
        <sub>💬 微信群</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/tgimage.png" width="180" alt="Telegram 群"><br>
        <sub>💬 Telegram</sub>
      </td>
    </tr>
  </table>

</div>

---

> **声明**：本项目由个人独立开发和维护，初衷是解决自己的需求。我有自己的注册机，根本不缺 token，所以这个项目不是为了"薅"谁的资源而存在的。
>
> 我自愿开源、自愿维护。该有的功能我会加，有 bug 我也会第一时间修。但我没有义务为任何单个用户提供定制服务。
>
> 觉得代码垃圾？可以不用。觉得你写得更好？欢迎提 PR 加入贡献者。Issue 区用来反馈 bug 和建议，不是用来提需求、催更新、或指点江山的。

---

**Codex Proxy** 是一个轻量级本地中转服务，将 [Codex Desktop](https://openai.com/codex) 的 Responses API 转换为多种标准协议接口（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Gemini、Codex `/v1/responses` 直通，以及可选 Ollama `/api/chat` 兼容桥接）。通过本项目，您可以在 Cursor、Claude Code、Continue 等任何兼容上述协议的客户端中直接使用 Codex 编程模型。

只需一个 ChatGPT 账号（或接入第三方 API 中转站），配合本代理即可在本地搭建一个专属的 AI 编程助手网关。

## 🚀 快速开始

> **前置条件**：你需要一个 ChatGPT 账号（免费账号即可）。如果还没有，先去 [chat.openai.com](https://chat.openai.com) 注册一个。

### 方式一：桌面应用（推荐新手）

下载 → 安装 → 打开就能用。

**下载安装包** — 打开 [Releases 页面](https://github.com/icebear0828/codex-proxy/releases)，根据系统下载：

| 系统 | 文件 |
|------|------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

安装后打开应用，点击登录按钮用 ChatGPT 账号登录。浏览器访问 `http://localhost:8080` 即可看到控制面板。

### 方式二：Docker 部署

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
# 打开 http://localhost:8080 登录
```

> 账号数据保存在 `data/` 文件夹，重启不丢失。其他容器连本服务用宿主机 IP（如 `192.168.x.x:8080`），不要用 `localhost`。

取消 `docker-compose.yml` 中 Watchtower 的注释即可自动更新。若要在 Docker 中启用 Ollama 兼容桥接，请参考下方 [Ollama Bridge 配置](#ollama-bridge-配置)。

### 方式三：源码运行

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install                        # 安装后端依赖
cd web && npm install && cd ..     # 安装前端依赖
npm run dev                        # 开发模式（热重载）
# 或: npm run build && npm start   # 生产模式
```

> **需要 Rust 工具链**（用于编译 TLS native addon）：
> ```bash
> # 1. 安装 Rust（如果没有的话）
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> # 2. 编译 TLS addon
> cd native && npm install && npm run build && cd ..
> ```
> Docker / 桌面应用已内置编译好的 addon，无需手动编译。

打开 `http://localhost:8080` 登录。

### 验证

登录后打开控制面板 `http://localhost:8080`，在 **API Configuration** 区域找到你的 API Key，然后：

```bash
# 把 your-api-key 替换成控制面板里显示的密钥
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

看到 AI 回复的文字流即部署成功。如果返回 401，请检查 API Key 是否正确。

## 🌟 核心功能

### 🔌 全协议兼容
- 兼容 `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、Gemini 格式及 `/v1/responses`（Codex 直通）
- 内置可选 Ollama 兼容桥接，默认监听 `http://127.0.0.1:11434`
- SSE 流式输出，可直接对接所有 OpenAI / Anthropic SDK 和客户端
- 自动完成 Chat Completions / Anthropic / Gemini ↔ Codex Responses API 双向协议转换
- **Structured Outputs** — `response_format`（`json_object` / `json_schema`）和 Gemini `responseMimeType`
- **Function Calling** — 原生 `function_call` / `tool_calls` 支持（所有协议）
- **第三方 API Keys** — 支持 OpenAI / Anthropic / Gemini / OpenRouter / 自定义 OpenAI-compatible Provider，并按模型路由直通上游。

### 🔐 账号管理与智能轮换
- **OAuth PKCE 登录** — 浏览器一键授权，无需手动复制 Token
- **多账号轮换** — `least_used`（最少使用优先）、`round_robin`（轮询）、`sticky`（粘性）三种策略
- **Plan Routing** — 不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型
- **Token 自动续期** — JWT 到期前自动刷新，指数退避重试
- **配额采集** — 默认从上游响应头和 WebSocket rate limit 事件被动更新账号额度；用户手动查询单账号额度时会调用 `/backend-api/wham/usage`，并把 `remaining_percent = 100 - used_percent` 写入缓存。
- **封禁检测** — 上游 403 自动标记 banned；401 token 吊销自动过期并切换账号
- **API Key Provider 池** — 支持通过 Dashboard 管理第三方 API Key、模型列表、导入导出和启停状态。
- **Web 控制面板** — 账号管理、用量统计、批量操作，中英双语；远程访问需 Dashboard 登录门

### 🌐 代理池
- **Per-Account 代理路由** — 为不同账号配置不同的上游代理
- **四种分配模式** — Global Default / Direct / Auto / 指定代理
- **健康检查** — 定时 + 手动，通过 ipify 获取出口 IP 和延迟
- **不可达自动标记** — 代理不可达时自动排除

### 🛡️ 反检测与协议伪装
- **Rust Native TLS** — 内置 reqwest + rustls native addon，TLS 指纹与真实 Codex Desktop 精确一致（依赖版本锁定）
- **完整请求头** — `originator`、`User-Agent`、`x-openai-internal-codex-residency`、`x-codex-turn-state`、`x-client-request-id` 等头按真实客户端行为发送
- **Cookie 持久化** — 自动捕获和回放 Cloudflare Cookie
- **指纹自动更新** — 轮询 Codex Desktop 更新源，自动同步 `app_version` 和 `build_number`

## 🏗️ 技术架构

```
                                Codex Proxy
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Client (Cursor / Claude Code / Continue / SDK / ...)    │
│       │                                                  │
│  POST /v1/chat/completions (OpenAI)                      │
│  POST /v1/messages         (Anthropic)                   │
│  POST /v1/responses        (Codex 直通)                  │
│  POST /gemini/*            (Gemini)                      │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐   │
│  │  Routes   │──▶│  Translation  │──▶│    Proxy     │   │
│  │  (Hono)  │   │ Multi→Codex   │   │ Native TLS   │   │
│  └──────────┘   └───────────────┘   └──────┬───────┘   │
│       ▲                                     │           │
│       │          ┌───────────────┐          │           │
│       └──────────│  Translation  │◀─────────┘           │
│                  │ Codex→Multi   │  SSE stream          │
│                  └───────────────┘                       │
│                                                          │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │   Auth   │  │  Fingerprint  │  │   Model Store    │  │
│  │OAuth/API │  │ Rust (rustls) │  │ Static + Dynamic │  │
│  │ API Keys │  │  Headers/UA   │  │  Plan Routing    │  │
│  └──────────┘  └───────────────┘  └──────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
                Rust Native Addon (napi-rs)
              reqwest 0.12.28 + rustls 0.23.36
             (TLS 指纹 = 真实 Codex Desktop)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
             chatgpt.com   第三方 Provider
         /backend-api/codex  (第三方 API)
```

## 📦 可用模型

| 模型 ID | 推理等级 | 当前上下文 | 最大上下文 | 最大输出 | 输出 | 说明 |
|---------|---------|------------|------------|----------|------|------|
| `gpt-5.5` | low / medium / high / xhigh | 272,000 | 272,000 | 128,000 | 文本 | 复杂编码、研究和真实工作流旗舰模型 |
| `gpt-5.4` | low / medium / high / xhigh | 272,000 | 1,000,000 | 128,000 | 文本 | 日常编码强模型（默认） |
| `gpt-5.4-mini` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 5.4 轻量版 |
| `gpt-5.3-codex` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 5.3 编程优化模型 |
| `gpt-5.2` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 专业工作 + 长时间代理 |
| `gpt-5-codex` | low / medium / high | 400,000 | — | 128,000 | 文本 | GPT-5 编程优化模型 |
| `gpt-5-codex-mini` | medium / high | — | — | — | 文本 | 轻量 Codex / CLI 编程模型 |
| `gpt-oss-120b` | low / medium / high | 131,072 | — | — | 文本 | 开源 120B 模型 |
| `gpt-oss-20b` | low / medium / high | 131,072 | — | — | 文本 | 开源 20B 模型 |
| `gpt-image-2` | — | — | — | — | 图像 | 图像生成工具后端（通过 `image_generation` 调用） |

> **后缀**：任意 chat 模型名后追加 `-fast` 启用 Fast 模式，`-high`/`-low` 切换推理等级。例如：`gpt-5.4-fast`、`gpt-5.4-high-fast`。图像模型（`gpt-image-2`）不支持后缀。
>
> **Plan Routing**：不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型，模型可用性以登录账号对应的 Codex 后端返回为准，不要按旧的 Plus-only 表理解。模型列表由后端动态获取，自动同步；只要模型出现在 Dashboard / `/v1/models/catalog` 中，就可以作为请求里的 `model` 使用。
>
> **前端模型选择 ≠ 配置文件**：Dashboard 中切换模型只影响前端展示和 API 示例中的模型名，**不会修改** `config/default.yaml` 或 `data/local.yaml` 中的 `model.default`。实际使用哪个模型取决于客户端请求中的 `model` 字段（如 Cursor、Claude Code 等自行指定），配置文件中的 `model.default` 仅在客户端未指定模型时作为兜底。
>
> **Max token 说明**：上表跟随当前 `config/models.yaml` 和 Codex runtime `/v1/models/catalog` 元数据；`—` 表示当前目录未返回该字段，不代表模型不可用。运行时从 Codex 后端拉到的模型信息会覆盖静态值，并保留 `contextWindow`、`maxContextWindow`、`maxOutputTokens`、`truncationPolicyLimit`。请求体里的 `context_window` / `max_context_window` / `truncation_policy` / `max_output_tokens` 都不是可用开关；直接转发给 Codex 原生接口会返回 `400 Unsupported parameter`。

### 🖼️ 图像生成

图像生成走 `/v1/responses` 的 `image_generation` 内置工具，后端固定为 `gpt-image-2`。

**前提**：ChatGPT **Plus 及以上** 账号（free 账号上游会静默剥掉工具，模型会降级用 SVG 文本假装画图）。

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": [{"role":"user","content":"Draw a red circle on white background."}],
    "tools": [{"type":"image_generation","size":"3840x2160"}]
  }'
```

常用参数：`size`（1024×1024 / 1024×1536 / 1536×1024 / 2048×2048 / 2048×3072 / 3072×2048 / 3840×2160（4K UHD）/ `auto`，最长边 ≤ 3840 px，像素预算约 8 MP）、`output_format`（`png` / `jpeg` / `webp`）、`output_compression`（jpeg / webp 可调）、`background`（`auto` / `opaque`）、`moderation`（`auto` / `low`）、`partial_images`（0–3）。一次只能出 1 张图（`n` 固定为 1）；`model` 字段不管传什么都会被上游改写回 `gpt-image-2`。详见 [API.md](./API.md#image_generation-tool)。

事件流里 `image_generation_call` item 的 `result` 字段即 base64 编码的图像；`revised_prompt` 是上游改写后的最终提示词。

**编辑模式**（带参考图）：在 user message 的 `content` 里追加 `{"type":"input_image","image_url":"data:image/png;base64,..."}` 即可。

> `/v1/chat/completions` 兼容路径会接受 `image_generation` 工具，避免 OpenAI 客户端因 schema 失败；但图像 payload 只有 `/v1/responses` 会稳定透出 `image_generation_call.result`。需要拿到图片字节时请使用 `/v1/responses`。

## 🔗 客户端接入

> 所有客户端的 API Key 均从控制面板 (`http://localhost:8080`) 获取。模型名填具体 ID（默认 `gpt-5.4`）或任意 [可用模型](#-可用模型) ID。

### Claude Code (CLI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# 切换模型: export ANTHROPIC_MODEL=gpt-5.4 / gpt-5.4-fast / gpt-5.4-mini ...
claude
```

> 控制面板的 **Anthropic SDK Setup** 卡片可一键复制环境变量（含 Opus / Sonnet / Haiku 层级模型配置）。
>
> 推荐模型：Opus → `gpt-5.5`，Sonnet → `gpt-5.4`，Haiku → `gpt-5.3-codex`。
>
> ⚠️ 配置不生效？请参考 **[Claude Code 配置避坑指南](.github/guides/claude-code-setup.md)**（AUTH_TOKEN 劫持、API Key 黑名单等常见问题）。

### Codex CLI

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

# 直接把 API Key 写进 config（推荐：本地单用户场景）
[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 也可以改用环境变量：把 `[model_providers.proxy_codex.http_headers]` 这两行删掉，换成 `env_key = "PROXY_API_KEY"`，然后 `export PROXY_API_KEY=your-api-key && codex`。需要避免密钥落到 config 文件（多人共享 / 开源仓库）时用这个。

### Claude Desktop

1. **开启开发者模式**：点击菜单栏 **Help** → **Troubleshooting** → **Enable Developer Mode**。
2. **配置第三方推理**：点击菜单栏新出现的 **Developer** → **Configure Third-Party Inference...**。
3. **填写配置**：
   - **Endpoint**: `http://127.0.0.1:8080`
   - **API Key**: 你的 API Key
   - **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

> 或手动修改配置文件（Windows 下路径通常在 `%APPDATA%\Claude-3p\configLibrary\` 目录下的 JSON 文件，Mac 为 `~/Library/Application Support/Claude-3p/configLibrary/`），添加如下字段：
```json
 {
   "disableDeploymentModeChooser": true,
   "inferenceProvider": "gateway",
   "inferenceGatewayBaseUrl": "http://127.0.0.1:8080",
   "inferenceGatewayApiKey": "your-api-key",
   "inferenceGatewayAuthScheme": "bearer",
   "inferenceModels": [
     "claude-opus-4-7",
     "claude-sonnet-4-6",
     "claude-haiku-4-5"
   ]
 }
```

内置 Claude 形态模型名会映射到 Codex 模型。自定义映射请写到 `data/local.yaml`，不要改 `config/models.yaml`：
```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    claude-sonnet-4-6: gpt-5.4
    claude-haiku-4-5: gpt-5.3-codex
    my-openai: openai:gpt-4o
    my-deepseek: deepseek-chat
```

alias 左边是客户端请求里填写的模型名，右边是真正发给上游的模型名。右侧可以是 Codex 模型 ID、带 provider 前缀的模型（如 `openai:gpt-4o` / `anthropic:claude-sonnet-4-5` / `gemini:gemini-2.5-pro`），也可以是已通过 `model_routing` 绑定到自定义 provider 的模型名（如 `deepseek-chat`）。别名会出现在 `/v1/models`，请求进入直连 provider 时会自动把模型名改写成映射目标。

> 💡 **排查提示 (Windows)**: 如果使用 `127.0.0.1` 时 Claude Desktop 提示 `ERR_CONNECTION_REFUSED`（而使用 `localhost` 提示 URL 格式错误），说明 Node.js 在你的系统上默认只绑定了 IPv6。请进入 Codex Proxy 控制面板的设置页面，将 **Host** 修改为 `127.0.0.1`，或在 `data/local.yaml` 中添加 `server: { host: "127.0.0.1" }` 后重启代理。
> 
> 💡 **局域网使用提示 (LAN)**: Claude Desktop 强制校验 API 地址，**只允许** `https://` 开头或 `http://127.0.0.1`。如果你将 Codex Proxy 部署在局域网另一台机器（如 `192.168.x.x`），直接填入会报错。解决方法：
> 1. **SSH 隧道 (最简单)**：在客户端机器运行 `ssh -L 8080:127.0.0.1:8080 user@192.168.x.x`，然后在 Claude 里填 `http://127.0.0.1:8080`。
> 2. **反向代理**：使用 Caddy 或 Nginx 配置局域网 HTTPS 证书。

### Codex Desktop (官方应用)

官方客户端与 CLI 共用配置文件，修改后需重启客户端生效。

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 **为什么不用 `env_key`？** macOS / Windows 的 GUI 应用不读 shell 的 `~/.zshrc` / `.bashrc`，光 `export PROXY_API_KEY=...` 在终端里 GUI 进程根本看不到，启动会直接报 `Missing environment variable`。`http_headers` 把 Authorization 写在 config 里，重启 Codex 就能用，不用折腾 `launchctl setenv` 或 LaunchAgent。需要密钥从配置文件解耦时（共享机器 / 仓库提交）再换回 `env_key = "PROXY_API_KEY"` 走环境变量。
>
> ⚠️ 如果你是通过"登录 ChatGPT 账号"方式使用的，客户端可能会忽略此配置——只要 `[model_providers.proxy_codex]` 配上、`profiles.default.model_provider = "proxy_codex"`，新会话就会走 proxy；登录会话仍可能直接走官方上游。

### Claude for VSCode / JetBrains

打开 Claude 扩展设置，找到 **API Configuration**：
- **API Provider**: 选择 Anthropic
- **Base URL**: `http://localhost:8080`
- **API Key**: 你的 API Key

或在 VS Code `settings.json` 中添加：
```json
{
  "claude.apiEndpoint": "http://localhost:8080",
  "claude.apiKey": "your-api-key"
}
```

### Cursor

1. 打开 Settings → Models
2. 选择 OpenAI API
3. 设置 **Base URL**: `http://localhost:8080/v1`
4. 设置 **API Key**: 你的 API Key
5. 添加模型名 `gpt-5.4`（或其他模型 ID）

### Windsurf

1. 打开 Settings → AI Provider
2. 选择 **OpenAI Compatible**
3. **API Base URL**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. **Model**: `gpt-5.4`

### Cline (VSCode 扩展)

1. 打开 Cline 侧边栏 → 设置齿轮
2. **API Provider**: 选择 OpenAI Compatible
3. **Base URL**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. **Model ID**: `gpt-5.4`

### Continue (VSCode 扩展)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "gpt-5.4",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

### aider

```bash
aider --openai-api-base http://localhost:8080/v1 \
      --openai-api-key your-api-key \
      --model openai/gpt-5.4
```

或设置环境变量：
```bash
export OPENAI_API_BASE=http://localhost:8080/v1
export OPENAI_API_KEY=your-api-key
aider --model openai/gpt-5.4
```

### Cherry Studio

1. 设置 → 模型服务 → 添加
2. **类型**: OpenAI
3. **API 地址**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. 添加模型 `gpt-5.4`

### Ollama 兼容客户端

在 Dashboard → Settings → **Ollama Bridge** 中启用后，可使用 Ollama 默认地址：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:11434` |
| API Key | 不需要，Bridge 内部会使用 Codex Proxy 的密钥访问主服务 |
| Model | `gpt-5.4`（或其他模型 ID） |

```bash
curl http://localhost:11434/api/tags

curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

> Ollama API 本身没有鉴权。默认仅监听 `127.0.0.1`，不建议暴露到公网或未信任的局域网。

### 通用 OpenAI 兼容客户端

任何支持自定义 OpenAI API Base 的客户端均可接入：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:8080/v1` |
| API Key | 控制面板获取 |
| Model | `gpt-5.4`（或其他模型 ID） |

<details>
<summary>SDK 代码示例（Python / Node.js）</summary>

**Python**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-api-key")
for chunk in client.chat.completions.create(
    model="gpt-5.4", messages=[{"role": "user", "content": "Hello!"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js**
```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "your-api-key" });
const stream = await client.chat.completions.create({
  model: "gpt-5.4", messages: [{ role: "user", content: "Hello!" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

</details>

## ⚙️ 配置说明

> **重要**：不要直接修改 `config/default.yaml`，该文件会在版本更新时被覆盖。自定义配置请通过 Dashboard 设置面板修改（自动保存到 `data/local.yaml`），或手动创建 `data/local.yaml` 写入需要覆盖的字段。`data/` 目录不受更新影响。

默认配置位于 `config/default.yaml`：

| 分类 | 关键配置 | 说明 |
|------|---------|------|
| `server` | `host`, `port`, `proxy_api_key` | 监听地址与 API 密钥 |
| `api` | `base_url`, `timeout_seconds` | 上游 API 地址与超时 |
| `client` | `app_version`, `build_number`, `chromium_version` | 模拟的 Codex Desktop 版本 |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier`, `aliases`, `custom_models`, `inject_desktop_context` | 默认模型、推理配置、模型映射与自定义模型目录 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 轮换策略与限流退避 |
| `tls` | `proxy_url`, `force_http11` | TLS 代理与 HTTP 版本 |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | 用量快照、阈值配置与耗尽账号跳过 |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | Dashboard session 管理 |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama 兼容桥接 |
| `official_agent` | `enabled`, `api_key`, `app_server_url`, `auth` | 官方 Codex app-server 桥接，用于复用 Chrome/browser 插件 |

### 模型映射

`model.aliases` 用来把客户端里的模型名映射成真实上游模型，适合 Claude Desktop / Cursor / Continue 等客户端只能选择固定模型名、或你希望暴露更短别名的场景。

也可以直接在 Dashboard → Settings → **模型映射** 中添加 / 删除映射。保存后会写入 `data/local.yaml` 并热加载到后端，不需要修改 `config/default.yaml`。

```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    sonnet-local: gpt-5.4
    openai-fast: openai:gpt-4o
    deepseek-local: deepseek-chat

providers:
  custom:
    deepseek:
      api_key: "sk-..."
      base_url: "https://api.deepseek.com/v1"
      models: ["deepseek-chat"]
model_routing:
  deepseek-chat: deepseek
```

映射解析发生在 `model_routing` 和内置 Claude/Gemini 自动路由之前。映射到 Codex 模型时仍支持 `-fast` / `-high` 等后缀；映射到第三方 provider 时，直连请求会把 `model` 字段改写成右侧目标值。

如果你还需要把完全自定义的 Codex-compatible 模型 ID 加入模型目录，可在 `data/local.yaml` 中配置 `model.custom_models`。简单字符串会使用默认 text/medium 元数据；对象写法可补 display name、推理等级、上下文和输出上限：

```yaml
model:
  custom_models:
    - local-simple
    - id: local-rich
      display_name: Local Rich
      description: Local rich model
      supported_reasoning_efforts: [low, high]
      default_reasoning_effort: high
      input_modalities: [text, image]
      output_modalities: [text]
      context_window: 12345
      max_context_window: 23456
      max_output_tokens: 3456
```

### 配额轮转

`quota.skip_exhausted: true` 时，账号池会在选择账号前跳过缓存额度已经耗尽的账号；这个过滤发生在 session affinity / `preferredEntryId` 之前，所以长对话也不会强行粘到已耗尽账号上。

当前跳过条件是缓存额度里的 `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true` 或 `code_review_rate_limit.limit_reached === true`。如果只是 `used_percent` 接近 100（例如 99%）但上游还没标记 `limit_reached`，代理仍会继续使用该账号；真正打到上游 429 后，账号会进入 `rate_limited` 退避并切换到其他可用账号。secondary / code review 窗口自己的 `reset_at` 过期后会从缓存中清除，避免账号被永久跳过。

### 局域网访问

源码默认配置仅监听 `127.0.0.1`；Electron 也会传入 `127.0.0.1`，除非 `data/local.yaml` 显式覆盖。Docker 镜像会通过 `CODEX_PROXY_HOST=0.0.0.0` 在容器内监听所有接口，`docker-compose.yml` 默认仍只把宿主机端口绑定到 `127.0.0.1`。

需要仅本机访问时写入：

```yaml
server:
  host: "127.0.0.1"
```

如需局域网内其他设备访问，在 `data/local.yaml` 中添加，并把 `docker-compose.yml` 的端口映射从 `127.0.0.1:${PORT:-8080}:8080` 改成 `${PORT:-8080}:8080`：

```yaml
server:
  host: "0.0.0.0"
```

Electron 桌面版的 `data/local.yaml` 路径：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Codex Proxy/data/local.yaml` |
| Windows | `%APPDATA%/Codex Proxy/data/local.yaml` |
| Linux | `~/.config/Codex Proxy/data/local.yaml` |

> ⚠️ 绑定 `0.0.0.0` 会将服务暴露到局域网，务必在 Dashboard → 密钥设置中配置强密钥。

### TLS 配置

```yaml
tls:
  proxy_url: null                  # null = 自动检测本地代理；填写代理 URL 指定上游代理
  force_http11: false              # HTTP/2 失败时自动降级 HTTP/1.1；true = 强制 HTTP/1.1
```

> 内置 Rust native addon（reqwest + rustls），TLS 指纹与真实 Codex Desktop 完全一致。源码运行需先编译：`cd native && npm install && npm run build`。

### API 密钥

```yaml
server:
  proxy_api_key: "pwd"    # 自定义密钥，客户端用 Bearer pwd 访问
  # proxy_api_key: null   # null = 不配置全局密钥；已登录账号仍会生成 account-level codex-proxy-xxxx 密钥
```

首次启动如果缺少 `data/local.yaml`，程序会自动创建 `server.proxy_api_key: pwd`。当前可用密钥显示在控制面板的 API Configuration 区域。

### Ollama Bridge 配置

```yaml
ollama:
  enabled: false          # true = 启动内置 Ollama 兼容监听器
  host: 127.0.0.1         # 默认仅本机可访问
  port: 11434             # Ollama 默认端口
  version: "0.18.3"       # /api/version 返回值
  disable_vision: false   # true = /api/show 不声明 vision 能力
```

支持的 Ollama 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `http://localhost:11434/api/version` | GET | Ollama 版本探测 |
| `http://localhost:11434/api/tags` | GET | 模型列表 |
| `http://localhost:11434/api/show` | POST | 模型元数据 |
| `http://localhost:11434/api/chat` | POST | 聊天补全，支持流式 NDJSON |
| `http://localhost:11434/v1/*` | 任意 | OpenAI `/v1` 直通 |

Docker 部署时，如果希望宿主机访问 `11434`：

1. 在 Dashboard 或 `data/local.yaml` 中设置 `ollama.enabled: true` 和 `ollama.host: 0.0.0.0`。
2. 取消 `docker-compose.yml` 中 `127.0.0.1:${OLLAMA_BRIDGE_PORT:-11434}:11434` 端口映射的注释。
3. 保持宿主机绑定 `127.0.0.1`，除非你明确知道自己要把无鉴权 Ollama API 暴露到网络。

浏览器 CORS 访问仅允许 `localhost`、`127.x.x.x`、`::1` 等 loopback origin；非本机网页来源不能读取桥接响应。Bridge 会为 `/v1/*` 直通请求注入已配置的 Codex Proxy API Key，因此暴露到 localhost 之外时，相当于也把主代理 API 以无鉴权方式暴露出去。

### Official Agent Bridge 配置

该桥接用于连接本机官方 `codex app-server`，从而复用 Codex app 的官方 Chrome/browser 插件、审批和 app mention 能力。默认关闭，不影响现有 `/v1/*` 模型代理。

先启动官方 app-server：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

然后在 `data/local.yaml` 启用：

```yaml
server:
  proxy_api_key: "your-api-key"

official_agent:
  enabled: true
  api_key: "your-official-agent-key"
  app_server_url: ws://127.0.0.1:4500
  auth:
    type: none
```

如果 app-server 使用 capability token：

```bash
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/path/to/token
```

对应配置：

```yaml
server:
  proxy_api_key: "your-api-key"

official_agent:
  enabled: true
  api_key: "your-official-agent-key"
  app_server_url: ws://127.0.0.1:4500
  auth:
    type: capability_token
    token_file: /absolute/path/to/token
```

可用端点：

```bash
curl http://localhost:8080/official-agent/apps \
  -H "Authorization: Bearer your-official-agent-key"
```

```bash
curl -N http://localhost:8080/official-agent/threads/{threadId}/turns \
  -H "Authorization: Bearer your-official-agent-key" \
  -H "Content-Type: application/json" \
  -d '{"text":"Open localhost:8080 and inspect the dashboard","app":{"id":"chrome","name":"Chrome"}}'
```

### 环境变量覆盖

| 环境变量 | 覆盖配置 |
|---------|---------|
| `PORT` | `server.port` |
| `CODEX_PROXY_HOST` | `server.host`（仅当 `data/local.yaml` 未显式设置 `server.host` 时生效） |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `HTTPS_PROXY` | `tls.proxy_url` |
| `OLLAMA_BRIDGE_ENABLED` | `ollama.enabled` |
| `OLLAMA_BRIDGE_HOST` | `ollama.host` |
| `OLLAMA_BRIDGE_PORT` | `ollama.port` |
| `OLLAMA_BRIDGE_VERSION` | `ollama.version` |
| `OLLAMA_BRIDGE_DISABLE_VISION` | `ollama.disable_vision` |

## 📡 API 端点

<details>
<summary>点击展开主要端点列表</summary>

**协议端点**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI 格式聊天补全 |
| `/v1/responses` | POST | Codex Responses API 直通 |
| `/v1/responses/compact` | POST | Codex compact 响应代理 |
| `/v1/messages` | POST | Anthropic 格式聊天补全 |
| `/v1/models` | GET | 可用模型列表 |
| `/v1/models/catalog` | GET | Dashboard 使用的完整模型目录 |
| `/v1/models/:modelId/info` | GET | 单个模型的推理等级等详情 |
| `/v1beta/models` | GET | Gemini 格式模型列表 |
| `/v1beta/models/:modelAction` | POST | Gemini `generateContent` / `streamGenerateContent` |
| `:11434/api/chat` | POST | Ollama 兼容聊天补全（需启用 Ollama Bridge） |

**账号与认证**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | OAuth 登录入口 |
| `/auth/accounts` | GET | 账号列表（含缓存额度） |
| `/auth/accounts` | POST | 添加单个账号（token 或 refreshToken） |
| `/auth/accounts/import` | POST | 批量导入账号（JSON / `text/plain` token 行） |
| `/auth/accounts/export` | GET | 导出账号（`?format=full|minimal|cockpit_tools|sub2api|cpa`） |
| `/auth/accounts/batch-delete` | POST | 批量删除账号 |
| `/auth/accounts/batch-status` | POST | 批量修改账号状态 |
| `/auth/accounts/health-check` | POST | 批量检测账号可用性 |
| `/auth/accounts/:id/refresh` | POST | 刷新并探测单个账号 |
| `/auth/accounts/:id/quota` | GET | 主动查询单个账号额度 |
| `/auth/accounts/:id/cookies` | GET/POST/DELETE | 管理账号 Cloudflare cookies |
| `/auth/quota/warnings` | GET | 当前额度预警状态 |

**第三方 API Keys**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/api-keys/catalog` | GET | 内置 Provider 与推荐模型目录 |
| `/auth/api-keys` | GET/POST | API Key 列表 / 添加 |
| `/auth/api-keys/models` | POST | 从自定义 OpenAI-compatible Provider 拉取模型 |
| `/auth/api-keys/export` | GET | 导出 API Key 配置 |
| `/auth/api-keys/import` | POST | 导入 API Key 配置 |
| `/auth/api-keys/batch-delete` | POST | 批量删除 API Key |
| `/auth/api-keys/:id` | DELETE | 删除单个 API Key |
| `/auth/api-keys/:id/label` | PATCH | 修改 API Key 标签 |
| `/auth/api-keys/:id/status` | PATCH | 启用或停用 API Key |

**账号导入导出示例**

```bash
# 导出所有账号（完整格式，含 token）
curl -s http://localhost:8080/auth/accounts/export \
  -H "Authorization: Bearer your-api-key" > backup.json

# 导出精简格式（仅 refreshToken + label，适合分享）
curl -s "http://localhost:8080/auth/accounts/export?format=minimal" \
  -H "Authorization: Bearer your-api-key" > backup-minimal.json

# 导出第三方兼容格式
curl -s "http://localhost:8080/auth/accounts/export?format=sub2api" \
  -H "Authorization: Bearer your-api-key" > sub2api-accounts.json

# 批量导入（支持 token、refreshToken，或两者同时传）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "accounts": [
      { "token": "eyJhbGciOi..." },
      { "refreshToken": "v1.abc..." },
      { "refreshToken": "v1.def...", "label": "备用账号" }
    ]
  }'
# 返回: { "added": 2, "updated": 1, "failed": 0, "errors": [] }

# text/plain token 行导入（每行 access token 或 refresh token）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: text/plain" \
  -H "Authorization: Bearer your-api-key" \
  --data-binary $'eyJhbGciOi...\noaistb_rt_...\n'

# 备份恢复一键操作（导出后直接导入到另一个实例）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d @backup.json
```

**管理接口**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/rotation-settings` | GET/POST | 轮换策略配置 |
| `/admin/quota-settings` | GET/POST | 额度刷新与预警配置 |
| `/admin/ollama-settings` | GET/POST | Ollama Bridge 配置 |
| `/admin/ollama-status` | GET | Ollama Bridge 运行状态 |
| `/admin/refresh-models` | POST | 手动刷新模型列表 |
| `/admin/usage-stats/summary` | GET | 用量统计汇总 |
| `/admin/usage-stats/history` | GET | 用量时间序列 |
| `/admin/logs` | GET | 请求日志列表 |
| `/admin/logs/state` | GET/POST | 日志采集开关与配置 |
| `/admin/update-status` | GET | 自更新状态 |
| `/admin/check-update` | POST | 检查更新 |
| `/admin/apply-update` | POST | 执行自更新 |
| `/health` | GET | 健康检查 |

**代理池**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/proxies` | GET/POST | 代理池列表 / 添加代理 |
| `/api/proxies/:id` | PUT/DELETE | 更新 / 删除代理 |
| `/api/proxies/:id/check` | POST | 健康检查单个代理 |
| `/api/proxies/check-all` | POST | 全部代理健康检查 |
| `/api/proxies/assign` | POST | 为账号分配代理 |
| `/api/proxies/assignments` | GET | 查看账号代理分配 |
| `/api/proxies/assign-bulk` | POST | 批量分配代理 |
| `/api/proxies/assign-rule` | POST | 按规则分配代理 |
| `/api/proxies/export` | GET | 导出代理池 YAML |
| `/api/proxies/import` | POST | 导入代理池 YAML |

</details>

## 📋 系统要求

- **Node.js** 18+（推荐 20+）
- **Rust** — 源码运行需 Rust 工具链（编译 TLS native addon）；Docker / 桌面应用已内置
- **ChatGPT 账号** — 免费账号即可
- **Docker**（可选）

## ⚠️ 注意事项

- Codex API 为**流式输出专用**，`stream: false` 时代理内部流式收集后返回完整 JSON
- 本项目依赖 Codex Desktop 的公开接口，上游版本更新时会自动检测并更新指纹
- Windows 下 native TLS addon 需 Rust 工具链编译；Docker 部署已预编译，无需额外配置

## 📝 最近更新

> 完整更新日志请查看 [CHANGELOG.md](./CHANGELOG.md)，以下内容由 CI 自动同步。

<!-- CHANGELOG:START -->
### [Unreleased]

**Added**
- **压缩明细面板新增耗时埋点（`duration_ms`/`upstream_ms`）。** 四种结果（成功/预判降级/上游失败/拒绝）统一从同一个入口时间点起算总耗时，成功和失败路径的数字因此可以直接比较；`upstream_ms` 只在真的发起过上游调用时才有值，缺省不是 0 而是"没采集到"。
- **压缩明细面板新增预算降级的估算可信度信息**（用户原话："这个为什么是降级？"）：区分这次估算是字节比例粗筛、真分词器完整算完、还是分词器触发 2000ms 熔断后按已处理比例外推——外推自 20% 和外推自 90% 的可信度天差地别，缺了这个字段就没法判断一次降级是不是误判。粗筛值和最终估算值并存，每条降级记录因此是一个"粗筛 vs 精确"的真实标定样本，以后校准字节→token 比例常数可以直接从生产数据读，不用再靠专门实验人工标定。
- **压缩明细面板：请求 ID 可一键复制，筛选状态（时间范围/结果类型/型号）和当前选中记录同步进 URL。** 刷新或分享链接后能直接还原到同一个视图，排查问题时不用再口头描述"我筛了哪个型号、点了第几条"。
**Changed**
- 修正 7 处此前发现的文档/代码注释与实际行为脱节（TTL/淘汰行为的过时描述、`/health` 容量字段已迁移到受鉴权端点的过时引用、测试文件头部过时的生产默认值、README 里两处互相矛盾的分词器熔断阈值数字），并给 `RecompactFailureCause` 的 13 个取值补上和既有穷尽性守卫同款的编译时约束——新增字面量不同步分类会直接编译失败，不是等运行时才发现。
- **★ 修一个隐蔽 bug：用户在 Claude Code 里选的推理档位，一直被我们自己静默丢弃。** 根因：Claude Code 用 adaptive thinking 时（`thinking:{type:"adaptive"}`，不带 `budget_tokens`）通过 `output_config.effort` 字段传递用户在客户端选的档位（low/medium/high/xhigh/max/ultra）——qa 用 TCP 层抓包证实客户端零配置就在发这个字段。但 `AnthropicMessagesRequestSchema` 顶层对象没有 `.passthrough()`，Zod 默认对未声明字段静默 strip（不是 `.strict()` 报错，是悄悄丢掉），`output_config` 字段在 `safeParse()` 那一刻就没了，业务逻辑从未见过它。效果：不管用户在 Claude Code 里选 `high` 还是 `max`，最终发给 Codex 的永远只是服务端 `default_reasoning_effort` 配置默认值，用户的选择完全不起作用。
  **这条查了三轮才发现，最贵的教训是**：我们自己的请求日志记的是 `safeParse()` 之后的 `parsed.data`，字段已经被吃掉了，日志里天然查不到——**不能靠"生产日志零命中"就断定客户端没发，得去查 schema 本身声明了什么，日志只能证明"解析后有什么"，证明不了"客户端发过什么"**。最终是 qa 绕过应用层直接抓 TCP 层原始 wire body 才实锤。
  三块改动：
  1. schema 补 `output_config` 字段，用 `.passthrough()`（不是只声明 `effort` 就 `.strict()`——这个字段未来还可能带 `format`/`task_budget` 等子字段，`passthrough` 防止同一种"未声明就丢弃"的坑在子字段层面再犯一次）。
  2. `translateAnthropicToCodexRequest` 里的优先级链把 `output_config.effort` 提到最前（> thinking config > suffix > config default）——这是唯一真正来自客户端显式选择的信号，比其余三个来源都可信。
  3. **新增 `clampReasoningEffortToModel`**，把请求到的档位钳制到目标模型 `supportedReasoningEfforts` 真实支持的范围内。这份元数据此前只当展示用的静态信息存着，从没有代码真正读它做判定——**不钳制的后果 qa 已经实测过：不支持的模型收到不支持的 effort，上游不报错也不降级，是连接空转、3 次重试全部超时、502**（`gpt-5.4-mini` + `"max"` 必现，2.2s/次）。现在 `output_config.effort` 真正被采纳后，这个隐患从"理论上可能"变成"用户选 max、模型只到 xhigh 时必现"，必须在这里挡住。钳制触发时打一行 `phase=effort_clamped` 的 warn（带 rid/model/requested/clamped_to/supported）。
  **reviewer2 复审阶段抓出两个真缺陷，同一提交里一并修掉**：`output_config.effort` 为空字符串 `""` 时，`typeof==="string"` 检查能通过，但 `??` 只处理 `null`/`undefined` 不处理空串，会把 `""` 当成"已提供"顶掉整条 fallback 链，最终请求完全不带 `reasoning` 字段发出去——**比这次改动之前更差**（改动前至少还能落到 config 默认值兜底）；纯空白字符串 `"   "` 更隐蔽：它是 truthy，不会被空串判断挡住，会正常进入钳制逻辑，因为不在任何模型的 `supportedReasoningEfforts` 里而被钳到该模型支持的最高档——**等于把一个空白值悄悄升级成 max，不是"处理了"，是悄悄换了语义**。两者都修成：trim 后非空才算"客户端真的提供了"，否则回退到下一优先级；trim 后非空的情况也用规范化（trim 后）的值参与判断。
  **已知残留风险，写在 `clampReasoningEffortToModel` 头部注释里，如实不隐藏**：这次只接了 Anthropic Messages 这一条路径，`/v1/responses` 的直通端点（普通请求和 compact 各一处）仍然直接透传客户端的 `reasoning.effort`，不经过钳制；OpenAI 兼容路径、Gemini 翻译层也没有调用这个函数——这些入口如果收到目标模型不支持的 effort，502 空转的隐患依然存在。本次评估为已知范围外（passthrough 端点的调用方是自己构造请求的高级用户，和 Claude Code 终端用户不是同一类风险敞口，改动面也会明显更大），不是这次顺手漏掉的（`src/types/anthropic.ts`、`src/translation/anthropic-to-codex.ts`、`src/translation/shared-utils.ts`、`src/routes/messages.ts`，新增 20 条定向测试锁住优先级链/钳制边界（含空串/空白串两个 reviewer2 发现的场景）/schema passthrough 行为）。
- **★ 补上 `v2.0.91` 漏掉的分词器熔断修复——不是新特性，是补一个从未真正进入过发布产物的缺陷。** `v2.0.91` 打 tag 之后，qa 门禁复审发现 8.13 那版的 400ms 熔断阈值在真实（非病态）大体积 compact 内容上同样会被触发：用生产真实会话切片（rung3-B，真实 `usage.input_tokens=312,084`，明确在预算内、本该成功）复现——400ms 内只处理了 691500/932680 字符就熔断，退回粗筛（系统性高估 ~33%），导致这个本该成功的会话被误判超限降级。**分词器恰好在最需要它的场景（粗筛怀疑超限、精确估算最该顶上去兜底）被自己的熔断挡住，反而帮不上忙**——和分词器最初要解决的问题（cheap 估算不准导致误判）是同一类问题，只是换了个触发路径。
  developer 在共享工作区改好、qa 也验过，**但那份修复从未提交、从未进入 `v2.0.91` 的 tag**——`v2.0.91` tag 实际指向的提交里这个文件仍是未修复的 400ms 版本，生产 `sha-722e778` 部署的正是这个版本，不是 qa 验证过的那份代码。整条 digest 核对链（`head_sha`、`RepoDigests`）当时全部核对一致，因为**镜像确实和构建产物一致**——不一致的是"验证用的源码"和"进入 tag 的源码"这两者本身。不算灾难：400ms 版本的净效果和 v2.0.90 基本一致（同样被 cheap 的 33% 高估误判，只是每次多等约 400ms 熔断开销），没有比上一版更差，且同一提交里的 Dashboard 成功率功能是好的、已验证生效。这次通过正常提交流程补上，往后 qa 门禁改为直接拉 CI 按 tag 构建出的镜像验证，不允许用工作区/本地 build 的产物代替。
  两个具体改动：
  1. `CUMULATIVE_TIME_BUDGET_MS` 400ms → 2000ms，真实数据验证：rung3-B/rung2-B 两组真实内容（语义内容约 85/93 万字符）在 2000ms 预算下完整跑完、根本不触发熔断（实测 611~634ms），`withinBudget` 恢复正确判定，代价是最坏同步阻塞时间从 ~525ms 升到 ~2125ms——这笔交易划算，compact 不是热路径，2 秒阻塞远小于"误判降级导致用户等 14 分钟全量生成"（v2.0.88 那次真实生产事故）的代价。
  2. 熔断触发时不再无条件丢弃已处理部分，改成按已处理比例外推（已处理比例 < 20% 时才判定样本太小、放弃外推退回粗筛）。**外推是防御性兜底，不是这次修复生效的关键机制**——这两个真实失败案例本身都不需要用到外推路径，改动一（调阈值）已经完全覆盖。外推准确度如实记录：真实内容强制触发外推测得处理比例 17%~72% 区间内误差 7%~18%（不像用均匀重复内容测出的"接近零误差"，根因是真实内容按类型拼接顺序固定、token 密度分布不均匀，"处理了前 N%"是有偏样本），但所有测试点方向都是安全的高估，仍明显好于旧版"熔断即丢弃"。
  另附两条 qa 门禁复审发现的纯文档缺口（不改行为）：`CUMULATIVE_TIME_BUDGET_MS` 是单次 tokenize 调用的预算，不是一次 compact 判断的总预算——`planCompactRequestForBudget` 一次判断最多调用两次，qa 实测最坏总耗时 4025~4280ms，接近单次上界（~2125ms）的两倍，仍可接受，只是把"单次 vs 总耗时"的落差写清楚；Docker 和 Electron 上"编码表加载失败"不是同一种失败模式——Electron 打包没有把 `js-tiktoken` 排除在外，整个包被内联进 `server.mjs`，不存在"文件缺失/损坏"这种失败路径，两边的防御性 `null` 兜底都要留，但不要以为 Electron 上也有 Docker 那种文件系统层面的失败场景（`src/routes/shared/compact-tokenizer.ts`）。
**Fixed**
- **★ 族 A（`not_found`/`expired`，撞在普通续聊请求上）不再是 409——改成 400 + `x-should-retry: false`。** 根因：Anthropic SDK 和 Claude Code 自己的重试逻辑都把 409 当"可重试的锁冲突"无条件重试，而这类失败是确定性的（底层 state 行已经不存在，重试不会有不同结果）——生产实测单个会话最多 134s 静默等待、~10 次指数退避重试，每次重传全部上下文，用户在此期间完全看不到早就正确的"运行 /compact 即可恢复"提示。响应 body 本来就是 `invalid_request_error`（对应 Anthropic 规范里的 400），400 不是发明新码，是把已经写在 body 里的语义和状态码对齐；`x-should-retry: false` 是 `@anthropic-ai/sdk` 自己的机制（在状态码判断之前先读这个头），双保险覆盖只按状态码硬编码判断的边缘重试层。**只对族 A 生效**——`tampered`/`account_mismatch`/9 个致命 store 故障等其余原因语义是"服务端状态有问题"不是"你的请求有问题"，保持 409、不加这个头，避免被误读成客户端参数错误。
- **`recompact_failed_original_account` 这个 409 聚合桶不再对所有死因吐同一句"账号失败，请 /clear"。** 之前不管上游真实原因是什么，落进这个分支只留下同一句聚合文案，事后无法从用户报告反推死因。现在按已有的失败子因（`cause`）分成三桶：容量耗尽（`state_too_large`）建议 /clear 换更小的上下文；并发/协议冲突（`stale_generation`/`preserved_tail_conflict`）说明会自动恢复、不需要 /clear；其余账号/上游失败维持原有的 /clear 建议——不是重新分类，是把已经存在但一直被忽略的字段读出来用。
- **opaque compact 淘汰算法优先逐出结构性废代（已有 successor 的旧记录），不再无差别 LRU。** 修一个 P1 级回归风险：纯 LRU 在 COMMIT 到客户端收到响应之间的窗口可能删掉刚提交、还没被回放确认的 successor edge，破坏崩溃恢复的幂等回放保证。找不到"确定安全可删"的候选时才退化回原来的全局 LRU，行为与修复前一致。
- **Dashboard 压缩明细面板不再假设 `denied` 恒等于 409、恒该建议 `/clear`。** 族 A 记录现在是 400、并发冲突/容量耗尽记录有各自更准确的指引，面板按每条记录的真实 `http_status`/`cause` 给出对应文案，不再用一句固定文案掩盖三种性质完全不同的失败。

### [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

**Added**
- 原生 function_call / tool_calls 支持（所有协议）
**Fixed**
- 格式错误的 chat payload 返回 400 `invalid_json` 错误
<!-- CHANGELOG:END -->

## ☕ 赞赏 & 交流

觉得有帮助？请作者喝杯咖啡，或加入微信交流群获取使用帮助。二维码见 [页面顶部](#)。

## 🙏 贡献致谢

Codex Proxy 主要由个人维护，但一路上收到了很多社区帮助。特别感谢这些通过代码、文档、修复或 PR 参与建设的贡献者：

[@SsuJojo](https://github.com/SsuJojo) · [@TutuchanXD](https://github.com/TutuchanXD) · [@kanweiwei](https://github.com/kanweiwei) · [@et2010](https://github.com/et2010) · [@d-demand-priv](https://github.com/d-demand-priv) · [@hangox](https://github.com/hangox) · [@jarvisluk](https://github.com/jarvisluk) · [@jeasonstudio](https://github.com/jeasonstudio) · [@JPClaw12](https://github.com/JPClaw12) · [@lezi-fun](https://github.com/lezi-fun) · [@lookvincent](https://github.com/lookvincent) · [@pocper1](https://github.com/pocper1) · [@woai66](https://github.com/woai66) · [@xsShuang](https://github.com/xsShuang) · [@yuwei5380](https://github.com/yuwei5380)

也感谢所有在 [Issues](https://github.com/icebear0828/codex-proxy/issues) 里提交 bug 复现、日志、兼容性反馈和功能建议的用户。这些反馈直接推动了账号轮换、代理兼容、Dashboard、Ollama Bridge、模型兼容和错误观测等能力的迭代。

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=icebear0828/codex-proxy&type=Date)](https://star-history.com/#icebear0828/codex-proxy&Date)

## 📄 许可协议

本项目采用 **非商业许可 (Non-Commercial)**：

- **允许**：个人学习、研究、自用部署
- **禁止**：任何形式的商业用途，包括但不限于出售、转售、收费代理、商业产品集成

本项目与 OpenAI 无关联。使用者需自行承担风险并遵守 OpenAI 的服务条款。

---

<div align="center">
  <sub>Built with Hono + TypeScript + Rust | Powered by Codex Desktop API</sub>
</div>
