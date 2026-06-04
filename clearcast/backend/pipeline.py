"""Audio enhancement pipeline.

Stages (each optional / auto-selected by what's installed):

  decode  -> ffmpeg: any audio/video -> 48 kHz mono wav
  music   -> Demucs htdemucs: isolate the vocal stem (removes background music)
  denoise -> studio: ClearVoice MossFormer2_SE_48K  (AI denoise + restore)
             fast:   DeepFilterNet `deep-filter` binary (AI denoise, real-time)
             basic:  ffmpeg afftdn/anlmdn (DSP fallback, always available)
  blend   -> mix enhanced with original by `strength` (Adobe-style strength slider)
  master  -> ffmpeg: highpass / de-ess / presence EQ / compressor / loudnorm
  export  -> wav or mp3

The API server stays light: every ML model runs in its own subprocess.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PY = ROOT / ".venv" / "bin" / "python"
DEEPFILTER_BIN = ROOT / "bin" / "deep-filter"
ENGINES_DIR = Path(__file__).resolve().parent / "engines"
DEEPFILTER_PY = ENGINES_DIR / "run_deepfilter.py"
DEREVERB_PY = ENGINES_DIR / "run_dereverb.py"

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _run(cmd: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    """Run a command, raising a readable error on failure."""
    proc = subprocess.run(
        [str(c) for c in cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-12:]
        raise RuntimeError(
            f"command failed ({proc.returncode}): {' '.join(str(c) for c in cmd[:3])}…\n"
            + "\n".join(tail)
        )
    return proc


def _has_module(name: str) -> bool:
    importlib.invalidate_caches()
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def detect_engines() -> dict:
    """What's installed right now (re-checked live so health reflects installs)."""
    df = _has_module("df")  # DeepFilterNet python package
    return {
        "basic": True,
        "fast": df,
        "deepfilter": df,
        "studio": _has_module("clearvoice"),
        "music": _has_module("demucs"),
        "dereverb": _has_module("nara_wpe"),
        "auto": True,  # auto-diagnose mode (uses whatever engines are present)
    }


def ffprobe_duration(path: Path) -> float:
    try:
        proc = _run([
            "ffprobe", "-v", "quiet", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ])
        return float(proc.stdout.strip())
    except Exception:
        return 0.0


