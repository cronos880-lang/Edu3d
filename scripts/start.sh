#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PWD/.local/cache}"
mkdir -p "$XDG_CACHE_HOME"
if [[ ! -x .venv/bin/python || ! -f frontend/dist/index.html ]]; then
  echo 'Ejecuta bash scripts/setup.sh antes de iniciar Edu3d.' >&2
  exit 1
fi
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "${PORT:-8000}"
