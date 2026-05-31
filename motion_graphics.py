"""AI Motion Graphics + SFX overlay generator.

Takes a clip's transcript and an optional video, asks an LLM to propose a
list of overlay events (text bursts, callouts, emoji moments, highlight
boxes) with matching SFX cues, and renders the result via ffmpeg's
drawtext / drawbox filters + the existing synthesised SFX library from
editor.py.

The output of `generate_motion_graphics_plan()` is intentionally JSON
the frontend can preview as a timeline before the user commits to the
render. `render_clip_with_motion_graphics()` then bakes the chosen
events into an mp4. Aspect-aware: positions and font sizes scale with
the target aspect (9:16, 16:9, 1:1).

Design contract for an event:

    {
        "start": float,        # seconds from the start of the clip
        "duration": float,     # seconds the overlay stays on screen
        "type": "text_burst" | "callout_box" | "emoji_burst" |
                "highlight_strip",
        "content": str,        # the text or emoji to show
        "position": "center" | "top-center" | "top-left" |
                    "top-right" | "bottom-center" | "bottom-left" |
                    "bottom-right" | "left" | "right",
        "color": "#RRGGBB",    # primary color of the overlay
        "sfx": "pop" | "whoosh" | "impact" | "ding" | "riser" |
               "reverse_whoosh" | None,
    }

Anything missing gets sensible defaults so the renderer never crashes
on a partial event.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Tuple


# --------------------------------------------------------------------------
# CONSTANTS
# --------------------------------------------------------------------------

# Position name → (x_expr, y_expr, anchor) for FFmpeg drawtext.
# Both expressions are FFmpeg expressions (W, H = video dims; tw, th = text dims).
POSITION_MAP: Dict[str, Tuple[str, str]] = {
    "center":         ("(W-tw)/2",          "(H-th)/2"),
    "top-center":     ("(W-tw)/2",          "H*0.08"),
    "top-left":       ("W*0.05",            "H*0.08"),
    "top-right":      ("W-tw-W*0.05",       "H*0.08"),
    "bottom-center":  ("(W-tw)/2",          "H*0.85"),
    "bottom-left":    ("W*0.05",            "H*0.85"),
    "bottom-right":   ("W-tw-W*0.05",       "H*0.85"),
    "left":           ("W*0.05",            "(H-th)/2"),
    "right":          ("W-tw-W*0.05",       "(H-th)/2"),
}

# Default sizes per overlay type, expressed as a fraction of the video's
# SHORTER edge. Scales correctly across 9:16, 16:9, and 1:1.
DEFAULT_FONT_FRAC = {
    "text_burst":     0.085,
    "callout_box":    0.055,
    "emoji_burst":    0.18,
    "highlight_strip": 0.045,
}


# Approximate frame region (x0, y0, x1, y1 — all 0..1) that an overlay at
# each named position is likely to occupy. Used to detect collision with
# detected faces and snap the overlay to a safe alternate slot.
#
# These are conservative bounding boxes of where text typically lands
# given POSITION_MAP's anchor expressions plus the largest expected
# fontsize. If a face overlaps with the chosen overlay's box, the
# placement is "blocked" and we look for a non-blocked alternate.
POSITION_BBOX: Dict[str, Tuple[float, float, float, float]] = {
    "center":        (0.10, 0.30, 0.90, 0.70),
    "top-center":    (0.10, 0.02, 0.90, 0.22),
    "top-left":      (0.02, 0.02, 0.50, 0.22),
    "top-right":     (0.50, 0.02, 0.98, 0.22),
    "bottom-center": (0.10, 0.78, 0.90, 0.98),
    "bottom-left":   (0.02, 0.78, 0.50, 0.98),
    "bottom-right":  (0.50, 0.78, 0.98, 0.98),
    "left":          (0.02, 0.30, 0.30, 0.70),
    "right":         (0.70, 0.30, 0.98, 0.70),
}

# Preferred fallback order when the AI's chosen position overlaps a face.
# Top/bottom corners are usually safest because faces gravitate to the
# centre column.
POSITION_FALLBACKS: List[str] = [
    "top-center", "bottom-center",
    "top-left",   "top-right",
    "bottom-left","bottom-right",
    "left",       "right",
    "center",
]


# --------------------------------------------------------------------------
# FACE DETECTION — sampled across the clip
# --------------------------------------------------------------------------

def detect_face_regions(
    input_path: str,
    num_samples: int = 10,
) -> List[Tuple[float, float, float, float]]:
    """Sample `num_samples` evenly-spaced frames from the clip, run
    mediapipe FaceDetection on each, and return the union of detected
    face bounding boxes — each as (x0, y0, x1, y1) in 0..1 fractional
    coords. Empty list if no faces or if any dependency is missing.

    Cheap and forgiving — failure to detect simply means we fall back to
    "no face zones", which lets the AI place overlays anywhere.
    """
    try:
        import cv2
        import mediapipe as mp
    except Exception:
        return []

    if not os.path.isfile(input_path):
        return []

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return []
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if total_frames <= 0:
            return []
        # Pick evenly-spaced sample indices (skip first/last 5% — common
        # to have a black opener or trailing logo).
        lo = int(total_frames * 0.05)
        hi = int(total_frames * 0.95)
        if hi <= lo:
            lo, hi = 0, total_frames - 1
        if num_samples <= 1:
            sample_idx = [(lo + hi) // 2]
        else:
            step = (hi - lo) / (num_samples - 1)
            sample_idx = [int(lo + step * i) for i in range(num_samples)]

        mp_face_det = mp.solutions.face_detection
        det = mp_face_det.FaceDetection(model_selection=1, min_detection_confidence=0.5)
        regions: List[Tuple[float, float, float, float]] = []
        try:
            for idx in sample_idx:
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    continue
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                h, w = rgb.shape[:2]
                if w <= 0 or h <= 0:
                    continue
                res = det.process(rgb)
                if not res.detections:
                    continue
                for d in res.detections:
                    bb = d.location_data.relative_bounding_box
                    # mediapipe returns x, y, width, height all 0..1.
                    # Pad 12% on each side to give text some breathing room.
                    pad_x = bb.width * 0.12
                    pad_y = bb.height * 0.12
                    x0 = max(0.0, bb.xmin - pad_x)
                    y0 = max(0.0, bb.ymin - pad_y)
                    x1 = min(1.0, bb.xmin + bb.width + pad_x)
                    y1 = min(1.0, bb.ymin + bb.height + pad_y)
                    if x1 > x0 and y1 > y0:
                        regions.append((x0, y0, x1, y1))
        finally:
            try:
                det.close()
            except Exception:
                pass
        return _merge_overlapping_regions(regions)
    finally:
        cap.release()


def _merge_overlapping_regions(
    regions: List[Tuple[float, float, float, float]],
) -> List[Tuple[float, float, float, float]]:
    """Greedy union of overlapping rectangles. Cuts down the noisy list
    of per-frame face boxes into a couple of dominant zones."""
    if not regions:
        return []
    merged: List[List[float]] = [list(r) for r in regions]
    changed = True
    while changed:
        changed = False
        for i in range(len(merged)):
            for j in range(i + 1, len(merged)):
                a, b = merged[i], merged[j]
                if (a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]):
                    a[0] = min(a[0], b[0])
                    a[1] = min(a[1], b[1])
                    a[2] = max(a[2], b[2])
                    a[3] = max(a[3], b[3])
                    merged.pop(j)
                    changed = True
                    break
            if changed:
                break
    return [tuple(m) for m in merged]


def _bbox_overlaps(
    a: Tuple[float, float, float, float],
    b: Tuple[float, float, float, float],
    min_overlap_frac: float = 0.05,
) -> bool:
    """True if rectangles a and b overlap with at least `min_overlap_frac`
    of the smaller rect's area inside the other."""
    ix0 = max(a[0], b[0]); iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2]); iy1 = min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return False
    inter = (ix1 - ix0) * (iy1 - iy0)
    a_area = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    b_area = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
    smaller = min(a_area, b_area)
    return (inter / smaller) >= min_overlap_frac


