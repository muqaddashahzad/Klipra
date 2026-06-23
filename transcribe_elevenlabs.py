"""ElevenLabs Scribe transcription — pro-tier paid alternative to Whisper.

Stage 1 of Klipra's pipeline accepts two engines:
  - Whisper Turbo (default, free, runs locally on the user's machine)
  - ElevenLabs Scribe (paid, ~$0.40/hr, runs in the cloud, higher
    accuracy — especially on noisy / mixed-language / accented audio)

We prefer Whisper for the default flow because it's free and stays on the
user's machine. Users who care about transcript quality enough to pay
can flip a toggle in Settings (already ships their ElevenLabs key today
for dubbing) and Stage 1 transparently swaps in Scribe.

The output shape matches `transcribe_video()` in main.py exactly so the
downstream cleanup → clip-pick pipeline doesn't care which engine ran:
    {
        "text":     "<full transcript>",
        "language": "<ISO code>",
        "segments": [
            {
                "text":  "...",
                "start": <sec>,
                "end":   <sec>,
                "words": [
                    {"word": "Hello", "start": 0.0, "end": 0.5,
                     "probability": 0.97},
                    ...
                ],
            },
            ...
        ],
    }
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Optional

import httpx


SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL_ID = "scribe_v1"


def _extract_audio(video_path: str) -> str:
    """Strip the audio out of the video → mp3 file in a temp location.

    Why bother instead of uploading the raw video?
      - ElevenLabs accepts video, but Scribe only needs audio so a
        45-min talking-head video uploaded raw eats minutes of upload
        time. mp3 at 64 kbps is tiny and uploads in seconds.
      - Avoids the 1 GB API limit for big source videos.
    """
    out_fd, out_path = tempfile.mkstemp(suffix=".mp3", prefix="klipra_scribe_")
    os.close(out_fd)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", video_path,
        "-vn",                    # drop video
        "-ac", "1",               # mono — Scribe doesn't need stereo
        "-ar", "16000",           # 16 kHz is plenty for ASR
        "-c:a", "libmp3lame", "-b:a", "64k",
        out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out_path


def transcribe_with_elevenlabs(
    video_path: str,
    *,
    api_key: str,
    language_code: Optional[str] = None,
    timeout_sec: float = 600.0,
) -> dict:
    """Transcribe a video via ElevenLabs Scribe and return Whisper-shape data.

    Raises RuntimeError on API failure so the caller can fall back to
    local Whisper if the user wanted Scribe but their key is dead /
    quota is hit.
    """
    if not api_key:
        raise RuntimeError("ElevenLabs API key required for Scribe transcription.")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    audio_path = _extract_audio(video_path)
    try:
        # Scribe takes multipart/form-data with the audio file plus
        # text fields. Setting `timestamps_granularity=word` is what
        # gives us the per-word timings we need for word-aligned
        # subtitle burn-in later.
        data = {
            "model_id": SCRIBE_MODEL_ID,
            "timestamps_granularity": "word",
            # Diarization off — we only need the words, not who said them.
            "diarize": "false",
        }
        if language_code:
            data["language_code"] = language_code
        headers = {"xi-api-key": api_key}

        print(f"🎙️  ElevenLabs Scribe: uploading {os.path.getsize(audio_path)/1024:.1f} KB audio…")
        # `with open(...)` so the handle closes before the finally block
        # os.removes it (body is fully read by the time post() returns) —
        # fixes an fd leak / Windows unlink failure.
        with httpx.Client(timeout=timeout_sec) as client, open(audio_path, "rb") as _audio_fh:
            files = {"file": ("audio.mp3", _audio_fh, "audio/mpeg")}
            resp = client.post(SCRIBE_ENDPOINT, headers=headers, files=files, data=data)

        if resp.status_code == 401:
            raise RuntimeError("ElevenLabs API key was rejected (401). Check the key in Settings.")
        if resp.status_code == 429:
            raise RuntimeError("ElevenLabs quota exceeded (429). Add credits or fall back to Whisper.")
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ElevenLabs Scribe failed (HTTP {resp.status_code}): "
                f"{resp.text[:300]}"
            )
        body = resp.json()
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass

    # ---- shape conversion: Scribe → Whisper-compatible ----
    full_text = (body.get("text") or "").strip()
    detected_lang = body.get("language_code") or language_code or ""
    raw_words = body.get("words") or []

    # Scribe returns a flat word list. Group into ~10-word segments at
    # natural pauses (gap > 0.6 s) so downstream code that iterates on
    # `segments` keeps working unchanged.
    segments: list = []
    current_words: list = []
    current_start = 0.0
    last_end = 0.0
    for entry in raw_words:
        wtext = (entry.get("word") or entry.get("text") or "").strip()
        if not wtext:
            continue
        # Scribe sometimes returns 'spacing' entries — skip those, keep words.
        if entry.get("type") and entry["type"] != "word":
            continue
        try:
            ws = float(entry.get("start") or 0.0)
            we = float(entry.get("end") or ws + 0.05)
        except (TypeError, ValueError):
            continue

        # Open a new segment if there's a >600 ms silence or we already have ~10 words.
        gap_too_big = current_words and (ws - last_end) > 0.6
        too_many_words = len(current_words) >= 10
        if gap_too_big or too_many_words:
            segments.append({
                "text": " ".join(w["word"] for w in current_words),
                "start": current_words[0]["start"],
                "end": current_words[-1]["end"],
                "words": [
                    {"word": w["word"], "start": w["start"], "end": w["end"], "probability": 1.0}
                    for w in current_words
                ],
            })
            current_words = []

        if not current_words:
            current_start = ws
        current_words.append({"word": wtext, "start": ws, "end": we})
        last_end = we

    # Flush trailing.
    if current_words:
        segments.append({
            "text": " ".join(w["word"] for w in current_words),
            "start": current_words[0]["start"],
            "end": current_words[-1]["end"],
            "words": [
                {"word": w["word"], "start": w["start"], "end": w["end"], "probability": 1.0}
                for w in current_words
            ],
        })

    print(
        f"✅ ElevenLabs Scribe done — {len(raw_words)} words, "
        f"{len(segments)} segments, language={detected_lang or '?'}"
    )
    return {
        "text": full_text,
        "language": detected_lang,
        "segments": segments,
    }
