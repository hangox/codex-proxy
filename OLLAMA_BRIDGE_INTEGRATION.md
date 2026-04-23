# Ollama Bridge Integration Development Log

## Goal

Integrate the standalone `codex-proxy-ollama-bridge` into the main `codex-proxy`
application so users can expose an Ollama-compatible endpoint without managing a
second service.

## Phase 1 Scope

- Move the existing bridge behavior into the main Node/Electron process.
- Start a dedicated Ollama-compatible listener, defaulting to
  `http://127.0.0.1:11434`.
- Preserve the current supported endpoints:
  - `GET /api/version`
  - `GET /api/tags`
  - `POST /api/show`
  - `POST /api/chat`
  - passthrough `/v1/*`
- Add persistent config under `ollama`.
- Add admin APIs for status and settings.
- Add a dashboard settings panel for enablement, host, port, version, and vision
  capability advertisement.
- Keep defaults local-only for safety.

## Phase 1 Design

The bridge will run as an optional second HTTP listener from the same process as
the main proxy. This keeps Ollama clients compatible with the conventional
`11434` port while removing the separate `systemd` unit and external script from
the product path.

Configuration:

```yaml
ollama:
  enabled: false
  host: 127.0.0.1
  port: 11434
  version: "0.18.3"
  disable_vision: false
```

Runtime behavior:

- If `ollama.enabled` is false, no Ollama listener is started.
- If the configured port is occupied, the main Codex Proxy server continues to
  run and the Ollama status reports the bind error.
- Settings changes are persisted to `data/local.yaml`.
- The bridge can be restarted dynamically from the settings API without
  restarting the main proxy process.

## Open Follow-Ups

- Decide whether to replace internal HTTP self-calls with direct route/service
  invocation in a later refactor.

## Phase 2 Hardening Scope

- Add dedicated unit tests for the bridge protocol surface:
  - version/tags/show
  - non-streaming chat conversion
  - streaming SSE to Ollama NDJSON conversion
  - `/v1/*` passthrough and proxy API key injection
  - client-side JSON validation errors
- Add runtime listener lifecycle tests for disabled mode, successful start,
  restart, uninitialized runtime, and bind failures.
- Add admin API tests for reading settings, saving settings, auth checks,
  validation, config persistence, reload, restart, and error status propagation.
- Add config schema and environment override coverage.
- Document the feature in README, README_EN, API reference, `.env.example`, and
  Docker compose guidance.
- Expose `11434` in the Docker image metadata while keeping compose port
  publishing opt-in and loopback-bound.

## Development Notes

- 2026-04-23: Started Phase 1 implementation.
- 2026-04-23: Implemented Phase 1 backend listener, admin APIs, dashboard
  settings panel, config defaults, and legacy environment variable overrides.
- 2026-04-23: Verified build, full test suite, and local endpoints:
  `GET /api/version`, `GET /api/tags`, and `POST /api/show`.
- 2026-04-23: Started comprehensive Phase 2 hardening: protocol tests,
  listener lifecycle tests, admin/config tests, Docker guidance, and public docs.
- 2026-04-23: Addressed PR review hardening items: loopback-only browser CORS,
  broader non-loopback host warnings, malformed admin JSON handling, bounded SSE
  buffering, and `/v1/*` query-string preservation.
- 2026-04-23: Addressed follow-up review items: explicit `/v1/*` API-key
  passthrough warning, trimmed admin validation, non-duplicated settings response
  status, and schema-level `ollama.version` bounds.
