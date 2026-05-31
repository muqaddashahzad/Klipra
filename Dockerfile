# Multi-stage build for smaller final image
FROM python:3.11-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# Generous timeout + retries so a flaky network connection doesn't kill
# the build halfway through a large wheel download. Without these,
# the default 15s/3-retries was failing on 100 MB+ downloads.
ENV PIP_DEFAULT_TIMEOUT=300
ENV PIP_RETRIES=10
RUN pip install --upgrade pip
# Install torch / torchvision FIRST from the PyTorch CPU-only wheel
# index. This is critical for Mac builds: the default index serves
# CUDA-enabled wheels on aarch64 Linux (~2 GB including nvidia_cusparse,
# nvidia_cudnn, nvidia_cublas) which are USELESS in Docker on Mac
# (no GPU passthrough) AND fragile to download (one chunk timing out
# kills the whole build). The CPU index is ~10x smaller and has zero
# CUDA deps. Doing this BEFORE requirements.txt means ultralytics +
# faster-whisper find torch already installed and don't pull the
# default-index version.
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch torchvision
RUN pip install --no-cache-dir -r requirements.txt

# Final stage
FROM python:3.11-slim

WORKDIR /app

# Install FFmpeg, OpenCV dependencies, Node.js (for yt-dlp JS challenges),
# and FONTS for libass to render burned subtitles correctly.
#
# Font strategy — install the GENUINE Microsoft core fonts plus free
# Linux fallbacks:
#
#   ttf-mscorefonts-installer:
#     Lives in Debian's `contrib` repo (which we enable below). The
#     installer downloads Microsoft's TrueType Core Fonts pack from
#     SourceForge — Verdana, Arial, Impact, Helvetica, Georgia, Times
#     New Roman, Courier New, Comic Sans MS, plus the Tahoma family.
#     Microsoft's EULA permits free redistribution AS-IS; Debian's
#     installer auto-accepts via debconf preseeding (the
#     `accept-mscorefonts-eula select true` line below). After this
#     step, every name in our font picker resolves to the REAL font,
#     so burn and preview render identically.
#
#   fonts-dejavu / fonts-dejavu-extra / fonts-liberation:
#     Defensive fallback. If MS fonts ever fail to download (their
#     server can be flaky), the runtime fallback map in subtitles.py
#     remaps to these free metric-compatible alternatives. The -extra
#     package is what carries DejaVu Sans Condensed (the Impact
#     fallback) — it's NOT in the base fonts-dejavu.
#
#   fontconfig:
#     The library libass uses to look up family names. Without it,
#     libass falls back to a single compiled-in default for everything.
#
RUN echo "deb http://deb.debian.org/debian bookworm contrib" > /etc/apt/sources.list.d/contrib.list \
    && echo 'ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true' | debconf-set-selections \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    nodejs \
    fontconfig \
    fonts-dejavu \
    fonts-dejavu-extra \
    fonts-liberation \
    ttf-mscorefonts-installer \
    # Color emoji font — required for the viral-hook burn pipeline
    # (hooks.py renders the hook headline via Pillow; without an
    # emoji-capable font, glyphs like 👽 / 🇺🇸 come out as tofu squares
    # instead of the colorful icons shown in the preview).
    fonts-noto-color-emoji \
    fonts-symbola \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual env from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Always upgrade yt-dlp to latest (YouTube bot-detection changes frequently)
RUN pip install --upgrade --no-cache-dir yt-dlp

# Copy application code
COPY . .

# Create a non-root user (Moved up)
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

# Create directories including Ultralytics cache config
RUN mkdir -p /app/uploads /app/output /tmp/Ultralytics
# Fix permissions: /app for code/uploads, /tmp/Ultralytics for AI cache
RUN chown -R appuser:appuser /app /tmp/Ultralytics

# Switch to non-root user
USER appuser

# Pre-download YOLO model on build (now running as appuser)
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

# Expose FastAPI port
EXPOSE 8000

# Run FastAPI app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