def _safe_position(
    desired: str,
    face_regions: List[Tuple[float, float, float, float]],
) -> str:
    """Return the desired position if it doesn't overlap any face,
    otherwise the first POSITION_FALLBACKS entry that's safe. If every
    position overlaps something (unlikely), return desired unchanged."""
    if not face_regions:
        return desired
    desired_box = POSITION_BBOX.get(desired) or POSITION_BBOX["center"]
    if not any(_bbox_overlaps(desired_box, fr) for fr in face_regions):
        return desired
    for cand in POSITION_FALLBACKS:
        if cand == desired:
            continue
        cand_box = POSITION_BBOX[cand]
        if not any(_bbox_overlaps(cand_box, fr) for fr in face_regions):
            return cand
    return desired


# --------------------------------------------------------------------------
# helpers (continued)
# --------------------------------------------------------------------------

def _hex_to_ffmpeg_color(hex_color: str, alpha: float = 1.0) -> str:
    """Convert #RRGGBB to ffmpeg's 0xRRGGBB@alpha format."""
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    return f"0x{h.upper()}@{alpha:.2f}"


def _escape_ffmpeg_text(s: str) -> str:
    """Escape text for FFmpeg drawtext. The order matters — backslashes
    first, then the special characters drawtext treats specially."""
    if not s:
        return ""
    # FFmpeg drawtext text needs colons, single quotes, percent, and
    # backslash escaped. We wrap the value in single quotes when used
    # in the filter string so single-quote escaping is the messy bit.
    return (
        s.replace("\\", "\\\\")
         .replace(":", r"\:")
         .replace("'", r"\\'")
         .replace("%", r"\%")
         .replace(",", r"\,")
    )


# --------------------------------------------------------------------------
# LLM PROMPT — planner
# --------------------------------------------------------------------------

def _describe_face_regions(
    face_regions: List[Tuple[float, float, float, float]],
) -> str:
    """Human-readable summary of where the faces sit, for the prompt."""
    if not face_regions:
        return ""
    descs = []
    for (x0, y0, x1, y1) in face_regions:
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        # Map to "top/middle/bottom" + "left/center/right" zones.
        if cy < 0.33:
            row = "top"
        elif cy < 0.67:
            row = "middle"
        else:
            row = "bottom"
        if cx < 0.33:
            col = "left"
        elif cx < 0.67:
            col = "center"
        else:
            col = "right"
        descs.append(f"{row}-{col}")
    blocked: List[str] = []
    # Translate face zones into AVOID list of POSITION names.
    for pos, box in POSITION_BBOX.items():
        if any(_bbox_overlaps(box, fr) for fr in face_regions):
            blocked.append(pos)
    safe = [p for p in POSITION_BBOX.keys() if p not in blocked]
    return (
        f"Detected face regions in the clip: {', '.join(descs)}.\n"
        f"AVOID these positions (a face is there): {', '.join(blocked) or 'none'}.\n"
        f"PREFER these positions (clear of faces): {', '.join(safe) or 'top-center, bottom-center'}.\n"
    )


