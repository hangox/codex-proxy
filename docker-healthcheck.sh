#!/bin/sh
# Prefer the runtime port override, then config, then the default.
CONFIG_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
HEALTHCHECK_PORT=${PORT:-${CONFIG_PORT:-8080}}
# Local health checks must never inherit an upstream HTTP proxy.
curl --noproxy '*' --fail --silent --show-error --max-time 3 \
  "http://127.0.0.1:${HEALTHCHECK_PORT}/health" >/dev/null || exit 1
