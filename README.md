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
- root compact 静默降级为普通生成事件补结构化日志（生产数据：16 例观测的 root compact 尝试里 3 例、约 19%，命中这条路径，此前**零可诊断信息**）：`messages.ts` 的 `respondWithOpaqueCompactMarker` 抛错后，若既不是 store 级故障（`reportOpaqueCompactStoreFault` 返回 `null`）、也不是"原账号重新 compact 失败"（`opaqueRestore.restored` 为 `false`，即会话第一次 compact），代码此前会直接跌出 `if`、请求原样继续走普通生成——这个 200 路径的 fallback 行为**本身不在这次改动范围内**，是否要修 19% 静默降级要等有了下面这份数据再决策，这次只补日志，唯一改动的可观测行为是"打印了什么"。此前唯一的痕迹是一行只打印固定不变的 `error.name`（恒为 `"CompactServiceError"`）的 `console.warn`，对诊断"为什么失败"没有任何信息量。改法：① `console.warn` 补上 `error.message`；② 新增 `recordOpaqueCompactFallback`（`opaque-compact-fallback-log.ts`）把 `rid`/`model`/`input_items`/`conv_hash`/`account_hash`/`generation`/`error_name`/`error_message` 结构化落进 `error-log.jsonl`，root compact fallback 分支里调用一次。**没有复用 8.6 的 `recordOpaqueCompactDenial`**：团队倾向复用同一收口点（自动继承字段白名单约束），但读了它的文档才发现设计冲突——`recordOpaqueCompactDenial` 明确"不接受自由文本，自由文本容易被手滑塞进 marker 片段"，而这次要记的核心信息恰恰是上游自由文本 `error.message`，塞进一个专门设计成拒绝自由文本的函数是在破坏它的不变式；语义上也不同类，`recordOpaqueCompactDenial` 文档明确是"409 / fail-closed 决策"，这次的事件请求仍以 200 成功。于是新开一个语义准确的函数，但原样搬了同一套基础设施（`appendErrorLog` + `auditAccountTag`/`auditSessionTag` 派生哈希 + 函数签名强制白名单纪律）。**`error.message` 敏感性判断**（不是假设安全，是追完了来源链路）：`CompactServiceError.message` 最终来自 `CodexApiError.message`（`Codex API error (${status}): ${detail}`，`detail` 取自上游 HTTP 错误 body 的 `.detail`/`.error.message`，JSON 解析失败时退化为整段原始 body），本质是上游服务对失败原因的分类描述而非设计上会携带用户 prompt 内容的字段——但也没有代码保证过这一点。更直接的证据：`proxy-error-handler.ts` 的 `handleCodexApiError` 早有一个 `safeLog` 参数，`executeCompactOnly` 调用时传的正是 `true`，专门把 `err.message` 从相邻一行 `console.error` 里隐藏掉，注释写的原因就是"opaque compact 等受隐私合同约束的调用方"——同一来源的内容，团队此前已经做过一次"不完全信任"的判断。另外发现 `appendErrorLog` 顶层 `error.message` 字段**不经过** `redactJson`（只有 `context` 会），所以这次新函数把上游自由文本严格限制在 `context.error_message` 里，顶层 `error` 只放受控分类字符串。基于以上判断：`error.message` 落盘前一律先过新增的 `sanitizeFreeTextForLog`（`redact.ts`）——marker 值级脱敏（防止 opaque marker 通过错误文本回显泄漏）+ 截断到 300 字符（`redactJson` 只按 key 名/marker 值模式匹配，对未知形态的敏感内容没有通用防护，截断至少把最坏情况暴露面从"整段上游 body"收窄到一个有限窗口），`console.warn` 与结构化日志共用同一份处理，不是两套逻辑。配套测试：`sanitizeFreeTextForLog` 本身（短文本原样、marker 整体替换不留残片、超限截断并标注原始长度、恰好等于上限不截断）；`recordOpaqueCompactFallback` 白名单穷举 + hash 字段行为（镜像 8.6 既有测试模式）+ error_message 专属（marker 不泄漏、超长截断、隐私 canary 扫描）；e2e 层扩展既有的"first compact failure safely falls back to the original messages path"用例，锁定 fallback 行为完全不变（仍 200、仍只多打一次非 compact 上游请求）的同时新增断言 `console.warn` 真的带上了注入的错误文本、`recordOpaqueCompactFallback` 确实以正确参数被调用了一次（`src/routes/messages.ts`、`src/routes/shared/opaque-compact-fallback-log.ts`，新文件、`src/logs/redact.ts`、`tests/unit/logs/redact.test.ts`，新文件、`tests/unit/routes/opaque-compact-fallback-log.test.ts`，新文件、`tests/e2e/messages.test.ts`）
- 排查 19% root compact 静默降级期间，用户要求"缺少定位的日志都补回去"，把范围从单一 `phase=fallback` 扩大到整条 compact 调用链路的可观测性扫描，找到并补上以下盲点（**全部只加日志/诊断字段，不改任何分支决策或重试策略**）：
  1. **`status=0` 之谜**（qa 在客户端侧实际观测到的现象）——`proxy-error-handler.ts` 的 `handleCodexApiError` 有个 `safeLog` 参数，`executeCompactOnly` 调用时传 `true`；这个开关设计初衷是"opaque compact 受隐私合同约束的调用方不能明文账号标识"，但实现上把 `err.message` **整段**一起吞掉了，而不只是账号标识——后果是 opaque compact 遇到 transport 层异常（`CodexApiError(0, msg)`，超时/连接重置/TLS 失败等）时，唯一的 `console.error` 只剩 `status=0`，连是哪一类网络故障都分不出来。改法：账号标识仍然受 `safeLog` 控制（未变），但 `message` 一律打印，只是要先过新增的 `sanitizeFreeTextForLog`（见下）——两者被同一个开关误绑在一起，这次拆开。
  2. **账号获取失败无上下文**——`account-acquisition.ts` 的 `acquireAccount()` 返回 `null` 时只打"No available account"，看不出是池子本来就空、还是全员限流/封禁、还是这次调用把候选集合排除到只剩零个。改法：调用 `pool.getPoolSummary()`（Dashboard 账号池概览本来就在用的同一个方法）把 `total/active/expired/quota_exhausted/rate_limited/refreshing/disabled/banned` 六项聚合计数拼进警告行，外加"已排除 N 个已试过的账号"。全部是聚合计数，不含任何账号标识，这个函数被应用里所有账号获取路径共用，改动全局生效。
  3. **`withRetry` 只讲重试、不讲放弃**（`utils/retry.ts`，compact 走 `executeCompactOnly` 内部这条重试）——此前只有"即将重试"那一行 `console.warn`，"不可重试所以立即放弃"和"重试次数耗尽后放弃"两种终止路径完全没有日志，直接 `throw`。补一行 giving-up 警告，标注是哪一种终止、第几次尝试、状态码、以及脱敏后的错误消息。
  4. **`executeCompactOnly` 内部四处终止路径此前零日志**（`codex-compact-service.ts`）：① 一开始就没有可用账号（`phase=compact_no_account`）；② `requiredEntryId` 与实际拿到的账号不一致、跨账号 compact 被拒（`phase=compact_account_mismatch`，账号标识走 `auditAccountTag`，不落明文）；③ 非 `CodexApiError` 的意外异常，此前和"上游分类后决定不重试"完全混在一起分不清（`phase=compact_unexpected_error`）；④ 上游错误分类为不可重试、或跨账号重试被禁止，因而不进入重试循环（`phase=compact_abort`，带 `reason`/`status`/已尝试账号数）；⑤ 重试到账号池耗尽后放弃（`phase=compact_giveup`）。同时把已有的 `phase=account_retry` 从只打 `acct` 扩成带上 `prev_status`（这次触发重试的上游状态码）与 `tried`（累计尝试账号数）。`CompactServiceError` 新增可选的 `retryCount` 字段（这次失败之前一共拿过多少个不同账号），从抛出点一路带到 `messages.ts` 的 `console.warn` 与 `recordOpaqueCompactFallback` 的 `retry_count` 字段——非 `CompactServiceError` 的错误没有这个概念，诚实地留 `undefined`/`null`，不强行凑一个 0。
  5. **检查过、判断不需要动的地方**（如实记录避免重复排查）：`opaque-compact-bridge.ts` 的 `restoreOpaqueCompactRequest` 早已有 `phase=state_rejected reason=${stateError.reason}`，reason 是结构化分类值，诊断信息完整；WebSocket 降级到 HTTP SSE 那条路径（`ws-transport.ts:336`）本来就不是隐私受限路径（不受 `safeLog` 约束），失败时已经用 `console.warn` 打印真实的 `err.message`，不是盲点。
  新增的 `sanitizeFreeTextForLog`（复用 `messages.ts` 里 root compact fallback 那次已经建立的判断依据）现在被 `proxy-error-handler.ts`/`utils/retry.ts`/`codex-compact-service.ts` 三处共用，同一份脱敏逻辑不重复实现。配套测试：`retry.ts` 新增 3 条（giving-up 警告区分非重试/耗尽两种终止、marker 不泄漏）；`proxy-error-handler.ts` 新增 3 条（`safeLog=true` 时账号标识仍脱敏但 message 现在打印、`safeLog=false` 不受影响、marker 不泄漏）；新增 `tests/unit/routes/shared/codex-compact-service-diagnostics.test.ts`（7 条，覆盖上述五个新 phase 标记 + 增强后的 `account_retry`，通过 mock `buildCodexApi`/`AccountPool` 直接驱动 `executeCompactOnly` 的各条终止路径，不依赖真实网络）；`account-acquisition.test.ts` 新增 2 条（池状态构成确实拼进警告、无 `tag` 时确实不调用 `getPoolSummary`），并给两个既有测试文件的 mock pool 补上 `getPoolSummary`（`account-acquisition.test.ts`、`non-streaming-empty-response-retry.test.ts`，此前的 mock 没有这个方法，加了新分支后会直接抛 `TypeError`）（`src/routes/shared/proxy-error-handler.ts`、`src/routes/shared/account-acquisition.ts`、`src/routes/shared/codex-compact-service.ts`、`src/routes/messages.ts`、`src/routes/shared/opaque-compact-fallback-log.ts`、`src/utils/retry.ts`、`tests/unit/utils/retry.test.ts`、`tests/unit/routes/shared/proxy-error-handler.test.ts`、`tests/unit/routes/shared/codex-compact-service-diagnostics.test.ts`，新文件、`tests/unit/routes/shared/account-acquisition.test.ts`、`tests/unit/routes/shared/non-streaming-empty-response-retry.test.ts`、`tests/unit/routes/opaque-compact-fallback-log.test.ts`）
