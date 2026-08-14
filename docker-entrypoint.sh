#!/bin/sh
set -e

# Architecture: x64 or arm64
# Only set CODEX_ARCH if it's not already set or is empty
if [ -z "${CODEX_ARCH}" ]; then
  UNAME_ARCH=$(uname -m)
  if [ "$UNAME_ARCH" = "aarch64" ]; then
    CODEX_ARCH="arm64"
  elif [ "$UNAME_ARCH" = "x86_64" ]; then
    CODEX_ARCH="x64"
  else
    CODEX_ARCH="$UNAME_ARCH"
  fi
  export CODEX_ARCH
fi

# Seed empty config bind mount with defaults from the image
if [ -d /defaults ] && [ -z "$(ls -A /app/config 2>/dev/null)" ]; then
  echo "[Init] Config directory is empty — seeding from image defaults"
  mkdir -p /app/config
  cp -r /defaults/* /app/config/
fi

# Ensure mounted volumes are writable by the node user (UID 1000).
# When Docker auto-creates bind-mount directories on the host, they default
# to root:root — the node user can't write to them.
#
# This list must cover every path docker-compose.yml bind-mounts under /app
# (see its `volumes:` section — tests/unit/ci/docker-entrypoint-chown.test.ts
# derives the expected list from that file and fails if this one falls
# behind it).
#
# Real incident: /app/opaque-keys was missing from this list from the day
# opaque compact shipped. A brand-new volume there stayed root:root; the
# node user couldn't write the master keyring into it; the app failed
# closed with an error that reads like corrupted state ("keyring is missing
# while persisted state exists") instead of a permissions problem. That's
# exactly the "fresh volume + dropped-privilege user" combination a disaster
# recovery restore hits — the worst time to be misdiagnosed as data loss.
CHOWN_TARGETS="/app/data /app/config /app/opaque-keys"
if ! chown -R node:node $CHOWN_TARGETS 2>&1; then
  # Deliberately not fatal: some deployments intentionally pre-chown or use
  # a read-only mount (e.g. an NFS volume without root-squash disabled), and
  # this script runs as root — crashing here would take down a container
  # that may otherwise work fine. But silently swallowing the failure (the
  # previous `2>/dev/null || true`) is exactly how the /app/opaque-keys gap
  # above went unnoticed for this long. Surfacing it in the startup logs
  # costs nothing and turns a confusing downstream error into an obvious one.
  echo "[Init] WARNING: chown failed for one or more of: $CHOWN_TARGETS" >&2
  echo "[Init] If any of these are bind-mounted volumes, the node user may not be able to write to them." >&2
fi

exec gosu node "$@"
