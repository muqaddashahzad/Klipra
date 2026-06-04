import os
import uuid
import subprocess
import threading
import json
import shutil
import glob
import time
import asyncio
import copy
import secrets
from dotenv import load_dotenv
from typing import Dict, Optional, List, Any
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from s3_uploader import upload_job_artifacts, list_all_clips, upload_actor_to_s3, list_actor_gallery, upload_video_to_gallery, list_video_gallery
from transcript_utils import llm_rewrite_transcript as _llm_rewrite_transcript
from transcript_utils import llm_align_lyrics_to_whisper as _llm_align_lyrics_to_whisper
from transcript_utils import llm_translate_full_lyrics as _llm_translate_full_lyrics
from transcript_utils import (
    verify_chorus_coverage as _verify_chorus_coverage,
    recover_missing_blocks as _recover_missing_blocks,
    split_whisper_mega_segments as _split_whisper_mega_segments,
    chunk_segments_by_word_count as _chunk_segments_by_word_count,
)

load_dotenv()

# Constants
UPLOAD_DIR = "uploads"
OUTPUT_DIR = "output"


def _clip_filename_from_url(video_url: str) -> str:
    """Extract a bare filename from a clip's `video_url`.

    The frontend (and our retrim/reframe endpoints) append a cache-buster
    like `?v=12345` after re-rendering so the <video> tag reloads. Without
    stripping that, splitting by '/' leaves the query string fused to the
    filename and every subsequent disk lookup misses.
    """
    if not video_url:
        return ""
    name = video_url.split("?")[0].split("/")[-1]
    # The frontend may have URL-encoded the filename for the <video src>
    # (we encode characters like $, spaces, en-dash). Decode it back to
    # the on-disk name.
    try:
        from urllib.parse import unquote
        return unquote(name)
    except Exception:
        return name


def _safe_filename(name: str) -> str:
    """Return a filename safe for URLs, FFmpeg arguments, and shell paths.

    Replaces or strips:
      • non-ASCII characters (en-dash, smart quotes, etc.)
      • shell-special chars ($, &, #, %, |, ;, *, ?)
      • path separators (/, \\)
      • leading/trailing whitespace and dots
    Keeps spaces converted to underscores so the human-readable structure
    survives. Falls back to a hash if everything ends up stripped.
    """
    import re
    import hashlib
    if not name:
        return f"upload_{int(time.time())}"
    # Split off extension to preserve it.
    base, ext = os.path.splitext(name)
    # Strip non-ASCII; replace whitespace with _; drop unsafe punctuation.
    base = base.encode('ascii', 'ignore').decode('ascii')
    base = re.sub(r'\s+', '_', base)
    base = re.sub(r'[^A-Za-z0-9._\-]', '', base)
    base = base.strip('._-') or hashlib.md5(name.encode('utf-8')).hexdigest()[:10]
    ext = re.sub(r'[^A-Za-z0-9.]', '', ext) or '.mp4'
    # Cap length so filenames don't blow past 255-byte filesystem limits.
    return (base[:120] + ext)[:200]


def _apply_clip_change(
    job_id: str,
    clip_index: int,
    new_filename: str,
    *,
    operation: str,
    extra: Optional[dict] = None,
) -> str:
    """Push the current clip video into the per-clip undo stack and swap
    in a freshly-rendered file.

    Why this exists:
      - Every mutating endpoint (auto-edit, hook, subtitle, dub, retrim,
        reframe) used to do a slightly different version of the same
        boilerplate: rewrite metadata.json, update jobs[job_id], return
        a URL. They each forgot something — usually the cache-bust query
        string (so the browser kept showing the unedited version) or the
        on-disk metadata persistence (so a page refresh lost the edit).
      - This helper centralizes all of it: history push for Undo, both
        in-memory + on-disk metadata sync, cache-bust URL.

    Returns the new public URL (with `?v=<ts>` cache-bust).
    """
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    # Mint a cache-bust suffix per call so the browser <video> reloads.
    cache_bust = int(time.time() * 1000)
    new_url = f"/videos/{job_id}/{new_filename}?v={cache_bust}"

    # Update on-disk metadata so a page reload still shows the edit.
    if json_files:
        try:
            with open(json_files[0], 'r') as f:
                data = json.load(f)
            shorts = data.get('shorts', [])
            if 0 <= clip_index < len(shorts):
                clip = shorts[clip_index]
                history = clip.get('history') or []
                # Push the current state into the undo stack BEFORE
                # overwriting it. We store filename + the operation label
                # so the Undo button can show "Undo subtitle" etc.
                prev_url = clip.get('video_url', '')
                if prev_url:
                    history.append({
                        'video_url': prev_url,
                        'operation': operation,
                        'ts': cache_bust,
                    })
                clip['history'] = history[-10:]  # cap depth at 10
                clip['video_url'] = new_url
                if extra:
                    for k, v in extra.items():
                        clip[k] = v
                data['shorts'] = shorts
                with open(json_files[0], 'w') as f:
                    json.dump(data, f, indent=2)
        except Exception as e:
            print(f"⚠️  Failed to update metadata.json: {e}")

    # Mirror to in-memory job state too.
    record = jobs.get(job_id)
    if record and 'result' in record and 'clips' in record['result']:
        in_mem = record['result']['clips']
        if 0 <= clip_index < len(in_mem):
            clip_mem = in_mem[clip_index]
            history = clip_mem.get('history') or []
            prev_url = clip_mem.get('video_url', '')
            if prev_url:
                history.append({
                    'video_url': prev_url,
                    'operation': operation,
                    'ts': cache_bust,
                })
            clip_mem['history'] = history[-10:]
            clip_mem['video_url'] = new_url
            if extra:
                for k, v in extra.items():
                    clip_mem[k] = v

    return new_url


os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Configuration
# Default to 1 if not set, but user can set higher for powerful servers
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "5"))
MAX_FILE_SIZE_MB = int(os.environ.get("KLIPRA_MAX_FILE_SIZE_MB", "5120"))  # 5 GB default

# ---------- Local-file (no-upload) source mode ----------
# When the app runs on the SAME machine that holds the source media
# (single-user desktop / dev workstation), uploading every clip
# round-trips a multi-gigabyte file through HTTP into UPLOAD_DIR — even
# though the bytes are already sitting on disk. Local-mode lets the
# user pick a file BY PATH instead. Backend reads it directly. No copy.
#
# SECURITY: arbitrary paths from a browser are dangerous in any
# multi-tenant deployment, so the feature is OFF by default and
# additionally requires an allowlist of root directories — a request
# can only resolve to a path that is INSIDE one of those roots.
#
# Enable: set both env vars in your .env / compose file:
#   KLIPRA_LOCAL_MODE=1
#   KLIPRA_LOCAL_MEDIA_ROOTS=/app/local_media,/app/uploads
# In docker-compose.yml, also bind-mount the host folder you want to
# expose, e.g.:
#   volumes:
#     - ${HOME}/Movies:/app/local_media:ro
KLIPRA_LOCAL_MODE = os.environ.get("KLIPRA_LOCAL_MODE", "0").strip().lower() in ("1", "true", "yes", "on")
_local_roots_raw = os.environ.get("KLIPRA_LOCAL_MEDIA_ROOTS", "").strip()
KLIPRA_LOCAL_MEDIA_ROOTS = [
    os.path.realpath(r.strip())
    for r in _local_roots_raw.split(",")
    if r.strip()
]
# Allowed media extensions for the local-path mode. Mirrors the upload
# accept= filter in the dashboard.
KLIPRA_LOCAL_ALLOWED_EXTS = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv",
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac",
}


def _resolve_local_media_path(local_path: str) -> str:
    """Validate a user-supplied filesystem path and return the resolved
    absolute path, OR raise HTTPException with the right status.

    Checks performed:
      1. KLIPRA_LOCAL_MODE must be enabled (server-side opt-in).
      2. At least one root must be configured.
      3. The resolved path (after symlink expansion) must be UNDER
         one of the configured roots — defends against `..` escapes
         and crafted symlinks.
      4. The path must exist, be a regular file, be readable.
      5. The extension must be in the allowed media list.
      6. The size must be ≤ MAX_FILE_SIZE_MB (parity with upload).

    Returns the canonical absolute path the rest of the pipeline can
    treat as input_path.
    """
    if not KLIPRA_LOCAL_MODE:
        raise HTTPException(
            status_code=403,
            detail=(
                "Local-file mode is disabled on this server. "
                "Set KLIPRA_LOCAL_MODE=1 and configure "
                "KLIPRA_LOCAL_MEDIA_ROOTS to enable."
            ),
        )
    if not KLIPRA_LOCAL_MEDIA_ROOTS:
        raise HTTPException(
            status_code=500,
            detail=(
                "Local-file mode is enabled but no media roots are "
                "configured. Set KLIPRA_LOCAL_MEDIA_ROOTS in your "
                "environment, e.g. /app/local_media."
            ),
        )
    if not local_path or not isinstance(local_path, str):
        raise HTTPException(status_code=400, detail="Missing or invalid local_path.")
    # Normalize. realpath resolves symlinks so a malicious symlink
    # under a root can't point outside the root.
    try:
        resolved = os.path.realpath(local_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not resolve path: {e}")
    # Containment check. We compare directory prefixes with a trailing
    # separator so /app/local_media2 doesn't accidentally match a root
    # of /app/local_media.
    inside = False
    for root in KLIPRA_LOCAL_MEDIA_ROOTS:
        root_norm = root.rstrip(os.sep) + os.sep
        if (resolved + os.sep).startswith(root_norm):
            inside = True
            break
    if not inside:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Path is not inside an allowed media root. "
                f"Allowed roots: {', '.join(KLIPRA_LOCAL_MEDIA_ROOTS)}"
            ),
        )
    if not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail=f"File not found: {resolved}")
    if not os.path.isfile(resolved):
        raise HTTPException(status_code=400, detail=f"Path is not a regular file: {resolved}")
    if not os.access(resolved, os.R_OK):
        raise HTTPException(status_code=403, detail=f"File is not readable: {resolved}")
    ext = os.path.splitext(resolved)[1].lower()
    if ext not in KLIPRA_LOCAL_ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported file extension '{ext}'. Allowed: "
                + ", ".join(sorted(KLIPRA_LOCAL_ALLOWED_EXTS))
            ),
        )
    try:
        size = os.path.getsize(resolved)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not stat file: {e}")
    limit_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    if size > limit_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size / 1024 / 1024:.0f} MB). Max {MAX_FILE_SIZE_MB} MB.",
        )
    return resolved
# Job retention. Two tiers:
#   - SUCCEEDED jobs (metadata.json present)  → 30 days (env override).
#     This is your real "creator workflow" — the user invested time picking
#     clips, retrimming, reframing, dubbing. Wiping it after 1 hour was the
#     "my projects auto-deleted" bug.
#   - FAILED / ORPHAN jobs (no metadata.json) → 6 hours.
#     Crashed downloads, killed processes, etc.
# Override either via env vars to suit your storage budget.
#
# Default = 0 (never auto-delete) so completed Past Projects only disappear
# when the user explicitly clicks the trash button. Users who want a real
# TTL can opt in via env (e.g. KLIPRA_JOB_RETENTION_SUCCESS_SECONDS=2592000
# for 30 days). Failed/orphan jobs still get cleaned up automatically.
JOB_RETENTION_SECONDS_SUCCESS = int(os.environ.get("KLIPRA_JOB_RETENTION_SUCCESS_SECONDS", "0"))
JOB_RETENTION_SECONDS_FAILED  = int(os.environ.get("KLIPRA_JOB_RETENTION_FAILED_SECONDS", str(6 * 3600)))
# Legacy variable still referenced in places — kept as the SUCCESS default.
JOB_RETENTION_SECONDS = JOB_RETENTION_SECONDS_SUCCESS

# Application State
job_queue = asyncio.Queue()
jobs: Dict[str, Dict] = {}
thumbnail_sessions: Dict[str, Dict] = {}
publish_jobs: Dict[str, Dict] = {}  # {publish_id: {status, result, error}}
# Semester to limit concurrency to MAX_CONCURRENT_JOBS
concurrency_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)

def _relocate_root_job_artifacts(job_id: str, job_output_dir: str) -> bool:
    """
    Backward-compat rescue:
    If main.py accidentally wrote metadata/clips into OUTPUT_DIR root (e.g. output/<jobid>_...),
    move them into output/<job_id>/ so the API can find and serve them.
    """
    try:
        os.makedirs(job_output_dir, exist_ok=True)
        root = OUTPUT_DIR
        pattern = os.path.join(root, f"{job_id}_*_metadata.json")
        meta_candidates = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p), reverse=True)
        if not meta_candidates:
            return False

        # Move the newest metadata and its associated clips.
        metadata_path = meta_candidates[0]
        base_name = os.path.basename(metadata_path).replace("_metadata.json", "")

        # Move metadata
        dest_metadata = os.path.join(job_output_dir, os.path.basename(metadata_path))
        if os.path.abspath(metadata_path) != os.path.abspath(dest_metadata):
            shutil.move(metadata_path, dest_metadata)

        # Move any clips that match the same base_name into the job folder
        clip_pattern = os.path.join(root, f"{base_name}_clip_*.mp4")
        for clip_path in glob.glob(clip_pattern):
            dest_clip = os.path.join(job_output_dir, os.path.basename(clip_path))
            if os.path.abspath(clip_path) != os.path.abspath(dest_clip):
                shutil.move(clip_path, dest_clip)

        # Also move any temp_ clips that might remain
        temp_clip_pattern = os.path.join(root, f"temp_{base_name}_clip_*.mp4")
        for clip_path in glob.glob(temp_clip_pattern):
            dest_clip = os.path.join(job_output_dir, os.path.basename(clip_path))
            if os.path.abspath(clip_path) != os.path.abspath(dest_clip):
                shutil.move(clip_path, dest_clip)

        return True
    except Exception:
        return False

async def cleanup_jobs():
    """Background task to remove ONLY orphan/failed job folders.

    Policy (after a long history of users losing files unexpectedly):
      • Standalone folders (`standalone_*`) — NEVER auto-deleted. They
        have their own per-job delete UI inside Subtitle / Dub past
        projects, so user-controlled deletion is the only path.
      • Clip-gen folders that contain a `*_metadata.json` (i.e. they
        completed and the user has work invested there) — only
        auto-deleted when JOB_RETENTION_SECONDS_SUCCESS is a non-zero
        positive number AND they exceed it. Default is 0 = never.
      • Folders WITHOUT metadata are treated as crashed/orphan and
        get the FAILED retention (default 6h) so the cleanup loop
        still does something useful.
      • Uploaded source files follow the same rules — never deleted
        when SUCCESS retention is 0; otherwise aged out together with
        the job folder.
    """
    import time
    print(
        f"🧹 Cleanup task started (success="
        f"{'never' if JOB_RETENTION_SECONDS_SUCCESS <= 0 else f'{JOB_RETENTION_SECONDS_SUCCESS}s'}, "
        f"failed={JOB_RETENTION_SECONDS_FAILED}s)."
    )
    while True:
        try:
            await asyncio.sleep(300)  # check every 5 minutes
            now = time.time()

            # ----- OUTPUT_DIR per-job folders -----
            for job_id in os.listdir(OUTPUT_DIR):
                job_path = os.path.join(OUTPUT_DIR, job_id)
                if not os.path.isdir(job_path):
                    continue
                # NEVER touch standalone folders. They self-manage and
                # have their own delete UI. This was the bug that caused
                # Past Subtitle / Dub videos to disappear after 6h.
                if job_id.startswith("standalone_"):
                    continue
                metadata_files = glob.glob(os.path.join(job_path, "*_metadata.json"))
                age = now - os.path.getmtime(job_path)
                if metadata_files:
                    # Completed job. Auto-delete only when the user has
                    # opted into a positive TTL. Zero = keep forever.
                    if JOB_RETENTION_SECONDS_SUCCESS <= 0:
                        continue
                    if age <= JOB_RETENTION_SECONDS_SUCCESS:
                        continue
                    kind = "completed"
                else:
                    # Crashed / orphan. Always cleaned up after the
                    # FAILED threshold so we don't leak disk space.
                    if age <= JOB_RETENTION_SECONDS_FAILED:
                        continue
                    kind = "failed/orphan"
                print(f"🧹 Purging old {kind} job: {job_id} (age {age/3600:.1f}h)")
                shutil.rmtree(job_path, ignore_errors=True)
                if job_id in jobs:
                    del jobs[job_id]

            # ----- SaaSShorts in-memory jobs -----
            try:
                if JOB_RETENTION_SECONDS_SUCCESS > 0:
                    saas_expired = [
                        jid for jid, jdata in list(saas_jobs.items())
                        if jdata.get("status") in ("completed", "failed")
                        and jdata.get("output_dir")
                        and os.path.isdir(jdata["output_dir"])
                        and now - os.path.getmtime(jdata["output_dir"]) > JOB_RETENTION_SECONDS_SUCCESS
                    ]
                    for jid in saas_expired:
                        del saas_jobs[jid]
            except NameError:
                pass

            # ----- UPLOAD_DIR raw uploads -----
            # Same TTL semantics as the success policy. When the user
            # opts out (default 0) we never delete uploaded sources,
            # which keeps retrim / reframe / regenerate-from-original
            # functional indefinitely.
            if JOB_RETENTION_SECONDS_SUCCESS > 0:
                for filename in os.listdir(UPLOAD_DIR):
                    file_path = os.path.join(UPLOAD_DIR, filename)
                    try:
                        if now - os.path.getmtime(file_path) > JOB_RETENTION_SECONDS_SUCCESS:
                            os.remove(file_path)
                    except Exception:
                        pass

        except Exception as e:
            print(f"⚠️ Cleanup error: {e}")

async def process_queue():
    """Background worker to process jobs from the queue with concurrency limit."""
    print(f"🚀 Job Queue Worker started with {MAX_CONCURRENT_JOBS} concurrent slots.")
    while True:
        try:
            # Wait for a job
            job_id = await job_queue.get()
            
            # Acquire semaphore slot (waits if max jobs are running)
            await concurrency_semaphore.acquire()
            print(f"🔄 Acquired slot for job: {job_id}")

            # Process in background task to not block the loop (allowing other slots to fill)
            asyncio.create_task(run_job_wrapper(job_id))
            
        except Exception as e:
            print(f"❌ Queue dispatch error: {e}")
            await asyncio.sleep(1)

async def run_job_wrapper(job_id):
    """Wrapper to run job and release semaphore"""
    try:
        job = jobs.get(job_id)
        if job:
            await run_job(job_id, job)
    except Exception as e:
         print(f"❌ Job wrapper error {job_id}: {e}")
    finally:
        # Always release semaphore and mark queue task done
        concurrency_semaphore.release()
        job_queue.task_done()
        print(f"✅ Released slot for job: {job_id}")

def _repair_clip_video_urls(job_id: str, job_dir: str, clips: list) -> bool:
    """Walk a project's clips and fix any video_url that doesn't point
    at a real file on disk. Catches the LLM-hallucinated-text bug —
    transcript fragments like 'I need a' that ended up stored as
    video_url, causing the player to 404 on every clip after the first.

    Returns True if any clip was repaired (so caller can re-save metadata).
    """
    repaired = False
    metadata_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
    if not metadata_files:
        return False
    base_name = os.path.basename(metadata_files[0]).replace("_metadata.json", "")
    for i, clip in enumerate(clips):
        if not isinstance(clip, dict):
            continue
        current = (clip.get("video_url") or "").split("?")[0]
        # Valid shape is "/videos/<job>/<filename>".
        looks_valid = (
            current.startswith(f"/videos/{job_id}/")
            and "/" in current[len(f"/videos/{job_id}/"):]  # has a filename
        )
        if looks_valid:
            # Even if the path looks valid, double-check the file exists.
            fname = current.split("/")[-1]
            if os.path.exists(os.path.join(job_dir, fname)):
                continue
        # Try the canonical filename for this clip index.
        canonical = f"{base_name}_clip_{i + 1}.mp4"
        canonical_path = os.path.join(job_dir, canonical)
        if os.path.exists(canonical_path):
            clip["video_url"] = f"/videos/{job_id}/{canonical}"
            repaired = True
            print(f"🔧 Repaired clip {i + 1} video_url for job {job_id}")
        else:
            # File genuinely missing. Set to empty so the player shows the
            # "couldn't find this file" overlay instead of trying to fetch
            # garbage text as a URL.
            if clip.get("video_url") and not looks_valid:
                clip["video_url"] = ""
                repaired = True
                print(f"🔧 Cleared bogus video_url on clip {i + 1} for job {job_id}")
    return repaired


def rehydrate_jobs_from_disk():
    """Rebuild the in-memory `jobs` dict from finished projects on disk.

    Why this exists:
      Restarting the backend (`docker compose restart backend`) wipes the
      in-memory `jobs` dictionary, but the project folders + metadata.json
      files survive on the host volume. Every endpoint that checks
      `if job_id not in jobs:` would then 404 even though the project is
      perfectly intact on disk — that was the "Job not found" bug after
      backend restarts, and also the cause of the SubtitleModal losing
      its live preview + Edit Text panel (the captions endpoint gated
      on `jobs[job_id]`).

    For each {OUTPUT_DIR}/<job_id>/ folder containing a `*_metadata.json`,
    this builds a minimal job record so all read endpoints work. Active
    queue / worker state is NOT restored — only completed projects.
    """
    if not os.path.isdir(OUTPUT_DIR):
        return 0
    restored = 0
    for entry in os.listdir(OUTPUT_DIR):
        job_dir = os.path.join(OUTPUT_DIR, entry)
        if not os.path.isdir(job_dir):
            continue
        if entry in jobs:
            continue
        # Look for both filename shapes:
        #   <basename>_metadata.json  — legacy Generate Clips
        #   metadata.json             — Smart Clipper batches
        # If only the Smart-Clipper-shape exists, also write the legacy
        # sidecar so endpoints that glob `*_metadata.json` (Auto
        # Subtitle re-gen, Dub, etc.) can find it.
        meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
        plain_meta = os.path.join(job_dir, "metadata.json")
        if not meta_files and os.path.isfile(plain_meta):
            try:
                sidecar_path = os.path.join(job_dir, f"{entry}_metadata.json")
                if not os.path.isfile(sidecar_path):
                    with open(plain_meta, "r", encoding="utf-8") as src:
                        sidecar_data = src.read()
                    with open(sidecar_path, "w", encoding="utf-8") as dst:
                        dst.write(sidecar_data)
                    print(f"📎 Wrote sidecar {entry}_metadata.json for Smart Clipper batch")
                meta_files = [sidecar_path]
            except Exception as e:
                print(f"⚠️  Could not create legacy metadata sidecar for {entry}: {e}")
                meta_files = [plain_meta]
        if not meta_files:
            continue
        try:
            with open(meta_files[0], 'r') as f:
                data = json.load(f)
        except Exception as e:
            print(f"⚠️  Skip rehydrate {entry}: {e}")
            continue
        # Build the minimal in-memory record the endpoints expect.
        clips = data.get('shorts') or []

        # Repair any clip whose video_url is hallucinated text from the
        # LLM (and persist back to disk so the fix is permanent).
        if _repair_clip_video_urls(entry, job_dir, clips):
            try:
                data['shorts'] = clips
                with open(meta_files[0], 'w') as f:
                    json.dump(data, f, indent=2)
                print(f"💾 Saved repaired metadata for {entry}")
            except Exception as e:
                print(f"⚠️  Could not save repaired metadata for {entry}: {e}")

        # CREATED_AT BACKFILL — legacy projects didn't bake their
        # creation timestamp into metadata.json. On Linux containers
        # inode ctime is unreliable (gets bumped by file rewrites,
        # volume restores, the repair pass above) so all projects
        # ended up appearing to be created at the same instant. The
        # OLDEST clip mp4's mtime is a much better proxy — clip files
        # are write-once. We compute it once here and persist into
        # the metadata so every future read sees a stable timestamp.
        if "created_at" not in data:
            inferred = None
            try:
                clip_files = glob.glob(os.path.join(job_dir, "*_clip_*.mp4"))
                if clip_files:
                    mtimes = [os.path.getmtime(p) for p in clip_files if os.path.exists(p)]
                    if mtimes:
                        inferred = min(mtimes)
                if inferred is None:
                    inferred = os.path.getctime(job_dir)
            except OSError:
                inferred = None
            if inferred and inferred > 0:
                data["created_at"] = float(inferred)
                try:
                    with open(meta_files[0], "w") as f:
                        json.dump(data, f, indent=2)
                    print(
                        f"🕒 Backfilled created_at for {entry} → "
                        f"{int(inferred)} (oldest clip mtime)"
                    )
                except Exception as e:
                    print(f"⚠️  Could not persist created_at for {entry}: {e}")

        jobs[entry] = {
            'status': 'completed',
            'logs': [f'Rehydrated from disk on startup'],
            'output_dir': job_dir,
            'created_at': data.get("created_at"),  # surface to /api/jobs/list
            'result': {
                'clips': clips,
                # Preserve top-level transcript so the subtitle endpoint
                # can read it without re-running Whisper.
                'transcript': data.get('transcript'),
            },
        }
        restored += 1
    print(f"♻️  Rehydrated {restored} job(s) from {OUTPUT_DIR}")
    return restored


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Restore on-disk projects FIRST so any incoming request immediately
    # sees the historical jobs (Past Projects, captions, status checks).
    try:
        rehydrate_jobs_from_disk()
    except Exception as e:
        print(f"⚠️  Rehydrate failed: {e}")
    try:
        rehydrate_standalone_jobs()
    except Exception as e:
        print(f"⚠️  Standalone rehydrate failed: {e}")
    # Initialize the accounts DB (users, sessions, influencer apps).
    # Idempotent — safe on every boot. If bcrypt isn't installed yet
    # this will fail with a clear log, and the rest of the app keeps
    # working (auth endpoints will return 503 until you rebuild).
    try:
        import accounts as _acc_init
        _acc_init.init_db()
    except Exception as e:
        print(f"⚠️  Accounts DB init failed: {e}")
        print("    The rest of the app will still work; auth endpoints "
              "will return 503 until you `docker compose build backend`.")
    # Then start workers.
    worker_task = asyncio.create_task(process_queue())
    cleanup_task = asyncio.create_task(cleanup_jobs())
    yield
    # Cleanup (optional: cancel worker)

app = FastAPI(lifespan=lifespan)


# Tiny health / build marker. Hit /api/health to confirm the
# running backend has the latest code. The `build` string is
# bumped manually when significant changes ship; if the value you
# see in the response doesn't match what you expect, the running
# container is stale and needs `docker compose restart backend`.
KLIPRA_BUILD_MARKER = "2026-05-01-recreate-with-roman-script-option"


@app.get("/api/health")
async def health_check():
    """Live-ness check + version marker. Lists the auth/billing/
    standalone-subtitle endpoints we expect to be present so a
    quick `curl` can confirm the deployment is in sync with the
    code in the repo."""
    expected_routes = [
        "/api/standalone/subtitle/transcribe",
        "/api/standalone/subtitle/burn",
        "/api/standalone/subtitle/sync",
        "/api/standalone/subtitle/undo-sync",
        "/api/standalone/subtitle/save",
        "/api/auth/signup",
        "/api/auth/oauth/{provider}/start",
    ]
    registered = {r.path for r in app.routes if hasattr(r, "path")}
    missing = [p for p in expected_routes if p not in registered]
    return {
        "ok": True,
        "build": KLIPRA_BUILD_MARKER,
        "routes_registered": len(registered),
        "expected_missing": missing,
    }

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for serving videos
app.mount("/videos", StaticFiles(directory=OUTPUT_DIR), name="videos")

# Mount static files for serving thumbnails
THUMBNAILS_DIR = os.path.join(OUTPUT_DIR, "thumbnails")
os.makedirs(THUMBNAILS_DIR, exist_ok=True)
app.mount("/thumbnails", StaticFiles(directory=THUMBNAILS_DIR), name="thumbnails")

# Standalone-feature in-memory job state (separate from clip-gen `jobs`).
# Same shape: status / logs / result. Reusing a separate dict keeps the
# Past Projects view and clip-gen lifecycle clean.
standalone_jobs: Dict[str, Dict] = {}

class ProcessRequest(BaseModel):
    url: str

def enqueue_output(out, job_id):
    """Reads output from a subprocess and appends it to jobs logs."""
    try:
        for line in iter(out.readline, b''):
            decoded_line = line.decode('utf-8').strip()
            if decoded_line:
                print(f"📝 [Job Output] {decoded_line}")
                if job_id in jobs:
                    jobs[job_id]['logs'].append(decoded_line)
    except Exception as e:
        print(f"Error reading output for job {job_id}: {e}")
    finally:
        out.close()

async def run_job(job_id, job_data):
    """Executes the subprocess for a specific job."""
    
    cmd = job_data['cmd']
    env = job_data['env']
    output_dir = job_data['output_dir']
    
    jobs[job_id]['status'] = 'processing'
    jobs[job_id]['logs'].append("Job started by worker.")
    print(f"🎬 [run_job] Executing command for {job_id}: {' '.join(cmd)}")
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, # Merge stderr to stdout
            env=env,
            cwd=os.getcwd()
        )
        
        # We need to capture logs in a thread because Popen isn't async
        t_log = threading.Thread(target=enqueue_output, args=(process.stdout, job_id))
        t_log.daemon = True
        t_log.start()
        
        # Async wait for process with incremental updates
        start_wait = time.time()
        while process.poll() is None:
            await asyncio.sleep(2)
            
            # Check for partial results every 2 seconds
            # Look for metadata file
            try:
                json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
                if json_files:
                    target_json = json_files[0]
                    # Read metadata (it might be being written to, so simple try/except or just read)
                    # Use a lock or just robust read? json.load might fail if file is partial.
                    # Usually main.py writes it once at start (based on my review).
                    if os.path.getsize(target_json) > 0:
                        with open(target_json, 'r') as f:
                            data = json.load(f)
                            
                        base_name = os.path.basename(target_json).replace('_metadata.json', '')
                        clips = data.get('shorts', [])
                        cost_analysis = data.get('cost_analysis')
                        
                        # CRITICAL: ALWAYS overwrite video_url with the
                        # canonical path, even before the file lands on
                        # disk. The LLM that picked clips sometimes
                        # hallucinates a `video_url` field full of
                        # transcript text — without this overwrite, that
                        # garbage stayed in the metadata for any clip
                        # whose render later failed. Players then tried
                        # to fetch URLs like `/I need a` and 404'd.
                        ready_clips = []
                        for i, clip in enumerate(clips):
                            clip_filename = f"{base_name}_clip_{i+1}.mp4"
                            clip_path = os.path.join(output_dir, clip_filename)
                            # Always set the canonical URL — never trust
                            # whatever the LLM wrote in this field.
                            clip['video_url'] = f"/videos/{job_id}/{clip_filename}"
                            if os.path.exists(clip_path) and os.path.getsize(clip_path) > 0:
                                ready_clips.append(clip)

                        if ready_clips:
                             jobs[job_id]['result'] = {'clips': ready_clips, 'cost_analysis': cost_analysis}
            except Exception as e:
                # Ignore read errors during processing
                pass

        returncode = process.returncode
        
        if returncode == 0:
            jobs[job_id]['status'] = 'completed'
            jobs[job_id]['logs'].append("Process finished successfully.")
            
            # Start S3 upload in background (silent, non-blocking)
            loop = asyncio.get_event_loop()
            loop.run_in_executor(None, upload_job_artifacts, output_dir, job_id)
            
            # Find result JSON
            json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
            if not json_files:
                # Backward-compat rescue if outputs were written to OUTPUT_DIR root
                if _relocate_root_job_artifacts(job_id, output_dir):
                    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
            if json_files:
                target_json = json_files[0] 
                with open(target_json, 'r') as f:
                    data = json.load(f)
                
                # Enhance result with video URLs
                base_name = os.path.basename(target_json).replace('_metadata.json', '')
                clips = data.get('shorts', [])
                cost_analysis = data.get('cost_analysis')

                for i, clip in enumerate(clips):
                     clip_filename = f"{base_name}_clip_{i+1}.mp4"
                     clip['video_url'] = f"/videos/{job_id}/{clip_filename}"
                
                # Bake a creation timestamp into the metadata so Past
                # Projects can sort + display the right date even after
                # backend restarts. Future-proof: this is the canonical
                # field /api/jobs/list reads first.
                if "created_at" not in data:
                    data["created_at"] = time.time()
                    try:
                        with open(target_json, 'w') as f:
                            json.dump(data, f, indent=2)
                    except Exception as e:
                        print(f"⚠️  Could not persist created_at for {job_id}: {e}")
                jobs[job_id]['created_at'] = data["created_at"]
                jobs[job_id]['result'] = {'clips': clips, 'cost_analysis': cost_analysis}
            else:
                 jobs[job_id]['status'] = 'failed'
                 jobs[job_id]['logs'].append("No metadata file generated.")
        else:
            jobs[job_id]['status'] = 'failed'
            # main.py uses distinct exit codes to flag specific failure
            # modes so the UI can show actionable guidance instead of
            # a generic "failed" message.
            if returncode == 2:
                jobs[job_id]['logs'].append(
                    "❌ DAILY Gemini quota exhausted (20 requests/day on free tier). "
                    "Resets in ~24 hours. Today: switch to a local Ollama model "
                    "(Smart Clipper, no quota) or use Gemini paid tier."
                )
                jobs[job_id]['error_kind'] = 'gemini_daily_quota'
            elif returncode == 3:
                jobs[job_id]['logs'].append(
                    "⏳ Gemini per-minute quota hit. Wait 60 seconds and click Resume — "
                    "transcript is cached so it skips straight back to the picker."
                )
                jobs[job_id]['error_kind'] = 'gemini_minute_quota'
            else:
                jobs[job_id]['logs'].append(f"Process failed with exit code {returncode}")
            
    except Exception as e:
        jobs[job_id]['status'] = 'failed'
        jobs[job_id]['logs'].append(f"Execution error: {str(e)}")

def _find_source_video(job_id: str, output_dir: str) -> str | None:
    """Locate the original (non-clip) video for a finished job. Tries:
       1. jobs[job_id]['input_path'] (in-memory fast path — set at upload).
       2. UPLOAD_DIR/.{job_id}.link sidecar (written by _save_upload_dedup
          for content-addressed uploads — survives backend restarts because
          rehydrate_jobs_from_disk doesn't repopulate input_path).
       3. UPLOAD_DIR/{job_id}_* (legacy: uploads made before dedup shipped).
       4. Any *.mp4 in output_dir whose name doesn't include 'clip' and
          isn't 'temp_' (URL-ingest jobs — yt-dlp drops the source video
          alongside the clips inside the job folder).
    """
    # 1. In-memory fast path — populated when the upload was processed
    # in this same backend lifetime. Skipped after a restart because
    # rehydrate_jobs_from_disk doesn't currently store input_path.
    rec = jobs.get(job_id) or {}
    cached = rec.get("input_path")
    if cached and os.path.isfile(cached):
        return cached
    # 2. Sidecar `.link` file written by _save_upload_dedup. With
    # content-addressed uploads the file is named `{hash16}_{name}` and
    # no longer starts with `{job_id}_`, so we keep this small pointer
    # file per job pointing at the canonical content-addressed path.
    try:
        link_path = os.path.join(UPLOAD_DIR, f".{job_id}.link")
        if os.path.isfile(link_path):
            with open(link_path) as lf:
                target = (lf.read() or "").strip()
            if target and os.path.isfile(target):
                return target
    except Exception:
        pass
    # 3. Legacy job_id-prefixed upload (pre-dedup change).
    if os.path.isdir(UPLOAD_DIR):
        for f in os.listdir(UPLOAD_DIR):
            if f.startswith(f"{job_id}_"):
                return os.path.join(UPLOAD_DIR, f)
    # 4. The yt-dlp output sits in the job folder. main.py names clips
    # `<title>_clip_<N>.mp4` and keeps the original as `<title>.mp4` (or
    # whatever yt-dlp produced).
    if os.path.isdir(output_dir):
        candidates = []
        for f in os.listdir(output_dir):
            if not f.lower().endswith((".mp4", ".webm", ".mkv", ".mov")):
                continue
            if "clip_" in f or f.startswith("temp_"):
                continue
            candidates.append(os.path.join(output_dir, f))
        # Pick the largest — that's almost certainly the full source
        if candidates:
            return max(candidates, key=lambda p: os.path.getsize(p))
    return None


class RetrimRequest(BaseModel):
    new_start: float
    new_end: float


class Keyframe(BaseModel):
    t: float          # seconds, clip-local (0 = clip start)
    x: float          # 0..1, fraction of source width (center of 9:16 crop)
    y: float = 0.5    # 0..1, fraction of source height (defaults to centered)
    cut: bool = False # if True, snap into this keyframe instead of panning


class ReframeKfRequest(BaseModel):
    keyframes: list[Keyframe]


def _find_thumbnail_for_job(job_id: str, output_dir: str, clips: list) -> Optional[str]:
    """Pick the most-likely poster video for a project card.

    Priority:
      1. The first clip's `video_url` if it points to an existing file.
      2. The conventional <base>_clip_1.mp4 derived from the metadata
         file's basename.
      3. None — caller falls back to the History icon placeholder.
    """
    if not clips:
        return None
    # 1. Use the first clip's stored video_url if the file is on disk.
    fc = clips[0] if isinstance(clips[0], dict) else {}
    fc_url = fc.get("video_url") or ""
    if fc_url:
        fname = fc_url.split("?")[0].split("/")[-1]
        if fname and os.path.exists(os.path.join(output_dir, fname)):
            return f"/videos/{job_id}/{fname}"
    # 2. Fallback: <base>_clip_1.mp4
    metadata_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if metadata_files:
        base = os.path.splitext(os.path.basename(metadata_files[0]))[0].replace("_metadata", "")
        candidate = f"{base}_clip_1.mp4"
        if os.path.exists(os.path.join(output_dir, candidate)):
            return f"/videos/{job_id}/{candidate}"
    return None


@app.get("/api/jobs/list")
async def list_all_jobs():
    """Return every job we know about — in-memory + on-disk leftovers
    from previous runs. Used by the Past Projects view."""
    seen = {}
    # 1. In-memory records (authoritative — has live status). Also
    # compute a thumbnail from disk so rehydrated jobs show their poster.
    for jid, rec in jobs.items():
        clips = (rec.get("result") or {}).get("clips") or []
        out_dir = rec.get("output_dir") or os.path.join(OUTPUT_DIR, jid)
        seen[jid] = {
            "job_id": jid,
            "status": rec.get("status", "unknown"),
            "created_at": rec.get("created_at") or _safe_ctime_for_job(out_dir),
            "source": rec.get("source"),
            "clip_count": len(clips),
            "thumbnail": _find_thumbnail_for_job(jid, out_dir, clips),
        }
    # 2. Scan output dir for jobs we haven't seen (e.g. created
    # mid-session by a parallel process — rare, but be safe).
    if os.path.isdir(OUTPUT_DIR):
        for jid in os.listdir(OUTPUT_DIR):
            jpath = os.path.join(OUTPUT_DIR, jid)
            if not os.path.isdir(jpath) or jid in seen:
                continue
            metadata_files = glob.glob(os.path.join(jpath, "*_metadata.json"))
            if not metadata_files:
                continue
            try:
                meta = json.load(open(metadata_files[0]))
                clips = meta.get("shorts", []) or []
            except Exception:
                meta = {}
                clips = []
            # Use the same three-tier fallback as the in-memory branch
            # so cards from the two paths are sortable by the same
            # timestamp scale.
            ctime = (
                (meta.get("created_at") if isinstance(meta.get("created_at"), (int, float)) else None)
                or _safe_ctime_for_job(jpath)
            )
            seen[jid] = {
                "job_id": jid,
                "status": "completed",
                "created_at": ctime,
                "source": None,
                "clip_count": len(clips),
                "thumbnail": _find_thumbnail_for_job(jid, jpath, clips),
            }
    # Sort newest first
    items = sorted(
        seen.values(),
        key=lambda r: (r.get("created_at") or 0),
        reverse=True,
    )
    return {"jobs": items, "total": len(items)}


def _safe_ctime_for_job(out_dir: str) -> Optional[float]:
    """Best-effort creation-time lookup for sorting jobs newest-first.

    Three-tier fallback, in priority order:
      1. `created_at` field INSIDE the project's metadata.json. We
         start writing this on every completed job (and backfill old
         ones on rehydrate) so going forward this is the truth.
      2. The OLDEST mtime among the project's `*_clip_*.mp4` files.
         Clip mp4s are write-once: we render them, ffmpeg gives them
         an mtime, and nothing touches them again. So the mtime of
         the FIRST-rendered clip is a reliable proxy for the project's
         actual creation moment.
      3. Directory ctime — the old behaviour, kept only as a
         last-resort fallback for the rare case where neither
         metadata.json nor any clip mp4 is readable.

    Why NOT `os.path.getctime(metadata.json)` (the previous strategy)?
    On Linux that returns INODE change time, not creation time. Every
    file rewrite (the startup rehydrator's "repair clip video_url"
    pass, a chmod, a volume restore) bumps ctime to "now" for all
    jobs simultaneously — which is exactly the "all dates identical"
    bug the user saw.
    """
    # 1. Trust metadata's own created_at if present.
    try:
        metas = glob.glob(os.path.join(out_dir, "*_metadata.json"))
        if metas:
            with open(metas[0], "r") as f:
                data = json.load(f)
            ts = data.get("created_at")
            if isinstance(ts, (int, float)) and ts > 0:
                return float(ts)
    except Exception:
        pass
    # 2. Oldest clip-mp4 mtime — write-once files, very stable.
    try:
        clip_files = glob.glob(os.path.join(out_dir, "*_clip_*.mp4"))
        if clip_files:
            mtimes = []
            for p in clip_files:
                try:
                    mtimes.append(os.path.getmtime(p))
                except OSError:
                    continue
            if mtimes:
                return min(mtimes)
    except Exception:
        pass
    # 3. Fall back to directory ctime — better than nothing.
    try:
        if os.path.isdir(out_dir):
            return os.path.getctime(out_dir)
    except OSError:
        pass
    return None


@app.get("/api/job/{job_id}/source-video")
async def serve_source_video(job_id: str):
    """Stream the original (pre-clip) video so the keyframed-reframe
    modal can show it as a click-target. Fails 404 if the source has
    been cleaned up."""
    record = jobs.get(job_id)
    output_dir = (record or {}).get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    src = _find_source_video(job_id, output_dir)
    if not src or not os.path.isfile(src):
        raise HTTPException(404, "Source video not on disk")
    from fastapi.responses import FileResponse
    return FileResponse(src, media_type="video/mp4")


@app.get("/api/job/{job_id}/waveform")
async def serve_source_waveform(job_id: str, bins: int = 800):
    """Return a coarse audio amplitude envelope for the clip-gen source
    video so the RetrimModal can draw a real waveform on its timeline.

    Mirrors /api/h2v/{job_id}/waveform but reads from the clip-gen
    output_dir instead of the H2V job dir. Cached after first compute
    because ffmpeg-decoding a long-form video on every modal open
    would be wasteful.
    """
    record = jobs.get(job_id)
    output_dir = (record or {}).get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    src = _find_source_video(job_id, output_dir)
    if not src or not os.path.isfile(src):
        raise HTTPException(410, "Source video missing.")

    bins = max(50, min(4000, int(bins)))
    cache_path = os.path.join(output_dir, f"_waveform_{bins}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path) as f:
                return json.load(f)
        except Exception:
            pass

    try:
        # Same approach as the H2V version: decode to mono 8 kHz s16le
        # via ffmpeg and bucket peak amplitude per bin. Cheap + accurate
        # enough for a UI envelope.
        proc = subprocess.run(
            ["ffmpeg", "-i", src, "-ac", "1", "-ar", "8000",
             "-f", "s16le", "-loglevel", "error", "-"],
            capture_output=True, timeout=180,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace")[:200])
        import struct
        raw = proc.stdout
        n_samples = len(raw) // 2
        if n_samples <= 0:
            data = [0.0] * bins
        else:
            samples_per_bin = max(1, n_samples // bins)
            data = []
            i = 0
            for _ in range(bins):
                end = min(n_samples, i + samples_per_bin)
                if i >= end:
                    data.append(0.0)
                    continue
                chunk = raw[i*2:end*2]
                if not chunk:
                    data.append(0.0)
                else:
                    vals = struct.unpack(f"<{len(chunk)//2}h", chunk)
                    peak = max(abs(v) for v in vals) / 32768.0
                    data.append(round(peak, 4))
                i = end
        payload = {"bins": bins, "data": data}
        try:
            with open(cache_path, "w") as f:
                json.dump(payload, f)
        except Exception:
            pass  # cache write is best-effort
        return payload
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "ffmpeg timed out reading the source audio.")
    except Exception as e:
        raise HTTPException(500, f"Failed to compute waveform: {e}")


@app.post("/api/clip/{job_id}/{clip_index}/reframe-keyframes")
async def reframe_keyframes(job_id: str, clip_index: int, req: ReframeKfRequest):
    """Re-render one clip with a keyframed pan. The keyframes' time axis
    is clip-local (0 = clip start). Backend converts to absolute source
    time via the clip's known start/end."""
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(404, "Job not found")
    if record.get("status") != "completed":
        raise HTTPException(409, "Job is not complete")
    clips = (record.get("result") or {}).get("clips") or []
    if not (0 <= clip_index < len(clips)):
        raise HTTPException(404, "Clip index out of range")
    if not req.keyframes:
        raise HTTPException(400, "At least one keyframe required")

    clip = clips[clip_index]
    output_dir = record.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    source = _find_source_video(job_id, output_dir)
    if not source:
        raise HTTPException(410, "Source video unavailable — re-run the job to enable reframing.")

    clip_start = float(clip.get("start", 0))
    clip_end = float(clip.get("end", 0))
    if clip_end <= clip_start:
        raise HTTPException(500, "Clip start/end metadata is corrupt.")

    # Clamp keyframes to the clip's duration. Sort by time. Clip-local t.
    duration = clip_end - clip_start
    sorted_kfs = sorted(req.keyframes, key=lambda k: k.t)
    sanitized = [
        {
            "t": max(0.0, min(duration, kf.t)),
            "x": max(0.0, min(1.0, kf.x)),
            "y": max(0.0, min(1.0, kf.y)),
            "cut": bool(kf.cut),
        }
        for kf in sorted_kfs
    ]

    clip_filename = clip.get("video_url", "").split("?")[0].split("/")[-1]
    if not clip_filename:
        raise HTTPException(500, "Clip has no video_url")
    clip_path = os.path.join(output_dir, clip_filename)

    # Write keyframes JSON to a temp file the subprocess reads.
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as tmp:
        json.dump(sanitized, tmp)
        kf_path = tmp.name

    try:
        import asyncio
        proc = await asyncio.create_subprocess_exec(
            "python", "-u", "reframe_kf.py",
            "--source", source,
            "--start", f"{clip_start:.3f}",
            "--end", f"{clip_end:.3f}",
            "--keyframes", kf_path,
            "--output", clip_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            msg = (stderr or b"").decode("utf-8", errors="replace")[-1000:]
            raise HTTPException(500, f"Reframe failed: {msg}")

        # Persist via the central helper — pushes prev URL onto history,
        # writes metadata.json, mirrors to in-memory job, mints cache-bust.
        _apply_clip_change(
            job_id, clip_index, clip_filename,
            operation='reframe',
            extra={
                'keyframes': sanitized,
                # Clear the "reframe needs re-running" flag if a previous
                # retrim set it — the user just re-set their keyframes.
                'reframe_invalidated_at': None,
            },
        )
        # Return current state from in-memory job.
        cur = (record.get('result') or {}).get('clips') or []
        return cur[clip_index] if 0 <= clip_index < len(cur) else clip
    finally:
        try:
            os.unlink(kf_path)
        except OSError:
            pass


@app.post("/api/clip/{job_id}/{clip_index}/retrim")
async def retrim_clip(job_id: str, clip_index: int, req: RetrimRequest):
    """Re-cut + re-reframe one clip with new start/end. The original source
    video must still be on disk (i.e. the job hasn't been deleted)."""
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(404, "Job not found")
    if record.get("status") != "completed":
        raise HTTPException(409, "Job is not yet complete")
    clips = (record.get("result") or {}).get("clips") or []
    if not (0 <= clip_index < len(clips)):
        raise HTTPException(404, "Clip index out of range")

    clip = clips[clip_index]
    output_dir = record.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    if req.new_start < 0 or req.new_end <= req.new_start + 1.0:
        raise HTTPException(400, "Clip duration must be at least 1 second")

    source = _find_source_video(job_id, output_dir)
    if not source:
        raise HTTPException(
            410,
            "Source video has been cleaned up. Re-run the job to enable editing.",
        )

    # The clip file is referenced by its existing video_url.
    # Format: /videos/{job_id}/{filename}
    clip_filename = _clip_filename_from_url(clip.get("video_url", ""))
    if not clip_filename:
        raise HTTPException(500, "Clip has no video_url")
    clip_path = os.path.join(output_dir, clip_filename)

    # Spawn retrim.py — runs the cut + vertical pipeline in a subprocess
    # so torch/MediaPipe load only on demand.
    import asyncio
    proc = await asyncio.create_subprocess_exec(
        "python", "-u", "retrim.py",
        "--source", source,
        "--start", f"{req.new_start:.3f}",
        "--end", f"{req.new_end:.3f}",
        "--output", clip_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = (stderr or b"").decode("utf-8", errors="replace")[-1000:]
        raise HTTPException(500, f"Retrim failed: {msg}")

    # If the user had already keyframed a custom reframe on this clip,
    # the new timing invalidates those keyframe times. Drop the old
    # keyframes and flag invalidation — the frontend shows a banner
    # offering to re-set them.
    had_keyframes = bool(clip.get("keyframes"))
    extra = {
        "start": req.new_start,
        "end": req.new_end,
    }
    if had_keyframes:
        extra["keyframes"] = []
        extra["reframe_invalidated_at"] = int(time.time() * 1000)
    # Subtitles also become stale on retrim: the cached transcript's
    # segment times still refer to the OLD clip range, and any saved
    # `regenerated_transcript` was tuned to the previous cut. Without
    # this flag the frontend would happily call /api/subtitle and burn
    # captions that no longer line up with the audio. The SubtitleModal
    # reads `subtitles_invalidated_at` and shows a regenerate banner,
    # forcing a fresh Whisper pass before the next burn. Also clear
    # the per-clip regenerated_transcript so the subtitle endpoint's
    # "use saved regen" fast path doesn't accidentally re-use a stale
    # cleaned transcript.
    extra["subtitles_invalidated_at"] = int(time.time() * 1000)
    extra["regenerated_transcript"] = None

    new_url = _apply_clip_change(
        job_id, clip_index, clip_filename,
        operation='retrim', extra=extra,
    )
    # Refresh the in-memory clip dict to return current state to the
    # frontend.
    refreshed = (record.get("result") or {}).get("clips") or []
    return refreshed[clip_index] if 0 <= clip_index < len(refreshed) else clip


@app.post("/api/clip/{job_id}/{clip_index}/undo")
async def undo_clip_change(job_id: str, clip_index: int):
    """Pop the most recent entry from the per-clip undo stack.

    Every mutating endpoint (auto-edit, hook, subtitle, dub, reframe,
    retrim) pushes the previous video_url onto `clip['history']` via
    `_apply_clip_change`. This endpoint reverses one step: pops the top
    of the stack, restores it as the current video_url, and persists.

    Returns the restored clip dict, or 409 if there's nothing to undo.
    The actual rendered file from the OLDER state is still on disk
    (we never delete output files mid-session), so this is just a
    metadata flip — instant.
    """
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(404, "Job not found")
    clips_mem = (record.get('result') or {}).get('clips') or []
    if not (0 <= clip_index < len(clips_mem)):
        raise HTTPException(404, "Clip index out of range")

    clip_mem = clips_mem[clip_index]
    history = clip_mem.get('history') or []
    if not history:
        raise HTTPException(409, "Nothing to undo on this clip")

    last = history.pop()
    prev_url = last.get('video_url') or ''
    if not prev_url:
        raise HTTPException(500, "Corrupt history entry")

    # Re-apply cache-bust on undo too — the browser <video> needs to
    # know the URL "changed" to trigger a reload, even though it's
    # really an OLD file we're pointing back at.
    cache_bust = int(time.time() * 1000)
    bare = prev_url.split('?')[0]
    restored_url = f"{bare}?v={cache_bust}"

    clip_mem['video_url'] = restored_url
    clip_mem['history'] = history

    # Persist to metadata.json on disk.
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if json_files:
        try:
            with open(json_files[0], 'r') as f:
                data = json.load(f)
            shorts = data.get('shorts', [])
            if 0 <= clip_index < len(shorts):
                shorts[clip_index]['video_url'] = restored_url
                shorts[clip_index]['history'] = history
                data['shorts'] = shorts
                with open(json_files[0], 'w') as f:
                    json.dump(data, f, indent=2)
        except Exception as e:
            print(f"⚠️  Undo: failed to persist metadata: {e}")

    return {
        'undone_operation': last.get('operation', 'unknown'),
        'video_url': restored_url,
        'remaining_history': len(history),
    }


@app.delete("/api/job/{job_id}")
async def delete_job(job_id: str):
    """Wipe a job's output directory and forget its metadata.
    Refuses while the job is actively running so we don't kill a worker
    mid-render."""
    import shutil
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if record.get("status") in ("processing", "queued"):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a job that's still running.",
        )
    job_dir = record.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    freed = 0
    if os.path.isdir(job_dir):
        for root, _, files in os.walk(job_dir):
            for f in files:
                try:
                    freed += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        shutil.rmtree(job_dir, ignore_errors=True)
    jobs.pop(job_id, None)
    return {"ok": True, "freed_bytes": freed,
            "freed_mb": round(freed / (1024 * 1024), 2)}


@app.post("/api/jobs/purge-finished")
async def purge_finished():
    """Delete every completed/failed job in one call."""
    import shutil
    deleted, freed = 0, 0
    for jid in list(jobs.keys()):
        rec = jobs.get(jid) or {}
        if rec.get("status") in ("processing", "queued"):
            continue
        d = rec.get("output_dir") or os.path.join(OUTPUT_DIR, jid)
        if os.path.isdir(d):
            for root, _, files in os.walk(d):
                for f in files:
                    try:
                        freed += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            shutil.rmtree(d, ignore_errors=True)
        jobs.pop(jid, None)
        deleted += 1
    return {"ok": True, "jobs_deleted": deleted,
            "bytes_freed_mb": round(freed / (1024 * 1024), 2)}


# Cache for live Ollama model list. Querying every page-load is cheap
# but we still don't need to hit the local Ollama daemon repeatedly when
# users navigate around the dashboard. Short TTL so freshly-pulled
# models (`ollama pull qwen2.5:14b`) appear in the picker quickly.
_OLLAMA_TAGS_CACHE: dict = {"models": None, "ts": 0.0}
_OLLAMA_TAGS_TTL = 5.0


def _fetch_live_ollama_models(
    base_url: str = "http://host.docker.internal:11434",
    *,
    force_refresh: bool = False,
) -> list[str]:
    """Query the local Ollama daemon for the list of installed models.

    Why this exists: the static PROVIDER_INFO list in llm/factory.py
    only has a handful of common models. Users often `ollama pull
    qwen3:32b` (or whatever variant they need) and expect it to show
    up in the picker. Without this dynamic query they'd have to ask us
    to add their model to the static list — bad UX.

    Returns model names like ["qwen3:32b", "llama3.3:latest", ...].
    On any failure (Ollama down, wrong base URL, network error)
    returns [] so the caller can fall back to the static list.

    `force_refresh=True` bypasses the cache so a user who just ran
    `ollama pull X` sees the new model immediately without waiting
    for the TTL.
    """
    import time, httpx
    now = time.time()
    cached = _OLLAMA_TAGS_CACHE
    if (not force_refresh and cached["models"] is not None
            and (now - cached["ts"]) < _OLLAMA_TAGS_TTL):
        return cached["models"]
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=2.0)
        r.raise_for_status()
        models = [
            m.get("name") for m in (r.json().get("models") or [])
            if m.get("name")
        ]
        cached["models"] = models
        cached["ts"] = now
        return models
    except Exception:
        return []


@app.get("/api/providers")
async def list_providers(refresh: bool = False):
    """Catalog of supported LLM providers for the Settings page.

    For Ollama specifically, we replace the static model list with the
    LIVE list from the local Ollama daemon — that way any `ollama pull
    <model>` is immediately visible in the picker, and models the user
    DOESN'T have installed never get shown (they'd 404 on use).

    `?refresh=1` bypasses the 5s cache for a fresh probe — used by the
    MotionGraphicsModal picker's refresh button so freshly-pulled models
    appear instantly without page reload.
    """
    from llm import PROVIDER_INFO
    # Fetch Ollama models once for this request.
    live_ollama = _fetch_live_ollama_models(force_refresh=refresh)
    out = []
    for p in PROVIDER_INFO:
        models = list(p.models)
        if p.id == "ollama":
            # If we got a live list, that's the source of truth —
            # showing static "suggested" models the user doesn't have
            # installed leads to 404s on use. If the live probe failed
            # (Ollama daemon down), fall back to the static list so
            # users at least see SOMETHING they can troubleshoot.
            if live_ollama:
                models = live_ollama
            # else: keep the static list as a fallback
        out.append({
            "id": p.id, "name": p.name, "requires_key": p.requires_key,
            "models": models, "notes": p.notes,
        })
    return out


@app.post("/api/providers/test")
async def test_provider(request: Request):
    """Round-trip a 'say OK' prompt to verify provider + key + model."""
    from llm import build_provider, LLMError
    body = await request.json()
    provider_id = (body.get("provider") or "").lower()
    model_id = body.get("model") or ""

    # For Ollama specifically, do a pre-flight: check that the
    # requested model is actually installed locally. Without this
    # the test fails with a confusing "404 on /api/chat" message
    # that makes it look like Ollama is broken when really the user
    # just hasn't pulled that model yet.
    if provider_id == "ollama" and model_id:
        try:
            installed = _fetch_live_ollama_models()
            if installed and model_id not in installed:
                raise HTTPException(
                    400,
                    f'Ollama model "{model_id}" is not installed on this machine. '
                    f'Installed models: {", ".join(installed) or "(none)"}. '
                    f'Run `ollama pull {model_id}` on the host to install it, '
                    f'or pick one of the installed models from the dropdown.',
                )
        except HTTPException:
            raise
        except Exception:
            # If the pre-flight itself errors, fall through to the
            # real test call — better to show the underlying error
            # than to mask it with a hint that may be wrong.
            pass

    try:
        prov = build_provider(
            provider_id,
            model_id,
            body.get("api_key", ""),
            base_url=body.get("base_url"),
        )
        text = prov.complete_text(
            "You are a tester. Reply with just the word OK.",
            "Say OK.",
            max_tokens=16,
        )
        return {"ok": True, "response": text[:200]}
    except LLMError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))


# ====================================================================
# SMART CLIPPER (multimodal viral-moment picker)
# ====================================================================
# Three endpoints, isolated from the legacy clip generator:
#   GET  /api/multimodal-clip/models        — registry + installed status
#   POST /api/multimodal-clip/pull-model    — Ollama pull with SSE progress
#   POST /api/multimodal-clip/analyze       — run the picker on a video
#
# All wired into a brand-new dashboard tab. Existing /api/process flow is
# untouched.

@app.get("/api/multimodal-clip/models")
async def multimodal_clip_models():
    """List every multimodal model the Smart Clipper supports, with
    installed/not-installed status for the local ones. Frontend uses
    this to render the model picker grid + download buttons."""
    from multimodal_picker import (
        MODEL_REGISTRY,
        list_installed_ollama_models,
    )
    ollama_base = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
    installed_tags = set(list_installed_ollama_models(ollama_base))

    out = []
    for m in MODEL_REGISTRY:
        entry = dict(m)  # shallow copy so we can decorate without mutating registry
        if m.get("provider") == "ollama":
            tag = m.get("ollama_tag", "")
            # Ollama tags can be returned with or without ":latest" suffix —
            # match both forms.
            entry["installed"] = (
                tag in installed_tags
                or f"{tag}:latest" in installed_tags
                or any(t.split(":", 1)[0] == tag.split(":", 1)[0] for t in installed_tags)
            )
        else:
            entry["installed"] = True  # cloud providers don't need install
        out.append(entry)
    return {
        "models": out,
        "ollama_reachable": bool(installed_tags) or _ollama_ping(ollama_base),
    }


def _ollama_ping(base_url: str) -> bool:
    """Cheap reachability probe — separate from list_installed_ollama_models
    because we want to know 'is the daemon up' even when zero models are
    pulled."""
    try:
        import requests
        r = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=1.0)
        return r.status_code == 200
    except Exception:
        return False


class MultimodalPullModelRequest(BaseModel):
    ollama_tag: str  # e.g. "llama3.2-vision:11b"


@app.post("/api/multimodal-clip/pull-model")
async def multimodal_clip_pull_model(req: MultimodalPullModelRequest):
    """Trigger an Ollama pull for a multimodal model and stream the
    progress back as Server-Sent Events. Each event has the same shape
    Ollama emits natively, so the frontend can render exact byte-by-byte
    progress bars for each layer being downloaded.
    """
    from fastapi.responses import StreamingResponse
    from multimodal_picker import pull_ollama_model_streaming

    ollama_base = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
    tag = (req.ollama_tag or "").strip()
    if not tag:
        raise HTTPException(400, "Missing ollama_tag")
    # Whitelist against our registry so the endpoint can't be abused to
    # pull arbitrary tags (which would still be mostly harmless, but we
    # keep this hardened by default).
    from multimodal_picker import MODEL_REGISTRY
    allowed_tags = {m.get("ollama_tag") for m in MODEL_REGISTRY if m.get("ollama_tag")}
    if tag not in allowed_tags:
        raise HTTPException(400, f"Tag '{tag}' is not in the supported model list.")

    def event_stream():
        try:
            for evt in pull_ollama_model_streaming(tag, base_url=ollama_base):
                yield f"data: {json.dumps(evt)}\n\n"
            yield "data: " + json.dumps({"status": "complete"}) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"status": "error", "error": str(e)}) + "\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class MultimodalAnalyzeRequest(BaseModel):
    job_id: Optional[str] = None       # reuse an already-uploaded source
    local_path: Optional[str] = None   # OR run on a host file (local-mode)
    model_id: str                      # one of multimodal_picker.MODEL_REGISTRY ids
    target_clips: int = 6
    min_duration: float = 20.0
    max_duration: float = 60.0
    frame_stride: float = 4.0
    max_frames: int = 200
    # Smart Clipper Pro: when true, we run the staged 5-pass pipeline
    # (transcribe → translate → per-frame visual analysis → text
    # reasoning + window scoring → greedy non-overlapping selection)
    # instead of the single-call multimodal picker. Pro is much smarter
    # — but ~3× slower, since it makes multiple LLM calls.
    pro_mode: bool = False
    # Per-signal scoring rubric. 'signals' (default) makes the LLM
    # score each clip against six named signals individually
    # (punchline, reversal, awkward_pause, one_liner, audio_peak,
    # visual_energy) and surfaces the per-signal scores in the
    # response. 'classic' keeps the legacy single hook + why_viral
    # shape so the frontend can A/B compare picker quality without
    # restarting the backend.
    scoring_rubric: Optional[str] = "signals"


@app.post("/api/multimodal-clip/analyze")
async def multimodal_clip_analyze(
    req: MultimodalAnalyzeRequest,
    request: Request,
):
    """Run the multimodal picker on a video and return ranked clip
    candidates. The caller already has a job (from a normal upload) OR
    a local_path (when LOCAL_MODE is enabled). Cloud providers read
    their API key from the same headers Klipra uses everywhere else.
    """
    from multimodal_picker import (
        find_viral_moments_multimodal,
        get_model_by_id,
    )

    # Resolve the source video path.
    video_path: Optional[str] = None
    if req.job_id:
        rec = jobs.get(req.job_id) or {}
        video_path = rec.get("input_path")
        if not video_path or not os.path.exists(video_path):
            # Re-resolve from disk via the same helper retrim/reframe use.
            try:
                video_path = _find_source_video(req.job_id)
            except Exception:
                video_path = None
    elif req.local_path:
        video_path = _resolve_local_media_path(req.local_path)
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(404, "Video file not found for the supplied job_id / local_path.")

    # Resolve the model.
    model = get_model_by_id(req.model_id)
    if not model:
        raise HTTPException(400, f"Unknown model_id: {req.model_id}")

    # Pull the API key from the standard X-LLM-Key header, falling back
    # to per-provider env so an operator can configure server-side
    # defaults if they want.
    api_key = ""
    base_url = ""
    provider = model.get("provider")
    if provider == "gemini":
        api_key = (
            request.headers.get("X-Gemini-Key")
            or request.headers.get("X-LLM-Key")
            or os.environ.get("GEMINI_API_KEY", "")
        )
    elif provider == "openai":
        api_key = (
            request.headers.get("X-OpenAI-Key")
            or request.headers.get("X-LLM-Key")
            or os.environ.get("OPENAI_API_KEY", "")
        )
        base_url = request.headers.get("X-LLM-Base-URL") or ""
    elif provider == "anthropic":
        api_key = (
            request.headers.get("X-Anthropic-Key")
            or request.headers.get("X-LLM-Key")
            or os.environ.get("ANTHROPIC_API_KEY", "")
        )
    elif provider == "ollama":
        base_url = (
            request.headers.get("X-LLM-Base-URL")
            or os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
        )

    # We need a transcript for the picker. Re-use Klipra's existing one
    # if the job already has it cached; otherwise transcribe on the fly.
    transcript: Dict[str, Any] = {}
    if req.job_id:
        rec = jobs.get(req.job_id) or {}
        cached = rec.get("transcript")
        if cached and cached.get("segments"):
            transcript = cached
    if not transcript:
        # Fresh transcribe — uses the sidecar/CPU path automatically.
        from main import transcribe_video
        loop = asyncio.get_event_loop()
        transcript = await loop.run_in_executor(None, transcribe_video, video_path)
        if not transcript or not transcript.get("segments"):
            raise HTTPException(500, "Transcription returned no segments.")
        if req.job_id:
            jobs[req.job_id]["transcript"] = transcript

    # Run the picker (blocking — wrap in executor so we don't block the
    # event loop on a multi-minute Ollama call). Smart Clipper Pro
    # branches into the staged pipeline; the default path runs the
    # original single-call picker.
    loop = asyncio.get_event_loop()
    try:
        if req.pro_mode:
            from smart_clipper_pro import run_pro_pipeline
            result = await loop.run_in_executor(
                None,
                lambda: run_pro_pipeline(
                    video_path,
                    transcript,
                    model_id=req.model_id,
                    api_key=api_key,
                    base_url=base_url,
                    target_clips=int(req.target_clips),
                    min_duration=float(req.min_duration),
                    max_duration=float(req.max_duration),
                ),
            )
        else:
            result = await loop.run_in_executor(
                None,
                lambda: find_viral_moments_multimodal(
                    video_path,
                    transcript,
                    model_id=req.model_id,
                    api_key=api_key,
                    base_url=base_url,
                    target_clips=int(req.target_clips),
                    min_duration=float(req.min_duration),
                    max_duration=float(req.max_duration),
                    frame_stride=float(req.frame_stride),
                    max_frames=int(req.max_frames),
                    scoring_rubric=(req.scoring_rubric or "signals"),
                ),
            )
    except Exception as e:
        raise HTTPException(500, f"Multimodal picker failed: {e}")

    # ─── Per-clip hook regeneration ──────────────────────────────────
    # Both pickers occasionally return identical hooks for every clip
    # (Llama 3.2 Vision is the worst offender — it once gave us 6 clips
    # all titled "Run hundreds of AI agents in one unified token hub").
    # The fix: for each picked moment, look at the transcript text
    # actually inside [start, end] and ask the LLM to write a unique
    # hook from that content. Generic / duplicated picker hooks get
    # overwritten; good ones pass through unchanged.
    try:
        from clip_hook_writer import ensure_unique_hooks
        # Always force on Pro mode — the staged pipeline's stage-4 hooks
        # are scored at WINDOW level (before snapping) so they often
        # don't match the final clip boundaries. On Fast we only
        # regen when the heuristic detects bad output.
        ensure_unique_hooks(
            result.clips,
            transcript.get("segments") or [],
            provider_id=provider or "gemini",
            model_name=req.model_id.split("/", 1)[1] if "/" in req.model_id else req.model_id,
            api_key=api_key,
            base_url=base_url or None,
            force=bool(req.pro_mode),
        )
    except Exception as hook_e:
        print(f"⚠️  ensure_unique_hooks failed; keeping picker hooks: {hook_e}")

    response_payload = {
        "ok": True,
        "model_used": result.model_used,
        "provider_used": result.provider_used,
        "elapsed_seconds": result.elapsed_seconds,
        "frames_examined": result.frames_examined,
        "clips": result.clips,
        "pro_mode": bool(req.pro_mode),
        # Echo back which rubric ran so the frontend can render the
        # right "Why?" panel without having to guess from clip shape.
        "scoring_rubric": (req.scoring_rubric or "signals"),
    }
    # When 0 clips came out of the picker, ALSO return a truncated
    # excerpt of the raw model response so the frontend can show the
    # user "this is what the model actually said" instead of a
    # generic "no moments returned" message. Cap to 3KB so we don't
    # blow up the JSON payload.
    if not result.clips:
        excerpt = (result.raw_response or "")[:3000]
        response_payload["raw_response_excerpt"] = excerpt
        response_payload["raw_response_length"] = len(result.raw_response or "")
    return response_payload


# ====================================================================
# SMART CLIPPER — saved projects
# ====================================================================
# Persists analyses to OUTPUT_DIR/.smart_clipper/<id>.json so the user
# can re-open them later. Keeps Smart Clipper isolated from the legacy
# clip-gen / standalone job systems — these projects don't show up in
# Past Projects on the other tabs.

def _smart_clipper_dir() -> str:
    d = os.path.join(OUTPUT_DIR, ".smart_clipper")
    os.makedirs(d, exist_ok=True)
    return d


class SmartCutRequest(BaseModel):
    source_path: str                      # in-container path
    picks: List[Dict[str, Any]]           # [{start, end, hook, why_viral, ...}]
    reframe_to_vertical: bool = True      # True = center-crop to 9:16
    batch_id: Optional[str] = None        # reuse an existing batch dir


@app.post("/api/multimodal-clip/cut")
async def smart_clipper_cut(req: SmartCutRequest):
    """Slice Smart Clipper picks into individual mp4 clips AND register
    the result as a regular Klipra job so the existing ResultCard
    component (with all its Subtitle / Dub / Edit / Reframe / Post
    actions) can render each clip with full feature parity to Generate
    Clips. The batch is stored at OUTPUT_DIR/<batch_id>/ — same layout
    /api/process produces — and the jobs dict is populated so the
    /api/status/{job} + /api/clip/{job}/... endpoints work as-is.
    """
    if not req.source_path or not os.path.isfile(req.source_path):
        raise HTTPException(404, f"Source video not found: {req.source_path}")
    if not req.picks:
        return {"batch_id": "", "job_id": "", "clips": []}

    batch_id = req.batch_id or uuid.uuid4().hex[:10]
    job_dir = os.path.join(OUTPUT_DIR, batch_id)
    os.makedirs(job_dir, exist_ok=True)

    # Probe source dimensions once so we know whether to reframe.
    try:
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0",
                req.source_path,
            ],
            capture_output=True, text=True, check=True, timeout=30,
        )
        vw_str, vh_str = probe.stdout.strip().split(",")
        src_w, src_h = int(vw_str), int(vh_str)
    except Exception:
        src_w, src_h = 0, 0

    do_reframe = bool(req.reframe_to_vertical and src_w and src_h and src_w >= src_h)
    if do_reframe:
        target_w = int(src_h * 9 / 16)
        # Static center-crop fallback. The per-clip face-tracked filter
        # below is preferred — we only land here if face detection
        # turns up empty for a particular clip.
        center_crop_filter = f"crop={target_w}:{src_h}:(in_w-{target_w})/2:0,scale=720:1280"
    else:
        center_crop_filter = "scale='if(gt(iw,ih),720,-2)':'if(gt(iw,ih),-2,1280)'"

    # Face-tracking import — if mediapipe isn't installed or fails to
    # load we silently fall back to center-crop. Better degraded than
    # a 500.
    try:
        from face_track import build_face_track_filter
    except Exception:
        build_face_track_filter = None  # type: ignore

    shorts: List[Dict[str, Any]] = []
    for i, pick in enumerate(req.picks):
        try:
            start = float(pick.get("start", 0))
            end = float(pick.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        duration = end - start
        clip_filename = f"clip_{i:02d}.mp4"
        thumb_filename = f"thumb_{i:02d}.jpg"
        clip_path = os.path.join(job_dir, clip_filename)
        thumb_path = os.path.join(job_dir, thumb_filename)

        # Choose the crop filter for THIS clip. When we're reframing
        # horizontal → vertical, run face-tracking across the [start,
        # end] range so the crop window follows the speaker. If
        # face-tracking is unavailable or returns nothing (no faces
        # detected) we fall back to the static center-crop above.
        crop_filter = center_crop_filter
        if do_reframe and build_face_track_filter is not None:
            try:
                tracked = build_face_track_filter(
                    source_path=req.source_path,
                    start=start,
                    end=end,
                    target_aspect=9 / 16,
                    target_w=720,
                    target_h=1280,
                )
                if tracked:
                    crop_filter = tracked
                    print(
                        f"🎯 Smart Clipper: pick {i} using face-tracked crop "
                        f"({start:.1f}s → {end:.1f}s)"
                    )
            except Exception as ft_e:
                print(f"⚠️  Face-track for pick {i} failed; using center-crop: {ft_e}")

        # 1) Cut + reframe the mp4. We try the chosen crop_filter first;
        #    if ffmpeg rejects it (e.g. a flaky face-track expression on
        #    a clip with very few visible faces), we automatically retry
        #    with the static center-crop so the batch never ends up
        #    empty just because face-tracking misbehaved on one clip.
        def _run_cut(filter_str: str) -> "subprocess.CompletedProcess[str]":
            return subprocess.run(
                [
                    "ffmpeg", "-loglevel", "error",
                    "-ss", f"{start:.3f}",
                    "-i", req.source_path,
                    "-t", f"{duration:.3f}",
                    "-vf", filter_str,
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "23",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-movflags", "+faststart",
                    "-y",
                    clip_path,
                ],
                capture_output=True, text=True, timeout=300,
            )

        proc = _run_cut(crop_filter)
        if proc.returncode != 0 or not os.path.isfile(clip_path):
            # First attempt failed — log loudly with the actual ffmpeg
            # stderr so the diagnosis isn't a guessing game, then try
            # the static center-crop as a fallback before giving up.
            print(
                f"⚠️  Smart Clipper cut for pick {i} failed with "
                f"primary filter ({'face-tracked' if crop_filter != center_crop_filter else 'center-crop'}). "
                f"ffmpeg stderr: {proc.stderr[-500:]}"
            )
            if crop_filter != center_crop_filter:
                print(f"   ↪ retrying pick {i} with static center-crop…")
                proc = _run_cut(center_crop_filter)
            if proc.returncode != 0 or not os.path.isfile(clip_path):
                print(
                    f"⚠️  Smart Clipper cut for pick {i} STILL failed "
                    f"after fallback. Giving up on this clip. "
                    f"stderr: {proc.stderr[-500:]}"
                )
                continue
        # 2) Thumbnail — single frame ~1 sec into the clip so we get
        #    something more representative than a black opening frame.
        thumb_offset = min(1.0, duration / 2)
        thumb_cmd = [
            "ffmpeg", "-loglevel", "error",
            "-ss", f"{thumb_offset:.3f}",
            "-i", clip_path,
            "-frames:v", "1",
            "-q:v", "5",
            "-vf", "scale=480:-2",
            "-y",
            thumb_path,
        ]
        subprocess.run(thumb_cmd, capture_output=True, text=True, timeout=30)
        hook = (pick.get("hook") or f"Clip {i + 1}").strip()
        why = (pick.get("why_viral") or "").strip()
        # Map Smart Clipper picks → ResultCard's expected `shorts` shape
        # so the existing Subtitle / Dub / Edit / Post buttons just work.
        shorts.append({
            "video_url": f"/videos/{batch_id}/{clip_filename}",
            "thumbnail_url": f"/videos/{batch_id}/{thumb_filename}",
            "start": round(start, 2),
            "end": round(end, 2),
            "viral_hook_text": hook[:120],
            "video_title_for_youtube_short": hook[:100],
            "video_description_for_tiktok": why[:280] or hook[:280],
            "video_description_for_instagram": why[:280] or hook[:280],
            "caption_title": hook[:80],
            # Keep the rationale around as a non-standard field so we
            # can show it on the card later if we add a "Why?" button.
            "smart_clipper_why_viral": why,
        })

    # 3) Write metadata.json in the standard clip-gen shape so any
    #    code path that reads it (retrim, reframe, etc.) finds the
    #    right structure.
    metadata = {
        "shorts": shorts,
        "smart_clipper": {
            "source_path": req.source_path,
            "reframe_to_vertical": do_reframe,
            "src_width": src_w,
            "src_height": src_h,
        },
    }
    metadata_path = os.path.join(job_dir, "metadata.json")
    # ALSO write a sidecar with the legacy "<job>_metadata.json" name so
    # endpoints that glob for `*_metadata.json` (Auto Subtitle re-gen,
    # Dub, change-background, etc.) find Smart Clipper batches the
    # same way they find Generate Clips batches. Without this, those
    # endpoints respond with `{"detail": "Metadata not found"}` because
    # the glob pattern requires the prefix.
    legacy_metadata_path = os.path.join(job_dir, f"{batch_id}_metadata.json")
    try:
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)
        with open(legacy_metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)
    except Exception as e:
        print(f"⚠️  Could not write Smart Clipper metadata.json: {e}")

    # 4) Register in the in-memory `jobs` dict so /api/status/<batch>
    #    and the /api/clip/<batch>/... endpoints recognise this batch
    #    as a valid job. ResultCard's Subtitle / Dub / Edit modals
    #    all hit those routes — registering here means they work
    #    against Smart Clipper output without any further plumbing.
    jobs[batch_id] = {
        # IMPORTANT: must be "completed" (not "complete") because every
        # downstream endpoint that gates on `record.get("status") == "completed"`
        # — reframe, retrim, edit, subtitle, dub, etc. — would 409 with
        # "Job is not complete". One-letter mismatch we missed before.
        "status": "completed",
        "logs": [f"Smart Clipper cut {len(shorts)} clips."],
        "result": {"clips": shorts},
        "output_dir": job_dir,
        "input_path": req.source_path,
        "smart_clipper_batch": True,
    }

    print(
        f"✂️  Smart Clipper cut {len(shorts)}/{len(req.picks)} clips "
        f"into batch {batch_id} (reframe={do_reframe})"
    )
    return {
        "batch_id": batch_id,
        "job_id": batch_id,  # alias — ResultCard expects `jobId`
        "clips": shorts,
    }


class SaveSmartProjectRequest(BaseModel):
    source_path: str          # in-container path to the source video
    source_filename: str      # display name (the original basename)
    model_id: str
    model_label: str = ""
    target_clips: int = 6
    min_duration: float = 20.0
    max_duration: float = 60.0
    picks: List[Dict[str, Any]] = []
    elapsed_seconds: float = 0.0
    frames_examined: int = 0
    title: Optional[str] = None  # user-supplied label, optional


@app.post("/api/multimodal-clip/save-project")
async def smart_clipper_save_project(req: SaveSmartProjectRequest):
    """Persist a Smart Clipper analysis so the user can re-open it later
    without re-running the picker. Returns the new project id."""
    proj_id = uuid.uuid4().hex[:12]
    record = {
        "id": proj_id,
        "created_at": int(time.time()),
        "title": (req.title or req.source_filename or "Untitled").strip()[:120],
        "source_path": req.source_path,
        "source_filename": req.source_filename,
        "model_id": req.model_id,
        "model_label": req.model_label,
        "target_clips": req.target_clips,
        "min_duration": req.min_duration,
        "max_duration": req.max_duration,
        "picks": req.picks or [],
        "elapsed_seconds": req.elapsed_seconds,
        "frames_examined": req.frames_examined,
    }
    path = os.path.join(_smart_clipper_dir(), f"{proj_id}.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2)
    except Exception as e:
        raise HTTPException(500, f"Could not save project: {e}")
    return {"ok": True, "id": proj_id, "title": record["title"]}


@app.get("/api/multimodal-clip/projects")
async def smart_clipper_list_projects():
    """List all saved Smart Clipper projects, newest first."""
    out = []
    d = _smart_clipper_dir()
    if not os.path.isdir(d):
        return {"projects": []}
    for fname in os.listdir(d):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(d, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                rec = json.load(f)
            out.append({
                "id": rec.get("id"),
                "title": rec.get("title"),
                "created_at": rec.get("created_at"),
                "model_label": rec.get("model_label"),
                "model_id": rec.get("model_id"),
                "source_filename": rec.get("source_filename"),
                "source_path": rec.get("source_path"),
                "pick_count": len(rec.get("picks") or []),
                "elapsed_seconds": rec.get("elapsed_seconds"),
            })
        except Exception:
            continue
    out.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
    return {"projects": out}


@app.get("/api/multimodal-clip/projects/{proj_id}")
async def smart_clipper_get_project(proj_id: str):
    path = os.path.join(_smart_clipper_dir(), f"{proj_id}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "Project not found.")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


@app.delete("/api/multimodal-clip/projects/{proj_id}")
async def smart_clipper_delete_project(proj_id: str):
    path = os.path.join(_smart_clipper_dir(), f"{proj_id}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "Project not found.")
    os.remove(path)
    return {"ok": True}


# ====================================================================
# AI MOTION GRAPHICS + SFX (per-clip)
# ====================================================================

class MotionGraphicsRequest(BaseModel):
    # Either provide a plan (already-generated events list to apply
    # directly) OR leave it empty and let the LLM generate one.
    plan: Optional[Dict[str, Any]] = None
    style_hint: Optional[str] = None
    aspect: Optional[str] = None  # "9:16" / "16:9" / "1:1" — informs prompt only
    regenerate: bool = False      # ignore an attached plan, force a fresh LLM call
    # Auto mode: generate plan AND render it in a single round-trip.
    # When the frontend wants "click and forget" it sends auto=true and
    # this endpoint generates the plan, immediately renders it with
    # face-aware positioning, and returns the new clip URL.
    auto: bool = False
    # Optional transcript text to feed the LLM. When set, the prompt
    # anchors every event to a specific spoken moment — dramatically
    # better timing + content selection. Either auto-generated by the
    # /transcribe endpoint below, or pasted by the user.
    transcript: Optional[str] = None


@app.post("/api/clip/{job_id}/{clip_idx}/motion-graphics")
async def apply_motion_graphics(
    job_id: str,
    clip_idx: int,
    req: MotionGraphicsRequest,
    request: Request,
):
    """Generate (and optionally render) AI motion graphics + SFX for a
    single clip. The same endpoint handles both Generate Clips output
    and Smart Clipper batches because both register their batch in the
    `jobs` dict with a metadata.json in the standard shape.

    Two phases:
      1. Plan generation — LLM proposes overlay events.
      2. Render — bake the chosen events into a new mp4.

    Frontend usage:
      • POST with empty body → returns plan only (preview before commit).
      • POST with plan={…} → renders the supplied plan (after user
        toggled events on/off in the modal).
    """
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    job_dir = job.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    metadata_path = os.path.join(job_dir, "metadata.json")
    if not os.path.isfile(metadata_path):
        # Generate Clips writes metadata under a different filename
        # pattern; fall back to scanning the dir.
        candidates = [
            os.path.join(job_dir, f) for f in os.listdir(job_dir)
            if f.endswith("metadata.json")
        ]
        if candidates:
            metadata_path = candidates[0]
        else:
            raise HTTPException(404, "metadata.json not found")
    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)
    shorts = metadata.get("shorts", [])
    if clip_idx < 0 or clip_idx >= len(shorts):
        raise HTTPException(404, "Clip index out of range")
    clip = shorts[clip_idx]

    # Resolve the input mp4. video_url is "/videos/<job>/<file>" — strip
    # the prefix to get the on-disk path.
    video_rel = (clip.get("video_url") or "").lstrip("/")
    if video_rel.startswith("videos/"):
        video_rel = video_rel[len("videos/"):]
    input_path = os.path.join(OUTPUT_DIR, video_rel.split("?")[0])
    if not os.path.isfile(input_path):
        raise HTTPException(404, f"Clip video not found: {input_path}")

    # PHASE 1 — plan generation (if needed).
    plan = req.plan
    if not plan or req.regenerate:
        # Build a transcript-like text from the clip metadata. We don't
        # have word-level transcript on the clip-shape, so we use the
        # hook + description. That's enough context for the LLM to
        # propose timing-aware overlays.
        clip_text = (
            (clip.get("viral_hook_text") or "")
            + "\n\n"
            + (clip.get("video_title_for_youtube_short") or "")
            + "\n\n"
            + (clip.get("video_description_for_tiktok") or "")
            + "\n\n"
            + (clip.get("video_description_for_instagram") or "")
        ).strip() or "Clip without transcript context"
        duration = float(clip.get("end", 0)) - float(clip.get("start", 0))
        if duration <= 0:
            duration = 30.0  # safe fallback
        provider_id = (request.headers.get("X-LLM-Provider") or "gemini").lower()
        model_name = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
        api_key = (
            request.headers.get("X-LLM-Key")
            or request.headers.get("X-Gemini-Key")
            or os.environ.get("GEMINI_API_KEY", "")
        )
        base_url = request.headers.get("X-LLM-Base-URL") or None

        from motion_graphics import generate_motion_graphics_plan
        plan = generate_motion_graphics_plan(
            clip_text=clip_text,
            duration=duration,
            aspect=req.aspect or "9:16",
            provider_id=provider_id,
            model_name=model_name,
            api_key=api_key,
            base_url=base_url,
            style_hint=req.style_hint or "",
            # Pass the actual mp4 in so the planner can sample frames
            # for face detection and steer overlays away from speakers'
            # faces.
            input_video_path=input_path,
            # Pass the transcript through — the LLM produces much
            # better-timed and more relevant events when it can see
            # the actual spoken words instead of just hook/description
            # metadata. Frontend either auto-generates this via the
            # /transcribe endpoint or accepts a paste from the user.
            transcript=(req.transcript or "").strip(),
        )
    if not isinstance(plan, dict):
        plan = {"events": []}

    # If the caller didn't include events in the request, this was a
    # plan-only call — return the proposed plan without rendering.
    # EXCEPTION: when req.auto is True, we auto-render the freshly
    # generated plan in this same request (one-click mode). That lets
    # the frontend ship "click → done" without a second round-trip and
    # without the user having to toggle individual events.
    incoming = req.plan or {}
    is_render_call = bool(incoming.get("events")) and not req.regenerate
    if req.auto and (plan.get("events") or []):
        # Take the LLM's full proposal as-is and proceed to render. The
        # face-aware planner already snapped positions away from
        # speakers, so this is safe.
        events = plan["events"]
    elif not is_render_call:
        return {
            "ok": True,
            "plan": plan,
            "rendered": False,
            "clip_url": clip.get("video_url"),
        }
    else:
        # PHASE 2 — render with the supplied events from a manual
        # toggle pass through the modal.
        events = (req.plan or {}).get("events") or []
    if not events:
        raise HTTPException(400, "No events provided to render.")

    # Output beside the original clip with a distinct filename so the
    # original is preserved and we have something to roll back to.
    base_dir = os.path.dirname(input_path)
    base_name, ext = os.path.splitext(os.path.basename(input_path))
    out_name = f"{base_name}_mg{int(time.time())}{ext}"
    out_path = os.path.join(base_dir, out_name)
    try:
        from motion_graphics import render_clip_with_motion_graphics
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: render_clip_with_motion_graphics(
                input_path=input_path,
                output_path=out_path,
                events=events,
            ),
        )
    except Exception as e:
        raise HTTPException(500, f"Motion graphics render failed: {e}")

    # Update metadata so subsequent reads return the new version.
    new_url = "/videos/" + out_path[len(OUTPUT_DIR):].lstrip("/")
    history = clip.get("history") or []
    history.append({"video_url": clip.get("video_url"), "ts": int(time.time())})
    clip["history"] = history
    clip["video_url"] = new_url
    clip["motion_graphics_plan"] = {"events": events}
    shorts[clip_idx] = clip
    metadata["shorts"] = shorts
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    if "result" in job and isinstance(job["result"], dict):
        job["result"]["clips"] = shorts

    return {
        "ok": True,
        "rendered": True,
        "plan": {"events": events},
        "clip_url": new_url,
    }


@app.post("/api/clip/{job_id}/{clip_idx}/transcribe")
async def transcribe_clip(job_id: str, clip_idx: int):
    """Transcribe a single clip's mp4 and return plain text.

    Used by the AI Magic Overlays modal to feed real spoken-word
    context to the LLM. The result dramatically improves event timing
    + content selection vs. relying on hook/description metadata.

    Tries three sources in order:
      1. Cached clip-level transcript on disk (per-clip JSON, written
         by previous Subtitle/Magic runs) — instant.
      2. Job-level cached transcript sliced to [clip.start, clip.end] —
         instant, accurate.
      3. Fresh Whisper transcribe on the clip's mp4 — slower but
         works for any clip.

    Returns {ok, transcript, cached, source}.
    """
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    job_dir = job.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    metadata_path = os.path.join(job_dir, "metadata.json")
    if not os.path.isfile(metadata_path):
        candidates = [
            os.path.join(job_dir, f) for f in os.listdir(job_dir)
            if f.endswith("metadata.json")
        ]
        if not candidates:
            raise HTTPException(404, "metadata.json not found")
        metadata_path = candidates[0]
    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)
    shorts = metadata.get("shorts", [])
    if clip_idx < 0 or clip_idx >= len(shorts):
        raise HTTPException(404, "Clip index out of range")
    clip = shorts[clip_idx]

    # Resolve the clip mp4 on disk.
    video_rel = (clip.get("video_url") or "").lstrip("/")
    if video_rel.startswith("videos/"):
        video_rel = video_rel[len("videos/"):]
    input_path = os.path.join(OUTPUT_DIR, video_rel.split("?")[0])
    if not os.path.isfile(input_path):
        raise HTTPException(404, f"Clip video not found: {input_path}")

    # Source 1: clip-level cache sidecar next to the mp4. We write to
    # this on the first transcribe so subsequent opens are instant.
    cache_path = os.path.splitext(input_path)[0] + ".transcript.json"
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("text"):
                return {
                    "ok": True,
                    "transcript": cached["text"],
                    "cached": True,
                    "source": "clip-cache",
                }
        except Exception:
            pass  # fall through to next source

    # Source 2: job-level transcript sliced to clip [start, end].
    clip_start = float(clip.get("start") or 0.0)
    clip_end = float(clip.get("end") or 0.0)
    job_transcript = (job.get("transcript") or {}).get("segments") or []
    if job_transcript and clip_end > clip_start:
        lines = []
        for seg in job_transcript:
            s = float(seg.get("start") or 0.0)
            e = float(seg.get("end") or 0.0)
            # Keep segments that fall ENTIRELY OR PARTIALLY inside the
            # clip's range. Translate timestamps to clip-relative so
            # the LLM's t=0 matches the clip's t=0.
            if e < clip_start or s > clip_end:
                continue
            rel_s = max(0.0, s - clip_start)
            rel_e = min(clip_end - clip_start, e - clip_start)
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            lines.append(f"[{rel_s:.1f}-{rel_e:.1f}s] {text}")
        if lines:
            transcript_text = "\n".join(lines)
            # Cache for future calls.
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump({"text": transcript_text, "source": "job-slice"}, f)
            except Exception:
                pass
            return {
                "ok": True,
                "transcript": transcript_text,
                "cached": False,
                "source": "job-slice",
            }

    # Source 3: fresh Whisper transcribe on the clip mp4 itself.
    from main import transcribe_video
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, transcribe_video, input_path)
    except Exception as e:
        raise HTTPException(500, f"Transcription failed: {e}")
    if not result or not result.get("segments"):
        raise HTTPException(500, "Transcription returned no segments.")

    lines = []
    for seg in result["segments"]:
        s = float(seg.get("start") or 0.0)
        e = float(seg.get("end") or 0.0)
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{s:.1f}-{e:.1f}s] {text}")
    transcript_text = "\n".join(lines) or (result.get("text") or "").strip()
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"text": transcript_text, "source": "whisper-fresh"}, f)
    except Exception:
        pass
    return {
        "ok": True,
        "transcript": transcript_text,
        "cached": False,
        "source": "whisper-fresh",
    }


# ====================================================================
# DIMENSION SWITCHER (per-clip aspect re-render)
# ====================================================================

class AspectChangeRequest(BaseModel):
    aspect: str  # "9:16" | "16:9" | "1:1"


@app.post("/api/clip/{job_id}/{clip_idx}/aspect")
async def change_clip_aspect(job_id: str, clip_idx: int, req: AspectChangeRequest):
    """Re-render a single clip at the requested aspect using face-tracking
    reframe (reframe_kf.py). Persists the new URL on the clip record so
    any subsequent edit (subtitles, motion graphics) uses the new canvas.
    """
    aspect = (req.aspect or "").strip()
    if aspect not in ("9:16", "16:9", "1:1"):
        raise HTTPException(400, "aspect must be '9:16', '16:9', or '1:1'")
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    job_dir = job.get("output_dir") or os.path.join(OUTPUT_DIR, job_id)
    metadata_path = os.path.join(job_dir, "metadata.json")
    if not os.path.isfile(metadata_path):
        candidates = [
            os.path.join(job_dir, f) for f in os.listdir(job_dir)
            if f.endswith("metadata.json")
        ]
        if candidates:
            metadata_path = candidates[0]
        else:
            raise HTTPException(404, "metadata.json not found")
    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)
    shorts = metadata.get("shorts", [])
    if clip_idx < 0 or clip_idx >= len(shorts):
        raise HTTPException(404, "Clip index out of range")
    clip = shorts[clip_idx]

    # Resolve current clip path.
    video_rel = (clip.get("video_url") or "").lstrip("/")
    if video_rel.startswith("videos/"):
        video_rel = video_rel[len("videos/"):]
    input_path = os.path.join(OUTPUT_DIR, video_rel.split("?")[0])
    if not os.path.isfile(input_path):
        raise HTTPException(404, f"Clip video not found: {input_path}")

    # Pick output dimensions per aspect.
    aspect_dims = {
        "9:16": (1080, 1920),
        "16:9": (1920, 1080),
        "1:1":  (1080, 1080),
    }
    target_w, target_h = aspect_dims[aspect]

    # Use ffmpeg with smart crop. For face-tracking we'd hand off to
    # reframe_kf.py — but reframe_kf takes start/end inside a SOURCE
    # video, and here we already have the cut clip on disk. So apply
    # a simpler centred crop+scale that respects the aspect. The
    # existing Reframe modal in ResultCard still hands off to
    # reframe_kf.py for the deeper face-tracked version per-clip;
    # this endpoint is the quick preset.
    base_dir = os.path.dirname(input_path)
    base_name, ext = os.path.splitext(os.path.basename(input_path))
    out_name = f"{base_name}_{aspect.replace(':', 'x')}_{int(time.time())}{ext}"
    out_path = os.path.join(base_dir, out_name)

    # Build a pad+scale chain that preserves the source content fully,
    # using ffmpeg's force_original_aspect_ratio + pad. This is the
    # safe "letterbox/pillarbox" path that never crops anything off.
    # For a true face-tracked crop, use the existing Reframe modal.
    crop_filter = (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black"
    )

    cmd = [
        "ffmpeg", "-loglevel", "error",
        "-i", input_path,
        "-vf", crop_filter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "21",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-y",
        out_path,
    ]
    loop = asyncio.get_event_loop()
    proc = await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=600),
    )
    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise HTTPException(
            500,
            f"Aspect re-render failed: {proc.stderr[-800:] if proc.stderr else 'unknown'}",
        )

    new_url = "/videos/" + out_path[len(OUTPUT_DIR):].lstrip("/")
    history = clip.get("history") or []
    history.append({"video_url": clip.get("video_url"), "ts": int(time.time())})
    clip["history"] = history
    clip["video_url"] = new_url
    clip["aspect"] = aspect
    shorts[clip_idx] = clip
    metadata["shorts"] = shorts
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    if "result" in job and isinstance(job["result"], dict):
        job["result"]["clips"] = shorts

    return {"ok": True, "clip_url": new_url, "aspect": aspect}


@app.get("/api/local/config")
async def local_mode_config():
    """Tell the frontend whether the 'use file from disk' option should
    be visible, and what root directories the user is allowed to point
    at. Frontend hides the tab when enabled=False so production
    deployments don't even hint at the feature."""
    return {
        "enabled": KLIPRA_LOCAL_MODE,
        "roots": KLIPRA_LOCAL_MEDIA_ROOTS,
        "allowed_extensions": sorted(KLIPRA_LOCAL_ALLOWED_EXTS),
        "max_size_mb": MAX_FILE_SIZE_MB,
    }


@app.get("/api/local/find")
async def local_mode_find(
    name: str,
    size: Optional[int] = None,
):
    """Resolve a browser-dragged or file-picked file to an absolute
    in-container path WITHOUT uploading the file's bytes.

    Why: browsers cannot expose absolute filesystem paths to a
    webpage (a hard security restriction). When the user drops a
    file in the dashboard, we get only `name` and `size`. This
    endpoint walks the configured KLIPRA_LOCAL_MEDIA_ROOTS recursively
    looking for files whose basename matches `name`. When `size` is
    also provided, we filter to those whose size matches exactly —
    that combination is effectively unique on a personal machine.

    Returns:
        {
            "matches": [
                {"path": "/app/local_media/MyClip.mp4", "size": 12345678}
            ]
        }

    Frontend uses the result like this:
        - exactly one match → autofill the path, ready to Generate
        - multiple matches  → show a small picker
        - zero matches      → tell the user to move the file into
                              ~/Desktop/Movies (or whatever root is
                              configured)
    """
    if not KLIPRA_LOCAL_MODE:
        raise HTTPException(
            status_code=403,
            detail="Local-file mode is disabled on this server.",
        )
    if not KLIPRA_LOCAL_MEDIA_ROOTS:
        raise HTTPException(
            status_code=500,
            detail="No KLIPRA_LOCAL_MEDIA_ROOTS configured.",
        )
    target_name = (name or "").strip()
    if not target_name:
        raise HTTPException(status_code=400, detail="Missing name.")
    # Bail on path-separator chars in `name` so a malicious value can't
    # turn this into a "is this absolute path readable?" probe. The
    # browser only ever supplies a basename anyway.
    if "/" in target_name or "\\" in target_name or target_name.startswith("."):
        raise HTTPException(
            status_code=400,
            detail="`name` must be a basename, not a path.",
        )
    matches = []
    # Cap how many directory entries we scan per root so a giant
    # mounted folder doesn't tie up the worker. Bumped to 200_000 when
    # the user opted-in to mounting ~/Downloads + ~/Documents — those
    # can easily contain tens of thousands of files (years of saved
    # PDFs, screenshots, etc.) and 50k would miss recent additions.
    scan_budget = 200_000
    # De-dup table. When the user has overlapping mounts (e.g.
    # ~/Desktop and ~/Desktop/Movies both mounted), the same physical
    # file appears at multiple paths inside the container. macOS bind
    # mounts give each view a different st_dev, so st_ino alone is
    # ambiguous — we key by (size, name) PLUS first 64 KB content hash
    # to be safe. (Reading 64 KB once per hit is cheap; we cap matches
    # tightly so the worst case is a few MB of reads.)
    import hashlib as _hashlib
    seen_keys: set = set()

    def _fingerprint(path: str, fsize: int) -> Optional[str]:
        try:
            with open(path, "rb") as f:
                head = f.read(64 * 1024)
        except OSError:
            return None
        return f"{fsize}:{_hashlib.sha1(head).hexdigest()}"

    for root in KLIPRA_LOCAL_MEDIA_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # Skip hidden folders (.git, .DS_Store, etc.) so we don't
            # waste cycles or bump into permissions errors.
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in filenames:
                scan_budget -= 1
                if scan_budget <= 0:
                    break
                if fname != target_name:
                    continue
                full = os.path.join(dirpath, fname)
                # Confirm containment after realpath — same defence
                # as _resolve_local_media_path uses. If a symlink
                # somehow points outside, drop it.
                resolved = os.path.realpath(full)
                root_norm = root.rstrip(os.sep) + os.sep
                if not (resolved + os.sep).startswith(root_norm):
                    continue
                try:
                    fsize = os.path.getsize(resolved)
                except OSError:
                    continue
                if size is not None:
                    try:
                        if int(size) != fsize:
                            continue
                    except (TypeError, ValueError):
                        pass
                # De-dup: same fingerprint = same file via a different
                # mount. Keep the FIRST (shortest, most-canonical) path
                # encountered and drop the rest.
                fp = _fingerprint(resolved, fsize)
                if fp is None:
                    continue
                if fp in seen_keys:
                    continue
                seen_keys.add(fp)
                matches.append({"path": resolved, "size": fsize})
            if scan_budget <= 0:
                break
        if scan_budget <= 0:
            break
    # If the user has the SAME file genuinely copied in multiple
    # physical locations, we still surface all of them — they have
    # different content fingerprints because their bytes differ on
    # disk. Order is the discovery order, which (since we iterate
    # KLIPRA_LOCAL_MEDIA_ROOTS in declaration order) puts the
    # canonical /app/local_media path first.
    return {"matches": matches}


@app.post("/api/process")
async def process_endpoint(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    local_path: Optional[str] = Form(None),
):
    # Multi-provider support. New headers take precedence; the legacy
    # X-Gemini-Key is still accepted so the existing dashboard keeps working.
    provider_id = (request.headers.get("X-LLM-Provider") or "gemini").lower()
    llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    llm_base_url = request.headers.get("X-LLM-Base-URL") or ""
    api_key = (
        request.headers.get("X-LLM-Key")
        or request.headers.get("X-Gemini-Key")
        or ""
    )
    if provider_id != "ollama" and not api_key:
        raise HTTPException(
            status_code=400,
            detail="Missing API key. Send X-LLM-Key (or legacy X-Gemini-Key).",
        )

    # Handle JSON body manually for URL payload
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
        url = body.get("url")
        # JSON path also allows local_path so curl/script callers can
        # use the no-upload mode without multipart form encoding.
        local_path = local_path or body.get("local_path")

    if not url and not file and not local_path:
        raise HTTPException(status_code=400, detail="Must provide URL, File, or local_path")

    job_id = str(uuid.uuid4())
    job_output_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_output_dir, exist_ok=True)

    # Prepare Command
    cmd = ["python", "-u", "main.py"] # -u for unbuffered
    env = os.environ.copy()
    # Primary — the new multi-provider vars main.py reads
    env["OPENSHORTS_LLM_PROVIDER"] = provider_id
    env["OPENSHORTS_LLM_MODEL"] = llm_model
    env["OPENSHORTS_LLM_KEY"] = api_key
    if llm_base_url:
        env["OPENSHORTS_LLM_BASE_URL"] = llm_base_url

    # Clip-selection sliders sent by the dashboard. main.py reads these
    # from env and substitutes them into the LLM prompt.
    #
    # Whisper / transcript:
    #   X-Whisper-Model     → 'base' | 'small' | 'medium' (speed vs accuracy)
    #   X-Transcript-Lang   → ISO code to force on Whisper, e.g. 'ur' for Urdu.
    #                         Without this, Whisper auto-detects and may pick
    #                         'hi' (Hindi/Devanagari) for Urdu speakers.
    #   X-Transcript-Script → 'auto' (default) | 'roman'. When 'roman' we run
    #                         the LLM transliterator on the Whisper output
    #                         BEFORE clip selection, so the live progress
    #                         logs, the picker LLM, and the default subtitles
    #                         all see Latin letters.
    for header_name, env_name, default in [
        ("X-Min-Clips",            "OPENSHORTS_MIN_CLIPS",         "3"),
        ("X-Max-Clips",            "OPENSHORTS_MAX_CLIPS",         "8"),
        ("X-Min-Duration",         "OPENSHORTS_MIN_DURATION",      "20"),
        ("X-Max-Duration",         "OPENSHORTS_MAX_DURATION",      "60"),
        # Whisper model. Was 'medium' historically, but the dashboard
        # explicitly advertises Whisper Turbo (large-v3-turbo) as the
        # default — same accuracy as Large-v3 but ~8x faster. The
        # 'medium' default here was silently stomping main.py's
        # large-v3-turbo fallback, so jobs were running on a
        # smaller / less accurate model than the UI promised.
        ("X-Whisper-Model",        "OPENSHORTS_WHISPER_MODEL",     "large-v3-turbo"),
        ("X-Transcript-Lang",      "OPENSHORTS_TRANSCRIPT_LANG",   ""),
        ("X-Transcript-Script",    "OPENSHORTS_TRANSCRIPT_SCRIPT", "auto"),
        # Stage-1 engine choice. 'whisper' (default, free, local) or
        # 'elevenlabs' (paid, ElevenLabs Scribe — requires the key below).
        ("X-Transcribe-Provider",  "OPENSHORTS_TRANSCRIBE_PROVIDER", "whisper"),
    ]:
        env[env_name] = request.headers.get(header_name) or default
    # Forward the ElevenLabs key (if present) into env so the Scribe
    # client picks it up. Same key the dub feature uses.
    eleven_key_header = request.headers.get("X-ElevenLabs-Key") or ""
    if eleven_key_header:
        env["OPENSHORTS_ELEVENLABS_KEY"] = eleven_key_header
        env["ELEVENLABS_API_KEY"] = eleven_key_header  # legacy alias
    # Legacy — fill GEMINI_API_KEY for code paths that still read it
    # directly (hooks.py, thumbnail.py, saasshorts.py — ported next pass).
    if provider_id == "gemini" and api_key:
        env["GEMINI_API_KEY"] = api_key
    
    input_path = None
    if url:
        cmd.extend(["-u", url])
    elif local_path:
        # NO-UPLOAD path: validate the user-supplied filesystem path
        # (must be under an allowlisted root, exist, be readable, have
        # a media extension, be ≤ size cap). On success the rest of
        # the pipeline treats it like any other input_path — Whisper,
        # ffmpeg, etc. all take a path string and don't care that it
        # wasn't copied through UPLOAD_DIR.
        try:
            input_path = _resolve_local_media_path(local_path)
        except HTTPException:
            try:
                shutil.rmtree(job_output_dir)
            except Exception:
                pass
            raise
        # Drop a sidecar so retrim / change-background / past-projects
        # can still resolve a source by job_id, same as the upload
        # path does.
        try:
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            link_path = os.path.join(UPLOAD_DIR, f".{job_id}.link")
            with open(link_path, "w") as lf:
                lf.write(input_path)
        except OSError:
            pass
        print(f"📁 Local-file source: {input_path} (job {job_id} — no upload)")
        cmd.extend(["-i", input_path])
    else:
        # Use the same content-addressed dedup helper the standalone
        # endpoints use. Re-uploading the same source video produces
        # NO new disk usage on the second+ upload — the helper detects
        # the matching SHA-256 and points this job at the existing
        # canonical file. Sanitization + size limit are still enforced
        # inside the helper.
        try:
            input_path = _save_upload_dedup(file, job_id)
        except HTTPException:
            try:
                shutil.rmtree(job_output_dir)
            except Exception:
                pass
            raise
        cmd.extend(["-i", input_path])

    cmd.extend(["-o", job_output_dir])

    # Enqueue Job
    jobs[job_id] = {
        'status': 'queued',
        'logs': [f"Job {job_id} queued."],
        'cmd': cmd,
        'env': env,
        'output_dir': job_output_dir,
        # Cache the resolved upload path so retrim/reframe can skip
        # the UPLOAD_DIR scan + sidecar read while this job is alive
        # in memory. None for URL-ingest jobs (yt-dlp drops the source
        # in the job folder; _find_source_video covers that case).
        'input_path': input_path if not url else None,
    }
    
    await job_queue.put(job_id)
    
    return {"job_id": job_id, "status": "queued"}

@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    return {
        "status": job['status'],
        "logs": job['logs'],
        "result": job.get('result')
    }


@app.post("/api/retry/{job_id}")
async def retry_job(
    job_id: str,
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    """Re-run a failed clip-generation job, reusing on-disk checkpoints.

    main.py now writes `<title>_clips_checkpoint.json` as soon as the
    LLM picker returns, and per-clip mp4 files act as their own
    checkpoint via os.path.exists. Calling this endpoint re-queues
    the SAME cmd against the SAME output_dir, so main.py picks up
    where the previous attempt left off — skipping the expensive
    transcribe/picker/reframe stages that already succeeded.

    Tolerant of three scenarios:
      • Job alive in memory (normal case) — re-queue verbatim.
      • Job rehydrated from disk after restart (no cmd cached) — try
        to reconstruct the cmd from the on-disk output_dir + input
        path so resume still works.
      • Job folder doesn't exist anywhere — return 404 with a clear
        explanation so the user knows to re-upload.

    SWITCH-AI override:
        Callers may pass X-LLM-Provider / X-LLM-Model / X-LLM-Key /
        X-LLM-Base-URL headers to swap the AI provider used by the
        resumed run — useful when Gemini hits a daily quota and the
        user wants to finish the job on free Ollama instead. The
        on-disk transcript + clip checkpoints survive, so only the
        steps that still need an LLM run against the new provider.
    """
    job = jobs.get(job_id)
    job_dir = os.path.join(OUTPUT_DIR, job_id)

    if not job and not os.path.isdir(job_dir):
        raise HTTPException(404, "Job not found in memory or on disk. Re-upload the source video to start fresh.")

    if job:
        status = job.get("status", "")
        if status == "processing":
            raise HTTPException(409, "Job is currently running; cannot retry.")
        if status == "completed" and (job.get("result") or {}).get("clips"):
            raise HTTPException(409, "Job already completed successfully.")

    # If the job's cmd was lost (backend restart), try to reconstruct
    # the bare-minimum command from on-disk state. We need:
    #   - input path: look for the original upload in UPLOAD_DIR or
    #     inside the job folder (yt-dlp drops it there for URL jobs).
    #   - output dir: <OUTPUT_DIR>/<job_id>.
    if not job or "cmd" not in job:
        # Try to locate the source video.
        input_path = None
        if job and job.get("input_path") and os.path.isfile(job["input_path"]):
            input_path = job["input_path"]
        else:
            try:
                input_path = _find_source_video(job_id)
            except Exception:
                input_path = None
        if not input_path:
            raise HTTPException(
                409,
                "Cannot reconstruct retry command for this job after backend restart — "
                "the original source video isn't on disk anymore. Re-upload to start fresh."
            )
        # Rebuild a minimal `python main.py` cmd with the original input
        # and output dir. Resume logic in main.py picks up the rest from
        # disk checkpoints.
        rebuilt_cmd = [
            "python", "main.py",
            "-i", input_path,
            "-o", job_dir,
        ]
        env = os.environ.copy()
        jobs[job_id] = {
            "status": "queued",
            "logs": [f"Job {job_id} re-queued (cmd reconstructed after restart)."],
            "cmd": rebuilt_cmd,
            "env": env,
            "output_dir": job_dir,
            "input_path": input_path,
        }
    else:
        # Reset the job's transient state but keep cmd/env/output_dir/
        # input_path so the resume works against the SAME folder.
        job["status"] = "queued"
        job["logs"] = [
            f"Job {job_id} re-queued for retry. "
            f"main.py will skip steps whose checkpoints already exist on disk."
        ]
        job["result"] = None

    # ---------- SWITCH-AI override --------------------------------------
    # If the caller provided new provider/model/key headers, patch the
    # job's env dict in place so the resumed subprocess picks them up.
    # We log the swap clearly so the user sees it in the live log feed.
    if x_llm_provider or x_llm_model or x_llm_key or x_llm_base_url:
        target = jobs[job_id]
        env = target.get("env") or os.environ.copy()
        old_prov = env.get("OPENSHORTS_LLM_PROVIDER", "")
        old_model = env.get("OPENSHORTS_LLM_MODEL", "")
        if x_llm_provider:
            env["OPENSHORTS_LLM_PROVIDER"] = x_llm_provider
        if x_llm_model:
            env["OPENSHORTS_LLM_MODEL"] = x_llm_model
        if x_llm_key is not None:
            # Allow empty string for Ollama (no key needed).
            env["OPENSHORTS_LLM_KEY"] = x_llm_key
            # Mirror into the legacy Gemini env var so older code paths
            # (hooks.py, thumbnail.py, saasshorts.py) see a fresh key.
            if (x_llm_provider or env.get("OPENSHORTS_LLM_PROVIDER")) == "gemini" and x_llm_key:
                env["GEMINI_API_KEY"] = x_llm_key
        if x_llm_base_url:
            env["OPENSHORTS_LLM_BASE_URL"] = x_llm_base_url
        target["env"] = env
        new_prov = env.get("OPENSHORTS_LLM_PROVIDER", "")
        new_model = env.get("OPENSHORTS_LLM_MODEL", "")
        target.setdefault("logs", []).append(
            f"🔄 AI provider switched for resume: "
            f"{old_prov}/{old_model} → {new_prov}/{new_model}"
        )

    await job_queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "retry": True}

from editor import VideoEditor
from subtitles import generate_srt, burn_subtitles, generate_srt_from_video, generate_srt_per_segment
from hooks import add_hook_to_video
from translate import translate_video, get_supported_languages
from thumbnail import analyze_video_for_titles, refine_titles, generate_thumbnail, generate_youtube_description

class EditRequest(BaseModel):
    job_id: str
    clip_index: int
    api_key: Optional[str] = None
    input_filename: Optional[str] = None
    # Auto-mix synthetic sound effects on top of zoom transitions.
    # When enabled, editor.apply_edits parses the AI's zoompan zone
    # boundaries, picks a cue (impact / pop / whoosh / reverse_whoosh)
    # for each transition, and mixes them into the audio at the right
    # timestamps. sfx_volume is a master gain (0.0-1.0).
    enable_sfx: Optional[bool] = False
    sfx_volume: Optional[float] = 0.6

@app.post("/api/edit")
async def edit_clip(
    req: EditRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key"),
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    provider_id = (x_llm_provider or "gemini").lower()
    llm_model = x_llm_model or None
    # Determine API Key — prefer the new multi-provider header
    final_api_key = x_llm_key or req.api_key or x_gemini_key or os.environ.get("GEMINI_API_KEY")

    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key (Header or Body)")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")
        
    try:
        # Resolve Input Path: Prefer explict input_filename from frontend (chaining edits)
        if req.input_filename:
            # Security: Ensure just a filename, no paths
            safe_name = os.path.basename(req.input_filename)
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
            filename = safe_name
        else:
            # Fallback to original clip
            clip = job['result']['clips'][req.clip_index]
            filename = _clip_filename_from_url(clip['video_url'])
            input_path = os.path.join(OUTPUT_DIR, req.job_id, filename)
        
        if not os.path.exists(input_path):
             raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

        # Define output path for edited video. Suffix with cache_bust ms
        # so each Auto Edit run writes a NEW file (so the browser <video>
        # cannot accidentally serve a stale cached copy of the previous
        # edit).
        cache_bust_ms = int(time.time() * 1000)
        edited_filename = f"edited_{cache_bust_ms}_{filename}"
        output_path = os.path.join(OUTPUT_DIR, req.job_id, edited_filename)
        
        # Run editing in a thread to avoid blocking main loop
        # Since VideoEditor uses blocking calls (subprocess, API wait)
        def run_edit():
            editor = VideoEditor(
                api_key=final_api_key,
                provider_id=provider_id,
                model_name=llm_model,
                base_url=x_llm_base_url,
            )
            
            # SAFE FILE RENAMING STRATEGY (Avoid UnicodeEncodeError in Docker)
            # Create a safe ASCII filename in the same directory
            safe_filename = f"temp_input_{req.job_id}.mp4"
            safe_input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_filename)
            
            # Copy original file to safe path
            # (Copy is safer than rename if something crashes, we keep original)
            shutil.copy(input_path, safe_input_path)
            
            try:
                # 1. Upload (using safe path)
                vid_file = editor.upload_video(safe_input_path)
                
                # 2. Get duration
                import cv2
                cap = cv2.VideoCapture(safe_input_path)
                fps = cap.get(cv2.CAP_PROP_FPS)
                frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                duration = frame_count / fps if fps else 0
                cap.release()
                
                # Load transcript from metadata
                transcript = None
                try:
                    meta_files = glob.glob(os.path.join(OUTPUT_DIR, req.job_id, "*_metadata.json"))
                    if meta_files:
                        with open(meta_files[0], 'r') as f:
                            data = json.load(f)
                            transcript = data.get('transcript')
                except Exception as e:
                    print(f"⚠️ Could not load transcript for editing context: {e}")

                # 3. Get Plan (Filter String)
                filter_data = editor.get_ffmpeg_filter(vid_file, duration, fps=fps, width=width, height=height, transcript=transcript)
                
                # 4. Apply
                # Use safe output name first
                safe_output_path = os.path.join(OUTPUT_DIR, req.job_id, f"temp_output_{req.job_id}.mp4")
                editor.apply_edits(
                    safe_input_path, safe_output_path, filter_data,
                    enable_sfx=bool(req.enable_sfx),
                    sfx_volume=float(req.sfx_volume or 0.6),
                )
                
                # Move result to final destination (rename works even if dest name has unicode if filesystem supports it, 
                # but python might still struggle if locale is broken? No, os.rename usually handles it better than subprocess args)
                # Actually, output_path is defined above: f"edited_{filename}"
                # If filename has unicode, output_path has unicode.
                # Let's hope shutil.move / os.rename works.
                if os.path.exists(safe_output_path):
                    shutil.move(safe_output_path, output_path)
                
                return filter_data
            finally:
                # Cleanup temp safe input
                if os.path.exists(safe_input_path):
                    os.remove(safe_input_path)

        # Run in thread pool
        loop = asyncio.get_event_loop()
        plan = await loop.run_in_executor(None, run_edit)

        # Centralized: pushes prev URL to history, persists to metadata,
        # syncs in-memory job, returns cache-busted URL.
        new_video_url = _apply_clip_change(
            req.job_id, req.clip_index, edited_filename,
            operation='auto-edit',
        )

        return {
            "success": True,
            "new_video_url": new_video_url,
            "edit_plan": plan,
        }

    except Exception as e:
        print(f"❌ Edit Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class TimelineEditRequest(BaseModel):
    job_id: str
    clip_index: int
    input_filename: Optional[str] = None
    # List of {start, end, effect}. Order matters — effects are chained
    # in the order the user added them.
    regions: List[Dict[str, Any]]
    # Optional sound-effect mix. When enable_sfx is True, each motion
    # region (zoom-punch, slow-pan, shake, flash) gets a synthetic SFX
    # cue mixed into the audio at its start time. sfx_volume is a
    # master gain (0-1) applied to all cues.
    enable_sfx: Optional[bool] = False
    sfx_volume: Optional[float] = 0.6


@app.post("/api/clip/edit-timeline")
async def edit_timeline(req: TimelineEditRequest):
    """Render a clip with the user's hand-picked region/effect timeline.

    This is the renderer behind the new Edit modal. Replaces the old
    "Auto Edit" path where an LLM blindly designed effects — here the
    user explicitly chose where each effect goes and which kind, so
    output is always exactly what they expect.
    """
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[req.job_id]
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)

    if req.input_filename:
        filename = os.path.basename(req.input_filename)
    else:
        clip = (job.get("result") or {}).get("clips", [])[req.clip_index]
        filename = _clip_filename_from_url(clip.get("video_url", ""))
    input_path = os.path.join(output_dir, filename) if filename else None
    if not input_path or not os.path.exists(input_path):
        raise HTTPException(404, f"Video file not found")

    if not req.regions:
        raise HTTPException(400, "Add at least one region with an effect.")

    # Probe source dimensions so the motion filters can use literal
    # crop sizes (works on every ffmpeg version, including 4.x where
    # the older crop-with-eval=frame pattern errors out).
    src_w, src_h = 0, 0
    try:
        import cv2 as _cv2
        _cap = _cv2.VideoCapture(input_path)
        src_w = int(_cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(_cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
        _cap.release()
    except Exception:
        pass

    from timeline_effects import build_filter_from_timeline
    filter_string = build_filter_from_timeline(req.regions,
                                                source_width=src_w,
                                                source_height=src_h)
    if not filter_string:
        raise HTTPException(400, "No valid effects in the timeline.")

    cache_bust_ms = int(time.time() * 1000)
    edited_filename = f"edited_{cache_bust_ms}_{filename}"
    output_path = os.path.join(output_dir, edited_filename)

    # SFX cue mapping — motion effect name -> synthetic SFX preset.
    # Color grades and other non-motion effects don't get a cue.
    SFX_FOR_EFFECT = {
        "zoom-punch": "impact",
        "punch-in": "impact",
        "slow-pan": "riser",
        "shake": "impact",
        "flash": "ding",
    }
    sfx_cues: list[tuple[float, str]] = []
    if req.enable_sfx:
        for region in req.regions or []:
            eff = (region.get("effect") or "").strip().lower()
            cue = SFX_FOR_EFFECT.get(eff)
            if not cue:
                continue
            # Skip whole-clip regions — a single SFX firing at t=0 is
            # not what users want for "graded entire video" applications.
            if region.get("whole"):
                continue
            try:
                t_s = max(0.0, float(region.get("start", 0)))
            except (TypeError, ValueError):
                continue
            sfx_cues.append((t_s, cue))
        # Cap so a 20-region timeline doesn't drown in audio.
        sfx_cues = sfx_cues[:8]

    # Run ffmpeg in a thread pool so the API stays responsive.
    def run():
        env = os.environ.copy()
        env["LANG"] = "C.UTF-8"
        env["LC_ALL"] = "C.UTF-8"

        if sfx_cues:
            # filter_complex path — same shape as editor.apply_edits's
            # SFX path. Builds a single video chain + N delayed SFX
            # sources mixed with original audio.
            from editor import VideoEditor as _VE
            video_chain = f"[0:v]{filter_string}[v]"
            sfx_chunks: list[str] = []
            sfx_inputs: list[str] = []
            master_gain = max(0.0, min(1.5, float(req.sfx_volume or 0.6)))
            for i, (t_s, cue_type) in enumerate(sfx_cues):
                src_label = f"sfxsrc{i}"
                src_chunk, _dur = _VE._build_sfx_source(
                    cue_type, src_label, master_gain=master_gain,
                )
                delay_ms = max(0, int(round(t_s * 1000)))
                delayed_label = f"sfx{i}d"
                sfx_chunks.append(src_chunk)
                sfx_chunks.append(
                    f"[{src_label}]aformat=channel_layouts=stereo,"
                    f"adelay={delay_ms}|{delay_ms}[{delayed_label}]"
                )
                sfx_inputs.append(f"[{delayed_label}]")
            mix_inputs = "[0:a]" + "".join(sfx_inputs)
            mix_chunk = (
                f"{mix_inputs}amix=inputs={1 + len(sfx_inputs)}:"
                f"duration=first:dropout_transition=0:normalize=0[a]"
            )
            filter_complex = ";".join([video_chain, *sfx_chunks, mix_chunk])
            print(
                f"🎬 Edit timeline ({len(req.regions)} regions, "
                f"{len(sfx_cues)} SFX cues, gain={master_gain:.2f})"
            )
            cmd = [
                "ffmpeg", "-y",
                "-i", input_path,
                "-filter_complex", filter_complex,
                "-map", "[v]", "-map", "[a]",
                "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                "-c:a", "aac", "-b:a", "192k",
                output_path,
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", input_path,
                "-vf", filter_string,
                "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                "-c:a", "copy",
                output_path,
            ]
            print(f"🎬 Edit timeline filter ({len(req.regions)} region(s)): {filter_string[:300]}…")

        # Encode args to bytes to avoid ascii filesystem issues with
        # unicode filenames.
        cmd_bytes = [a.encode("utf-8") if isinstance(a, str) else a for a in cmd]
        result = subprocess.run(cmd_bytes, capture_output=True, env=env)
        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")[-1000:]
            raise RuntimeError(f"FFmpeg failed: {err}")

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run)
    except Exception as e:
        print(f"❌ Timeline edit failed: {e}")
        raise HTTPException(500, str(e))

    new_video_url = _apply_clip_change(
        req.job_id, req.clip_index, edited_filename,
        operation="edit-timeline",
    )
    return {
        "success": True,
        "new_video_url": new_video_url,
        "regions": req.regions,
    }


class RegionPreviewRequest(BaseModel):
    """Audition a single region's effect without committing to the
    full multi-region render. Returns a short mp4 the EditModal plays
    inline next to the region card."""
    job_id: str
    clip_index: int
    input_filename: Optional[str] = None
    region: Dict[str, Any]


@app.post("/api/clip/edit-region-preview")
async def edit_region_preview(req: RegionPreviewRequest):
    """Render JUST one region with its effect applied so the user can
    see the effect before clicking the destructive Render edit button.

    Implementation:
      1. ffmpeg -ss <start> -t <duration> trims the input to the
         region's time range (with a tiny lead-in for context).
      2. The trimmed segment is passed through build_filter_from_timeline
         with start=0 / end=duration since after trimming the segment
         starts at t=0.
      3. Output is muxed without audio (-an) — previews are visual-only,
         keeps file size + render time low.

    Output filename includes a hash of (start, end, effect) so the
    frontend can cache: clicking Preview a second time on unchanged
    params reuses the already-rendered file and is effectively instant.
    """
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)

    if req.input_filename:
        filename = os.path.basename(req.input_filename)
    else:
        clip = (jobs[req.job_id].get("result") or {}).get("clips", [])[req.clip_index]
        filename = _clip_filename_from_url(clip.get("video_url", ""))
    input_path = os.path.join(output_dir, filename) if filename else None
    if not input_path or not os.path.exists(input_path):
        raise HTTPException(404, "Video file not found")

    region = req.region or {}
    whole = bool(region.get("whole"))
    if whole:
        # Whole-clip preview — just trim a 3-second sample from the
        # start of the clip so the user can audition the colour grade
        # quickly. The grade is time-independent, so 3s is enough.
        start = 0.0
        end = 3.0
    else:
        start = max(0.0, float(region.get("start", 0)))
        end = float(region.get("end", start + 1))
        if end <= start:
            raise HTTPException(400, "Region end must be after start.")
    duration = max(0.3, end - start)

    # Probe the source video's dimensions so the timeline_effects
    # module can substitute them as literal constants in the crop
    # filter. Without this it falls back to the eval=frame-on-crop
    # pattern which BREAKS on ffmpeg 4.x (debian-bullseye base).
    src_w, src_h = 0, 0
    try:
        import cv2 as _cv2
        _cap = _cv2.VideoCapture(input_path)
        src_w = int(_cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(_cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
        _cap.release()
    except Exception:
        pass

    # Build a single-region filter, but rebase to start=0 because we're
    # trimming the input first.
    from timeline_effects import build_filter_from_timeline
    one_region = {**region, "start": 0.0, "end": duration}
    filter_string = build_filter_from_timeline([one_region],
                                                source_width=src_w,
                                                source_height=src_h)
    if not filter_string:
        raise HTTPException(400, "Invalid effect.")

    import hashlib
    # Cache key: include `whole` flag so a whole-clip preview and a
    # region preview of the same effect don't collide. Region previews
    # cache by (start, end, effect); whole previews cache by effect alone.
    if whole:
        key = hashlib.md5(
            f"{filename}|whole|{region.get('effect')}".encode()
        ).hexdigest()[:12]
    else:
        key = hashlib.md5(
            f"{filename}|{start:.3f}|{end:.3f}|{region.get('effect')}".encode()
        ).hexdigest()[:12]
    preview_filename = f"preview_region_{key}.mp4"
    preview_path = os.path.join(output_dir, preview_filename)

    # Cache hit — file already exists with these exact params.
    if os.path.isfile(preview_path):
        return {
            "success": True,
            "preview_url": f"/videos/{req.job_id}/{preview_filename}",
            "duration": duration,
            "cached": True,
        }

    def run():
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}",
            "-i", input_path,
            "-t", f"{duration:.3f}",
            "-vf", filter_string,
            "-c:v", "libx264",
            # 'ultrafast' preset prioritizes encoding speed over file
            # size — exactly what we want for a transient preview.
            "-preset", "ultrafast",
            "-crf", "26",
            "-an",  # no audio for previews
            "-movflags", "+faststart",
            preview_path,
        ]
        env = os.environ.copy()
        env["LANG"] = "C.UTF-8"
        env["LC_ALL"] = "C.UTF-8"
        cmd_bytes = [a.encode("utf-8") if isinstance(a, str) else a for a in cmd]
        result = subprocess.run(cmd_bytes, capture_output=True, env=env)
        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")[-1000:]
            raise RuntimeError(f"FFmpeg failed: {err}")

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run)
    except Exception as e:
        print(f"❌ Region preview failed: {e}")
        raise HTTPException(500, str(e))

    return {
        "success": True,
        "preview_url": f"/videos/{req.job_id}/{preview_filename}",
        "duration": duration,
        "cached": False,
    }


@app.get("/api/edit/effect-catalog")
async def edit_effect_catalog():
    """Return the list of effects the Edit modal exposes. Frontend
    pulls this once and renders the picker — keeps recipe + UI catalog
    in lockstep without needing to update two files for a new effect.
    """
    from timeline_effects import EFFECT_CATALOG
    return {"effects": EFFECT_CATALOG}


class SubtitleRequest(BaseModel):
    job_id: str
    clip_index: int
    position: str = "bottom" # top, middle, bottom
    font_size: int = 16
    font_name: str = "Verdana"
    font_color: str = "#FFFFFF"
    border_color: str = "#000000"
    border_width: int = 2
    bg_color: str = "#000000"
    bg_opacity: float = 0.0
    input_filename: Optional[str] = None
    # Text-script options:
    #   'auto'        — use Whisper's output as-is (default, original behavior)
    #   'roman'       — transliterate non-Latin scripts to Roman/Latin
    #                   (e.g. Hindi/Urdu/Arabic/Cyrillic → ASCII)
    #   'translate'   — translate the transcript to `target_language` first
    script_mode: Optional[str] = "auto"
    target_language: Optional[str] = None  # used when script_mode='translate'
    # Optional: user hand-edited text from the regenerate preview. When
    # set, the backend writes this exact text to the SRT (one line per
    # segment, evenly distributed across the clip's time range) instead
    # of slicing a cached transcript. Used by the two-phase Regenerate
    # flow's "Burn" step.
    edited_text: Optional[str] = None
    # Animation style applied at burn time. Values:
    #   'none'     — plain subtitles (default; matches legacy behaviour)
    #   'pop'      — line fade-in + per-word \k karaoke flip from
    #                font_color → highlight_color
    #   'karaoke'  — per-word \K continuous fill (highlight sweeps the word)
    #   'glow'     — thicker outline + colored shadow in highlight_color
    # All values are accepted by burn_subtitles → srt_to_ass; unknown
    # strings degrade to 'none' (rendered plain).
    animation: Optional[str] = "none"
    # Hex color used by the karaoke/glow effects. Sent as #RRGGBB; the
    # ASS converter handles the &HAABBGGRR transform downstream.
    highlight_color: Optional[str] = "#FFDD00"


@app.get("/api/clip/{job_id}/{clip_index}/transcript")
async def get_clip_transcript(job_id: str, clip_index: int):
    """Return word-level captions for a specific clip, formatted for Remotion."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    output_dir = os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")

    with open(json_files[0], 'r') as f:
        data = json.load(f)

    transcript = data.get('transcript')
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript not found in metadata")

    clips = data.get('shorts', [])
    if clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")

    clip_data = clips[clip_index]
    clip_start = clip_data.get('start', 0)
    clip_end = clip_data.get('end', 0)

    # Extract words within clip range and convert to CaptionWord format
    captions = []
    for segment in transcript.get('segments', []):
        for word_info in segment.get('words', []):
            if word_info['end'] > clip_start and word_info['start'] < clip_end:
                captions.append({
                    "text": word_info.get('word', '').strip(),
                    "startMs": int((max(0, word_info['start'] - clip_start)) * 1000),
                    "endMs": int((max(0, word_info['end'] - clip_start)) * 1000),
                })

    duration_sec = clip_end - clip_start

    return {
        "captions": captions,
        "durationSec": duration_sec,
        "language": transcript.get('language', 'en'),
    }


class RegenTranscribeRequest(BaseModel):
    job_id: str
    clip_index: int
    input_filename: Optional[str] = None
    # If 'roman' or 'translate', additionally pass the result through the
    # LLM rewriter for an intelligent context-aware cleanup. 'auto' just
    # returns the raw Whisper transcript text.
    cleanup_mode: Optional[str] = "auto"
    target_language: Optional[str] = None


@app.post("/api/clip/regenerate-transcript")
async def regenerate_transcript(
    req: RegenTranscribeRequest,
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    """Phase-1 of the two-phase Regenerate flow.

    Re-runs Whisper on JUST this clip's audio (cheap) to get a fresh
    transcript, optionally pipes it through an LLM cleanup pass
    (Roman/Latin or translate), and returns the cleaned text — WITHOUT
    burning anything to video.

    The dashboard surfaces the result in an editable preview. The user
    can then edit it inline if they want, and click "Burn" to actually
    apply it via /api/subtitle. This way burning is the last resort and
    the user can iterate on transcript quality cheaply.
    """
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")

    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(404, "Metadata not found")
    with open(json_files[0], 'r') as f:
        data = json.load(f)
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(404, "Clip not found")
    clip_data = clips[req.clip_index]

    if req.input_filename:
        filename = os.path.basename(req.input_filename)
    else:
        filename = _clip_filename_from_url(clip_data.get('video_url', ''))
    input_path = os.path.join(output_dir, filename) if filename else None
    if not input_path or not os.path.exists(input_path):
        raise HTTPException(404, f"Video file not found for this clip")

    # Re-transcribe via main.py's transcribe_video. Slow but correct.
    from main import transcribe_video
    loop = asyncio.get_event_loop()
    fresh = await loop.run_in_executor(None, transcribe_video, input_path)
    if not fresh or not fresh.get("segments"):
        raise HTTPException(500, "Re-transcription returned no segments")

    cleanup_mode = (req.cleanup_mode or "auto").lower()
    cleaned = fresh
    # 'roman' / 'hinglish' / 'urglish' / 'translate' all run through the
    # same LLM rewrite path with different system prompts. 'hinglish' /
    # 'urglish' are code-switch-preserving variants of 'roman' — they
    # explicitly keep English words/phrases in English script while
    # transliterating Hindi or Urdu words into Roman/Latin.
    if cleanup_mode in ("roman", "hinglish", "urglish", "translate"):
        cleaned = _llm_rewrite_transcript(
            transcript=fresh,
            mode=cleanup_mode,
            target_language=req.target_language,
            provider_id=(x_llm_provider or "gemini").lower(),
            model_name=x_llm_model or "gemini-2.5-flash",
            api_key=x_llm_key or os.environ.get("GEMINI_API_KEY", ""),
            base_url=x_llm_base_url,
        )

    # Persist the regenerated transcript so /api/subtitle can use it on
    # burn instead of re-transcribing again. Stored at clip-level so it
    # doesn't disturb the job-level cached transcript.
    try:
        clips[req.clip_index]['regenerated_transcript'] = cleaned
        data['shorts'] = clips
        with open(json_files[0], 'w') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"⚠️  Failed to persist regenerated transcript: {e}")

    return {
        "ok": True,
        "language": cleaned.get("language", fresh.get("language", "")),
        "text": cleaned.get("text", ""),
        "segments": [
            {
                "text": (s.get("text") or "").strip(),
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
            }
            for s in (cleaned.get("segments") or [])
        ],
        "cleanup_mode": cleanup_mode,
    }


class SyncTranscriptRequest(BaseModel):
    job_id: str
    clip_index: int
    edited_text: str
    input_filename: Optional[str] = None


def _normalize_word_for_match(w: str) -> str:
    """Normalize a word for fuzzy matching across edits.

    Strips punctuation, lowercases, removes non-alphanumeric so that
    'P2P' matches 'p2p', 'wallet,' matches 'wallet'. Roman Urdu
    transliteration variants ('yeh' vs 'ye', 'hain' vs 'hai') won't
    perfectly match but difflib's similarity score will still find
    them as near-matches at the sequence level.
    """
    import re
    return re.sub(r'[^a-z0-9]', '', (w or '').lower())


def _align_words_to_whisper(edited_words: list, whisper_words: list) -> list:
    """Align user's edited word list against Whisper's word-timestamped
    list. Returns a list of (word, start_sec, end_sec) tuples — one per
    edited word.

    Strategy:
      1. Use difflib.SequenceMatcher to find longest matching subsequences
         between the two word lists (after normalization).
      2. Words that match Whisper directly inherit Whisper's timestamps.
      3. Unmatched gaps (user added or changed words) get linearly
         interpolated between the nearest matched neighbors.
      4. Leading / trailing unmatched runs extend from clip start / end.

    This is "poor man's forced alignment" — it gives accurate timings
    for the 80%+ of words that match Whisper exactly, and best-effort
    interpolation for the rest. Way better than even-spread-by-duration.
    """
    import difflib

    if not edited_words or not whisper_words:
        return []

    # Build normalized lists for matching, keep originals for output.
    edited_norm = [_normalize_word_for_match(w) for w in edited_words]
    whisper_norm = [_normalize_word_for_match(w["text"]) for w in whisper_words]

    matcher = difflib.SequenceMatcher(None, edited_norm, whisper_norm, autojunk=False)
    timings: list = [None] * len(edited_words)
    for block in matcher.get_matching_blocks():
        for i in range(block.size):
            ei = block.a + i
            wi = block.b + i
            if 0 <= ei < len(edited_words) and 0 <= wi < len(whisper_words):
                timings[ei] = (
                    float(whisper_words[wi]["start"]),
                    float(whisper_words[wi]["end"]),
                )

    # Interpolate the gaps. Find first and last matched index.
    first_match = next((i for i, t in enumerate(timings) if t is not None), None)
    last_match = next((i for i in range(len(timings) - 1, -1, -1) if timings[i] is not None), None)

    audio_start = float(whisper_words[0]["start"]) if whisper_words else 0.0
    audio_end = float(whisper_words[-1]["end"]) if whisper_words else 1.0

    if first_match is None:
        # No matches at all — fall back to even distribution across audio range.
        n = len(edited_words)
        per = (audio_end - audio_start) / max(1, n)
        return [(edited_words[i], audio_start + i * per, audio_start + (i + 1) * per) for i in range(n)]

    # Words BEFORE first match — interpolate from audio_start up to first match.
    if first_match > 0:
        first_t = timings[first_match][0]
        slot = (first_t - audio_start) / first_match
        for i in range(first_match):
            t = audio_start + i * slot
            timings[i] = (t, t + max(0.05, slot * 0.95))

    # Words AFTER last match — interpolate from last match end to audio_end.
    if last_match < len(timings) - 1:
        last_t = timings[last_match][1]
        n_after = len(timings) - 1 - last_match
        slot = max(0.05, (audio_end - last_t) / max(1, n_after))
        for i in range(last_match + 1, len(timings)):
            offset = i - last_match
            t = last_t + (offset - 1) * slot
            timings[i] = (t, t + slot * 0.95)

    # Words BETWEEN matches — interpolate inside each gap.
    i = first_match
    while i <= last_match:
        if timings[i] is None:
            # Find the next matched index.
            j = i + 1
            while j <= last_match and timings[j] is None:
                j += 1
            prev_end = timings[i - 1][1]
            next_start = timings[j][0]
            slots = j - i
            slot_dur = max(0.05, (next_start - prev_end) / slots)
            for k in range(slots):
                t = prev_end + k * slot_dur
                timings[i + k] = (t, t + slot_dur * 0.95)
            i = j
        else:
            i += 1

    return [
        (edited_words[i], float(timings[i][0]), float(timings[i][1]))
        for i in range(len(edited_words))
    ]


@app.post("/api/clip/sync-transcript")
async def sync_transcript(req: SyncTranscriptRequest):
    """Phase-3: word-level alignment of user's edited text to audio.

    What this REALLY does:
      1. Loads Whisper's word-level timestamps for this clip — preferring
         the regenerated_transcript saved during Step 1 (instant) over a
         fresh Whisper run (slow).
      2. Uses difflib sequence matching to align each user-edited word
         against the Whisper word that it most closely corresponds to.
      3. Words that match Whisper inherit Whisper's exact timestamps.
         Words the user added/changed get linearly interpolated from
         their neighbors.
      4. Re-groups the now-timed edited words back into segments using
         the original Whisper segment boundaries.
      5. Saves the result with `_word_timings_aligned: True` so the
         burn step uses per-WORD subtitle timing (real spoken alignment)
         instead of the fallback per-segment block display.

    Net effect: subtitles now light up the moment each word is actually
    spoken, regardless of how heavily the user edited the transcript.
    """
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(404, "Metadata not found")
    with open(json_files[0], 'r') as f:
        data = json.load(f)
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(404, "Clip not found")
    clip_data = clips[req.clip_index]

    edited_words = req.edited_text.strip().split()
    if not edited_words:
        raise HTTPException(400, "Edited text is empty")

    # ---- Step 1: get Whisper word-timestamped data ----
    # Fast path: if Step 1 (Regenerate) already ran, we have a saved
    # regenerated_transcript with word timestamps. Reuse it. Cuts sync
    # from minutes to seconds.
    saved = clip_data.get('regenerated_transcript')
    whisper_segments = []
    if saved and isinstance(saved, dict) and saved.get('segments'):
        # The saved regen has clip-local times. Use as-is.
        whisper_segments = saved['segments']
        print(f"⚡ Sync using saved regenerated_transcript ({len(whisper_segments)} segments)")
    else:
        # Fallback: run Whisper. Slow but correct.
        if req.input_filename:
            filename = os.path.basename(req.input_filename)
        else:
            filename = _clip_filename_from_url(clip_data.get('video_url', ''))
        input_path = os.path.join(output_dir, filename) if filename else None
        if not input_path or not os.path.exists(input_path):
            raise HTTPException(404, "Video file for this clip is missing")
        from main import transcribe_video
        loop = asyncio.get_event_loop()
        print("📼 Sync running fresh Whisper (no saved transcript)")
        fresh = await loop.run_in_executor(None, transcribe_video, input_path)
        whisper_segments = fresh.get("segments") if fresh else []
        if not whisper_segments:
            raise HTTPException(500, "Whisper returned no segments")

    # Flatten into a word list with timings.
    whisper_words = []
    for seg in whisper_segments:
        for w in seg.get('words', []) or []:
            text = (w.get('word') or '').strip()
            if not text:
                continue
            whisper_words.append({
                'text': text,
                'start': float(w.get('start', seg.get('start', 0))),
                'end': float(w.get('end', seg.get('end', 0))),
            })

    if not whisper_words:
        # If saved regen had segment-only timings (no words), fall back to
        # synthesizing word timings by spreading evenly inside each segment.
        for seg in whisper_segments:
            seg_text = (seg.get('text') or '').strip()
            seg_words = seg_text.split()
            if not seg_words:
                continue
            s_start = float(seg.get('start', 0))
            s_end = float(seg.get('end', s_start + 1))
            per = (s_end - s_start) / max(1, len(seg_words))
            for i, sw in enumerate(seg_words):
                whisper_words.append({
                    'text': sw,
                    'start': s_start + i * per,
                    'end': s_start + (i + 1) * per,
                })

    if not whisper_words:
        raise HTTPException(500, "No word timings available to sync against")

    # ---- Step 2: align user's edited words to Whisper's word timings ----
    aligned = _align_words_to_whisper(edited_words, whisper_words)
    if not aligned:
        raise HTTPException(500, "Alignment produced no output")

    # ---- Step 3: re-group aligned words into Whisper's segment boundaries ----
    synced_segments = []
    word_iter = iter(aligned)
    next_word = next(word_iter, None)
    for seg in whisper_segments:
        s_start = float(seg.get('start', 0))
        s_end = float(seg.get('end', s_start + 1))
        seg_words = []
        # Take all aligned words whose START falls inside this segment.
        while next_word is not None and next_word[1] < s_end:
            w_text, w_start, w_end = next_word
            seg_words.append({
                'word': w_text,
                'start': max(s_start, w_start),
                'end': min(s_end, w_end),
            })
            next_word = next(word_iter, None)
        if seg_words:
            synced_segments.append({
                'text': ' '.join(w['word'] for w in seg_words),
                'start': s_start,
                'end': s_end,
                'words': seg_words,
            })
    # Any tail words left over → tack onto the last segment.
    while next_word is not None:
        w_text, w_start, w_end = next_word
        if synced_segments:
            tail = synced_segments[-1]
            tail['words'].append({'word': w_text, 'start': w_start, 'end': w_end})
            tail['text'] += ' ' + w_text
            tail['end'] = max(tail['end'], w_end)
        next_word = next(word_iter, None)

    if not synced_segments:
        raise HTTPException(500, "Sync produced no segments")

    synced_transcript = {
        'language': (saved.get('language') if isinstance(saved, dict) else None) or '',
        'text': ' '.join(s['text'] for s in synced_segments),
        'segments': synced_segments,
        # Flag: the burn endpoint uses this to pick per-word SRT (with
        # accurate timings) over per-segment fallback.
        '_word_timings_aligned': True,
        '_already_clip_local': True,
    }

    # Persist so next Burn uses it directly.
    try:
        clips[req.clip_index]["regenerated_transcript"] = synced_transcript
        data["shorts"] = clips
        with open(json_files[0], "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"⚠️  Failed to persist synced transcript: {e}")

    return {
        "ok": True,
        "language": synced_transcript["language"],
        "text": synced_transcript["text"],
        "segments": [
            {"text": s["text"], "start": s["start"], "end": s["end"]}
            for s in synced_segments
        ],
        "segment_count": len(synced_segments),
        "alignment_method": "difflib+interpolate",
    }


# ---------- Bring-Your-Own-Lyrics alignment ----------
#
# Whisper struggles with songs in code-switched languages. The user can
# bypass that failure mode by pasting the OFFICIAL lyrics — we then
# treat those as ground truth, and use Whisper purely as a timing oracle
# (forced alignment via difflib, the same trick /sync-transcript uses).
#
# This unlocks two things:
#   1. The translate path stops translating Whisper hallucinations and
#      starts translating the real lyrics.
#   2. Chorus repetition is preserved verbatim in the user's input, so
#      the LLM produces the same translation for each repeat.
#
# Why not Whisper-only? Songs cause Whisper to invent phrases (the
# "Yield Farming → young farmers in the fields" class of bug). Pasting
# the ground truth removes that entire failure mode.

class LyricsAlignRequest(BaseModel):
    # Raw multi-line lyrics as the user pasted them. May include
    # bracketed structure tags ([Intro], [Verse 1], [Chorus],
    # [Female Vocals], [Spoken Word]) — we strip them by default.
    lyrics: str
    # Set True to KEEP [Verse]/[Chorus]/[Bridge] structure tags as
    # standalone lines in the output (and burn them as on-screen
    # subtitles). Default is False — most users want clean lyric lines
    # with the tags hidden.
    keep_structure_tags: bool = False
    input_filename: Optional[str] = None


def _parse_user_lyrics(raw: str, keep_structure_tags: bool = False) -> list[str]:
    """Turn pasted lyrics into a list of clean subtitle-ready lines.

    Drops:
      • Empty / whitespace-only lines.
      • Bracketed structure tags by default ([Intro], [Verse 1], [Chorus],
        [Bridge 2], [Female Vocals], [Spoken Word], [Instrumental], etc.) —
        these are metadata, not lyrics. Pass keep_structure_tags=True
        to retain them as their own subtitle line (rare).

    Keeps:
      • Multi-word lines exactly as written. We deliberately do NOT
        split on punctuation — songs use ellipses and em-dashes that
        belong on a single subtitle line.
    """
    if not raw:
        return []
    out = []
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Detect "structure tag" lines — bracketed metadata.
        if line.startswith('[') and line.endswith(']'):
            if keep_structure_tags:
                out.append(line)
            continue
        out.append(line)
    return out


@app.post("/api/clip/{job_id}/{clip_index}/lyrics-align")
async def lyrics_align(job_id: str, clip_index: int, req: LyricsAlignRequest):
    """Align user-pasted lyrics to the clip's audio using Whisper word
    timestamps as anchors. Saves the aligned text as the clip's
    `regenerated_transcript` so the subtitle burn path (and the
    translate path within it) reads ground truth instead of Whisper
    output.

    Failure modes & guards:
      • No lyrics or only structure tags  → 400.
      • Job/clip not found                → 404.
      • Whisper transcript missing word
        timings                            → fall back to per-segment
                                             even-distribution so the
                                             feature still works on
                                             older jobs.
    """
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    record = jobs[job_id]

    # Locate metadata.json so we can persist back to disk (same
    # pattern as /api/clip/regenerate-transcript and sync-transcript).
    output_dir = record.get('output_dir') or os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(404, "Metadata not found")
    with open(json_files[0], 'r') as f:
        data = json.load(f)
    clips = data.get('shorts') or []
    if not (0 <= clip_index < len(clips)):
        raise HTTPException(404, "Clip index out of range")
    clip = clips[clip_index]

    lyric_lines = _parse_user_lyrics(req.lyrics, keep_structure_tags=req.keep_structure_tags)
    if not lyric_lines:
        raise HTTPException(400, "No lyric lines parsed from input")

    # Flatten lyrics into words while remembering which line each
    # word belongs to — we need this both for forced alignment AND
    # for re-grouping back into LINES (the natural display unit).
    flat_words: list[str] = []
    word_to_line: list[int] = []
    for line_idx, line in enumerate(lyric_lines):
        for w in line.split():
            flat_words.append(w)
            word_to_line.append(line_idx)
    if not flat_words:
        raise HTTPException(400, "Lyrics had no words")

    # Build the Whisper word-timing pool from the saved transcript.
    # Prefer any earlier regenerated_transcript (it's already clip-local);
    # fall back to the job-level transcript sliced to this clip's range.
    saved = clip.get('regenerated_transcript')
    is_local = bool(saved and isinstance(saved, dict) and saved.get('_already_clip_local'))
    whisper_segments: list = []
    clip_start = float(clip.get('start', 0))
    clip_end = float(clip.get('end', 0))
    if is_local:
        whisper_segments = list(saved.get('segments') or [])
    else:
        full_tr = data.get('transcript') or {}
        # Slice job-level segments down to this clip's [start, end] window
        # AND shift to clip-local time (start at 0).
        for s in (full_tr.get('segments') or []):
            s_start = float(s.get('start', 0))
            s_end = float(s.get('end', 0))
            if s_end < clip_start or s_start > clip_end:
                continue
            new_seg = dict(s)
            new_seg['start'] = max(0.0, s_start - clip_start)
            new_seg['end'] = max(new_seg['start'] + 0.01, s_end - clip_start)
            # Shift word timings too, so the alignment pool is also
            # clip-local. Skip words that fall entirely outside the clip.
            new_words = []
            for w in (s.get('words') or []):
                w_start = float(w.get('start', s_start))
                w_end = float(w.get('end', s_end))
                if w_end < clip_start or w_start > clip_end:
                    continue
                new_words.append({
                    'word': w.get('word', ''),
                    'start': max(0.0, w_start - clip_start),
                    'end': max(0.01, w_end - clip_start),
                })
            new_seg['words'] = new_words
            whisper_segments.append(new_seg)

    # Flatten word timings the same way sync-transcript does, with the
    # same fall-through to per-segment synthesis when a job has only
    # segment-level timings (older Whisper runs).
    whisper_words: list = []
    for seg in whisper_segments:
        for w in (seg.get('words') or []):
            text = (w.get('word') or '').strip()
            if not text:
                continue
            whisper_words.append({
                'text': text,
                'start': float(w.get('start', seg.get('start', 0))),
                'end': float(w.get('end', seg.get('end', 0))),
            })
    if not whisper_words:
        for seg in whisper_segments:
            seg_text = (seg.get('text') or '').strip()
            seg_words = seg_text.split()
            if not seg_words:
                continue
            s_start = float(seg.get('start', 0))
            s_end = float(seg.get('end', s_start + 1))
            per = (s_end - s_start) / max(1, len(seg_words))
            for i, sw in enumerate(seg_words):
                whisper_words.append({
                    'text': sw,
                    'start': s_start + i * per,
                    'end': s_start + (i + 1) * per,
                })

    # If we still have nothing — Whisper produced an empty transcript
    # for this clip, often happens with mostly-instrumental songs —
    # fall back to PURE EVEN-DISTRIBUTION across the clip duration so
    # the feature still works. The user gets approximate timing rather
    # than an error.
    if not whisper_words:
        clip_dur = max(0.1, clip_end - clip_start)
        per = clip_dur / len(flat_words)
        word_timings = [
            (flat_words[i], i * per, (i + 1) * per)
            for i in range(len(flat_words))
        ]
        alignment_method = 'even-distribute (no Whisper words)'
    else:
        # Forced alignment via difflib (poor man's, but works well at
        # 60-90% match rate for songs where Whisper got the rough
        # phonemes right). Reuses the same helper /sync-transcript uses.
        word_timings = _align_words_to_whisper(flat_words, whisper_words)
        if not word_timings:
            raise HTTPException(500, "Lyric alignment produced no output")
        alignment_method = 'difflib+interpolate'

    # Re-group aligned words back into LINES (one segment per lyric line).
    # Lines are the natural display unit for lyrics — using Whisper's
    # segment boundaries instead would split lines awkwardly mid-rhyme.
    line_word_groups: list[list] = [[] for _ in lyric_lines]
    for (word_text, w_start, w_end), line_idx in zip(word_timings, word_to_line):
        line_word_groups[line_idx].append({
            'word': word_text,
            'start': float(w_start),
            'end': float(w_end),
        })

    new_segments = []
    for line_idx, line_words in enumerate(line_word_groups):
        if not line_words:
            continue
        line_start = min(w['start'] for w in line_words)
        line_end = max(w['end'] for w in line_words)
        new_segments.append({
            'text': lyric_lines[line_idx],
            'start': line_start,
            'end': line_end,
            'words': line_words,
        })

    if not new_segments:
        raise HTTPException(500, "Aligned segments came out empty")

    aligned_transcript = {
        'language': 'mixed',
        'text': '\n'.join(s['text'] for s in new_segments),
        'segments': new_segments,
        # Markers the /api/subtitle endpoint reads:
        #   _user_lyrics              → translate prompt switches to song-mode
        #                               (ground-truth source, chorus respect,
        #                               crypto glossary).
        #   _word_timings_aligned     → SRT generator uses per-word timing,
        #                               not per-segment, so karaoke
        #                               animations sync to the ball.
        #   _already_clip_local       → start/end are 0..clip_dur, don't
        #                               re-shift them.
        '_user_lyrics': True,
        '_word_timings_aligned': True,
        '_already_clip_local': True,
    }

    # Persist so subsequent burns reuse this without realigning.
    try:
        clips[clip_index]['regenerated_transcript'] = aligned_transcript
        # Burn time will read this and skip the "stale captions" banner.
        if 'subtitles_invalidated_at' in clips[clip_index]:
            clips[clip_index]['subtitles_invalidated_at'] = None
        data['shorts'] = clips
        with open(json_files[0], 'w') as f:
            json.dump(data, f, indent=2)
        # Mirror to in-memory job so refresh-free flows pick it up.
        mem_clips = (record.get('result') or {}).get('clips') or []
        if 0 <= clip_index < len(mem_clips):
            mem_clips[clip_index]['regenerated_transcript'] = aligned_transcript
            mem_clips[clip_index]['subtitles_invalidated_at'] = None
    except Exception as e:
        print(f"⚠️  Failed to persist aligned lyrics: {e}")

    return {
        'ok': True,
        'lines_count': len(new_segments),
        'words_count': sum(len(s['words']) for s in new_segments),
        'whisper_words_used': len(whisper_words),
        'alignment_method': alignment_method,
        'segments': [
            {'text': s['text'], 'start': s['start'], 'end': s['end']}
            for s in new_segments
        ],
    }


# =====================================================================
# Standalone features — full-video Dub and full-video Subtitle.
#
# These are NOT clip-generation jobs; the user uploads a single video
# and wants the WHOLE thing dubbed or subtitled, no viral clipping.
#
# Pipeline shape mirrors clip-gen:
#   Stage 1 — transcribe (Whisper Turbo by default, ElevenLabs Scribe
#             when the user has supplied an ElevenLabs key).
#   Stage 2 — LLM cleanup with full-clip context (Roman script /
#             translation / proofreading depending on feature).
#   Stage 3 — render (burn subs to ASS+FFmpeg / dub via Edge TTS or
#             ElevenLabs voice cloning).
# =====================================================================


def _standalone_meta_path(job_id: str) -> str:
    """Where the on-disk metadata for a standalone job lives — one
    JSON file per job, alongside its output mp4 / srt files."""
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    return os.path.join(job_dir, "_standalone_meta.json")


def _split_long_segments(segments, max_chars: int = 38, max_duration: float = 3.0):
    """Split Whisper segments whose text or duration exceeds caption
    limits into multiple shorter sequential segments.

    Why this lives here: Whisper returns segments that can be 5–10
    seconds long with 100+ characters of text — fine for an SRT, but
    awful as a captioning unit on a 9:16 phone screen (3+ lines) AND
    awful in our Timed editor where each row is supposed to be one
    line. Splitting at the segment boundary level (instead of just
    wrapping at burn time) means the EDITOR ROWS, the BURN OUTPUT,
    and the SRT EXPORT all agree on "1 line per caption" — same UX
    everywhere.

    Time is allocated proportional to the character count of each
    chunk so reading pace stays even within the original segment's
    duration. Word-level `words` arrays are dropped from split
    segments because the original word timestamps no longer match
    the new segment boundaries — Sync will re-derive them.
    """
    if not segments:
        return []
    out = []
    for seg in segments:
        text = (seg.get('text') or '').strip()
        try:
            start = float(seg.get('start', 0))
            end = float(seg.get('end', 0))
        except (TypeError, ValueError):
            out.append(seg)
            continue
        duration = max(0.05, end - start)
        if not text:
            out.append(seg)
            continue
        if len(text) <= max_chars and duration <= max_duration:
            out.append(seg)
            continue
        # Greedy chunk on word boundaries.
        words = text.split()
        chunks = []
        cur = ''
        for w in words:
            if not cur:
                cur = w
                continue
            if len(cur) + 1 + len(w) <= max_chars:
                cur += ' ' + w
            else:
                chunks.append(cur)
                cur = w
        if cur:
            chunks.append(cur)
        # Distribute time proportional to chunk char count so faster
        # phrases stay quick and slower phrases linger.
        total_chars = sum(len(c) for c in chunks) or 1
        cursor = start
        for i, chunk in enumerate(chunks):
            portion = len(chunk) / total_chars
            seg_end = end if i == len(chunks) - 1 else cursor + duration * portion
            new_seg = dict(seg)
            new_seg['text'] = chunk
            new_seg['start'] = cursor
            new_seg['end'] = seg_end
            new_seg.pop('words', None)
            out.append(new_seg)
            cursor = seg_end
    return out


def _standalone_save_blob(job_id: str, name: str, data) -> None:
    """Save an arbitrary JSON blob next to the job's metadata. Used to
    checkpoint intermediate stage outputs (raw transcript, translated
    text, etc.) so we can RESUME an interrupted pipeline from the
    last completed stage instead of starting over.

    Files live under output/standalone_<id>/<name>.json. Naming is
    by-stage so each rehydrate / resume call can detect which stages
    have completed by checking which files exist.
    """
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    try:
        os.makedirs(job_dir, exist_ok=True)
        path = os.path.join(job_dir, f"{name}.json")
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"⚠️  Could not save blob '{name}' for {job_id}: {e}")


def _standalone_load_blob(job_id: str, name: str):
    """Read back a blob saved by _standalone_save_blob. Returns None if
    the file is missing or unreadable — callers treat that as "this
    stage hasn't completed yet, run it now"."""
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    path = os.path.join(job_dir, f"{name}.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return None


def _standalone_persist(job_id: str) -> None:
    """Snapshot the current in-memory job record to disk. Called on
    every status update so a backend restart never loses progress.

    We persist a curated subset (status, kind, logs, result, timestamps,
    options). Heavy intermediate state (raw transcript, translated text)
    is saved separately via _standalone_save_blob so the resume
    endpoint can pick up from the last completed stage.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        return
    snapshot = {
        "job_id": job_id,
        "kind": rec.get("kind"),
        "status": rec.get("status"),
        "logs": rec.get("logs", [])[-30:],  # cap log size
        "result": rec.get("result"),
        "created_at": rec.get("created_at"),
        "updated_at": time.time(),
        "title": rec.get("title"),  # human label, set when job starts
        # input_path is the path of the original source video on disk —
        # required by the /api/standalone/{id}/source-video endpoint
        # that the homepage uses to play the original alongside the
        # output. Without persisting it, every backend restart drops
        # the link and the homepage source tile goes blank.
        "input_path": rec.get("input_path"),
        "draft_styling": rec.get("draft_styling"),
    }
    try:
        path = _standalone_meta_path(job_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(snapshot, f, indent=2)
    except Exception as e:
        print(f"⚠️  Could not persist standalone meta for {job_id}: {e}")


def _standalone_status(job_id: str, status: str, msg: str = "", **extra):
    """Update an entry in the standalone_jobs registry AND persist to
    disk. Safe to call from background threads."""
    rec = standalone_jobs.setdefault(job_id, {"status": "queued", "logs": []})
    rec["status"] = status
    if msg:
        rec.setdefault("logs", []).append(msg)
    for k, v in extra.items():
        rec[k] = v
    _standalone_persist(job_id)


def _rehydrate_one_standalone(job_id: str) -> bool:
    """Reconstruct ONE standalone_jobs entry from disk on demand.

    Used by /save and /burn (and any other endpoint that does
    `standalone_jobs.get(job_id)`) when the in-memory dict is empty
    after a backend restart that hasn't yet run the bulk
    rehydrate_standalone_jobs() pass — or for any reason a job
    persisted to disk isn't in memory. Returns True if the job was
    found on disk and inserted into the in-memory dict; False
    otherwise.

    This is what stops the "burn 404'd silently and an old subtitled
    mp4 was the only output available" failure mode. With this in
    place, the burn endpoint can ALWAYS find the job as long as the
    standalone_<job_id> folder still exists on disk.
    """
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    if not os.path.isdir(job_dir):
        return False
    meta_path = os.path.join(job_dir, "_standalone_meta.json")
    if not os.path.isfile(meta_path):
        return False
    try:
        with open(meta_path, "r") as f:
            meta = json.load(f)
    except Exception:
        return False
    rec = {
        "kind": meta.get("kind"),
        "status": meta.get("status") or "completed",
        "logs": meta.get("logs", []),
        "result": meta.get("result"),
        "output_dir": job_dir,
        "created_at": meta.get("created_at"),
        "title": meta.get("title"),
        "input_path": meta.get("input_path"),
        "draft_styling": meta.get("draft_styling"),
    }
    cleaned = _standalone_load_blob(job_id, "cleaned_transcript")
    if cleaned:
        rec["transcript"] = cleaned
    else:
        legacy_result = meta.get("result") or {}
        legacy_segments = legacy_result.get("segments") or []
        if legacy_segments:
            rec["transcript"] = {
                "segments": [
                    {
                        "text": (s.get("text") or "").strip(),
                        "start": float(s.get("start", 0)),
                        "end": float(s.get("end", 0)),
                    }
                    for s in legacy_segments
                ],
                "text": legacy_result.get("transcript_text", ""),
                "language": legacy_result.get("language", ""),
            }
    whisper_original = _standalone_load_blob(job_id, "whisper_original")
    if whisper_original:
        rec["whisper_original"] = whisper_original
    cleanup_opts = _standalone_load_blob(job_id, "cleanup_opts")
    if cleanup_opts:
        rec["cleanup_opts"] = cleanup_opts
    translated = _standalone_load_blob(job_id, "translated_text")
    if translated and translated.get("text"):
        rec["translated_text"] = translated["text"]
    dub_opts = _standalone_load_blob(job_id, "dub_opts")
    if dub_opts:
        rec["dub_opts"] = dub_opts
    standalone_jobs[job_id] = rec
    print(f"♻️  On-demand rehydrate: standalone job {job_id} reloaded from disk")
    return True


def rehydrate_standalone_jobs():
    """Restore standalone_jobs from disk on startup so Past Projects
    inside Subtitle / Dub survive a backend restart. Mirrors the
    rehydrate_jobs_from_disk pattern but keyed on `_standalone_meta.json`
    files inside `standalone_*` folders.
    """
    if not os.path.isdir(OUTPUT_DIR):
        return 0
    restored = 0
    for entry in os.listdir(OUTPUT_DIR):
        if not entry.startswith("standalone_"):
            continue
        job_dir = os.path.join(OUTPUT_DIR, entry)
        if not os.path.isdir(job_dir):
            continue
        job_id = entry[len("standalone_"):]
        if job_id in standalone_jobs:
            continue
        meta_path = os.path.join(job_dir, "_standalone_meta.json")
        if not os.path.isfile(meta_path):
            continue
        try:
            with open(meta_path, "r") as f:
                meta = json.load(f)
        except Exception:
            continue
        rec = {
            "kind": meta.get("kind"),
            "status": meta.get("status") or "completed",
            "logs": meta.get("logs", []),
            "result": meta.get("result"),
            "output_dir": job_dir,
            "created_at": meta.get("created_at"),
            "title": meta.get("title"),
            # Restore input_path and draft_styling from the meta so the
            # source-video endpoint and the resume-draft flow work after
            # a backend restart. Old metas (written before these fields
            # were persisted) just get None and degrade gracefully.
            "input_path": meta.get("input_path"),
            "draft_styling": meta.get("draft_styling"),
        }
        # Load checkpoint blobs so resume can pick up where the last
        # run left off. Each blob is independent — missing blobs are
        # treated as "this stage hasn't completed yet".
        whisper_original = _standalone_load_blob(job_id, "whisper_original")
        if whisper_original:
            rec["whisper_original"] = whisper_original
        cleanup_opts = _standalone_load_blob(job_id, "cleanup_opts")
        if cleanup_opts:
            rec["cleanup_opts"] = cleanup_opts
        cleaned = _standalone_load_blob(job_id, "cleaned_transcript")
        if cleaned:
            rec["transcript"] = cleaned
        else:
            # Fallback for legacy jobs that landed in transcript_ready
            # before the checkpoint blobs existed — reconstruct from
            # the segments persisted inside _standalone_meta.json so
            # Burn / Save Draft don't dead-end.
            legacy_result = meta.get("result") or {}
            legacy_segments = legacy_result.get("segments") or []
            if legacy_segments:
                rec["transcript"] = {
                    "segments": [
                        {
                            "text": (s.get("text") or "").strip(),
                            "start": float(s.get("start", 0)),
                            "end": float(s.get("end", 0)),
                        }
                        for s in legacy_segments
                    ],
                    "text": legacy_result.get("transcript_text", ""),
                    "language": legacy_result.get("language", ""),
                }
        translated = _standalone_load_blob(job_id, "translated_text")
        if translated and translated.get("text"):
            rec["translated_text"] = translated["text"]
        dub_opts = _standalone_load_blob(job_id, "dub_opts")
        if dub_opts:
            rec["dub_opts"] = dub_opts
        # If the backend was killed mid-pipeline (status was running
        # when we shut down), mark the job as 'interrupted' so the
        # frontend can offer a Resume button instead of treating it
        # as a normal completed/failed job.
        running_states = {"queued", "transcribing", "cleaning", "translating", "rendering"}
        if rec["status"] in running_states:
            rec["status"] = "interrupted"
            rec.setdefault("logs", []).append(
                "Backend restarted while this job was running — click Resume to continue from the last checkpoint."
            )
        standalone_jobs[job_id] = rec
        # Re-persist with the corrected status so /past_projects shows
        # the right label without waiting for a status update.
        if rec["status"] == "interrupted":
            _standalone_persist(job_id)
        restored += 1
    print(f"♻️  Rehydrated {restored} standalone job(s)")
    return restored


def _crop_to_orientation(input_path: str, output_path: str,
                         orientation: str,
                         x_offset_pct: float = 50.0,
                         y_offset_pct: float = 50.0) -> str:
    """Crop a video to a target orientation (vertical 9:16 or horizontal
    16:9), with manual horizontal/vertical positioning of the crop
    window via offset percentages.

    Behavior:
      • orientation='vertical'  → target aspect 9/16
      • orientation='horizontal' → target aspect 16/9
      • orientation='original' or anything else → no-op, returns input_path

    When the source's aspect already matches the target (within 1%),
    we return the input path unchanged — no re-encoding.

    x_offset_pct: 0 = far left, 50 = centre, 100 = far right. Used when
                  the source is wider than the target (crops horizontally).
    y_offset_pct: same scale, vertical axis. Used when the source is
                  taller than the target.

    Returns the path of the file that should be fed to the next stage —
    either the new cropped file, or the original input if no crop was
    needed.
    """
    if not orientation or orientation == 'original':
        return input_path
    if orientation not in ('vertical', 'horizontal'):
        return input_path

    # Probe the source dimensions.
    try:
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
             input_path],
            capture_output=True, text=True, check=True,
        )
        w_str, h_str = probe.stdout.strip().split(',')[:2]
        iw, ih = int(w_str), int(h_str)
    except Exception as e:
        print(f"⚠️  Could not probe video for crop: {e} — skipping crop.")
        return input_path

    src_aspect = iw / max(1, ih)
    target_aspect = 9 / 16 if orientation == 'vertical' else 16 / 9

    # Already matches the target — no work needed.
    if abs(src_aspect - target_aspect) < 0.01:
        return input_path

    if src_aspect > target_aspect:
        # Source is wider than target — crop horizontally, keep full
        # height. Width = ih * target_aspect (rounded to even).
        crop_h = ih
        crop_w = int(ih * target_aspect)
        crop_w -= crop_w % 2
        x = int((iw - crop_w) * max(0.0, min(100.0, x_offset_pct)) / 100.0)
        y = 0
    else:
        # Source is taller than target — crop vertically, keep full
        # width. Height = iw / target_aspect (rounded to even).
        crop_w = iw
        crop_h = int(iw / target_aspect)
        crop_h -= crop_h % 2
        x = 0
        y = int((ih - crop_h) * max(0.0, min(100.0, y_offset_pct)) / 100.0)

    cmd = [
        'ffmpeg', '-y', '-i', input_path,
        '-vf', f'crop={crop_w}:{crop_h}:{x}:{y}',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        # Preserve audio bit-for-bit; the crop only changes video frames.
        '-c:a', 'copy',
        output_path,
    ]
    print(f"🎞️  Cropping to {orientation}: {iw}x{ih} → {crop_w}x{crop_h} @ ({x},{y})")
    cmd_bytes = [a.encode('utf-8') if isinstance(a, str) else a for a in cmd]
    result = subprocess.run(cmd_bytes, capture_output=True)
    if result.returncode != 0:
        err = result.stderr.decode('utf-8', errors='replace')[-800:]
        print(f"⚠️  Crop failed, returning original: {err}")
        return input_path
    return output_path


def _save_upload_dedup(file: UploadFile, job_id: str, hash_chars: int = 16) -> str:
    """Persist an uploaded video to UPLOAD_DIR using CONTENT-ADDRESSED
    storage. The final filename is `{sha256[:hash_chars]}_{safe_name}` —
    so re-uploading the same file 35 times still only produces ONE copy
    on disk. Per-job association is tracked via a tiny `.{job_id}.link`
    sidecar that points at the canonical path.

    Why this matters: dev iterations and impatient users re-upload the
    same source repeatedly. Without dedup each upload was a 400 MB
    write and a 400 MB ongoing storage cost. With dedup the second and
    later uploads are no-cost on the disk side.

    Streaming is preserved: we hash and check the size limit while the
    bytes flow in, so an oversize upload still fails fast without
    writing the full payload.
    """
    import hashlib
    safe_name = _safe_filename(file.filename or 'upload.mp4')
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    # Write to a temp file FIRST (we don't know the hash until we've
    # streamed the whole content). Once finalised we either rename to
    # the canonical name or delete if a duplicate already exists.
    tmp_path = os.path.join(UPLOAD_DIR, f".tmp_{job_id}_{safe_name}")
    sha = hashlib.sha256()
    size = 0
    limit_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    try:
        with open(tmp_path, "wb") as f:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit_bytes:
                    f.close()
                    try: os.remove(tmp_path)
                    except OSError: pass
                    raise HTTPException(413, f"File too large. Max {MAX_FILE_SIZE_MB} MB")
                sha.update(chunk)
                f.write(chunk)
        digest = sha.hexdigest()[:hash_chars]
        canonical = os.path.join(UPLOAD_DIR, f"{digest}_{safe_name}")
        if os.path.exists(canonical):
            # Same content already on disk from a previous upload —
            # discard the temp copy and reuse the existing file.
            try: os.remove(tmp_path)
            except OSError: pass
            print(f"♻️  Upload dedup hit: reusing {os.path.basename(canonical)} (saved {size / 1024 / 1024:.1f} MB)")
        else:
            # First time we've seen this content — promote the temp
            # file to its canonical name. Atomic rename within the
            # same directory.
            os.rename(tmp_path, canonical)
            print(f"💾 Upload stored: {os.path.basename(canonical)} ({size / 1024 / 1024:.1f} MB)")
    except HTTPException:
        raise
    except Exception:
        try: os.remove(tmp_path)
        except OSError: pass
        raise

    # Sidecar that lets _find_standalone_source_video still resolve a
    # source by job_id — without this we'd have to keep the per-job
    # mapping ONLY in memory, which loses across container restarts
    # for jobs that were created before _standalone_persist's
    # input_path persistence shipped.
    try:
        link_path = os.path.join(UPLOAD_DIR, f".{job_id}.link")
        with open(link_path, "w") as lf:
            lf.write(canonical)
    except OSError:
        pass

    return canonical


# Kept under the old name for any caller that still imports it. New
# code should use _save_upload_dedup directly.
def _standalone_save_upload(file: UploadFile, job_id: str) -> str:
    return _save_upload_dedup(file, job_id)


# ---------- Standalone Subtitle (two-phase wizard) ----------
#
# Phase 1: /api/standalone/subtitle/transcribe
#   User uploads video + picks transcription engine + picks AI cleanup
#   mode (Original / Roman / Translate). Backend transcribes, runs the
#   LLM context-aware cleanup, returns the resulting transcript text
#   for the user to PREVIEW and optionally hand-edit.
#
# Phase 2: /api/standalone/subtitle/burn
#   User has reviewed the transcript and dialled in subtitle styling.
#   Backend takes the saved transcript + new style options + the user's
#   text edits, generates an SRT, and burns it into the whole video.
#
# Both phases share a single job_id so the frontend polls one status
# endpoint and the transcript is reused without re-transcribing.

@app.post("/api/standalone/subtitle/transcribe")
async def standalone_subtitle_transcribe(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    target_language: Optional[str] = Form(None),
    script_mode: Optional[str] = Form("auto"),       # 'auto' | 'roman' | 'translate'
    transcribe_provider: Optional[str] = Form("whisper"),
    source_language: Optional[str] = Form(""),
    # Bring-Your-Own-Lyrics: if the user already knows what was sung
    # (officially-published lyrics, podcast script, voice memo notes),
    # they can paste it here. Whisper still runs (we need its word-
    # level timings as alignment anchors), but the resulting transcript
    # text comes from THIS field, not Whisper. The LLM cleanup step is
    # SKIPPED in this mode — the user's text is ground truth and
    # doesn't need to be "fixed". Translate flows downstream see
    # _user_lyrics=True and switch to song-mode prompt automatically.
    lyrics: Optional[str] = Form(None),
    lyrics_keep_tags: Optional[bool] = Form(False),
):
    """Phase 1 — transcribe + AI cleanup. Accepts EITHER an uploaded
    file OR a URL (yt-dlp downloads it server-side). Returns job_id;
    result text appears in the status endpoint when the background
    task finishes.

    BYOL mode: pass `lyrics` to skip Whisper's word output and use
    your text as the transcript. Whisper still runs (for timings).
    """
    if not file and not (url and url.strip()):
        raise HTTPException(400, "Provide either a video file or a URL.")
    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None
    x_eleven_key = request.headers.get("X-ElevenLabs-Key") or ""

    job_id = str(uuid.uuid4())
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    os.makedirs(job_dir, exist_ok=True)
    # Default title — refined below depending on whether the source is
    # a file upload or a URL download.
    if file:
        default_title = file.filename or "Untitled subtitle job"
    else:
        default_title = (url or "URL subtitle job").strip()[:120]
    standalone_jobs[job_id] = {
        "status": "queued",
        "kind": "subtitle",
        "logs": ["Phase 1 queued."],
        "output_dir": job_dir,
        "result": None,
        "transcript": None,
        "input_path": None,
        "created_at": time.time(),
        "title": default_title,
    }
    if file:
        input_path = _standalone_save_upload(file, job_id)
        standalone_jobs[job_id]["input_path"] = input_path
    else:
        # URL ingest. We download SYNCHRONOUSLY here (not inside the
        # background task) so the user gets immediate feedback if the
        # URL is bad, instead of a polling loop that ends in a cryptic
        # status='failed'. Saves to UPLOAD_DIR so it survives across
        # restarts and rehydrates.
        try:
            from main import download_url_video
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            input_path, fetched_title = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: download_url_video(url.strip(), UPLOAD_DIR),
            )
            # Replace the placeholder title with the real video title
            # so it shows up nicely in Past Projects.
            if fetched_title:
                standalone_jobs[job_id]["title"] = fetched_title
            standalone_jobs[job_id]["input_path"] = input_path
        except Exception as e:
            # Tear down the half-created job so it doesn't leak into
            # Past Projects as a permanent failure.
            standalone_jobs.pop(job_id, None)
            try:
                shutil.rmtree(job_dir, ignore_errors=True)
            except Exception:
                pass
            raise HTTPException(400, str(e))
    _standalone_persist(job_id)

    async def run():
        try:
            _standalone_status(job_id, "transcribing", "Stage 1: transcribing audio…")
            os.environ["OPENSHORTS_TRANSCRIBE_PROVIDER"] = transcribe_provider or "whisper"
            os.environ["OPENSHORTS_TRANSCRIPT_LANG"] = source_language or ""
            if x_eleven_key:
                os.environ["OPENSHORTS_ELEVENLABS_KEY"] = x_eleven_key
            from main import transcribe_video
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_video, input_path)
            if not transcript or not transcript.get("segments"):
                raise RuntimeError("No segments returned from transcription.")

            # Save the RAW Whisper output (with word-level timestamps and
            # original wording) BEFORE the LLM cleanup overwrites it. This
            # lets the user later:
            #   • Regenerate — re-run the AI cleanup from a known-good baseline
            #     instead of compounding edits on edits.
            #   • Sync — align their edited text against real word timings.
            #   • Resume — if cleanup or any later stage fails (LLM
            #     timeout from a connection drop, container restart),
            #     pick back up from this checkpoint instead of
            #     re-transcribing the whole video.
            standalone_jobs[job_id]["whisper_original"] = transcript
            _standalone_save_blob(job_id, "whisper_original", transcript)
            # Remember the Phase-1 cleanup choices so a later /regenerate
            # or /resume call can default to the same mode/target.
            cleanup_opts = {
                "script_mode": (script_mode or "auto"),
                "target_language": target_language or "",
                "transcribe_provider": transcribe_provider or "whisper",
                "source_language": source_language or "",
            }
            standalone_jobs[job_id]["cleanup_opts"] = cleanup_opts
            _standalone_save_blob(job_id, "cleanup_opts", cleanup_opts)

            # BYOL fast path. If the user provided ground-truth lyrics
            # at upload time, skip the LLM cleanup entirely and run
            # forced alignment of their text against Whisper's word
            # timings. This is the song workflow: Whisper hears the
            # vocals approximately, the user types out exactly what
            # was sung, we keep Whisper's timing skeleton + the user's
            # words, and the result is subtitle-perfect.
            byol_lyrics = (lyrics or "").strip()
            if byol_lyrics:
                _standalone_status(job_id, "cleaning", "Stage 2: aligning your lyrics to the audio…")
                lyric_lines = _parse_user_lyrics(byol_lyrics, keep_structure_tags=bool(lyrics_keep_tags))
                if not lyric_lines:
                    raise RuntimeError("BYOL lyrics had no usable lines after parsing")
                # PROPORTIONAL DISTRIBUTION (NOT difflib) — songs and
                # poetry are the BYOL use case, and difflib word-matching
                # produces unstable alignments for them: repeated chorus
                # lines match Whisper anchors inconsistently, instrumental
                # sections create huge gaps that interpolation overshoots,
                # and the result is a subtitle that "freezes" at one line
                # for 30+ seconds while the audio plays past it (the
                # player's currentTime is past that segment's clamped
                # end, but the next segment's start is way later).
                #
                # Proportional distribution avoids all that. It's the
                # algorithm commercial lyric-video tools use because:
                #   • It's MONOTONIC by construction — line N+1 always
                #     starts when line N ends, so the player can never
                #     get into a "no active segment" dead zone.
                #   • It scales gracefully across any line/duration ratio.
                #   • It's character-weighted so longer lines get more
                #     screen time than short ones (e.g. "Boom and bust,"
                #     gets less time than the verse that follows).
                #
                # Whisper word timings could STILL improve word-level
                # accuracy, but only when the user's lyrics line count
                # matches Whisper's segment count exactly — and even
                # then only when the songs has clean speech (which
                # defeats the whole reason BYOL exists). So we just
                # don't use them.
                from subtitles import probe_media as _probe_dur_byol
                _probe_info = _probe_dur_byol(input_path)
                _audio_dur = max(2.0, float(_probe_info.get("duration_s") or 0))
                if _audio_dur < 2.0 and (transcript.get("segments") or []):
                    # Fall back to last Whisper segment end if probe failed.
                    _audio_dur = max(_audio_dur, float(
                        max(s.get("end", 0) for s in transcript["segments"])
                    ))
                if _audio_dur < 2.0:
                    _audio_dur = max(60.0, len(lyric_lines) * 3.0)

                # SEGMENT-PER-SEGMENT MAPPING — the right algorithm for
                # songs and any audio with instrumental gaps. Whisper
                # already produces segments ONLY where it heard vocals,
                # with natural silence between them for instrumentals,
                # build-ups, fade-outs. We map the user's lyric LINES
                # onto those segments — so subtitles automatically
                # disappear during instrumental breaks (no subtitle
                # plays over a drum solo).
                #
                # Algorithm:
                #   1. Take Whisper's non-empty (vocal) segments.
                #   2. If line count == segment count → 1:1 zip (best).
                #   3. Otherwise distribute user lines across Whisper
                #      segments WEIGHTED BY SEGMENT DURATION, so a
                #      30-second segment gets more lines than a 5-sec
                #      one. Within each segment, lines are distributed
                #      evenly inside its [start, end] window.
                #   4. Result: subtitles only appear during Whisper-
                #      detected vocal moments. Total silence everywhere
                #      else, just like a real lyric video.
                _all_segments = transcript.get("segments") or []
                # NOISE FILTER — Whisper picks up drum hits, ad-libs
                # ("yeah!", "oh!", "boom!"), and instrumental blips as
                # if they were vocal segments. If we map user lyrics
                # 1:1 against THOSE, the real lines get bumped onto
                # noise timestamps and subtitles drift. Drop segments
                # that look like noise BEFORE alignment so the mapping
                # only sees real vocal lines.
                _NOISE_TOKENS = {
                    "yeah", "yeh", "ah", "oh", "uh", "um", "hmm", "mhm",
                    "boom", "bam", "yo", "hey", "ha", "eh", "la", "na",
                    "ya", "ooh", "woo", "whoa", "ow", "ay", "yay", "haha",
                }
                _vocal_segments = []
                _dropped_noise = 0
                for s in _all_segments:
                    text = (s.get("text") or "").strip()
                    s_start = float(s.get("start", 0))
                    s_end = float(s.get("end", 0))
                    duration = s_end - s_start
                    if not text or duration <= 0:
                        continue
                    # Drop segments shorter than 0.4 s — too short to
                    # contain a real lyric line at typical singing pace.
                    if duration < 0.4:
                        _dropped_noise += 1
                        continue
                    # Strip punctuation for the noise-token check; keep
                    # the original text in the segment we KEEP though.
                    import re as _re
                    cleaned = _re.sub(r"[^\w\s]", "", text.lower()).strip()
                    if not cleaned:
                        _dropped_noise += 1
                        continue
                    tokens = cleaned.split()
                    # Drop segments that are entirely interjections.
                    if all(tok in _NOISE_TOKENS for tok in tokens):
                        _dropped_noise += 1
                        continue
                    # Drop segments with a single very short token AND
                    # short duration — almost always a vocal artifact.
                    if len(tokens) == 1 and len(tokens[0]) <= 2 and duration < 1.0:
                        _dropped_noise += 1
                        continue
                    _vocal_segments.append({
                        "start": s_start,
                        "end": s_end,
                    })
                if _dropped_noise:
                    print(f"🧹 Dropped {_dropped_noise} noise/ad-lib Whisper segments before BYOL alignment.")

                aligned_segments = []

                # Try LLM SEMANTIC matching first — this is the
                # algorithm the user actually asked for: AI reads
                # Whisper's heard text + the official lyrics, matches
                # each Whisper segment to a lyric line (or null for
                # noise), and we use Whisper's exact timing window.
                # Choruses repeat verbatim because the LLM understands
                # repetition. Falls through to proportional only if
                # the LLM call fails or returns no matches.
                _llm_key_for_align = x_llm_key or os.environ.get("GEMINI_API_KEY", "")
                if _vocal_segments and _llm_key_for_align:
                    try:
                        # Use the FILTERED noise-free segments — saves
                        # tokens and keeps the LLM focused on real vocals.
                        # Keep the original heard text on each so the LLM
                        # can use phonetic hints.
                        _filtered_for_llm = []
                        for orig_seg in _all_segments:
                            text = (orig_seg.get("text") or "").strip()
                            s_start = float(orig_seg.get("start", 0))
                            s_end = float(orig_seg.get("end", 0))
                            if not text or s_end <= s_start or (s_end - s_start) < 0.4:
                                continue
                            _filtered_for_llm.append({
                                "start": s_start, "end": s_end, "text": text,
                            })
                        # Build a structure outline for the LLM. Keeping
                        # [Verse]/[Chorus]/[Bridge]/[Outro] markers in
                        # the prompt is the difference between "AI
                        # matches the chorus once and skips the rest"
                        # and "AI matches every chorus repeat correctly".
                        # The outline is context only — the markers
                        # never become subtitle text.
                        _structure_outline = (byol_lyrics or "").strip()

                        # Pre-split Whisper mega-segments (>10s) — see
                        # standalone_lyrics_align for the full rationale.
                        # Same chorus-collapse bug applies here.
                        _aligner_input_clip = _split_whisper_mega_segments(
                            _filtered_for_llm, max_dur=5.0, sub_dur=5.0
                        )
                        if len(_aligner_input_clip) != len(_filtered_for_llm):
                            print(
                                f"🪓 Clip BYOL: split mega-segments "
                                f"({len(_filtered_for_llm)} → {len(_aligner_input_clip)})"
                            )
                        llm_matches = await loop.run_in_executor(
                            None,
                            lambda: _llm_align_lyrics_to_whisper(
                                whisper_segments=_aligner_input_clip,
                                lyric_lines=lyric_lines,
                                provider_id=x_llm_provider,
                                model_name=x_llm_model,
                                api_key=_llm_key_for_align,
                                base_url=x_llm_base_url,
                                structure_outline=_structure_outline,
                            ),
                        )
                        # Build aligned segments from the LLM matches.
                        #
                        # MERGE STEP — when the LLM matches several
                        # CONSECUTIVE Whisper segments to the SAME
                        # lyric line, that means Whisper split one
                        # sung phrase into pieces (a brief breath, a
                        # mid-line pause) and the LLM correctly
                        # recognized them as the same line. Without
                        # merging, the user sees the same subtitle
                        # text burn twice in a row at adjacent
                        # timestamps, which feels like the timing is
                        # broken. Merge consecutive same-line matches
                        # into ONE segment that spans all of them.
                        # SAFETY CAP — cap a single merged span at 8s so
                        # an LLM mismap (chorus absorbed into a verse line)
                        # can't produce a 24-second on-screen mega-block.
                        # See standalone_lyrics_align for the parent
                        # rationale.
                        MAX_MERGED_SEG_DURATION = 5.0
                        merged_groups = []  # [(lyric_idx, start, end), ...]
                        cur_lyric, cur_start, cur_end = None, None, None
                        clip_mismap_warnings = 0
                        for w_idx, l_idx in enumerate(llm_matches or []):
                            if l_idx is None:
                                # Close any open group.
                                if cur_lyric is not None:
                                    merged_groups.append((cur_lyric, cur_start, cur_end))
                                    cur_lyric = None
                                continue
                            # Read from _aligner_input_clip — the array
                            # the LLM was given (post-split). See parent
                            # comment in standalone_lyrics_align.
                            ws = _aligner_input_clip[w_idx]
                            if cur_lyric == l_idx:
                                # Same lyric as previous — extend, but
                                # only if it stays within the cap.
                                candidate_end = ws["end"]
                                if (candidate_end - cur_start) > MAX_MERGED_SEG_DURATION:
                                    # Close run; do NOT restart with
                                    # same lyric. See parent comment in
                                    # standalone_lyrics_align — this
                                    # prevents the duplicate-line bug.
                                    merged_groups.append((cur_lyric, cur_start, cur_end))
                                    clip_mismap_warnings += 1
                                    cur_lyric = None
                                else:
                                    cur_end = candidate_end
                            else:
                                if cur_lyric is not None:
                                    merged_groups.append((cur_lyric, cur_start, cur_end))
                                cur_lyric = l_idx
                                cur_start = ws["start"]
                                cur_end = ws["end"]
                        if cur_lyric is not None:
                            merged_groups.append((cur_lyric, cur_start, cur_end))
                        if clip_mismap_warnings:
                            print(
                                f"⚠️  Clip lyrics-align: split {clip_mismap_warnings} "
                                f"oversize merged segment(s) (>{MAX_MERGED_SEG_DURATION}s)."
                            )

                        # RECOVERY PASS — mirrors the standalone path.
                        # Detects under-matched chorus repeats and force-
                        # injects them into the largest unmatched gaps.
                        try:
                            _coverage = _verify_chorus_coverage(
                                [j for (j, _, _) in merged_groups],
                                lyric_lines,
                                _structure_outline,
                            )
                            merged_groups = _recover_missing_blocks(
                                merged_groups,
                                lyric_lines,
                                _structure_outline,
                                whisper_segments=_aligner_input_clip,
                                coverage=_coverage,
                            )
                        except Exception as _rec_err:
                            print(f"⚠️  Clip recovery pass skipped ({_rec_err}); using LLM-only matches.")

                        for l_idx, s_start, s_end in merged_groups:
                            line = lyric_lines[l_idx]
                            words = line.split()
                            per_w = (s_end - s_start) / max(1, len(words))
                            aligned_segments.append({
                                "text": line,
                                "start": s_start,
                                "end": s_end,
                                "words": [
                                    {"word": w, "start": s_start + i * per_w, "end": s_start + (i + 1) * per_w}
                                    for i, w in enumerate(words)
                                ],
                            })
                        # Word-chunking: ≤5 words per on-screen subtitle.
                        try:
                            _pre = len(aligned_segments)
                            aligned_segments = _chunk_segments_by_word_count(aligned_segments, max_words=5)
                            if len(aligned_segments) != _pre:
                                print(
                                    f"✂️  Clip word-split: {_pre} → {len(aligned_segments)} segments "
                                    f"(max 5 words per subtitle)."
                                )
                        except Exception as _chunk_err:
                            print(f"⚠️  Clip word-chunking skipped ({_chunk_err}).")
                        if aligned_segments:
                            _orig_match_count = sum(1 for x in (llm_matches or []) if x is not None)
                            _merged_count = len(aligned_segments)
                            print(
                                f"✅ LLM semantic alignment produced {_merged_count} aligned segments "
                                f"(merged from {_orig_match_count} Whisper matches — "
                                f"{_orig_match_count - _merged_count} consecutive duplicates collapsed)."
                            )
                    except Exception as _llm_err:
                        print(f"⚠️  LLM alignment errored ({_llm_err}); falling through to proportional.")
                        aligned_segments = []

                # PROPORTIONAL FALLBACK — only runs if LLM matching
                # didn't produce any segments (no key, error, or all-null).
                if aligned_segments:
                    # LLM already produced the alignment. Skip the
                    # proportional fallbacks below.
                    pass
                elif not _vocal_segments:
                    # No Whisper vocal segments at all (rare — song was
                    # entirely instrumental, or transcription failed).
                    # Fall back to even distribution across the audio.
                    print("⚠️  No Whisper vocal segments — falling back to even distribution.")
                    weights = [max(2, len(line)) for line in lyric_lines]
                    total_weight = sum(weights) or 1
                    cursor = 0.0
                    for li, line in enumerate(lyric_lines):
                        line_dur = _audio_dur * (weights[li] / total_weight)
                        line_start = cursor
                        line_end = min(_audio_dur, cursor + line_dur)
                        words = line.split()
                        per_w = (line_end - line_start) / max(1, len(words))
                        aligned_segments.append({
                            "text": line,
                            "start": line_start,
                            "end": line_end,
                            "words": [
                                {"word": w, "start": line_start + i * per_w, "end": line_start + (i + 1) * per_w}
                                for i, w in enumerate(words)
                            ],
                        })
                        cursor = line_end
                elif len(lyric_lines) == len(_vocal_segments):
                    # Best case: perfect 1:1 mapping. User's lyric line N
                    # gets Whisper's segment N's exact timing window.
                    print(f"✅ Lyrics line count ({len(lyric_lines)}) == Whisper vocal segments ({len(_vocal_segments)}) — 1:1 zip.")
                    for line, ws in zip(lyric_lines, _vocal_segments):
                        s_start, s_end = ws["start"], ws["end"]
                        words = line.split()
                        per_w = (s_end - s_start) / max(1, len(words))
                        aligned_segments.append({
                            "text": line,
                            "start": s_start,
                            "end": s_end,
                            "words": [
                                {"word": w, "start": s_start + i * per_w, "end": s_start + (i + 1) * per_w}
                                for i, w in enumerate(words)
                            ],
                        })
                else:
                    # Distribute user lines across Whisper segments,
                    # weighted by segment duration. A long segment gets
                    # more user lines than a short one (matches the
                    # natural feeling of lyrics packing together during
                    # extended vocal phrases vs. one-line hooks).
                    print(f"📊 Lyrics ({len(lyric_lines)}) vs Whisper vocal segments ({len(_vocal_segments)}) — proportional distribution.")
                    seg_durs = [max(0.1, s["end"] - s["start"]) for s in _vocal_segments]
                    total_seg_dur = sum(seg_durs)
                    # Allocate lines per Whisper segment proportionally.
                    raw_alloc = [d / total_seg_dur * len(lyric_lines) for d in seg_durs]
                    int_alloc = [int(round(a)) for a in raw_alloc]
                    # Fix rounding drift — total int_alloc must equal
                    # total lyric line count. Bump the largest fractional
                    # remainders until totals match.
                    diff = len(lyric_lines) - sum(int_alloc)
                    if diff != 0:
                        # +1 to highest-remainder buckets, -1 from
                        # lowest-remainder buckets, until totals match.
                        order = sorted(range(len(_vocal_segments)),
                                       key=lambda i: raw_alloc[i] - int_alloc[i],
                                       reverse=(diff > 0))
                        i = 0
                        while diff != 0 and i < len(order):
                            j = order[i]
                            if diff > 0:
                                int_alloc[j] += 1
                                diff -= 1
                            elif int_alloc[j] > 0:
                                int_alloc[j] -= 1
                                diff += 1
                            i += 1
                    # Walk through lyric_lines, slotting them into the
                    # allocated buckets. Within each Whisper segment,
                    # distribute the assigned lines evenly across its
                    # [start, end] window.
                    cursor_line = 0
                    for ws, n_lines in zip(_vocal_segments, int_alloc):
                        if n_lines <= 0:
                            continue
                        s_start, s_end = ws["start"], ws["end"]
                        chunk_dur = (s_end - s_start) / n_lines
                        for k in range(n_lines):
                            if cursor_line >= len(lyric_lines):
                                break
                            line = lyric_lines[cursor_line]
                            cursor_line += 1
                            line_start = s_start + k * chunk_dur
                            line_end = s_start + (k + 1) * chunk_dur
                            words = line.split()
                            per_w = (line_end - line_start) / max(1, len(words))
                            aligned_segments.append({
                                "text": line,
                                "start": line_start,
                                "end": line_end,
                                "words": [
                                    {"word": w, "start": line_start + i * per_w, "end": line_start + (i + 1) * per_w}
                                    for i, w in enumerate(words)
                                ],
                            })
                    # Tail safety: if any lyric lines didn't get placed
                    # (rounding edge case), append them to the LAST
                    # vocal segment so we don't drop user content.
                    if cursor_line < len(lyric_lines):
                        last_ws = _vocal_segments[-1]
                        leftover = lyric_lines[cursor_line:]
                        # Squeeze the rest into 80% of the last
                        # segment's tail so the user sees them.
                        tail_start = last_ws["start"] + (last_ws["end"] - last_ws["start"]) * 0.2
                        tail_end = last_ws["end"]
                        per_line = (tail_end - tail_start) / max(1, len(leftover))
                        for i, line in enumerate(leftover):
                            line_start = tail_start + i * per_line
                            line_end = tail_start + (i + 1) * per_line
                            words = line.split()
                            per_w = (line_end - line_start) / max(1, len(words))
                            aligned_segments.append({
                                "text": line,
                                "start": line_start,
                                "end": line_end,
                                "words": [
                                    {"word": w, "start": line_start + j * per_w, "end": line_start + (j + 1) * per_w}
                                    for j, w in enumerate(words)
                                ],
                            })

                if not aligned_segments:
                    raise RuntimeError("BYOL alignment produced no segments")
                # whisper_words is no longer needed for alignment, but
                # keep a count for the log line + debug.
                whisper_words: list = []
                for seg in (transcript.get("segments") or []):
                    whisper_words.extend(seg.get("words") or [])
                flat_words = [w for line in lyric_lines for w in line.split()]

                # CLAMP & SORT — the difflib alignment can produce
                # timings that:
                #   • Exceed the audio duration (when a user word like
                #     'boom!' has no Whisper anchor and interpolation
                #     extends it past the file's end). Symptom: the
                #     video player freezes on that subtitle, the burn
                #     pipeline produces an mp4 shorter than the SRT.
                #   • Land out of order (rare, but difflib can match
                #     a later user word to an earlier Whisper anchor).
                # Both issues show up as playback stuck at one line.
                # Probe the actual audio duration and clamp everything
                # to [0, duration]; then sort segments by start and
                # nudge overlaps so the player can advance cleanly.
                from subtitles import probe_media as _probe_dur
                _info = _probe_dur(input_path)
                _dur = max(0.5, float(_info.get("duration_s") or 0))
                if _dur < 0.5:
                    # Fall back to the last known Whisper word end if
                    # ffprobe didn't give a duration (rare).
                    if whisper_words:
                        _dur = max(_dur, max(float(w["end"]) for w in whisper_words))
                    if _dur < 0.5:
                        _dur = max(s["end"] for s in aligned_segments)
                # Clamp all word + segment times into [0, _dur].
                for seg in aligned_segments:
                    seg["start"] = max(0.0, min(_dur, float(seg["start"])))
                    seg["end"] = max(seg["start"] + 0.05, min(_dur, float(seg["end"])))
                    for w in seg.get("words") or []:
                        w["start"] = max(0.0, min(_dur, float(w["start"])))
                        w["end"] = max(w["start"] + 0.01, min(_dur, float(w["end"])))
                # Sort by start so the player advances monotonically.
                aligned_segments.sort(key=lambda s: float(s.get("start", 0)))
                # Nudge any backward overlap so segment N+1 starts
                # at-or-after segment N's end. Tiny 5-ms gap keeps
                # them visually distinct.
                for i in range(1, len(aligned_segments)):
                    prev_end = float(aligned_segments[i - 1]["end"])
                    if float(aligned_segments[i]["start"]) < prev_end:
                        new_start = min(_dur - 0.05, prev_end + 0.005)
                        aligned_segments[i]["start"] = new_start
                        if float(aligned_segments[i]["end"]) <= new_start:
                            aligned_segments[i]["end"] = min(_dur, new_start + 0.5)

                transcript = {
                    "language": "mixed",
                    "text": "\n".join(s["text"] for s in aligned_segments),
                    "segments": aligned_segments,
                    "_user_lyrics": True,
                    "_word_timings_aligned": True,
                }
                print(
                    f"🎵 BYOL aligned: {len(aligned_segments)} lyric lines mapped to "
                    f"{len(_vocal_segments)} cleaned vocal segments "
                    f"(was {len(_all_segments)} total Whisper segments, "
                    f"{_dropped_noise} dropped as noise/ad-libs) · "
                    f"clamped to {_dur:.2f}s audio duration"
                )

                # BYOL + script_mode 'roman' or 'translate':
                # the user's text is ground truth, but they STILL want
                # it transliterated or translated. Run the LLM rewrite
                # on the aligned transcript — it carries _user_lyrics=True
                # so the prompt uses the song-mode template (chorus
                # repetition, crypto glossary, no "fix Whisper errors"
                # framing). 'auto' mode short-circuits — there's
                # nothing to clean when the user provided ground truth.
                _byol_mode = (script_mode or "auto").lower()
                if _byol_mode in ("roman", "translate"):
                    _standalone_status(
                        job_id, "cleaning",
                        f"Stage 2: AI {_byol_mode} on your lyrics…",
                    )
                    transcript = await loop.run_in_executor(
                        None,
                        lambda: _llm_rewrite_transcript(
                            transcript=transcript,
                            mode=_byol_mode,
                            target_language=target_language if _byol_mode == "translate" else None,
                            provider_id=x_llm_provider,
                            model_name=x_llm_model,
                            api_key=x_llm_key,
                            base_url=x_llm_base_url,
                        ),
                    )
                    # Preserve the BYOL flags through the rewrite
                    # (deep-copy in _llm_rewrite_transcript would have
                    # carried them, but defence in depth).
                    transcript["_user_lyrics"] = True
                    if "_word_timings_aligned" not in transcript:
                        transcript["_word_timings_aligned"] = True
            else:
                mode = (script_mode or "auto").lower()
                cleanup_label = (
                    "AI proofread cleanup" if mode == "auto"
                    else f"AI {mode} cleanup"
                )
                _standalone_status(job_id, "cleaning", f"Stage 2: {cleanup_label}…")
                cleanup_mode = "cleanup" if mode == "auto" else mode
                transcript = await loop.run_in_executor(
                    None,
                    lambda: _llm_rewrite_transcript(
                        transcript=transcript,
                        mode=cleanup_mode,
                        target_language=target_language if mode == "translate" else None,
                        provider_id=x_llm_provider,
                        model_name=x_llm_model,
                        api_key=x_llm_key,
                        base_url=x_llm_base_url,
                    ),
                )

            # Split long segments into single-line chunks BEFORE
            # persisting. The Timed editor, the saved transcript, the
            # burn pipeline, and the SRT export all then agree that one
            # row = one caption line. User complaint was that the editor
            # showed 5-line paragraphs even though the burn was 1-line.
            #
            # SKIP FOR BYOL: when the user pasted ground-truth lyrics,
            # each segment IS already one lyric line — splitting it
            # again chops "Decades in the making... let's ride the
            # cycle!" into "Decades in the making... let's ride" /
            # "the cycle!" and the timing falls apart. The user's line
            # IS the natural caption unit. Trust it.
            if not transcript.get("_user_lyrics"):
                transcript["segments"] = _split_long_segments(
                    transcript.get("segments") or []
                )
            standalone_jobs[job_id]["transcript"] = transcript
            _standalone_save_blob(job_id, "cleaned_transcript", transcript)
            # Also flatten segments into a clean list with start/end so
            # the frontend can show them with timestamps and offer SRT
            # export. Times are in clip-local seconds.
            seg_payload = []
            for s in (transcript.get("segments") or []):
                seg_payload.append({
                    "text": (s.get("text") or "").strip(),
                    "start": float(s.get("start", 0)),
                    "end": float(s.get("end", 0)),
                })
            _standalone_status(
                job_id, "transcript_ready", "Phase 1 done — review the transcript.",
                result={
                    "transcript_text": transcript.get("text", ""),
                    "language": transcript.get("language", ""),
                    "segments_count": len(seg_payload),
                    "segments": seg_payload,
                    "phase": 1,
                },
            )
        except Exception as e:
            print(f"❌ Standalone subtitle Phase 1 failed ({job_id}): {e}")
            _standalone_status(job_id, "failed", f"Error in Phase 1: {e}")

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


class StandaloneBurnSegment(BaseModel):
    """One per-line text override from the Phase-1 Timed view."""
    index: int
    text: str


class StandaloneBurnRequest(BaseModel):
    job_id: str
    # Two layered edit signals (apply in this order on the backend):
    #   1. edited_segments — per-line text fixes from the Timed view.
    #      Highest priority. Preserves segment timings (incl. aligned
    #      word-level timings from Sync). Backend just swaps the
    #      `text` of each named segment.
    #   2. edited_text — bulk Plain-view edits. Only used when
    #      edited_segments is None/empty. Triggers naive proportional
    #      redistribution across original segments.
    edited_text: Optional[str] = None
    edited_segments: Optional[List[StandaloneBurnSegment]] = None
    # Legacy enum kept for backward compat. Ignored when position_pct
    # is provided.
    position: Optional[str] = "bottom"
    # Vertical position of subtitle TOP edge as 0..100% of frame height.
    # Overrides `position` when set. None means use the legacy enum.
    position_pct: Optional[float] = None
    # Output orientation. 'original' = no crop; 'vertical' = 9:16;
    # 'horizontal' = 16:9. When cropping is required, crop_x_offset_pct
    # / crop_y_offset_pct say where on the source to centre the crop
    # window (50 = middle by default).
    output_orientation: Optional[str] = "original"
    crop_x_offset_pct: Optional[float] = 50.0
    crop_y_offset_pct: Optional[float] = 50.0
    # Optional keyframed crop. When non-empty AND output_orientation is
    # not 'original', the crop window pans/cuts through these keyframes
    # over the course of the video instead of using the static x/y
    # offsets. Each keyframe: { t (seconds, video-local), x (0..1),
    # y (0..1), cut (bool — true = hard snap into this position, false
    # = smooth pan from previous keyframe) }. When None or empty, the
    # static-offset behaviour is preserved unchanged.
    crop_keyframes: Optional[List[Keyframe]] = None
    font_size: Optional[int] = 64
    font_name: Optional[str] = "Verdana"
    font_color: Optional[str] = "#FFFFFF"
    border_color: Optional[str] = "#000000"
    border_width: Optional[int] = 2
    bg_color: Optional[str] = "#000000"
    bg_opacity: Optional[float] = 0.0
    # Manual time-shift applied to ALL segments at burn time. Positive
    # number pushes all subtitles LATER (delays them); negative pulls
    # them EARLIER. Used as the escape-hatch when automatic alignment
    # for BYOL / translated transcripts isn't quite right — the user
    # nudges a slider in Phase 2 and re-burns. Clamped to ±60 s to
    # prevent timings from sliding off the audio entirely.
    time_offset_seconds: Optional[float] = 0.0
    # FULL SEGMENT REPLACEMENT FOR BURN — same shape as the /save
    # endpoint accepts. When provided, REPLACES the transcript's
    # segments wholesale BEFORE the SRT is generated and burned.
    # This is the authoritative path for capturing user edits made in
    # the timeline editor: text edits, splits, merges, retiming,
    # inserts, deletes. Without this, the burn endpoint had to rely on
    # the index-only `edited_segments` field which can ONLY patch
    # text — splits/merges/retiming silently fell back to the original
    # Whisper output. The frontend now sends the full segment array
    # on every burn click so what you see is always what gets burned.
    #   { start: float, end: float, text: str, words?: [...] }
    full_segments: Optional[List[Dict[str, Any]]] = None
    # ANIMATED SUBTITLE TEMPLATE — chooses how each line/word is
    # rendered at burn time. The libass renderer in subtitles.py
    # honours these values via _animate_block_events +
    # _resolve_animation_style_overrides. When 'none', the static
    # path is used. These fields were referenced unconditionally
    # downstream (`req.animation or 'none'`) but the model never
    # declared them, so pydantic's strict attribute access raised
    # `'StandaloneBurnRequest' object has no attribute 'animation'`
    # on every burn — that was the actual Phase-2 crash the user
    # was seeing in the failure card.
    animation: Optional[str] = "none"
    # Hex color (#RRGGBB) used as the karaoke / word-highlight
    # active-word color. Backend converts to ASS &H00BBGGRR before
    # writing the .ass file.
    highlight_color: Optional[str] = "#FFDD00"
    # When false, the burn skips SRT generation + libass entirely and
    # just re-encodes the (possibly reframed) source video. Used by
    # the Phase 1 "Export without subtitles" path so users can change
    # orientation / set crop keyframes WITHOUT being forced into the
    # subtitle styling step. Defaults to True to keep every existing
    # call site working unchanged.
    burn_subtitles: Optional[bool] = True


@app.post("/api/standalone/subtitle/burn")
async def standalone_subtitle_burn(req: StandaloneBurnRequest):
    """Phase 2 — burn the (possibly user-edited) transcript onto the
    whole video using the chosen style. Reuses the same job_id from
    Phase 1 so we don't re-transcribe."""
    rec = standalone_jobs.get(req.job_id)
    # ON-DEMAND REHYDRATE — when the in-memory dict doesn't have the
    # job (uvicorn restarted between save and burn, OR rehydrate ran
    # but missed this job, OR the user is hitting an old job whose
    # in-memory entry was evicted), pull the record off disk before
    # 404'ing. This is what was 404'ing in the burn-debug screenshot:
    # the frontend was sending the right segments, but the backend
    # had no row for the job and bailed out before the SRT generator
    # ever ran. After this falls through, the burn proceeds normally
    # with the on-disk transcript (or with full_segments below, which
    # then overrides it wholesale — exactly what the user wants).
    if not rec:
        if _rehydrate_one_standalone(req.job_id):
            rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    transcript = rec.get("transcript")
    # Fall back to disk if the in-memory transcript was wiped by a
    # backend restart — happens to jobs that landed in transcript_ready
    # before the checkpoint code shipped, or any time the container
    # restarted between Phase 1 finishing and the user clicking Burn.
    if not transcript:
        transcript = _standalone_load_blob(req.job_id, "cleaned_transcript")
        if transcript:
            rec["transcript"] = transcript
    if not transcript:
        # Second fallback: the raw Whisper checkpoint. The user loses
        # the AI-cleaned version but the burn produces a usable mp4
        # instead of dead-ending.
        whisper_orig = _standalone_load_blob(req.job_id, "whisper_original")
        if whisper_orig:
            transcript = whisper_orig
            rec["transcript"] = transcript
    if not transcript:
        # LAST-resort fallback for OLD projects predating the
        # checkpoint code: reconstruct a minimal transcript from the
        # segment payload that's persisted inside _standalone_meta.json
        # under result.segments. Each segment has text/start/end —
        # exactly what generate_srt_per_segment needs. Word-level
        # timings are gone, but the burn pipeline doesn't use them
        # for segment-level SRT (which is what the standalone burn
        # uses anyway).
        result = rec.get("result") or {}
        legacy_segments = result.get("segments") or []
        if legacy_segments:
            transcript = {
                "segments": [
                    {
                        "text": (s.get("text") or "").strip(),
                        "start": float(s.get("start", 0)),
                        "end": float(s.get("end", 0)),
                    }
                    for s in legacy_segments
                ],
                "text": result.get("transcript_text", ""),
                "language": result.get("language", ""),
            }
            rec["transcript"] = transcript
            # Save it as a cleaned_transcript blob so future restarts
            # don't have to do this dance again.
            _standalone_save_blob(req.job_id, "cleaned_transcript", transcript)
            print(f"♻️  Reconstructed transcript for legacy job {req.job_id} from saved segments.")
    input_path = rec.get("input_path")
    if not transcript:
        raise HTTPException(
            409,
            "This job's transcript was lost (most likely the backend "
            "restarted between Phase 1 and Burn). Click Regenerate "
            "on the transcript page to recreate it from the saved "
            "audio — or Resume it from Past Projects.",
        )
    if not input_path or not os.path.exists(input_path):
        raise HTTPException(
            409,
            "The source video for this job is no longer on disk. "
            "Re-upload from the Subtitle homepage to start a fresh "
            "burn.",
        )

    job_dir = rec.get("output_dir")
    output_filename = f"subtitled_{int(time.time())}.mp4"
    output_path = os.path.join(job_dir, output_filename)
    srt_path = os.path.join(job_dir, f"subs_{int(time.time())}.srt")

    # VERY VISIBLE PROOF that the new burn endpoint code is running.
    # If you click Burn and DON'T see this banner in the backend log,
    # uvicorn is still running the OLD app.py — restart it so the
    # latest code is loaded. Without this, all the data-flow fixes
    # are invisible because the OLD function object is still bound.
    print("=" * 70)
    print(f"🔥 KLIPRA BURN DEBUG — job_id={req.job_id}")
    print(f"   has full_segments: {bool(req.full_segments)}")
    print(f"   full_segments count: {len(req.full_segments) if req.full_segments else 0}")
    print(f"   has edited_segments: {bool(req.edited_segments)}")
    print(f"   edited_segments count: {len(req.edited_segments) if req.edited_segments else 0}")
    print(f"   in-memory transcript segments: {len(transcript.get('segments') or [])}")
    if req.full_segments:
        _fs = req.full_segments
        print(f"   first full_segment: {_fs[0] if _fs else None}")
        print(f"   last  full_segment: {_fs[-1] if _fs else None}")
    print("=" * 70)

    # FULL SEGMENT REPLACEMENT — highest-priority edit path.
    # When the frontend sends a complete segments array (the timeline
    # editor does this on every Burn click), REPLACE the in-memory
    # transcript's segments wholesale before SRT generation. This is
    # the only path that captures user splits/merges/retiming/inserts
    # — `edited_segments` (below) can only patch existing text by
    # index. After this runs, the SRT generator sees exactly what the
    # user has on screen, which is also exactly what auto-save just
    # persisted (or is about to). No more "old subtitles burned"
    # mystery: the frontend's segments ARE the source of truth at
    # burn time.
    #
    # PROVIDED-BUT-EMPTY = "no subtitles wanted". The user deleted
    # every line from the timeline (sometimes because they only want
    # to reframe). The old code filtered empties, hit `if clean_segs:`
    # False, fell through, and burned the on-disk transcript — exactly
    # the bug the user reported. Now we treat full_segments=[] as an
    # explicit "skip subtitles" intent and propagate it via the
    # burn_subtitles flag.
    if req.full_segments is not None and isinstance(req.full_segments, list):
        clean_segs = []
        for s in req.full_segments:
            if not isinstance(s, dict):
                continue
            try:
                start = float(s.get("start", 0.0))
                end = float(s.get("end", start))
            except Exception:
                continue
            text = (s.get("text") or "").strip()
            if not text:
                continue
            entry = {"start": start, "end": end, "text": text}
            words = s.get("words")
            if isinstance(words, list) and words:
                entry["words"] = [
                    {
                        "word": (w.get("word") or "").strip(),
                        "start": float(w.get("start", start)),
                        "end": float(w.get("end", end)),
                    }
                    for w in words if isinstance(w, dict) and (w.get("word") or "").strip()
                ]
            clean_segs.append(entry)
        if clean_segs:
            transcript["segments"] = clean_segs
            transcript["text"] = " ".join(s["text"] for s in clean_segs)
            print(
                f"🔄 Burn: replaced {req.job_id} transcript with "
                f"{len(clean_segs)} client-supplied segments"
            )
            try:
                _standalone_save_blob(req.job_id, "cleaned_transcript", transcript)
            except Exception as _persist_err:
                print(
                    f"⚠️  Could not persist burn-time transcript for "
                    f"{req.job_id}: {_persist_err}"
                )
        else:
            # User wiped every segment — they don't want subtitles
            # on this burn. Force burn_subtitles=False AND blank the
            # working transcript so any later code path can't sneak
            # in the saved version.
            print(
                f"🧹 Burn: client supplied full_segments=[] for "
                f"{req.job_id} — interpreting as 'no subtitles wanted'."
            )
            req.burn_subtitles = False
            transcript = dict(transcript or {})
            transcript["segments"] = []
            transcript["text"] = ""

    # Apply user's hand-edits to the transcript text before burning.
    # Two paths, in priority order:
    #
    # 1. edited_segments — precise per-line fixes from the Timed view.
    #    Just swaps each segment's `text`; preserves all timings (incl.
    #    aligned word-level timings from Sync). Drop the saved per-word
    #    timing array on EDITED segments only — the words don't match
    #    anymore and would corrupt the SRT.
    #    NOTE: If full_segments was provided above, edited_segments is
    #    redundant (full_segments already has the latest text). The
    #    backend still applies it idempotently — no-op when the texts
    #    match — so old clients keep working.
    if req.edited_segments:
        segs = transcript.get("segments") or []
        for ed in req.edited_segments:
            if 0 <= ed.index < len(segs):
                new_text = (ed.text or "").strip()
                if not new_text:
                    continue
                if segs[ed.index].get("text") != new_text:
                    segs[ed.index]["text"] = new_text
                    # Word-level timings (if any) belong to the OLD text.
                    # Drop them so the burn step falls back to per-segment
                    # display for THIS segment only — neighbours keep their
                    # alignment.
                    if "words" in segs[ed.index]:
                        segs[ed.index].pop("words", None)
        transcript["text"] = " ".join(s.get("text", "") for s in segs)
        print(f"✏️  Applied {len(req.edited_segments)} per-segment edits")
    # 2. edited_text — legacy bulk Plain-view edit. Only honoured when
    #    edited_segments wasn't provided. Distributes words proportionally
    #    across segments — less precise but useful when the user did a
    #    big rewrite in the Plain view.
    elif req.edited_text and req.edited_text.strip():
        new_words = req.edited_text.strip().split()
        segs = transcript.get("segments") or []
        if new_words and segs:
            total_dur = max(1e-3, sum(
                max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
                for s in segs
            ))
            cursor = 0
            for s in segs:
                seg_dur = max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
                take = max(1, int(round(len(new_words) * (seg_dur / total_dur))))
                slice_words = new_words[cursor:cursor + take]
                cursor += take
                if slice_words:
                    s["text"] = " ".join(slice_words)
            if cursor < len(new_words):
                segs[-1]["text"] += " " + " ".join(new_words[cursor:])
            transcript["text"] = " ".join(s.get("text", "") for s in segs)

    async def run():
        try:
            _standalone_status(req.job_id, "rendering", "Phase 2: burning subtitles…")

            # If the user picked an orientation different from the
            # source, pre-crop the source to the target aspect first.
            # The crop helper is a no-op when the source already
            # matches, so this is safe to call unconditionally.
            burn_input_path = input_path
            if req.output_orientation and req.output_orientation != "original":
                # Two crop paths:
                #
                #  - KEYFRAMED: user dropped one or more crop keyframes
                #    in Phase 2. We hand off to reframe_kf.py in
                #    full-video mode so the crop window pans/snaps
                #    through their picks over the whole timeline.
                #
                #  - STATIC: classic single x/y offset for the entire
                #    video. Unchanged from the original behaviour.
                kfs = req.crop_keyframes or []
                if kfs:
                    _standalone_status(
                        req.job_id, "rendering",
                        f"Re-framing video to {req.output_orientation} with {len(kfs)} keyframe(s)…",
                    )
                    # Map orientation -> aspect string accepted by
                    # reframe_kf.py's --aspect arg.
                    aspect_arg = {
                        "vertical": "9:16",
                        "horizontal": "16:9",
                    }.get(req.output_orientation, "9:16")
                    # Sanitize keyframes: clamp x/y to [0,1] and t to
                    # [0, +inf). reframe_kf.py also clamps but a clean
                    # JSON keeps the FFmpeg expression short and the
                    # debug print readable.
                    sorted_kfs = sorted(kfs, key=lambda k: k.t)
                    sanitized = [
                        {
                            "t": max(0.0, float(kf.t)),
                            "x": max(0.0, min(1.0, float(kf.x))),
                            "y": max(0.0, min(1.0, float(kf.y))),
                            "cut": bool(kf.cut),
                        }
                        for kf in sorted_kfs
                    ]
                    import tempfile as _tempfile
                    with _tempfile.NamedTemporaryFile(
                        suffix=".json", delete=False, mode="w",
                    ) as _tmp:
                        json.dump(sanitized, _tmp)
                        _kf_path = _tmp.name
                    cropped_path = os.path.join(
                        job_dir, f"cropped_{int(time.time())}.mp4",
                    )
                    try:
                        proc = await asyncio.create_subprocess_exec(
                            "python", "-u", "reframe_kf.py",
                            "--source", input_path,
                            "--keyframes", _kf_path,
                            "--output", cropped_path,
                            "--aspect", aspect_arg,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        _stdout, _stderr = await proc.communicate()
                        if proc.returncode != 0:
                            _msg = (_stderr or b"").decode("utf-8", errors="replace")[-1000:]
                            raise RuntimeError(f"Keyframed reframe failed: {_msg}")
                    finally:
                        try:
                            os.unlink(_kf_path)
                        except OSError:
                            pass
                    burn_input_path = cropped_path
                else:
                    _standalone_status(
                        req.job_id, "rendering",
                        f"Re-framing video to {req.output_orientation}…",
                    )
                    cropped_path = os.path.join(
                        job_dir, f"cropped_{int(time.time())}.mp4",
                    )
                    loop = asyncio.get_event_loop()
                    burn_input_path = await loop.run_in_executor(
                        None,
                        lambda: _crop_to_orientation(
                            input_path, cropped_path,
                            req.output_orientation,
                            x_offset_pct=req.crop_x_offset_pct or 50.0,
                            y_offset_pct=req.crop_y_offset_pct or 50.0,
                        ),
                    )

            # MANUAL TIME-SHIFT — applied just before SRT generation
            # so the saved cleaned_transcript stays canonical (the next
            # burn with a different shift starts from the same source).
            # Clamp the offset to ±60 s so a runaway slider can't push
            # subtitles entirely off the audio.
            shift_s = max(-60.0, min(60.0, float(req.time_offset_seconds or 0.0)))
            if abs(shift_s) > 0.01:
                # Probe the actual audio duration so we don't shift
                # past the end. shift_s positive = delay (push later),
                # negative = pull earlier.
                from subtitles import probe_media as _probe_for_shift
                _info = _probe_for_shift(burn_input_path)
                _shift_dur = max(2.0, float(_info.get("duration_s") or 0))
                shifted_transcript = json.loads(json.dumps(transcript))
                for seg in shifted_transcript.get("segments") or []:
                    seg["start"] = max(0.0, min(_shift_dur, float(seg.get("start", 0)) + shift_s))
                    seg["end"] = max(seg["start"] + 0.05, min(_shift_dur, float(seg.get("end", 0)) + shift_s))
                    for w in seg.get("words") or []:
                        w["start"] = max(0.0, min(_shift_dur, float(w.get("start", 0)) + shift_s))
                        w["end"] = max(w["start"] + 0.01, min(_shift_dur, float(w.get("end", 0)) + shift_s))
                burn_transcript = shifted_transcript
                print(f"⏱️  Applied manual time-shift: {shift_s:+.2f}s")
            else:
                burn_transcript = transcript

            if req.burn_subtitles is False:
                # SUBTITLE-FREE EXPORT — the user wants the reframed
                # source video and nothing else burned onto it. Skip
                # SRT generation + libass entirely. Just re-encode the
                # already-cropped source so the output filename + path
                # stay consistent with the normal burn flow (Past
                # Projects, change-background, etc. all key off these).
                _standalone_status(
                    req.job_id, "rendering",
                    "Encoding output (subtitles skipped)…",
                )
                cmd = [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-i", burn_input_path,
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    output_path,
                ]
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _stdout, _stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(
                        f"No-subs encode failed: "
                        f"{(_stderr or b'').decode('utf-8', errors='replace')[-800:]}"
                    )
                print(
                    f"🎞  Burn (no-subs): {req.job_id} encoded "
                    f"{output_filename} from {os.path.basename(burn_input_path)}"
                )
            else:
                # Always use segment-level SRT for the standalone burn.
                # Word-level SRT chunks subtitles into ~20-char blocks
                # which feels jittery for whole-video subtitling. Sync
                # refines the per-SEGMENT start/end so the segment-level
                # SRT already gets precise audio-aligned timing — no
                # need to flip into word-level mode.
                ok = generate_srt_per_segment(burn_transcript, 0.0, 1e9, srt_path)
                if not ok:
                    raise RuntimeError("Failed to write SRT.")
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, lambda: burn_subtitles(
                    burn_input_path, srt_path, output_path,
                    alignment=req.position, fontsize=req.font_size,
                    font_name=req.font_name, font_color=req.font_color,
                    border_color=req.border_color, border_width=req.border_width,
                    bg_color=req.bg_color, bg_opacity=req.bg_opacity,
                    position_pct=req.position_pct,
                    # ANIMATION + HIGHLIGHT — were silently dropped
                    # before this line was added. Without them the burn
                    # always rendered at animation='none' regardless of
                    # template choice, which is why Karaoke /
                    # Word-Highlight / Pop templates only showed a
                    # line-level entrance and never the per-word effect.
                    animation=(req.animation or 'none'),
                    highlight_color=(req.highlight_color or '#FFDD00'),
                ))
            # Cache the burn settings on the job so /change-background can
            # re-burn with the same look without the client re-sending all
            # fields. Stored in-memory + persisted via _standalone_persist.
            standalone_jobs[req.job_id]['last_burn_settings'] = {
                'position': req.position,
                'position_pct': req.position_pct,
                'font_size': req.font_size,
                'font_name': req.font_name,
                'font_color': req.font_color,
                'border_color': req.border_color,
                'border_width': req.border_width,
                'bg_color': req.bg_color,
                'bg_opacity': req.bg_opacity,
                # Cache animation choices so change-background re-burns
                # in the same template look (Karaoke stays Karaoke when
                # the user swaps the visual background).
                'animation': req.animation or 'none',
                'highlight_color': req.highlight_color or '#FFDD00',
            }
            _standalone_status(
                req.job_id, "completed", "Done.",
                result={
                    "video_url": f"/videos/standalone_{req.job_id}/{output_filename}",
                    "transcript_text": transcript.get("text", ""),
                    "phase": 2,
                },
            )
        except Exception as e:
            print(f"❌ Standalone subtitle Phase 2 failed ({req.job_id}): {e}")
            _standalone_status(req.job_id, "failed", f"Error in Phase 2: {e}")

    asyncio.create_task(run())
    return {"job_id": req.job_id, "status": "rendering"}


class StandaloneSaveDraftRequest(BaseModel):
    """Snapshot of Phase 2 styling state, captured when the user clicks
    'Save for later' instead of 'Burn subtitles'. The transcript is
    already on the backend (rec['transcript']); this captures the
    styling choices so reopening the project lands the user exactly
    where they left off."""
    job_id: str
    edited_text: Optional[str] = None
    edited_segments: Optional[List[StandaloneBurnSegment]] = None
    position: Optional[str] = "bottom"
    position_pct: Optional[float] = None
    output_orientation: Optional[str] = "original"
    crop_x_offset_pct: Optional[float] = 50.0
    crop_y_offset_pct: Optional[float] = 50.0
    # Same shape and meaning as StandaloneBurnRequest.crop_keyframes —
    # snapshotted into the draft so reopening the project restores the
    # keyframes the user already placed.
    crop_keyframes: Optional[List[Keyframe]] = None
    font_size: Optional[int] = 64
    font_name: Optional[str] = "Verdana"
    font_color: Optional[str] = "#FFFFFF"
    border_color: Optional[str] = "#000000"
    border_width: Optional[int] = 2
    bg_color: Optional[str] = "#000000"
    bg_opacity: Optional[float] = 0.0
    # FULL SEGMENT REPLACEMENT — when set, REPLACES the entire segments
    # array on the backend. Captures user changes that the index-only
    # `edited_segments` field can't express: splits, merges, manual
    # adds/deletes, retiming. Auto-save now sends this on every flush
    # so the backend stays the source of truth and Download SRT
    # always reflects what's on screen. Each entry is just the
    # subset of fields we care about for resume + SRT export:
    #   { start: float, end: float, text: str, words?: [...] }
    full_segments: Optional[List[Dict[str, Any]]] = None


@app.post("/api/standalone/subtitle/save")
async def standalone_subtitle_save(req: StandaloneSaveDraftRequest):
    """Save the current Subtitle wizard state as a DRAFT (no burn).
    Records the transcript edits + chosen Phase-2 styling so the user
    can come back later, replay the styling, and finally burn when
    they're happy. Surfaces in Past Projects with status='saved_draft'.
    """
    rec = standalone_jobs.get(req.job_id)
    # ON-DEMAND REHYDRATE — same fix as /burn. Without this, every
    # auto-save firing after a backend restart 404s silently in the
    # background, and the on-screen edits never make it to disk,
    # leading to the lost-edits failure mode the user was hitting
    # repeatedly.
    if not rec:
        if _rehydrate_one_standalone(req.job_id):
            rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    transcript = rec.get("transcript")
    # Fall back to disk for jobs whose in-memory transcript got wiped
    # by a backend restart.
    if not transcript:
        transcript = _standalone_load_blob(req.job_id, "cleaned_transcript")
        if transcript:
            rec["transcript"] = transcript
    if not transcript:
        raise HTTPException(
            409,
            "This job's transcript isn't loaded — open it from Past "
            "Projects first, or click Regenerate to recreate it.",
        )

    # FULL_SEGMENTS REPLACEMENT — when the frontend sends a complete
    # segments array (auto-save does this on every flush), replace
    # the transcript's segments wholesale. Captures everything the
    # index-only `edited_segments` path can't: splits, merges,
    # retiming, inserts, deletes. After this runs the backend's
    # view matches the editor exactly, so Download SRT and re-open
    # both reflect the user's current work.
    if req.full_segments and isinstance(req.full_segments, list):
        clean_segs = []
        for s in req.full_segments:
            if not isinstance(s, dict):
                continue
            try:
                start = float(s.get("start", 0.0))
                end = float(s.get("end", start))
            except Exception:
                continue
            text = (s.get("text") or "").strip()
            if not text:
                continue
            entry = {"start": start, "end": end, "text": text}
            # Preserve word-level timings if the frontend sent them —
            # used by word-by-word burn animations and by SRT export
            # if/when we ever switch to per-word output.
            words = s.get("words")
            if isinstance(words, list) and words:
                entry["words"] = [
                    {
                        "word": (w.get("word") or "").strip(),
                        "start": float(w.get("start", start)),
                        "end": float(w.get("end", end)),
                    }
                    for w in words if isinstance(w, dict) and (w.get("word") or "").strip()
                ]
            clean_segs.append(entry)
        if clean_segs:
            transcript["segments"] = clean_segs
            transcript["text"] = " ".join(s["text"] for s in clean_segs)

    # Apply any pending edits to the saved transcript so the snapshot
    # accurately reflects what the user sees in Phase 2 right now.
    if req.edited_segments:
        segs = transcript.get("segments") or []
        for ed in req.edited_segments:
            if 0 <= ed.index < len(segs):
                new_text = (ed.text or "").strip()
                if new_text and segs[ed.index].get("text") != new_text:
                    segs[ed.index]["text"] = new_text
                    if "words" in segs[ed.index]:
                        segs[ed.index].pop("words", None)
        transcript["text"] = " ".join(s.get("text", "") for s in segs)
    elif req.edited_text and req.edited_text.strip():
        # Same proportional redistribution as the burn endpoint uses,
        # so a Plain-view edit is preserved across save/reopen.
        new_words = req.edited_text.strip().split()
        segs = transcript.get("segments") or []
        if new_words and segs:
            total_dur = max(1e-3, sum(
                max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
                for s in segs
            ))
            cursor = 0
            for s in segs:
                seg_dur = max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
                take = max(1, int(round(len(new_words) * (seg_dur / total_dur))))
                slice_words = new_words[cursor:cursor + take]
                cursor += take
                if slice_words:
                    s["text"] = " ".join(slice_words)
            if cursor < len(new_words):
                segs[-1]["text"] += " " + " ".join(new_words[cursor:])
            transcript["text"] = " ".join(s.get("text", "") for s in segs)

    # Snapshot the styling choices so the wizard can replay them.
    rec["draft_styling"] = {
        "position": req.position,
        "position_pct": req.position_pct,
        "output_orientation": req.output_orientation,
        "crop_x_offset_pct": req.crop_x_offset_pct,
        "crop_y_offset_pct": req.crop_y_offset_pct,
        # Persist keyframes as plain dicts so the JSON the frontend reads
        # back has the exact same shape it sends in. None / [] when
        # absent — the wizard treats both as "no keyframes set".
        "crop_keyframes": (
            [
                {
                    "t": float(kf.t),
                    "x": float(kf.x),
                    "y": float(kf.y),
                    "cut": bool(kf.cut),
                }
                for kf in (req.crop_keyframes or [])
            ]
            or None
        ),
        "font_size": req.font_size,
        "font_name": req.font_name,
        "font_color": req.font_color,
        "border_color": req.border_color,
        "border_width": req.border_width,
        "bg_color": req.bg_color,
        "bg_opacity": req.bg_opacity,
    }
    rec["transcript"] = transcript

    # PERSIST TO DISK so the user's edits survive a backend restart.
    # Before this line existed, /save updated only rec["transcript"] in
    # memory. When uvicorn auto-reloaded (or the container restarted)
    # between save and burn, the in-memory transcript was lost and the
    # burn endpoint fell back to the ORIGINAL Whisper transcript on
    # disk — silently burning the un-edited version. The fix: rewrite
    # the cleaned_transcript blob on every successful save, so disk +
    # memory always agree.
    try:
        _standalone_save_blob(req.job_id, "cleaned_transcript", transcript)
    except Exception as _persist_err:
        # Don't fail the save if disk write hiccups — in-memory state
        # is still correct, the user just risks losing edits on restart.
        print(f"⚠️  Could not persist saved transcript to disk for {req.job_id}: {_persist_err}")

    seg_payload = [
        {"text": (s.get("text") or "").strip(),
         "start": float(s.get("start", 0)),
         "end":   float(s.get("end", 0))}
        for s in (transcript.get("segments") or [])
    ]
    _standalone_status(
        req.job_id, "saved_draft",
        "Saved as draft. Reopen from Past Projects to keep editing.",
        result={
            "transcript_text": transcript.get("text", ""),
            "language": transcript.get("language", ""),
            "segments_count": len(seg_payload),
            "segments": seg_payload,
            "phase": 2,
            "draft_styling": rec["draft_styling"],
            "is_draft": True,
        },
    )
    return {
        "ok": True,
        "job_id": req.job_id,
        "status": "saved_draft",
    }


@app.get("/api/standalone/subtitle/{job_id}/srt")
async def standalone_subtitle_srt(job_id: str):
    """Return a downloadable SRT file built from the saved Phase-1
    transcript. Lets users export captions for use in their own editing
    app or upload directly to TikTok / YouTube.
    """
    rec = standalone_jobs.get(job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    transcript = rec.get("transcript")
    if not transcript or not transcript.get("segments"):
        raise HTTPException(409, "Transcript not ready yet — finish Phase 1 first.")

    # Build the SRT in-memory using the per-segment generator's logic.
    job_dir = rec.get("output_dir")
    srt_path = os.path.join(job_dir, f"transcript_{int(time.time())}.srt")
    ok = generate_srt_per_segment(transcript, 0.0, 1e9, srt_path)
    if not ok or not os.path.isfile(srt_path):
        raise HTTPException(500, "Failed to generate SRT.")

    from fastapi.responses import FileResponse
    return FileResponse(
        srt_path,
        media_type="application/x-subrip",
        filename=f"klipra_{job_id}.srt",
    )


# ---------- Standalone Bring-Your-Own-Lyrics alignment ----------
#
# Mirror of /api/clip/{job}/{idx}/lyrics-align but for the standalone
# subtitle workflow (the full-video one users land on from the
# "Auto Subtitle" homepage tab). Whisper runs first as normal — we
# need its word-level timings as alignment anchors. The user then
# pastes the OFFICIAL lyrics, we align line-by-line using difflib,
# and save the result as the cleaned_transcript so the burn step
# reads ground truth instead of Whisper hallucination. Critical for
# songs where Whisper misreads at every line.

class StandaloneLyricsAlignRequest(BaseModel):
    job_id: str
    lyrics: str
    keep_structure_tags: bool = False
    # Optional. When provided, after LLM alignment matches lyrics to
    # Whisper segments, the matched lyric text is translated to this
    # target language using the song-mode prompt (chorus repetition
    # preservation, crypto/finance glossary). Skips translation if
    # script_mode != 'translate' or target is empty.
    target_language: Optional[str] = None
    script_mode: Optional[str] = "auto"


@app.post("/api/standalone/subtitle/lyrics-align")
async def standalone_lyrics_align(req: StandaloneLyricsAlignRequest, request: Request):
    """Align user-provided lyrics to a standalone subtitle job's audio.

    Saves the aligned text as the job's cleaned_transcript and refreshes
    the result.segments view so the Phase 1 preview shows the user's
    own lines (not Whisper's noise) before they move to Phase 2.
    """
    rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get('kind') != 'subtitle':
        raise HTTPException(404, "Subtitle job not found")

    lyric_lines = _parse_user_lyrics(req.lyrics, keep_structure_tags=req.keep_structure_tags)
    if not lyric_lines:
        raise HTTPException(400, "No lyric lines parsed from input")

    # Build the Whisper word-timing pool. Order of preference:
    #   1. whisper_original (raw Whisper output kept from Phase 1)
    #   2. cleaned_transcript (LLM-cleaned version — has same word
    #      timings if cleanup didn't restructure, but may have fewer
    #      anchors after Roman/translate rewrites)
    whisper_src = rec.get('whisper_original')
    if not whisper_src:
        whisper_src = _standalone_load_blob(req.job_id, 'whisper_original')
    if not whisper_src:
        # Fall back to whatever the job currently considers the
        # transcript — better than nothing.
        whisper_src = rec.get('transcript') or _standalone_load_blob(req.job_id, 'cleaned_transcript')
    if not whisper_src or not whisper_src.get('segments'):
        raise HTTPException(409, "No transcript on this job yet — finish Phase 1 first.")

    whisper_words: list = []
    for seg in whisper_src.get('segments') or []:
        for w in (seg.get('words') or []):
            text = (w.get('word') or '').strip()
            if not text:
                continue
            whisper_words.append({
                'text': text,
                'start': float(w.get('start', seg.get('start', 0))),
                'end': float(w.get('end', seg.get('end', 0))),
            })
    # Synthesize word timings from segment timings if Whisper didn't
    # provide word-level data (some transcribe providers don't).
    if not whisper_words:
        for seg in whisper_src.get('segments') or []:
            seg_text = (seg.get('text') or '').strip()
            seg_words = seg_text.split()
            if not seg_words:
                continue
            s_start = float(seg.get('start', 0))
            s_end = float(seg.get('end', s_start + 1))
            per = (s_end - s_start) / max(1, len(seg_words))
            for i, sw in enumerate(seg_words):
                whisper_words.append({
                    'text': sw,
                    'start': s_start + i * per,
                    'end': s_start + (i + 1) * per,
                })

    # Flatten user lyrics into words remembering line indices.
    flat_words: list[str] = []
    word_to_line: list[int] = []
    for line_idx, line in enumerate(lyric_lines):
        for w in line.split():
            flat_words.append(w)
            word_to_line.append(line_idx)
    if not flat_words:
        raise HTTPException(400, "Lyrics had no words")

    # Pull LLM credentials from headers (the frontend sends them via
    # llmHeaders). Without these the LLM matcher is skipped.
    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or os.environ.get("GEMINI_API_KEY", "")
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None

    new_segments: list = []
    alignment_method = ''
    loop = asyncio.get_event_loop()

    # TRANSLATION — separated from alignment.
    #
    # The right architecture (per a senior code review): translate the
    # FULL lyric_lines list ONCE, upfront. Then when stamping aligned
    # segments below, use translated_lyric_lines[lyric_idx] instead
    # of lyric_lines[lyric_idx]. This guarantees:
    #   • No batching → no items dropped → every line attempted.
    #   • All chorus repeats translate to identical text (LLM sees the
    #     full song at once, recognizes the pattern).
    #   • Already-target-language lines stay verbatim because the LLM
    #     is given the whole list and can spot what's already English.
    #   • Mixing concerns is gone: alignment maps Whisper segments to
    #     LYRIC INDICES, the translation lookup is a separate step.
    #
    # Falls back gracefully: if no LLM key, no translation requested,
    # or translation errors out, translated_lyric_lines = lyric_lines
    # (unchanged), and downstream stamping still works.
    _mode = (req.script_mode or "auto").lower()
    translated_lyric_lines = list(lyric_lines)
    # KEY GUARD REMOVED for Ollama — x_llm_key is empty for local
    # models which DON'T need a key. The build_provider() inside
    # llm_translate_full_lyrics handles missing-key for cloud
    # providers gracefully (returns originals on failure). Without
    # this fix, Ollama users silently never got translation.
    _can_run_llm = (x_llm_provider == "ollama") or bool(x_llm_key)
    if _mode == "translate" and req.target_language and _can_run_llm:
        print(f"🌐 Translating {len(lyric_lines)} lyric lines to {req.target_language} BEFORE alignment…")
        try:
            translated_lyric_lines = await loop.run_in_executor(
                None,
                lambda: _llm_translate_full_lyrics(
                    lyric_lines=lyric_lines,
                    target_language=req.target_language,
                    provider_id=x_llm_provider,
                    model_name=x_llm_model,
                    api_key=x_llm_key,
                    base_url=x_llm_base_url,
                ),
            )
            # Length sanity check — the helper guarantees this but
            # double-check at the call site.
            if len(translated_lyric_lines) != len(lyric_lines):
                print(
                    f"⚠️  Translated count {len(translated_lyric_lines)} != input "
                    f"{len(lyric_lines)} — falling back to original lyrics."
                )
                translated_lyric_lines = list(lyric_lines)
        except Exception as e:
            print(f"⚠️  Full-lyrics translation failed ({e}); using original lyrics for alignment.")
            translated_lyric_lines = list(lyric_lines)

    # PRIMARY ALGORITHM — LLM SEMANTIC MATCHING with structure context.
    # The matcher reads Whisper's heard text + the user's lyrics + the
    # song's structure outline (with [Verse]/[Chorus] markers) and
    # decides which Whisper segment maps to which lyric line. Choruses
    # repeat correctly because the LLM understands repetition.
    llm_matches = None
    # Same Ollama-doesn't-need-a-key guard as the translation block above.
    # Without this, local models silently fell back to difflib alignment.
    if _can_run_llm and (whisper_src.get('segments') or []):
        try:
            # Filter Whisper segments same way the transcribe path does
            # — drop sub-0.4s blips and ad-libs.
            _filtered = []
            for seg in (whisper_src.get('segments') or []):
                text = (seg.get('text') or '').strip()
                s_start = float(seg.get('start', 0))
                s_end = float(seg.get('end', 0))
                if not text or s_end <= s_start or (s_end - s_start) < 0.4:
                    continue
                _filtered.append({"start": s_start, "end": s_end, "text": text})

            # Pre-split mega-segments — Whisper Turbo on songs with
            # heavy background music sometimes lumps a chorus + start
            # of next verse into ONE 15-25 second segment. Splitting
            # those into ~5s chunks (with [music] sentinel on the
            # later parts) lets the LLM aligner map the chorus's j
            # indices to the right time ranges instead of the whole
            # chorus getting absorbed into a neighbouring verse line.
            # max_dur=5.0 — every aligner-visible segment capped at 5s.
            # Songs benefit from finer time granularity; even non-mega
            # segments get split if they happen to be 6-9s long.
            _aligner_input = _split_whisper_mega_segments(_filtered, max_dur=5.0, sub_dur=5.0)
            if len(_aligner_input) != len(_filtered):
                print(
                    f"🪓 Split {len(_aligner_input) - len(_filtered)} mega-segment "
                    f"chunk(s) for BYOL alignment ({len(_filtered)} → {len(_aligner_input)})."
                )
            llm_matches = _llm_align_lyrics_to_whisper(
                whisper_segments=_aligner_input,
                lyric_lines=lyric_lines,
                provider_id=x_llm_provider,
                model_name=x_llm_model,
                api_key=x_llm_key,
                base_url=x_llm_base_url,
                structure_outline=req.lyrics,
            )
            # Merge consecutive same-lyric matches (Whisper splits a
            # phrase into pieces — same lyric should span all of them).
            #
            # SAFETY CAP: a single sung lyric line virtually never lasts
            # longer than ~8 seconds. When a merged span would exceed
            # this, it almost always means the LLM aligner mismapped
            # several Whisper segments to the same lyric — typically
            # a chorus block being absorbed into a neighbouring verse
            # line. Capping prevents one absurd 24-second on-screen
            # block (which is what triggered this fix); the affected
            # Whisper region becomes multiple shorter same-text blocks
            # instead, which at least keeps the timeline readable.
            MAX_MERGED_SEG_DURATION = 5.0
            merged = []
            cur_l, cur_s, cur_e = None, None, None
            absorbed_count = 0
            mismap_warnings = 0
            for w_idx, l_idx in enumerate(llm_matches or []):
                if l_idx is None:
                    if cur_l is not None:
                        merged.append((cur_l, cur_s, cur_e))
                        cur_l = None
                        absorbed_count = 0
                    continue
                # NB: read from _aligner_input — this is the array the
                # LLM was given. After the mega-segment splitter, w_idx
                # maps into _aligner_input, NOT _filtered. Using the
                # wrong array would silently take timings from the
                # mega-segment rather than the post-split chunks.
                ws = _aligner_input[w_idx]
                if cur_l == l_idx:
                    # Would extending exceed the per-line cap?
                    candidate_end = ws["end"]
                    if (candidate_end - cur_s) > MAX_MERGED_SEG_DURATION:
                        # Cap exceeded. Close the current run WITHOUT
                        # restarting with the same lyric — restarting
                        # made the same line appear twice on screen
                        # (duplicate "Decades in the making..." bug).
                        # If real audio with vocals follows, the LLM
                        # will have mapped it to a *different* lyric;
                        # if it's silence/music, leaving a gap is the
                        # right answer. Recovery pass can fill if
                        # structure says something belongs there.
                        merged.append((cur_l, cur_s, cur_e))
                        mismap_warnings += 1
                        cur_l = None
                    else:
                        cur_e = candidate_end
                        absorbed_count += 1
                else:
                    if cur_l is not None:
                        merged.append((cur_l, cur_s, cur_e))
                    cur_l = l_idx
                    cur_s = ws["start"]
                    cur_e = ws["end"]
                    absorbed_count = 1
            if cur_l is not None:
                merged.append((cur_l, cur_s, cur_e))
            if mismap_warnings:
                print(
                    f"⚠️  Lyrics-align: split {mismap_warnings} oversize merged "
                    f"segment(s) (>{MAX_MERGED_SEG_DURATION}s). Likely a chorus "
                    f"or repeat the LLM aligner failed to detect — review the "
                    f"Aligned tab for missing lines."
                )

            # RECOVERY PASS — when MiniMax / similar models silently
            # drop chorus repeats (mapping the chorus's Whisper segments
            # to a neighbouring verse line instead), the merged groups
            # will lack those chorus j indices. Detect that by counting
            # [Chorus] blocks in the structure outline vs distinct
            # chorus runs in `merged`, and inject the missing block(s)
            # into the largest unmatched time gaps.
            try:
                coverage = _verify_chorus_coverage(
                    [j for (j, _, _) in merged],
                    lyric_lines,
                    req.lyrics or "",
                )
                merged = _recover_missing_blocks(
                    merged,
                    lyric_lines,
                    req.lyrics or "",
                    whisper_segments=_aligner_input,
                    coverage=coverage,
                )
            except Exception as _rec_err:
                print(f"⚠️  Recovery pass skipped ({_rec_err}); using LLM-only matches.")

            for l_idx, s_start, s_end in merged:
                # Use the TRANSLATED lyric line if translation ran;
                # otherwise the original. Both arrays are guaranteed
                # to have len == len(lyric_lines), so indexing by
                # l_idx is always safe.
                line = translated_lyric_lines[l_idx]
                words = line.split()
                per_w = (s_end - s_start) / max(1, len(words))
                new_segments.append({
                    "text": line,
                    "start": s_start,
                    "end": s_end,
                    "words": [
                        {"word": w, "start": s_start + i * per_w, "end": s_start + (i + 1) * per_w}
                        for i, w in enumerate(words)
                    ],
                })
            # Word-chunking — split each lyric line into max 5-word
            # subtitles for readable on-screen display. A line like
            # "Boom and bust, we rise from the dust!" becomes two
            # consecutive subtitles with proportionally split timing.
            try:
                _pre = len(new_segments)
                new_segments = _chunk_segments_by_word_count(new_segments, max_words=5)
                if len(new_segments) != _pre:
                    print(
                        f"✂️  Word-split: {_pre} → {len(new_segments)} segments "
                        f"(max 5 words per subtitle)."
                    )
            except Exception as _chunk_err:
                print(f"⚠️  Word-chunking skipped ({_chunk_err}); using full-line segments.")

            if new_segments:
                alignment_method = 'llm-semantic'
                print(f"✅ Lyrics-align (LLM semantic): {len(new_segments)} segments")
        except Exception as e:
            print(f"⚠️  LLM semantic alignment failed ({e}); falling through to difflib.")

    # FALLBACK: difflib alignment for cases where LLM didn't run or
    # produced nothing usable.
    if not new_segments:
        if whisper_words:
            word_timings = _align_words_to_whisper(flat_words, whisper_words)
            alignment_method = 'difflib+interpolate'
        else:
            try:
                from subtitles import probe_media
                info = probe_media(rec.get('input_path') or '')
                dur = max(5.0, info.get('duration_s') or 60.0)
            except Exception:
                dur = 60.0
            per = dur / len(flat_words)
            word_timings = [(flat_words[i], i * per, (i + 1) * per) for i in range(len(flat_words))]
            alignment_method = 'even-distribute (no Whisper word timings)'

        line_word_groups: list[list] = [[] for _ in lyric_lines]
        for (word_text, w_start, w_end), line_idx in zip(word_timings, word_to_line):
            line_word_groups[line_idx].append({
                'word': word_text,
                'start': float(w_start),
                'end': float(w_end),
            })
        for line_idx, line_words in enumerate(line_word_groups):
            if not line_words:
                continue
            new_segments.append({
                # Use translated lyrics here too — same guarantee
                # (translated_lyric_lines has same length as lyric_lines).
                'text': translated_lyric_lines[line_idx],
                'start': min(w['start'] for w in line_words),
                'end': max(w['end'] for w in line_words),
                'words': line_words,
            })
    if not new_segments:
        raise HTTPException(500, "Aligned segments came out empty")

    aligned = {
        'language': 'mixed',
        'text': '\n'.join(s['text'] for s in new_segments),
        'segments': new_segments,
        '_user_lyrics': True,
        '_word_timings_aligned': True,
    }

    # Translation for 'translate' mode already happened UPFRONT — see
    # the full-lyrics translation block at the top of this function.
    # We deliberately DO NOT call the per-segment llm_rewrite_transcript
    # here for translate mode anymore — that was the source of the
    # "missing chorus" bug, because batched per-segment rewrites
    # collapse / drop identical chorus repeats.
    #
    # Roman script mode is the only remaining case that benefits from
    # the per-segment rewrite (transliteration is per-line, no chorus-
    # collapse risk). Keep that path intact.
    if _mode == "roman" and _can_run_llm:
        try:
            print(f"🌐 Lyrics-align: running AI roman transliteration on aligned segments…")
            aligned = _llm_rewrite_transcript(
                transcript=aligned,
                mode="roman",
                target_language=None,
                provider_id=x_llm_provider,
                model_name=x_llm_model,
                api_key=x_llm_key,
                base_url=x_llm_base_url,
            )
            # Re-affirm flags the rewrite may have lost.
            aligned["_user_lyrics"] = True
            aligned["_word_timings_aligned"] = True
        except Exception as e:
            print(f"⚠️  Lyrics-align: AI roman failed ({e}); keeping original aligned text.")

    # Replace the working transcript with the aligned ground truth.
    rec['transcript'] = aligned
    _standalone_save_blob(req.job_id, 'cleaned_transcript', aligned)
    # Refresh the result.segments view from the FINAL aligned segments
    # (which include the translation if one ran). The frontend reads
    # this to update its segments state without a page reload.
    _final_segments_for_view = aligned.get('segments') or new_segments
    rec['result'] = {
        **(rec.get('result') or {}),
        'language': aligned.get('language', 'mixed'),
        'transcript_text': aligned.get('text', ''),
        'segments': [
            {'text': s.get('text', ''), 'start': float(s.get('start', 0)), 'end': float(s.get('end', 0))}
            for s in _final_segments_for_view
        ],
    }
    _standalone_persist(req.job_id)

    # Pull final segments from `aligned` (which may have been
    # translated) so the response reflects what'll be burned.
    out_segments = aligned.get('segments') or new_segments
    return {
        'ok': True,
        'lines_count': len(out_segments),
        'words_count': sum(len(s.get('words') or []) for s in out_segments),
        'whisper_words_used': len(whisper_words),
        'alignment_method': alignment_method,
        'translated': _mode == "translate",
        'segments': [
            {'text': s.get('text', ''), 'start': float(s.get('start', 0)), 'end': float(s.get('end', 0))}
            for s in out_segments
        ],
    }


# ---------- Clip-gen SRT export (mirrors the standalone endpoint) ----------
@app.get("/api/clip/{job_id}/{clip_index}/srt-export")
async def clip_srt_export(job_id: str, clip_index: int):
    """Download the SRT for a clip-gen project's specific clip. Lets
    users save subtitles for re-use in another project (paste the file
    into the SRT-import flow, or open in their own editing tool)."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    record = jobs[job_id]
    output_dir = record.get('output_dir') or os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(404, "Metadata not found")
    with open(json_files[0], 'r') as f:
        data = json.load(f)
    clips = data.get('shorts') or []
    if not (0 <= clip_index < len(clips)):
        raise HTTPException(404, "Clip index out of range")
    clip = clips[clip_index]

    # Prefer the clip's regenerated_transcript (clip-local timing,
    # already-aligned word timings if Sync ran) over the job-level
    # full-video transcript sliced to this clip.
    saved = clip.get('regenerated_transcript')
    if saved and isinstance(saved, dict) and saved.get('segments'):
        transcript = saved
        is_clip_local = bool(saved.get('_already_clip_local'))
    else:
        transcript = data.get('transcript')
        is_clip_local = False
    if not transcript:
        raise HTTPException(409, "No transcript available — generate subtitles first.")

    srt_path = os.path.join(output_dir, f"export_{clip_index}_{int(time.time())}.srt")
    if is_clip_local:
        ok = generate_srt_per_segment(transcript, 0.0, 1e9, srt_path)
    else:
        ok = generate_srt_per_segment(
            transcript,
            float(clip.get('start', 0)),
            float(clip.get('end', 0) or 1e9),
            srt_path,
        )
    if not ok or not os.path.isfile(srt_path):
        raise HTTPException(500, "Failed to generate SRT for export.")

    from fastapi.responses import FileResponse
    return FileResponse(
        srt_path,
        media_type="application/x-subrip",
        filename=f"klipra_{job_id}_clip{clip_index + 1}.srt",
    )


# ---------- SRT import — skip Whisper, jump straight to ready-to-burn ----------
def _parse_srt_to_transcript(srt_text: str) -> dict:
    """Parse an SRT into the same transcript shape Whisper produces:
        {language, text, segments: [{start, end, text, words: [...]}]}.

    Word-level timings are synthesized by even-distribution within each
    segment — the SRT format only carries segment-level timing. Good
    enough for karaoke/word-highlight animations on imported subs.
    """
    segments = []
    full_text_parts = []
    blocks = srt_text.replace('\r\n', '\n').replace('\r', '\n').strip().split('\n\n')
    for chunk in blocks:
        lines = [ln for ln in chunk.split('\n') if ln.strip()]
        if len(lines) < 2:
            continue
        # First line MAY be the index ("1", "2", ...). Detect by looking
        # for the "-->" timing line; everything before it is the index.
        time_line_idx = None
        for i, ln in enumerate(lines):
            if '-->' in ln:
                time_line_idx = i
                break
        if time_line_idx is None:
            continue
        time_line = lines[time_line_idx]
        text_lines = lines[time_line_idx + 1:]
        if not text_lines:
            continue
        try:
            left, _, right = time_line.partition('-->')
            def parse_t(s):
                s = s.strip().replace(',', '.')
                if s.count(':') == 2:
                    h, m, sec = s.split(':')
                    return int(h) * 3600 + int(m) * 60 + float(sec)
                if s.count(':') == 1:
                    m, sec = s.split(':')
                    return int(m) * 60 + float(sec)
                return float(s)
            start = parse_t(left)
            end = parse_t(right)
        except Exception:
            continue
        text = ' '.join(text_lines).strip()
        if not text:
            continue
        words = text.split()
        seg_dur = max(0.001, end - start)
        per = seg_dur / max(1, len(words))
        word_objs = [
            {'word': w, 'start': start + i * per, 'end': start + (i + 1) * per}
            for i, w in enumerate(words)
        ]
        segments.append({
            'start': start,
            'end': end,
            'text': text,
            'words': word_objs,
        })
        full_text_parts.append(text)

    return {
        'language': 'imported',
        'text': '\n'.join(full_text_parts),
        'segments': segments,
        '_word_timings_aligned': False,  # synthetic timings
        '_imported_srt': True,
    }


@app.post("/api/standalone/subtitle/import-srt")
async def standalone_subtitle_import_srt(
    request: Request,
    file: Optional[UploadFile] = File(None),
    srt_file: Optional[UploadFile] = File(None),
    srt_text: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
):
    """Skip Whisper entirely. User uploads BOTH:
       • file       — the audio or video they want subtitles burned onto
       • srt_file   — an .srt file
         OR
       • srt_text   — the SRT contents pasted as a string
    The endpoint creates a standalone subtitle job already at the
    'transcript_ready' stage — the user goes straight to styling + burn.
    """
    if not file:
        raise HTTPException(400, "Provide a media file (audio or video).")
    raw_srt = ""
    if srt_file:
        raw_bytes = await srt_file.read()
        try:
            raw_srt = raw_bytes.decode('utf-8')
        except UnicodeDecodeError:
            try:
                raw_srt = raw_bytes.decode('latin-1')
            except Exception:
                raise HTTPException(400, "Could not decode SRT file (try UTF-8).")
    elif srt_text:
        raw_srt = srt_text
    else:
        raise HTTPException(400, "Provide either an .srt file or pasted srt_text.")

    transcript = _parse_srt_to_transcript(raw_srt)
    if not transcript.get('segments'):
        raise HTTPException(400, "SRT had no parseable segments.")

    job_id = str(uuid.uuid4())
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    os.makedirs(job_dir, exist_ok=True)
    standalone_jobs[job_id] = {
        "status": "queued",
        "kind": "subtitle",
        "logs": ["SRT-import job queued.", "Skipping Whisper — using imported subtitles."],
        "output_dir": job_dir,
        "result": None,
        "transcript": transcript,
        "input_path": None,
        "created_at": time.time(),
        "title": (title or file.filename or "Imported subtitles"),
    }

    # Persist the media via the same dedup helper as the regular flow.
    input_path = _standalone_save_upload(file, job_id)
    standalone_jobs[job_id]["input_path"] = input_path

    # Save the imported transcript as our "cleaned" checkpoint so future
    # restarts / regenerate / sync calls all see it as ground truth.
    _standalone_save_blob(job_id, "cleaned_transcript", transcript)

    # Move the job directly to transcript_ready — no Whisper run, no
    # LLM cleanup, the user just clicks Burn.
    _standalone_status(job_id, "transcript_ready", "Imported subtitles ready to burn.")
    standalone_jobs[job_id]["result"] = {
        "language": "imported",
        "transcript_text": transcript.get("text", ""),
        "segments": [
            {
                "text": s.get("text", ""),
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
            }
            for s in transcript.get("segments", [])
        ],
    }
    _standalone_persist(job_id)

    return {"job_id": job_id, "status": "transcript_ready", "imported_segments": len(transcript['segments'])}


# ---------- Stock backgrounds catalog ----------
@app.get("/api/stock-backgrounds/list")
async def list_stock_backgrounds():
    """Return the stock background catalog. Frontend renders the picker
    grid from this. Tier filtering ('free' vs 'pro') happens client-side
    so the UI can show locked previews with an upgrade CTA."""
    from stock_backgrounds import STOCK_BACKGROUNDS
    # Strip the FFmpeg recipe — it's a server-side concern, not data
    # the client needs. The id alone is sufficient for the change-bg
    # endpoint to look it up.
    return {
        "backgrounds": [
            {k: v for k, v in entry.items() if k != 'lavfi'}
            for entry in STOCK_BACKGROUNDS
        ]
    }


# ---------- Change-background endpoint ----------
class StandaloneChangeBackgroundRequest(BaseModel):
    job_id: str
    # Choose ONE of:
    stock_id: Optional[str] = None
    # Or, the client uploads a file — handled below as a multipart endpoint
    # variant. (We expose two endpoints: this Pydantic-JSON one for stock,
    # and a second multipart one for uploaded backgrounds.)

    # When True with a NEW uploaded video that has audio, that audio
    # replaces the original transcribed audio (this is the song flow:
    # vocals were uploaded just for clean transcription, the new full
    # mix takes over). When False (or new bg has no audio), the original
    # audio stays.
    replace_audio_with_new: Optional[bool] = True
    # Burn-time styling — if omitted the previous burn's choices are
    # reused (we cache them on the job after each burn). Provided here
    # so a single endpoint covers "just swap bg" AND "swap bg + tweak
    # styling" without two round-trips.
    font_size: Optional[int] = None
    font_name: Optional[str] = None
    font_color: Optional[str] = None
    border_color: Optional[str] = None
    border_width: Optional[int] = None
    bg_color: Optional[str] = None
    bg_opacity: Optional[float] = None
    position: Optional[str] = None
    position_pct: Optional[float] = None
    animation: Optional[str] = None
    highlight_color: Optional[str] = None


def _last_burn_settings(rec: dict) -> dict:
    """Pull the most recent burn-style settings the user committed for
    this job, so change-background can re-burn with the same look
    unless the request overrides specific fields."""
    return rec.get('last_burn_settings') or {}


def _resolve_burn_setting(req_value, fallback_value, default_value):
    """Three-way fallback: explicit request value > saved last-burn
    value > module default. Pydantic optional fields come through as
    None if the client didn't send them."""
    if req_value is not None:
        return req_value
    if fallback_value is not None:
        return fallback_value
    return default_value


def _change_background_core(rec: dict,
                            new_video_path: str,
                            replace_audio_with_new: bool,
                            settings: dict) -> dict:
    """Heavy lifting for the change-background flow. Steps:
       1. Determine final video path (the new bg) and final audio path
          (new bg's audio OR the original input's audio).
       2. Mux video frames + chosen audio into a temp working video.
       3. Re-burn the cached subtitles + chosen styling onto that.
       4. Persist the result + return job-shaped status payload.

    Common to both stock and uploaded backgrounds.
    """
    from subtitles import (
        burn_subtitles as _burn,
        probe_media as _probe,
        replace_video_audio as _swap_audio,
    )

    job_id = rec.get('id') or rec.get('job_id') or 'unknown'
    job_dir = rec['output_dir']
    transcript = rec.get('transcript')
    if not transcript or not transcript.get('segments'):
        # Recover from the on-disk blob if memory was wiped.
        loaded = _standalone_load_blob(job_id, 'cleaned_transcript')
        if loaded:
            transcript = loaded
            rec['transcript'] = transcript
    if not transcript:
        raise HTTPException(409, "No transcript available for this job.")

    original_input = rec.get('input_path')
    if not original_input or not os.path.isfile(original_input):
        raise HTTPException(409, "Original audio/video for this job is missing.")

    # Decide audio source.
    new_info = _probe(new_video_path)
    use_new_audio = bool(replace_audio_with_new and new_info['has_audio'])
    audio_source = new_video_path if use_new_audio else original_input

    # Build a working source video: new visual frames + chosen audio.
    work_path = os.path.join(job_dir, f"bg_swap_{int(time.time())}.mp4")
    if use_new_audio:
        # Copy the new file into the job dir under a stable name so the
        # cleanup logic doesn't reach into UPLOAD_DIR. Re-encode is
        # avoided when codecs already match.
        if not _swap_audio(new_video_path, new_video_path, work_path):
            raise HTTPException(500, "Failed to mux new background.")
    else:
        # New visuals + original audio. The original may be audio-only
        # (no video stream), in which case we just need to take its
        # audio and the new bg's video.
        if not _swap_audio(new_video_path, original_input, work_path):
            raise HTTPException(500, "Failed to mux new background with original audio.")

    # Re-burn subtitles on top of the new working video.
    cache_bust = int(time.time() * 1000)
    srt_path = os.path.join(job_dir, f"bgswap_{cache_bust}.srt")
    output_path = os.path.join(job_dir, f"subtitled_bgswap_{cache_bust}.mp4")
    ok = generate_srt_per_segment(transcript, 0.0, 1e9, srt_path)
    if not ok:
        raise HTTPException(500, "Failed to (re-)generate SRT for change-background.")

    _burn(
        work_path, srt_path, output_path,
        alignment=settings['position'],
        fontsize=settings['font_size'],
        font_name=settings['font_name'],
        font_color=settings['font_color'],
        border_color=settings['border_color'],
        border_width=settings['border_width'],
        bg_color=settings['bg_color'],
        bg_opacity=settings['bg_opacity'],
        position_pct=settings.get('position_pct'),
        animation=settings.get('animation', 'none'),
        highlight_color=settings.get('highlight_color', '#FFDD00'),
    )

    # Persist the new burn as the current result.
    rec['result'] = {**(rec.get('result') or {}),
                     'video_url': f"/videos/standalone/{job_id}/{os.path.basename(output_path)}",
                     'video_filename': os.path.basename(output_path)}
    rec['last_burn_settings'] = settings
    _standalone_status(job_id, "completed", "Background swapped + subtitles re-burned.")
    _standalone_persist(job_id)
    return {"ok": True,
            "video_url": rec['result']['video_url'],
            "audio_replaced": use_new_audio}


@app.post("/api/standalone/{job_id}/change-background-stock")
async def standalone_change_background_stock(job_id: str, req: StandaloneChangeBackgroundRequest):
    """Re-burn the existing subtitles on a STOCK background (lavfi-
    rendered on demand)."""
    rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "Job not found")
    rec.setdefault('id', job_id)
    if not req.stock_id:
        raise HTTPException(400, "stock_id is required for stock backgrounds.")
    from stock_backgrounds import get_stock_by_id, render_stock_lavfi
    from subtitles import probe_media, make_lavfi_video
    entry = get_stock_by_id(req.stock_id)
    if not entry:
        raise HTTPException(404, f"Stock background '{req.stock_id}' not found.")

    # Generate the stock as a temp video the same length as the input audio.
    original_input = rec.get('input_path')
    if not original_input or not os.path.isfile(original_input):
        raise HTTPException(409, "Original audio for this job is missing.")
    info = probe_media(original_input)
    duration = info['duration_s'] or 60.0
    width = 1080
    height = 1920
    lavfi = render_stock_lavfi(entry, width, height, duration)
    bg_path = os.path.join(rec['output_dir'], f"stock_{req.stock_id}_{int(time.time())}.mp4")
    if not make_lavfi_video(lavfi, original_input, bg_path):
        raise HTTPException(500, "Failed to render stock background.")

    last = _last_burn_settings(rec)
    settings = {
        'position': _resolve_burn_setting(req.position, last.get('position'), 'bottom'),
        'position_pct': _resolve_burn_setting(req.position_pct, last.get('position_pct'), None),
        'font_size': _resolve_burn_setting(req.font_size, last.get('font_size'), 64),
        'font_name': _resolve_burn_setting(req.font_name, last.get('font_name'), 'Verdana'),
        'font_color': _resolve_burn_setting(req.font_color, last.get('font_color'), '#FFFFFF'),
        'border_color': _resolve_burn_setting(req.border_color, last.get('border_color'), '#000000'),
        'border_width': _resolve_burn_setting(req.border_width, last.get('border_width'), 2),
        'bg_color': _resolve_burn_setting(req.bg_color, last.get('bg_color'), '#000000'),
        'bg_opacity': _resolve_burn_setting(req.bg_opacity, last.get('bg_opacity'), 0.0),
        'animation': _resolve_burn_setting(req.animation, last.get('animation'), 'none'),
        'highlight_color': _resolve_burn_setting(req.highlight_color, last.get('highlight_color'), '#FFDD00'),
    }
    return _change_background_core(rec, bg_path, replace_audio_with_new=False, settings=settings)


@app.post("/api/standalone/{job_id}/change-background-upload")
async def standalone_change_background_upload(
    job_id: str,
    bg_file: UploadFile = File(...),
    replace_audio_with_new: bool = Form(True),
    # Same styling fields available as Form params (multipart can't
    # carry a Pydantic JSON body alongside a file).
    font_size: Optional[int] = Form(None),
    font_name: Optional[str] = Form(None),
    font_color: Optional[str] = Form(None),
    border_color: Optional[str] = Form(None),
    border_width: Optional[int] = Form(None),
    bg_color: Optional[str] = Form(None),
    bg_opacity: Optional[float] = Form(None),
    position: Optional[str] = Form(None),
    position_pct: Optional[float] = Form(None),
    animation: Optional[str] = Form(None),
    highlight_color: Optional[str] = Form(None),
):
    """Re-burn the existing subtitles on a USER-UPLOADED background.
    If the upload has audio AND replace_audio_with_new=True (default),
    the new audio takes over from the original transcribed audio —
    this is the vocals-first → final-mix song flow.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "Job not found")
    rec.setdefault('id', job_id)

    # Persist the uploaded background via dedup so re-uploading the
    # same file twice doesn't double-store it.
    bg_path = _save_upload_dedup(bg_file, f"{job_id}_bg")

    last = _last_burn_settings(rec)
    settings = {
        'position': _resolve_burn_setting(position, last.get('position'), 'bottom'),
        'position_pct': _resolve_burn_setting(position_pct, last.get('position_pct'), None),
        'font_size': _resolve_burn_setting(font_size, last.get('font_size'), 64),
        'font_name': _resolve_burn_setting(font_name, last.get('font_name'), 'Verdana'),
        'font_color': _resolve_burn_setting(font_color, last.get('font_color'), '#FFFFFF'),
        'border_color': _resolve_burn_setting(border_color, last.get('border_color'), '#000000'),
        'border_width': _resolve_burn_setting(border_width, last.get('border_width'), 2),
        'bg_color': _resolve_burn_setting(bg_color, last.get('bg_color'), '#000000'),
        'bg_opacity': _resolve_burn_setting(bg_opacity, last.get('bg_opacity'), 0.0),
        'animation': _resolve_burn_setting(animation, last.get('animation'), 'none'),
        'highlight_color': _resolve_burn_setting(highlight_color, last.get('highlight_color'), '#FFDD00'),
    }
    return _change_background_core(rec, bg_path, replace_audio_with_new=replace_audio_with_new, settings=settings)


class StandaloneRegenerateRequest(BaseModel):
    job_id: str
    # Optional override: re-run cleanup with a different mode / target
    # language than Phase 1 used. Defaults fall back to the original choice.
    script_mode: Optional[str] = None
    target_language: Optional[str] = None


@app.post("/api/standalone/subtitle/regenerate")
async def standalone_subtitle_regenerate(
    req: StandaloneRegenerateRequest,
    request: Request,
):
    """Re-run the AI cleanup pass against the ORIGINAL Whisper transcript
    saved from Phase 1. Cheap (no re-transcription) — just pushes the raw
    audio words back through the LLM with the user's chosen mode. Returns
    the new transcript text + segments via the standard status endpoint.
    """
    rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    whisper_orig = rec.get("whisper_original")
    if not whisper_orig:
        # Fall back to the on-disk checkpoint — older jobs that
        # finished before checkpointing was added won't have one,
        # but new jobs always will.
        whisper_orig = _standalone_load_blob(req.job_id, "whisper_original")
        if whisper_orig:
            rec["whisper_original"] = whisper_orig
    if not whisper_orig:
        raise HTTPException(
            409,
            "No saved Whisper transcript for this job — regenerate "
            "needs the original audio words.",
        )

    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None

    # Mode/target default to whatever the user chose in Phase 1 unless
    # this request explicitly overrides them.
    saved_opts = rec.get("cleanup_opts") or {}
    mode = (req.script_mode or saved_opts.get("script_mode") or "auto").lower()
    target = (
        req.target_language
        or saved_opts.get("target_language")
        or ""
    )
    cleanup_mode = "cleanup" if mode == "auto" else mode

    async def run():
        try:
            _standalone_status(
                req.job_id, "cleaning",
                f"Regenerating transcript (mode={mode})…",
            )
            loop = asyncio.get_event_loop()
            new_transcript = await loop.run_in_executor(
                None,
                lambda: _llm_rewrite_transcript(
                    transcript=copy.deepcopy(whisper_orig),
                    mode=cleanup_mode,
                    target_language=(target if mode == "translate" else None),
                    provider_id=x_llm_provider,
                    model_name=x_llm_model,
                    api_key=x_llm_key,
                    base_url=x_llm_base_url,
                ),
            )
            # Apply the same single-line split to regenerated output
            # so the editor stays consistent with the initial Phase 1.
            # SKIP for BYOL — user's lyrics are already line-shaped.
            if not new_transcript.get("_user_lyrics"):
                new_transcript["segments"] = _split_long_segments(
                    new_transcript.get("segments") or []
                )
            standalone_jobs[req.job_id]["transcript"] = new_transcript
            _standalone_save_blob(req.job_id, "cleaned_transcript", new_transcript)
            seg_payload = [
                {
                    "text": (s.get("text") or "").strip(),
                    "start": float(s.get("start", 0)),
                    "end": float(s.get("end", 0)),
                }
                for s in (new_transcript.get("segments") or [])
            ]
            _standalone_status(
                req.job_id, "transcript_ready",
                "Regeneration done — review the new transcript.",
                result={
                    "transcript_text": new_transcript.get("text", ""),
                    "language": new_transcript.get("language", ""),
                    "segments_count": len(seg_payload),
                    "segments": seg_payload,
                    "phase": 1,
                },
            )
        except Exception as e:
            print(f"❌ Standalone subtitle regenerate failed ({req.job_id}): {e}")
            _standalone_status(req.job_id, "failed", f"Error in regenerate: {e}")

    asyncio.create_task(run())
    return {"job_id": req.job_id, "status": "cleaning"}


class StandaloneSyncRequest(BaseModel):
    job_id: str
    # Text to align — typically what the user has in their Phase-1 editor
    # right now. If omitted we use the saved cleaned transcript text.
    edited_text: Optional[str] = None


@app.post("/api/standalone/subtitle/sync")
async def standalone_subtitle_sync(req: StandaloneSyncRequest):
    """Refine word-level timings WITHIN each user segment using the
    saved Whisper word timestamps as ground truth — without ever moving
    words across segment boundaries.

    History: the previous version did a global word alignment and then
    re-grouped words into segments based on aligned timings. That
    silently shuffled words across segments when alignment was even
    slightly off, and it fell back to "spread the words evenly across
    the whole audio" when the user's text was Romanized / translated /
    in a different script — making the result much worse than the
    per-segment timing the user already had.

    New behaviour:
      1. Confirm the saved Whisper transcript actually has word-level
         timestamps. If not, sync is a no-op (segment timings are
         already as accurate as we can be) — return applied=False.
      2. Compute a global match rate between the user's text and
         Whisper's words. If it's below threshold the texts are
         essentially in different languages/scripts — return
         applied=False with a clear explanation, don't touch the
         transcript.
      3. For each USER segment, find Whisper words whose times fall
         in that segment's range. Run difflib alignment LOCALLY for
         that segment. If the local alignment is sane (timings
         monotonic, within range) use the per-word timings; otherwise
         fall back to even distribution within the segment time range.
      4. Snapshot the pre-sync transcript so the user can undo if the
         result still looks wrong.

    The user's segment text + boundaries are always preserved. Sync
    only ever IMPROVES word-level timing accuracy — it cannot make
    things worse than they were before the call.
    """
    rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    whisper_orig = rec.get("whisper_original")
    if not whisper_orig or not whisper_orig.get("segments"):
        raise HTTPException(
            409,
            "No saved Whisper transcript for this job — sync is only "
            "available right after Phase 1 finishes.",
        )

    user_transcript = rec.get("transcript") or {}
    user_segments_in = user_transcript.get("segments") or []
    if not user_segments_in:
        raise HTTPException(409, "No segments to sync.")

    # Work on deep copies so a partial / aborted sync can't mutate
    # the live transcript.
    user_segments = copy.deepcopy(user_segments_in)

    # Optional: apply caller-supplied edited_text via proportional
    # redistribution before alignment (so users who edited in Plain
    # view see their text reflected in the synced output).
    edited_text = (req.edited_text or "").strip()
    if edited_text:
        new_words = edited_text.split()
        total_dur = max(1e-3, sum(
            max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
            for s in user_segments
        ))
        cursor = 0
        for s in user_segments:
            seg_dur = max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
            take = max(1, int(round(len(new_words) * (seg_dur / total_dur))))
            slice_words = new_words[cursor:cursor + take]
            cursor += take
            if slice_words:
                s["text"] = " ".join(slice_words)
        if cursor < len(new_words) and user_segments:
            user_segments[-1]["text"] = (
                (user_segments[-1].get("text") or "")
                + " " + " ".join(new_words[cursor:])
            )

    # Flatten Whisper words with their times.
    all_whisper_words: List[Dict[str, Any]] = []
    has_real_word_timings = False
    for seg in whisper_orig.get("segments") or []:
        seg_words = seg.get("words") or []
        if seg_words:
            has_real_word_timings = True
        for w in seg_words:
            t = (w.get("word") or "").strip()
            if not t:
                continue
            all_whisper_words.append({
                "text": t,
                "start": float(w.get("start", seg.get("start", 0))),
                "end": float(w.get("end", seg.get("end", 0))),
            })

    user_segments_for_payload = lambda segs: [
        {"text": (s.get("text") or "").strip(),
         "start": float(s.get("start", 0)),
         "end":   float(s.get("end", 0))}
        for s in segs
    ]

    if not has_real_word_timings or not all_whisper_words:
        # No word-level timestamps to align against — there's nothing
        # we can improve. Don't touch the transcript.
        return {
            "ok": True,
            "applied": False,
            "reason": "no_word_timings",
            "message": (
                "Your transcript doesn't have word-level audio timings to "
                "align against — the original transcription only stored "
                "segment-level timing. Your existing per-segment subtitles "
                "will still display correctly."
            ),
            "segments": user_segments_for_payload(user_segments_in),
            "text": user_transcript.get("text", ""),
        }

    # Quick global match-rate sanity check before doing per-segment work.
    all_user_words: List[str] = []
    for s in user_segments:
        all_user_words.extend((s.get("text") or "").split())
    if not all_user_words:
        raise HTTPException(400, "Edited text is empty.")
    user_norm = [_normalize_word_for_match(w) for w in all_user_words]
    whisper_norm = [_normalize_word_for_match(w["text"]) for w in all_whisper_words]
    import difflib as _difflib
    matcher = _difflib.SequenceMatcher(None, user_norm, whisper_norm, autojunk=False)
    total_matched = sum(b.size for b in matcher.get_matching_blocks())
    match_rate = total_matched / max(1, len(all_user_words))

    MIN_MATCH_RATE = 0.40
    if match_rate < MIN_MATCH_RATE:
        return {
            "ok": True,
            "applied": False,
            "reason": "low_match_rate",
            "match_rate": round(match_rate, 2),
            "message": (
                f"Sync would make timing worse here — only "
                f"{int(round(match_rate * 100))}% of your transcript text "
                "matches the audio words. This usually happens when the "
                "transcript was Romanized (e.g. Roman Urdu / Hinglish), "
                "translated, or heavily rewritten. Your existing "
                "per-segment timings will still produce accurate subtitles. "
                "Use the Timed view to fix any specific lines manually."
            ),
            "segments": user_segments_for_payload(user_segments_in),
            "text": user_transcript.get("text", ""),
        }

    # OK — alignment quality is good enough to be useful. Refine
    # word-level timings within each user segment.
    SLACK = 0.3  # seconds — Whisper word boundaries can spill slightly
    synced_segments: List[Dict[str, Any]] = []
    for u_seg in user_segments:
        u_start = float(u_seg.get("start", 0))
        u_end = float(u_seg.get("end", u_start + 1))
        u_text = (u_seg.get("text") or "").strip()
        u_words = u_text.split()
        if not u_words:
            continue

        # Default per-word timings: even distribution within the
        # segment. Always usable as a fallback.
        per_dur = (u_end - u_start) / max(1, len(u_words))
        per_word_timings = [
            {
                "word": u_words[i],
                "start": u_start + i * per_dur,
                "end": min(u_end, u_start + (i + 1) * per_dur),
            }
            for i in range(len(u_words))
        ]

        # Try local alignment — only if any Whisper words actually
        # fall in this segment's time range (with slack).
        seg_whisper = [
            w for w in all_whisper_words
            if w["end"] >= u_start - SLACK and w["start"] <= u_end + SLACK
        ]
        if seg_whisper:
            try:
                aligned = _align_words_to_whisper(u_words, seg_whisper)
            except Exception as e:
                print(f"⚠️  Local sync alignment failed for segment: {e}")
                aligned = None

            if aligned:
                # Sanity-check the alignment: monotonic, within segment
                # range. If anything looks off, fall back to even.
                ok = True
                last_end = u_start - 0.01
                for _t, w_start, w_end in aligned:
                    if w_end < w_start:
                        ok = False; break
                    if w_start < u_start - SLACK or w_end > u_end + SLACK:
                        ok = False; break
                    if w_start < last_end - 0.05:
                        ok = False; break
                    last_end = w_end
                if ok:
                    per_word_timings = [
                        {
                            "word": t,
                            "start": max(u_start, float(s)),
                            "end":   min(u_end,   float(e)),
                        }
                        for t, s, e in aligned
                    ]

        # Refine segment start/end based on the first / last actually-
        # aligned word audio. Only nudge by a sensible amount (max 0.4s
        # in either direction) so an outlier alignment can't blow up
        # the segment timing. The 0.1s lead-in / hold-out makes the
        # subtitle feel natural rather than snapping cold to the
        # waveform edges.
        refined_start = u_start
        refined_end = u_end
        if per_word_timings:
            try:
                fw_start = float(per_word_timings[0].get("start", u_start))
                lw_end = float(per_word_timings[-1].get("end", u_end))
                # Lead-in / hold-out padding for readability.
                cand_start = max(0.0, fw_start - 0.10)
                cand_end = lw_end + 0.10
                # Cap drift from the user's existing segment timing so
                # a bad word alignment can't shift things by seconds.
                MAX_DRIFT = 0.40
                refined_start = max(u_start - MAX_DRIFT,
                                    min(u_start + MAX_DRIFT, cand_start))
                refined_end = max(u_end - MAX_DRIFT,
                                  min(u_end + MAX_DRIFT, cand_end))
                # Refuse to shrink below 0.3s.
                if refined_end - refined_start < 0.3:
                    refined_start, refined_end = u_start, u_end
            except Exception:
                refined_start, refined_end = u_start, u_end

        synced_segments.append({
            "text": u_text,             # PRESERVE user's per-segment text
            "start": refined_start,     # SUBTLY refined toward the audio
            "end": refined_end,
            "words": per_word_timings,  # kept for future word-level views
        })

    if not synced_segments:
        return {
            "ok": True,
            "applied": False,
            "reason": "empty",
            "message": "Nothing to sync.",
            "segments": user_segments_for_payload(user_segments_in),
            "text": user_transcript.get("text", ""),
        }

    # Snapshot the pre-sync state so the user can undo. Only stash
    # the original (we don't snapshot multiple sync runs).
    if "pre_sync_transcript" not in rec or not rec.get("pre_sync_transcript"):
        rec["pre_sync_transcript"] = copy.deepcopy(user_transcript)

    synced_transcript = {
        "language": (
            user_transcript.get("language")
            or whisper_orig.get("language")
            or ""
        ),
        "text": " ".join(s["text"] for s in synced_segments),
        "segments": synced_segments,
        "_word_timings_aligned": True,
    }
    standalone_jobs[req.job_id]["transcript"] = synced_transcript

    seg_payload = [
        {"text": s["text"], "start": s["start"], "end": s["end"]}
        for s in synced_segments
    ]
    _standalone_status(
        req.job_id, "transcript_ready",
        f"Sync done — {len(synced_segments)} segments refined "
        f"({int(round(match_rate * 100))}% word match).",
        result={
            "transcript_text": synced_transcript["text"],
            "language": synced_transcript["language"],
            "segments_count": len(synced_segments),
            "segments": seg_payload,
            "phase": 1,
            "synced": True,
            "can_undo": True,
        },
    )
    return {
        "ok": True,
        "applied": True,
        "match_rate": round(match_rate, 2),
        "language": synced_transcript["language"],
        "text": synced_transcript["text"],
        "segments": seg_payload,
        "segment_count": len(synced_segments),
        "can_undo": True,
        "alignment_method": "per-segment difflib + fallback",
    }


class StandaloneUndoSyncRequest(BaseModel):
    job_id: str


@app.post("/api/standalone/subtitle/undo-sync")
async def standalone_subtitle_undo_sync(req: StandaloneUndoSyncRequest):
    """Restore the transcript snapshot taken right before the most
    recent sync. Lets the user back out of a sync that didn't help."""
    rec = standalone_jobs.get(req.job_id)
    if not rec or rec.get("kind") != "subtitle":
        raise HTTPException(404, "Subtitle job not found")
    pre = rec.get("pre_sync_transcript")
    if not pre:
        raise HTTPException(409, "Nothing to undo — no pre-sync snapshot saved.")
    rec["transcript"] = pre
    rec["pre_sync_transcript"] = None

    seg_payload = [
        {
            "text": (s.get("text") or "").strip(),
            "start": float(s.get("start", 0)),
            "end": float(s.get("end", 0)),
        }
        for s in (pre.get("segments") or [])
    ]
    _standalone_status(
        req.job_id, "transcript_ready",
        "Sync undone — restored previous transcript.",
        result={
            "transcript_text": pre.get("text", ""),
            "language": pre.get("language", ""),
            "segments_count": len(seg_payload),
            "segments": seg_payload,
            "phase": 1,
            "synced": False,
            "can_undo": False,
        },
    )
    return {
        "ok": True,
        "segments": seg_payload,
        "text": pre.get("text", ""),
    }


# ---------- Standalone Dub ----------

@app.post("/api/standalone/dub")
async def standalone_dub(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    target_language: str = Form(...),                # ISO code: 'es','fr','en'…
    transcribe_provider: Optional[str] = Form("whisper"),
    source_language: Optional[str] = Form(""),
    dub_provider: Optional[str] = Form("edge"),       # 'edge' | 'elevenlabs'
    voice_gender: Optional[str] = Form("auto"),
    keep_original: Optional[bool] = Form(False),
    original_volume: Optional[float] = Form(0.2),
    # Output orientation. 'original' (default) keeps the source aspect.
    # 'vertical' produces 9:16 by cropping wider sources horizontally.
    # 'horizontal' produces 16:9 by cropping taller sources vertically.
    # crop_x_offset_pct / crop_y_offset_pct control where the crop
    # window sits — 50 = centre, 0 = far left/top, 100 = far right/bottom.
    output_orientation: Optional[str] = Form("original"),
    crop_x_offset_pct: Optional[float] = Form(50.0),
    crop_y_offset_pct: Optional[float] = Form(50.0),
    # Optional keyframed crop. JSON-encoded list of {t,x,y,cut} entries.
    # When non-empty AND output_orientation != 'original', the dub video
    # is cropped via reframe_kf.py (panning/cutting through the user's
    # picks) instead of the static x/y offsets — same machinery the
    # subtitle burn already supports.
    crop_keyframes: Optional[str] = Form(None),
    # When true, after the dub renders we transcribe the DUBBED audio
    # and burn matching subtitles onto the output. The dubbed audio is
    # in the target language, so the subtitles are too — single-step
    # "Spanish dub + Spanish captions" without the user having to
    # bounce through Auto Subtitle afterwards.
    burn_subtitles_in_target_lang: Optional[bool] = Form(False),
    # Subtitle styling — same parameter shape as the Auto Subtitle
    # Phase 2 burn endpoint, so a user who likes a particular look in
    # Auto Subtitle can replicate it inside Dubbing without learning
    # new controls. All optional with sensible defaults that match
    # subtitle's defaults.
    subtitle_font_name: Optional[str] = Form("Verdana"),
    subtitle_font_size: Optional[int] = Form(32),
    subtitle_font_color: Optional[str] = Form("#FFFFFF"),
    subtitle_border_color: Optional[str] = Form("#000000"),
    subtitle_border_width: Optional[int] = Form(2),
    subtitle_bg_color: Optional[str] = Form("#000000"),
    subtitle_bg_opacity: Optional[float] = Form(0.0),
    subtitle_position_pct: Optional[float] = Form(85.0),
):
    """Dub the user's WHOLE video into another language. Accepts either
    a file upload or a URL (yt-dlp downloads it server-side)."""
    if not file and not (url and url.strip()):
        raise HTTPException(400, "Provide either a video file or a URL.")
    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None
    x_eleven_key = request.headers.get("X-ElevenLabs-Key") or ""

    if dub_provider == "elevenlabs" and not x_eleven_key:
        raise HTTPException(400, "ElevenLabs dubbing requires an X-ElevenLabs-Key header.")

    job_id = str(uuid.uuid4())
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    os.makedirs(job_dir, exist_ok=True)
    if file:
        title_source = file.filename or "Untitled dub"
    else:
        title_source = (url or "URL dub").strip()[:120]
    standalone_jobs[job_id] = {
        "status": "queued",
        "kind": "dub",
        "logs": ["Job queued."],
        "output_dir": job_dir,
        "result": None,
        "created_at": time.time(),
        "title": f"{title_source} → {target_language}",
    }
    if file:
        input_path = _standalone_save_upload(file, job_id)
    else:
        try:
            from main import download_url_video
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            input_path, fetched_title = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: download_url_video(url.strip(), UPLOAD_DIR),
            )
            if fetched_title:
                standalone_jobs[job_id]["title"] = f"{fetched_title} → {target_language}"
        except Exception as e:
            standalone_jobs.pop(job_id, None)
            try:
                shutil.rmtree(job_dir, ignore_errors=True)
            except Exception:
                pass
            raise HTTPException(400, str(e))
    _standalone_persist(job_id)

    async def run():
        try:
            _standalone_status(job_id, "transcribing", "Stage 1: transcribing audio…")
            os.environ["OPENSHORTS_TRANSCRIBE_PROVIDER"] = transcribe_provider or "whisper"
            os.environ["OPENSHORTS_TRANSCRIPT_LANG"] = source_language or ""
            if x_eleven_key:
                os.environ["OPENSHORTS_ELEVENLABS_KEY"] = x_eleven_key
            from main import transcribe_video
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_video, input_path)
            if not transcript or not transcript.get("segments"):
                raise RuntimeError("No segments returned from transcription.")
            transcript_text = (transcript.get("text") or "").strip()
            # Checkpoint after transcription so a later-stage failure
            # (LLM timeout, TTS connection drop, container restart)
            # doesn't cost the user another transcribe pass.
            standalone_jobs[job_id]["whisper_original"] = transcript
            _standalone_save_blob(job_id, "whisper_original", transcript)
            dub_opts = {
                "target_language": target_language,
                "source_language": source_language or "",
                "transcribe_provider": transcribe_provider or "whisper",
                "dub_provider": dub_provider or "edge",
                "voice_gender": voice_gender or "auto",
                "keep_original": keep_original,
                "original_volume": original_volume,
                "output_orientation": output_orientation or "original",
                "crop_x_offset_pct": crop_x_offset_pct or 50.0,
                "crop_y_offset_pct": crop_y_offset_pct or 50.0,
            }
            standalone_jobs[job_id]["dub_opts"] = dub_opts
            _standalone_save_blob(job_id, "dub_opts", dub_opts)

            _standalone_status(job_id, "translating", "Stage 2: translating with AI…")
            from llm import build_provider
            try:
                provider = build_provider(
                    x_llm_provider, x_llm_model, x_llm_key, base_url=x_llm_base_url
                )
            except Exception as e:
                raise RuntimeError(f"Could not build LLM provider for translation: {e}")

            from prompt_rules import USER_TEXT_RULES
            from dub_edge import LANGUAGE_NAMES
            target_name = LANGUAGE_NAMES.get(target_language, target_language)

            translation_resp = provider.complete_json(
                f"You are a subtitle translator. Translate the user's text to {target_name}. "
                f"Keep tone and length close to the original — these are spoken subtitles, "
                f"so the translation should sound natural read aloud. "
                f"Use full-clip context to fix obvious Whisper errors before translating "
                f"(e.g. \"trail\" in a trading video → translate it as \"trade\").\n\n"
                f"{USER_TEXT_RULES}\n\n"
                f'Return ONLY this JSON: {{"translation": "<translated text>"}}.',
                transcript_text,
                max_tokens=8192,
            )
            translated_text = ""
            if isinstance(translation_resp, dict):
                translated_text = (translation_resp.get("translation") or "").strip()
            elif isinstance(translation_resp, str):
                translated_text = translation_resp.strip()
            if not translated_text:
                raise RuntimeError("LLM returned empty translation.")
            # Checkpoint the translation. TTS is the most fragile stage
            # of the pipeline (long-running, depends on external API or
            # subprocess). Saving here lets resume re-do JUST the
            # synthesis if the user's connection drops between stages.
            standalone_jobs[job_id]["translated_text"] = translated_text
            _standalone_save_blob(job_id, "translated_text", {"text": translated_text})

            _standalone_status(job_id, "rendering", "Stage 3: synthesising voice + muxing…")
            output_filename = f"dubbed_{target_language}_{int(time.time())}.mp4"
            output_path = os.path.join(job_dir, output_filename)
            keep_vol = float(original_volume or 0.0) if keep_original else 0.0

            # If the user picked an orientation different from the
            # source aspect, pre-crop the video so the dubbed output
            # comes out in the requested aspect ratio. Two crop paths:
            #
            #  - KEYFRAMED: when crop_keyframes was provided, pan/cut
            #    through the user's picks via reframe_kf.py — same
            #    machinery the subtitle burn uses.
            #  - STATIC: classic single x/y offset.
            video_for_dub = input_path
            if output_orientation and output_orientation != "original":
                # Try to parse crop_keyframes (sent as a JSON-encoded
                # string in the form payload). Empty / null = static.
                parsed_kfs = []
                if crop_keyframes:
                    try:
                        parsed_kfs = json.loads(crop_keyframes) or []
                        if not isinstance(parsed_kfs, list):
                            parsed_kfs = []
                    except Exception:
                        parsed_kfs = []
                cropped_path = os.path.join(
                    job_dir, f"cropped_{int(time.time())}.mp4",
                )
                if parsed_kfs:
                    _standalone_status(
                        job_id, "rendering",
                        f"Re-framing video to {output_orientation} with {len(parsed_kfs)} keyframe(s)…",
                    )
                    aspect_arg = {
                        "vertical": "9:16",
                        "horizontal": "16:9",
                    }.get(output_orientation, "9:16")
                    sorted_kfs = sorted(parsed_kfs, key=lambda k: float(k.get("t", 0)))
                    sanitized = [
                        {
                            "t": max(0.0, float(kf.get("t", 0))),
                            "x": max(0.0, min(1.0, float(kf.get("x", 0.5)))),
                            "y": max(0.0, min(1.0, float(kf.get("y", 0.5)))),
                            "cut": bool(kf.get("cut", False)),
                        }
                        for kf in sorted_kfs
                    ]
                    import tempfile as _tempfile
                    with _tempfile.NamedTemporaryFile(
                        suffix=".json", delete=False, mode="w",
                    ) as _tmp:
                        json.dump(sanitized, _tmp)
                        _kf_path = _tmp.name
                    try:
                        proc = await asyncio.create_subprocess_exec(
                            "python", "-u", "reframe_kf.py",
                            "--source", input_path,
                            "--keyframes", _kf_path,
                            "--output", cropped_path,
                            "--aspect", aspect_arg,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        _stdout, _stderr = await proc.communicate()
                        if proc.returncode != 0:
                            _msg = (_stderr or b"").decode("utf-8", errors="replace")[-1000:]
                            raise RuntimeError(f"Keyframed reframe failed: {_msg}")
                    finally:
                        try:
                            os.unlink(_kf_path)
                        except OSError:
                            pass
                    video_for_dub = cropped_path
                else:
                    _standalone_status(
                        job_id, "rendering",
                        f"Re-framing video to {output_orientation}…",
                    )
                    video_for_dub = await loop.run_in_executor(
                        None,
                        lambda: _crop_to_orientation(
                            input_path, cropped_path,
                            output_orientation,
                            x_offset_pct=crop_x_offset_pct or 50.0,
                            y_offset_pct=crop_y_offset_pct or 50.0,
                        ),
                    )

            if dub_provider == "edge":
                # Auto-detect gender if user picked 'auto'.
                gender = (voice_gender or "auto").lower()
                if gender == "auto":
                    try:
                        g_resp = provider.complete_json(
                            "Classify the speaker's gender from this transcript. "
                            'Reply ONLY {"gender":"male"} or {"gender":"female"} or {"gender":"unknown"}.',
                            f"Transcript:\n\n{transcript_text[:2000]}",
                            max_tokens=64,
                        )
                        gv = (g_resp.get("gender") if isinstance(g_resp, dict) else "").lower()
                        gender = "male" if "male" in gv and "female" not in gv else "female"
                    except Exception:
                        gender = "female"
                from dub_edge import dub_with_edge_tts, pick_voice
                voice = pick_voice(target_language, gender)
                await loop.run_in_executor(None, lambda: dub_with_edge_tts(
                    video_path=video_for_dub,
                    output_path=output_path,
                    target_language=target_language,
                    text_to_speak=translated_text,
                    voice=voice,
                    keep_original_volume=keep_vol,
                ))
            else:
                # ElevenLabs voice-cloning path.
                from translate import translate_video
                await loop.run_in_executor(None, lambda: translate_video(
                    video_path=video_for_dub,
                    output_path=output_path,
                    target_language=target_language,
                    api_key=x_eleven_key,
                    source_language=source_language or None,
                ))

            # OPTIONAL Stage 4 — burn matching subtitles in the SAME
            # language as the dubbed audio. We re-transcribe the dubbed
            # mp4 (because the new audio is what matters for caption
            # timing, not the source's original-language timing) and
            # burn the result onto a fresh output file. The original
            # dubbed-only mp4 stays on disk under the previous
            # filename in case the user wants both.
            final_output_path = output_path
            final_output_filename = output_filename
            if burn_subtitles_in_target_lang:
                try:
                    _standalone_status(
                        job_id, "rendering",
                        "Stage 4: transcribing dubbed audio for subtitles…",
                    )
                    from subtitles import (
                        transcribe_audio as _sub_transcribe,
                        generate_srt_per_segment as _sub_gen_srt,
                        burn_subtitles as _sub_burn,
                    )
                    dubbed_transcript = await loop.run_in_executor(
                        None, _sub_transcribe, output_path,
                    )
                    if dubbed_transcript and dubbed_transcript.get("segments"):
                        srt_path = os.path.join(
                            job_dir, f"dub_subs_{int(time.time())}.srt",
                        )
                        _sub_gen_srt(dubbed_transcript, 0.0, 1e9, srt_path)
                        subtitled_filename = (
                            f"dubbed_subtitled_{target_language}_{int(time.time())}.mp4"
                        )
                        subtitled_path = os.path.join(job_dir, subtitled_filename)
                        _standalone_status(
                            job_id, "rendering",
                            f"Stage 4: burning {target_language} subtitles…",
                        )
                        await loop.run_in_executor(None, lambda: _sub_burn(
                            output_path, srt_path, subtitled_path,
                            position_pct=subtitle_position_pct or 85,
                            fontsize=subtitle_font_size or 32,
                            font_name=subtitle_font_name or "Verdana",
                            font_color=subtitle_font_color or "#FFFFFF",
                            border_color=subtitle_border_color or "#000000",
                            border_width=subtitle_border_width or 2,
                            bg_color=subtitle_bg_color or "#000000",
                            bg_opacity=subtitle_bg_opacity or 0.0,
                        ))
                        final_output_path = subtitled_path
                        final_output_filename = subtitled_filename
                    else:
                        print(f"⚠️  Dubbed-audio transcription returned no segments for {job_id} — skipping subtitle burn.")
                except Exception as sub_err:
                    # Don't fail the whole dub if just the subtitle pass
                    # had a problem. Surface the issue in logs (with full
                    # traceback so we can debug) and ship the dub-only mp4.
                    import traceback
                    print(f"⚠️  Subtitle-burn step failed for {job_id}: {sub_err}")
                    traceback.print_exc()

            _standalone_status(
                job_id, "completed", "Done.",
                result={
                    "video_url": f"/videos/standalone_{job_id}/{final_output_filename}",
                    "translated_text": translated_text,
                    "target_language": target_language,
                    "has_burned_subtitles": bool(burn_subtitles_in_target_lang and final_output_path != output_path),
                },
            )
        except Exception as e:
            print(f"❌ Standalone dub failed ({job_id}): {e}")
            _standalone_status(job_id, "failed", f"Error: {e}")

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


def _find_standalone_source_video(job_id: str) -> Optional[str]:
    """Best-effort lookup of the original uploaded video for a standalone
    job — used by both /source-video and the redub endpoint. Returns the
    on-disk path if any of these match (in order):
       1. rec['input_path'] in memory (fast path)
       2. UPLOAD_DIR/<job_id>_*  (file-upload jobs)
       3. UPLOAD_DIR/<safe_title>* (URL-ingest jobs)
       4. <job's output_dir>/cropped_*.mp4 (last-resort: pre-cropped)
    Returns None when no source can be located.
    """
    rec = standalone_jobs.get(job_id) or {}
    src = rec.get("input_path")
    if src and os.path.isfile(src):
        return src
    # 1.5 Sidecar `.link` file written by _save_upload_dedup. With
    # content-addressed uploads the file no longer starts with
    # `{job_id}_`, so we keep this small pointer file per job that
    # contains the canonical content-addressed path.
    try:
        link_path = os.path.join(UPLOAD_DIR, f".{job_id}.link")
        if os.path.isfile(link_path):
            with open(link_path) as lf:
                target = (lf.read() or "").strip()
            if target and os.path.isfile(target):
                return target
    except Exception:
        pass
    # 2. Legacy: job_id prefix in UPLOAD_DIR (for uploads made before
    # the dedup change shipped — those files were saved as
    # `{job_id}_{safe_name}` with no hash).
    try:
        if os.path.isdir(UPLOAD_DIR):
            for name in os.listdir(UPLOAD_DIR):
                if name.startswith(f"{job_id}_"):
                    candidate = os.path.join(UPLOAD_DIR, name)
                    if os.path.isfile(candidate):
                        return candidate
    except Exception:
        pass
    # 3. Title prefix in UPLOAD_DIR (URL-ingest)
    try:
        title = (rec.get("title") or "").strip()
        for sep in (" → ", " -> "):
            if sep in title:
                title = title.split(sep, 1)[0].strip()
                break
        if title and os.path.isdir(UPLOAD_DIR):
            safe_title = (
                title.replace(" ", "_").replace("/", "_").replace("\\", "_")
                     .replace(":", "").replace("?", "").replace("*", "")
                     .replace('"', "").replace("<", "").replace(">", "").replace("|", "")
            )[:100]
            if safe_title:
                for name in os.listdir(UPLOAD_DIR):
                    if name.startswith(safe_title) and name.lower().endswith(
                        (".mp4", ".mkv", ".webm", ".mov", ".m4v")
                    ):
                        return os.path.join(UPLOAD_DIR, name)
    except Exception:
        pass
    # 4. cropped_*.mp4 in the job's output dir
    try:
        out_dir = rec.get("output_dir") or os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
        if os.path.isdir(out_dir):
            for name in sorted(os.listdir(out_dir)):
                if name.startswith("cropped_") and name.endswith(".mp4"):
                    return os.path.join(out_dir, name)
    except Exception:
        pass
    return None


class StandaloneRedubRequest(BaseModel):
    """Spawn a new dub from an EXISTING standalone job's saved transcript.

    The source job must have a checkpointed transcript on disk
    (whisper_original.json or cleaned_transcript.json). Both subtitle
    and dub jobs save these, so the user can dub from EITHER kind
    without re-running Whisper.
    """
    source_job_id: str
    target_language: str
    transcribe_provider: Optional[str] = None  # ignored — we reuse saved
    source_language: Optional[str] = ""
    dub_provider: Optional[str] = "edge"
    voice_gender: Optional[str] = "auto"
    keep_original: Optional[bool] = False
    original_volume: Optional[float] = 0.2
    output_orientation: Optional[str] = "original"
    crop_x_offset_pct: Optional[float] = 50.0
    crop_y_offset_pct: Optional[float] = 50.0
    # Optional keyframed crop for the dub video orientation. Same shape
    # as Auto Subtitle's crop_keyframes — list of {t,x,y,cut} entries.
    crop_keyframes: Optional[List[Keyframe]] = None
    # Same as the regular /api/standalone/dub: optional 4th stage that
    # transcribes the dubbed audio and burns matching subtitles.
    burn_subtitles_in_target_lang: Optional[bool] = False
    # Subtitle styling — passed straight through to subtitles.burn_subtitles
    # when the burn toggle is on. Same defaults as Auto Subtitle Phase 2.
    subtitle_font_name: Optional[str] = "Verdana"
    subtitle_font_size: Optional[int] = 32
    subtitle_font_color: Optional[str] = "#FFFFFF"
    subtitle_border_color: Optional[str] = "#000000"
    subtitle_border_width: Optional[int] = 2
    subtitle_bg_color: Optional[str] = "#000000"
    subtitle_bg_opacity: Optional[float] = 0.0
    subtitle_position_pct: Optional[float] = 85.0


@app.post("/api/standalone/dub/redub")
async def standalone_dub_redub(req: StandaloneRedubRequest, request: Request):
    """Generate a new dub for a different target language WITHOUT
    re-running transcription. Reuses the source job's saved Whisper
    transcript checkpoint, so the user pays the transcription cost
    (60-180s of CPU) ONLY ONCE per source video, no matter how many
    languages they dub it into.

    Source job can be either kind:
      - dub:      reuse whisper_original.json
      - subtitle: reuse cleaned_transcript.json (preferred) or
                  whisper_original.json fallback. cleaned_transcript
                  is what the user reviewed in Phase 1, so dubbing
                  from it produces a cleaner translation.
    """
    src_rec = standalone_jobs.get(req.source_job_id)
    # All standalone jobs are loaded into memory at startup via
    # rehydrate_standalone_jobs(). If the source isn't in standalone_jobs
    # it's because the user is referencing a job_id that doesn't exist.
    if src_rec is None:
        raise HTTPException(404, "Source standalone job not found.")

    # Pick the best available transcript checkpoint. cleaned_transcript
    # has segments with text/start/end and possibly the AI cleanup pass
    # applied. whisper_original is the raw output. Either works for the
    # translate stage since we only feed it the joined text.
    transcript = (
        _standalone_load_blob(req.source_job_id, "cleaned_transcript")
        or _standalone_load_blob(req.source_job_id, "whisper_original")
    )
    if not transcript or not transcript.get("text"):
        # Some old jobs store text inside segments[*].text but no
        # top-level "text" — splice it together so callers always see
        # a useful transcript_text for the translate stage.
        if transcript and transcript.get("segments"):
            joined = " ".join(
                (s.get("text") or "").strip() for s in transcript["segments"]
            ).strip()
            if joined:
                transcript = {**transcript, "text": joined}

    # Source video. We don't move/copy it — the new job simply points at
    # the SAME file on disk. Saves disk space and IO.
    source_video_path = _find_standalone_source_video(req.source_job_id)
    if not source_video_path:
        raise HTTPException(
            409,
            "The original source video for this project is no longer on "
            "disk (uploads may have been cleared). Re-upload to dub.",
        )

    # FALLBACK PATH for legacy jobs — if the source job predates the
    # transcript-checkpoint code, no whisper_original / cleaned_transcript
    # JSON exists. Rather than dead-end the redub, mark this run as
    # "needs transcription" and let the background task do the
    # transcription pass before translate + synthesize. The user still
    # avoids re-uploading and we save the resulting transcript as a
    # checkpoint, so the SECOND redub of the same source is instant.
    needs_transcription = not transcript or not transcript.get("text")

    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None
    x_eleven_key = request.headers.get("X-ElevenLabs-Key") or ""
    if (req.dub_provider or "edge") == "elevenlabs" and not x_eleven_key:
        raise HTTPException(400, "ElevenLabs voice cloning needs an X-ElevenLabs-Key header.")

    # Mint a new job. Inherits the source's title with the new
    # target-language suffix so the past-projects list reads
    # "<source title> → <new lang>" alongside any prior dubs.
    job_id = str(uuid.uuid4())
    job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    os.makedirs(job_dir, exist_ok=True)
    base_title = (src_rec.get("title") or "Untitled").strip()
    for sep in (" → ", " -> "):
        if sep in base_title:
            base_title = base_title.split(sep, 1)[0].strip()
            break
    initial_log = (
        f"Re-dub from {req.source_job_id[:8]}… "
        + ("(no checkpoint — running transcription on saved source first)."
           if needs_transcription else
           "(transcription reused, no Whisper pass).")
    )
    standalone_jobs[job_id] = {
        "status": "queued",
        "kind": "dub",
        "logs": [initial_log],
        "output_dir": job_dir,
        "result": None,
        "created_at": time.time(),
        "title": f"{base_title} → {req.target_language}",
        "input_path": source_video_path,
        "redub_source": req.source_job_id,
    }
    # Mirror the source's transcript checkpoint into the NEW job so
    # any future resume / lookup works from this job alone — without
    # this the new job would silently depend on the source's blob and
    # break if the source were deleted. (Skipped on the fallback path
    # because we don't have the checkpoint yet; the run() task will
    # save it AFTER transcribing.)
    if not needs_transcription:
        standalone_jobs[job_id]["whisper_original"] = transcript
        _standalone_save_blob(job_id, "whisper_original", transcript)
    _standalone_persist(job_id)

    target_language = req.target_language
    dub_provider = req.dub_provider or "edge"
    voice_gender = req.voice_gender or "auto"
    keep_original = bool(req.keep_original)
    original_volume = float(req.original_volume or 0.2)
    output_orientation = req.output_orientation or "original"
    crop_x = float(req.crop_x_offset_pct or 50.0)
    crop_y = float(req.crop_y_offset_pct or 50.0)
    # Empty string when needs_transcription — populated inside run() once
    # we've actually transcribed the saved source video.
    transcript_text = (transcript.get("text") or "").strip() if transcript else ""

    # Transcribe-engine env vars need to be set BEFORE main.transcribe_video
    # is imported / called by the run() coroutine. Snapshot them now from
    # the request + headers (matching how the original /api/standalone/dub
    # endpoint sets them) so the fallback transcription path uses the
    # same provider config the user picked on the page.
    redub_transcribe_provider = req.transcribe_provider or "whisper"
    redub_source_lang = req.source_language or ""

    async def run():
        try:
            loop = asyncio.get_event_loop()
            # FALLBACK STAGE — only runs when the source job had no saved
            # checkpoint. Reuses the same transcribe_video helper the
            # original dub endpoint uses; result gets saved as a
            # checkpoint so SECOND redub of the same source skips this.
            nonlocal transcript_text
            local_transcript = transcript
            if needs_transcription:
                _standalone_status(
                    job_id, "transcribing",
                    "Source had no saved transcript — transcribing now (one-time).",
                )
                os.environ["OPENSHORTS_TRANSCRIBE_PROVIDER"] = redub_transcribe_provider
                os.environ["OPENSHORTS_TRANSCRIPT_LANG"] = redub_source_lang
                if x_eleven_key:
                    os.environ["OPENSHORTS_ELEVENLABS_KEY"] = x_eleven_key
                from main import transcribe_video
                local_transcript = await loop.run_in_executor(
                    None, transcribe_video, source_video_path,
                )
                if not local_transcript or not local_transcript.get("segments"):
                    raise RuntimeError("Fallback transcription returned no segments.")
                # Persist into BOTH the new job AND the source job, so
                # any subsequent redub of the same source picks the
                # checkpoint up via the fast path.
                standalone_jobs[job_id]["whisper_original"] = local_transcript
                _standalone_save_blob(job_id, "whisper_original", local_transcript)
                _standalone_save_blob(req.source_job_id, "whisper_original", local_transcript)
                transcript_text = (local_transcript.get("text") or "").strip()
                if not transcript_text and local_transcript.get("segments"):
                    transcript_text = " ".join(
                        (s.get("text") or "").strip()
                        for s in local_transcript["segments"]
                    ).strip()

            dub_opts = {
                "target_language": target_language,
                "source_language": req.source_language or "",
                "dub_provider": dub_provider,
                "voice_gender": voice_gender,
                "keep_original": keep_original,
                "original_volume": original_volume,
                "output_orientation": output_orientation,
                "crop_x_offset_pct": crop_x,
                "crop_y_offset_pct": crop_y,
                "redub_source": req.source_job_id,
            }
            standalone_jobs[job_id]["dub_opts"] = dub_opts
            _standalone_save_blob(job_id, "dub_opts", dub_opts)

            _standalone_status(
                job_id, "translating",
                f"Translating saved transcript → {target_language}…",
            )
            from llm import build_provider
            try:
                provider = build_provider(
                    x_llm_provider, x_llm_model, x_llm_key, base_url=x_llm_base_url
                )
            except Exception as e:
                raise RuntimeError(f"Could not build LLM provider for translation: {e}")

            from prompt_rules import USER_TEXT_RULES
            from dub_edge import LANGUAGE_NAMES
            target_name = LANGUAGE_NAMES.get(target_language, target_language)

            translation_resp = provider.complete_json(
                f"You are a subtitle translator. Translate the user's text to {target_name}. "
                f"Keep tone and length close to the original — these are spoken subtitles, "
                f"so the translation should sound natural read aloud. "
                f"Use full-clip context to fix obvious Whisper errors before translating.\n\n"
                f"{USER_TEXT_RULES}\n\n"
                f'Return ONLY this JSON: {{"translation": "<translated text>"}}.',
                transcript_text,
                max_tokens=8192,
            )
            translated_text = ""
            if isinstance(translation_resp, dict):
                translated_text = (translation_resp.get("translation") or "").strip()
            elif isinstance(translation_resp, str):
                translated_text = translation_resp.strip()
            if not translated_text:
                raise RuntimeError("LLM returned empty translation.")
            standalone_jobs[job_id]["translated_text"] = translated_text
            _standalone_save_blob(job_id, "translated_text", {"text": translated_text})

            _standalone_status(job_id, "rendering", "Synthesising voice + muxing…")
            output_filename = f"dubbed_{target_language}_{int(time.time())}.mp4"
            output_path = os.path.join(job_dir, output_filename)
            keep_vol = original_volume if keep_original else 0.0

            # Re-frame if the user picked a non-original orientation —
            # keyframed when the user dropped keyframes, static otherwise.
            video_for_dub = source_video_path
            if output_orientation and output_orientation != "original":
                kfs = req.crop_keyframes or []
                cropped_path = os.path.join(
                    job_dir, f"cropped_{int(time.time())}.mp4",
                )
                if kfs:
                    _standalone_status(
                        job_id, "rendering",
                        f"Re-framing video to {output_orientation} with {len(kfs)} keyframe(s)…",
                    )
                    aspect_arg = {
                        "vertical": "9:16",
                        "horizontal": "16:9",
                    }.get(output_orientation, "9:16")
                    sorted_kfs = sorted(kfs, key=lambda k: k.t)
                    sanitized = [
                        {
                            "t": max(0.0, float(kf.t)),
                            "x": max(0.0, min(1.0, float(kf.x))),
                            "y": max(0.0, min(1.0, float(kf.y))),
                            "cut": bool(kf.cut),
                        }
                        for kf in sorted_kfs
                    ]
                    import tempfile as _tempfile
                    with _tempfile.NamedTemporaryFile(
                        suffix=".json", delete=False, mode="w",
                    ) as _tmp:
                        json.dump(sanitized, _tmp)
                        _kf_path = _tmp.name
                    try:
                        proc = await asyncio.create_subprocess_exec(
                            "python", "-u", "reframe_kf.py",
                            "--source", source_video_path,
                            "--keyframes", _kf_path,
                            "--output", cropped_path,
                            "--aspect", aspect_arg,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        _stdout, _stderr = await proc.communicate()
                        if proc.returncode != 0:
                            _msg = (_stderr or b"").decode("utf-8", errors="replace")[-1000:]
                            raise RuntimeError(f"Keyframed reframe failed: {_msg}")
                    finally:
                        try:
                            os.unlink(_kf_path)
                        except OSError:
                            pass
                    video_for_dub = cropped_path
                else:
                    _standalone_status(
                        job_id, "rendering",
                        f"Re-framing video to {output_orientation}…",
                    )
                    video_for_dub = await loop.run_in_executor(
                        None,
                        lambda: _crop_to_orientation(
                            source_video_path, cropped_path,
                            output_orientation,
                            x_offset_pct=crop_x, y_offset_pct=crop_y,
                        ),
                    )

            if dub_provider == "edge":
                gender = voice_gender.lower()
                if gender == "auto":
                    try:
                        g_resp = provider.complete_json(
                            "Classify the speaker's gender from this transcript. "
                            'Reply ONLY {"gender":"male"} or {"gender":"female"} or {"gender":"unknown"}.',
                            f"Transcript:\n\n{transcript_text[:2000]}",
                            max_tokens=64,
                        )
                        gv = (g_resp.get("gender") if isinstance(g_resp, dict) else "").lower()
                        gender = "male" if "male" in gv and "female" not in gv else "female"
                    except Exception:
                        gender = "female"
                from dub_edge import dub_with_edge_tts, pick_voice
                voice = pick_voice(target_language, gender)
                await loop.run_in_executor(None, lambda: dub_with_edge_tts(
                    video_path=video_for_dub,
                    output_path=output_path,
                    target_language=target_language,
                    text_to_speak=translated_text,
                    voice=voice,
                    keep_original_volume=keep_vol,
                ))
            else:
                from translate import translate_video
                await loop.run_in_executor(None, lambda: translate_video(
                    video_path=video_for_dub,
                    output_path=output_path,
                    target_language=target_language,
                    api_key=x_eleven_key,
                    source_language=req.source_language or None,
                ))

            # Optional subtitle burn — same logic as the main /dub
            # endpoint. Re-transcribes the dubbed mp4 and burns the
            # resulting target-language captions onto a NEW file.
            final_output_path = output_path
            final_output_filename = output_filename
            if req.burn_subtitles_in_target_lang:
                try:
                    _standalone_status(
                        job_id, "rendering",
                        "Stage 4: transcribing dubbed audio for subtitles…",
                    )
                    from subtitles import (
                        transcribe_audio as _sub_transcribe,
                        generate_srt_per_segment as _sub_gen_srt,
                        burn_subtitles as _sub_burn,
                    )
                    dubbed_transcript = await loop.run_in_executor(
                        None, _sub_transcribe, output_path,
                    )
                    if dubbed_transcript and dubbed_transcript.get("segments"):
                        srt_path = os.path.join(
                            job_dir, f"dub_subs_{int(time.time())}.srt",
                        )
                        _sub_gen_srt(dubbed_transcript, 0.0, 1e9, srt_path)
                        subtitled_filename = (
                            f"dubbed_subtitled_{target_language}_{int(time.time())}.mp4"
                        )
                        subtitled_path = os.path.join(job_dir, subtitled_filename)
                        _standalone_status(
                            job_id, "rendering",
                            f"Stage 4: burning {target_language} subtitles…",
                        )
                        await loop.run_in_executor(None, lambda: _sub_burn(
                            output_path, srt_path, subtitled_path,
                            position_pct=req.subtitle_position_pct or 85,
                            fontsize=req.subtitle_font_size or 32,
                            font_name=req.subtitle_font_name or "Verdana",
                            font_color=req.subtitle_font_color or "#FFFFFF",
                            border_color=req.subtitle_border_color or "#000000",
                            border_width=req.subtitle_border_width or 2,
                            bg_color=req.subtitle_bg_color or "#000000",
                            bg_opacity=req.subtitle_bg_opacity or 0.0,
                        ))
                        final_output_path = subtitled_path
                        final_output_filename = subtitled_filename
                    else:
                        print(f"⚠️  Dubbed-audio transcription returned no segments for {job_id} — skipping subtitle burn.")
                except Exception as sub_err:
                    import traceback
                    print(f"⚠️  Subtitle-burn step failed for {job_id}: {sub_err}")
                    traceback.print_exc()

            _standalone_status(
                job_id, "completed", "Done.",
                result={
                    "video_url": f"/videos/standalone_{job_id}/{final_output_filename}",
                    "translated_text": translated_text,
                    "target_language": target_language,
                    "has_burned_subtitles": bool(req.burn_subtitles_in_target_lang and final_output_path != output_path),
                },
            )
        except Exception as e:
            print(f"❌ Standalone redub failed ({job_id}): {e}")
            _standalone_status(job_id, "failed", f"Error: {e}")

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


class DubBurnSubtitlesRequest(BaseModel):
    """Burn subtitles in the dub's target language onto an ALREADY-
    rendered dub output. Reuses the dub job's mp4 + saved target
    language; just runs the Stage 4 subtitle pass.
    """
    subtitle_font_name: Optional[str] = "Verdana"
    subtitle_font_size: Optional[int] = 32
    subtitle_font_color: Optional[str] = "#FFFFFF"
    subtitle_border_color: Optional[str] = "#000000"
    subtitle_border_width: Optional[int] = 2
    subtitle_bg_color: Optional[str] = "#000000"
    subtitle_bg_opacity: Optional[float] = 0.0
    subtitle_position_pct: Optional[float] = 85.0


@app.post("/api/standalone/dub/{job_id}/burn-subtitles")
async def standalone_dub_burn_subtitles(job_id: str, req: DubBurnSubtitlesRequest):
    """Add subtitles to an already-completed dub. Useful when the user
    didn't tick 'burn subtitles' before running the dub — they hit the
    Result panel, decide they want captions too, click Add subtitles,
    and the same Stage 4 pipeline runs against the existing dubbed mp4
    without re-translating or re-synthesising.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "Dub job not found.")
    if rec.get("kind") != "dub":
        raise HTTPException(400, "This endpoint only works on dub jobs.")
    result = rec.get("result") or {}
    dubbed_url = result.get("video_url") or ""
    target_language = (result.get("target_language") or "").strip() or "en"
    if not dubbed_url:
        raise HTTPException(409, "Dub has no rendered video to burn subtitles onto.")

    # The video_url is `/videos/standalone_<id>/<filename>` — translate
    # back to a filesystem path inside the job's output_dir.
    job_dir = rec.get("output_dir") or os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    dubbed_filename = dubbed_url.split("?")[0].split("/")[-1]
    dubbed_path = os.path.join(job_dir, dubbed_filename)
    if not os.path.isfile(dubbed_path):
        raise HTTPException(
            409,
            f"Dubbed mp4 missing on disk ({dubbed_filename}). It may have "
            "been cleaned up. Re-run the dub.",
        )

    async def run():
        try:
            _standalone_status(
                job_id, "rendering",
                "Stage 4: transcribing dubbed audio for subtitles…",
            )
            from subtitles import (
                transcribe_audio as _sub_transcribe,
                generate_srt_per_segment as _sub_gen_srt,
                burn_subtitles as _sub_burn,
            )
            loop = asyncio.get_event_loop()
            dubbed_transcript = await loop.run_in_executor(
                None, _sub_transcribe, dubbed_path,
            )
            if not dubbed_transcript or not dubbed_transcript.get("segments"):
                raise RuntimeError("Dubbed-audio transcription returned no segments.")
            srt_path = os.path.join(
                job_dir, f"dub_subs_{int(time.time())}.srt",
            )
            _sub_gen_srt(dubbed_transcript, 0.0, 1e9, srt_path)
            subtitled_filename = (
                f"dubbed_subtitled_{target_language}_{int(time.time())}.mp4"
            )
            subtitled_path = os.path.join(job_dir, subtitled_filename)
            _standalone_status(
                job_id, "rendering",
                f"Stage 4: burning {target_language} subtitles…",
            )
            await loop.run_in_executor(None, lambda: _sub_burn(
                dubbed_path, srt_path, subtitled_path,
                position_pct=req.subtitle_position_pct or 85,
                fontsize=req.subtitle_font_size or 32,
                font_name=req.subtitle_font_name or "Verdana",
                font_color=req.subtitle_font_color or "#FFFFFF",
                border_color=req.subtitle_border_color or "#000000",
                border_width=req.subtitle_border_width or 2,
                bg_color=req.subtitle_bg_color or "#000000",
                bg_opacity=req.subtitle_bg_opacity or 0.0,
            ))
            _standalone_status(
                job_id, "completed", "Subtitles burned.",
                result={
                    **(rec.get("result") or {}),
                    "video_url": f"/videos/standalone_{job_id}/{subtitled_filename}",
                    "has_burned_subtitles": True,
                },
            )
        except Exception as e:
            import traceback
            print(f"❌ Subtitle burn-on-existing failed for {job_id}: {e}")
            traceback.print_exc()
            _standalone_status(job_id, "failed", f"Subtitle burn failed: {e}")

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "rendering"}


@app.get("/api/standalone/status/{job_id}")
async def standalone_status(job_id: str):
    rec = standalone_jobs.get(job_id)
    if rec is None:
        raise HTTPException(404, "Standalone job not found")
    return {
        "status": rec.get("status"),
        "logs": rec.get("logs", []),
        "kind": rec.get("kind"),
        "result": rec.get("result"),
        # Tell the frontend whether resume is even possible — saves a
        # round-trip when a past-project card decides whether to show
        # a Resume button.
        "resumable": _standalone_resume_stage(job_id) is not None,
    }


def _standalone_resume_stage(job_id: str) -> Optional[str]:
    """Inspect the on-disk checkpoints for a job and decide which
    stage Resume should pick up from. Returns one of:
        'cleanup'   — for subtitle: skip transcribe, run AI cleanup
        'translate' — for dub: skip transcribe, re-run translation
        'tts'       — for dub: skip transcribe + translate, re-run TTS
        None        — nothing to resume (success / no checkpoints).
    Only failed / interrupted jobs are eligible.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        return None
    status = rec.get("status")
    # Only offer resume for jobs that aren't currently running and
    # aren't already complete.
    if status in (None, "completed"):
        return None
    if status not in ("failed", "interrupted"):
        return None
    kind = rec.get("kind")
    has_whisper = (
        bool(rec.get("whisper_original"))
        or _standalone_load_blob(job_id, "whisper_original") is not None
    )
    if not has_whisper:
        return None
    if kind == "subtitle":
        return "cleanup"
    if kind == "dub":
        has_trans = (
            bool(rec.get("translated_text"))
            or _standalone_load_blob(job_id, "translated_text") is not None
        )
        return "tts" if has_trans else "translate"
    return None


@app.post("/api/standalone/{job_id}/resume")
async def standalone_resume(job_id: str, request: Request):
    """Resume an interrupted / failed standalone job from its last
    on-disk checkpoint. Picks the right stage based on which blobs
    were saved by the previous run.

    Subtitle:
      • whisper_original on disk → re-run AI cleanup, mark transcript_ready
    Dub:
      • whisper_original only → re-run translate + TTS
      • whisper_original + translated_text → skip translate, re-run TTS only

    Returns {job_id, status, stage} so the frontend can show the user
    which stage was skipped vs re-run.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "Standalone job not found")
    stage = _standalone_resume_stage(job_id)
    if not stage:
        raise HTTPException(
            409,
            "Nothing to resume — either the job has no checkpoint, is "
            "already running, or already completed.",
        )

    # Pull saved blobs (also keep them on the in-memory rec).
    if not rec.get("whisper_original"):
        rec["whisper_original"] = _standalone_load_blob(job_id, "whisper_original")
    whisper_orig = rec.get("whisper_original")

    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None
    x_eleven_key = request.headers.get("X-ElevenLabs-Key") or ""

    kind = rec.get("kind")
    if kind == "subtitle":
        # Re-run cleanup using the saved options.
        opts = rec.get("cleanup_opts") or _standalone_load_blob(job_id, "cleanup_opts") or {}
        mode = (opts.get("script_mode") or "auto").lower()
        target = opts.get("target_language") or ""
        cleanup_mode = "cleanup" if mode == "auto" else mode

        async def run():
            try:
                _standalone_status(job_id, "cleaning", "Resume: re-running AI cleanup…")
                loop = asyncio.get_event_loop()
                transcript = await loop.run_in_executor(
                    None,
                    lambda: _llm_rewrite_transcript(
                        transcript=copy.deepcopy(whisper_orig),
                        mode=cleanup_mode,
                        target_language=target if mode == "translate" else None,
                        provider_id=x_llm_provider,
                        model_name=x_llm_model,
                        api_key=x_llm_key,
                        base_url=x_llm_base_url,
                    ),
                )
                # Same single-line split as Phase 1 / Regenerate.
                # SKIP for BYOL — user's lyrics are already line-shaped.
                if not transcript.get("_user_lyrics"):
                    transcript["segments"] = _split_long_segments(
                        transcript.get("segments") or []
                    )
                rec["transcript"] = transcript
                _standalone_save_blob(job_id, "cleaned_transcript", transcript)
                seg_payload = [
                    {
                        "text": (s.get("text") or "").strip(),
                        "start": float(s.get("start", 0)),
                        "end": float(s.get("end", 0)),
                    }
                    for s in (transcript.get("segments") or [])
                ]
                _standalone_status(
                    job_id, "transcript_ready",
                    "Resumed — review the transcript.",
                    result={
                        "transcript_text": transcript.get("text", ""),
                        "language": transcript.get("language", ""),
                        "segments_count": len(seg_payload),
                        "segments": seg_payload,
                        "phase": 1,
                    },
                )
            except Exception as e:
                print(f"❌ Resume (subtitle) failed for {job_id}: {e}")
                _standalone_status(job_id, "failed", f"Resume failed: {e}")

        asyncio.create_task(run())
        return {"job_id": job_id, "status": "cleaning", "stage": stage}

    if kind == "dub":
        opts = rec.get("dub_opts") or _standalone_load_blob(job_id, "dub_opts") or {}
        target_language = opts.get("target_language") or "en"
        dub_provider = opts.get("dub_provider") or "edge"
        voice_gender = opts.get("voice_gender") or "auto"
        keep_original = bool(opts.get("keep_original"))
        original_volume = float(opts.get("original_volume") or 0.0)
        output_orientation = opts.get("output_orientation") or "original"
        crop_x_offset_pct = float(opts.get("crop_x_offset_pct") or 50.0)
        crop_y_offset_pct = float(opts.get("crop_y_offset_pct") or 50.0)

        # Pull translated text if present (skips translate stage).
        translated_text = rec.get("translated_text")
        if not translated_text:
            blob = _standalone_load_blob(job_id, "translated_text")
            if blob and blob.get("text"):
                translated_text = blob["text"]
                rec["translated_text"] = translated_text

        input_path = rec.get("input_path")
        job_dir = os.path.join(OUTPUT_DIR, f"standalone_{job_id}")

        if not input_path or not os.path.exists(input_path):
            raise HTTPException(
                409,
                "Source video for this job is missing — can't resume "
                "synthesis without it. Please re-upload from the "
                "homepage.",
            )

        async def run():
            try:
                from llm import build_provider
                loop = asyncio.get_event_loop()
                nonlocal translated_text
                transcript_text = (whisper_orig.get("text") or "").strip()
                provider = None

                # If we don't have a saved translation, re-run translate.
                if not translated_text:
                    _standalone_status(job_id, "translating", "Resume: re-running translation…")
                    provider = build_provider(
                        x_llm_provider, x_llm_model, x_llm_key, base_url=x_llm_base_url
                    )
                    from prompt_rules import USER_TEXT_RULES
                    from dub_edge import LANGUAGE_NAMES
                    target_name = LANGUAGE_NAMES.get(target_language, target_language)
                    resp = provider.complete_json(
                        f"You are a subtitle translator. Translate the user's text to {target_name}. "
                        f"Keep tone and length close to the original.\n\n{USER_TEXT_RULES}\n\n"
                        f'Return ONLY this JSON: {{"translation": "<translated text>"}}.',
                        transcript_text,
                        max_tokens=8192,
                    )
                    translated_text = ""
                    if isinstance(resp, dict):
                        translated_text = (resp.get("translation") or "").strip()
                    elif isinstance(resp, str):
                        translated_text = resp.strip()
                    if not translated_text:
                        raise RuntimeError("LLM returned empty translation.")
                    rec["translated_text"] = translated_text
                    _standalone_save_blob(job_id, "translated_text", {"text": translated_text})

                _standalone_status(job_id, "rendering", "Resume: synthesising voice + muxing…")
                output_filename = f"dubbed_{target_language}_{int(time.time())}.mp4"
                output_path = os.path.join(job_dir, output_filename)

                video_for_dub = input_path
                if output_orientation and output_orientation != "original":
                    cropped_path = os.path.join(job_dir, f"cropped_{int(time.time())}.mp4")
                    video_for_dub = await loop.run_in_executor(
                        None,
                        lambda: _crop_to_orientation(
                            input_path, cropped_path,
                            output_orientation,
                            x_offset_pct=crop_x_offset_pct,
                            y_offset_pct=crop_y_offset_pct,
                        ),
                    )

                if dub_provider == "edge":
                    gender = (voice_gender or "auto").lower()
                    if gender == "auto":
                        try:
                            if provider is None:
                                provider = build_provider(
                                    x_llm_provider, x_llm_model, x_llm_key, base_url=x_llm_base_url
                                )
                            g_resp = provider.complete_json(
                                "Classify the speaker's gender. "
                                'Reply ONLY {"gender":"male"} or {"gender":"female"}.',
                                f"Transcript:\n\n{transcript_text[:2000]}",
                                max_tokens=64,
                            )
                            gv = (g_resp.get("gender") if isinstance(g_resp, dict) else "").lower()
                            gender = "male" if "male" in gv and "female" not in gv else "female"
                        except Exception:
                            gender = "female"
                    from dub_edge import dub_with_edge_tts, pick_voice
                    voice = pick_voice(target_language, gender)
                    keep_vol = original_volume if keep_original else 0.0
                    await loop.run_in_executor(None, lambda: dub_with_edge_tts(
                        video_path=video_for_dub,
                        output_path=output_path,
                        target_language=target_language,
                        text_to_speak=translated_text,
                        voice=voice,
                        keep_original_volume=keep_vol,
                    ))
                else:
                    from translate import translate_video
                    await loop.run_in_executor(None, lambda: translate_video(
                        video_path=video_for_dub,
                        output_path=output_path,
                        target_language=target_language,
                        api_key=x_eleven_key,
                        source_language=opts.get("source_language") or None,
                    ))

                _standalone_status(
                    job_id, "completed", "Resume completed.",
                    result={
                        "video_url": f"/videos/standalone_{job_id}/{output_filename}",
                        "translated_text": translated_text,
                        "target_language": target_language,
                    },
                )
            except Exception as e:
                print(f"❌ Resume (dub) failed for {job_id}: {e}")
                _standalone_status(job_id, "failed", f"Resume failed: {e}")

        asyncio.create_task(run())
        return {"job_id": job_id, "status": "translating" if stage == "translate" else "rendering", "stage": stage}

    raise HTTPException(409, f"Cannot resume — unknown job kind '{kind}'.")


@app.get("/api/standalone/list")
async def standalone_list(kind: Optional[str] = None):
    """List FINISHED standalone jobs of a given kind ('subtitle' or
    'dub'), sorted newest-first. Used by Past Projects inside each
    standalone feature.

    "Past projects" means done-and-dusted, not draft/in-flight, so we
    filter out anything that hasn't produced a final video:
      • queued / transcribing / cleaning / translating / rendering →
        currently running, belongs in the active wizard, not Past
        Projects.
      • transcript_ready → user generated a transcript but never
        proceeded to Phase 2 burn. There's no output mp4. Hide it from
        Past Projects so the user doesn't see an "offline" looking card.
      • failed → kept hidden by default; the user can't replay it
        anyway, and the most useful action is to just rerun.
      • completed → always shown, with a per-job file existence check.
        If the mp4 has been wiped from disk we surface status='missing'
        so the frontend can render a broken-state card with a clear
        Delete affordance instead of looking silently empty.
    """
    items = []
    wanted = (kind or "").strip().lower()
    # Two surface-able states:
    #   completed   — burned, has a final mp4 the user can replay/download
    #   saved_draft — Phase-2 styling chosen but not burned yet; user
    #                 wants to come back and finish later
    # 'interrupted' / 'failed' jobs that have a saved checkpoint also
    # show up so the user can click Resume — otherwise the project
    # silently vanishes after a crashed pipeline and the only path
    # forward is starting from scratch (the original complaint).
    #
    # 'transcribing' / 'cleaning' / 'translating' / 'rendering' /
    # 'transcript_ready' / 'queued' also surface so a user who refreshed
    # the browser mid-pipeline can click their card and re-attach to
    # the still-running backend job. Without this they'd lose track of
    # any job not stored in localStorage (private window, cleared
    # storage, different device).
    DISPLAYABLE = {
        "completed", "saved_draft", "interrupted", "failed",
        "queued", "transcribing", "cleaning", "translating", "rendering",
        "transcript_ready",
    }
    for jid, rec in standalone_jobs.items():
        if wanted and rec.get("kind") != wanted:
            continue
        status = rec.get("status")
        if status not in DISPLAYABLE:
            continue
        # Skip failed/interrupted jobs that have NO checkpoint to
        # resume from — those are unrecoverable, and showing them
        # without an actionable button is worse than hiding them.
        is_resumable = False
        if status in ("interrupted", "failed"):
            is_resumable = _standalone_resume_stage(jid) is not None
            if not is_resumable:
                continue
        result = rec.get("result") or {}
        video_url = result.get("video_url")
        is_draft = status == "saved_draft"
        # File-existence validation only applies to completed jobs.
        # Drafts have no output video yet — that's the whole point.
        if status == "completed":
            if video_url:
                try:
                    rel = video_url.lstrip("/")
                    if rel.startswith("videos/"):
                        rel = rel[len("videos/"):]
                    disk_path = os.path.join(OUTPUT_DIR, rel)
                    if not os.path.isfile(disk_path):
                        status = "missing"
                except Exception:
                    pass
            else:
                # Status said completed but no video_url — meta corrupted.
                status = "missing"
        items.append({
            "job_id": jid,
            "kind": rec.get("kind"),
            "status": status,
            "title": rec.get("title") or "Untitled",
            "created_at": rec.get("created_at"),
            "video_url": video_url,
            "language": result.get("language") or result.get("target_language"),
            "is_draft": is_draft,
            "is_resumable": is_resumable,
        })
    items.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
    return {"jobs": items, "total": len(items)}


@app.get("/api/standalone/{job_id}/source-video")
async def standalone_source_video(job_id: str):
    """Stream the original source video for a standalone job. Used by
    the Phase-2 preview AND the homepage demo tiles.

    Resolution order (so old jobs whose meta predates input_path
    persistence still serve their source):
      1. rec["input_path"] from in-memory state.
      2. Search UPLOAD_DIR for a filename starting with `<job_id>_` —
         that's the pattern _standalone_save_upload writes when a
         user uploads a file. Catches every file-upload job ever made.
      3. Search UPLOAD_DIR for any video that contains the job's
         title or sanitized title — covers URL-ingest jobs where the
         filename is derived from the YouTube/TikTok title.
      4. Search the job's output_dir for a `cropped_*.mp4` (the
         pre-rendered cropped source from a recent burn).
      5. 404 if none of those find anything.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "Standalone job not found")
    src = rec.get("input_path")
    if src and os.path.isfile(src):
        from fastapi.responses import FileResponse
        return FileResponse(src, media_type="video/mp4")

    # 2. Match by job_id prefix in UPLOAD_DIR.
    try:
        if os.path.isdir(UPLOAD_DIR):
            for name in os.listdir(UPLOAD_DIR):
                if name.startswith(f"{job_id}_"):
                    candidate = os.path.join(UPLOAD_DIR, name)
                    if os.path.isfile(candidate):
                        # Cache it back onto the rec so subsequent calls
                        # hit case 1 (and the new value gets persisted).
                        rec["input_path"] = candidate
                        try:
                            _standalone_persist(job_id)
                        except Exception:
                            pass
                        from fastapi.responses import FileResponse
                        return FileResponse(candidate, media_type="video/mp4")
    except Exception as e:
        print(f"⚠️  source-video upload-dir scan failed for {job_id}: {e}")

    # 3. Match by title in UPLOAD_DIR (for URL-ingest jobs whose title
    # came from yt-dlp's video_title rather than a job-id prefix).
    try:
        title = (rec.get("title") or "").strip()
        # The title may include " → <lang>" suffix for dub jobs — strip
        # it so we match on just the source filename.
        for sep in (" → ", " -> "):
            if sep in title:
                title = title.split(sep, 1)[0].strip()
                break
        # Sanitize roughly the same way main._sanitize_filename does.
        if title:
            safe_title = (
                title.replace(" ", "_")
                     .replace("/", "_")
                     .replace("\\", "_")
                     .replace(":", "")
                     .replace("?", "")
                     .replace("*", "")
                     .replace('"', "")
                     .replace("<", "")
                     .replace(">", "")
                     .replace("|", "")
            )[:100]
            if os.path.isdir(UPLOAD_DIR):
                for name in os.listdir(UPLOAD_DIR):
                    if name.startswith(safe_title) and name.lower().endswith(
                        (".mp4", ".mkv", ".webm", ".mov", ".m4v")
                    ):
                        candidate = os.path.join(UPLOAD_DIR, name)
                        rec["input_path"] = candidate
                        try:
                            _standalone_persist(job_id)
                        except Exception:
                            pass
                        from fastapi.responses import FileResponse
                        return FileResponse(candidate, media_type="video/mp4")
    except Exception as e:
        print(f"⚠️  source-video title-match scan failed for {job_id}: {e}")

    # 4. Cropped intermediate from a previous burn — last resort but
    # still better than 404.
    try:
        out_dir = rec.get("output_dir") or os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
        if os.path.isdir(out_dir):
            for name in sorted(os.listdir(out_dir)):
                if name.startswith("cropped_") and name.endswith(".mp4"):
                    candidate = os.path.join(out_dir, name)
                    from fastapi.responses import FileResponse
                    return FileResponse(candidate, media_type="video/mp4")
    except Exception:
        pass

    raise HTTPException(404, "Source video not on disk")


@app.delete("/api/standalone/{job_id}")
async def standalone_delete(job_id: str):
    """Delete a standalone job — wipes its output dir and forgets its
    in-memory state. Refuses while still rendering."""
    import shutil as _sh
    rec = standalone_jobs.get(job_id)
    if rec is None:
        raise HTTPException(404, "Standalone job not found")
    if rec.get("status") in ("queued", "transcribing", "cleaning", "rendering", "translating"):
        raise HTTPException(409, "Job is still running — wait for it to finish.")
    out_dir = rec.get("output_dir") or os.path.join(OUTPUT_DIR, f"standalone_{job_id}")
    if os.path.isdir(out_dir):
        _sh.rmtree(out_dir, ignore_errors=True)
    standalone_jobs.pop(job_id, None)
    return {"deleted": True, "job_id": job_id}


# =====================================================================
# Accounts: signup, signin, sessions, current user, influencer apps,
# Stripe billing. All backed by accounts.py / SQLite.
# =====================================================================

# DEFENSIVE IMPORT — accounts.py pulls in bcrypt at the top, which is
# only available after `docker compose build` has run with the updated
# requirements.txt. If we let an ImportError bubble up here it would
# kill the ENTIRE app (every endpoint → 500), including unrelated
# things like Past Projects and Subtitle. We don't want that. Keep the
# rest of the app fully functional and only fail the auth endpoints.
try:
    import accounts as _accounts
    _ACCOUNTS_AVAILABLE = True
except Exception as _accounts_err:
    print(
        f"⚠️  accounts module unavailable: {_accounts_err}. "
        "Auth / sign-up / sign-in endpoints will return 503. The rest "
        "of the app (Past Projects, Subtitle, Dub, clip generation) "
        "is unaffected. Run `docker compose build backend` to install "
        "the missing 'bcrypt' dependency from requirements.txt."
    )
    _accounts = None
    _ACCOUNTS_AVAILABLE = False


def _accounts_or_503():
    """Tiny guard called from every auth/influencer/billing endpoint.
    Returns 503 with a clear, actionable message instead of an opaque
    500 traceback when the accounts module didn't load."""
    if not _ACCOUNTS_AVAILABLE or _accounts is None:
        raise HTTPException(
            503,
            "Accounts subsystem unavailable. The 'bcrypt' Python "
            "package isn't installed in this build — run "
            "`docker compose build backend` (then `up -d`) to install "
            "the new dependencies from requirements.txt.",
        )


def _session_token_from_request(request: Request) -> Optional[str]:
    """Resolve the session token from either Authorization header or
    the klipra_session cookie. Header takes priority because it's what
    SPAs send; cookie is a fallback for direct browser visits."""
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        if token:
            return token
    return request.cookies.get("klipra_session")


def _current_user(request: Request) -> Optional[Dict]:
    # Treat "accounts unavailable" the same as "no session" so the rest
    # of the app degrades gracefully (e.g. anonymous users keep working).
    if not _ACCOUNTS_AVAILABLE or _accounts is None:
        return None
    token = _session_token_from_request(request)
    if not token:
        return None
    return _accounts.get_user_by_session(token)


def _require_user(request: Request) -> Dict:
    _accounts_or_503()
    user = _current_user(request)
    if not user:
        raise HTTPException(401, "Sign in required.")
    return user


class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    # Optional social handles. Empty strings are stripped server-side.
    tiktok: Optional[str] = None
    instagram: Optional[str] = None
    youtube: Optional[str] = None
    x: Optional[str] = None


def _clean_handles(req) -> Dict[str, str]:
    raw = {
        "tiktok": (req.tiktok or "").strip(),
        "instagram": (req.instagram or "").strip(),
        "youtube": (req.youtube or "").strip(),
        "x": (req.x or "").strip(),
    }
    return {k: v for k, v in raw.items() if v}


@app.post("/api/auth/signup")
async def auth_signup(req: SignupRequest):
    """Create a new free-tier account and return a session token.

    Captures social handles upfront so we can verify creators later (the
    influencer program reuses the same handles). Password rules enforced
    by accounts.hash_password (8+ chars).
    """
    _accounts_or_503()
    try:
        user = _accounts.create_user(
            email=req.email,
            password=req.password,
            full_name=req.full_name,
            social_handles=_clean_handles(req),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    token = _accounts.create_session(user["id"])

    # Fire-and-forget welcome email. No-ops cleanly when SMTP isn't
    # configured, so signup keeps working in dev without setup.
    try:
        from email_utils import send_welcome_email
        send_welcome_email(
            to_email=user.get("email") or req.email,
            full_name=user.get("full_name"),
        )
    except Exception as _email_err:
        print(f"⚠️  Welcome email skipped ({type(_email_err).__name__}: {_email_err})")

    return {"user": user, "token": token}


class SigninRequest(BaseModel):
    email: str
    password: str


@app.post("/api/auth/signin")
async def auth_signin(req: SigninRequest):
    _accounts_or_503()
    user = _accounts.authenticate(req.email, req.password)
    if not user:
        raise HTTPException(401, "Email or password is incorrect.")
    token = _accounts.create_session(user["id"])
    return {"user": user, "token": token}


@app.post("/api/auth/signout")
async def auth_signout(request: Request):
    # Soft-fail: signing out shouldn't error even if accounts is broken.
    # Just clear whatever cookie/header the client sent.
    if _ACCOUNTS_AVAILABLE and _accounts is not None:
        token = _session_token_from_request(request)
        if token:
            _accounts.destroy_session(token)
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    """Return the currently signed-in user, or 401. The frontend uses
    this to bootstrap state on page load."""
    user = _current_user(request)
    if not user:
        raise HTTPException(401, "Not signed in.")
    return {"user": user}


# ---------- OAuth (Google, GitHub) ---------------------------------------
#
# Standard OAuth 2.0 authorization-code flow. No external library — just
# httpx + cookies for state. To enable each provider, set the matching
# CLIENT_ID + CLIENT_SECRET env vars (see _OAUTH_PROVIDERS below). When
# the env vars aren't set we return a clear 503 from /start so the
# frontend can hide the button or show "not configured".
#
# Setup once per provider (free):
#   Google:  https://console.cloud.google.com → APIs & Services →
#            Credentials → OAuth client ID (type: Web application).
#            Authorized redirect URI:
#              https://your-domain/api/auth/oauth/google/callback
#            (use http://localhost:8000/... for local dev).
#   GitHub:  https://github.com/settings/developers → New OAuth app.
#            Authorization callback URL:
#              https://your-domain/api/auth/oauth/github/callback
#
# The user lands back on the SPA at FRONTEND_URL with the new session
# token in the URL fragment (#oauth_token=...). App.jsx picks it up,
# stashes it in localStorage, clears the hash. Token never goes through
# referer/server logs because URL fragments aren't sent.

_OAUTH_PROVIDERS = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
    },
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "userinfo_emails_url": "https://api.github.com/user/emails",
        "scope": "read:user user:email",
        "client_id_env": "GITHUB_CLIENT_ID",
        "client_secret_env": "GITHUB_CLIENT_SECRET",
    },
}


def _oauth_redirect_uri(request: Request, provider: str) -> str:
    """Build the redirect URI for a provider.

    Resolution order, picking the FIRST match:
      1. OAUTH_REDIRECT_BASE env var — pin the exact public origin.
         Set this whenever the backend sits behind ANY proxy. In our
         docker-compose setup the Vite dev server proxies /api with
         changeOrigin:true which rewrites Host to "backend:8000",
         causing Google to reject the request with invalid_request
         because that doesn't match the registered redirect URI. In
         production the same problem hits anyone behind nginx /
         cloudflare without proper X-Forwarded-* headers.
      2. X-Forwarded-Host / X-Forwarded-Proto headers — standard
         reverse-proxy hint. Honour them when present so the user
         doesn't have to manually pin OAUTH_REDIRECT_BASE.
      3. request.url — direct-access fallback (only correct when
         the backend is reached without a proxy).

    Logged on every call so a misconfigured deploy is easy to debug:
    look at the backend log line right after the user clicks Sign in
    with Google and you see the exact redirect_uri being sent.
    """
    base = (os.environ.get("OAUTH_REDIRECT_BASE") or "").strip()
    if not base:
        fwd_host = request.headers.get("x-forwarded-host", "").strip()
        fwd_proto = request.headers.get("x-forwarded-proto", "").strip() or "http"
        if fwd_host:
            base = f"{fwd_proto}://{fwd_host}"
        else:
            base = f"{request.url.scheme}://{request.url.netloc}"
    redirect_uri = f"{base.rstrip('/')}/api/auth/oauth/{provider}/callback"
    print(f"🔐 OAuth {provider}: redirect_uri={redirect_uri}")
    return redirect_uri


def _frontend_url() -> str:
    """Where to send the user after OAuth completes. Configure via
    FRONTEND_URL env (e.g. http://localhost:5175 in dev,
    https://your.app in prod)."""
    return (os.environ.get("FRONTEND_URL") or "/").strip().rstrip("/") or "/"


def _oauth_failure_redirect(reason: str):
    from fastapi.responses import RedirectResponse
    url = f"{_frontend_url()}/#oauth_error={reason}"
    return RedirectResponse(url, status_code=302)


@app.get("/api/auth/oauth/{provider}/start")
async def oauth_start(provider: str, request: Request):
    _accounts_or_503()
    cfg = _OAUTH_PROVIDERS.get(provider)
    if not cfg:
        raise HTTPException(404, "Unknown OAuth provider.")
    client_id = (os.environ.get(cfg["client_id_env"]) or "").strip()
    if not client_id:
        raise HTTPException(
            503,
            f"{provider.title()} sign-in is not configured yet. Set "
            f"{cfg['client_id_env']} (and {cfg['client_secret_env']}) "
            "to enable it.",
        )
    state = secrets.token_urlsafe(24)
    redirect_uri = _oauth_redirect_uri(request, provider)
    from urllib.parse import urlencode
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": cfg["scope"],
        "response_type": "code",
        "state": state,
    }
    if provider == "google":
        # 'select_account' makes it obvious which Google account is
        # being used; without it Chrome silently reuses the only
        # logged-in one which surprises users.
        params["access_type"] = "online"
        params["prompt"] = "select_account"
    auth_url = f"{cfg['authorize_url']}?{urlencode(params)}"
    from fastapi.responses import RedirectResponse
    resp = RedirectResponse(auth_url, status_code=302)
    # Store state in an HttpOnly cookie so the callback can verify it
    # without the SPA having to remember anything across the redirect.
    # samesite=lax is required so the cookie survives the redirect
    # back from the provider.
    resp.set_cookie(
        f"klipra_oauth_state_{provider}",
        state,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        max_age=600,
        path="/",
    )
    return resp


@app.get("/api/auth/oauth/{provider}/callback")
async def oauth_callback(
    provider: str,
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    cfg = _OAUTH_PROVIDERS.get(provider)
    if not cfg:
        raise HTTPException(404, "Unknown OAuth provider.")

    # User cancelled / provider returned an error.
    if error:
        return _oauth_failure_redirect(error)
    if not code:
        return _oauth_failure_redirect("no_code")

    # CSRF check via the state cookie set in /start.
    expected = request.cookies.get(f"klipra_oauth_state_{provider}")
    if not state or not expected or state != expected:
        return _oauth_failure_redirect("invalid_state")

    client_id = (os.environ.get(cfg["client_id_env"]) or "").strip()
    client_secret = (os.environ.get(cfg["client_secret_env"]) or "").strip()
    if not client_id or not client_secret:
        return _oauth_failure_redirect("not_configured")

    redirect_uri = _oauth_redirect_uri(request, provider)
    import httpx
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Step 1: exchange code for an access token.
            tok_resp = await client.post(
                cfg["token_url"],
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
                headers={"Accept": "application/json"},
            )
            if tok_resp.status_code >= 400:
                print(f"OAuth {provider} token exchange failed: {tok_resp.status_code} {tok_resp.text}")
                return _oauth_failure_redirect("token_exchange_failed")
            tok_data = tok_resp.json()
            access_token = tok_data.get("access_token")
            if not access_token:
                return _oauth_failure_redirect("no_access_token")

            # Step 2: fetch the user profile.
            user_resp = await client.get(
                cfg["userinfo_url"],
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                },
            )
            user_resp.raise_for_status()
            user_data = user_resp.json() or {}

            if provider == "google":
                provider_user_id = user_data.get("sub")
                email = user_data.get("email")
                full_name = user_data.get("name")
                avatar_url = user_data.get("picture")
            elif provider == "github":
                provider_user_id = user_data.get("id")
                full_name = user_data.get("name") or user_data.get("login")
                avatar_url = user_data.get("avatar_url")
                email = user_data.get("email")
                # GitHub returns null for email when the user has it
                # set to private. Fall back to /user/emails — the
                # user:email scope grants that.
                if not email:
                    e_resp = await client.get(
                        cfg["userinfo_emails_url"],
                        headers={
                            "Authorization": f"Bearer {access_token}",
                            "Accept": "application/json",
                        },
                    )
                    if e_resp.is_success:
                        emails = e_resp.json() or []
                        primary = next(
                            (e for e in emails if e.get("primary") and e.get("verified")),
                            None,
                        )
                        if primary:
                            email = primary.get("email")
                        elif emails:
                            email = emails[0].get("email")
            else:
                provider_user_id = user_data.get("id") or user_data.get("sub")
                email = user_data.get("email")
                full_name = user_data.get("name")
                avatar_url = None

            try:
                user, oauth_created = _accounts.find_or_create_oauth_user(
                    provider=provider,
                    provider_user_id=provider_user_id,
                    email=email,
                    full_name=full_name,
                    avatar_url=avatar_url,
                )
            except ValueError as e:
                # E.g. GitHub returned no public email and the email
                # endpoint also failed.
                print(f"OAuth {provider} user creation failed: {e}")
                return _oauth_failure_redirect("no_email")

            print(f"DEBUG: user={user}, type={type(user)}, oauth_created={locals().get('oauth_created')}"); session_token = _accounts.create_session(user["id"])

            # Fire a welcome email ONLY when a brand-new account was
            # created via this OAuth — not on every login. The helper
            # is fire-and-forget, so this doesn't slow the redirect.
            if oauth_created and (user.get("email") or "").strip():
                try:
                    from email_utils import send_welcome_email
                    send_welcome_email(
                        to_email=user["email"],
                        full_name=user.get("full_name"),
                    )
                except Exception as _email_err:
                    print(f"⚠️  Welcome email skipped ({type(_email_err).__name__}: {_email_err})")
    except Exception as e:
        # Print the full traceback so we can debug — `str(e)` alone
        # gave us nothing actionable when the user reported
        # exchange_failed. Also include the exception class name in the
        # redirect code so the URL fragment hints at the root cause.
        import traceback
        print(f"OAuth callback error for {provider}: {type(e).__name__}: {e}")
        traceback.print_exc()
        # Common failure modes mapped to clearer codes:
        msg = str(e).lower()
        if "redirect_uri_mismatch" in msg or "redirect uri" in msg:
            return _oauth_failure_redirect("redirect_uri_mismatch")
        if "invalid_grant" in msg:
            return _oauth_failure_redirect("invalid_grant")
        if "timeout" in msg:
            return _oauth_failure_redirect("network_timeout")
        return _oauth_failure_redirect(f"exchange_failed_{type(e).__name__}")

    # Send the SPA back to the front door with the session token in
    # the URL fragment. Fragments aren't transmitted to the server,
    # so the token doesn't end up in access logs.
    from fastapi.responses import RedirectResponse
    front_url = _frontend_url()
    target = f"{front_url}/#oauth_token={session_token}"
    resp = RedirectResponse(target, status_code=302)
    # Tidy up the state cookie now that we're done with it.
    resp.delete_cookie(f"klipra_oauth_state_{provider}", path="/")
    return resp


# ---------- Influencer applications ----------

class InfluencerApplyRequest(BaseModel):
    email: str
    full_name: Optional[str] = None
    tiktok: Optional[str] = None
    instagram: Optional[str] = None
    youtube: Optional[str] = None
    x: Optional[str] = None
    # Links to the promotional videos the creator has posted about
    # Klipra. Free-text list; one URL per line on the frontend.
    promo_links: Optional[List[str]] = None
    notes: Optional[str] = None


@app.post("/api/influencer/apply")
async def influencer_apply(req: InfluencerApplyRequest):
    """Public endpoint — no auth required. Creators submit promo-video
    links + their handles; you review the apps in the DB and email
    them the install guide manually."""
    _accounts_or_503()
    try:
        app_id = _accounts.submit_influencer_application(
            email=req.email,
            full_name=req.full_name,
            social_handles=_clean_handles(req),
            promo_links=req.promo_links or [],
            notes=req.notes,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "application_id": app_id}


@app.get("/api/influencer/applications")
async def influencer_list(request: Request, status: Optional[str] = None):
    """Admin-only listing of influencer applications. Used for manual
    review until we build a proper admin dashboard."""
    user = _require_user(request)
    if not user.get("is_admin"):
        raise HTTPException(403, "Admin only.")
    return {"applications": _accounts.list_influencer_applications(status)}


# ---------- Stripe billing ----------
#
# All Stripe-touching code is gated behind the env vars below. When
# they're not set, the endpoints return a clear "not configured"
# error so the frontend can show a "Coming soon" or "Contact us"
# affordance without crashing.
#
# Required env vars (set on your hosting platform):
#   STRIPE_SECRET_KEY        — sk_live_… or sk_test_…
#   STRIPE_WEBHOOK_SECRET    — whsec_… from your webhook endpoint
#   STRIPE_PRICE_PRO         — Stripe price ID for the Pro tier
#   STRIPE_PRICE_STUDIO      — Stripe price ID for the Studio tier
#   STRIPE_SUCCESS_URL       — where to redirect on successful checkout
#                              (e.g. https://your.app/billing/success)
#   STRIPE_CANCEL_URL        — where to redirect on canceled checkout
#                              (e.g. https://your.app/pricing)

def _stripe_client():
    key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise HTTPException(503, "Stripe is not configured. Set STRIPE_SECRET_KEY.")
    import stripe
    stripe.api_key = key
    return stripe


_PLAN_TO_ENV = {
    "pro": "STRIPE_PRICE_PRO",
    "studio": "STRIPE_PRICE_STUDIO",
}


class CheckoutRequest(BaseModel):
    plan: str  # 'pro' or 'studio'


@app.post("/api/billing/checkout")
async def billing_checkout(req: CheckoutRequest, request: Request):
    user = _require_user(request)
    if req.plan not in _PLAN_TO_ENV:
        raise HTTPException(400, f"Unknown plan: {req.plan}")
    price_env = _PLAN_TO_ENV[req.plan]
    price_id = os.environ.get(price_env, "").strip()
    if not price_id:
        raise HTTPException(503, f"{req.plan} pricing is not configured. Set {price_env}.")
    stripe = _stripe_client()
    success_url = os.environ.get("STRIPE_SUCCESS_URL", "").strip() or "https://example.com/billing/success"
    cancel_url = os.environ.get("STRIPE_CANCEL_URL", "").strip() or "https://example.com/pricing"
    try:
        # Reuse an existing Stripe customer if we've seen this user before.
        customer_id = user.get("stripe_customer_id")
        if not customer_id:
            customer = stripe.Customer.create(
                email=user["email"],
                name=user.get("full_name") or user["email"],
                metadata={"user_id": str(user["id"])},
            )
            customer_id = customer.id
            _accounts.attach_stripe_customer(user["id"], customer_id)
        session = stripe.checkout.Session.create(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            allow_promotion_codes=True,
            metadata={"user_id": str(user["id"]), "plan": req.plan},
        )
        return {"url": session.url}
    except Exception as e:
        raise HTTPException(502, f"Stripe error: {e}")


@app.post("/api/billing/portal")
async def billing_portal(request: Request):
    """Send the user to the Stripe customer portal to manage / cancel
    their subscription. Requires they already have a stripe_customer_id."""
    user = _require_user(request)
    customer_id = user.get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(400, "No subscription to manage.")
    stripe = _stripe_client()
    return_url = os.environ.get("STRIPE_CANCEL_URL", "").strip() or "https://example.com/account"
    try:
        portal = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )
        return {"url": portal.url}
    except Exception as e:
        raise HTTPException(502, f"Stripe error: {e}")


@app.post("/api/billing/webhook")
async def billing_webhook(request: Request):
    """Receive subscription lifecycle events from Stripe and sync the
    user's plan tier. Stripe signs the payload — we verify it with
    STRIPE_WEBHOOK_SECRET to reject spoofed callbacks.
    """
    _accounts_or_503()
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise HTTPException(503, "Webhook secret not configured.")
    stripe = _stripe_client()
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except Exception as e:
        raise HTTPException(400, f"Invalid Stripe signature: {e}")

    et = event.get("type")
    data = (event.get("data") or {}).get("object") or {}

    # Map sub events to plan changes. We key off the price ID rather
    # than metadata so manual price swaps in the dashboard still work.
    pro_id = os.environ.get("STRIPE_PRICE_PRO", "")
    studio_id = os.environ.get("STRIPE_PRICE_STUDIO", "")

    def _plan_from_subscription(sub) -> Optional[str]:
        items = (sub.get("items") or {}).get("data") or []
        for it in items:
            pid = (((it.get("price") or {}).get("id")) or "")
            if pid and pid == pro_id:
                return "pro"
            if pid and pid == studio_id:
                return "studio"
        return None

    if et in ("customer.subscription.created", "customer.subscription.updated"):
        customer_id = data.get("customer")
        user = _accounts.find_user_by_stripe_customer(customer_id)
        if not user:
            return {"ok": True, "ignored": "unknown_customer"}
        plan = _plan_from_subscription(data) or "free"
        _accounts.set_plan(user["id"], plan, stripe_subscription_id=data.get("id"))
        return {"ok": True, "set_plan": plan}
    if et == "customer.subscription.deleted":
        customer_id = data.get("customer")
        user = _accounts.find_user_by_stripe_customer(customer_id)
        if user:
            _accounts.set_plan(user["id"], "free")
        return {"ok": True, "set_plan": "free"}
    # Other events (invoice.paid, payment_intent.*) ignored — we drive
    # plan state purely from subscription lifecycle.
    return {"ok": True, "ignored": et}


# --- Remotion Render Proxy ---
RENDER_SERVICE_URL = os.getenv("RENDER_SERVICE_URL", "http://renderer:3100")

@app.post("/api/render")
async def proxy_render(request: Request):
    """Proxy render requests to the Node.js Remotion render service."""
    import httpx
    body = await request.json()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{RENDER_SERVICE_URL}/render", json=body)
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Render service unavailable: {e}")

@app.get("/api/render/{render_id}")
async def proxy_render_status(render_id: str):
    """Proxy render status polling to the Node.js Remotion render service."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{RENDER_SERVICE_URL}/render/{render_id}")
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Render service unavailable: {e}")


class EffectsGenerateRequest(BaseModel):
    job_id: str
    clip_index: int
    input_filename: Optional[str] = None

@app.post("/api/effects/generate")
async def generate_effects_config(
    req: EffectsGenerateRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key"),
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    """Generate structured EffectsConfig JSON for Remotion rendering."""
    provider_id = (x_llm_provider or "gemini").lower()
    final_api_key = x_llm_key or x_gemini_key or os.environ.get("GEMINI_API_KEY")

    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing API key (X-LLM-Key)")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")

    try:
        # Resolve input path
        if req.input_filename:
            safe_name = os.path.basename(req.input_filename)
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
        else:
            clip = job['result']['clips'][req.clip_index]
            filename = _clip_filename_from_url(clip['video_url'])
            input_path = os.path.join(OUTPUT_DIR, req.job_id, filename)

        if not os.path.exists(input_path):
            raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

        def run_effects_generation():
            editor = VideoEditor(
                api_key=final_api_key,
                provider_id=provider_id,
                model_name=x_llm_model,
                base_url=x_llm_base_url,
            )

            # Create safe ASCII filename to avoid encoding issues
            safe_filename = f"temp_effects_{req.job_id}.mp4"
            safe_input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_filename)
            shutil.copy(input_path, safe_input_path)

            try:
                # Upload video to Gemini
                vid_file = editor.upload_video(safe_input_path)

                # Get video metadata via ffprobe
                probe_cmd = [
                    'ffprobe', '-v', 'error',
                    '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height,r_frame_rate,duration',
                    '-show_entries', 'format=duration',
                    '-of', 'json',
                    safe_input_path
                ]
                probe_result = subprocess.check_output(probe_cmd).decode().strip()
                probe_data = json.loads(probe_result)

                stream = probe_data.get('streams', [{}])[0]
                width = int(stream.get('width', 1080))
                height = int(stream.get('height', 1920))

                # Parse fps from r_frame_rate (e.g. "30/1")
                r_frame_rate = stream.get('r_frame_rate', '30/1')
                num, den = r_frame_rate.split('/')
                fps = round(int(num) / int(den), 2)

                # Get duration from stream or format
                duration = float(stream.get('duration', 0))
                if duration == 0:
                    duration = float(probe_data.get('format', {}).get('duration', 0))

                # Load transcript from metadata
                transcript = None
                try:
                    meta_files = glob.glob(os.path.join(OUTPUT_DIR, req.job_id, "*_metadata.json"))
                    if meta_files:
                        with open(meta_files[0], 'r') as f:
                            data = json.load(f)
                            transcript = data.get('transcript')
                except Exception as e:
                    print(f"⚠️ Could not load transcript for effects config: {e}")

                # Generate effects config
                effects_config = editor.get_effects_config(
                    vid_file, duration, fps=fps, width=width, height=height, transcript=transcript
                )

                return effects_config
            finally:
                if os.path.exists(safe_input_path):
                    os.remove(safe_input_path)

        loop = asyncio.get_event_loop()
        effects_config = await loop.run_in_executor(None, run_effects_generation)

        if effects_config is None:
            raise HTTPException(status_code=500, detail="Failed to generate effects config from Gemini")

        return {"effects": effects_config}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Effects Generation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/subtitle")
async def add_subtitles(
    req: SubtitleRequest,
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    # Reload job data from disk just in case metadata was updated
    job = jobs[req.job_id]

    # We need to access metadata.json to get the transcript
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")

    with open(json_files[0], 'r') as f:
        data = json.load(f)

    transcript = data.get('transcript')
    script_mode = (req.script_mode or "auto").lower()

    # If the user just ran the two-phase Regenerate flow, the cleaned
    # per-clip transcript is sitting on the clip itself. Prefer that
    # over the job-level cached one — it's both fresher and (if they
    # asked for Roman/Translate cleanup during phase 1) already
    # massaged into the right script.
    clips_for_lookup = data.get('shorts', [])
    if 0 <= req.clip_index < len(clips_for_lookup):
        regen = clips_for_lookup[req.clip_index].get('regenerated_transcript')
        if regen and isinstance(regen, dict) and regen.get('segments'):
            print(f"📝 Using regenerated transcript for clip {req.clip_index} (skipping re-transcribe)")
            transcript = regen
            # The clip's segment timings on the regen are clip-local
            # (start at 0). Mark a flag so the SRT generator below
            # treats them as already-clip-local.
            transcript['_already_clip_local'] = True

    # 'regenerate' re-transcribes this clip's audio from scratch via
    # Whisper — the cached transcript isn't needed (and may be missing
    # entirely for older jobs). Every other mode does need it.
    if not transcript and script_mode != "regenerate":
        raise HTTPException(status_code=400, detail="Transcript not found in metadata. Please process a new video.")

    # If the user hand-edited the transcript text in the regenerate
    # preview, override the segment text with their edits — keeping the
    # original segment timings, redistributing words across them.
    if req.edited_text and transcript and transcript.get('segments'):
        new_words = req.edited_text.strip().split()
        segs = transcript['segments']
        if new_words and segs:
            # Naive even-redistribution proportional to each segment's
            # original duration. Good enough for subtitle pacing.
            total_dur = max(1e-3, sum(
                max(0.0, float(s.get('end', 0)) - float(s.get('start', 0)))
                for s in segs
            ))
            words_per_sec = len(new_words) / total_dur
            cursor = 0
            for s in segs:
                seg_dur = max(0.0, float(s.get('end', 0)) - float(s.get('start', 0)))
                take = max(1, int(round(seg_dur * words_per_sec)))
                slice_words = new_words[cursor:cursor + take]
                cursor += take
                s['text'] = ' '.join(slice_words)
                # Spread word-level timestamps evenly over [start, end].
                if slice_words and seg_dur > 0:
                    per = seg_dur / len(slice_words)
                    base = float(s.get('start', 0))
                    s['words'] = [
                        {'word': w, 'start': base + i * per, 'end': base + (i + 1) * per}
                        for i, w in enumerate(slice_words)
                    ]
                else:
                    s['words'] = []
            # Any remainder → tack onto the last non-empty segment.
            if cursor < len(new_words):
                tail = ' '.join(new_words[cursor:])
                segs[-1]['text'] = (segs[-1].get('text') or '') + ' ' + tail
            transcript['text'] = ' '.join(s.get('text', '') for s in segs)
            print(f"✏️  Used hand-edited transcript ({len(new_words)} words)")

    # Optional: transliterate or translate the transcript before subtitle
    # generation. Useful when Whisper outputs Hindi/Urdu/Arabic/etc. but
    # the user wants Roman/Latin script ("Roman Urdu") or another language.
    if script_mode in ("roman", "translate"):
        transcript = _llm_rewrite_transcript(
            transcript=transcript,
            mode=script_mode,
            target_language=req.target_language,
            provider_id=(x_llm_provider or "gemini").lower(),
            model_name=x_llm_model or "gemini-2.5-flash",
            api_key=x_llm_key or os.environ.get("GEMINI_API_KEY", ""),
            base_url=x_llm_base_url,
        )
        
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")
        
    clip_data = clips[req.clip_index]
    
    # Video Path
    if req.input_filename:
        # Use chained file
        filename = os.path.basename(req.input_filename)
    else:
        # Fallback to standard naming
        filename = _clip_filename_from_url(clip_data.get('video_url', ''))
        if not filename:
             base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
             filename = f"{base_name}_clip_{req.clip_index+1}.mp4"
         
    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        # Try looking for edited version if url implied it?
        # Just fail if not found.
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")
        
    # Define outputs. Suffix output filename with cache_bust ms so each
    # generation writes a NEW file — sidesteps any leftover-cache issues.
    cache_bust = int(time.time() * 1000)
    srt_filename = f"subs_{req.clip_index}_{cache_bust}.srt"
    srt_path = os.path.join(output_dir, srt_filename)

    output_filename = f"subtitled_{cache_bust}_{filename}"
    output_path = os.path.join(output_dir, output_filename)
    
    try:
        # 1. Generate SRT
        # Three paths:
        #   • DUBBED clip — must re-transcribe (the cached transcript is
        #     in the original language, not the dubbed audio).
        #   • REGENERATE — user explicitly asked for a fresh Whisper
        #     pass on this clip's audio (overrides the cached transcript).
        #     Useful when the original transcribe was wrong.
        #   • Otherwise — use the cached transcript sliced to this clip.
        is_dubbed = filename.startswith("translated_")
        # If we're using a regenerated (clip-local) transcript already,
        # don't transcribe again — slice from t=0 to clip duration.
        using_clip_local = bool(transcript and transcript.get('_already_clip_local'))
        # 'regenerate' script_mode forces a fresh transcription, EXCEPT
        # when we already have a regenerated transcript on the clip (the
        # two-phase Regenerate flow already did it).
        force_retranscribe = (script_mode == "regenerate") and not using_clip_local

        # Decide whether this transcript has reliable per-WORD timings
        # (use the rich word-level SRT generator) or only reliable
        # per-SEGMENT timings (use the per-segment generator).
        #
        # The Phase-3 Sync step builds proper per-word alignment by
        # matching user words against Whisper's word-level timestamps
        # via difflib. When the saved regen has `_word_timings_aligned`
        # set, the per-word SRT generator produces subtitles that light
        # up the moment each word is actually spoken — which is what
        # users actually want from "synced subtitles".
        used_rewrite = (script_mode in ("roman", "translate"))
        used_edited_text = bool(req.edited_text)
        word_aligned = bool(transcript and transcript.get('_word_timings_aligned'))
        # Word-level for: synced transcripts (real Whisper word timings)
        # AND original untouched Whisper output. Per-segment for:
        # LLM-rewritten or edited transcripts that haven't been synced.
        per_segment_mode = (using_clip_local or used_rewrite or used_edited_text) and not word_aligned

        if is_dubbed or force_retranscribe:
            label = "Dubbed clip" if is_dubbed else "Regenerate requested"
            print(f"🎙️ {label} — re-transcribing this clip's audio…")
            def run_transcribe_srt():
                return generate_srt_from_video(input_path, srt_path)
            loop = asyncio.get_event_loop()
            success = await loop.run_in_executor(None, run_transcribe_srt)
        elif word_aligned:
            # User ran Phase-3 Sync. Word-level timings are real
            # (matched against Whisper, interpolated for edits) — use
            # the per-WORD SRT generator so each word lights up at the
            # exact moment it's spoken.
            clip_dur = float(clip_data.get('end', 0)) - float(clip_data.get('start', 0))
            print("🎯 Using per-WORD subtitle timing (Phase-3 sync alignment)")
            success = generate_srt(transcript, 0.0, clip_dur if clip_dur > 0 else 1e9, srt_path)
        elif per_segment_mode:
            # No Phase-3 Sync. Word timings are synthetic / unreliable
            # (LLM rewrite or hand-edit), so display the whole segment
            # text inside Whisper's accurate segment window. Better than
            # word-level drift, worse than synced word-level.
            clip_dur = float(clip_data.get('end', 0)) - float(clip_data.get('start', 0))
            if using_clip_local:
                start_t, end_t = 0.0, clip_dur if clip_dur > 0 else 1e9
            else:
                start_t, end_t = clip_data['start'], clip_data['end']
            print("📝 Using per-SEGMENT subtitle timing (synced to Whisper segments)")
            success = generate_srt_per_segment(transcript, start_t, end_t, srt_path)
        else:
            # Original cached transcript — Whisper word timings are accurate.
            success = generate_srt(transcript, clip_data['start'], clip_data['end'], srt_path)

        if not success:
             raise HTTPException(status_code=400, detail="No words found for this clip range.")

        # 2. Burn Subtitles
        # Run in thread pool
        def run_burn():
             burn_subtitles(input_path, srt_path, output_path,
                           alignment=req.position, fontsize=req.font_size,
                           font_name=req.font_name, font_color=req.font_color,
                           border_color=req.border_color, border_width=req.border_width,
                           bg_color=req.bg_color, bg_opacity=req.bg_opacity,
                           # Animation + highlight wired in for Pop / Karaoke
                           # / Glow. Backwards-compatible: missing fields
                           # default to 'none' / yellow which keeps prior
                           # callers (Standalone subtitle, dub burn) working
                           # exactly as before.
                           animation=(req.animation or "none"),
                           highlight_color=(req.highlight_color or "#FFDD00"))
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run_burn)
        
    except Exception as e:
        print(f"❌ Subtitle Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    # 3. Persist via the central helper — pushes prev URL onto history,
    # syncs metadata.json, mirrors to in-memory job, mints cache-bust.
    new_video_url = _apply_clip_change(
        req.job_id, req.clip_index, output_filename,
        operation='subtitle',
    )

    return {
        "success": True,
        "new_video_url": new_video_url
    }

class HookRequest(BaseModel):
    job_id: str
    clip_index: int
    text: str
    input_filename: Optional[str] = None
    position: Optional[str] = "top" # top, center, bottom
    size: Optional[str] = "M" # S, M, L
    # Custom styling — all optional. Hex strings like "#FFFFFF". Opacity
    # is 0.0–1.0 of the background fill.
    text_color: Optional[str] = "#000000"
    bg_color: Optional[str] = "#FFFFFF"
    bg_opacity: Optional[float] = 0.94
    # Optional vertical position override (0–100, % from top of frame).
    # When provided, takes precedence over the `position` preset so users
    # can drag the hook to any spot via the slider in the modal.
    y_offset: Optional[float] = None

@app.post("/api/hook")
async def add_hook(req: HookRequest):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")
    with open(json_files[0], 'r') as f:
        data = json.load(f)
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")
    clip_data = clips[req.clip_index]

    # Resolve input video. The frontend sends `input_filename` which is
    # the CURRENT video filename (cache-bust stripped) — use that so
    # repeat applies stack on each other rather than rendering the same
    # original over and over.
    if req.input_filename:
        filename = os.path.basename(req.input_filename)
    else:
        filename = _clip_filename_from_url(clip_data.get('video_url', ''))
        if not filename:
            base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
            filename = f"{base_name}_clip_{req.clip_index+1}.mp4"
    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

    # Output filename. Suffix with cache_bust ms so each call writes a
    # NEW file — sidesteps any leftover-cache issues even if `?v=` is
    # ignored by some intermediate proxy.
    cache_bust = int(time.time() * 1000)
    output_filename = f"hook_{cache_bust}_{filename}"
    output_path = os.path.join(output_dir, output_filename)

    size_map = {"S": 0.8, "M": 1.0, "L": 1.3}
    font_scale = size_map.get(req.size, 1.0)

    try:
        def run_hook():
            add_hook_to_video(
                input_path, req.text, output_path,
                position=req.position, font_scale=font_scale,
                text_color=req.text_color or "#000000",
                bg_color=req.bg_color or "#FFFFFF",
                bg_opacity=float(req.bg_opacity if req.bg_opacity is not None else 0.94),
                y_offset_pct=req.y_offset,
            )
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run_hook)
    except Exception as e:
        print(f"❌ Hook Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    new_video_url = _apply_clip_change(
        req.job_id, req.clip_index, output_filename,
        operation='hook',
    )
    return {
        "success": True,
        "new_video_url": new_video_url,
    }

class TranslateRequest(BaseModel):
    job_id: str
    clip_index: int
    target_language: str
    source_language: Optional[str] = None
    input_filename: Optional[str] = None
    # 'elevenlabs' = paid, voice cloning. 'edge' = free, Microsoft neural voices.
    dub_provider: Optional[str] = "elevenlabs"
    voice: Optional[str] = None  # explicit Edge TTS voice override
    # When true, the original voice is kept underneath the dub at low
    # volume (documentary-style). Edge path only.
    keep_original: Optional[bool] = False
    original_volume: Optional[float] = 0.2
    # When true (default), the dubbed clip is added as a NEW clip in the
    # gallery and the original stays untouched. When false, the original
    # clip is overwritten with the dubbed version (legacy behavior).
    keep_separate: Optional[bool] = True
    # Voice gender — 'male' / 'female' / 'auto'. 'auto' asks the LLM to
    # detect from the source transcript.
    voice_gender: Optional[str] = "auto"

@app.get("/api/translate/languages")
async def get_languages(dub_provider: Optional[str] = "elevenlabs"):
    """Return supported languages for the selected dubbing provider."""
    if (dub_provider or "").lower() == "edge":
        from dub_edge import get_supported_languages as edge_langs
        return {"languages": edge_langs()}
    return {"languages": get_supported_languages()}

@app.post("/api/translate")
async def translate_clip(
    req: TranslateRequest,
    x_elevenlabs_key: Optional[str] = Header(None, alias="X-ElevenLabs-Key"),
    x_llm_provider: Optional[str] = Header(None, alias="X-LLM-Provider"),
    x_llm_model: Optional[str] = Header(None, alias="X-LLM-Model"),
    x_llm_key: Optional[str] = Header(None, alias="X-LLM-Key"),
    x_llm_base_url: Optional[str] = Header(None, alias="X-LLM-Base-URL"),
):
    """Translate a video clip's audio. Supports two engines:
       - 'elevenlabs' (default, requires X-ElevenLabs-Key) — voice cloning + dubbing
       - 'edge' (free, no key) — LLM translates the transcript, Edge TTS speaks it
    """
    dub_provider = (req.dub_provider or "elevenlabs").lower()
    if dub_provider == "elevenlabs" and not x_elevenlabs_key:
        raise HTTPException(status_code=400, detail="Missing X-ElevenLabs-Key header")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[req.job_id]
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")

    with open(json_files[0], 'r') as f:
        data = json.load(f)

    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")

    clip_data = clips[req.clip_index]

    # Video Path
    if req.input_filename:
        filename = os.path.basename(req.input_filename)
    else:
        filename = _clip_filename_from_url(clip_data.get('video_url', ''))
        if not filename:
             base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
             filename = f"{base_name}_clip_{req.clip_index+1}.mp4"

    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

    # Output video with language suffix
    base, ext = os.path.splitext(filename)
    output_filename = f"translated_{req.target_language}_{base}{ext}"
    output_path = os.path.join(output_dir, output_filename)

    try:
        if dub_provider == "edge":
            # Free path: LLM translates the clip transcript, Edge TTS speaks it.
            from dub_edge import dub_with_edge_tts
            from llm import build_provider

            # 1. Pull the clip's transcript text from metadata.json.
            transcript_text = (clip_data.get("transcript_text")
                               or clip_data.get("video_description_for_instagram")
                               or "").strip()
            # If metadata didn't include a per-clip transcript, splice from the
            # full transcript using start/end seconds.
            if not transcript_text:
                full = data.get("transcript", {})
                segs = full.get("segments", []) if isinstance(full, dict) else []
                clip_start = float(clip_data.get("start", 0))
                clip_end = float(clip_data.get("end", 9e9))
                pieces = []
                for seg in segs:
                    if seg.get("end", 0) > clip_start and seg.get("start", 0) < clip_end:
                        pieces.append(seg.get("text", ""))
                transcript_text = " ".join(pieces).strip()
            if not transcript_text:
                raise HTTPException(
                    status_code=400,
                    detail="No transcript text on this clip — re-run job to enable Edge TTS dubbing.",
                )

            # 2. Translate via the user's chosen LLM.
            provider_id = (x_llm_provider or "gemini").lower()
            llm_key = x_llm_key or os.environ.get("GEMINI_API_KEY")
            if provider_id != "ollama" and not llm_key:
                raise HTTPException(
                    status_code=400,
                    detail="LLM key required for translation (X-LLM-Key).",
                )
            provider = build_provider(
                provider_id,
                x_llm_model or "gemini-2.5-flash",
                llm_key or "",
                base_url=x_llm_base_url,
            )
            from dub_edge import LANGUAGE_NAMES
            target_name = LANGUAGE_NAMES.get(req.target_language, req.target_language)

            # IMPORTANT: use complete_json (not complete_text) here.
            # Reasoning models — MiniMax M2.7, Gemini 2.5 Thinking,
            # Claude Sonnet with extended thinking, OpenAI o-series — emit
            # their reasoning trace BEFORE the final answer when called via
            # complete_text. That whole reasoning trace ends up being spoken
            # by the TTS engine ("user selected English language let's see
            # what he says…"). complete_json forces a structured response
            # we can extract the clean field from.
            try:
                from prompt_rules import USER_TEXT_RULES as _UTR_DUB
            except ImportError:
                _UTR_DUB = ""
            translation_resp = provider.complete_json(
                f"You are a subtitle translator. Translate the user's text to {target_name}. "
                f"Keep tone and length close to the original — these are spoken subtitles, "
                f"so the translation should sound natural read aloud.\n\n"
                f"{_UTR_DUB}\n\n"
                f'Return ONLY this JSON: {{"translation": "<translated text>"}}. '
                f"Do not include any reasoning, commentary, or extra fields.",
                transcript_text,
                max_tokens=2048,
            )
            if isinstance(translation_resp, dict):
                translated_text = (translation_resp.get("translation") or "").strip()
            elif isinstance(translation_resp, str):
                translated_text = translation_resp.strip()
            else:
                translated_text = ""
            # Defensive: strip any stray "translation:" prefix or quotes
            # the model may have left in.
            for prefix in ("translation:", "Translation:", "TRANSLATION:"):
                if translated_text.lower().startswith(prefix.lower()):
                    translated_text = translated_text[len(prefix):].strip()
            if (translated_text.startswith('"') and translated_text.endswith('"')) or \
               (translated_text.startswith("'") and translated_text.endswith("'")):
                translated_text = translated_text[1:-1].strip()
            if not translated_text:
                raise HTTPException(500, "LLM returned empty translation")
            print(f"🌐 Translation: {translated_text[:160]}{'…' if len(translated_text) > 160 else ''}")

            # 3. Decide voice gender. If user passed 'auto', ask the LLM
            # to guess from the original transcript. Use complete_json for
            # the same reasoning-model safety as above.
            gender = (req.voice_gender or "auto").lower()
            if gender == "auto":
                try:
                    g_resp = provider.complete_json(
                        "You classify a speaker's apparent gender from their speech transcript. "
                        'Respond ONLY with this JSON: {"gender": "male"} or {"gender": "female"} '
                        'or {"gender": "unknown"}. No reasoning, no extra fields.',
                        f"Transcript:\n\n{transcript_text[:2000]}",
                        max_tokens=64,
                    )
                    g_val = ""
                    if isinstance(g_resp, dict):
                        g_val = str(g_resp.get("gender") or "").lower()
                    elif isinstance(g_resp, str):
                        g_val = g_resp.lower()
                    if "male" in g_val and "female" not in g_val:
                        gender = "male"
                    elif "female" in g_val:
                        gender = "female"
                    else:
                        gender = "female"  # safe default
                    print(f"🎙️ LLM detected speaker gender: {gender}")
                except Exception as e:
                    print(f"⚠️ Gender detection failed ({e}); defaulting to female")
                    gender = "female"

            # 4. Pick the right Edge voice for the chosen gender.
            from dub_edge import pick_voice
            chosen_voice = req.voice or pick_voice(req.target_language, gender)

            # 5. Run TTS + mux in a thread.
            keep_vol = float(req.original_volume or 0.0) if req.keep_original else 0.0
            def run_edge():
                return dub_with_edge_tts(
                    video_path=input_path,
                    output_path=output_path,
                    target_language=req.target_language,
                    text_to_speak=translated_text,
                    voice=chosen_voice,
                    keep_original_volume=keep_vol,
                )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, run_edge)
        else:
            # ElevenLabs path — original behavior.
            def run_translate():
                return translate_video(
                    video_path=input_path,
                    output_path=output_path,
                    target_language=req.target_language,
                    api_key=x_elevenlabs_key,
                    source_language=req.source_language,
                )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, run_translate)

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Translation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    cache_bust_dub = int(time.time() * 1000)
    new_video_url_with_v = f"/videos/{req.job_id}/{output_filename}?v={cache_bust_dub}"
    keep_separate = bool(getattr(req, "keep_separate", True))

    if keep_separate:
        # Add the dubbed clip as a NEW entry alongside the original.
        # Inherit hooks/title/timing from the source clip but mark the
        # language and engine in the title so the gallery makes sense.
        original_clip = job['result']['clips'][req.clip_index] if req.clip_index < len(job['result']['clips']) else {}
        new_clip = dict(original_clip)
        # Drop the original's history — undo on a dub clip should NOT
        # walk back into the source clip's edit chain.
        new_clip.pop('history', None)
        new_clip['video_url'] = new_video_url_with_v
        new_clip['_dubbed_from_index'] = req.clip_index
        new_clip['_dub_language'] = req.target_language
        suffix = f" [dub · {req.target_language}]"
        for key in ('video_title_for_youtube_short',
                    'video_description_for_instagram',
                    'video_description_for_tiktok'):
            if key in new_clip and isinstance(new_clip[key], str) and suffix not in new_clip[key]:
                new_clip[key] = new_clip[key] + suffix
        job['result']['clips'].append(new_clip)

        try:
            clips.append({**new_clip})
            data['shorts'] = clips
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Added dubbed clip [{req.target_language}] as new entry; original preserved")
        except Exception as e:
            print(f"⚠️ Failed to update metadata.json: {e}")
    else:
        # Replace-in-place — push old URL onto undo stack so user can
        # restore the original (un-dubbed) clip in one click.
        new_video_url_with_v = _apply_clip_change(
            req.job_id, req.clip_index, output_filename,
            operation=f'dub-{req.target_language}',
            extra={'_dub_language': req.target_language},
        )

    return {
        "success": True,
        "new_video_url": new_video_url_with_v,
        "keep_separate": keep_separate,
    }

class SocialPostRequest(BaseModel):
    job_id: str
    clip_index: int
    api_key: str
    user_id: str
    platforms: List[str] # ["tiktok", "instagram", "youtube"]
    # Optional overrides if frontend wants to edit them
    title: Optional[str] = None
    description: Optional[str] = None
    scheduled_date: Optional[str] = None # ISO-8601 string
    timezone: Optional[str] = "UTC"

import httpx

@app.post("/api/social/post")
async def post_to_socials(req: SocialPostRequest):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")
        
    try:
        clip = job['result']['clips'][req.clip_index]
        # Video URL is relative /videos/..., we need absolute file path
        # clip['video_url'] is like "/videos/{job_id}/{filename}"
        # We constructed it as: f"/videos/{job_id}/{clip_filename}"
        # And file is at f"{OUTPUT_DIR}/{job_id}/{clip_filename}"
        
        filename = _clip_filename_from_url(clip['video_url'])
        file_path = os.path.join(OUTPUT_DIR, req.job_id, filename)
        
        if not os.path.exists(file_path):
             raise HTTPException(status_code=404, detail=f"Video file not found: {file_path}")

        # Construct parameters for Upload-Post API
        # Fallbacks
        final_title = req.title or clip.get('title', 'Viral Short')
        final_description = req.description or clip.get('video_description_for_instagram') or clip.get('video_description_for_tiktok') or "Check this out!"
        
        # Prepare form data
        url = "https://api.upload-post.com/api/upload"
        headers = {
            "Authorization": f"Apikey {req.api_key}"
        }
        
        # Prepare data as dict (httpx handles lists for multiple values)
        data_payload = {
            "user": req.user_id,
            "title": final_title,
            "platform[]": req.platforms, # Pass list directly
            "async_upload": "true"  # Enable async upload
        }

        # Add scheduling if present
        if req.scheduled_date:
            data_payload["scheduled_date"] = req.scheduled_date
            if req.timezone:
                data_payload["timezone"] = req.timezone
        
        # Add Platform specifics
        if "tiktok" in req.platforms:
             data_payload["tiktok_title"] = final_description
             
        if "instagram" in req.platforms:
             data_payload["instagram_title"] = final_description
             data_payload["media_type"] = "REELS"

        if "youtube" in req.platforms:
             yt_title = req.title or clip.get('video_title_for_youtube_short', final_title)
             data_payload["youtube_title"] = yt_title
             data_payload["youtube_description"] = final_description
             data_payload["privacyStatus"] = "public"

        # Send File
        # httpx AsyncClient requires async file reading or bytes. 
        # Since we have MAX_FILE_SIZE_MB, reading into memory is safe-ish.
        with open(file_path, "rb") as f:
            file_content = f.read()
            
        files = {
            "video": (filename, file_content, "video/mp4")
        }

        # Switch to synchronous Client to avoid "sync request with AsyncClient" error with multipart/files
        with httpx.Client(timeout=120.0) as client:
            print(f"📡 Sending to Upload-Post for platforms: {req.platforms}")
            response = client.post(url, headers=headers, data=data_payload, files=files)
            
        if response.status_code not in [200, 201, 202]: # Added 201
             print(f"❌ Upload-Post Error: {response.text}")
             raise HTTPException(status_code=response.status_code, detail=f"Vendor API Error: {response.text}")

        return response.json()

    except Exception as e:
        print(f"❌ Social Post Exception: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/social/connect-link")
async def get_social_connect_link(
    platform: str,
    profile: Optional[str] = None,
    api_key: str = Header(..., alias="X-Upload-Post-Key"),
):
    """Return the Upload-Post URL the user should open to connect a
    specific social platform (tiktok / instagram / youtube). Upload-Post
    doesn't currently expose a documented per-platform deep-link, so we
    return their manage-users page — the user picks the platform from
    that page. Front-end then polls /api/social/user to detect connection.
    """
    platform = (platform or "").lower()
    if platform not in {"tiktok", "instagram", "youtube"}:
        raise HTTPException(400, "Unsupported platform")

    # The manage-users page accepts the user's API key implicitly via
    # their Upload-Post session cookie. We just deep-link.
    base = "https://app.upload-post.com/manage-users"
    return {
        "url": base if not profile else f"{base}?profile={profile}",
        "platform": platform,
        "instructions": (
            f"In the popup that opens, click your profile and connect {platform}. "
            "When done, close the popup — we'll auto-detect the new connection."
        ),
    }


@app.get("/api/social/user")
async def get_social_user(api_key: str = Header(..., alias="X-Upload-Post-Key")):
    """Proxy to fetch user ID from Upload-Post"""
    if not api_key:
         raise HTTPException(status_code=400, detail="Missing X-Upload-Post-Key header")
         
    url = "https://api.upload-post.com/api/uploadposts/users"
    print(f"🔍 Fetching User ID from: {url}")
    headers = {"Authorization": f"Apikey {api_key}"}
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                print(f"❌ Upload-Post User Fetch Error: {resp.text}")
                raise HTTPException(status_code=resp.status_code, detail=f"Failed to fetch user: {resp.text}")
            
            data = resp.json()
            print(f"🔍 Upload-Post User Response: {data}")
            
            user_id = None
            # The structure is {'success': True, 'profiles': [{'username': '...'}, ...]}
            profiles_list = []
            if isinstance(data, dict):
                 raw_profiles = data.get('profiles', [])
                 if isinstance(raw_profiles, list):
                     for p in raw_profiles:
                         username = p.get('username')
                         if username:
                             # Determine connected platforms
                             socials = p.get('social_accounts', {})
                             connected = []
                             # Check typical platforms
                             for platform in ['tiktok', 'instagram', 'youtube']:
                                 account_info = socials.get(platform)
                                 # If it's a dict and typically has data, or just not empty string
                                 if isinstance(account_info, dict):
                                     connected.append(platform)
                             
                             profiles_list.append({
                                 "username": username,
                                 "connected": connected
                             })
            
            if not profiles_list:
                # Fallback if no profiles found
                return {"profiles": [], "error": "No profiles found"}
                
            return {"profiles": profiles_list}
            
            
        except Exception as e:
             raise HTTPException(status_code=500, detail=str(e))

# --- Thumbnail Studio Endpoints ---

@app.post("/api/thumbnail/upload")
async def thumbnail_upload(
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
):
    """Upload video and start background Whisper transcription immediately."""
    if not url and not file:
        raise HTTPException(status_code=400, detail="Must provide URL or File")

    session_id = str(uuid.uuid4())
    transcript_event = asyncio.Event()

    # Save file if uploaded directly
    video_path = None
    if file:
        video_path = os.path.join(UPLOAD_DIR, f"thumb_{session_id}_{file.filename}")
        with open(video_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)

    # Initialize session
    thumbnail_sessions[session_id] = {
        "video_path": video_path,
        "transcript_event": transcript_event,
        "transcript_ready": False,
        "transcript": None,
        "transcript_segments": [],
        "video_duration": 0,
        "language": "en",
        "context": "",
        "titles": [],
        "conversation": [],
        "_url": url,  # Store URL for deferred download
    }

    async def run_background_whisper():
        try:
            vpath = video_path
            # Download YouTube video if URL was provided
            if not vpath and url:
                from main import download_youtube_video
                loop = asyncio.get_event_loop()
                vpath, _ = await loop.run_in_executor(None, download_youtube_video, url, UPLOAD_DIR)
                thumbnail_sessions[session_id]["video_path"] = vpath

            from main import transcribe_video
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_video, vpath)
            segments = transcript.get("segments", [])
            duration = segments[-1]["end"] if segments else 0

            thumbnail_sessions[session_id].update({
                "transcript_ready": True,
                "transcript": transcript,
                "transcript_segments": segments,
                "video_duration": duration,
                "language": transcript.get("language", "en"),
            })
            print(f"✅ [Thumbnail] Background Whisper complete for session {session_id}")
        except Exception as e:
            print(f"❌ [Thumbnail] Background Whisper failed: {e}")
            thumbnail_sessions[session_id]["transcript_error"] = str(e)
        finally:
            transcript_event.set()

    asyncio.create_task(run_background_whisper())

    return {"session_id": session_id}


@app.post("/api/thumbnail/analyze")
async def thumbnail_analyze(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    session_id: Optional[str] = Form(None),
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Analyze a video and suggest viral YouTube titles."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    pre_transcript = None

    # Check for pre-existing session with background Whisper
    if session_id and session_id in thumbnail_sessions:
        session = thumbnail_sessions[session_id]

        # Wait for background Whisper to complete
        transcript_event = session.get("transcript_event")
        if transcript_event:
            print(f"⏳ [Thumbnail] Waiting for background Whisper to finish...")
            await transcript_event.wait()

        if session.get("transcript_error"):
            raise HTTPException(status_code=500, detail=f"Transcription failed: {session['transcript_error']}")

        video_path = session["video_path"]
        if not video_path or not os.path.exists(video_path):
            raise HTTPException(status_code=404, detail="Video file not found in session")

        if session.get("transcript_ready"):
            pre_transcript = session["transcript"]
    else:
        # No pre-existing session — need file or URL
        if not url and not file:
            raise HTTPException(status_code=400, detail="Must provide URL, File, or session_id")

        session_id = str(uuid.uuid4())

        if url:
            from main import download_youtube_video
            video_path, _ = download_youtube_video(url, UPLOAD_DIR)
        else:
            video_path = os.path.join(UPLOAD_DIR, f"thumb_{session_id}_{file.filename}")
            with open(video_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)

    try:
        # Run analysis in thread pool (skips Whisper if pre_transcript is available)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, analyze_video_for_titles, api_key, video_path, pre_transcript)

        # Store/update session context
        if session_id not in thumbnail_sessions:
            thumbnail_sessions[session_id] = {}

        thumbnail_sessions[session_id].update({
            "context": result.get("transcript_summary", ""),
            "titles": result.get("titles", []),
            "language": result.get("language", "en"),
            "conversation": thumbnail_sessions[session_id].get("conversation", []),
            "video_path": video_path,
            "transcript_segments": result.get("segments", []),
            "video_duration": result.get("video_duration", 0)
        })

        return {
            "session_id": session_id,
            "titles": result.get("titles", []),
            "context": result.get("transcript_summary", ""),
            "language": result.get("language", "en"),
            "recommended": result.get("recommended", [])
        }

    except Exception as e:
        print(f"❌ Thumbnail Analyze Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ThumbnailTitlesRequest(BaseModel):
    session_id: Optional[str] = None
    message: Optional[str] = None
    title: Optional[str] = None

@app.post("/api/thumbnail/titles")
async def thumbnail_titles(
    req: ThumbnailTitlesRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Refine title suggestions or accept a manual title."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    # Manual title mode - just create a session with the user's title
    if req.title:
        session_id = req.session_id or str(uuid.uuid4())
        if session_id not in thumbnail_sessions:
            thumbnail_sessions[session_id] = {
                "context": "",
                "titles": [req.title],
                "language": "en",
                "conversation": []
            }
        return {"session_id": session_id, "titles": [req.title]}

    # Refinement mode
    if not req.session_id or req.session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    if not req.message:
        raise HTTPException(status_code=400, detail="Must provide message or title")

    session = thumbnail_sessions[req.session_id]

    # Add user message to conversation history
    session["conversation"].append({"role": "user", "content": req.message})

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            refine_titles,
            api_key,
            session["context"],
            req.message,
            session["conversation"]
        )

        new_titles = result.get("titles", [])
        session["titles"] = new_titles
        session["conversation"].append({"role": "assistant", "content": json.dumps(new_titles)})

        return {"titles": new_titles}

    except Exception as e:
        print(f"❌ Thumbnail Titles Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/thumbnail/generate")
async def thumbnail_generate(
    request: Request,
    session_id: str = Form(...),
    title: str = Form(...),
    extra_prompt: str = Form(""),
    count: int = Form(3),
    face: Optional[UploadFile] = File(None),
    background: Optional[UploadFile] = File(None),
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Generate YouTube thumbnails with Gemini image generation."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    # Clamp count
    count = min(max(1, count), 6)

    # Save optional uploaded images
    face_path = None
    bg_path = None
    thumb_upload_dir = os.path.join(UPLOAD_DIR, f"thumb_{session_id}")
    os.makedirs(thumb_upload_dir, exist_ok=True)

    try:
        if face and face.filename:
            face_path = os.path.join(thumb_upload_dir, f"face_{face.filename}")
            with open(face_path, "wb") as f:
                f.write(await face.read())

        if background and background.filename:
            bg_path = os.path.join(thumb_upload_dir, f"bg_{background.filename}")
            with open(bg_path, "wb") as f:
                f.write(await background.read())

        # Get video context from session (transcript summary from analysis step)
        video_context = ""
        if session_id in thumbnail_sessions:
            video_context = thumbnail_sessions[session_id].get("context", "")

        # Run generation in thread pool
        loop = asyncio.get_event_loop()
        thumbnails = await loop.run_in_executor(
            None,
            generate_thumbnail,
            api_key,
            title,
            session_id,
            face_path,
            bg_path,
            extra_prompt,
            count,
            video_context
        )

        if not thumbnails:
            raise HTTPException(status_code=500, detail="Thumbnail generation failed. Please check your Gemini API key has access to image generation (gemini-3.1-flash-image-preview model).")

        return {"thumbnails": thumbnails}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Thumbnail Generate Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ThumbnailDescribeRequest(BaseModel):
    session_id: str
    title: str

@app.post("/api/thumbnail/describe")
async def thumbnail_describe(
    req: ThumbnailDescribeRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Generate a YouTube description with chapters from the transcript."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    if req.session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = thumbnail_sessions[req.session_id]
    segments = session.get("transcript_segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available. Please analyze a video first.")

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            generate_youtube_description,
            api_key,
            req.title,
            segments,
            session.get("language", "en"),
            session.get("video_duration", 0)
        )
        return {"description": result.get("description", "")}

    except Exception as e:
        print(f"❌ Thumbnail Describe Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/thumbnail/publish")
async def thumbnail_publish(
    background_tasks: BackgroundTasks,
    session_id: str = Form(...),
    title: str = Form(...),
    description: str = Form(...),
    thumbnail_url: str = Form(...),
    api_key: str = Form(...),
    user_id: str = Form(...),
):
    """Kick off a background upload to YouTube via Upload-Post and return immediately."""
    if session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = thumbnail_sessions[session_id]
    video_path = session.get("video_path")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Original video file not found")

    # Resolve thumbnail path from URL
    thumb_relative = thumbnail_url.lstrip("/")
    if thumb_relative.startswith("thumbnails/"):
        thumb_path = os.path.join(OUTPUT_DIR, thumb_relative)
    else:
        thumb_path = os.path.join(THUMBNAILS_DIR, thumb_relative)

    if not os.path.exists(thumb_path):
        raise HTTPException(status_code=404, detail=f"Thumbnail file not found: {thumb_path}")

    # Generate a unique ID for this publish job so the frontend can poll
    publish_id = str(uuid.uuid4())
    publish_jobs[publish_id] = {"status": "uploading", "result": None, "error": None}

    def do_upload():
        """Runs in a thread via BackgroundTasks — does the actual multipart upload."""
        try:
            upload_url = "https://api.upload-post.com/api/upload"
            headers = {"Authorization": f"Apikey {api_key}"}
            data_payload = {
                "user": user_id,
                "platform[]": ["youtube"],
                "title": title,          # required base field (fallback)
                "async_upload": "true",
                "youtube_title": title,
                "youtube_description": description,
                "privacyStatus": "public",
            }
            video_filename = os.path.basename(video_path)
            thumb_filename = os.path.basename(thumb_path)

            print(f"📡 [Thumbnail] Publishing to YouTube via Upload-Post... (publish_id={publish_id})")
            with open(video_path, "rb") as vf, open(thumb_path, "rb") as tf:
                files = {
                    "video": (video_filename, vf.read(), "video/mp4"),
                    "thumbnail": (thumb_filename, tf.read(), "image/jpeg"),
                }

            # Use a long timeout — video uploads can take several minutes
            with httpx.Client(timeout=600.0) as client:
                response = client.post(upload_url, headers=headers, data=data_payload, files=files)

            if response.status_code not in [200, 201, 202]:
                err = f"Upload-Post API Error ({response.status_code}): {response.text}"
                print(f"❌ {err}")
                publish_jobs[publish_id]["status"] = "failed"
                publish_jobs[publish_id]["error"] = err
            else:
                print(f"✅ [Thumbnail] Published successfully (publish_id={publish_id})")
                publish_jobs[publish_id]["status"] = "done"
                publish_jobs[publish_id]["result"] = response.json()

        except Exception as e:
            err = str(e)
            print(f"❌ Thumbnail Publish Background Error: {err}")
            publish_jobs[publish_id]["status"] = "failed"
            publish_jobs[publish_id]["error"] = err

    background_tasks.add_task(do_upload)
    return {"publish_id": publish_id, "status": "uploading"}


@app.get("/api/thumbnail/publish/status/{publish_id}")
async def thumbnail_publish_status(publish_id: str):
    """Poll the status of a background publish job."""
    if publish_id not in publish_jobs:
        raise HTTPException(status_code=404, detail="Publish job not found")
    return publish_jobs[publish_id]


# @app.get("/api/gallery/clips")
# async def get_gallery_clips(limit: int = 20, offset: int = 0, refresh: bool = False):
#     """
#     Fetch clips from S3 for the gallery with pagination.
#
#     Args:
#         limit: Number of clips to return (default 20, max 100)
#         offset: Starting position for pagination
#         refresh: Force refresh cache
#     """
#     try:
#         # Clamp limit to reasonable values
#         limit = min(max(1, limit), 100)
#
#         # Get clips (uses cache internally)
#         all_clips = list_all_clips(limit=limit + offset, force_refresh=refresh)
#
#         # Apply offset for pagination
#         clips = all_clips[offset:offset + limit]
#
#         return {
#             "clips": clips,
#             "total": len(all_clips),
#             "limit": limit,
#             "offset": offset,
#             "has_more": len(all_clips) > offset + limit
#         }
#     except Exception as e:
#         print(f"❌ Gallery Error: {e}")
#         raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# SaaSShorts: AI UGC Video Generator for SaaS Products
# ═══════════════════════════════════════════════════════════════════════

from saasshorts import (
    scrape_website,
    research_saas_online,
    analyze_saas,
    generate_scripts,
    generate_full_video,
    generate_actor_images,
    get_elevenlabs_voices,
    DEFAULT_VOICES,
)

# State for SaaSShorts jobs (separate from video processing jobs)
saas_jobs: Dict[str, Dict] = {}


class SaaSAnalyzeRequest(BaseModel):
    url: Optional[str] = None
    description: Optional[str] = None  # Manual product/business description
    num_scripts: int = 3
    style: str = "ugc"
    language: str = "en"
    actor_gender: str = "female"


@app.post("/api/saasshorts/analyze")
async def saasshorts_analyze(
    req: SaaSAnalyzeRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key"),
):
    """Analyze a URL or manual description and generate video scripts."""
    gemini_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key")

    if not req.url and not req.description:
        raise HTTPException(status_code=400, detail="Provide a URL or a product description")

    try:
        loop = asyncio.get_event_loop()

        def run_analysis():
            web_research = None

            if req.url and req.url.strip():
                # URL provided: full scrape + research pipeline
                scraped = scrape_website(req.url)
                web_research = research_saas_online(req.url, gemini_key)
                analysis = analyze_saas(scraped, gemini_key, web_research=web_research)
            else:
                # Manual description: build analysis from description
                analysis = {
                    "product_name": req.description.split(",")[0].strip()[:60] if req.description else "Product",
                    "description": req.description,
                    "value_proposition": req.description,
                    "target_audience": "general audience",
                    "key_features": [req.description],
                    "pain_points": [],
                    "tone": "casual and authentic",
                }

            scripts = generate_scripts(analysis, gemini_key, req.num_scripts, req.style, req.language, req.actor_gender)
            return {
                "analysis": analysis,
                "scripts": scripts,
                "web_research": web_research,
            }

        result = await loop.run_in_executor(None, run_analysis)
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SaaSActorRequest(BaseModel):
    actor_description: str
    num_options: int = 3
    product_description: Optional[str] = None


@app.post("/api/saasshorts/actor-upload")
async def saasshorts_actor_upload(file: UploadFile = File(...)):
    """Upload a custom actor image (stored locally only, not S3)."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    try:
        content = await file.read()

        # Validate minimum size
        if len(content) < 1000:
            raise HTTPException(status_code=400, detail="File too small to be a valid image")

        upload_id = uuid.uuid4().hex[:8]
        upload_dir = os.path.join(OUTPUT_DIR, "actor_uploads")
        os.makedirs(upload_dir, exist_ok=True)
        filename = f"custom_{upload_id}.png"
        file_path = os.path.join(upload_dir, filename)

        with open(file_path, "wb") as f:
            f.write(content)

        return {"url": f"/videos/actor_uploads/{filename}"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/saasshorts/actor-options")
async def saasshorts_actor_options(
    req: SaaSActorRequest,
    x_fal_key: Optional[str] = Header(None, alias="X-Fal-Key"),
):
    """Generate multiple actor image options for the user to choose from."""
    fal_key = x_fal_key
    if not fal_key:
        raise HTTPException(status_code=400, detail="Missing fal.ai API Key")

    try:
        job_id = str(uuid.uuid4())
        out_dir = os.path.join(OUTPUT_DIR, f"saas_actors_{job_id}")
        os.makedirs(out_dir, exist_ok=True)

        loop = asyncio.get_running_loop()
        import functools
        paths = await loop.run_in_executor(
            None,
            functools.partial(
                generate_actor_images,
                req.actor_description, fal_key, out_dir, "actor", req.num_options,
                product_description=req.product_description,
            ),
        )

        # Upload each actor image to public S3 with description
        desc = req.actor_description
        if req.product_description:
            desc += f" (holding {req.product_description})"
        urls = []
        for p in paths:
            s3_url = upload_actor_to_s3(p, description=desc)
            if s3_url:
                urls.append(s3_url)
            else:
                # Fallback to local URL if S3 fails
                urls.append(f"/videos/saas_actors_{job_id}/{os.path.basename(p)}")

        return {"images": urls}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/saasshorts/gallery")
async def saasshorts_video_gallery(limit: int = 50):
    """List all UGC videos from the public gallery."""
    try:
        loop = asyncio.get_running_loop()
        videos = await loop.run_in_executor(None, list_video_gallery, limit)
        return {"videos": videos, "total": len(videos)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SaaSPostRequest(BaseModel):
    job_id: str
    api_key: str
    user_id: str
    platforms: List[str]
    title: Optional[str] = None
    description: Optional[str] = None
    scheduled_date: Optional[str] = None
    timezone: Optional[str] = "UTC"


@app.post("/api/saasshorts/post")
async def saasshorts_post_to_socials(req: SaaSPostRequest):
    """Post an AI Shorts video to social media via Upload-Post."""
    if req.job_id not in saas_jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = saas_jobs[req.job_id]
    result = job.get("result")
    if not result or not result.get("video_url"):
        raise HTTPException(status_code=400, detail="No video available for this job")

    try:
        # Resolve video file path
        video_url = result["video_url"]  # e.g. /videos/saas_xxx/slug_final.mp4
        rel_path = video_url.replace("/videos/", "")
        file_path = os.path.join(OUTPUT_DIR, rel_path)

        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail=f"Video file not found")

        script = result.get("script", {})
        final_title = req.title or script.get("title", "AI Short")
        final_description = req.description or script.get("caption", "")
        if not final_description:
            final_description = script.get("full_narration", "Check this out!")

        url = "https://api.upload-post.com/api/upload"
        headers = {"Authorization": f"Apikey {req.api_key}"}

        data_payload = {
            "user": req.user_id,
            "title": final_title,
            "platform[]": req.platforms,
            "async_upload": "true",
        }

        if req.scheduled_date:
            data_payload["scheduled_date"] = req.scheduled_date
            if req.timezone:
                data_payload["timezone"] = req.timezone

        if "tiktok" in req.platforms:
            data_payload["tiktok_title"] = final_description
        if "instagram" in req.platforms:
            data_payload["instagram_title"] = final_description
            data_payload["media_type"] = "REELS"
        if "youtube" in req.platforms:
            data_payload["youtube_title"] = final_title
            data_payload["youtube_description"] = final_description
            data_payload["privacyStatus"] = "public"

        filename = os.path.basename(file_path)
        with open(file_path, "rb") as f:
            file_content = f.read()

        files = {"video": (filename, file_content, "video/mp4")}

        with httpx.Client(timeout=120.0) as client:
            print(f"📡 [AI Shorts] Sending to Upload-Post: {req.platforms}")
            response = client.post(url, headers=headers, data=data_payload, files=files)

        if response.status_code not in [200, 201, 202]:
            raise HTTPException(status_code=response.status_code, detail=f"Upload-Post Error: {response.text}")

        return response.json()

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ [AI Shorts] Post Exception: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/gallery", response_class=HTMLResponse)
async def gallery_html_page():
    """SEO gallery page with all generated UGC videos."""
    import html as html_mod
    loop = asyncio.get_running_loop()
    videos = await loop.run_in_executor(None, list_video_gallery, 100)

    cards_html = ""
    ld_items = []
    for i, v in enumerate(videos):
        title = html_mod.escape(v.get("title", "Untitled"))
        video_url = v.get("video_url", "")
        actor_url = v.get("actor_url", "")
        video_id = v.get("video_id", "")
        duration = v.get("duration", 0)
        mode = v.get("video_mode", "")
        product = html_mod.escape(v.get("product_name", ""))
        caption = html_mod.escape(v.get("caption", "")[:120])

        mode_badge = '<span style="background:#22c55e;color:#000;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700">LOW COST</span>' if mode == "lowcost" else '<span style="background:#8b5cf6;color:#fff;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700">PREMIUM</span>'

        cards_html += f'''
        <a href="/video/{video_id}" style="text-decoration:none;color:inherit">
          <div style="background:#18181b;border-radius:16px;overflow:hidden;border:1px solid #27272a;transition:transform 0.2s" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'">
            <div style="position:relative;aspect-ratio:9/16;background:#000">
              <video src="{video_url}" poster="{actor_url}" muted playsinline preload="metadata"
                     onmouseenter="this.play()" onmouseleave="this.pause();this.currentTime=0"
                     style="width:100%;height:100%;object-fit:cover"></video>
              <div style="position:absolute;top:8px;right:8px">{mode_badge}</div>
            </div>
            <div style="padding:12px">
              <h2 style="font-size:14px;font-weight:600;margin:0 0 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{title}</h2>
              <p style="font-size:11px;color:#71717a;margin:0">{duration:.0f}s · {product}</p>
            </div>
          </div>
        </a>'''

        ld_items.append(f'{{"@type":"ListItem","position":{i+1},"url":"https://openshorts.app/video/{video_id}","name":"{title}"}}')

    ld_json = f'{{"@context":"https://schema.org","@type":"CollectionPage","name":"AI UGC Video Gallery","mainEntity":{{"@type":"ItemList","numberOfItems":{len(videos)},"itemListElement":[{",".join(ld_items)}]}}}}'

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI UGC Video Gallery | OpenShorts</title>
<meta name="description" content="Browse {len(videos)} AI-generated UGC marketing videos. Create viral TikTok and Instagram Reels for your SaaS product.">
<meta name="robots" content="index, follow">
<meta property="og:title" content="AI UGC Video Gallery | OpenShorts">
<meta property="og:type" content="website">
<meta property="og:description" content="Browse AI-generated UGC marketing videos for SaaS products.">
<script type="application/ld+json">{ld_json}</script>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#0a0a0c;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,sans-serif}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;padding:20px;max-width:1400px;margin:0 auto}}
nav{{padding:20px 40px;border-bottom:1px solid #27272a;display:flex;align-items:center;justify-content:space-between}}
h1{{font-size:28px;font-weight:700;padding:40px 20px 0;text-align:center}}
.subtitle{{text-align:center;color:#71717a;font-size:14px;padding:8px 20px 20px}}
.cta{{display:inline-block;background:#8b5cf6;color:#fff;padding:10px 24px;border-radius:12px;text-decoration:none;font-weight:600;font-size:14px}}
</style>
</head>
<body>
<nav><strong style="font-size:18px">OpenShorts</strong><a href="/" class="cta">Create Your Video</a></nav>
<h1>AI-Generated UGC Videos</h1>
<p class="subtitle">{len(videos)} videos generated · Low Cost & Premium modes</p>
<div class="grid">{cards_html}</div>
<div style="text-align:center;padding:40px"><a href="/" class="cta">Create Your Own UGC Video</a></div>
</body></html>'''


@app.get("/video/{video_id}", response_class=HTMLResponse)
async def video_html_page(video_id: str):
    """SEO individual video page with og:video meta tags."""
    import html as html_mod
    loop = asyncio.get_running_loop()
    videos = await loop.run_in_executor(None, list_video_gallery, 200)
    meta = next((v for v in videos if v.get("video_id") == video_id), None)
    if not meta:
        raise HTTPException(status_code=404, detail="Video not found")

    title = html_mod.escape(meta.get("title", "Untitled"))
    caption = html_mod.escape(meta.get("caption", ""))
    narration = html_mod.escape(meta.get("full_narration", ""))
    video_url = meta.get("video_url", "")
    actor_url = meta.get("actor_url", "")
    duration = meta.get("duration", 0)
    mode = meta.get("video_mode", "")
    product = html_mod.escape(meta.get("product_name", ""))
    product_url = html_mod.escape(meta.get("product_url", ""))
    language = meta.get("language", "en")
    hashtags = " ".join(meta.get("hashtags", []))
    cost = meta.get("cost_estimate", {}).get("total", 0)
    created = meta.get("created_at", "")
    actor_desc = html_mod.escape(meta.get("actor_description", ""))

    ld_json = f'{{"@context":"https://schema.org","@type":"VideoObject","name":"{title}","description":"{caption}","thumbnailUrl":"{actor_url}","contentUrl":"{video_url}","uploadDate":"{created}","duration":"PT{int(duration)}S","width":1080,"height":1920,"inLanguage":"{language}"}}'

    mode_label = "Low Cost" if mode == "lowcost" else "Premium"

    return f'''<!DOCTYPE html>
<html lang="{language}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} - AI UGC Video | OpenShorts</title>
<meta name="description" content="{caption} {hashtags}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{caption}">
<meta property="og:video" content="{video_url}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1080">
<meta property="og:video:height" content="1920">
<meta property="og:image" content="{actor_url}">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="{title}">
<meta name="twitter:image" content="{actor_url}">
<script type="application/ld+json">{ld_json}</script>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#0a0a0c;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,sans-serif}}
nav{{padding:20px 40px;border-bottom:1px solid #27272a;display:flex;align-items:center;gap:16px}}
nav a{{color:#a1a1aa;text-decoration:none;font-size:14px}}
.container{{max-width:1000px;margin:0 auto;padding:40px 20px;display:grid;grid-template-columns:1fr 1fr;gap:40px}}
@media(max-width:768px){{.container{{grid-template-columns:1fr}}}}
video{{width:100%;border-radius:16px;background:#000}}
h1{{font-size:22px;font-weight:700;margin-bottom:8px}}
.meta{{color:#71717a;font-size:13px;margin-bottom:20px}}
.section{{margin-bottom:20px}}
.section h2{{font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}}
.section p{{font-size:14px;line-height:1.6}}
.badge{{display:inline-block;padding:3px 10px;border-radius:9999px;font-size:11px;font-weight:700}}
.cta{{display:inline-block;background:#8b5cf6;color:#fff;padding:10px 24px;border-radius:12px;text-decoration:none;font-weight:600;font-size:14px;margin-top:20px}}
</style>
</head>
<body>
<nav><strong>OpenShorts</strong><a href="/gallery">Gallery</a><span style="color:#3f3f46">›</span><span style="color:#e4e4e7;font-size:14px">{title}</span></nav>
<div class="container">
<div><video src="{video_url}" poster="{actor_url}" controls autoplay playsinline style="aspect-ratio:9/16;object-fit:cover"></video></div>
<div>
<h1>{title}</h1>
<p class="meta">{duration:.0f}s · {mode_label} · ${cost:.2f} · {product}</p>
<div class="section"><h2>Caption</h2><p>{caption}</p><p style="color:#8b5cf6;margin-top:4px">{hashtags}</p></div>
<div class="section"><h2>Script</h2><p>{narration}</p></div>
<div class="section"><h2>Actor</h2><p>{actor_desc}</p></div>
{f'<div class="section"><h2>Product</h2><p><a href="{product_url}" style="color:#8b5cf6" target="_blank">{product}</a></p></div>' if product_url else ''}
<a href="/gallery">← Back to Gallery</a>
<br><a href="/" class="cta">Create Your Own</a>
</div>
</div>
</body></html>'''


@app.get("/api/saasshorts/actor-gallery")
async def saasshorts_actor_gallery():
    """List all previously generated actor images from public S3."""
    try:
        loop = asyncio.get_running_loop()
        images = await loop.run_in_executor(None, list_actor_gallery)
        return {"images": images}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SaaSGenerateRequest(BaseModel):
    script: dict
    voice_id: Optional[str] = None
    actor_description: Optional[str] = None
    selected_actor_url: Optional[str] = None  # Pre-selected actor image URL
    retry_job_id: Optional[str] = None
    video_mode: str = "lowcost"  # "lowcost" or "premium"


@app.post("/api/saasshorts/generate")
async def saasshorts_generate(
    req: SaaSGenerateRequest,
    x_fal_key: Optional[str] = Header(None, alias="X-Fal-Key"),
    x_elevenlabs_key: Optional[str] = Header(None, alias="X-ElevenLabs-Key"),
):
    """Generate a SaaS UGC video from a script. Returns a job_id for polling."""
    fal_key = x_fal_key
    elevenlabs_key = x_elevenlabs_key

    if not fal_key:
        raise HTTPException(status_code=400, detail="Missing fal.ai API Key (X-Fal-Key header)")
    if not elevenlabs_key:
        raise HTTPException(status_code=400, detail="Missing ElevenLabs API Key (X-ElevenLabs-Key header)")

    # Support retry: reuse output_dir so cached assets (image, voice, head, broll) are kept
    reused = False
    if req.retry_job_id:
        # Check memory first, then disk
        old_dir = os.path.join(OUTPUT_DIR, f"saas_{req.retry_job_id}")
        if req.retry_job_id in saas_jobs:
            old_dir = saas_jobs[req.retry_job_id]["output_dir"]

        if os.path.isdir(old_dir):
            job_id = req.retry_job_id
            job_output_dir = old_dir
            reused = True
            # Clear the 0-byte final video so pipeline re-generates it
            for f in os.listdir(old_dir):
                fp = os.path.join(old_dir, f)
                if f.endswith("_final.mp4") and os.path.getsize(fp) == 0:
                    os.remove(fp)
            saas_jobs[job_id] = {
                "status": "processing",
                "logs": [f"Retrying job {job_id[:8]}... reusing cached assets from disk."],
                "result": None,
                "output_dir": job_output_dir,
            }

    if not reused:
        job_id = str(uuid.uuid4())
        job_output_dir = os.path.join(OUTPUT_DIR, f"saas_{job_id}")
        os.makedirs(job_output_dir, exist_ok=True)
        saas_jobs[job_id] = {
            "status": "processing",
            "logs": ["SaaSShorts job started."],
            "result": None,
            "output_dir": job_output_dir,
        }

    # If user selected a pre-generated actor, resolve it to a local path
    selected_actor_path = None
    if req.selected_actor_url:
        if req.selected_actor_url.startswith("http"):
            # Download from S3 public URL to job output dir
            import httpx
            try:
                actor_local = os.path.join(job_output_dir, "selected_actor.png")
                with httpx.Client(timeout=30.0) as client:
                    resp = client.get(req.selected_actor_url)
                    if resp.status_code == 200:
                        with open(actor_local, "wb") as f:
                            f.write(resp.content)
                        selected_actor_path = actor_local
            except Exception:
                pass
        else:
            src = os.path.join(OUTPUT_DIR, req.selected_actor_url.replace("/videos/", ""))
            if os.path.exists(src):
                selected_actor_path = src

    config = {
        "fal_key": fal_key,
        "elevenlabs_key": elevenlabs_key,
        "voice_id": req.voice_id or "21m00Tcm4TlvDq8ikWAM",
        "actor_description": req.actor_description,
        "selected_actor_path": selected_actor_path,
        "video_mode": req.video_mode,
    }

    async def run_generation():
        await concurrency_semaphore.acquire()
        try:
            loop = asyncio.get_running_loop()

            def log_msg(msg):
                print(f"[SaaSShorts Job {job_id[:8]}] {msg}")
                if job_id in saas_jobs:
                    saas_jobs[job_id]["logs"].append(msg)

            def run():
                return generate_full_video(req.script, config, job_output_dir, log_msg)

            result = await loop.run_in_executor(None, run)

            if job_id in saas_jobs:
                video_filename = result["video_filename"]
                saas_jobs[job_id]["status"] = "completed"
                saas_jobs[job_id]["result"] = {
                    "video_url": f"/videos/saas_{job_id}/{video_filename}",
                    "video_filename": video_filename,
                    "duration": result.get("duration", 0),
                    "cost_estimate": result.get("cost_estimate", {}),
                    "script": req.script,
                }
                saas_jobs[job_id]["logs"].append("Video generation completed!")

                # Upload to public gallery (non-blocking)
                try:
                    gallery_meta = {
                        "title": req.script.get("title", "Untitled"),
                        "hook_text": req.script.get("hook_text", ""),
                        "caption": req.script.get("caption", ""),
                        "hashtags": req.script.get("hashtags", []),
                        "full_narration": req.script.get("full_narration", ""),
                        "actor_description": req.script.get("actor_description", ""),
                        "style": req.script.get("style", "ugc"),
                        "language": req.script.get("language", "en"),
                        "duration": result.get("duration", 0),
                        "video_mode": req.video_mode,
                        "product_name": req.script.get("_product_name", ""),
                        "product_url": req.script.get("_product_url", ""),
                        "segments": req.script.get("segments", []),
                        "cost_estimate": result.get("cost_estimate", {}),
                    }
                    gallery_result = upload_video_to_gallery(
                        video_path=result["video_path"],
                        actor_image_path=result.get("actor_image", ""),
                        metadata=gallery_meta,
                        video_id=job_id[:8],
                    )
                    if gallery_result:
                        saas_jobs[job_id]["result"]["gallery_video_id"] = gallery_result["video_id"]
                        log_msg("📤 Uploaded to public gallery.")
                except Exception as gallery_err:
                    log_msg(f"⚠️ Gallery upload skipped: {gallery_err}")

        except Exception as e:
            print(f"[SaaSShorts] ❌ Job {job_id} failed: {e}")
            if job_id in saas_jobs:
                saas_jobs[job_id]["status"] = "failed"
                saas_jobs[job_id]["logs"].append(f"Error: {str(e)}")
        finally:
            concurrency_semaphore.release()

    asyncio.create_task(run_generation())

    return {"job_id": job_id, "status": "processing"}


@app.get("/api/saasshorts/status/{job_id}")
async def saasshorts_status(job_id: str):
    """Poll SaaSShorts job status."""
    if job_id not in saas_jobs:
        raise HTTPException(status_code=404, detail="SaaSShorts job not found")

    job = saas_jobs[job_id]
    return {
        "status": job["status"],
        "logs": job["logs"],
        "result": job.get("result"),
    }


@app.get("/api/saasshorts/voices")
async def saasshorts_voices(
    x_elevenlabs_key: Optional[str] = Header(None, alias="X-ElevenLabs-Key"),
):
    """List available ElevenLabs voices."""
    if x_elevenlabs_key:
        try:
            loop = asyncio.get_event_loop()
            voices = await loop.run_in_executor(
                None, get_elevenlabs_voices, x_elevenlabs_key
            )
            if voices:
                return {"voices": voices, "source": "elevenlabs"}
        except Exception:
            pass

    # Fallback to default voices
    return {
        "voices": [
            {"voice_id": vid, "name": name, "category": "default"}
            for name, vid in DEFAULT_VOICES.items()
        ],
        "source": "defaults",
    }


# ===========================================================================
# Horizontal → Vertical (H2V) — pro-grade timeline editor backend
# ===========================================================================
#
# Three-stage user flow (mirrors StandaloneSubtitle's wizard pattern):
#
#   Stage 1 — analyze: user uploads or pastes a URL. We download the
#             video, run Whisper, then run h2v_pipeline.detect_topic_segments
#             to get AI-proposed vertical clips. Returns a job_id.
#
#   Stage 2 — editor (frontend only): user drags clips on the timeline,
#             splits / merges / adjusts. Each clip can have a focus mode
#             of "auto" (mediapipe face track), "center" (static), or
#             "manual" (per-clip keyframes).
#
#   Stage 3 — render: user clicks "Render All" → we render each clip
#             concatenating its time_ranges using h2v_pipeline.render_h2v_clip.
#             Results show up on the page + in Past Projects.
#
# Persistence reuses the standalone_jobs registry with kind="h2v" so the
# existing rehydrate / list / source-video plumbing works unchanged.

h2v_jobs: Dict[str, Dict] = {}  # alias: same shape as standalone_jobs entries


class H2VRenderClipReq(BaseModel):
    title: Optional[str] = None
    time_ranges: List[Dict[str, float]]                # [{start, end}, ...]
    focus_mode: Optional[str] = "auto"                 # auto | manual | center
    aspect: Optional[str] = "9:16"
    manual_keyframes: Optional[List[Dict[str, Any]]] = None  # [{t,x,y,cut}, ...]


class H2VRenderRequest(BaseModel):
    clips: List[H2VRenderClipReq]


def _h2v_dir(job_id: str) -> str:
    return os.path.join(OUTPUT_DIR, f"standalone_{job_id}")


def _h2v_status(job_id: str, status: str, msg: str = "", **extra):
    """Tiny wrapper that delegates to _standalone_status so H2V jobs
    show up in /api/standalone/list (kind='h2v') and get persisted
    the same way as subtitle / dub jobs."""
    rec = standalone_jobs.setdefault(job_id, {
        "status": "queued",
        "kind": "h2v",
        "logs": [],
        "output_dir": _h2v_dir(job_id),
    })
    rec["status"] = status
    if msg:
        rec.setdefault("logs", []).append(msg)
    for k, v in extra.items():
        rec[k] = v
    _standalone_persist(job_id)


@app.post("/api/h2v/analyze")
async def h2v_analyze(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    local_path: Optional[str] = Form(None),
    source_language: Optional[str] = Form(""),
    transcribe_provider: Optional[str] = Form("whisper"),
):
    """Stage 1 of the H2V flow. Accepts an uploaded file, a URL, or a
    local-mode filesystem path. Kicks off a background task that
    downloads (if needed), runs Whisper, runs LLM topic detection, and
    saves results to the job record. The frontend polls
    /api/h2v/status/{job_id} until status == 'analyzed' and then opens
    the editor with the proposed clips."""
    has_url = bool(url and url.strip())
    has_local = bool(local_path and local_path.strip())
    if not file and not has_url and not has_local:
        raise HTTPException(400, "Provide a video file, URL, or local path.")
    x_llm_provider = request.headers.get("X-LLM-Provider") or "gemini"
    x_llm_model = request.headers.get("X-LLM-Model") or "gemini-2.5-flash"
    x_llm_key = request.headers.get("X-LLM-Key") or ""
    x_llm_base_url = request.headers.get("X-LLM-Base-URL") or None
    x_eleven_key = request.headers.get("X-ElevenLabs-Key") or ""

    job_id = str(uuid.uuid4())
    job_dir = _h2v_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    if file:
        default_title = (file.filename or "Uploaded video")[:120]
    elif has_url:
        default_title = url.strip()[:120]
    else:
        # Local-mode: use the file's basename, not the full path (which
        # may contain the user's username).
        default_title = (os.path.basename(local_path or "").strip() or "Local video")[:120]

    standalone_jobs[job_id] = {
        "status": "queued",
        "kind": "h2v",
        "logs": ["H2V queued."],
        "output_dir": job_dir,
        "result": None,
        "transcript": None,
        "topics": None,
        "input_path": None,
        "progress": 0,                  # 0–100 across the full pipeline
        "stage": "queued",              # queued | downloading | transcribing | analyzing | done | failed
        "created_at": time.time(),
        "title": default_title,
    }

    # Synchronous source resolution so a bad URL or path surfaces immediately.
    if file:
        input_path = _standalone_save_upload(file, job_id)
    elif has_local:
        try:
            input_path = _resolve_local_media_path(local_path.strip())
        except HTTPException:
            standalone_jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        except Exception as e:
            standalone_jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(400, f"Could not resolve local file: {e}")
    else:
        try:
            from main import download_url_video
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            _h2v_status(job_id, "downloading", "Downloading video from URL…",
                        progress=5, stage="downloading")
            input_path, fetched_title = await asyncio.get_event_loop().run_in_executor(
                None, lambda: download_url_video(url.strip(), UPLOAD_DIR),
            )
            if fetched_title:
                standalone_jobs[job_id]["title"] = fetched_title
        except Exception as e:
            standalone_jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(400, str(e))

    standalone_jobs[job_id]["input_path"] = input_path
    _standalone_persist(job_id)

    async def run():
        try:
            _h2v_status(job_id, "transcribing", "Stage 1: transcribing audio with Whisper…",
                        progress=15, stage="transcribing")
            os.environ["OPENSHORTS_TRANSCRIBE_PROVIDER"] = transcribe_provider or "whisper"
            os.environ["OPENSHORTS_TRANSCRIPT_LANG"] = source_language or ""
            if x_eleven_key:
                os.environ["OPENSHORTS_ELEVENLABS_KEY"] = x_eleven_key
            from main import transcribe_video
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_video, input_path)
            if not transcript or not transcript.get("segments"):
                raise RuntimeError("No segments returned from transcription.")
            standalone_jobs[job_id]["transcript"] = transcript
            _standalone_save_blob(job_id, "h2v_transcript", transcript)
            seg_count = len(transcript.get("segments") or [])
            _h2v_status(
                job_id, "transcribing",
                f"Transcript ready — {seg_count} segments.",
                progress=60, stage="transcribed",
            )

            _h2v_status(job_id, "analyzing",
                        "Stage 2: AI is finding topic boundaries + merging related sections…",
                        progress=70, stage="analyzing")
            from h2v_pipeline import detect_topic_segments
            topics = await loop.run_in_executor(
                None,
                lambda: detect_topic_segments(
                    transcript.get("segments") or [],
                    llm_provider=x_llm_provider,
                    llm_model=x_llm_model,
                    llm_key=x_llm_key,
                    llm_base_url=x_llm_base_url,
                ),
            )
            standalone_jobs[job_id]["topics"] = topics
            _standalone_save_blob(job_id, "h2v_topics", topics)
            _h2v_status(job_id, "analyzing",
                        f"AI proposed {len(topics)} vertical clip(s). Probing video…",
                        progress=88, stage="probing")

            # Probe video dimensions so the frontend timeline knows what
            # aspect ratio the preview should be.
            try:
                from reframe_kf import _probe_dimensions as _probe_dims
                src_w, src_h = _probe_dims(input_path)
            except Exception:
                src_w, src_h = 1920, 1080
            standalone_jobs[job_id]["source_dims"] = {"w": src_w, "h": src_h}

            # Total duration (fall back to last segment end if probe fails).
            try:
                from subtitles import probe_media as _pm
                duration = float(_pm(input_path).get("duration_s") or 0)
            except Exception:
                duration = 0.0
            if duration <= 0 and transcript.get("segments"):
                duration = max(float(s.get("end") or 0) for s in transcript["segments"])
            standalone_jobs[job_id]["duration"] = duration

            _h2v_status(
                job_id, "analyzed",
                f"Found {len(topics)} topic(s). Ready for editor.",
                progress=100, stage="done",
                result={"topics": topics, "duration": duration,
                        "source_dims": {"w": src_w, "h": src_h}},
            )
        except Exception as e:
            err = f"H2V analyze failed: {e}"
            print(f"❌ {err}")
            _h2v_status(job_id, "failed", err, stage="failed")

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/h2v/status/{job_id}")
async def h2v_status(job_id: str):
    rec = standalone_jobs.get(job_id)
    if not rec:
        # Try rehydrate from disk.
        if not _rehydrate_one_standalone(job_id):
            raise HTTPException(404, "H2V job not found.")
        rec = standalone_jobs.get(job_id)
        if not rec:
            raise HTTPException(404, "H2V job not found.")
    return {
        "job_id": job_id,
        "status": rec.get("status"),
        "logs": rec.get("logs", [])[-50:],
        "title": rec.get("title"),
        "topics": rec.get("topics"),
        "transcript": (rec.get("transcript") or {}),
        "source_dims": rec.get("source_dims"),
        "duration": rec.get("duration"),
        "result": rec.get("result"),
        "progress": rec.get("progress", 0),
        "stage": rec.get("stage", rec.get("status") or "queued"),
    }


@app.post("/api/h2v/{job_id}/render")
async def h2v_render(job_id: str, req: H2VRenderRequest):
    """Render the user-edited list of clips. Each clip can span multiple
    time ranges (intelligent merge) and has its own focus mode + optional
    manual keyframes.

    Synchronous: rendering N clips at 1080×1920 takes a few seconds per
    clip in our experience, and the frontend already has a spinner.
    """
    rec = standalone_jobs.get(job_id)
    if not rec:
        if not _rehydrate_one_standalone(job_id):
            raise HTTPException(404, "H2V job not found.")
        rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "H2V job not found.")

    source_path = rec.get("input_path") or _find_standalone_source_video(job_id)
    if not source_path or not os.path.isfile(source_path):
        raise HTTPException(410, "Source video missing.")

    job_dir = _h2v_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    outputs = []
    from h2v_pipeline import render_h2v_clip
    _h2v_status(job_id, "rendering", f"Rendering {len(req.clips)} clip(s)…")
    try:
        for i, clip in enumerate(req.clips):
            base = _safe_filename(f"clip_{i+1:02d}_{(clip.title or '').strip()[:50] or 'untitled'}.mp4")
            out_path = os.path.join(job_dir, base)
            _h2v_status(job_id, "rendering", f"Rendering clip {i+1}/{len(req.clips)}: {clip.title or base}…")
            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda c=clip, o=out_path: render_h2v_clip(
                    source_path,
                    time_ranges=[{"start": float(r["start"]), "end": float(r["end"])}
                                 for r in c.time_ranges],
                    output_path=o,
                    aspect=c.aspect or "9:16",
                    focus_mode=c.focus_mode or "auto",
                    manual_keyframes=c.manual_keyframes or None,
                ),
            )
            video_url = f"/videos/standalone_{job_id}/{base}?v={int(time.time()*1000)}"
            outputs.append({
                "index": i,
                "title": clip.title or base,
                "video_url": video_url,
                "time_ranges": [dict(r) for r in clip.time_ranges],
                "focus_mode": clip.focus_mode or "auto",
                "aspect": clip.aspect or "9:16",
            })
    except Exception as e:
        err = f"H2V render failed: {e}"
        print(f"❌ {err}")
        _h2v_status(job_id, "failed", err)
        raise HTTPException(500, err)

    result = {"clips": outputs}
    _h2v_status(job_id, "completed", f"Rendered {len(outputs)} clip(s) ✅",
                result=result)
    _standalone_save_blob(job_id, "h2v_rendered_clips", outputs)
    return {"status": "completed", "clips": outputs}


@app.get("/api/h2v/{job_id}/preview-frame")
async def h2v_preview_frame(job_id: str, t: float = 0.0):
    """Extract a single JPEG frame from the source at time `t` seconds.
    Used by the timeline editor's filmstrip thumbnails.

    Cached on disk so repeated requests for the same time don't re-run
    ffmpeg. We allow only an explicit set of times by snapping to the
    nearest 0.5 s grid (prevents an attacker — or a runaway scrubber —
    from filling the disk with one file per millisecond)."""
    rec = standalone_jobs.get(job_id)
    if not rec:
        _rehydrate_one_standalone(job_id)
        rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "H2V job not found.")
    source_path = rec.get("input_path") or _find_standalone_source_video(job_id)
    if not source_path or not os.path.isfile(source_path):
        raise HTTPException(410, "Source video missing.")

    t_snap = max(0.0, round(float(t) * 2) / 2)  # 0.5 s grid
    thumb_dir = os.path.join(_h2v_dir(job_id), "_thumbs")
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_path = os.path.join(thumb_dir, f"f_{int(t_snap*1000):08d}.jpg")
    if not os.path.isfile(thumb_path):
        cmd = [
            "ffmpeg", "-y", "-ss", f"{t_snap:.3f}", "-i", source_path,
            "-frames:v", "1", "-vf", "scale=240:-2",
            "-q:v", "5", thumb_path,
        ]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0 or not os.path.isfile(thumb_path):
            raise HTTPException(500, "Frame extract failed")
    from fastapi.responses import FileResponse
    return FileResponse(thumb_path, media_type="image/jpeg")


@app.get("/api/h2v/{job_id}/waveform")
async def h2v_waveform(job_id: str, bins: int = 400):
    """Return a coarse audio amplitude array for the source video so
    the timeline can render a real waveform. Cached after first call."""
    rec = standalone_jobs.get(job_id)
    if not rec:
        _rehydrate_one_standalone(job_id)
        rec = standalone_jobs.get(job_id)
    if not rec:
        raise HTTPException(404, "H2V job not found.")
    source_path = rec.get("input_path") or _find_standalone_source_video(job_id)
    if not source_path or not os.path.isfile(source_path):
        raise HTTPException(410, "Source video missing.")

    bins = max(50, min(2000, int(bins)))
    cache_path = os.path.join(_h2v_dir(job_id), f"_waveform_{bins}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path) as f:
                return json.load(f)
        except Exception:
            pass

    # Use ffmpeg's astats filter via a Python subprocess. Simpler approach:
    # dump audio to s16le mono at low rate, then bucket in Python.
    try:
        # Sample at 8 kHz mono — plenty for an amplitude envelope.
        proc = subprocess.run(
            ["ffmpeg", "-i", source_path, "-ac", "1", "-ar", "8000",
             "-f", "s16le", "-loglevel", "error", "-"],
            capture_output=True, timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace")[:200])
        import struct
        raw = proc.stdout
        n_samples = len(raw) // 2
        if n_samples <= 0:
            data = [0.0] * bins
        else:
            samples_per_bin = max(1, n_samples // bins)
            data = []
            i = 0
            for _ in range(bins):
                end = min(n_samples, i + samples_per_bin)
                if i >= end:
                    data.append(0.0)
                    continue
                # Compute peak amplitude in this bin (normalized 0..1).
                chunk = raw[i*2:end*2]
                if not chunk:
                    data.append(0.0)
                else:
                    vals = struct.unpack(f"<{len(chunk)//2}h", chunk)
                    peak = max(abs(v) for v in vals) / 32768.0
                    data.append(round(peak, 4))
                i = end
        payload = {"bins": bins, "data": data}
        try:
            with open(cache_path, "w") as f:
                json.dump(payload, f)
        except Exception:
            pass
        return payload
    except Exception as e:
        # Non-fatal — return zeros, the frontend renders an empty track.
        return {"bins": bins, "data": [0.0] * bins, "error": str(e)}
