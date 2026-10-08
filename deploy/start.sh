#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"
command -v docker >/dev/null 2>&1 || { echo "Install and start Docker Desktop or Docker Engine before running this script." >&2; exit 1; }
engine_type=$(docker info --format '{{.OSType}}' 2>/dev/null) || { echo "Docker engine is not ready. Complete Docker Desktop setup and wait for Engine running." >&2; exit 1; }
[ -n "$engine_type" ] || { echo "Docker engine is not ready. Complete Docker Desktop setup and wait for Engine running." >&2; exit 1; }
[ "$engine_type" = linux ] || { echo "This project requires Linux containers. Switch Docker Desktop to Linux containers." >&2; exit 1; }
sh "$script_dir/init-secrets.sh"
if [ "${CHATGPT:-0}" = 1 ]; then
  exec docker compose -f compose.yaml --profile chatgpt up --build "$@"
fi
exec docker compose -f compose.yaml up --build "$@"
