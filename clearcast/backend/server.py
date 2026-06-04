"""Clearcast API server — FastAPI + a single-worker job queue + static UI.

Jobs are processed STRICTLY ONE AT A TIME (a single background worker pulls
from a FIFO queue), so a batch of uploads is enhanced sequentially.
"""
from __future__ import annotations

import os
import queue
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import pipeline

ROOT = Path(__file__).resolve().parent.parent
JOBS = ROOT / "jobs"
WEB = ROOT / "web"
JOBS.mkdir(exist_ok=True)

app = FastAPI(title="Clearcast", docs_url=None, redoc_url=None)

# Allow the Klipra dashboard (and direct localhost access) to call us. When
# reached through Klipra's Vite proxy this is same-origin anyway; CORS just
# makes direct cross-port access work too.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"], allow_headers=["*"], allow_credentials=False,
)

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_q: "queue.Queue[str]" = queue.Queue()

ALLOWED_SUFFIXES = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff",
    ".wma", ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
}

# ---- Direct local-file access (no upload) -----------------------------------
# Klipra's "Use file from disk" returns an in-CONTAINER path (e.g.
# /app/local_movies/x.mp4). We run on the HOST, so map those prefixes back to
# the real host folders, and only allow files under this allowlist.
_HOME = os.path.expanduser("~")
_CONTAINER_TO_HOST = {
    "/app/local_media": f"{_HOME}/Desktop/Movies",
    "/app/local_desktop": f"{_HOME}/Desktop",
    "/app/local_downloads": f"{_HOME}/Downloads",
    "/app/local_documents": f"{_HOME}/Documents",
    "/app/local_movies": f"{_HOME}/Movies",
    "/app/uploads": "/Volumes/Data/AntiGravity/Klipra/uploads",
}
_ALLOWED_HOST_ROOTS = [
    f"{_HOME}/Desktop", f"{_HOME}/Downloads", f"{_HOME}/Documents",
    f"{_HOME}/Movies", f"{_HOME}/Music", "/Volumes/Data/AntiGravity/Klipra/uploads",
]


def _resolve_local_path(raw: str) -> Path:
    """Map a Klipra container path (or accept a host path) to a real, allowed host file."""
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(400, "No path provided")
    mapped = raw
    for cprefix, hprefix in _CONTAINER_TO_HOST.items():
        if raw == cprefix or raw.startswith(cprefix + "/"):
            mapped = hprefix + raw[len(cprefix):]
            break
    p = Path(mapped).expanduser().resolve()
    if not p.exists() or not p.is_file():
        raise HTTPException(404, f"File not found: {raw}")
    if not any(str(p).startswith(str(Path(r).resolve()) + os.sep) for r in _ALLOWED_HOST_ROOTS):
        raise HTTPException(403, "Path is outside the allowed folders")
    if p.suffix.lower() not in ALLOWED_SUFFIXES:
        raise HTTPException(400, f"Unsupported file type: {p.suffix}")
    return p


def _set(jid: str, **kw) -> None:
    with _lock:
        if jid in _jobs:
            _jobs[jid].update(kw)


def _public(job: dict) -> dict:
    keep = ("id", "status", "stage", "progress", "message", "filename",
            "created", "meta", "error", "output_format", "ahead")
    out = {k: job.get(k) for k in keep if k in job}
    out["has_result"] = job.get("status") == "done"
    out["has_video"] = bool(job.get("_out_video"))
    return out


# --------------------------------------------------------------------------- #
# single worker — sequential processing
# --------------------------------------------------------------------------- #
def _worker_loop() -> None:
    while True:
        jid = _q.get()
        try:
            _process_job(jid)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        finally:
            _q.task_done()
            _recount_queue()


def _process_job(jid: str) -> None:
    with _lock:
        job = _jobs.get(jid)
    if not job:
        return
    in_path = Path(job["_in"])
    jdir = Path(job["_dir"])
    opts = job["_opts"]

    def cb(stage: str, progress: float, message: str) -> None:
        _set(jid, status="processing", stage=stage, progress=progress,
             message=message, ahead=0)

    try:
        _set(jid, status="processing", message="Starting…", ahead=0)
        out_audio, out_video, meta = pipeline.enhance(in_path, jdir, opts, cb)
        _set(jid, status="done", stage="done", progress=1.0, message="Done",
             meta=meta, _out=str(out_audio),
             _out_video=(str(out_video) if out_video else None),
             _origaudio=str(jdir / "src48.wav"))
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _set(jid, status="error", message="Enhancement failed", error=str(exc))


def _recount_queue() -> None:
    """Update each queued job's 'ahead' count for nicer UX."""
    with _lock:
        pending = [j for j in _jobs.values() if j["status"] == "queued"]
        pending.sort(key=lambda j: j["created"])
        for i, j in enumerate(pending):
            j["ahead"] = i + (1 if any(x["status"] == "processing" for x in _jobs.values()) else 0)


threading.Thread(target=_worker_loop, daemon=True).start()


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    with _lock:
        active = sum(1 for j in _jobs.values() if j["status"] in ("queued", "processing"))
    return {"ok": True, "engines": pipeline.detect_engines(), "active_jobs": active}


