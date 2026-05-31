#!/usr/bin/env bash
# One-command launcher for the Klipra Whisper sidecar.
#
# What this does:
#   1. Verifies you're on Apple Silicon (Metal needs an M-series chip).
#   2. Creates a Python venv in this folder (.venv) if missing.
#   3. Installs mlx-whisper + FastAPI inside that venv.
#   4. Starts the server on http://127.0.0.1:8765.
#
# After it's running, set this in your shell once and `docker compose up`
# Klipra:
#     export KLIPRA_WHISPER_SIDECAR_URL="http://host.docker.internal:8765"
#
# To run on every boot, see the launchd snippet at the bottom of
# whisper_sidecar/README.md.

set -euo pipefail

cd "$(dirname "$0")"

# --- guardrails ------------------------------------------------------
if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ This sidecar only makes sense on macOS (Apple Metal). Detected: $(uname)" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "❌ This sidecar requires an Apple Silicon Mac (M1/M2/M3/M4). Detected arch: $(uname -m)" >&2
  echo "    On Intel Macs, the Docker CPU path is the right one — close this terminal and use Klipra normally." >&2
  exit 1
fi

PY="${PYTHON:-python3}"
VENV=".venv"

# --- venv ------------------------------------------------------------
if [[ ! -d "$VENV" ]]; then
  echo "🧪 Creating Python virtualenv in $VENV ..."
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

# --- deps ------------------------------------------------------------
# pip-install once. The mlx-whisper wheel is ~50 MB; the model itself
# (Whisper Turbo, ~1.5 GB) is downloaded on the FIRST transcription
# request, not now.
if ! python -c "import mlx_whisper" 2>/dev/null; then
  echo "📦 Installing dependencies (one-time, ~50 MB) ..."
  pip install --upgrade pip
  pip install -r requirements.txt
fi

# --- run -------------------------------------------------------------
echo ""
echo "🚀 Starting Klipra Whisper Sidecar on http://127.0.0.1:8765"
echo "   First transcription pulls the model (~1.5 GB) — be patient ~2 minutes."
echo "   Later transcriptions are ~10-15× faster than CPU."
echo ""
echo "   Tell Klipra to use it:"
echo "     export KLIPRA_WHISPER_SIDECAR_URL='http://host.docker.internal:8765'"
echo "     cd /path/to/openshorts-fork && docker compose up -d"
echo ""

exec python sidecar.py
