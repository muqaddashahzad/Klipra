"""Smart Clipper — multimodal viral-moment picker.

Watches the video (real frames + audio transcript) instead of just reading
the transcript like the legacy text picker does. Uses any of:

  • Local Ollama VLMs (free):
      - llama3.2-vision:11b
      - qwen2-vl:7b
      - minicpm-v:8b
      - llava:13b
  • Cloud APIs (BYOK, free tier or paid):
      - Gemini 1.5 / 2.5 Flash / Pro    (Google free tier covers ~5 vids/day)
      - GPT-4o / GPT-4o-mini            (OpenAI, paid)
      - Claude 3.5 / 3.7 Sonnet         (Anthropic, paid)

The picker returns ranked viral-moment candidates with start/end timestamps,
a one-line hook, and a rationale string. The caller (the new Smart Clipper
endpoint in app.py) then runs each candidate through Klipra's existing
reframe + ffmpeg cut + caption pipeline — so horizontal input produces
vertical 9:16 output exactly the same way the legacy clip generator does.

Designed to live ALONGSIDE the existing text-only picker (main.py /
saasshorts.py). Nothing in the legacy clip-gen flow changes — Smart
Clipper is its own surface.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# --------------------------------------------------------------------------
# MODEL REGISTRY
# --------------------------------------------------------------------------
# Single source of truth for every multimodal model the Smart Clipper
# supports. The frontend reads this via /api/multimodal-clip/models and
# uses it to render the model picker (with download buttons for local
# models that aren't yet installed).
#
# `tier` is one of:
#   • 'free-local'   — runs entirely on the user's machine via Ollama.
#                      Hit the download button once and you're done.
#   • 'free-cloud'   — has a generous free tier on the provider's API
#                      (no card, sometimes daily caps). User pastes a
#                      free API key once.
#   • 'paid-cloud'   — no free tier; user brings their own API key
#                      and pays the provider directly.
#
# `quality` is a hand-tuned 0-100 score the UI shows so users can pick
# trade-offs at a glance without us pretending precision we don't have.
# `speed_seconds` is approximate end-to-end picker time on a 10-min
# video on the user's stated hardware (M1 64GB).
MODEL_REGISTRY: List[Dict[str, Any]] = [
    # ----- Local (Ollama) -----
    {
        "id": "ollama/llama3.2-vision:11b",
        "provider": "ollama",
        "ollama_tag": "llama3.2-vision:11b",
        "label": "Llama 3.2 Vision 11B",
        "vendor": "Meta",
        "tier": "free-local",
        "size_mb": 7900,
        "quality": 78,
        "speed_seconds": 240,
        "notes": "Free, runs locally. Best balance of quality and speed.",
    },
    {
        "id": "ollama/qwen2-vl:7b",
        "provider": "ollama",
        "ollama_tag": "qwen2-vl:7b",
        "label": "Qwen2-VL 7B",
        "vendor": "Alibaba",
        "tier": "free-local",
        "size_mb": 5200,
        "quality": 73,
        "speed_seconds": 180,
        "notes": "Free, smaller download, quick. Good for sanity-check runs.",
    },
    {
        "id": "ollama/minicpm-v:8b",
        "provider": "ollama",
        "ollama_tag": "minicpm-v:8b",
        "label": "MiniCPM-V 2.6 (8B)",
        "vendor": "OpenBMB",
        "tier": "free-local",
        "size_mb": 6100,
        "quality": 76,
        "speed_seconds": 210,
        "notes": "Free, strong at multi-image reasoning. Good for clip picking.",
    },
    {
        "id": "ollama/llava:13b",
        "provider": "ollama",
        "ollama_tag": "llava:13b",
        "label": "LLaVA 13B",
        "vendor": "Microsoft Research",
        "tier": "free-local",
        "size_mb": 8000,
        "quality": 70,
        "speed_seconds": 270,
        "notes": "Free, classic VLM. Mature and stable.",
    },
    # ----- Cloud free tier -----
    # NOTE: Google deprecated gemini-1.5-flash for new API keys
    # (existing keys may still work but new aistudio.google.com keys
    # 404 on it). We default to gemini-2.5-flash, which is Google's
    # current free-tier multimodal recommendation.
    {
        "id": "gemini/gemini-2.5-flash",
        "provider": "gemini",
        "label": "Gemini 2.5 Flash",
        "vendor": "Google",
        "tier": "free-cloud",
        "quality": 92,
        "speed_seconds": 30,
        "free_tier_note": "Free tier ~10 req/min, ~1500 req/day. Best free cloud default.",
        "byok_setting": "gemini",
        "notes": "Current Google default. Strong quality, free tier, native multimodal.",
    },
    {
        "id": "gemini/gemini-2.0-flash",
        "provider": "gemini",
        "label": "Gemini 2.0 Flash",
        "vendor": "Google",
        "tier": "free-cloud",
        "quality": 86,
        "speed_seconds": 25,
        "free_tier_note": "Older, generous free tier, stable.",
        "byok_setting": "gemini",
        "notes": "Solid fallback when 2.5-flash hits its rate limit.",
    },
    # ----- Cloud paid -----
    {
        "id": "gemini/gemini-2.5-pro",
        "provider": "gemini",
        "label": "Gemini 2.5 Pro",
        "vendor": "Google",
        "tier": "paid-cloud",
        "quality": 96,
        "speed_seconds": 45,
        "byok_setting": "gemini",
        "cost_per_video": "~$0.20",
        "notes": "Best quality on Google's stack. Paid tier only.",
    },
    {
        "id": "openai/gpt-4o",
        "provider": "openai",
        "label": "GPT-4o",
        "vendor": "OpenAI",
        "tier": "paid-cloud",
        "quality": 94,
        "speed_seconds": 35,
        "byok_setting": "openai",
        "cost_per_video": "~$0.40",
        "notes": "Strong reasoning. No free tier.",
    },
    {
        "id": "openai/gpt-4o-mini",
        "provider": "openai",
        "label": "GPT-4o mini",
        "vendor": "OpenAI",
        "tier": "paid-cloud",
        "quality": 80,
        "speed_seconds": 25,
        "byok_setting": "openai",
        "cost_per_video": "~$0.06",
        "notes": "Cheaper OpenAI option, decent quality.",
    },
    {
        "id": "anthropic/claude-3-5-sonnet-20241022",
        "provider": "anthropic",
        "label": "Claude 3.5 Sonnet",
        "vendor": "Anthropic",
        "tier": "paid-cloud",
        "quality": 93,
        "speed_seconds": 40,
        "byok_setting": "anthropic",
        "cost_per_video": "~$0.45",
        "notes": "Excellent at long-context reasoning over many frames.",
    },
]


def get_model_by_id(model_id: str) -> Optional[Dict[str, Any]]:
    """Look up a model entry by its registry id."""
    for m in MODEL_REGISTRY:
        if m["id"] == model_id:
            return m
    return None


# --------------------------------------------------------------------------
# FRAME EXTRACTION
# --------------------------------------------------------------------------

@dataclass
class Frame:
    time_seconds: float
    image_path: str


def extract_keyframes(
    video_path: str,
    *,
    stride_seconds: float = 4.0,
    max_frames: int = 240,
    out_dir: Optional[str] = None,
) -> List[Frame]:
    """Sample one JPEG keyframe every `stride_seconds` from the video.

    Why this exists: most VLMs don't accept native video. They want
    images. We sample the video at a fixed rate and feed those frames
    plus the transcript window to the model. Higher frame rate = better
    moment detection but slower picker. 4 seconds is a good default —
    a typical viral beat (a laugh, a pause, a shocked face) lasts at
    least that long.

    `max_frames` is a hard cap so a 90-min podcast doesn't melt the
    machine. With max_frames=240 and stride=4s we cover up to 16 min
    of content; for longer videos the caller should call this on each
    chunk separately or raise the stride.
    """
    if not os.path.isfile(video_path):
        raise FileNotFoundError(video_path)

    if out_dir is None:
        out_dir = tempfile.mkdtemp(prefix="klipra-vlm-frames-")
    os.makedirs(out_dir, exist_ok=True)

    # Use the `fps` filter to sample at exactly 1/stride_seconds Hz.
    # `-frames:v` enforces the max-frames cap so we don't write a flood
    # of files for a long source.
    fps = 1.0 / max(0.5, stride_seconds)
    pattern = os.path.join(out_dir, "frame_%05d.jpg")
    cmd = [
        "ffmpeg",
        "-loglevel", "error",
        "-i", video_path,
        "-vf", f"fps={fps:.4f},scale=512:-1",  # downscale — VLMs don't need 4K
        "-q:v", "5",
        "-frames:v", str(max_frames),
        "-y",
        pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg keyframe extraction failed: {proc.stderr[-500:]}"
        )

    frames: List[Frame] = []
    written = sorted(
        f for f in os.listdir(out_dir) if f.startswith("frame_") and f.endswith(".jpg")
    )
    for i, fname in enumerate(written):
        # Frame index is 1-based; time = (i) * stride (frame 1 is at t=0+½ stride
        # because of how ffmpeg's `fps` filter works, but i*stride is close
        # enough for moment-picking).
        t = i * stride_seconds
        frames.append(Frame(time_seconds=t, image_path=os.path.join(out_dir, fname)))
    return frames


def encode_frame_b64(frame_path: str) -> str:
    """JPEG file → base64 string. Used by every cloud provider."""
    with open(frame_path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def composite_frames_to_grid(
    frame_paths: List[str],
    *,
    out_path: Optional[str] = None,
    cols: int = 4,
) -> tuple[str, int, int]:
    """Stitch N JPEG keyframes into a single tiled grid image.

    Why this exists: many local VLMs (notably Llama 3.2 Vision via
    Ollama) hard-cap input to ONE image per call. We can't send 8
    separate frames the way Gemini accepts. Workaround — combine all
    frames into a single composite "contact-sheet" image using
    ffmpeg's `tile` filter. The model sees one big image laid out as
    a grid; the prompt tells it the order so it can correlate cells
    to timestamps.

    Returns: (out_path, cols, rows) — caller uses cols/rows to
    explain the layout in the prompt.
    """
    n = len(frame_paths)
    if n == 0:
        raise ValueError("No frames to composite.")
    rows = max(1, (n + cols - 1) // cols)
    if out_path is None:
        out_path = os.path.join(
            os.path.dirname(frame_paths[0]) or tempfile.gettempdir(),
            "klipra_grid.jpg",
        )
    # Write a temp file listing the inputs (avoids hitting the shell
    # length limit when N gets bigger and side-steps any glob ordering
    # surprises). ffmpeg's concat demuxer reads it.
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8"
    ) as listfile:
        for p in frame_paths:
            listfile.write(f"file '{p}'\n")
            listfile.write(f"duration 0.04\n")
        # ffmpeg requires the last file repeated to compute duration
        listfile.write(f"file '{frame_paths[-1]}'\n")
        list_path = listfile.name

    try:
        cmd = [
            "ffmpeg",
            "-loglevel", "error",
            "-f", "concat",
            "-safe", "0",
            "-i", list_path,
            "-vf", f"scale=480:-2,tile={cols}x{rows}:padding=8:color=black",
            "-frames:v", "1",
            "-q:v", "5",
            "-y",
            out_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg grid composite failed: {proc.stderr[-500:]}"
            )
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass
    return out_path, cols, rows


# --------------------------------------------------------------------------
# PROMPT
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# SIGNAL RUBRIC — adapted from clipify (MIT, Louise de Sadeleer for Tella).
# We don't copy their code, only the named-signal IDEA: a clip can't just
# get one opaque virality score; it has to be evaluated against a small
# fixed set of language-agnostic signals so the model commits to each
# rather than handwaving the whole thing.
#
# Keep this list short (6 entries) — bigger lists waste tokens and dilute
# the model's attention on each signal. Each signal scores 0.0-1.0 with
# a one-clause rationale. Default rubric for new picks; legacy code path
# behind `scoring_rubric='classic'` flag.
# --------------------------------------------------------------------------
SIGNAL_RUBRIC = [
    (
        "punchline",
        "A line that lands a joke, reaction, or surprise. Reactions like "
        "'what', 'wait', 'no way', laughter, swearing, or an audible "
        "exhale of disbelief — in any language (the local equivalents "
        "of uh / umm / haan / yaar / oh god count)."
    ),
    (
        "reversal",
        "A setup→twist beat. A question whose answer is unexpected, or a "
        "claim that gets immediately contradicted. The viewer's mental "
        "model has to flip inside the clip."
    ),
    (
        "awkward_pause",
        "A long beat of silence, a stutter, or filler-heavy struggle "
        "(filler words in ANY language: uh / um / matlab / yaani / yaar / "
        "ehh / actually). Awkwardness is comedic gold for shorts."
    ),
    (
        "one_liner",
        "A short standalone declarative sentence that would survive being "
        "screenshotted with no context. Quotable, self-contained, "
        "ideally under 12 words."
    ),
    (
        "audio_peak",
        "A sudden spike in vocal energy — laughter, raised voice, a yell, "
        "loud reaction. Visual cues: open mouth, hand to face, exaggerated "
        "expression. Audio cues will be cross-checked by ffmpeg post-hoc."
    ),
    (
        "visual_energy",
        "Animated face, sudden movement, gesture spike, scene cut, "
        "on-screen text/chart appearing, b-roll energy. A boring "
        "talking-head minute scores 0; a chart reveal with a "
        "head-shake reaction scores 1."
    ),
]


def _signal_rubric_block() -> str:
    """Render the rubric as a numbered list inside the picker prompt."""
    return "\n".join(
        f"  {i + 1}. `{name}` — {desc}"
        for i, (name, desc) in enumerate(SIGNAL_RUBRIC)
    )


# --------------------------------------------------------------------------
# AUDIO PEAK MEASUREMENT — ffmpeg, no LLM, no extra deps.
# --------------------------------------------------------------------------
# The LLM's `audio_peak` score is a guess based on visual cues + transcript
# context. We override it post-hoc with a real ffmpeg `volumedetect`
# measurement of the actual audio inside the clip's [start, end] window,
# normalised to 0.0-1.0.
#
# Why this matters: laughter, yelling, and crowd reactions almost always
# spike volumedetect's `max_volume`. Whisper might say "haha" or "wow"
# regardless of actual loudness — measuring the audio is the cheap, free,
# always-available ground truth.
#
# Cost: one ffmpeg subprocess per clip. ~150ms on an M1 for a 30-second
# slice. Zero LLM cost.

def measure_audio_peak(
    video_path: str,
    start: float,
    end: float,
) -> Optional[float]:
    """Run `ffmpeg -af volumedetect` over [start, end] and return a
    0.0-1.0 audio-peak score.

    Mapping (dBFS → 0..1):
       -40 dBFS or quieter → 0.0    (whisper / near-silence)
        -3 dBFS or louder  → 1.0    (audible yell / laugh / spike)
       linearly interpolated between.

    Returns None if ffmpeg fails or the window is invalid — caller
    should NOT use the LLM's guess as a fallback either; just keep
    audio_peak as whatever the LLM produced.
    """
    if not video_path or end <= start:
        return None
    duration = max(0.1, float(end) - float(start))
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-nostats",
                "-ss", f"{start:.3f}",
                "-i", video_path,
                "-t", f"{duration:.3f}",
                "-vn", "-af", "volumedetect",
                "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return None
    # ffmpeg writes volumedetect output to stderr. Format:
    #   [Parsed_volumedetect_0 @ 0x...] mean_volume: -23.4 dB
    #   [Parsed_volumedetect_0 @ 0x...] max_volume:  -3.1 dB
    import re
    m = re.search(r"max_volume:\s*(-?[0-9.]+)\s*dB", proc.stderr or "")
    if not m:
        return None
    try:
        max_db = float(m.group(1))
    except ValueError:
        return None
    # Linear-clip mapping.
    if max_db >= -3.0:
        return 1.0
    if max_db <= -40.0:
        return 0.0
    return round((max_db + 40.0) / 37.0, 3)


def override_audio_peak_scores(
    video_path: str,
    clips: List[Dict[str, Any]],
    *,
    on_log=None,
) -> List[Dict[str, Any]]:
    """For every clip whose `signals` dict is present, replace the
    LLM-guessed `audio_peak` with the actual ffmpeg measurement.

    Mutates AND returns the list. Failures on individual clips are
    silent — the LLM's guess remains in place for that clip only.
    """
    log = on_log or (lambda s: print(s))
    if not clips:
        return clips
    for c in clips:
        sig = c.get("signals")
        if not isinstance(sig, dict):
            continue
        measured = measure_audio_peak(video_path, c.get("start", 0), c.get("end", 0))
        if measured is None:
            continue
        prev = sig.get("audio_peak")
        sig["audio_peak"] = measured
        if isinstance(prev, (int, float)) and abs(prev - measured) > 0.2:
            log(
                f"🔊 audio_peak overridden for clip @ {c.get('start')}s: "
                f"LLM said {prev:.2f}, ffmpeg measured {measured:.2f}"
            )
    return clips


def _build_picker_prompt(
    transcript_text: str,
    target_clips: int,
    min_duration: float,
    max_duration: float,
    video_duration: float,
    frame_stride: float = 4.0,
    frame_count: int = 0,
    scoring_rubric: str = "signals",
) -> str:
    """The system+user prompt the VLM sees. Same wording across providers
    so quality differences are about the model, not the prompt.

    `scoring_rubric`:
      'signals' — emit per-signal scores (the new default; see
                  SIGNAL_RUBRIC). LLM has to commit to each signal
                  individually instead of vibe-checking the whole clip.
      'classic' — legacy single hook + why_viral. Kept so the
                  frontend can flip a feature flag and A/B-compare
                  picker quality on real videos.
    """
    rubric = (scoring_rubric or "signals").lower()
    # Compute mandatory zone boundaries so the prompt can FORCE clips
    # to be sampled across the whole video instead of clustering at the
    # start. We split the source into `target_clips` zones and require
    # each clip to fall in a different zone.
    zone_size = max(1.0, video_duration / max(1, target_clips))
    zones_text_lines = []
    for z in range(target_clips):
        z_start = z * zone_size
        z_end = min(video_duration, (z + 1) * zone_size)
        zones_text_lines.append(
            f"  Zone {z + 1}: from {z_start:.1f}s to {z_end:.1f}s "
            f"(pick exactly ONE clip whose start falls inside this zone)"
        )
    zones_text = "\n".join(zones_text_lines)

    # ----- Output schema chosen by rubric -----
    if rubric == "signals":
        # Per-signal scores. The LLM has to fill EVERY signal for EVERY
        # clip, which forces it to commit to specific judgments rather
        # than hide behind a single vague "this is viral" score.
        rubric_block = (
            f"⭐ EVALUATION RUBRIC — score every clip against these six "
            f"signals individually. Each signal is 0.0 (not present) to "
            f"1.0 (definitive). DO NOT skip signals; if a signal isn't "
            f"present, score it 0.0 with a one-clause reason.\n"
            f"{_signal_rubric_block()}\n\n"
            f"Signals are LANGUAGE-AGNOSTIC. The transcript may be in "
            f"English, Urdu, Hindi, Hinglish, Roman Urdu, Spanish, or "
            f"anything else. Map filler words / reactions to the local "
            f"equivalent.\n\n"
        )
        output_schema = (
            f"Return ONLY a JSON object of this exact shape (no markdown, "
            f"no code fences, no commentary):\n"
            f'{{"clips": [\n'
            f'  {{\n'
            f'    "start": <seconds, float>,\n'
            f'    "end": <seconds, float>,\n'
            f'    "hook": "<8-12 word headline that would work as the clip\'s caption hook>",\n'
            f'    "why_viral": "<one sentence explaining what makes this moment land overall>",\n'
            f'    "signals": {{\n'
            f'      "punchline":      <0.0-1.0>,\n'
            f'      "reversal":       <0.0-1.0>,\n'
            f'      "awkward_pause":  <0.0-1.0>,\n'
            f'      "one_liner":      <0.0-1.0>,\n'
            f'      "audio_peak":     <0.0-1.0>,\n'
            f'      "visual_energy":  <0.0-1.0>\n'
            f'    }},\n'
            f'    "signal_rationale": "<one short clause per signal, comma-separated, e.g. \'punchline: he says no way; reversal: question→twist; audio_peak: laughter; awkward_pause: none; one_liner: yes; visual_energy: hand gesture\'>"\n'
            f'  }}\n'
            f"]}}\n\n"
        )
    else:
        # Legacy single-judgment shape. Kept for A/B comparison.
        rubric_block = ""
        output_schema = (
            f"Return ONLY a JSON object of this exact shape (no markdown, "
            f"no code fences, no commentary):\n"
            f'{{"clips": [\n'
            f'  {{"start": <seconds, float>, "end": <seconds, float>, '
            f'   "hook": "<8-12 word headline that would work as the clip\'s caption hook>", '
            f'   "why_viral": "<one sentence explaining what makes this moment land>"}}\n'
            f"]}}\n\n"
        )

    return (
        f"You are an expert short-form video editor. You watch the supplied "
        f"video frames AND read the transcript, then pick the {target_clips} "
        f"strongest viral moments — the windows that would perform best on "
        f"TikTok, YouTube Shorts, or Instagram Reels.\n\n"
        + rubric_block
        +
        f"Source video duration: {video_duration:.1f} seconds.\n"
        f"You're seeing {frame_count} keyframes spaced approximately "
        f"{frame_stride:.1f} seconds apart in chronological order. Frame i "
        f"(zero-indexed) corresponds to time t ≈ i * {frame_stride:.1f}s.\n"
        f"Each clip must be between {min_duration:.0f}s and {max_duration:.0f}s.\n\n"
        f"⚠️ CRITICAL TIMESTAMP FORMAT — read this twice:\n"
        f"  • `start` and `end` MUST be RAW SECONDS as plain numbers, NOT minutes.\n"
        f"  • A moment 3 minutes 25 seconds in is 205.0, NOT 3.25 and NOT \"3:25\".\n"
        f"  • A moment 12.5 seconds in is 12.5, not 0.125 or \"0:12\".\n"
        f"  • If you write 3.25, that means 3.25 seconds — way too short to be a clip.\n"
        f"  • Example: a 30-second clip starting at 3:42 in the video is "
        f"`{{\"start\": 222.0, \"end\": 252.0, ...}}` (222 = 3*60+42).\n\n"
        f"⚠️ DIVERSITY REQUIREMENT — read this carefully:\n"
        f"  • You MUST return {target_clips} clips with DIFFERENT timestamps spread "
        f"ACROSS the whole video. Returning clips that all start near the beginning "
        f"or are all the same length is WRONG.\n"
        f"  • Vary clip durations: some clips should be {min_duration:.0f}s, others "
        f"{(min_duration + max_duration) / 2:.0f}s, others {max_duration:.0f}s. "
        f"Don't return all clips at the maximum length.\n"
        f"  • Each clip must come from a different MOMENT in the video — different "
        f"topic, different speaker beat, different scene. Not consecutive seconds.\n"
        f"  • Mandatory zones (one clip from each):\n"
        f"{zones_text}\n\n"
        f"Use BOTH the visual frames (facial expressions, gestures, scene "
        f"cuts, b-roll energy) AND the transcript (hook lines, punchlines, "
        f"shocking statements) to decide.\n\n"
        f"Transcript (with rough timestamps):\n"
        f"---\n{transcript_text}\n---\n\n"
        + output_schema
        + f"Pick {target_clips} clips, ordered by predicted virality "
        f"(best first). Do not overlap clips. Respect the duration "
        f"window. Verify that each clip's `start` falls in a DIFFERENT "
        f"zone before answering."
    )


# --------------------------------------------------------------------------
# PROVIDERS
# --------------------------------------------------------------------------

@dataclass
class PickerResult:
    clips: List[Dict[str, Any]] = field(default_factory=list)
    raw_response: str = ""
    provider_used: str = ""
    model_used: str = ""
    elapsed_seconds: float = 0.0
    frames_examined: int = 0


def _parse_json_response(raw: str) -> Dict[str, Any]:
    """Tolerant JSON parser. Strips code fences, finds the JSON block,
    and normalises whatever the model returned into the shape the rest
    of the pipeline expects: { "clips": [{start, end, hook, why_viral}] }.

    Handles common deviations:
      • Alternative array keys: viral_moments, moments, picks, results,
        events, segments — all collapse to "clips".
      • Alternative field names: start_time/begin/from → start;
        end_time/finish/to → end; title/caption → hook;
        rationale/reason/description → why_viral.
      • A bare array at the top level (no wrapping object).
    """
    s = (raw or "").strip()
    if s.startswith("```"):
        s = s.split("```", 2)
        s = s[1] if len(s) > 1 else ""
        if "\n" in s:
            first, rest = s.split("\n", 1)
            if first.strip() in ("json", "JSON"):
                s = rest

    # Try to find a JSON object first; otherwise fall back to a JSON array.
    first_brace = s.find("{")
    last_brace = s.rfind("}")
    first_bracket = s.find("[")
    last_bracket = s.rfind("]")
    candidate = None
    if first_brace >= 0 and last_brace > first_brace:
        candidate = s[first_brace : last_brace + 1]
    if candidate is None and first_bracket >= 0 and last_bracket > first_bracket:
        candidate = s[first_bracket : last_bracket + 1]
    if candidate is None:
        return {"clips": []}

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        return {"clips": []}

    # Case 1: bare array at the top level — wrap it.
    if isinstance(parsed, list):
        return {"clips": _normalize_clip_dicts(parsed)}

    if not isinstance(parsed, dict):
        return {"clips": []}

    # Case 2: an object — find the array under one of the expected keys.
    array_keys = (
        "clips", "viral_moments", "moments", "picks", "results",
        "events", "segments", "highlights", "shorts",
    )
    arr = None
    for k in array_keys:
        v = parsed.get(k)
        if isinstance(v, list):
            arr = v
            break
    if arr is None:
        # Last-ditch: maybe the object IS a single clip — if it has
        # start/end fields, wrap it in a one-element array.
        if any(k in parsed for k in ("start", "start_time", "begin", "from")):
            arr = [parsed]
        else:
            arr = []

    return {"clips": _normalize_clip_dicts(arr)}


def _normalize_clip_dicts(items: List[Any]) -> List[Dict[str, Any]]:
    """Map every {start_time, end_time, title, ...}-style entry to our
    canonical {start, end, hook, why_viral} shape so the downstream
    normalizer doesn't have to guess at the field names."""
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        # Pick the first non-None value out of a list of synonym keys.
        def pick(*keys):
            for k in keys:
                if k in item and item[k] is not None:
                    return item[k]
            return None
        # Carry the per-signal scores through if the model emitted them
        # (signals rubric). When the legacy / classic rubric is in
        # play, `signals` stays None and downstream code treats the
        # clip as unscored.
        signals = pick("signals", "scores", "signal_scores")
        signal_rationale = pick("signal_rationale", "rationales", "per_signal_reasons")
        out.append({
            "start": pick("start", "start_time", "begin", "from", "start_seconds", "in"),
            "end":   pick("end",   "end_time",   "finish", "to", "end_seconds", "out"),
            "hook":  pick("hook", "title", "caption", "headline", "name", "label"),
            "why_viral": pick(
                "why_viral", "rationale", "reason",
                "description", "explanation", "viral_reason",
            ),
            "signals": signals if isinstance(signals, dict) else None,
            "signal_rationale": (
                str(signal_rationale).strip()[:600] if signal_rationale else None
            ),
        })
    return out