- root compact 静默降级用户可查两条腿（用户拍板：会话内实时提示做不到——Claude Code 只显示"✻ Conversation compacted"，摘要本身不展示给用户，压缩进度条是客户端画的，插不进任何提示——所以只能做"事后可查"）：① **Dashboard 可见**：Errors 页新增一个 amber 警示 banner，命中条件是 `error-log.jsonl` 里存在 `error.name === "OpaqueCompactFallback"` 的分组（即 `recordOpaqueCompactFallback` 写的记录）。**复用了既有的 `/admin/error-logs` 分组数据和 `useErrorLogs()` hook，没有新开接口/新的埋点面**：`groupErrorLog` 本来就按 `name + 首个 stack frame` 分组，这类事件没有 stack，天然全部落进同一组，`group.count` 就是命中次数，`group.sample_context` 就是最近一次事件的完整上下文——`computeCompactFallbackSummary`（`ErrorsPage.tsx`）只是从这份既有数据里挑出 `count`/`last_seen`/`model`/`input_items`/`error_message`/`retry_count` 六项渲染成人类可读的 banner，字段来源与本轮第一条已经确立的白名单完全一致，没有引入新字段。banner 回答"最近撞过降级吗"（次数 + 相对时间）、"规模多大"（`input_items`）、"为什么"（`error_message`，已经过 `sanitizeFreeTextForLog`）、"重试了几次"（`retry_count`）。**没有做"成功/降级比率"**：`appendErrorLog` 语义上是错误日志，没有对应的"成功 compact"埋点，做真正的比率需要新开一个成功事件的埋点面，不是"复用现有数据"能低成本做到的，这次刻意跳过，只给命中次数和时间——不达标的部分如实标注在函数文档里，不是悄悄阉割。② **响应 header**：`x-codex-proxy-compact-fallback: 1`，只在真的走了 root compact fallback 分支时打在最终响应上（`COMPACT_FALLBACK_HEADER`，`messages.ts`），用户看不到，排查某次具体请求是否命中降级时不用去翻日志对时间戳。两条都是纯附加可观测性，不改响应本身的 status/body/流式行为。
  **顺手修了一个 reviewer 此前标注"确认一处、未穷举全部 7 个调用点"的既有风险**：`stream-close-event.ts` 的 `recordStreamCloseEvent`（premature stream close / client abort 的结构化落盘，7 个调用点遍布 `responses.ts`/`streaming-handler.ts`/`response-processor.ts`/`non-streaming-premature-close.ts`/`direct-request-handler.ts`）此前把调用方传入的 `detail`（底层异常的自由文本描述）原样拼进 `message`，落进 `appendErrorLog` **顶层** `error.message`——这个字段和 8.6/本轮第一条已经确认过的坑一样，**不经过 `redactJson`**（只有 `context` 会）。这条风险这次才真正有展示面：`ErrorsPage.tsx` 把 `group.message` 直接渲染在 Dashboard 上，就是这次要新加 banner 的同一个组件——继续放着不修，等于我自己往这个刚确认过一次漏洞的展示面上又加了一层曝光。判断依据：这不是"可能相关"，是同一个文件、同一个渲染路径，修复成本也低（复用第一条已经写好的 `sanitizeFreeTextForLog`，改动集中在 `recordStreamCloseEvent` 一个函数，不用碰 7 个调用点各自的代码）。改法：`detail` 在函数入口处统一 sanitize 一次，结果同时用于构造顶层 `message` 和写入 `context.detail`（`normalizeStreamCloseErrorForDisplay` 展示时优先读 `context.detail` 重建 message，所以两处都要覆盖，不能只改一处），in-memory 审计日志（`enqueueLogEntry` 的 `error` 字段）复用同一份结果，不是两套脱敏逻辑。**顺手发现但这次没有修的另一个问题**：同一批调用点里 `context.accountEntryId` 传的是明文 `entryId`（未经 `auditAccountTag` 哈希），`redactJson` 的 `SECRET_KEY_RE` 不按 "accountEntryId" 这个 key 名匹配，所以这条也不受保护——但这是团队没问过的第二个、独立的问题（reviewer/team-lead 这次只点名了 `error.message`），且修法要动 7 个调用点各自传的值而不是一个共享函数，改动面明显更大，**如实标注、不顺手扩大范围**，留给团队决定要不要单独立项。配套测试：`stream-close-event.test.ts` 新增 4 条（marker 不会原样落进顶层 message 或 `context.detail`、超长 detail 截断、audit log 复用同一份脱敏结果不是第二套逻辑、正常 detail 不受影响）；`ErrorsPage.tsx` 新增 `errors-page.test.tsx`（7 条：`computeCompactFallbackSummary` 的字段提取/缺省降级/类型校验 + banner 渲染/不渲染/字段缺失时优雅省略）；`messages.test.ts` 扩展既有 fallback e2e 用例断言 header 确实为 `"1"`，新增一条成功 compact 场景断言 header 确实缺席（不是恰好没测到）（`src/logs/stream-close-event.ts`、`tests/unit/logs/stream-close-event.test.ts`、`src/routes/messages.ts`、`web/src/pages/ErrorsPage.tsx`、`web/src/pages/__tests__/errors-page.test.tsx`，新文件、`shared/i18n/translations.ts`、`tests/e2e/messages.test.ts`）