def _loudness(path: Path) -> float | None:
    """Integrated loudness (LUFS) measured via ffmpeg ebur128, or None."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-i", str(path), "-af", "ebur128=framelog=quiet",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        )
        marker = "I:"
        val = None
        for line in proc.stderr.splitlines():
            s = line.strip()
            if s.startswith(marker) and "LUFS" in s:
                val = float(s.split()[1])
        return val
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# stages
# --------------------------------------------------------------------------- #
def _decode(src: Path, work: Path) -> Path:
    out = work / "src48.wav"
    _run(["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "48000",
          "-c:a", "pcm_s16le", str(out)])
    return out


def _demucs(in_wav: Path, work: Path) -> Path:
    # Output MP3 (320k via lameenc) instead of WAV: torchaudio 2.11's WAV writer
    # routes through torchcodec (not installed / incompatible with FFmpeg 8),
    # whereas Demucs' MP3 path uses lameenc directly. We re-decode to WAV next.
    out_dir = work / "demucs"
    _run([VENV_PY, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
          "--mp3", "--mp3-bitrate", "320", "-d", "cpu",
          "-o", str(out_dir), str(in_wav)], timeout=3600)
    voc = next(out_dir.glob("htdemucs/*/vocals.mp3"))
    dst = work / "vocals48.wav"
    _run(["ffmpeg", "-y", "-i", str(voc), "-ac", "1", "-ar", "48000", str(dst)])
    return dst


def _clearvoice(in_wav: Path, work: Path) -> Path:
    out = work / "studio.wav"
    _run([VENV_PY, str(ENGINES_DIR / "run_clearvoice.py"), str(in_wav), str(out)],
         timeout=3600)
    # normalise back to 48k mono
    norm = work / "studio48.wav"
    _run(["ffmpeg", "-y", "-i", str(out), "-ac", "1", "-ar", "48000", str(norm)])
    return norm


def _deepfilter_py(in_wav: Path, work: Path, tag: str = "df") -> Path:
    """DeepFilterNet via the python package (run_deepfilter.py). Crushes the
    residual broadband noise floor that the restorer leaves behind."""
    out = work / f"{tag}_raw.wav"
    _run([VENV_PY, str(DEEPFILTER_PY), str(in_wav), str(out)], timeout=1800)
    norm = work / f"{tag}48.wav"
    _run(["ffmpeg", "-y", "-i", str(out), "-ac", "1", "-ar", "48000", str(norm)])
    return norm


def _dereverb(in_wav: Path, work: Path) -> Path:
    """WPE dereverberation — removes the 'speaking in a hall' tail. Best run
    BEFORE the denoiser (on the still-reverberant signal)."""
    out = work / "dereverb.wav"
    _run([VENV_PY, str(DEREVERB_PY), str(in_wav), str(out)], timeout=1800)
    return out


def _declip(in_wav: Path, work: Path) -> Path:
    out = work / "declip.wav"
    _run(["ffmpeg", "-y", "-i", str(in_wav), "-af", "adeclip", "-ar", "48000", str(out)])
    return out


def _dehum(in_wav: Path, work: Path, freq: int) -> Path:
    out = work / "dehum.wav"
    notches = ",".join(f"bandreject=f={freq*h}:width_type=q:w=30" for h in (1, 2, 3))
    _run(["ffmpeg", "-y", "-i", str(in_wav), "-af", notches, "-ar", "48000", str(out)])
    return out


def _ffmpeg_denoise(in_wav: Path, work: Path) -> Path:
    out = work / "dsp48.wav"
    _run(["ffmpeg", "-y", "-i", str(in_wav),
          "-af", "highpass=f=70,afftdn=nr=24:nf=-30,anlmdn=s=0.0008:p=0.002",
          "-ar", "48000", str(out)])
    return out


def _blend(enhanced: Path, original: Path, work: Path, strength: float) -> Path:
    strength = max(0.0, min(1.0, strength))
    if strength >= 0.999:
        return enhanced
    out = work / "blended.wav"
    fc = (f"[0:a]volume={strength}[a];"
          f"[1:a]volume={1 - strength}[b];"
          f"[a][b]amix=inputs=2:normalize=0:duration=shortest")
    _run(["ffmpeg", "-y", "-i", str(enhanced), "-i", str(original),
          "-filter_complex", fc, "-ar", "48000", "-ac", "1", str(out)])
    return out


def _master(in_wav: Path, work: Path, target_lufs: float, warmth: float,
            deess: float = 0.3) -> Path:
    out = work / "mastered.wav"
    warmth = max(0.0, min(1.0, warmth))
    di = round(0.3 + 0.5 * max(0.0, min(1.0, deess)), 2)  # de-ess intensity
    # crisp + dry: cut boxy low-mids (room/hall buildup), add presence; the
    # 'air' high-shelf is crisp by default and dialled toward warm as warmth↑.
    air = round(2.5 - 4.0 * warmth, 2)  # warmth 0 -> +2.5 (crisp), 1 -> -1.5 (warm)
    chain = (
        "highpass=f=90,"
        f"deesser=i={di}:m=0.5:f=0.5:s=o,"
        "equalizer=f=350:t=q:w=1.2:g=-3,"      # de-box: reduce room/hall low-mids
        "equalizer=f=550:t=q:w=1.5:g=-1.5,"
        "equalizer=f=3500:t=q:w=1.6:g=3.5,"    # presence / clarity / crispness
        f"highshelf=g={air}:f=10000,"          # air — crisp; warmth dials it down
        "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=160:makeup=2,"
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11"
    )
    _run(["ffmpeg", "-y", "-i", str(in_wav), "-af", chain,
          "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", str(out)])  # 24-bit master
    return out


def _export(in_wav: Path, work: Path, fmt: str) -> Path:
    if fmt == "mp3":
        out = work / "enhanced.mp3"
        _run(["ffmpeg", "-y", "-i", str(in_wav), "-b:a", "192k", str(out)])
        return out
    out = work / "enhanced.wav"
    shutil.copy(in_wav, out)
    return out


def _remux_video(video_in: Path, audio_in: Path, work: Path) -> Path:
    """Replace the audio track of the original video with the enhanced audio."""
    out = work / "enhanced_video.mp4"
    try:  # fast path: copy the video stream untouched, just swap audio
        _run(["ffmpeg", "-y", "-i", str(video_in), "-i", str(audio_in),
              "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
              "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
              "-shortest", str(out)])
    except RuntimeError:  # fallback: re-encode video (non-mp4-copyable codecs)
        _run(["ffmpeg", "-y", "-i", str(video_in), "-i", str(audio_in),
              "-map", "0:v:0", "-map", "1:a:0",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
              "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
              "-movflags", "+faststart", "-shortest", str(out)])
    return out


# --------------------------------------------------------------------------- #
# orchestration
# --------------------------------------------------------------------------- #
def enhance(in_path: Path, work: Path, opts: dict, cb) -> tuple[Path, dict]:
    """Run the pipeline. `cb(stage, progress, message)` reports progress 0..1."""
    work = Path(work)
    engines = detect_engines()
    engine = opts.get("engine", "auto")
    remove_music = bool(opts.get("remove_music", False))
    strength = float(opts.get("strength", 1.0))
    target_lufs = float(opts.get("target_lufs", -16.0))
    warmth = float(opts.get("warmth", 0.6))
    out_fmt = opts.get("output_format", "wav")
    force_dereverb = bool(opts.get("dereverb", False))

    meta: dict = {"engine_used": engine, "stages": []}

    cb("decode", 0.05, "Reading audio…")
    src = _decode(in_path, work)
    meta["duration"] = round(ffprobe_duration(src), 2)
    current = src

    # ---- analyze: find out what's actually wrong with this recording ----
    cb("analyze", 0.10, "Analyzing the recording…")
    try:
        import analyze as _an
        diag = _an.analyze(str(src))
    except Exception:  # noqa: BLE001
        diag = {"metrics": {}, "issues": [], "fixes": [], "deess": 0.3, "hum_freq": None}
    meta["diagnosis"] = diag
    auto = engine == "auto"
    fixes = set(diag.get("fixes", [])) if auto else set()
    applied: list[str] = []

    # ---- targeted, conditional repairs ----
    if auto and "declip" in fixes:
        cb("declip", 0.16, "Repairing clipped audio…")
        current = _declip(current, work); applied.append("De-clip"); meta["stages"].append("declip")

    if auto and "dehum" in fixes and diag.get("hum_freq"):
        hz = int(diag["hum_freq"])
        cb("dehum", 0.20, f"Removing {hz} Hz hum…")
        current = _dehum(current, work, hz); applied.append(f"{hz} Hz hum"); meta["stages"].append("dehum")

    if remove_music and engines["music"]:
        cb("music", 0.26, "Separating voice from background music…")
        current = _demucs(current, work); applied.append("Music removal"); meta["stages"].append("music-removal")

    # de-reverb works best BEFORE the denoiser (on the still-reverberant signal)
    want_dereverb = engines.get("dereverb") and (("dereverb" in fixes) or (not auto and force_dereverb))
    if want_dereverb:
        cb("dereverb", 0.34, "Removing room echo / reverb…")
        current = _dereverb(current, work); applied.append("De-reverb"); meta["stages"].append("dereverb")

    # denoise engine downgrade
    eng = engine
    if eng in ("auto", "studio") and not engines["studio"]:
        eng = "fast" if engines["fast"] else "basic"
    if eng == "fast" and not engines["fast"]:
        eng = "basic"

    def _studio(sig):
        cb("denoise", 0.42, "Removing noise & restoring voice — Studio AI…")
        out = _clearvoice(sig, work) if engines["studio"] else sig
        meta["stages"].append("denoise:studio")
        if engines.get("deepfilter"):
            cb("polish", 0.64, "Polishing — removing residual noise…")
            out = _deepfilter_py(out, work); meta["stages"].append("polish:deepfilter")
        return out

    if auto:
        if "denoise" in fixes:
            enhanced = _studio(current); applied.append("Denoise + restore voice")
            # heavy reverb: a 2nd restore pass on the dereverbed+denoised signal
            # closes the gap to studio dryness (verified vs Adobe).
            if "dereverb" in fixes and engines["studio"]:
                cb("restore2", 0.70, "Final voice restoration (de-reverb)…")
                enhanced = _clearvoice(enhanced, work)
                meta["stages"].append("restore2:studio")
                applied.append("Extra de-reverb / restoration pass")
        elif applied and engines.get("deepfilter"):
            cb("polish", 0.5, "Polishing…")
            enhanced = _deepfilter_py(current, work); meta["stages"].append("polish:deepfilter")
        else:
            enhanced = current  # nothing wrong worth processing
        if not applied:
            applied.append("Clean already — light master only")
    elif eng == "studio":
        enhanced = _studio(current)
    elif eng == "fast":
        cb("denoise", 0.42, "Removing noise — Fast AI…")
        enhanced = _deepfilter_py(current, work) if engines.get("deepfilter") else _ffmpeg_denoise(current, work)
        meta["stages"].append("denoise:fast")
    else:
        cb("denoise", 0.42, "Removing noise — DSP…")
        enhanced = _ffmpeg_denoise(current, work); meta["stages"].append("denoise:basic")

    meta["engine_used"] = "auto" if auto else eng
    meta["diagnosis"]["applied"] = applied

    cb("blend", 0.74, "Applying enhancement strength…")
    blended = _blend(enhanced, src, work, strength)

    cb("master", 0.80, "Mastering podcast voice…")
    mastered = _master(blended, work, target_lufs, warmth, diag.get("deess", 0.3))
    meta["stages"].append("master")

    cb("encode", 0.90, "Exporting…")
    out = _export(mastered, work, out_fmt)
    meta["stages"].append(f"export:{out_fmt}")

    video_out = None
    is_video = in_path.suffix.lower() in VIDEO_SUFFIXES
    meta["is_video"] = is_video
    if is_video and opts.get("make_video", True):
        cb("video", 0.95, "Rebuilding video with enhanced audio…")
        try:
            video_out = _remux_video(in_path, out, work)
            meta["stages"].append("video-remux")
            meta["video"] = True
        except Exception:
            video_out = None

    # before/after loudness (best-effort, for the UI stat strip)
    try:
        meta["lufs_in"] = _loudness(src)
        meta["lufs_out"] = _loudness(out)
    except Exception:
        pass

    cb("done", 1.0, "Done")
    return out, video_out, meta


if __name__ == "__main__":  # tiny CLI for manual testing
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("outdir")
    ap.add_argument("--engine", default="studio")
    ap.add_argument("--remove-music", action="store_true")
    ap.add_argument("--strength", type=float, default=1.0)
    a = ap.parse_args()
    d = Path(a.outdir)
    d.mkdir(parents=True, exist_ok=True)
    out, vout, m = enhance(
        Path(a.input), d,
        {"engine": a.engine, "remove_music": a.remove_music, "strength": a.strength},
        lambda s, p, msg: print(f"[{p:4.0%}] {s}: {msg}"),
    )
    print("OUTPUT:", out)
    if vout:
        print("VIDEO :", vout)
    print(json.dumps(m, indent=2))
