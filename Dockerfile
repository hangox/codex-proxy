# ── Stage 1: Build native TLS addon (Rust → .node) ──────────────────
FROM rust:1-slim AS native-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 curl ca-certificates gnupg && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (needed by napi-rs CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /native

# Cache Cargo deps first
COPY native/Cargo.toml native/Cargo.lock native/build.rs ./
RUN mkdir src && echo '#[allow(dead_code)] fn main(){}' > src/lib.rs && \
    cargo build --release 2>/dev/null || true

# Build real addon
COPY native/ ./
RUN npm ci && npm run build

# ── Stage 2: Application ────────────────────────────────────────────
# Node 22.16.0 (Debian bookworm) is the minimum runtime this image may use:
# src/routes/shared/opaque-compact-*.ts import `node:sqlite` at module load
# time, and that builtin only exists from Node 22.5 (flagged) / 22.13 (stable).
# On node:20-slim the process died at startup with ERR_UNKNOWN_BUILTIN_MODULE,
# which `restart: unless-stopped` turned into a crash loop in production.
# The Rust addon from stage 1 is built against N-API 9 (napi feature "napi9"),
# which is ABI-stable and forward compatible with Node 22, so it needs no
# rebuild. Note that stage 1 (`rust:1-slim`) currently floats on Debian trixie
# (glibc 2.41) while this stage is bookworm (glibc 2.36); the addon links only
# against old symbol versions today, and the build-time load assertion below
# turns any future drift into a failed build instead of a dead container.
FROM node:22.16.0-slim

# Fail the build (not production) if the runtime base image ever loses the
# `node:sqlite` builtin the opaque compact persistence layer depends on.
RUN node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(':memory:').close();"

# The checked-in default is loopback-only for local source installs. Containers
# need to listen on all interfaces inside the network namespace so published
# ports and Docker health checks can reach the service.
ENV CODEX_PROXY_HOST=0.0.0.0

# curl: needed by full-update.ts
# unzip: needed by full-update.ts to extract Codex.app
# gosu: needed by entrypoint to drop from root to node user
# build-essential/python3: needed when better-sqlite3 falls back to node-gyp
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates gosu build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Backend deps
COPY package*.json tsconfig.json ./
COPY scripts/ scripts/
RUN npm ci

# 2) Web deps (separate layer for cache efficiency)
COPY web/package*.json web/
RUN cd web && npm ci

# 3) Copy source
COPY . .

# 4) Copy native addon from builder stage (overwrite macOS .node if present)
COPY --from=native-builder /native/codex-tls.linux-*.node /app/native/

# The TLS transport is mandatory: initTransport() throws if the addon cannot be
# loaded, so a builder/runtime glibc mismatch would kill the container at
# startup exactly like the node:sqlite regression did. Prove it loads here.
RUN node -e "const fs=require('fs');const f=fs.readdirSync('/app/native').find((n)=>n.startsWith('codex-tls.linux-')&&n.endsWith('.node'));if(!f)throw new Error('linux native addon missing');require('/app/native/'+f);"

# 5) Build frontend (Vite → public/) + backend (tsc → dist/)
RUN cd web && npm run build && cd .. && npx tsc

# 6) Stamp build time for update-checker (COPY . invalidates cache, so this is always fresh)
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.docker-build-time

# 7) Prune dev deps, re-add tsx (needed at runtime by update-checker fork())
RUN npm prune --omit=dev && npm install --no-save tsx

EXPOSE 8080 11434

# Ensure data dir exists in the image (bind mount may override at runtime).
# /app/opaque-keys is the conventional home for opaque_compact_state.keyring_file
# (must live outside /app/data — see config-schema.ts).
#
# ★ Why mkdir -p here matters (reviewer-verified, not what an earlier version
# of this comment claimed): `chown -R` treats each listed path independently —
# a missing path only makes chown fail (and warn) for *that* path; it does not
# stop the others from being chown'd correctly. So this is NOT here to
# "guarantee entrypoint always has a target" — that already holds without it.
# The real reason: this entire build stage runs as root (no `USER` switch
# anywhere in this Dockerfile), so `mkdir -p` here bakes the directory into
# the image already root-owned; docker-entrypoint.sh also starts as root
# (before `gosu node`), so chowning an already-existing directory just
# succeeds silently. Without this line, the overwhelming majority of
# deployments — which never enable opaque compact and never bind-mount
# anything here — would hit a missing path on every single container start,
# and (paired with the entrypoint change that turns chown failures into a
# visible `[Init] WARNING` instead of silently swallowing them) that would
# print a spurious warning on every boot. This line is what keeps "failure is
# now visible" from degrading into "it warns every time, so nobody reads it."
RUN mkdir -p /app/data /app/opaque-keys

# Backup default configs so entrypoint can seed empty bind mounts
RUN cp -r /app/config /defaults

COPY docker-entrypoint.sh /
COPY docker-healthcheck.sh /
RUN chmod +x /docker-entrypoint.sh /docker-healthcheck.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /docker-healthcheck.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
