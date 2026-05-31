"""Free dubbing pipeline using Microsoft Edge TTS + LLM translation.

Pipeline:
  1. Read the clip's original transcript (saved in metadata.json during
     the main job).
  2. Ask the configured LLM to translate it to the target language —
     reuses the multi-provider abstraction in llm/.
  3. Synthesize the translated text with Edge TTS (neural voices, free,
     no API key).
  4. Mux the new audio onto the original video, replacing the audio
     track with FFmpeg.

This gives users without an ElevenLabs key a working dub option. Quality
is below ElevenLabs (no voice cloning) but better than gTTS — the Edge
neural voices are surprisingly natural.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
from pathlib import Path

# Edge TTS voice IDs per language. Picked the most natural-sounding
# neural voice in each. See `edge-tts --list-voices` for full options.
DEFAULT_VOICES = {
    "en": "en-US-AriaNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "hi": "hi-IN-SwaraNeural",
    "ur": "ur-PK-UzmaNeural",
    "ar": "ar-EG-SalmaNeural",
    "tr": "tr-TR-EmelNeural",
    "id": "id-ID-GadisNeural",
    "vi": "vi-VN-HoaiMyNeural",
    "th": "th-TH-PremwadeeNeural",
    "fa": "fa-IR-DilaraNeural",
    "pl": "pl-PL-AgnieszkaNeural",
    "nl": "nl-NL-FennaNeural",
    "bn": "bn-IN-TanishaaNeural",
}

# Male voice variants — used when the speaker in the source is male.
# Pulled from edge-tts's catalog. Where a language has no popular male
# neural voice we fall back to the female default.
MALE_VOICES = {
    "en": "en-US-GuyNeural",
    "es": "es-ES-AlvaroNeural",
    "fr": "fr-FR-HenriNeural",
    "de": "de-DE-ConradNeural",
    "it": "it-IT-DiegoNeural",
    "pt": "pt-BR-AntonioNeural",
    "ru": "ru-RU-DmitryNeural",
    "zh": "zh-CN-YunxiNeural",
    "ja": "ja-JP-KeitaNeural",
    "ko": "ko-KR-InJoonNeural",
    "hi": "hi-IN-MadhurNeural",
    "ur": "ur-PK-AsadNeural",
    "ar": "ar-EG-ShakirNeural",
    "tr": "tr-TR-AhmetNeural",
    "id": "id-ID-ArdiNeural",
    "vi": "vi-VN-NamMinhNeural",
    "th": "th-TH-NiwatNeural",
    "fa": "fa-IR-FaridNeural",
    "pl": "pl-PL-MarekNeural",
    "nl": "nl-NL-MaartenNeural",
    "bn": "bn-IN-BashkarNeural",
}


def pick_voice(target_language: str, gender: str = "auto") -> str:
    """Pick an Edge TTS voice for a given language + gender.
    `gender` is one of 'male', 'female', 'auto'. 'auto' returns the female
    default (matching original behavior)."""
    lang = (target_language or "en").lower()
    g = (gender or "auto").lower()
    if g == "male":
        return MALE_VOICES.get(lang) or DEFAULT_VOICES.get(lang) or DEFAULT_VOICES["en"]
    return DEFAULT_VOICES.get(lang) or DEFAULT_VOICES["en"]


LANGUAGE_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian",
    "zh": "Chinese (Simplified)", "ja": "Japanese", "ko": "Korean",
    "hi": "Hindi", "ur": "Urdu", "ar": "Arabic", "tr": "Turkish",
    "id": "Indonesian", "vi": "Vietnamese", "th": "Thai",
    "fa": "Persian", "pl": "Polish", "nl": "Dutch", "bn": "Bengali",
}


def get_supported_languages() -> list[dict]:
    """Used by the /api/translate/languages endpoint to populate the
    Edge TTS language picker. Same shape ElevenLabs returns."""
    return [
        {"code": code, "name": LANGUAGE_NAMES.get(code, code)}
        for code in DEFAULT_VOICES.keys()
    ]


# ---------------------------------------------------------------------------
# Synthesize speech
# ---------------------------------------------------------------------------

async def _synthesize_async(text: str, voice: str, out_path: Path) -> None:
    import edge_tts
    communicator = edge_tts.Communicate(text, voice)
    await communicator.save(str(out_path))


def synthesize_speech(text: str, target_language: str, out_path: Path,
                      voice: str | None = None) -> Path:
    """Synthesize `text` with Edge TTS in `target_language` (ISO 639-1)."""
    voice = voice or DEFAULT_VOICES.get(target_language, DEFAULT_VOICES["en"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        asyncio.run(_synthesize_async(text, voice, out_path))
    except RuntimeError:
        # Already inside an event loop (e.g. uvicorn) — use new loop.
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_synthesize_async(text, voice, out_path))
        finally:
            loop.close()
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Edge TTS produced no audio")
    return out_path


# ---------------------------------------------------------------------------
# Mux audio onto video
# ---------------------------------------------------------------------------

def _video_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip() or 0.0)


def _audio_duration(path: Path) -> float:
    return _video_duration(path)


def replace_audio(
    video_path: Path,
    audio_path: Path,
    out_path: Path,
    *,
    keep_original_volume: float = 0.0,
) -> Path:
    """Mux `audio_path` onto the video.

    `keep_original_volume`:
      - 0.0 (default) → fully replace the original audio track (old behavior)
      - 0.0–1.0       → keep the original at this volume, layer the dub
                        on top at full volume. 0.15–0.25 sounds like
                        background narration; 0.5+ dubbed-doc style.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    vid_dur = _video_duration(video_path)
    aud_dur = _audio_duration(audio_path)

    # Speed-match the dub to the video duration so they line up.
    speed = max(0.85, min(1.15, aud_dur / vid_dur)) if vid_dur > 0 else 1.0
    dub_filter = []
    if abs(speed - 1.0) > 0.02:
        dub_filter.append(f"atempo={speed:.3f}")
    dub_filter.append("apad")
    dub_filter.append(f"atrim=0:{vid_dur:.3f}")
    dub_filter.append("asetpts=N/SR/TB")
    dub_filter_str = ",".join(dub_filter)

    keep = max(0.0, min(1.0, float(keep_original_volume)))
    if keep <= 0.001:
        # Old behavior — replace entirely
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-filter_complex", f"[1:a]{dub_filter_str}[a]",
            "-map", "0:v",
            "-map", "[a]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(out_path),
        ]
    else:
        # Mix — original at `keep` volume, dub at full volume on top.
        # `duration=first` makes amix follow the original track length.
        filter_complex = (
            f"[0:a]volume={keep:.3f}[orig];"
            f"[1:a]{dub_filter_str},volume=1.0[dub];"
            f"[orig][dub]amix=inputs=2:duration=first:dropout_transition=0[a]"
        )
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-filter_complex", filter_complex,
            "-map", "0:v",
            "-map", "[a]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(out_path),
        ]

    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(
            "FFmpeg mux failed: "
            + res.stderr.decode("utf-8", errors="replace")[-500:]
        )
    return out_path


