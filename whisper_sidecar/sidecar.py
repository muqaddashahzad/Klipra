"""Klipra Whisper Sidecar — native macOS Metal-accelerated Whisper.

Why this exists
---------------
Klipra runs in Docker. Docker on macOS uses a Linux VM that has NO
access to Metal (Apple's GPU API). So when transcription happens
inside the container it's CPU-only.

This sidecar runs OUTSIDE Docker, directly on the macOS host, where
it CAN use the M-series GPU. Klipra's Python backend POSTs audio
files here over loopback HTTP and gets a transcript back ~10-15×
faster than CPU.

Setup
-----
    cd whisper_sidecar
    ./start.sh

That script creates a venv, installs mlx-whisper + fastapi, and
launches the server on http://127.0.0.1:8765.

For Klipra to call it, set the env var before `docker compose up`:
    export KLIPRA_WHISPER_SIDECAR_URL="http://host.docker.internal:8765"

The sidecar is OPTIONAL. If it's not running, Klipra transparently
falls back to CPU faster-whisper inside the container — same
behaviour as before.

Endpoints
---------
    GET  /health       — { ok, model, device }
    POST /transcribe   — multipart upload of an audio/video file.
                          Form fields:
                              audio (UploadFile, required)
                              language (str, optional)  ISO code, e.g. 'ur'
                              initial_prompt (str, optional)
                              model (str, optional)     hf repo id override
                          Returns:
                              { text, segments[], language }
                          Same shape faster-whisper produces, so main.py
                          uses the result without any post-processing.
"""

import logging
import os
import tempfile
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import mlx_whisper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("klipra-sidecar")

# Default model — MLX-converted Whisper Turbo on HuggingFace. mlx-whisper
# downloads + caches it on first use (~1.5 GB). Override via the env
# var if you want a different model (e.g. "mlx-community/whisper-base").
DEFAULT_MODEL = os.environ.get(
    "KLIPRA_SIDECAR_MODEL",
    "mlx-community/whisper-large-v3-turbo",
)
HOST = os.environ.get("KLIPRA_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("KLIPRA_SIDECAR_PORT", "8765"))

app = FastAPI(title="Klipra Whisper Sidecar", version="1.0")

# Loopback only — we don't need cross-origin restrictions, but the
# Klipra dashboard runs on a different origin (vite dev server) and
# may want to probe /health someday from the browser. Allowing all
# is fine since the bind address is 127.0.0.1.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Cheap liveness check the Klipra backend hits before deciding
    whether to use the sidecar or the CPU fallback."""
    return {
        "ok": True,
        "model": DEFAULT_MODEL,
        "device": "mps (Apple Metal)",
        "service": "klipra-whisper-sidecar",
    }


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    initial_prompt: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
):
    """Transcribe an audio or video file with mlx-whisper on the
    Apple Silicon GPU.
    """
    repo = (model or DEFAULT_MODEL).strip()
    lang = (language or "").strip() or None
    log.info(
        "transcribe: file=%s size_hint=%s model=%s lang=%s",
        audio.filename,
        getattr(audio, "size", None),
        repo,
        lang or "auto",
    )

    suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    # delete=False because we want to keep it through the mlx-whisper
    # call — and that call internally invokes ffmpeg, which needs the
    # path to still exist when its subprocess starts.
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
        # Stream to disk so a 5 GB upload doesn't sit in RAM.
        while True:
            chunk = await audio.read(1024 * 1024)
            if not chunk:
                break
            tmp.write(chunk)

    try:
        log.info("Running mlx-whisper on %s ...", tmp_path)
        result = mlx_whisper.transcribe(
            tmp_path,
            path_or_hf_repo=repo,
            language=lang,
            initial_prompt=initial_prompt or None,
            word_timestamps=True,
        )
    except Exception as e:
        log.exception("mlx-whisper failed")
        raise HTTPException(status_code=500, detail=f"mlx-whisper failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # Normalise into the same shape faster-whisper would have produced
    # so the rest of Klipra's pipeline doesn't care which path ran.
    out_segments = []
    for seg in result.get("segments", []):
        ns = {
            "text": seg.get("text", ""),
            "start": float(seg.get("start", 0.0)),
            "end": float(seg.get("end", 0.0)),
            "words": [],
        }
        for w in seg.get("words") or []:
            ns["words"].append({
                "word": w.get("word", ""),
                "start": float(w.get("start", ns["start"])),
                "end": float(w.get("end", ns["end"])),
                "probability": float(w.get("probability", 1.0)),
            })
        out_segments.append(ns)

    payload = {
        "text": (result.get("text") or "").strip(),
        "segments": out_segments,
        "language": result.get("language") or lang or "",
    }
    log.info(
        "Done. detected_language=%s segments=%d",
        payload["language"],
        len(payload["segments"]),
    )
    return payload


if __name__ == "__main__":
    log.info("Starting Klipra Whisper Sidecar on http://%s:%d", HOST, PORT)
    log.info("Default model: %s (downloads on first use)", DEFAULT_MODEL)
    log.info("First request will pull the model — that one is slower; later requests are fast.")
    # access_log=False keeps the terminal quiet during long transcripts;
    # we still log the high-level events ourselves.
    uvicorn.run(app, host=HOST, port=PORT, log_level="info", access_log=False)
