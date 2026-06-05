# Clearcast — audio-cleaning engine, runs as a Klipra Docker service.
FROM python:3.11-slim

# ffmpeg = decode / master / video re-mux ; git/ca-certs for pip + model fetch
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/app/.cache \
    TORCH_HOME=/app/.cache/torch \
    HF_HOME=/app/.cache/huggingface

WORKDIR /app

# Dependencies first (Docker layer cache). On linux/arm64 these resolve to CPU builds.
COPY requirements.txt requirements-ml.txt ./
RUN pip install -r requirements.txt -r requirements-ml.txt

# App source (the compose bind-mount overlays this at runtime for live edits).
COPY . /app

EXPOSE 8770
CMD ["uvicorn", "server:app", "--app-dir", "backend", \
     "--host", "0.0.0.0", "--port", "8770", "--log-level", "warning"]
