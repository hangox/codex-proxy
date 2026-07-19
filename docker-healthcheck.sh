#!/bin/sh
# Read server port from config, fallback to 8080
PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
# Local health checks must never inherit an upstream HTTP proxy.
curl --noproxy '*' --fail --silent --show-error --max-time 3 \
  "http://127.0.0.1:${PORT:-8080}/health" >/dev/null || exit 1