- 另一起生产事故补结构化日志 + 爆炸半径回归测试：`OpaqueCompactDenied x94`（reason: `store_unavailable`），7 个会话里有一个（`eb77c2b0`）在 49 分钟内撞了 77 次同一个 409（指数退避 8s→9s→11s→…→46s），根因至今查不到——`store_unavailable` 是 `toStateError()`（`opaque-compact-state.ts`）遇到不认识的错误时的兜底分类，此前这个函数的兜底分支 `new OpaqueCompactStateError("store_unavailable")` **完全不引用原始 `error`**，原始异常内容在分类的这一刻就已经永久丢失，不是下游哪个日志函数漏接了它——`console.warn` 打印的 `detail` 只是原始异常在被丢弃前的最后一份副本，不是根因本身。**排查过是否只有一个产生点**（团队要求核实，不是照抄）：确认有三条独立的故障上报路径，三条都修了——启动路径（`startOpaqueCompactRuntime()` 的 catch 块 → `fail(token, reason, detail)`，运行时启动失败或 Admin 热切换失败时触发）、运行路径（一个存活请求命中致命错误 → `toStateError()` 包装 → `messages.ts` 捕获 → `reportOpaqueCompactStoreFault(error)` → `runtimeFaultHandler`/`reportOpaqueCompactRuntimeFault`，已运行的 store 中途发现致命故障时触发），以及 **reviewer 复审时数出的第三条**——`startOpaqueCompactRuntime()` 冷启动 `recover()` 发现不可读记录时的 `recover_unreadable` quarantine 分支（`setOpaqueCompactStateUnavailable("state_corrupt")`，此前既不带 `detail`、也没调用 `recordOpaqueCompactRuntimeFault`，是本轮初版遗漏的第三个 sink，通过对全部 `setOpaqueCompactStateUnavailable(` 调用点逐一核对才找全，不是靠猜）。这条分支旁边已有一行内容丰富的 `console.warn`（`unreadable=/retained=/isolated=/files=/marker=`），因此这次只是把同一批已经判断过安全的计数/布尔值（`recovered.unreadable`/`recovered.retained`/`quarantined.ok`/`quarantined.moved.length`/`quarantined.markerWritten`，以及接口文档已标注"不含敏感内容"的 `quarantined.error`）接进 `detail`，不是新引入信息、也没有把整行原样塞进去——`quarantined.directory`（绝对路径）刻意不放进去，即便它只是本地 data 卷内部路径，跟其余字段"零路径"的一致性优先。且启动路径顺手发现一个真实 bug：这里此前构造 `detail` 用的是 `error.name`，但这批自定义 Error 子类（`OpaqueCompactStoreLockError`/`OpaqueCompactKeyringError`/`OpaqueCompactRepositoryError` 等）的 `.name` 在构造函数里硬编码成固定的类名字符串，同一个类的每次失败都打印同一句话，真正的描述性文本在 `.message` 里——这不是团队最初描述的"原始异常文本，可能含路径/DB 内容片段"，而是此前从未真正生效过的诊断字段，已一并修正为 `${error.name}: ${error.message}`。**detail 敏感性判断**：追到底是各子系统的 `Error.message`（keyring/repository/sentinel/lock/quarantine），可能含文件路径或畸形数据片段，因此和 8.6/root compact fallback 两条先例一致，一律先过 `sanitizeFreeTextForLog`（marker 脱敏 + 300 字符截断），只放进 `context.detail`，绝不进顶层 `error.message`（不经过 `redactJson`）、绝不拼进任何客户端可见响应体（`getOpaqueCompactStateReadiness()` 文档注释已显式标注这条边界）。**是否给 `recordOpaqueCompactDenial` 加 detail 字段**（团队委托的决策）：加了——这是用户真实撞上的 94 次 409 的同一个落点，`reason` 仍保持受控分类不变，`detail` 作为新增的、单独脱敏的显式例外字段，和 `opaque-compact-fallback-log.ts`/新增的 `opaque-compact-runtime-fault-log.ts` 同一套先例，没有破坏"拒绝自由文本"的白名单纪律。改法：`OpaqueCompactStateError` 新增可选 `detail` 字段；`toStateError()` 的全部 9 处构造（8 个具名 reason 分支 + 两处 `store_unavailable` 兜底）统一传入 `error.message`；module 级 `runtimeUnavailableDetail` 随 `runtimeUnavailableReason` 一起维护；`getOpaqueCompactStateReadiness()`/`reportOpaqueCompactStoreFault()`/`setOpaqueCompactRuntimeFaultHandler` 的返回值与签名相应扩展；`messages.ts` 全部 4 个消费 `readiness`/`opaqueRestore.error`/`reportOpaqueCompactStoreFault` 返回值的调用点一并透传 `detail`；新增 `recordOpaqueCompactRuntimeFault`（`opaque-compact-runtime-fault-log.ts`，新文件）单独承接 store 故障转移这个"每次故障发生一次"的事件（区别于每次请求都打一条的 `recordOpaqueCompactDenial`），启动/运行两条路径都调用它。**爆炸半径回归测试**（新增 `tests/e2e/opaque-compact-fault-blast-radius.test.ts`）：用真实 `startOpaqueCompactRuntime()` + 真实 SQLite repository + 真实 Hono 路由，在 repository 边界（`OpaqueCompactRepository.prototype.load`）注入一个任意的、未预料的普通 `Error`（不是任何具名子类，专为 `toStateError()` 兜底分支设计），断言：store 被全局摘掉（`getOpaqueCompactStateReadiness()` 全局 not-ready）；后续请求——包括从未碰过故障 marker 的其它会话、甚至全新会话的全新 root compact 尝试——全部 409，不局限于触发故障的那一个请求；多次重试（模拟 49 分钟/77 次的重试模式）故障持续存在、不会自愈；新增的两条结构化日志（`recordOpaqueCompactDenial`、`recordOpaqueCompactRuntimeFault`）都真的带上了原始注入异常的文本内容；同时反向断言这段原始异常文本绝不出现在客户端可见的响应体里。这条测试不测分类函数本身（既有测试已穷举），只固化"分类之后，一次故障的影响范围有多大"这件事——此前 `store_unavailable`/`reportOpaqueCompactStoreFault`/`isFatalStoreFailure` 在 `tests/` 里零直接覆盖，只有一条注释提到过。**这一轮明确不改故障恢复行为**：是否给瞬时性 store 故障加自动恢复路径是尚未拍板的设计权衡，这次只做"能查到根"（detail 落盘）和"防回归"（爆炸半径测试），不新增、不修改任何自愈/重试逻辑。配套测试：`opaque-compact-runtime-fault-log.test.ts`（新文件，6 条：白名单字段/`phase` 区分 startup 与 runtime/`detail` 缺省为 `null`/marker 脱敏/超长截断/落盘失败不冒泡）；`opaque-compact-denial-log.test.ts` 扩展（`detail` 字段的白名单归位、缺省为 `null`、marker 脱敏、超长截断）；`opaque-compact-denial-log-integration.test.ts`/`opaque-compact-lifecycle.test.ts`/`opaque-compact-persistence.test.ts` 三个既有文件的白名单穷举断言与 `getOpaqueCompactStateReadiness()` 精确匹配断言相应扩展以容纳新增的 `detail` 字段；新增 `opaque-compact-runtime-quarantine-detail.test.ts` 专测第三个 sink（reviewer 复审后补）——不重复测 quarantine 机制本身（既有覆盖范围之外），只用真实 `node:sqlite` bit-flip 一条已保存记录的 `ciphertext`（不是 mock），让 `recover()` 真的认证失败触发 `recover_unreadable`，断言 `readiness.detail` 与新的 `OpaqueCompactRuntimeFault` 日志都带上诊断内容且只含计数/布尔值，不含目录路径/marker/密文原文（`src/routes/shared/opaque-compact-state.ts`、`src/routes/shared/opaque-compact-runtime.ts`、`src/routes/shared/opaque-compact-runtime-fault-log.ts`，新文件、`src/routes/shared/opaque-compact-denial-log.ts`、`src/routes/messages.ts`、`tests/unit/routes/opaque-compact-runtime-fault-log.test.ts`，新文件、`tests/unit/routes/opaque-compact-denial-log.test.ts`、`tests/e2e/opaque-compact-denial-log-integration.test.ts`、`tests/e2e/opaque-compact-lifecycle.test.ts`、`tests/unit/routes/opaque-compact-persistence.test.ts`、`tests/e2e/opaque-compact-fault-blast-radius.test.ts`，新文件、`tests/unit/routes/opaque-compact-runtime-quarantine-detail.test.ts`，新文件）
- lint 式回归守卫：禁止「把 `Error.name` 当诊断内容用、丢掉 `.message`」这个写法在生产代码里重新出现。这个模式在本仓库已经真实复发过（不是假设性风险）：① `opaque-compact-runtime.ts` 的 `fail()`——`detail` 曾取 `error.name`，这批自定义 Error 子类的 `.name` 在构造函数里硬编码成固定类名，诊断字段从写下第一天起就从未真正生效过（已修，见 `7c807cc`）；② 更早还有一条"空转测试"（测一个被测函数根本不读的字段）。共同形状：**代码在，行为不在**，不会报错、不会让测试变红，只有真出事查日志时才发现手里什么都没有。用 TypeScript 编译器 API（`ts.createSourceFile` + AST 遍历，沿用本仓库 `*-boundary.test.ts` 系列已建立的"lint 式测试"写法，不是新引入的工具）在 `tests/unit/lint/error-name-as-diagnostic.test.ts` 里加一条规则：命中 `X instanceof Error ? X.name : <fallback>` 这个三元表达式形状，**且**同一个 catch 子句作用域内 `X.message` 没有在任何地方被访问过时判定违规。刻意不做更宽的"禁止一切单独出现的 `.name`"——那种规则做不到机械且不误伤：`.name` 用于分类判断（`error.name === "XxxError"`）、日志分组、错误类型路由都是正当用法，分辨"这次访问是不是打算当成诊断内容"需要理解意图，语法穷举不了；本仓库 `messages.ts`/`codex-compact-service.ts` 就有"同一个 catch 块分别捕获 `.name` 和 `.message` 存进两个变量"的合法写法，误伤会制造"改动被规则挡住所以只好加 `// eslint-disable`"的空转规则，比没有规则更糟。红/绿验证：先在**不修复现有代码**的状态下跑过一次 `src/` 全量扫描，规则精确报出 4 处真实违规（见下），确认规则本身先在真实代码上验证过命中能力，不是只在合成用例里自证；随后逐一修复，复跑转绿。规则精确度另有 7 条独立单测（合成源码字符串输入，不依赖真实文件）：命中两处真实 bug 形状（含"锁住已修复的第 1 处写法，防止被改回去"）、命中同一文件两条独立违规各自计数、不误伤"同一 catch 块分别捕获 name/message"、不误伤"`${error.name}: ${error.message}` 拼在同一模板字符串里"、不误伤"`.name` 只做分类判断"、不误伤"三元表达式判断的不是 `instanceof Error`"。**扫描过程中额外发现两处此前没人提过的真实实例**（不是团队原始描述的范围，是这次全量扫描顺带扫出来的）：③ `opaque-compact-quarantine.ts` 的 `quarantined.error`（`mkdirSync`/`renameSync` 失败时取 `.name`，Node 的 `fs` 错误 `.name` 恒为常量 `"Error"`，真正含路径的描述在 `.message` 里，诊断价值同样是零——**这里刚好因为是常量所以不会泄漏路径，但诊断价值和第 1 处同构，判断修**：改成 `${error.name}: ${error.message}`，接口文档同步更新为"可能包含本地文件路径"，调用方 `opaque-compact-runtime.ts` 已经在用 `sanitizeFreeTextForLog` 处理这个字段，不需要额外改动消费端）；④ `admin/settings.ts` 里 `reconfigureOpaqueCompactRuntime` 失败分支（Admin 热切换时 `closeCurrentOpaqueCompactRuntime()` 抛错的 `console.warn`，同样只取 `.name`，改法一致，新增经 `sanitizeFreeTextForLog` 脱敏再打印）；⑤ `opaque-compact-store-lock.ts` 的 `probeOpaqueCompactStoreLock`（探测锁状态用，`reason` 字段同样只取 `.name`）——核实过这个函数目前在生产代码里**没有任何调用方**（未接线的死代码），改动零行为风险，但同样修正，不留一个"只因为没人用才安全"的写法在代码里让规则被迫放行。不改任何运行时行为/控制流，只改错误诊断字段的内容（`tests/unit/lint/error-name-as-diagnostic.test.ts`，新文件、`src/routes/shared/opaque-compact-quarantine.ts`、`src/routes/admin/settings.ts`、`src/routes/shared/opaque-compact-store-lock.ts`）
  **reviewer 复审时实测验证了"这条规则能不能挡住当初真正那个 bug"**（团队指定的核心问题，不是走个流程）：直接 `import` 本次真实导出的 `findNameOnlyDiagnosticViolations` 函数（不是照描述重写一份），拿它去扫事故起因那行的**真实历史版本**（`7c807cc~1` 的 `opaque-compact-runtime.ts:403`：`return fail(token, reason, error instanceof Error ? error.name : "UnknownError");`），结果精确命中、行号对得上。这条三元表达式是**直接当函数实参传进去的**（没有先赋值给中间变量）——规则在整棵 AST 里找符合形状的 `ConditionalExpression` 节点，不要求赋值语句，因此照样命中。**这条规则确实能挡住当初那个 bug，不是只挡得住教学案例的空转规则**——这句话现在有实测证据支撑，不是自证。
  **补一处 reviewer 发现的注释失真**（`opaque-compact-runtime.ts` 的 `recover_unreadable` quarantine 分支，第三个 sink 那次改动留下的）：detail 构造逻辑旁边的注释此前写着"`quarantineOpaqueCompactStore` 自己文档化过『不含敏感内容』的 `error`"——但这句话已经被**同一个 commit**（`ccbb824`）自己推翻：`quarantined.error` 从只取 `.name` 改成 `${error.name}: ${error.message}` 后，接口文档同步改成了"可能包含本地文件路径"，`opaque-compact-runtime.ts` 却完全没被这次改动碰到，注释的依据因此在合并的同一刻就已经失真——代码行为一直是对的（照样过了 `sanitizeFreeTextForLog`），但注释引用了一个已经不成立的前提，下一个读者会基于假前提做判断。**这和 `.name` 死字段是同一类问题，只是载体从代码变成了注释**，因此不等"下次顺手改"，这轮就修：理由改成实际站得住的那个——"这里不依赖上游保证 `error` 字段不含敏感内容（那类保证已经在这次改动里被推翻过一次），一律先过 `sanitizeFreeTextForLog` 才放行，脱敏是唯一的安全依据，不是锦上添花的双保险"。纯注释修正，不改任何行为，`tsc`/全量测试复跑确认零回归（`src/routes/shared/opaque-compact-runtime.ts`）
