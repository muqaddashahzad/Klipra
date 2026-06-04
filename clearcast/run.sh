#!/usr/bin/env bash
# Clearcast — launch the local app.
set -e
cd "$(dirname "$0")"
PORT="${CLEARCAST_PORT:-8765}"

if [ ! -x .venv/bin/python ]; then
  echo "First run — installing. This downloads a few hundred MB of AI models…"
  bash setup.sh
fi

echo "▶ Clearcast running at http://127.0.0.1:${PORT}"
( sleep 1.2; open "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true ) &
exec .venv/bin/python -m uvicorn server:app \
  --app-dir backend --host 127.0.0.1 --port "${PORT}" --log-level warning
