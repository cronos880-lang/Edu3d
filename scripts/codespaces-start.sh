#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -x .venv/bin/python || ! -f frontend/dist/index.html ]]; then
  echo 'Falta preparar Edu3d. Ejecuta bash scripts/setup.sh y vuelve a iniciar el entorno.' >&2
  exit 1
fi

export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PWD/.local/cache}"
mkdir -p .local "$XDG_CACHE_HOME"
log_file="$PWD/.local/codespaces-server.log"
pid_file="$PWD/.local/codespaces-server.pid"

# Serialize repeated lifecycle calls. The server closes this lock descriptor.
exec 9>"$PWD/.local/codespaces-start.lock"
if ! flock --wait 55 9; then
  echo 'Hay otro inicio de Edu3d en curso. Revisa .local/codespaces-server.log.' >&2
  exit 1
fi

check_ready() {
  .venv/bin/python - <<'PY'
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=1) as response:
        result = json.load(response)
    ready = result.get("status") == "ok" and result.get("kernel") == "OpenCascade"
except Exception:
    ready = False
sys.exit(0 if ready else 1)
PY
}

print_location() {
  if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
    printf 'Edu3d listo: https://%s-8000.%s\n' "$CODESPACE_NAME" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  else
    echo 'Edu3d listo. Abre el puerto 8000 en la pestaña Puertos de Codespaces.'
  fi
  echo 'El puerto reenviado permanece privado. Registro: .local/codespaces-server.log'
}

if check_ready; then
  print_location
  exit 0
fi

server_pid=''
if [[ -r "$pid_file" ]]; then
  read -r previous_pid < "$pid_file" || true
  if [[ "${previous_pid:-}" =~ ^[0-9]+$ ]] && kill -0 "$previous_pid" 2>/dev/null; then
    server_pid="$previous_pid"
  fi
fi

if [[ -z "$server_pid" ]]; then
  nohup .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 \
    </dev/null >>"$log_file" 2>&1 9>&- &
  server_pid=$!
  printf '%s\n' "$server_pid" > "$pid_file"
fi

for ((attempt = 1; attempt <= 45; attempt++)); do
  if check_ready; then
    print_location
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo 'El servidor de Edu3d se ha detenido durante el inicio:' >&2
    tail -n 30 "$log_file" >&2
    exit 1
  fi
  sleep 1
done

echo 'Edu3d no ha respondido a tiempo. Revisa .local/codespaces-server.log.' >&2
tail -n 30 "$log_file" >&2
exit 1
