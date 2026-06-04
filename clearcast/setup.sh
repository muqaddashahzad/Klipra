#!/usr/bin/env bash
# Clearcast — one-time setup. Installs the Python env + AI engines.
set -e
cd "$(dirname "$0")"
echo "▶ Clearcast setup"

# 1. ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  installing ffmpeg via brew…"
  brew install ffmpeg
fi

# 2. venv (Python 3.11 via uv)
if [ ! -x .venv/bin/python ]; then
  echo "  creating venv (Python 3.11)…"
  uv venv --python 3.11 .venv
fi

# 3. light server deps
echo "  installing server deps…"
uv pip install --python .venv fastapi "uvicorn[standard]" python-multipart soundfile numpy requests

# 4. heavy AI engines
echo "  installing AI engines (torch / clearvoice / demucs — large download)…"
uv pip install --python .venv torch torchaudio
uv pip install --python .venv demucs
# ClearVoice (MossFormer2). Fall back to the source repo if the PyPI name moves.
uv pip install --python .venv clearvoice || \
  uv pip install --python .venv "git+https://github.com/modelscope/ClearerVoice-Studio.git#subdirectory=clearvoice"

# 5. DeepFilterNet binary (fast engine)
bash scripts/get_deepfilter.sh || echo "  (deep-filter binary optional — skipped)"

echo "✓ setup complete. Run ./run.sh"
