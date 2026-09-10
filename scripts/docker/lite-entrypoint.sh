#!/bin/sh
set -e

# Seed an empty config bind mount with the image defaults. docker-compose.yml
# mounts ./config onto /app/config; on a fresh install that directory is empty
# and shadows the config files baked into the image — without seeding, the
# server exits on the missing default.yaml.
if [ -d /defaults ] && [ -z "$(ls -A /app/config 2>/dev/null)" ]; then
  echo "[Init] Config directory is empty — seeding from image defaults"
  cp -r /defaults/* /app/config/
fi

exec "$@"