- ...（[查看全部](./CHANGELOG.md)）
**Changed**
- **compact 预算预判换成真分词器（`js-tiktoken` + `o200k_base`），字节比例估算连续两版（2.18→2.70）都没能根治的误差问题，这次从根上解决。** 起因：固定比例这个模型本身就不对——真实 chars/token 因内容成分（中文/英文/代码/base64）而异，波动区间宽到没有一个常数能同时拟合，无论怎么调整这个常数都只是换一个误判点。评估阶段用 4 组真实样本验证：直接对整个 JSON 请求体 tokenize 误差仍有 8~16%（JSON 语法本身——引号、花括号、字段名——会被当内容 token 化，而上游大概率不是逐字节 tokenize 我们发的 JSON），改成"只 tokenize 抽出来的语义内容 + 每 item 固定结构开销（4 token，4 组样本实测 2.86~5.94 波动）"，误差收窄到 <0.5%。
  **两级估算，不是直接上分词器**：正常大小的会话，字节比例粗筛（继续保持系统性偏高，充当第一道门槛）就能判定在预算内，永远不会触发分词器加载；只有粗筛怀疑超限时才懒加载分词器（`import()` 编码表，~2.3MB，进程级单例，只加载一次）重新精算——这一步存在的意义正是修 terra/2.70 那类"粗筛本身就估错了"的误判：粗筛说超了不代表真的超了，精确估算才是真正拍板的依据。含图片的请求整体跳过精确估算强制走粗筛（base64 字节数和真实 image token 数几乎无关，没有真实数据支撑给图片一个固定估算值，粗筛对图片天然保守）。精确估算之上叠加 3% 安全边际（分词器模拟的是 OpenAI 公开的 o200k_base 编码表，不是上游内部真正计费用的那一套，看不到也无法验证两者是否逐字节一致）。选 `js-tiktoken`（纯 JS，~2.3MB）不选 `tiktoken`（WASM，~7.9MB 但快 3 倍）：compact 不是热路径，速度优势换不回桌面版打包多出的 ~5.6MB；选 `o200k_base` 不选 `cl100k_base`：同一套模型换成后者误差从 <0.5% 恶化到 4.31~6.80%，实测确认，不是照着"应该是 GPT-4o 那套"猜的。
