#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
edu3d_cache_dir="${XDG_CACHE_HOME:-$PWD/.local/cache}"
mkdir -p "$edu3d_cache_dir"
export XDG_CACHE_HOME="$edu3d_cache_dir"

python3 -m venv .venv
if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python --require-hashes -r requirements.txt --cache-dir "$edu3d_cache_dir/uv"
else
  .venv/bin/python -m pip install --require-hashes -r requirements.txt --cache-dir "$edu3d_cache_dir/pip"
fi
npm --prefix frontend ci --no-audit --no-fund --cache "$edu3d_cache_dir/npm"
npm --prefix frontend run build
npm --prefix browser ci --no-audit --no-fund --cache "$edu3d_cache_dir/npm"
npm --prefix browser run build
