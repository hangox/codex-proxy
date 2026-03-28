# Native Transport — 待补测试清单

> PR #245 feat/native-tls-transport 分支
> 真实 E2E 已验证 18 次通过，以下是需要补的 vitest 测试模块

## 1. native-transport 单元测试

**文件**: `src/tls/__tests__/native-transport.test.ts`

Mock Rust bindings，验证 TS wrapper 逻辑：

- [ ] `post()` — 将 Rust callback 流正确包装为 ReadableStream
- [ ] `post()` — signal.aborted 时立即抛错
- [ ] `post()` — onChunk(null) 正确关闭 ReadableStream
- [ ] `post()` — onChunk(undefined) 也能关闭（napi-rs 兼容）
- [ ] `post()` — setCookieHeaders 从 meta 正确透传
- [ ] `post()` — response headers 排除 set-cookie（单独处理）
- [ ] `get()` — 返回 { status, body }
- [ ] `getWithCookies()` — 返回含 setCookieHeaders
- [ ] `simplePost()` — 返回 { status, body }
- [ ] `isImpersonate()` — 返回 false
- [ ] `resolveProxy()` — undefined → getProxyUrl()、null → null、string → string
- [ ] `force_http11` — 从 config 读取并传给 bindings

## 2. session-affinity turnState 测试

**文件**: `src/auth/__tests__/session-affinity.test.ts`（已有文件，追加）

- [x] `record()` 带 turnState → `lookupTurnState()` 返回正确值
- [x] `record()` 不带 turnState → `lookupTurnState()` 返回 null
- [x] turnState 过期后 lookup 返回 null
- [x] 多次 record 同一 responseId，turnState 更新

## 3. codex-api headers 测试

**文件**: `src/proxy/__tests__/codex-api-headers.test.ts`（新建）

Mock transport，验证请求头：

- [x] HTTP SSE 路径发送 `x-openai-internal-codex-residency: us`
- [x] HTTP SSE 路径发送 `x-client-request-id`（UUID 格式）
- [x] HTTP SSE 路径：request.turnState 存在时发送 `x-codex-turn-state`
- [x] HTTP SSE 路径：request.turnState 不存在时不发该头
- [x] HTTP SSE 路径：turnState 不出现在 JSON body 中
- [x] WebSocket 路径同样发送上述三个头

## 4. proxy-handler turnState 传递测试

**文件**: `tests/integration/proxy-handler.test.ts`（已有文件，追加）

- [ ] 首次请求无 previous_response_id → 不发 x-codex-turn-state
- [ ] 上游响应含 x-codex-turn-state → 存入 affinityMap
- [ ] 后续请求带 previous_response_id → 从 affinityMap 取出 turnState 注入请求
- [ ] 非流式路径同样传递 turnState

## 5. transport factory 测试

**文件**: `src/tls/__tests__/transport-init.test.ts`（新建或追加）

- [ ] config `transport: "native"` + addon 存在 → 选择 NativeTransport
- [ ] config `transport: "native"` + addon 不存在 → 抛错
- [ ] config `transport: "auto"` + addon 存在 → 优先选择 native
- [ ] config `transport: "auto"` + addon 不存在 → fallback 到 curl
- [ ] `getTransportInfo().type` 返回 `"native"`

## 优先级

1. **高**: #3 codex-api headers（直接影响伪装）
2. **高**: #2 session-affinity turnState（逻辑简单，快速补）
3. **中**: #1 native-transport（wrapper 逻辑验证）
4. **中**: #4 proxy-handler turnState（集成层）
5. **低**: #5 transport factory（启动路径，手动验证过）