def _build_motion_graphics_prompt(
    clip_text: str,
    duration: float,
    aspect: str,
    style_hint: str = "",
    face_summary: str = "",
    transcript: str = "",
) -> str:
    """The system+user prompt the LLM sees. Asks for a structured JSON
    plan of overlay + motion events.

    If `transcript` is provided, it gets a HEADLINE section at the top
    of the prompt and the LLM is instructed to anchor every event to a
    specific moment in it. With transcript present we get dramatically
    better timing + content selection than from clip metadata alone.
    """
    # Build the "what content to anchor to" block. When we have a real
    # transcript with timings the AI can pin events to specific spoken
    # words; without it we fall back to the clip's hook/description.
    if transcript and transcript.strip():
        content_section = (
            f"FULL TRANSCRIPT of the clip (timestamps in seconds, relative "
            f"to clip start). USE THIS as your primary source of truth — "
            f"each event you propose MUST be anchored to a specific moment "
            f"or phrase in this transcript:\n"
            f"---\n{transcript.strip()}\n---\n\n"
            f"Clip metadata (hook + description, for tone reference only):\n"
            f"---\n{clip_text}\n---\n\n"
        )
    else:
        content_section = (
            f"Clip metadata (NO transcript was provided — you'll have to "
            f"infer pacing from these descriptors):\n"
            f"---\n{clip_text}\n---\n\n"
        )

    return (
        f"You are a senior short-form video editor specialising in viral "
        f"TikTok / Reels / YouTube Shorts content. You're given a clip's "
        f"transcript and metadata. Your job: design 5-10 motion + overlay "
        f"events with matching sound effects that make this clip POP — "
        f"emphasising reveals, punchlines, and key facts — WITHOUT going "
        f"chaotic.\n\n"
        f"Clip duration: {duration:.1f} seconds.\n"
        f"Output aspect: {aspect}.\n"
        f"Style hint: {style_hint or 'punchy MrBeast / Iman Gadzhi style; zoom punches on punchlines; callouts for stats; emoji bursts on reactions; tasteful color pops on key moments'}.\n\n"
        + (f"FACE PLACEMENT CONSTRAINT (HARD RULE):\n{face_summary}\n"
           f"NEVER place a TEXT/CALLOUT overlay over a speaker's face. "
           f"Zoom/glitch/color effects are full-frame and DON'T care about "
           f"face position — those are fine anywhere.\n\n" if face_summary else "")
        + content_section
        + f"EVENT TYPES — mix and match for variety:\n\n"
        f"  OVERLAY TYPES (text/emoji on top of video — need position):\n"
        f"    • text_burst      — large bold text that pops in (\"WAIT\", \"NO WAY\", \"BOOM\")\n"
        f"    • callout_box     — text inside colored box (stats/facts: \"50% fatality\", \"$25M\")\n"
        f"    • emoji_burst     — one big emoji centered (🤯, 💥, 😱, ⚠️, ✅, 🔥)\n"
        f"    • highlight_strip — thin colored bar with text across the screen\n\n"
        f"  MOTION TYPES (affect the WHOLE video frame — no position/content needed):\n"
        f"    • zoom_punch      — fast in-and-out zoom (1.0→1.18→1.0) for emphasis on punchlines and reveals\n"
        f"    • glitch          — RGB chromatic-aberration glitch for shock / surprise moments (0.3-0.6s only)\n"
        f"    • color_pop       — saturation + contrast boost for the most impactful 1-2s segments\n\n"
        f"POSITION OPTIONS (overlay types only): center, top-center, top-left, "
        f"top-right, bottom-center, bottom-left, bottom-right, left, right.\n\n"
        f"COLORS (overlay types only): pick from this palette: "
        f"#FFD700 (gold), #FF4444 (red), #44CC88 (green), #44AAFF (blue), "
        f"#FF44AA (pink), #FFFFFF (white). Gold = emphasis, red = danger/loss, "
        f"green = win/profit, white = neutral.\n\n"
        f"SFX: pop (subtle click), whoosh (zoom-in), impact (big boom), "
        f"ding (reveal/realisation), riser (build-up), reverse_whoosh "
        f"(zoom-out). Pair zoom_punch with whoosh, glitch with impact, "
        f"text_burst with impact/ding, emoji_burst with pop/ding.\n\n"
        f"RULES:\n"
        f"  1. Anchor EVERY event to a specific moment in the transcript "
        f"(if provided). Cite the words it lands on in your timing.\n"
        f"  2. Mix overlay and motion types — at least 1-2 of each per clip. "
        f"A clip with only text overlays feels flat; one with only zooms "
        f"feels gimmicky.\n"
        f"  3. zoom_punch is for PUNCHLINES and SURPRISES — not random.\n"
        f"  4. glitch is for SHOCK only — 1, maybe 2 per clip, max 0.6s each.\n"
        f"  5. color_pop is for the SINGLE most impactful 1-2s segment — "
        f"highlights it like a director's cut. Max 2 per clip.\n"
        f"  6. Don't stack motion effects on top of each other (no glitch "
        f"during zoom_punch).\n"
        f"  7. Each event duration 0.3-2.5s (motion types short, overlays longer).\n"
        f"  8. Don't extend past the clip duration ({duration:.1f}s).\n"
        f"  9. Content text must be SHORT — text_burst ≤4 words, callout_box "
        f"≤8 words, emoji_burst exactly 1 emoji.\n"
        f" 10. Motion types (zoom_punch / glitch / color_pop) MUST omit "
        f"position, content, color — leave those fields out or set to null.\n\n"
        f"Return ONLY JSON, no markdown:\n"
        f"{{\n"
        f'  "events": [\n'
        f'    {{"start": 1.5, "duration": 1.0, "type": "text_burst", '
        f'"content": "WAIT WHAT", "position": "center", "color": "#FFD700", "sfx": "impact"}},\n'
        f'    {{"start": 3.8, "duration": 0.5, "type": "zoom_punch", "sfx": "whoosh"}},\n'
        f'    {{"start": 4.2, "duration": 1.8, "type": "callout_box", '
        f'"content": "50% fatality rate", "position": "top-right", "color": "#FF4444", "sfx": "ding"}},\n'
        f'    {{"start": 7.1, "duration": 0.4, "type": "glitch", "sfx": "impact"}},\n'
        f'    {{"start": 9.0, "duration": 1.5, "type": "color_pop", "sfx": null}}\n'
        f"  ]\n"
        f"}}\n"
    )