def _coerce_seconds(value: Any) -> Optional[float]:
    """Convert a VLM-supplied time value to seconds.

    VLMs sometimes return strings like "01:23" or "1m 23s" instead of
    raw seconds, even when the prompt asks for floats. Be lenient — a
    bad pick is better than a dropped one, and a dropped one looks
    like the model failed to find anything.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        # MM:SS or HH:MM:SS
        if ":" in s:
            try:
                parts = [float(p) for p in s.split(":")]
                if len(parts) == 2:
                    return parts[0] * 60 + parts[1]
                if len(parts) == 3:
                    return parts[0] * 3600 + parts[1] * 60 + parts[2]
            except ValueError:
                pass
        # "1m 23s"
        import re
        m = re.match(r"^\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?\s*$", s)
        if m and (m.group(1) or m.group(2)):
            mins = float(m.group(1) or 0)
            secs = float(m.group(2) or 0)
            return mins * 60 + secs
        # Last resort: try float
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _looks_like_mm_dot_ss(values: List[float]) -> bool:
    """Heuristic: are these floats actually MM.SS where the integer part
    is minutes and the decimal part encodes seconds-of-minute? Returns
    True when EVERY value's decimal part is < 0.60 (since real seconds
    don't exceed :59) AND the integer parts are reasonable minute counts.

    This fires when models like Gemini 2.5 Flash return things like
    [3.25, 3.59, 1.25, 2.00, 4.57, 5.18] for a 6-minute video — those
    aren't 3.25-second clips, they're 3:25, 3:59, 1:25, 2:00, etc.
    """
    if not values:
        return False
    for v in values:
        if v < 0:
            return False
        # Decimal part of 0.60+ would be "60+ seconds in a minute" which
        # is invalid in MM.SS, so the value can't be MM.SS.
        decimal = round(v - int(v), 4)
        if decimal >= 0.60:
            return False
    return True


def _mm_dot_ss_to_seconds(v: float) -> float:
    """Convert a MM.SS-encoded float to raw seconds.
    Example: 3.25 → 3*60 + 25 = 205.0."""
    minutes = int(v)
    # Multiply the decimal part by 100 to get the "seconds" portion as
    # the user intended ("3.25" → 25 seconds). Round to handle 0.249999.
    seconds = round((v - minutes) * 100)
    return float(minutes * 60 + seconds)


def _normalize_clips(
    clips: List[Dict[str, Any]],
    *,
    min_duration: float,
    max_duration: float,
    video_duration: float,
) -> List[Dict[str, Any]]:
    """Clamp each clip's start/end into the valid range and drop any that
    are out of policy. The VLM is usually well-behaved but this protects
    the burn pipeline from bogus values."""
    # FIRST PASS — coerce every start/end to float seconds (handling
    # strings like "MM:SS" via _coerce_seconds).
    parsed = []
    for c in clips or []:
        start_sec = _coerce_seconds(c.get("start"))
        end_sec = _coerce_seconds(c.get("end"))
        if start_sec is None or end_sec is None:
            continue
        parsed.append({
            "_raw": c,
            "start": float(start_sec),
            "end": float(end_sec),
        })
    if not parsed:
        return []

    # MM.SS DETECTION — if every clip's duration is suspiciously short
    # (< min_duration / 4) AND all start/end values look like MM.SS
    # (decimal part always < 0.60), the model misformatted the
    # timestamps as minute-dot-second decimals. Re-interpret them.
    suspect_short = all(
        (p["end"] - p["start"]) < (min_duration / 4) for p in parsed
    )
    looks_mm_ss = _looks_like_mm_dot_ss(
        [p["start"] for p in parsed] + [p["end"] for p in parsed]
    )
    if suspect_short and looks_mm_ss:
        print(
            f"⚠️  Normalizer: clips look like MM.SS-as-decimal "
            f"(e.g. 3.25 = 3min 25sec). Auto-converting to raw seconds."
        )
        for p in parsed:
            p["start"] = _mm_dot_ss_to_seconds(p["start"])
            p["end"] = _mm_dot_ss_to_seconds(p["end"])

    # SECOND PASS — clamp + filter + emit final clip dicts.
    out = []
    for p in parsed:
        c = p["_raw"]
        start = max(0.0, p["start"])
        # Cap end at video_duration if we know it, else trust the model.
        if video_duration > 0:
            end = min(video_duration, p["end"])
        else:
            end = p["end"]
        if end <= start:
            continue
        dur = end - start
        if dur < (min_duration * 0.5):  # too short to recover
            continue
        if dur > max_duration:
            end = start + max_duration
        # Per-signal scores — clamp every score to [0,1] and drop bad
        # entries silently. When the model didn't emit a `signals`
        # object (legacy rubric, or it forgot), pass through as None
        # so the frontend can render "unscored" instead of fabricating
        # zeros that look like a real measurement.
        signals_raw = c.get("signals")
        signals_clean = None
        if isinstance(signals_raw, dict):
            signals_clean = {}
            for k in ("punchline", "reversal", "awkward_pause",
                      "one_liner", "audio_peak", "visual_energy"):
                v = signals_raw.get(k)
                try:
                    fv = float(v)
                    if fv != fv:  # NaN guard
                        continue
                    signals_clean[k] = max(0.0, min(1.0, fv))
                except (TypeError, ValueError):
                    continue
            # If the dict had zero valid entries, treat as unscored.
            if not signals_clean:
                signals_clean = None
        out.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "hook": str(c.get("hook", "")).strip()[:200],
            "why_viral": str(c.get("why_viral", "")).strip()[:300],
            "signals": signals_clean,
            "signal_rationale": (
                str(c.get("signal_rationale") or "").strip()[:600] or None
            ),
        })

    # THIRD PASS — diversity. Drop near-duplicate picks (clips whose
    # ranges substantially overlap each other) so the user doesn't get
    # 8 versions of essentially the same moment. The picker prompt
    # instructs the model not to overlap clips, but local VLMs ignore
    # that ~half the time, so we enforce it here.
    out.sort(key=lambda c: c["start"])
    deduped: List[Dict[str, Any]] = []
    for c in out:
        keep = True
        for d in deduped:
            # Compute overlap fraction relative to the SHORTER clip.
            ov_start = max(c["start"], d["start"])
            ov_end = min(c["end"], d["end"])
            overlap = max(0.0, ov_end - ov_start)
            shorter = min(c["end"] - c["start"], d["end"] - d["start"])
            if shorter > 0 and overlap / shorter > 0.50:
                keep = False
                break
        if keep:
            deduped.append(c)

    if len(deduped) < len(out):
        print(
            f"🧹 Diversity filter dropped {len(out) - len(deduped)} "
            f"overlapping picks (>50% overlap with another clip)."
        )
    return deduped


def _call_ollama_vlm(
    *,
    model_tag: str,
    prompt: str,
    frame_paths: List[str],
    base_url: str = "http://host.docker.internal:11434",
) -> str:
    """Local VLM via Ollama. Free. Slow on CPU but excellent on M-series Macs.

    Ollama's /api/generate accepts an `images` list of base64 JPEGs, which
    is a much simpler interface than the cloud providers. One call, one
    response.
    """
    import requests
    images = [encode_frame_b64(p) for p in frame_paths]
    payload = {
        "model": model_tag,
        "prompt": prompt,
        "images": images,
        "stream": False,
        # Ollama's native JSON mode — the runtime forces the model's
        # output to be valid JSON. Belt-and-suspenders alongside the
        # explicit "JSON-only" prompt scaffolding for VLMs that tend
        # to drift into descriptive-prose mode.
        "format": "json",
        "options": {
            "temperature": 0.3,
            "num_predict": 2000,
        },
    }
    r = requests.post(
        f"{base_url.rstrip('/')}/api/generate",
        json=payload,
        timeout=600,
    )
    # When Ollama 400s we want the actual reason in the error message,
    # not the generic requests.HTTPError. The body usually says
    # something like {"error":"image too large"} or
    # {"error":"unknown model"} which makes the bug obvious.
    if not r.ok:
        try:
            body = r.json()
            detail = body.get("error") or body
        except Exception:
            detail = r.text[:500]
        raise RuntimeError(
            f"Ollama {r.status_code} from {model_tag}: {detail}. "
            f"Sent {len(images)} image(s). "
            f"(Llama 3.2 Vision typically supports 1-4 images per call.)"
        )
    data = r.json()
    return data.get("response", "")


def _call_gemini_vision(
    *,
    model_tag: str,
    api_key: str,
    prompt: str,
    frame_paths: List[str],
) -> str:
    """Gemini 1.5/2.5 Flash/Pro via the v1beta REST endpoint.

    Captures finishReason + safety-block info on empty responses so we
    can tell the difference between "model genuinely returned nothing"
    and "model was blocked by content safety". Both used to look
    identical (silent empty-string return) which made the 0-clip bug
    impossible to diagnose from outside.
    """
    if not api_key:
        raise RuntimeError("Gemini selected but no API key configured.")
    import requests
    parts: List[Dict[str, Any]] = [{"text": prompt}]
    for p in frame_paths:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": encode_frame_b64(p),
            }
        })
    # Increased maxOutputTokens — Gemini was silently truncating when
    # asked for 6 clips with longer hooks/rationales, leaving us with
    # incomplete JSON that wouldn't parse and looked like "0 clips".
    #
    # Native responseSchema FORCES the exact shape we want, which kills
    # the previous "0 clips returned" failures caused by Gemini using
    # alternative field names (start_time, from, …) or returning the
    # array under a different key (viral_moments, moments, …).
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "clips": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "start": {
                                    "type": "NUMBER",
                                    "description": (
                                        "Start time in RAW SECONDS as a float "
                                        "(e.g. 205.5 means 205.5 seconds, NOT "
                                        "3:25 minute notation)."
                                    ),
                                },
                                "end": {
                                    "type": "NUMBER",
                                    "description": (
                                        "End time in RAW SECONDS as a float."
                                    ),
                                },
                                "hook": {
                                    "type": "STRING",
                                    "description": (
                                        "8-12 word headline. Will be the "
                                        "clip's caption hook on TikTok / Reels."
                                    ),
                                },
                                "why_viral": {
                                    "type": "STRING",
                                    "description": (
                                        "One sentence: what makes this moment "
                                        "land for short-form social."
                                    ),
                                },
                            },
                            "required": ["start", "end", "hook", "why_viral"],
                        },
                    },
                },
                "required": ["clips"],
            },
        },
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model_tag}:generateContent?key={api_key}"
    )
    r = requests.post(url, json=body, timeout=300)
    if not r.ok:
        try:
            err = r.json()
        except Exception:
            err = r.text[:500]
        raise RuntimeError(f"Gemini {r.status_code}: {err}")

    data = r.json()
    candidates = data.get("candidates") or []
    if not candidates:
        # Some responses route the failure through promptFeedback when
        # the input itself was blocked.
        feedback = data.get("promptFeedback") or {}
        block_reason = feedback.get("blockReason")
        if block_reason:
            raise RuntimeError(
                f"Gemini blocked the prompt: {block_reason}. "
                f"Safety: {feedback.get('safetyRatings')}"
            )
        raise RuntimeError(f"Gemini returned no candidates. Body: {data}")

    cand = candidates[0]
    finish_reason = cand.get("finishReason", "")
    parts_out = (cand.get("content") or {}).get("parts") or []
    text = parts_out[0].get("text", "") if parts_out else ""
    if not text:
        # Empty content — usually safety, max-tokens, or recitation
        # block. Surface the actual reason so the caller can decide.
        safety = cand.get("safetyRatings", [])
        raise RuntimeError(
            f"Gemini returned empty content "
            f"(finishReason={finish_reason!r}, safetyRatings={safety})."
        )
    if finish_reason == "MAX_TOKENS":
        # Truncated mid-JSON — let the caller know so the parser
        # diagnostic can mention this.
        print(
            f"⚠️  Gemini hit MAX_TOKENS — response was truncated. "
            f"Bumping maxOutputTokens didn't help; consider asking for "
            f"fewer clips or shorter rationales."
        )
    return text


def _call_openai_vision(
    *,
    model_tag: str,
    api_key: str,
    prompt: str,
    frame_paths: List[str],
    base_url: str = "https://api.openai.com/v1",
) -> str:
    """GPT-4o / GPT-4o-mini via the chat completions API."""
    if not api_key:
        raise RuntimeError("OpenAI selected but no API key configured.")
    import requests
    user_content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for p in frame_paths:
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{encode_frame_b64(p)}",
                "detail": "low",  # cheaper; VLM doesn't need full detail per frame
            },
        })
    body = {
        "model": model_tag,
        "messages": [{"role": "user", "content": user_content}],
        "temperature": 0.4,
        "max_tokens": 2000,
        "response_format": {"type": "json_object"},
    }
    r = requests.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=300,
    )
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"]


def _call_anthropic_vision(
    *,
    model_tag: str,
    api_key: str,
    prompt: str,
    frame_paths: List[str],
) -> str:
    """Claude 3.5 / 3.7 Sonnet via the messages API."""
    if not api_key:
        raise RuntimeError("Anthropic selected but no API key configured.")
    import requests
    user_content: List[Dict[str, Any]] = []
    for p in frame_paths:
        user_content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": encode_frame_b64(p),
            },
        })
    user_content.append({"type": "text", "text": prompt})
    body = {
        "model": model_tag,
        "messages": [{"role": "user", "content": user_content}],
        "max_tokens": 2000,
        "temperature": 0.4,
    }
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
        timeout=300,
    )
    r.raise_for_status()
    data = r.json()
    out = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            out += block.get("text", "")
    return out


# --------------------------------------------------------------------------
# PUBLIC ENTRY POINT
# --------------------------------------------------------------------------

# Per-provider hard limits on how many keyframes we send in a single
# multimodal call.
#   • Ollama Llama 3.2 Vision STRICTLY ONE image — Ollama 400s with
#     "this model only supports one image while more than one image
#     requested". We work around this by stitching N frames into a
#     single composite grid (see SINGLE_IMAGE_PROVIDERS below).
#   • Other Ollama models (Qwen2-VL, MiniCPM-V) handle multi-image
#     natively up to ~4-8.
#   • Gemini handles 60+ images comfortably.
#   • OpenAI GPT-4o caps at ~20 images per request.
PROVIDER_FRAME_LIMITS: Dict[str, int] = {
    "ollama":    8,
    "gemini":    80,
    "openai":    20,
    "anthropic": 20,
}

# Models that only accept ONE image per call. The picker stitches the
# extracted keyframes into a single composite grid JPEG before calling
# the model so we don't lose temporal coverage.
SINGLE_IMAGE_OLLAMA_TAGS = {
    "llama3.2-vision:11b",
    "llama3.2-vision:90b",
    "llava:13b",
    "llava:7b",
    "bakllava",
}


def find_viral_moments_multimodal(
    video_path: str,
    transcript: Dict[str, Any],
    *,
    model_id: str,
    api_key: str = "",
    base_url: str = "",
    target_clips: int = 6,
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    frame_stride: float = 4.0,
    max_frames: int = 200,
    scoring_rubric: str = "signals",
) -> PickerResult:
    """Run the multimodal viral-moment picker on a video.

    `transcript` is the same shape Whisper / faster-whisper produces:
        {"text": "...", "segments": [{"start", "end", "text"}, ...]}

    `frame_stride` and `max_frames` are starting points; we may shrink
    the number of frames to fit per-provider limits — see
    PROVIDER_FRAME_LIMITS above.
    """
    model = get_model_by_id(model_id)
    if not model:
        raise ValueError(f"Unknown model id: {model_id}")

    t0 = time.time()

    # ------------------------------------------------------------------
    # Cap frames to whatever the chosen provider can actually accept.
    # Without this, a 10-min video at the default stride produces ~150
    # keyframes which Ollama rejects with a 400 (and most cloud VLMs
    # silently truncate).
    # ------------------------------------------------------------------
    provider_limit = PROVIDER_FRAME_LIMITS.get(model.get("provider", ""), 12)
    target_frames = min(max_frames, provider_limit)

    # Probe duration so the prompt has the right end-of-video context.
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ],
        capture_output=True, text=True,
    )
    try:
        video_duration = float(proc.stdout.strip())
    except ValueError:
        video_duration = 0.0

    # 1) Extract keyframes — pick a stride that gives us at most
    #    `target_frames` frames spread evenly across the video. Falls
    #    back to the caller's frame_stride only when we can't probe the
    #    duration (rare).
    effective_stride = frame_stride
    if video_duration > 0 and target_frames > 0:
        # We want exactly `target_frames` frames spread across the video.
        even_stride = video_duration / target_frames
        # Don't go BELOW the caller's requested stride either — if they
        # asked for one frame every 4 seconds and that already produces
        # fewer frames than the cap, keep their value.
        effective_stride = max(frame_stride, even_stride)
    print(
        f"🎞  Frame extraction: stride={effective_stride:.1f}s, "
        f"cap={target_frames} (provider limit), duration={video_duration:.0f}s"
    )
    frames = extract_keyframes(
        video_path,
        stride_seconds=effective_stride,
        max_frames=target_frames,
    )
    if not frames:
        raise RuntimeError("No frames extracted — is the input a valid video?")

    # 2) Build a compact transcript view with rough timestamps so the
    #    VLM can correlate frames to spoken content.
    transcript_lines = []
    for s in transcript.get("segments") or []:
        try:
            start = float(s.get("start", 0))
        except (TypeError, ValueError):
            continue
        text = (s.get("text") or "").strip()
        if not text:
            continue
        mins, secs = divmod(int(start), 60)
        transcript_lines.append(f"[{mins:02d}:{secs:02d}] {text}")
    transcript_text = "\n".join(transcript_lines)
    if len(transcript_text) > 6000:
        transcript_text = transcript_text[:6000] + "\n…"

    # 3) Build the prompt
    prompt = _build_picker_prompt(
        transcript_text=transcript_text,
        target_clips=target_clips,
        min_duration=min_duration,
        max_duration=max_duration,
        video_duration=video_duration,
        frame_stride=effective_stride,
        frame_count=len(frames),
        scoring_rubric=scoring_rubric,
    )

    # 4) Provider dispatch
    provider = model["provider"]
    frame_paths = [f.image_path for f in frames]
    raw = ""
    try:
        if provider == "ollama":
            ollama_base = base_url or os.getenv(
                "OLLAMA_BASE_URL", "http://host.docker.internal:11434"
            )
            tag = model["ollama_tag"]
            # SINGLE-IMAGE FALLBACK — Llama 3.2 Vision and LLaVA only
            # accept one image per /api/generate call. Stitch all
            # frames into a contact-sheet grid and send that.
            if tag in SINGLE_IMAGE_OLLAMA_TAGS:
                grid_path, cols, rows = composite_frames_to_grid(frame_paths)
                # Local VLMs reliably fall into "describe this image"
                # mode if the prompt doesn't HAMMER on the JSON-only
                # constraint. Prepend strong scaffolding before the
                # main prompt and append a JSON-only sign-off.
                grid_prompt = (
                    f"You are a JSON-only API. Your ENTIRE response must "
                    f"be a single valid JSON object — no markdown, no "
                    f"prose, no introduction, no \"the image shows…\". "
                    f"If you describe the image instead of returning "
                    f"JSON, the system will reject your output.\n\n"
                    + prompt
                    + f"\n\nIMAGE NOTE: The supplied image is a SINGLE "
                      f"composite contact-sheet, NOT a regular photo. "
                      f"It contains {cols * rows} frames from the video "
                      f"laid out in a {cols}x{rows} grid. Read it "
                      f"left-to-right, top-to-bottom — the top-left "
                      f"cell is frame 0 (time 0s), and each cell "
                      f"advances by approximately "
                      f"{effective_stride:.1f} seconds.\n\n"
                      f"Do NOT describe the contact sheet. Do NOT say "
                      f"\"I see…\" or \"The image shows…\". Use the "
                      f"frames + the transcript above to pick "
                      f"{target_clips} viral moment time-ranges and "
                      f"output ONLY the JSON described above. Start "
                      f"your response with the character `{{` and end "
                      f"it with `}}`. Nothing else."
                )
                print(
                    f"🧩 Composite-grid path for {tag}: "
                    f"{cols}x{rows} cells, single image."
                )
                raw = _call_ollama_vlm(
                    model_tag=tag,
                    prompt=grid_prompt,
                    frame_paths=[grid_path],
                    base_url=ollama_base,
                )
                # Cleanup grid file after success.
                try:
                    os.unlink(grid_path)
                except OSError:
                    pass
            else:
                raw = _call_ollama_vlm(
                    model_tag=tag,
                    prompt=prompt,
                    frame_paths=frame_paths,
                    base_url=ollama_base,
                )
        elif provider == "gemini":
            raw = _call_gemini_vision(
                model_tag=model_id.split("/", 1)[1],
                api_key=api_key,
                prompt=prompt,
                frame_paths=frame_paths,
            )
        elif provider == "openai":
            raw = _call_openai_vision(
                model_tag=model_id.split("/", 1)[1],
                api_key=api_key,
                prompt=prompt,
                frame_paths=frame_paths,
                base_url=base_url or "https://api.openai.com/v1",
            )
        elif provider == "anthropic":
            raw = _call_anthropic_vision(
                model_tag=model_id.split("/", 1)[1],
                api_key=api_key,
                prompt=prompt,
                frame_paths=frame_paths,
            )
        else:
            raise ValueError(f"Unsupported provider: {provider}")
    finally:
        # Clean up extracted frames — they were only needed for the LLM
        # call. Keep them on error so the user can see what was sent.
        if raw:
            for f in frames:
                try:
                    os.unlink(f.image_path)
                except OSError:
                    pass

    # 5) Parse + sanitize
    parsed = _parse_json_response(raw)
    raw_clips = parsed.get("clips") or []
    clips = _normalize_clips(
        raw_clips,
        min_duration=min_duration,
        max_duration=max_duration,
        video_duration=video_duration,
    )

    # AUDIO-PEAK GROUND TRUTH — replace the LLM's guessed audio_peak
    # score with the actual ffmpeg measurement over each clip's
    # [start, end] window. Costs ~150ms × N clips, no LLM tokens.
    # Skipped on classic rubric (no signals dict to update).
    if (scoring_rubric or "signals").lower() == "signals":
        try:
            override_audio_peak_scores(video_path, clips)
        except Exception as _ap_err:
            print(f"⚠️  audio_peak override failed: {_ap_err}")

    # DIAGNOSTICS — when something fails (model returned nothing OR
    # everything got dropped by the normalizer) log enough to debug
    # without us having to repro. Truncate the raw response so we don't
    # spam multi-MB JSON into stdout but always show the head + tail.
    if not clips:
        head = (raw or "")[:600].replace("\n", " ")
        tail = (raw or "")[-200:].replace("\n", " ") if len(raw or "") > 600 else ""
        print(
            f"⚠️  Multimodal picker returned 0 clips after normalization.\n"
            f"   provider={provider} model={model_id} frames={len(frames)}\n"
            f"   raw clips from model (BEFORE normalize): {len(raw_clips)} entries\n"
            f"   first raw clip: {raw_clips[0] if raw_clips else 'NONE'}\n"
            f"   raw response head: {head!r}\n"
            f"   raw response tail: {tail!r}"
        )

    return PickerResult(
        clips=clips,
        raw_response=raw,
        provider_used=provider,
        model_used=model_id,
        elapsed_seconds=round(time.time() - t0, 1),
        frames_examined=len(frames),
    )


# --------------------------------------------------------------------------
# OLLAMA MODEL MANAGEMENT (used by /api/multimodal-clip/models + pull-model)
# --------------------------------------------------------------------------

def list_installed_ollama_models(
    base_url: str = "http://host.docker.internal:11434",
) -> List[str]:
    """Return the list of model tags currently installed on the local
    Ollama daemon. Returns [] if the daemon is unreachable — caller
    should treat that as 'no local models available'."""
    try:
        import requests
        r = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=2.0)
        if r.status_code != 200:
            return []
        return [m.get("name", "") for m in (r.json().get("models") or []) if m.get("name")]
    except Exception:
        return []


def pull_ollama_model_streaming(
    ollama_tag: str,
    base_url: str = "http://host.docker.internal:11434",
):
    """Generator that yields Ollama pull progress as dicts. The HTTP
    endpoint /api/multimodal-clip/pull-model wraps this in a Server-
    Sent-Events stream so the frontend can render a live progress bar.

    Each yielded dict matches Ollama's native pull stream format:
        {"status": "pulling manifest", ...}
        {"status": "downloading", "digest": "...", "completed": N, "total": N}
        {"status": "success"}
    """
    import requests
    with requests.post(
        f"{base_url.rstrip('/')}/api/pull",
        json={"name": ollama_tag, "stream": True},
        stream=True,
        timeout=3600,
    ) as r:
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                yield {"status": "raw", "line": line}