- **★ 分词器引入的 O(n²) 级 DoS 漏洞——实现阶段写单测时测试套件直接挂起才炸出来的，评估阶段五个维度（准确度/编码/性能/体积/测试策略）没有一个能暴露它。** `js-tiktoken` 对高度重复内容有灾难级病态性能，同步调用、单线程 Node 下会卡死整个事件循环，等于给这条估算路径开了一个能拖死全进程的 DoS 面，不是"这次估算变慢"。
  **第一版修复被 reviewer 实测打回，值得记录这个反转过程**：最初的方案是"枚举哪些输入病态"（检测周期 1~4 的重复游程），reviewer 复审用真实数据证明这个思路本身是错的，不是参数没调对——周期 5~20 的重复同样卡死（3.4~4.8 秒量级，和周期 1 同一数量级，检测完全没拦住）；更关键的是同样"单字符重复"，`"0"` 几乎瞬间完成，但 `"x"`/`"a"`/`" "`/`"-"`/`"."` 全都要 3.6~4.1 秒——触发条件和 BPE 内部合并次数相关，不是"重复周期长度"这个维度能刻画的；补测进一步发现多字节字符更糟，emoji（🎉）在 UTF-16 长度 2000 下要 1974ms，同等长度下比 ASCII 慢 10 倍以上，中文、带重音字符同样明显更慢。**结论：不存在一个"检测这些模式就够了"的清单，继续按"发现新病态模式→加进检测清单"这个方向修，本质是在打地鼠。**
  最终策略反转成"不枚举哪些输入危险，而是限制最坏情况能有多坏"：分块 encode（500 UTF-16 code unit 一块）+ 块间累计耗时熔断（400ms），超了立即放弃、返回 `null`，调用方回退到粗筛比例估算（和分词器加载失败、含图片时完全同一条路径）。这个策略对"什么样的内容触发病态"完全不敏感，不需要理解 BPE 行为，因为最坏情况的时间上界只取决于块大小这一个固定可控的量，不取决于块里装的是什么内容——全程最坏总耗时上界约 400+125=525ms，无论内容形状如何都不会突破这个量级。WASM 版 `tiktoken` 同类测试量级更好但增长速率同样劣于线性，这层防护对两种实现都需要，不是"换 WASM 就能解决"的问题。
- **Dashboard 新增快速压缩成功率统计**（用户原话："我想加一下，就是成功率有多少，这样的话我方便我看"）。前提问题：此前成功事件只打 `console.log`，容器一重启历史全丢（生产当天已经重启三次）——新增独立文件 `compact-outcomes.jsonl`（复用 `error-log.jsonl` 已验证过的按字节轮转机制，但字节上限独立配置，不共享额度，因为这个文件"每次尝试都记一条"，量级远大于"只记错误"）。四种结果语义互不相同，团队要求分开展示、不合并成一个"失败"：`success`（含幂等重放命中）、`budget_exceeded`（我们自己的预判判定超限，可能像 terra 那次一样判错，附带 `estimated_tokens`/`budget_tokens` 方便在 Dashboard 上直接看出是否因估算偏高）、`upstream_failed`（真打了上游、被上游拒绝）、`denied`（409/fail-closed，会话可能直接死，团队原话"恰恰是最该被看见的一类"，刻意不并入 `upstream_failed`）。已知限制必须在 Dashboard 上可见：按会话去重用的 `conv_hash` 跨进程重启不稳定（隐私边界决定，非缺陷），一个会话的 retry storm 跨越容器重启会被计成两个"会话"。
  （`src/routes/shared/compact-tokenizer.ts`、新文件、`src/routes/shared/compact-outcome-log.ts`、新文件、`src/logs/jsonl-rotation.ts`、新文件（从 `error-log.ts` 抽出的公共轮转工具）、`src/routes/admin/compact-outcomes.ts`、新文件、`shared/hooks/use-compact-outcomes.ts`、新文件、`src/routes/shared/codex-compact-service.ts`、`src/routes/shared/opaque-compact-bridge.ts`、`src/routes/messages.ts`、`src/config-schema.ts`、`src/routes/web.ts`、`web/src/pages/UsageStats.tsx`、`shared/i18n/translations.ts`、`package.json`（新依赖 `js-tiktoken@1.0.21`）及配套测试）