# ---------- Ollama auto-fallback helpers ------------------------------
# When Gemini exhausts its daily 20-request free-tier quota (or is
# overloaded for too long), the AI Magic Overlays feature would just
# fail until midnight. Since Klipra already supports Ollama as a
# first-class provider, we can route the same overlay-plan prompt to
# a local Ollama daemon and keep the feature working at zero cost.
#
# These helpers are intentionally cheap: a 2-second HTTP probe for
# /api/tags decides whether to try the fallback at all. If Ollama isn't
# installed or isn't running, we skip silently and surface the
# original Gemini error to the user.

OLLAMA_FALLBACK_URL = "http://host.docker.internal:11434"

# Preference order — first one that's actually installed wins. JSON
# adherence matters a lot here because the rest of the pipeline parses
# the response. Qwen 2.5 / Qwen 3 and Llama 3.x both behave well with
# Ollama's `format: "json"` mode. Quality-first ordering (qwen3 / qwen2.5
# >> llama3.x >> mistral/gemma) since the prefix-match catches any tag
# variant the user actually has installed.
OLLAMA_FALLBACK_PREFERRED = (
    "qwen3", "qwen3:latest",                  # newest qwen — strongest at structured output
    "qwen2.5", "qwen2.5:latest",              # great JSON + creative copy, sweet spot
    "llama3.3", "llama3.3:latest",
    "llama3.2", "llama3.2:latest",
    "llama3.1", "llama3.1:latest",
    "mistral", "mistral:latest",
    "gemma2", "gemma2:latest",
)


def _pick_ollama_fallback_model() -> Optional[str]:
    """Hit Ollama's /api/tags and return the first installed model
    that matches our preference list, or any installed model as a
    last resort. Returns None if Ollama isn't reachable or has no
    models installed.
    """
    try:
        import httpx
        r = httpx.get(f"{OLLAMA_FALLBACK_URL}/api/tags", timeout=2.0)
        r.raise_for_status()
        installed = [
            m.get("name") for m in (r.json().get("models") or [])
            if m.get("name")
        ]
    except Exception as e:
        print(f"⚠️  Ollama fallback probe failed: {e}")
        return None
    if not installed:
        return None
    installed_set = set(installed)
    # Exact preference-list match first (handles `llama3.2` and
    # `llama3.2:latest` separately).
    for name in OLLAMA_FALLBACK_PREFERRED:
        if name in installed_set:
            return name
    # Otherwise, prefix match — handles user-pulled variants like
    # `llama3.2:1b`, `qwen2.5:7b-instruct-q4_K_M`, etc.
    for pref in OLLAMA_FALLBACK_PREFERRED:
        base = pref.split(":")[0]
        for got in installed:
            if got.startswith(base + ":") or got == base:
                return got
    # Last resort: anything installed.
    return installed[0]


def _try_ollama_fallback(prompt: str) -> Optional[List[Dict[str, Any]]]:
    """Send the same motion-graphics prompt to Ollama and return the
    parsed events list. Returns None on any failure (caller will then
    surface the original Gemini error to the user).
    """
    model = _pick_ollama_fallback_model()
    if not model:
        print("⚠️  Ollama fallback skipped — no installed models / daemon not reachable.")
        return None
    print(f"🔄 Gemini failed — trying Ollama fallback with model: {model}")
    try:
        from llm import build_provider
        provider = build_provider(
            provider_id="ollama",
            model=model,
            api_key="",
            base_url=OLLAMA_FALLBACK_URL,
        )
        raw = provider.complete_json(
            system="You are a JSON-only response generator. Never include markdown or commentary.",
            user=prompt,
            max_tokens=2000,
        )
    except Exception as e:
        print(f"⚠️  Ollama fallback call failed: {e}")
        return None
    # Match the same response-shape handling the main path uses.
    if isinstance(raw, dict):
        events = raw.get("events", [])
        if not events:
            for v in raw.values():
                if isinstance(v, list):
                    events = v
                    break
    elif isinstance(raw, list):
        events = raw
    else:
        return None
    return events if events else None