def _opts_from(engine, remove_music, strength, warmth, output_format, target_lufs,
               dereverb="false") -> dict:
    truthy = ("true", "1", "yes", "on")
    return {
        "engine": engine,
        "remove_music": str(remove_music).lower() in truthy,
        "dereverb": str(dereverb).lower() in truthy,
        "strength": float(strength),
        "warmth": float(warmth),
        "output_format": "mp3" if str(output_format).lower() == "mp3" else "wav",
        "target_lufs": float(target_lufs),
        "make_video": True,
    }


def _enqueue(filename: str, in_path: Path, opts: dict, local: bool = False) -> str:
    jid = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[jid] = {
            "id": jid, "status": "queued", "stage": "queued", "progress": 0.0,
            "message": "Queued", "filename": filename, "created": time.time(),
            "output_format": opts["output_format"], "ahead": 0, "local": local,
            "_in": str(in_path), "_dir": str(JOBS / jid), "_opts": opts,
        }
    (JOBS / jid).mkdir(parents=True, exist_ok=True)
    _q.put(jid)
    _recount_queue()
    return jid


@app.post("/api/enhance")
async def enhance(
    file: UploadFile = File(...),
    engine: str = Form("auto"),
    remove_music: str = Form("false"),
    strength: float = Form(1.0),
    warmth: float = Form(0.6),
    output_format: str = Form("wav"),
    target_lufs: float = Form(-16.0),
    dereverb: str = Form("false"),
):
    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(400, f"Unsupported file type: {suffix or 'unknown'}")
    opts = _opts_from(engine, remove_music, strength, warmth, output_format, target_lufs, dereverb)
    jid = uuid.uuid4().hex[:12]
    jdir = JOBS / jid
    jdir.mkdir(parents=True, exist_ok=True)
    in_path = jdir / ("input" + suffix)
    with open(in_path, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    if in_path.stat().st_size == 0:
        raise HTTPException(400, "Uploaded file is empty")
    with _lock:
        _jobs[jid] = {
            "id": jid, "status": "queued", "stage": "queued", "progress": 0.0,
            "message": "Queued", "filename": file.filename, "created": time.time(),
            "output_format": opts["output_format"], "ahead": 0, "local": False,
            "_in": str(in_path), "_dir": str(jdir), "_opts": opts,
        }
    _q.put(jid)
    _recount_queue()
    return {"job_id": jid}


@app.post("/api/enhance_local")
async def enhance_local(
    path: str = Form(...),
    engine: str = Form("auto"),
    remove_music: str = Form("false"),
    strength: float = Form(1.0),
    warmth: float = Form(0.6),
    output_format: str = Form("wav"),
    target_lufs: float = Form(-16.0),
    dereverb: str = Form("false"),
):
    """Process a file the user located on their own disk — read it IN PLACE,
    no upload/copy (works for multi-GB videos)."""
    src = _resolve_local_path(path)
    opts = _opts_from(engine, remove_music, strength, warmth, output_format, target_lufs, dereverb)
    jid = _enqueue(src.name, src, opts, local=True)
    return {"job_id": jid}


@app.get("/api/status/{jid}")
def status(jid: str):
    with _lock:
        if jid not in _jobs:
            raise HTTPException(404, "job not found")
        return _public(dict(_jobs[jid]))


def _job_or_404(jid: str) -> dict:
    with _lock:
        if jid not in _jobs:
            raise HTTPException(404, "job not found")
        return dict(_jobs[jid])


@app.get("/api/audio/{jid}/{which}")
def audio(jid: str, which: str):
    job = _job_or_404(jid)
    if which == "enhanced":
        path = job.get("_out")
    else:  # original — serve the decoded 48k wav (always browser-playable)
        path = job.get("_origaudio") or job.get("_in")
    if not path or not Path(path).exists():
        raise HTTPException(404, "audio not ready")
    return FileResponse(path)


@app.get("/api/media/{jid}/{which}")
def media(jid: str, which: str):
    """Inline media for the A/B preview player. Video-aware: for a video job the
    'enhanced' media is the re-muxed video; 'original' is the source file."""
    job = _job_or_404(jid)
    meta = job.get("meta") or {}
    if which == "enhanced":
        path = job.get("_out_video") if meta.get("is_video") else job.get("_out")
    else:
        path = job.get("_in")  # original source (video or audio)
    if not path or not Path(path).exists():
        raise HTTPException(404, "media not ready")
    return FileResponse(path)


@app.get("/api/download/{jid}")
def download(jid: str):
    job = _job_or_404(jid)
    path = job.get("_out")
    if not path or not Path(path).exists():
        raise HTTPException(404, "result not ready")
    base = Path(job.get("filename") or "audio").stem
    return FileResponse(path, filename=f"{base}_clearcast{Path(path).suffix}",
                        media_type="application/octet-stream")


@app.get("/api/download/{jid}/video")
def download_video(jid: str):
    job = _job_or_404(jid)
    path = job.get("_out_video")
    if not path or not Path(path).exists():
        raise HTTPException(404, "video not ready")
    base = Path(job.get("filename") or "video").stem
    return FileResponse(path, filename=f"{base}_clearcast.mp4",
                        media_type="application/octet-stream")


# static UI last so /api/* takes precedence
app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