- **修复一个正在生产反复发生的真实误判**：compact 输入的字节→token 估算比例从 `2.18` 改成 `2.70`。起因：用户亲眼撞到——同一个真实会话连续三次 recompact 全部被误判超限降级（`rid=39587bd5/2d362c85/5cb8f88c`，`estimated_tokens≈448k`，`budget_tokens=390000`），压缩跑了 14 分钟还卡在全量生成慢路径；但客户端状态栏当时显示的上下文只有 87%/300k≈261k token——估算值和客户端真实认的值差 1.72 倍。
  根因：`2.18` 这个比例来自 qa 早期用 `find-limit.mts` 在**合成负载**上测出的 chars/token，从没在真实会话上验证过。qa 后来用真实会话（`c382c880` 切片）端到端实测，拿上游真实返回的 `usage.input_tokens`（不是估算值）配对 bodyChars，测出来的真实比例是 2.70/3.34/3.33——反推那次生产事故：`448457 × 2.18 / 2.70 ≈ 362,065`，低于预算 390,000，本来完全能成功，不该被降级；这个数量级和"客户端 261k + tools ~47k ≈ 308k"三方互相印证。
  **权衡方向反转，这条是本次改动最值得记的结论**：8.7 最初取区间下界（更小值→换算出更多 token→更容易触发降级）的理由是"高估是安全方向的误差，低估才危险"，这个推理只在两个方向后果对称时成立，但实测下来根本不对称——高估的代价是无谓降级，**这条路径已经在生产反复发生**（上面这次事故连续三次）；低估的代价是撞上游 400，但 8.7 已经把这条路接住了（`isPromptTooLongLike` 判断触发降级返回 200，不是 409 杀会话），而且这个代价**至今一次都没在生产发生过**（零次 `Prompt is too long`）。所以"往保守方向取"本身没错，错的是"保守"当初被理解成"往小取"——真正的保守方向是"贴着真实会话实测的下界走"（2.70，三个真实样本里最小的那个，比真实中位数 3.33 还保守 23%），而不是盲目取一个更小的数字。图片 base64 字节数失真那条已知限制不受这次调整影响，结论不变（`src/routes/shared/codex-compact-service.ts`、`tests/unit/routes/shared/codex-compact-budget.test.ts`）。
- **修复一次已在生产发生的真实回归**：compact 预算表从 3 个型号扩到 8 个（qa 完整实测矩阵，17 次真实调用覆盖全部带 `contextWindow` 声明的型号）。起因：`gpt-5.6-terra` 此前不在表里，退到默认预算 260,000，一个 350,454 token、**本来能成功**的请求（terra 实测能吃到 405,173）被误判超限、降级到全量压缩慢路径，用户自己感知到变慢（`phase=compact_budget_exceeded model=gpt-5.6-terra estimated_tokens=350454 budget_tokens=260000`）——这次是修复，不是预防性加固。
  **最值得记的结论：上游元数据的 `contextWindow` 完全不可信，任何用公式从声明值推导预算的做法都是错的。** 8 个型号里 6 个统一声明 `272,000`，但实测真实成功上限从 271,261（`gpt-5.4-mini`，几乎等于声明值，1.00x）到 715,220（`gpt-5.4`，2.63x）不等，差 2.63 倍——不存在一个系数能同时拟合这整张表，只能逐型号实测入表，这也是为什么预算表是一张手工维护的 `Record`，不是一个"读字段乘系数"的函数。**唯一的反例、也是最危险的一个**：`gpt-5.3-codex-spark` 真实上限几乎贴着声明值走（~0.93x，128,000 声明 vs 119,036 实测成功上限）——不是"留了安全边际"，是"声明值本身就基本可信"；如果照着其他型号"实测普遍是声明值 1.49 倍"的经验给它套一个激进预算，会把它直接推过真实上限 3.3 倍，必炸，所以 spark 必须单独按自己的实测下界给，不能跟着别的型号"抄近路"。
  新预算表（每档 = 实测成功最大值打 ~95% 折，留出字节→token 估算噪声的余量；同代且实测值接近的型号才合并同一档——`gpt-5.5` 虽然和 sol/terra/luna 同代但实测明显更低，刻意没有合并进 390,000 那一档）：`gpt-5.3-codex-spark` 110,000、`gpt-5.4-mini` 260,000、`gpt-5.5` 270,000、`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` 390,000、`codex-auto-review` 580,000、`gpt-5.4` 680,000；未入表型号兜底预算维持 260,000 不变（刻意不跟着 spark 的实测下界往下压——兜底只服务未来新出现、还没实测过的型号，本轮 8 型号矩阵里除 spark 外全部 ≥260,000，260,000 对未来新型号是保守估计；就算撞线，后果是走降级慢路径而不是 409 杀会话，代价不对称，两个方向都不会导致数据损坏或误判成功，选对新模型更友好的方向）（`src/routes/shared/codex-compact-service.ts`、`tests/unit/routes/shared/codex-compact-budget.test.ts`）。