def generate_motion_graphics_plan(
    *,
    clip_text: str,
    duration: float,
    aspect: str,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url: Optional[str] = None,
    style_hint: str = "",
    input_video_path: Optional[str] = None,
    transcript: str = "",
) -> Dict[str, Any]:
    """Ask the LLM for an overlay plan. Returns a dict with key 'events'
    (list) on success, or {'events': [], 'error': '...'} on failure.
    Never raises — caller decides what to do with empty plans.

    If `input_video_path` is given we sample frames for face detection
    and constrain the LLM's overlay positions away from speaker faces.
    """
    from llm import build_provider, LLMError
    face_regions: List[Tuple[float, float, float, float]] = []
    face_summary = ""
    if input_video_path and os.path.isfile(input_video_path):
        try:
            face_regions = detect_face_regions(input_video_path, num_samples=10)
            face_summary = _describe_face_regions(face_regions)
        except Exception as fe:
            print(f"⚠️  Face detection skipped: {fe}")
    prompt = _build_motion_graphics_prompt(
        clip_text, duration, aspect, style_hint, face_summary, transcript,
    )
    try:
        # NOTE: factory.py's build_provider() uses kwarg name `model`,
        # not `model_name`. Same for the LLMProvider base class. The
        # complete_json() method's kwargs are (system, user, max_tokens)
        # — temperature and max_output_tokens are NOT in the base
        # signature and only some subclasses accept them, so we stick
        # to the portable arguments here.
        provider = build_provider(
            provider_id=provider_id,
            model=model_name,
            api_key=api_key,
            base_url=base_url,
        )
        # Retry transient Gemini/Ollama errors (503 overload, 429 rate
        # limit, 502 bad gateway, network timeouts) with exponential
        # backoff so a brief upstream hiccup doesn't kill the whole
        # request. Daily-quota errors are NOT retried — they'll just
        # waste time and money. Caller still gets the final exception
        # in `error` if all attempts fail.
        import time as _time
        TRANSIENT_MARKERS = (
            "503", "UNAVAILABLE", "overload", "high demand",
            "429", "RESOURCE_EXHAUSTED", "rate limit", "rate-limit",
            "502", "BAD_GATEWAY", "504", "DEADLINE_EXCEEDED",
            "timeout", "ECONNRESET", "temporarily unavailable",
        )
        DAILY_QUOTA_MARKERS = ("PerDayPerProject", "PerDay")
        last_err: Optional[Exception] = None
        raw = None
        for attempt in range(1, 4):  # 3 total attempts
            try:
                raw = provider.complete_json(
                    system="You are a JSON-only response generator. Never include markdown or commentary.",
                    user=prompt,
                    max_tokens=2000,
                )
                break  # success
            except Exception as inner_e:
                last_err = inner_e
                msg = str(inner_e)
                is_daily = any(m in msg for m in DAILY_QUOTA_MARKERS)
                is_transient = any(m.lower() in msg.lower() for m in TRANSIENT_MARKERS)
                if is_daily or not is_transient or attempt >= 3:
                    raise
                # Exponential backoff: 2s, 5s. Total max wait ~7s before
                # the third (last) attempt, so the UI doesn't hang for
                # ages on a hard-down upstream.
                wait_s = 2.0 if attempt == 1 else 5.0
                print(f"⏳ Motion-graphics LLM hit transient error (attempt {attempt}/3): "
                      f"{msg[:120]}... — retrying in {wait_s:.0f}s")
                _time.sleep(wait_s)
        if raw is None:
            # Loop exited without break and without raising — shouldn't
            # happen, but be safe.
            raise last_err or RuntimeError("Motion-graphics retry loop exhausted")
    except (LLMError, Exception) as e:
        # If Gemini blew up (daily quota, overload, rate-limit), try
        # Ollama as an automatic free fallback before giving up. The
        # user's MacBook runs Ollama on host.docker.internal:11434.
        # This is what keeps "AI Magic Overlays" working through the
        # Gemini quota outage. Only attempt the fallback if we were
        # ON Gemini (don't loop forever if Ollama itself failed).
        raw_msg = str(e)
        low = raw_msg.lower()
        if (provider_id or "").lower() == "gemini":
            fb = _try_ollama_fallback(prompt)
            if fb is not None:
                # Success — return the Ollama plan with a note that
                # we fell back, so the frontend can surface a small
                # hint if it wants to.
                print(f"✅ Motion-graphics Ollama fallback succeeded (Gemini failed: {raw_msg[:80]})")
                return {
                    "events": _normalize_events(fb, duration, face_regions=face_regions),
                    "face_regions": face_regions,
                    "raw": f"[Ollama fallback used — Gemini failed: {raw_msg[:120]}]",
                    "fallback": "ollama",
                }
        # Translate common upstream errors into messages a non-technical
        # user can act on. Falls back to the raw error string for
        # anything we don't recognise.
        friendly = None
        if "503" in raw_msg or "unavailable" in low or "high demand" in low or "overload" in low:
            friendly = (
                "Gemini is overloaded and Ollama fallback isn't reachable. "
                "Start Ollama (Applications → Ollama), then click 'Try again'. "
                "Or wait a few minutes for Gemini to recover."
            )
        elif "PerDayPerProject" in raw_msg or "PerDay" in raw_msg:
            friendly = (
                "Gemini's daily free-tier quota is used up (20 requests/project/day), "
                "and Ollama fallback isn't reachable. Open the Ollama app on your Mac "
                "(or run `ollama serve`), then click 'Try again'. "
                "Quota resets at midnight Pacific time."
            )
        elif "429" in raw_msg or "RESOURCE_EXHAUSTED" in raw_msg or "rate limit" in low:
            friendly = (
                "Gemini rate-limited the request and Ollama fallback isn't reachable. "
                "Start Ollama, or wait ~1 minute and click 'Try again'."
            )
        elif "401" in raw_msg or "invalid api key" in low or "API_KEY_INVALID" in raw_msg:
            friendly = (
                "Your Gemini API key was rejected. Open Settings, paste a valid key, and try again."
            )
        return {"events": [], "error": friendly or raw_msg}

    # complete_json() already returns parsed JSON (dict / list) — the
    # base class strips fences and json.loads()es internally. We just
    # need to pull the events list out of whatever shape came back.
    if isinstance(raw, dict):
        events = raw.get("events", [])
        # Some providers might wrap the array in another key like
        # "plan" or "result"; fall back to the first list-valued field.
        if not events:
            for v in raw.values():
                if isinstance(v, list):
                    events = v
                    break
    elif isinstance(raw, list):
        events = raw
    else:
        return {"events": [], "error": f"Unexpected response type: {type(raw).__name__}"}

    return {
        "events": _normalize_events(events, duration, face_regions=face_regions),
        "face_regions": face_regions,
        "raw": str(raw)[:600],
    }


