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
- **★ 降级之后的那次压缩现在也进压缩明细面板了，能和 opaque 放在一起对比**（用户原话："我想把压缩都统计到这里来，就是降级后的压缩也在这里统一展示，这样才能方便对比"）。此前它**根本没有落盘**——不是数据散在别处等合并：降级不是"不压缩"，而是把同一个请求换成通用生成端点重跑一次，那次压缩真实发生、真实产出摘要，但服务端只有不落盘的 `console.log`，失败时才散进 `error-log.jsonl` 且没有任何字段标明它是降级后的压缩，事后只能靠人工按 rid 关联 `docker logs` 里时间相邻的行。现在：新增 `compact_path` 三值（`opaque` / `fallback_decision` / `fallback_render`）——**刻意不用两值**，因为 `fallback_decision` 和 `fallback_render` 都会产生 `upstream_failed`（一个是 opaque 端点被拒、一个是通用端点被拒），混在同一标签下等于把隐含分类重新引入；`fallback_render` 记的是**真实完成状态**（上游确认生成完成的信号，不是 `res.status`——流式请求的所有同步失败分支统一返回 200，状态码在那一层不可靠），覆盖账号获取/同步拒绝/重试耗尽等 6 个终止点加流终止点；`failure_stage` 区分 `pre_stream`（换端点也没用，该调预算或换模型）和 `mid_stream`（换端点有效但传输出问题，该查链路），两者排查方向相反，**不能靠 `http_status` 有无去推导**。面板上一次降级产生的两条记录共享同一个请求 ID、可互相跳转，汇总卡片并列展示两组成功率且各自的分母写进句子本身（"4 次重试中，3 次完成"）——两组的分母不是一回事（一个是"opaque 尝试了多少次"，一个是"降级之后重试了多少次"），不能直接相加或相除。
**Changed**
- **★ 上游返回 `invalid_value` / `unsupported_value` 时，客户端收到的状态码从 502 改为 400——影响所有 API 面，不只是压缩。** 这两个 code 此前不在 `codexApiErrorFromEvent` 的码表里，落到兜底的 502，而 502 落在 `withRetry` 的可重试区间：一个「重发多少次都一样」的**参数校验错误**会被无谓重试 3 次。改成 400 之后重试不再发生。**这个函数不是压缩专用的**，`/v1/messages`、`/v1/chat/completions`、gemini 三条客户端翻译链共用它，所以这是全 API 面的状态码语义变更；受控 A/B 实测（同一个非压缩的普通 `/v1/messages` 请求）：master 返回 502、改动后返回 400，上游请求次数都是 1。**对客户端的实际影响需要注意**：4xx 和 5xx 对客户端不是同义词，很多客户端（Claude Code 就是）把 5xx 当可重试的临时故障、把 4xx 当永久失败——同一个上游状况，这类错误现在会**直接呈现给用户**而不是被静默自动重试。这是预期行为（参数错误重试没有意义，且重试会掩盖真实原因），不是回归。
- **★ 压缩改走 Responses compaction v2，并删除了基于上游错误文案的自动回落。** v2 走普通的流式 `/codex/responses`，靠 input 末尾的 `compaction_trigger` 哨兵表达「这是一次压缩」，上游返回一个加密的 `compaction` item。此前的实现会在「上游看起来不支持 trigger」时自动回落到 legacy 的 `/codex/responses/compact`——这条路已整个删掉，原因不是它写得不好，是方向本身错了：**回落的目标端点当前本身就是 404**（正是这次事故），回落到一个确定失败的端点期望价值是负的（白发一次请求 + 把真实失败原因替换成 v1 的 Not Found）；而判据只能来自上游的错误文案，「从错误文案反推上游支不支持某能力」实测会误判——一条 `Invalid value for 'input': compaction_trigger must be the last input item`（**位置放错、请求构造 bug**）同时命中 `invalid` 和 `compaction_trigger` 两个关键词被判成「v2 不可用」，客户端最终看到 404 而上游真实原因是 400。**特别地 404 不可能意味着「v2 不被支持」**：`/codex/responses` 是所有普通请求都在打的端点，它返回空 body 404 的真实含义是 Cloudflare path-block，吞掉会让清 cookie / 计数 / 到阈值禁用账号那套自愈失效。同时改为**主动声明** `x-codex-beta-features: remote_compaction_v2`，即能力协商是声明式的而不是推断式的。**官方客户端的机制**（核对 openai/codex `902bd9e06`）：该 header 只在 feature 启用时携带（`codex-rs/core/src/session/mod.rs:1041-1044`，条件是 `advertise_in_model_client_header && config.features.enabled(spec.id)`）；`RemoteCompactionV2` 是 `Stage::Stable` + `default_enabled: true`（`codex-rs/features/src/lib.rs:1453-1458`），所以**默认配置下会带、但用户可以关掉**；且 header 值是**在 session 创建时预计算**再传给 client 的，不是逐请求计算（`session/mod.rs:1033-1036` 的注释写明了这一点）。本代理这边则是**无条件携带**。——特意写清机制而不只写效果：默认配置下「每个请求都带」这个**观测结果**是对的，但如果把机制误记成「无条件、逐请求携带」，将来排查时会去找一段「每请求计算 header」的逻辑，而**那段逻辑不存在**；也会以为用户关不掉，其实关得掉。
- **新增配置项 `model.compact_protocol`（`auto` | `v1` | `v2`，默认 `auto`）。** `auto` = 纯 v2、无任何自动回落；`v1` = 直接走 legacy 端点，一次都不试 v2。这是上游回滚或出现旧客户端时**唯一不依赖任何猜测**的逃生舱：改一个配置键即可，不需要发版——这也是 legacy 实现被保留下来的唯一理由。该键可从受鉴权的 `/admin/general-settings` 读回实际生效值（防「配置写了、容器起了、`/health` 200、开关其实没生效」那类静默失效）。**老配置文件不需要改**：schema 有默认值兜底，没有这个键的配置在新版本上行为等同 `auto`，已实测确认。
- **`/v1/responses/compact` 响应新增 `compaction_protocol` 字段（`"v1"` | `"v2"`）。** 这个**对外**端点的 `output` 语义随协议不同：v1 是上游返回的压缩后 transcript，v2 是 `[...保留的 user 消息, {type:"compaction", ...}]`。而端点、字段名、响应类型都没变，外部调用方原本无从分辨、也不会有任何地方报错——新版 codex 会保留 `compaction` item，但早于该变体的旧客户端会把它反序列化成 `Other` 然后丢掉，**整段历史静默消失**。加这个字段让客户端能判别，配合 `compact_protocol: "v1"` 就能钉死到自己能处理的形状。
**Fixed**
- **★ 修一个会让系统提示词永久失效的缺陷：`system_prompt_strategy` 为 `developer_inline` / `system_inline` 时，走过压缩恢复的会话会丢掉用户的系统提示词。** inline 两种模式下用户 system prompt **不在**顶层 `instructions` 里（那里刻意留空），而是被 `unshift` 成 input 最前面的一个 `developer`/`system` item——**它只存在于这一个地方**。而恢复逻辑只保留 marker 边界之后的部分，边界之前整段丢弃、之后也没有任何地方插回去。实测：不是「压缩那一轮丢一次」，而是只要客户端还带着 marker（Claude Code 每轮都带），**每一轮都会重新丢一次**，该会话的系统提示词永久失效直到用户开新会话；`input` 里没有 developer item、`instructions` 是空串，模型完全没有系统指令，**不报错、不降级、无痕迹**。修法是在恢复函数内部保留边界之前的 inline 指令项（先按位置圈定前缀、再在前缀里按 role 判定，两个维度都用上，既不会扫到历史里的 user/assistant，也不写死 index 0）。落点选在恢复函数本身而不是某个调用分支，因此三条调用路径（恢复、root compact 复用 marker、**关开关/marker 不适用/marker 损坏**）一次性覆盖——最后那条恰恰是运维出事时会走的路径。
- **★ 压缩的协议违例不再被重试放大成 3 次付费请求。** `withRetry` 的判据是「status 在 5xx 即可重试」，而「上游正常应答但内容不符合约定」（compaction item 数量不对、流没到 `response.completed` 就断）同样被表达成 502——重放同样的请求只会得到同样的结果，但每一次重放都是一整轮真金白银的压缩。路由级实测：上游返回 0 个/2 个 compaction item、流提前 EOF，三种情况上游都被打满 3 次。另外 `/v1/responses/compact` 的 `withRetry` 没收到 signal，**客户端 abort 后退避 sleep 醒来照样继续打**，实测 abort 后上游总请求次数仍是 3——用户按了 Ctrl-C，账单照跑。修法刻意不在 `withRetry` 里堆 status/文案特例（那是「新增一种不可重试的失败就要改重试逻辑」的形状），改成由**抛出处**显式标记不可重试；默认不带标记、按 status 判定的老行为完全不变，真实传输层 5xx 仍然正常重试 3 次（有对照用例锁住，防止修过头）。
- **`/v1/responses/compact` 的 Cloudflare path-block 自愈现在真的会清 cookie。** 该路由调用统一错误处理时漏传了 `cookieJar`，而 CF 分支里是 `cookieJar?.clear(entryId)`——可选链把它静默变成 no-op，紧跟着的「cleared cookies and retrying...」日志却照打，**日志说清了、实际没清**。实测命中 CF 空 body 404 之后 cookie jar 里的 `__cf_bm` 原样残留。同一个函数在 `/v1/messages` 那条路径上是传了的，只有这条路由漏了。同时把该函数的 `cookieJar`/`safeLog` 两个参数改成**必须显式传**（`cookieJar` 仍可为 `undefined`，只是不能省略）——漏传和「传了 undefined」此前在调用点长得一模一样，这是它能通过 review 的原因；改完之后漏传是编译错误，不依赖任何人的注意力。
- **非法的 `input` 形状不再让本地装配抛 TypeError。** `/v1/responses` 只校验 `input` 是不是数组，元素形状完全没有约束。`{"role":"user"}`（没有 content）、`{"role":"user","content":123}`、含无 `text` 字段的未知 part 三种形状实测都会崩，而且**发生在上游压缩已成功返回、token 已经花掉之后**；抛的是 TypeError 而不是可分类的 API 错误，于是变成未处理 500——压缩结果丢失、无分类、无记录。现在非法形状按「没有文本」处理，把该报错的责任留给上游。
- **压缩消耗的配额不再从账号池视图里漏记。** v2 的压缩走的是和普通请求同一条 WebSocket 通道，上游会在流里发 `codex.rate_limits` 帧，但压缩路径此前没有接收这些帧的回调，配额消耗被直接丢弃——用得越多、账号池的额度视图偏得越远。

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