- ...（[查看全部](./CHANGELOG.md)）
**Fixed**
- `docker-publish.yml` 的 checkout 因 `actions/checkout` 已知 bug 与 tag ref 冲突，tag push 发布路径完全构建不起来（挡发布，紧急）：推 `v2.0.83` tag 触发构建时，在 `actions/checkout` 阶段就报错 `Cannot fetch both <sha> and refs/tags/v2.0.83 to refs/tags/v2.0.83`，根本没跑到 `Read version`。这条**本仓库此前没有任何文档**，是这次 release 推 tag 时第一次实测撞到的，不是"忘了记的已知问题"。查到根因是 `actions/checkout` 的上游已知 bug（`actions/checkout#1467`，`@v4` 未修，官方修复要到 `v6.0.2` 才发布），这一点同样是本轮才第一次查证：触发事件本身就是一个 `refs/tags/vX.Y.Z` 时（推 release tag、或 `workflow_dispatch` 手动选中一个 tag 重跑），`fetch-tags: true`（不带 `fetch-depth: 0`）会让 checkout 内部构造出"把触发 commit 的 SHA 写进 `refs/tags/vX.Y.Z`"和"拉取全部 tags 也会写同一个 `refs/tags/vX.Y.Z`"两条冲突的 refspec。**这个 bug 一直存在，此前没被发现的原因是它一直被上一条"版本 tag 无条件覆盖"的 bug 意外掩盖**：旧代码不管走哪条路径都会无条件打版本 tag，所以历史上遇到 tag push 构建失败时，靠"手动 `--ref master` 重跑" workflow_dispatch 就能绕过 checkout bug、且照样能打出正确的版本号。**修好上一条"版本 tag 覆盖"漏洞（加了 `enable=` 守卫）之后，`--ref master` 时 `github.ref` 不再是 tag ref，版本 tag 不再产出，这条历史绕行路径第一次失效，两个坑叠在一起，让发布链路彻底打不出版本 tag**。不是这次的 `enable=` 守卫修坏了什么——守卫本身行为完全正确，是它第一次让这个一直被掩盖的老 bug 真正挡住发布。
  修法：`fetch-tags: true` 换成 `fetch-depth: 0`。查过 `actions/checkout` 源码（`ref-helper.ts` 的 `getRefSpecForAllHistory`）：这条路径无条件带 `+refs/tags/*:refs/tags/*`（不看 `fetch-tags` 设不设），且只做两个通配符 refspec（`refs/heads/*`、`refs/tags/*`），不会构造"某个具体 SHA 写进某个具体 tag ref"这种会跟通配符冲突的 refspec，天然避开这个 bug——`Read version` 的 `LATEST_STABLE` 需要的"全部 tags"因此照样满足，不依赖 `fetch-tags`。
  **第一版还加了显式 `ref: ${{ github.ref }}`，复审后验证是冗余的，去掉了**：查过 `input-helper.ts`，同仓库（非 fork）checkout 在 `ref` 输入为空时会把 `settings.ref`/`settings.commit` 直接设成 `github.context.ref`/`github.context.sha`——和显式写 `ref: ${{ github.ref }}` 解析出来的值完全相同，纯冗余，不改变任何实际行为。第一版误加是因为 upstream issue #1467 讨论串里有多个独立复现者报告"加了 `ref:` 之后就好了"，但源码层面这行不可能改变已解析出来的 `settings` 值，那些报告更可能是巧合（`@v4` 是浮动 tag，恰好在测试间隔内也捡到了一次补丁版本更新）——留着这种"看起来在做事、实际什么都没改变"的配置只会误导后来人，去掉了。
  **评估过直接升级到 `actions/checkout@v6`（官方 `v6.0.2` 修了这个 bug，是更"治本"的修法），判断不采用**：`v5.0.0` 起对运行 action 的 Node 版本、runner 最低版本有新要求（GitHub 托管的 `ubuntu-latest` 会自动满足，但这是本仓库从未验证过的新约束），`v6.0.0` 改了凭据持久化方式——这类跨大版本的行为变化没法在没有真实 GitHub Actions runner 的环境里验证，只能凭 changelog 文字判断，而这条 workflow 恰恰是"挡着发布、优先级最高"的那条，不适合承担一次没有实测过的升级风险。相比之下 `fetch-depth: 0` 已经在本仓库的 `release.yml` 里对着同样的"tag push 触发 + 需要全部 tags"场景跑通过真实生产发布（`v2.0.83` 桌面端 14 个资产已经正常发出），是有生产验证的既有先例，不是本仓库首次尝试。**这个仓库现存的 4 个 `fetch-depth: 0` workflow 里，只有 `release.yml` 真正会被 tag push 触发**，另外 3 个（`bump-electron.yml`/`bump-electron-beta.yml`/`promote-dev-to-master.yml`）只由 `workflow_dispatch` 触发、从不会走到 tag ref 场景，不能当作等效先例——引用这个先例时特意核实过这一点。评估过另一个候选方案 `fetch-tags: ${{ !startsWith(github.ref, 'refs/tags/') }}`（只在 ref 本身是 tag 时关掉 fetch-tags，保留轻量 checkout）：判断不采用——那样的话推 tag 触发时 checkout 只会带来"触发本身这一个 tag"，`LATEST_STABLE` 退化成只看当前 tag，`max()` 存在的意义（不依赖 `package.json` 准确）就落空了，版本回退防护形同虚设。
  权衡：`0f65218`（#430）当初从 `fetch-depth: 0` 换成 `fetch-tags: true` 是为了"更轻量的 checkout"，这次换回去是刻意取舍——这个仓库体积很小（`.git` 18M、164 个 tag），全历史 fetch 的耗时相对后面的多平台 buildx 构建（`linux/amd64+arm64`，QEMU 模拟）可以忽略不计，不值得为了这点 checkout 耗时承受"发布链路随时可能断"的代价。已经把这两个坑（连同没被文档记录过这一点）写进 `CLAUDE.md` 的发布门禁一节。配套测试：新增 `tests/unit/ci/docker-publish-checkout.test.ts`（3 条）：① 不再出现历史上有问题的 `fetch-tags: true`（不带 `fetch-depth: 0`）组合；② 确实用了 `fetch-depth: 0`；③ 历史上出问题的 checkout 代码块原文不能原样重现（最后一道防线）。红/绿验证过：临时把 checkout 改回 `fetch-tags: true`，3 条全部正确变红，恢复后全部转绿（`.github/workflows/docker-publish.yml`、`tests/unit/ci/docker-publish-checkout.test.ts`，新文件、`CLAUDE.md`）