def _normalize_events(
    events: List[Dict[str, Any]],
    duration: float,
    face_regions: Optional[List[Tuple[float, float, float, float]]] = None,
) -> List[Dict[str, Any]]:
    """Clamp + sanitize each event so the renderer never gets bad
    input. Drops events that are completely unsalvageable. If
    `face_regions` are provided, snap any event whose chosen position
    overlaps a face to the nearest safe alternate slot.

    Two families of events:
    - OVERLAY types (text_burst, callout_box, emoji_burst, highlight_strip):
      require content + position + color (rendered as drawtext)
    - MOTION types (zoom_punch, glitch, color_pop): full-frame effects,
      content/position/color are ignored (LLM is told to omit them)
    """
    face_regions = face_regions or []
    out = []
    overlay_types = {"text_burst", "callout_box", "emoji_burst", "highlight_strip"}
    motion_types = {"zoom_punch", "glitch", "color_pop"}
    valid_types = overlay_types | motion_types
    valid_positions = set(POSITION_MAP.keys())
    valid_sfx = {"pop", "whoosh", "impact", "ding", "riser", "reverse_whoosh"}
    # Sane upper bounds per motion type so a confused LLM proposing a
    # 10s glitch doesn't make the whole clip unwatchable.
    motion_dur_caps = {"zoom_punch": 1.2, "glitch": 0.6, "color_pop": 2.5}
    for e in events or []:
        if not isinstance(e, dict):
            continue
        try:
            start = float(e.get("start", 0))
            dur = float(e.get("duration", 1.0))
        except (TypeError, ValueError):
            continue
        if dur <= 0 or start < 0 or start >= duration:
            continue
        if start + dur > duration:
            dur = duration - start
        etype = str(e.get("type", "text_burst"))
        if etype not in valid_types:
            etype = "text_burst"

        sfx = e.get("sfx")
        if sfx and sfx not in valid_sfx:
            sfx = None

        # MOTION events — no content/position/color/face-avoid. Just
        # clamp duration so they don't take over the clip.
        if etype in motion_types:
            cap = motion_dur_caps.get(etype, 2.0)
            if dur > cap:
                dur = cap
            out.append({
                "start": round(max(0.0, start), 2),
                "duration": round(dur, 2),
                "type": etype,
                "content": "",      # not used by renderer for motion types
                "position": "center",  # not used
                "color": "",          # not used
                "sfx": sfx,
            })
            continue

        # OVERLAY events — need position + content + color.
        pos = str(e.get("position", "center"))
        if pos not in valid_positions:
            pos = "center"
        # Snap away from speakers' faces. Cheap belt-and-braces on top
        # of the face-aware prompt — even if the LLM ignores the
        # avoid-list, we won't actually render text over a face.
        pos = _safe_position(pos, face_regions)
        color = str(e.get("color", "#FFD700"))
        if not color.startswith("#") or len(color) != 7:
            color = "#FFD700"
        content = str(e.get("content", "")).strip()
        if not content:
            continue
        # Truncate content per type — long text breaks drawtext layout.
        max_len = {
            "text_burst": 30,
            "callout_box": 70,
            "emoji_burst": 4,
            "highlight_strip": 70,
        }.get(etype, 50)
        if len(content) > max_len:
            content = content[:max_len].rstrip()
        out.append({
            "start": round(max(0.0, start), 2),
            "duration": round(dur, 2),
            "type": etype,
            "content": content,
            "position": pos,
            "color": color,
            "sfx": sfx,
        })
    out.sort(key=lambda x: x["start"])
    return out


# --------------------------------------------------------------------------
# RENDERER
# --------------------------------------------------------------------------

# ---------- Motion-effect filter helpers (full-frame video filters) -----
#
# These three event types affect the whole frame, not just text overlays.
# They MUST be applied to the video stream BEFORE drawtext overlays so the
# overlays render on top of the modified frame (otherwise zoom would zoom
# the text along with the frame, and color_pop would tint the text too).
#
# Each function returns an ffmpeg filter expression that runs continuously
# for the WHOLE clip but is gated by an `enable` clause (or wrapped in a
# t-conditional expression) so it only "fires" during [start, end].


def _motion_zoom_punch_filter(start: float, end: float) -> str:
    """Quick zoom in (1.0 → 1.18× → 1.0) over the region with sin² ease.

    Borrowed from timeline_effects.py's well-tested zoom_punch. Uses
    `crop` + `scale` with `eval=frame` so the zoom factor can vary
    per-frame (default eval=init crashes when expressions reference t).
    setsar=1 normalises the pixel aspect ratio after the rescale.
    """
    duration = max(0.001, end - start)
    inside = f"between(t\\,{start:.3f}\\,{end:.3f})"
    p = f"((t-{start:.3f})/{duration:.3f})"
    zexpr = f"(1+0.18*sin(PI*{p})*sin(PI*{p})*{inside})"
    return (
        f"crop=w=iw/{zexpr}:h=ih/{zexpr}:x=(iw-iw/{zexpr})/2:y=(ih-ih/{zexpr})/2:eval=frame,"
        f"scale=w='trunc(iw*{zexpr}/2)*2':h='trunc(ih*{zexpr}/2)*2':eval=frame,"
        f"setsar=1"
    )


def _motion_glitch_filter(start: float, end: float) -> str:
    """RGB chromatic-aberration glitch pulse — channels offset horizontally
    for a few hundred ms, mimicking a VHS / digital-corruption look.
    rgbashift offsets each channel by an integer number of pixels; we
    enable it only inside [start, end] so it appears as a quick burst.
    """
    return (
        f"rgbashift=rh=8:rv=-2:bh=-8:bv=2:"
        f"enable='between(t,{start:.3f},{end:.3f})'"
    )