# ---------------------------------------------------------------------------
# Top-level orchestrator (mirrors translate.translate_video signature)
# ---------------------------------------------------------------------------

def dub_with_edge_tts(
    video_path: str,
    output_path: str,
    target_language: str,
    text_to_speak: str,
    voice: str | None = None,
    keep_original_volume: float = 0.0,
) -> dict:
    """Dub a clip's audio into `target_language` using Edge TTS.

    `text_to_speak` is the already-translated transcript that the LLM
    produced (the caller is responsible for translating). We accept a
    pre-translated string rather than translating here so the caller can
    use any provider (Gemini / OpenAI / Claude / etc.) via the abstraction
    in llm/ — keeps this module focused on TTS + muxing.
    """
    video_path_p = Path(video_path)
    output_path_p = Path(output_path)
    if not video_path_p.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    print(f"[Edge TTS] Synthesizing {len(text_to_speak)} chars in {target_language} …")
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_audio = Path(tmp.name)
    try:
        synthesize_speech(text_to_speak, target_language, tmp_audio, voice=voice)
        print(f"[Edge TTS] Audio written: {tmp_audio} ({tmp_audio.stat().st_size} bytes)")
        replace_audio(
            video_path_p, tmp_audio, output_path_p,
            keep_original_volume=keep_original_volume,
        )
        print(f"[Edge TTS] Dubbed clip ready: {output_path}")
        return {
            "ok": True,
            "output_path": str(output_path_p),
            "voice": voice or DEFAULT_VOICES.get(target_language, DEFAULT_VOICES["en"]),
            "target_language": target_language,
        }
    finally:
        try:
            tmp_audio.unlink(missing_ok=True)
        except Exception:
            pass