- `docker-publish.yml` 静默覆盖已发布版本 tag（生产事故，非假设）：`Read version` step 算的是 `max(package.json 版本, 已有最高 stable git tag)`，而 `type=raw,value=v${{ steps.version.outputs.version }}` 这条 tag 规则此前**没有任何 `enable=` 条件**——docker/metadata-action 的规则默认全部参与输出，缺 `enable` 等于永远产出。workflow 的触发条件是 `push: branches:[master]`（不只是 `tags:["v*"]`），后果是**每一次日常 master 推送**都会把"当前最高版本号"这个 tag 重新指向这次构建的产物，不管 `package.json` 有没有实际 bump——不是"这次忘了 bump"式的一次性问题，是两次真正发版之间的每一次 master 推送都会复发。构建全绿、无任何报错，只有拿生产在跑的镜像 digest 去比对才会发现（真实案例：`v2.0.82` 从生产实际在跑的 `sha256:5bab5af3…` 被静默改指到了另一个 digest）。修法：给这条规则加 `enable=${{ startsWith(github.ref, 'refs/tags/v') }}`，只在触发事件本身处于一个 `refs/tags/v*` ref 上时才产出这个 tag。**用 `github.ref` 而不是 `type=ref,event=tag`**（后者本来就已经在规则列表里、且触发 tag push 时会自动产出同名 tag，看似可以整个删掉这条 raw 规则改成完全依赖它）：`github.ref` 覆盖了 `event=tag` 覆盖不到的一条真实路径——`workflow_dispatch` 手动对着一个已有 tag 重跑（`release.yml` 里就有同款"手动指定 tag 重跑"的用法，不是假设场景），这种触发下事件类型永远不是 "push a tag"，按 `event=tag` 判断会漏掉这条手动补发布路径，按 `github.ref` 判断则不会。核实过 `steps.version.outputs.version` 在这个 workflow 里只有这一处消费者，`Read version` step 仍然需要保留（不是可以顺手删掉的死代码）。**`max(package.json, 已有最高 stable tag)` 这套版本回退防护（上游 `0f65218`/#430 引入，解决的是另一个独立问题：落后分支的 `package.json` 版本号比已发布的还旧时不能直接采信）这次没有删、也没有简化**——它和 `enable=` 守卫完全兼容：推 tag 触发时 `fetch-tags: true` 会把刚推的 tag 一起拉下来，`LATEST_STABLE` 立刻包含它，`max()` 算出来天然等于 tag 本身；master 推送时 `enable=` 已经是 `false`，`max()` 算出什么都不会被用来打 tag。为了避免以后有人在"修 tag 覆盖"的名义下顺手把这段逻辑删掉或简化成只读 `package.json`（那会把上游已经修过的版本回退问题重新引回来），额外补了一条测试单独锁住这段逻辑还在（而不是只测有没有守卫）。配套测试：新增 `tests/unit/ci/docker-publish-tag-guard.test.ts`（沿用 `docker-node-runtime.test.ts` 的先例——CI 配置本身需要被单测锁住，不能只靠人工警觉），7 条断言：① `enable=` 条件必须存在；② 条件必须真正基于 `github.ref` 匹配 `refs/tags/v` 前缀，不能是 `is_default_branch` 这类日常 master 推送也恒真的条件；③ 用的是 `github.ref` 而非 `event=tag`（防止以后被"优化"成看起来更直观但漏掉手动重跑场景的写法）；④ 历史上那行完全无守卫的原文不能原样出现（最后一道防线）；⑤ 顺手守住 workflow 的触发范围本身没有被这次改动意外收紧；⑥ `Read version` step 未被误删；⑦ `max()` 版本回退防护逻辑本身完整保留（比较逻辑而非仅同名变量）。红/绿验证过两轮：第一轮临时把 `enable=` 条件去掉复现原始漏洞状态（7 条里 4 条正确变红）；第二轮临时把 `Read version` 简化成只读 `package.json`（模拟"顺手删掉 max() 逻辑"）单独复现第 7 条变红——两轮恢复修复后全部转绿，不是只在有修复的状态下跑过一次就假定测试有效（`.github/workflows/docker-publish.yml`、`tests/unit/ci/docker-publish-tag-guard.test.ts`，新文件）
- reviewer 复审 blocker：`stream-close-event.ts` 的 `recordStreamCloseEvent` 此前把 `accountEntryId`（`accounts.json` 里的账号唯一标识，OAuth 账号形如 `codex:auth:<uuid>`，可直接定位到具体账号记录）原样落进 `context`（`appendErrorLog`）与 `request`（`enqueueLogEntry`），两条都会被 Dashboard 已有的"展开看原始 JSON"视图（`ErrorsPage.tsx` 的 `ErrorRow`、`LogsPage.tsx` 的选中条目详情，均是 `JSON.stringify(整个 context/entry, null, 2)`）整体渲染出来——明文账号 ID 因此直接出现在 UI 上。这个曝光路径本身不是这次改动新写的（`accountEntryId` 从这个函数存在起就一直是明文，`ErrorRow` 的原始 JSON 展开视图也是既有功能），但本轮刚在同一个函数、同一个 `context`/`request` 对象里对 `detail`/`message` 两个字段做过"同类风险、同一套处理"的判断（见上面 `[Added]` 的 stream-close-event 那条），却没有把同一个判断延伸到紧挨着的 `accountEntryId` 字段——这是这次判断遗漏，不是"发现了但選擇不修"，reviewer 复审时指出后确认属于同一批必须一起修的范围。修法：改用 `auditAccountTag`（8.6 已经在用的同一个哈希函数，同一份进程级盐，跨日志来源可关联同一账号）算出 `accountHash`，字段名同步从 `accountEntryId` 改成 `accountHash`（不再叫 "EntryId"，避免让人以为这个字段还是原始 ID 可以拿去查账号表）。配套测试：`stream-close-event.test.ts` 新增断言整条落盘的 JSON 行不含明文 `entryId`、`context`/`request` 均不再有 `accountEntryId` 这个 key；测试里计算期望哈希值时必须和被测代码同一次 `vi.resetModules()` 后动态 `import` `auditAccountTag`（否则拿到的是不同模块实例、不同随机盐，算出的哈希对不上——`AUDIT_SALT` 是 `randomBytes(32)` 在模块顶层算的）（`src/logs/stream-close-event.ts`、`tests/unit/logs/stream-close-event.test.ts`）
- qa 覆盖率盘点补测（全绿基线上的补漏，不改业务逻辑）：① **必须补**——C3+D 组之前没有一条路由层用例把"store 未 ready"和"这是一个 compact 请求 + 历史带合法 marker"拼在一起断言仍然 409；readiness 检查确实写在自愈逻辑之前，但此前只由源码书写顺序保证，没有测试锁死，未来重构 `messages.ts` 一旦顺序颠倒不会有任何测试变红。新增路由层用例，用真实 D 组致命故障（`store_locked`，两个 `startOpaqueCompactRuntime` 实例抢同一把文件锁）构造，不是抄近路直接调内部 setter；断言 409、reason 落在致命族（用两个已导出的姊妹分类函数反向验证）、上游零调用。红/绿验证时意外发现这条边界其实是三层独立防御（早退检查 + `getOpaqueCompactStateStore()` 自身的 null 检查 + reason 分类结果本身不会让 store 级致命故障走到分类函数），单独破坏任一层都不会让请求泄漏成 200，写进了测试注释里——这个发现比单条断言更有价值，因为它说明这个安全边界的健壮性好于最初预期，但"需要同时破坏两层才会失守"不等于"不需要测试"，护栏依然留着。② TTL 精确边界（矩阵 A2）：此前只测了"过期后"（T+31min）和顺延链路本身，没测"还差一秒到期"这一侧——新增用例断言这种情况下一次普通请求走正常 resolve 成功路径（不是自愈），红/绿验证过（把时间故意推过期界，断言从 200 变 409）。③ marker 传输形态（矩阵 B5/B6/B8/B9/B10/B11，交接文档 6.2 猜测的真实事故触发形态，此前零覆盖）：这六条不是同一种断言——B5（代码块包裹）/B8（token 内插入换行）破坏了严格正则本身，和已测的 B4 同一条"忽略+占位透传，不 409"路径；B6（marker 独占第二个 text block）/B9（CRLF）/B10（首尾多余空白）不破坏正则（逐 block 独立解析 / 匹配前统一 normalize CRLF / 匹配前统一 trim），这三条按"真正解析成功、正常恢复"断言，不是"没 409 就算过"；B11（跨 message 双 marker，不是同 message 内重复）断言取的是后一条 message 里的那个。写测试过程中发现三处 `urls.toHaveLength(2)` 的自己的复制粘贴错误（应为 1），已修正——如实记录这不是实现问题（`tests/e2e/opaque-compact-lifecycle.test.ts`、`tests/e2e/messages.test.ts`）
- `web/` 的 Dashboard 组件测试从未被任何脚本实际执行过（reviewer 复审 UI 修复时顺带发现，与本轮改动无关，但撞见了就顺手补上）：`web/src/components/*.test.tsx`（8 个文件、17 个用例，含本轮改过的 `GeneralSettings.test.tsx`）根 `vitest.config.ts` 的 `include` 不覆盖，`web/package.json` 也没有 `test` 脚本——`npm test` 天然跑不到它们，只有手工 `cd web && npx vitest run` 才会执行。探测结果：**全绿**（这些文件是活的，只是没接进任何自动化），说明这次 UI 改动没有破坏既有交互测试的预期（`GeneralSettings.test.tsx` 用 `screen.getByLabelText` 按无障碍标签定位元素，不依赖 DOM 顺序，因此本轮把该区块移动位置不影响它）。修法：新增根级 `npm run test:web`（`cd web && npx vitest run`，与既有 `dev:web`/`build:web` 保持同一命名与实现约定）、`web/package.json` 加 `test` 脚本使 `cd web && npm test` 也能直接跑；**刻意不**把它并进根 `npm test` 本身——`tests/README.md` 的既有 scope 表格把 `npm test` 明确定义为"backend only"（unit+integration+e2e+electron），`web/` 是完全独立的依赖树（自己的 `node_modules`、preact/jsdom 环境），强行合并成一次 `vitest run` 需要把 `@testing-library/preact`/`jsdom`/preact 插件都装进根项目，代价和收益不成比例；保留成单独可发现的脚本，同时把 `tests/README.md`（新增一行 scope 表格）与 pr-push skill 的两处文档（`SKILL.md` 的 diff-dispatch 表、`pr-checklist.md`）同步更新，让"`web/**` 改了要跑什么"这条规则说清楚，不再是"能跑但没人知道"的状态（`package.json`、`web/package.json`、`tests/README.md`、`.claude/skills/pr-push/SKILL.md`、`.claude/skills/pr-push/references/pr-checklist.md`）
- ...（[查看全部](./CHANGELOG.md)）

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