def _motion_color_pop_filter(start: float, end: float) -> str:
    """Saturation + contrast boost for the most impactful moment(s).
    Lifts the colors on the highlight without overprocessing the rest
    of the clip.
    """
    return (
        f"eq=saturation=1.45:contrast=1.18:gamma=0.95:"
        f"enable='between(t,{start:.3f},{end:.3f})'"
    )


# Type → filter-builder lookup. Returns None if the type isn't a motion
# event (caller treats it as a regular overlay).
MOTION_FILTER_BUILDERS = {
    "zoom_punch": _motion_zoom_punch_filter,
    "glitch":     _motion_glitch_filter,
    "color_pop":  _motion_color_pop_filter,
}


def _build_drawtext_filter(
    event: Dict[str, Any],
    *,
    short_edge_px: int,
    fontfile: Optional[str],
) -> str:
    """Build the drawtext (or drawbox+drawtext) filter snippet for ONE
    overlay event."""
    etype = event["type"]
    text = _escape_ffmpeg_text(event["content"])
    color = _hex_to_ffmpeg_color(event["color"], 1.0)
    pos = event["position"]
    x_expr, y_expr = POSITION_MAP.get(pos, POSITION_MAP["center"])

    start = event["start"]
    end = start + event["duration"]
    enable = f"between(t,{start},{end})"

    # Aspect-aware font size — fraction of the shorter edge.
    font_frac = DEFAULT_FONT_FRAC.get(etype, 0.06)
    fontsize = max(18, int(short_edge_px * font_frac))

    # Smooth fade-in/out — 200ms each side.
    fade_in_end = start + 0.2
    fade_out_start = max(start, end - 0.2)
    alpha_expr = (
        f"if(lt(t,{fade_in_end}),"
        f"(t-{start})/0.2,"
        f"if(gt(t,{fade_out_start}),"
        f"max(0,({end}-t)/0.2),1))"
    )

    fontfile_arg = f"fontfile='{fontfile}':" if fontfile else ""

    if etype == "text_burst":
        # Large bold text with a thick black border + drop shadow.
        return (
            f"drawtext={fontfile_arg}"
            f"text='{text}':"
            f"fontsize={fontsize}:"
            f"fontcolor={color}:"
            f"borderw=4:bordercolor=0x000000@0.9:"
            f"shadowx=3:shadowy=4:shadowcolor=0x000000@0.6:"
            f"x={x_expr}:y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"enable='{enable}'"
        )
    elif etype == "callout_box":
        # Use drawtext's BUILT-IN box (box=1 + boxcolor + boxborderw)
        # instead of a separate drawbox filter. The standalone drawbox
        # filter doesn't have access to tw/th (text width/height) —
        # only drawtext does — so the previous version of this code
        # produced "Undefined constant" errors at render time. With
        # the built-in box, ffmpeg auto-sizes the rectangle around the
        # text, no manual width math required.
        bg_color = _hex_to_ffmpeg_color(event["color"], 0.85)
        text_color = "0xFFFFFF@1.0"
        # boxborderw is the padding (in px) between text edge and box
        # edge. Scales with fontsize so the box doesn't look cramped
        # at large sizes or wasteful at small sizes.
        box_pad = max(8, int(fontsize * 0.25))
        return (
            f"drawtext={fontfile_arg}"
            f"text='{text}':"
            f"fontsize={fontsize}:"
            f"fontcolor={text_color}:"
            f"box=1:boxcolor={bg_color}:boxborderw={box_pad}:"
            f"borderw=2:bordercolor=0x000000@0.6:"
            f"x={x_expr}:y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"enable='{enable}'"
        )
    elif etype == "emoji_burst":
        # Just a giant emoji with subtle scale animation via fontsize
        # interpolation isn't easy in drawtext, so a fade pulse looks fine.
        return (
            f"drawtext={fontfile_arg}"
            f"text='{text}':"
            f"fontsize={fontsize}:"
            f"fontcolor=0xFFFFFF@1.0:"
            f"shadowx=2:shadowy=3:shadowcolor=0x000000@0.5:"
            f"x={x_expr}:y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"enable='{enable}'"
        )
    else:  # highlight_strip
        # Same fix as callout_box — use drawtext's built-in box so we
        # don't need to know tw/th outside of drawtext. We force the
        # text to (W-tw)/2 (already inside drawtext, so tw is fine
        # here) and let the auto-box wrap it. To get the "strip
        # across the screen" feel even when the text is short, we
        # add a wide horizontal padding via boxborderw on the X axis.
        # ffmpeg's boxborderw uniformly pads all sides — close enough.
        bar_color = _hex_to_ffmpeg_color(event["color"], 0.75)
        # Vertical pad ~ 8-10 px; horizontal will be the same (uniform
        # boxborderw). That gives a chunky strip without odd spacing.
        bar_pad = max(10, int(fontsize * 0.30))
        return (
            f"drawtext={fontfile_arg}"
            f"text='{text}':"
            f"fontsize={fontsize}:"
            f"fontcolor=0xFFFFFF@1.0:"
            f"box=1:boxcolor={bar_color}:boxborderw={bar_pad}:"
            f"borderw=1:bordercolor=0x000000@0.5:"
            f"x='(W-tw)/2':y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"enable='{enable}'"
        )


def _detect_short_edge(input_path: str) -> int:
    """Return min(width, height) for the input video. Used to scale
    fonts so they look the right size on any aspect."""
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0",
                input_path,
            ],
            capture_output=True, text=True, check=True, timeout=15,
        )
        w_str, h_str = proc.stdout.strip().split(",")
        return min(int(w_str), int(h_str))
    except Exception:
        return 720


def _find_emoji_font() -> Optional[str]:
    """Best-effort font lookup for ffmpeg's `drawtext` filter.

    CRITICAL: ffmpeg's drawtext can ONLY load OUTLINE (TrueType vector)
    fonts. It cannot rasterise CBDT/CBLC bitmap fonts like
    `NotoColorEmoji.ttf` — feeding it one produces the error the user
    saw: `Monocromatic (1bpp) fonts are not supported`. Pillow's
    rendering (used by hooks.py for the viral-hook overlay) IS able to
    load those bitmap glyphs via `embedded_color=True`, but drawtext is
    a different code path with different constraints, so we keep the
    two font lookups separate.

    Symbola IS a valid outline emoji font — monochrome but covers most
    Unicode emoji codepoints. We prefer it for emoji_burst overlays
    when installed. Falls back to DejaVu Sans Bold for plain text.
    """
    candidates = [
        # Outline emoji font — covers most Unicode emoji as B&W glyphs.
        # We installed `fonts-symbola` in the Dockerfile alongside Noto
        # Color Emoji for exactly this reason.
        "/usr/share/fonts/truetype/symbola/Symbola.ttf",
        "/usr/share/fonts/truetype/symbola/Symbola_hint.ttf",
        "/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf",
        # Plain-text fallback — outline, scalable, no emoji.
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        # NotoColorEmoji is DELIBERATELY NOT in this list. It's a
        # bitmap font; drawtext rejects it. Don't add it back without
        # also switching this code path to overlay pre-rendered PNGs
        # via the `overlay` filter instead of drawtext.
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def render_clip_with_motion_graphics(
    *,
    input_path: str,
    output_path: str,
    events: List[Dict[str, Any]],
    sfx_volume: float = 0.5,
) -> None:
    """Bake the events into a new mp4. Combines drawtext/drawbox visual
    overlays with synthesised SFX from the existing editor.py library.

    Raises RuntimeError on ffmpeg failure (stderr in the message).
    """
    if not os.path.isfile(input_path):
        raise FileNotFoundError(input_path)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    short_edge = _detect_short_edge(input_path)
    fontfile = _find_emoji_font()

    # Build the video filter chain. Split into MOTION (full-frame effects
    # like zoom_punch / glitch / color_pop) and OVERLAY (drawtext) events.
    # Motion filters MUST run BEFORE drawtext so the text overlays are
    # rendered on top of the modified frame — otherwise a zoom_punch
    # would zoom the text along with the frame, which looks broken.
    motion_filters: List[str] = []
    overlay_filters: List[str] = []
    for ev in events:
        try:
            etype = ev.get("type", "")
            motion_builder = MOTION_FILTER_BUILDERS.get(etype)
            if motion_builder:
                motion_filters.append(motion_builder(
                    float(ev["start"]),
                    float(ev["start"]) + float(ev["duration"]),
                ))
            else:
                overlay_filters.append(_build_drawtext_filter(
                    ev, short_edge_px=short_edge, fontfile=fontfile,
                ))
        except Exception as e:
            # Skip a malformed event rather than fail the whole render.
            print(f"⚠️  Motion graphics: skipping bad event ({etype}): {e}")
    all_filters = motion_filters + overlay_filters
    vf = ",".join(all_filters) if all_filters else "null"

    # Build SFX inputs and the audio filter graph.
    # Each SFX gets an aevalsrc/anoisesrc input via -f lavfi -i ...,
    # then we delay it to its event start and mix all of them with the
    # original audio.
    from editor import VideoEditor  # reuse the SFX_LIBRARY definition
    sfx_lib = VideoEditor.SFX_LIBRARY

    sfx_events = [(i, ev) for i, ev in enumerate(events) if ev.get("sfx")]

    # ffmpeg cmd assembly
    cmd: List[str] = ["ffmpeg", "-loglevel", "error", "-i", input_path]
    audio_filter_parts = ["[0:a]volume=1.0[a0]"]
    sfx_count = 0

    for sfx_idx, (orig_i, ev) in enumerate(sfx_events):
        sfx_name = ev["sfx"]
        sfx_def = sfx_lib.get(sfx_name)
        if not sfx_def:
            continue
        dur_s = sfx_def["duration_s"]
        gain = sfx_def["default_gain"] * sfx_volume
        source_expr = sfx_def["source_expr"].format(dur=dur_s)
        cmd.extend(["-f", "lavfi", "-i", source_expr])
        # Delay the synthesised SFX to the event start.
        delay_ms = int(ev["start"] * 1000)
        # Channel layout: most of these are mono; convert to stereo and
        # delay both channels.
        sfx_count += 1
        sfx_idx_in_cmd = sfx_count  # input index 1..N
        audio_filter_parts.append(
            f"[{sfx_idx_in_cmd}:a]volume={gain:.2f},"
            f"adelay={delay_ms}|{delay_ms},aformat=channel_layouts=stereo[s{sfx_idx}]"
        )

    if sfx_count > 0:
        mix_inputs = "[a0]" + "".join(f"[s{i}]" for i in range(sfx_count))
        audio_filter_parts.append(
            f"{mix_inputs}amix=inputs={sfx_count + 1}:duration=first:dropout_transition=2,"
            f"aresample=44100[aout]"
        )
        a_filter = ";".join(audio_filter_parts)
        amap = "[aout]"
    else:
        # No SFX events — just pass the original audio through.
        a_filter = "[0:a]anull[aout]"
        amap = "[aout]"

    # Combine video + audio filter graphs.
    full_filter = f"[0:v]{vf}[vout];{a_filter}"
    cmd.extend([
        "-filter_complex", full_filter,
        "-map", "[vout]",
        "-map", amap,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "21",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        "-y",
        output_path,
    ])

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if proc.returncode != 0 or not os.path.isfile(output_path):
        # Stderr tail is usually enough to diagnose.
        raise RuntimeError(
            f"Motion graphics render failed: {proc.stderr[-1500:]}"
        )
