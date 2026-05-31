"""Smart Clipper Pro — staged 5-pass viral-moment picker.

Why this exists: the single-call multimodal picker
(`multimodal_picker.find_viral_moments_multimodal`) collapses everything
into one VLM round-trip — 8 keyframes + a flattened transcript →
"return 8 viral moments." For short videos that's fine. For a 12-minute
crypto vlog with multiple topics, hard cuts, and mixed languages, it
ranges from mediocre to bad: clips bunch up at the start, durations
collapse to identical lengths, and the model sometimes misses the
obviously-viral moment because it never zoomed in on it.

This module runs five separate, focused passes instead. Each pass does
ONE thing well, and the results compound:

  STAGE 1 — Transcription
    Already done by the caller. We accept the standard Whisper-shaped
    transcript: {"text": "...", "segments": [{"start", "end", "text"}]}.

  STAGE 2 — Translation / normalization (only if needed)
    If the transcript is in any language Whisper detected as non-English
    (or if it's Hinglish/Roman Urdu / mixed-language), call the LLM
    provider to translate every segment to English while keeping
    timestamps intact. The reasoning pass downstream is much smarter
    in English regardless of which provider we're using.

  STAGE 3 — Per-frame visual analysis
    Sample 24-40 keyframes spread across the video. Ask the VLM, IN
    BATCHES that respect provider frame limits, "describe each frame
    in one sentence: who's on screen, what they're doing, what emotion
    is on the face, what kind of scene it is (talking head /
    b-roll / chart / etc.)." Output: a list of (timestamp, description)
    pairs.

  STAGE 4 — Text reasoning + window scoring
    Now we have rich structured context (transcript + visual annotations
    + timestamps). Build a single PURE-TEXT prompt for the same model
    asking it to score every plausible 30-second window 0-100 for
    virality, with a one-line reason. Pure text reasoning is what
    LLMs do best — much sharper than the visual pass.

  STAGE 5 — Greedy non-overlapping selection
    Sort scored windows by score desc; pick the top N that don't
    overlap each other and respect the min/max duration window.

Output contract: a multimodal_picker.PickerResult so the rest of the
API doesn't have to know which pipeline produced the picks.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

# Reuse helpers + types from the existing single-call picker so we
# don't duplicate frame extraction, model registry, response parsing.
from multimodal_picker import (
    PickerResult,
    PROVIDER_FRAME_LIMITS,
    SINGLE_IMAGE_OLLAMA_TAGS,
    composite_frames_to_grid,
    encode_frame_b64,
    extract_keyframes,
    get_model_by_id,
    _normalize_clips,
    _call_ollama_vlm,
    _call_openai_vision,
    _call_anthropic_vision,
)


# --------------------------------------------------------------------------
# FLEXIBLE GEMINI VISION (Pro-mode only)
# --------------------------------------------------------------------------
# We can't reuse multimodal_picker._call_gemini_vision here — that helper
# enforces a strict responseSchema of {"clips": [...]} via Gemini's
# native generation config. Pro-mode visual descriptions use a different
# shape ({"frames": [{"n", "t", "desc"}]}) so the schema would reject
# our prompt and return empty. This Pro-only call leaves the response
# format as plain JSON-mode (no schema) so the model can answer in
# whatever shape the prompt asks for.

def _parse_gemini_retry_after(error_body_text: str) -> Optional[float]:
    """Pull the 'Please retry in 16.03s' hint out of Gemini's 429
    response so we can wait the right amount instead of guessing."""
    m = re.search(r"retry in ([0-9]+(?:\.[0-9]+)?)\s*s", error_body_text or "")
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def _call_gemini_describe(
    *,
    model_tag: str,
    api_key: str,
    prompt: str,
    frame_paths: List[str],
    max_retries: int = 3,
    on_log=None,
) -> str:
    """Gemini vision call with flexible JSON output, plus automatic
    retry on 429 (free-tier rate-limit). Returns raw JSON string (or
    whatever the model wrote). Caller is responsible for extracting
    the relevant structure.

    Free tier is 20 RPM on gemini-2.5-flash. When we get hit with a
    429, the response body says "Please retry in N.NNs" — we parse
    that, sleep, and retry up to `max_retries` times before giving up.
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
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
            # NOTE: deliberately no responseSchema — see module docstring.
        },
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model_tag}:generateContent?key={api_key}"
    )
    attempt = 0
    while True:
        attempt += 1
        r = requests.post(url, json=body, timeout=300)
        if r.status_code == 429 and attempt <= max_retries:
            wait_s = _parse_gemini_retry_after(r.text) or (5 * attempt)
            wait_s = min(60.0, wait_s + 1.0)  # +1s safety, cap at 60s per attempt
            if on_log:
                on_log(f"⏳ Gemini 429 — waiting {wait_s:.1f}s (attempt {attempt}/{max_retries})…")
            time.sleep(wait_s)
            continue
        if not r.ok:
            raise RuntimeError(
                f"Gemini {r.status_code}: {r.text[:500]}"
            )
        data = r.json()
        candidates = data.get("candidates") or []
        if not candidates:
            block = data.get("promptFeedback", {}).get("blockReason")
            raise RuntimeError(f"Gemini returned no candidates (block={block})")
        parts_out = candidates[0].get("content", {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts_out if isinstance(p, dict))
        return text or ""


# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

# How many keyframes to extract for the visual-description pass. More
# gives finer-grained signal but costs more LLM time. 32 is a good
# balance for 5-15 min videos.
VISUAL_PASS_FRAMES_DEFAULT = 32

# Multi-size scoring candidates. Instead of one fixed window length
# (which made every clip the same duration), we generate candidates at
# THREE sizes that span the user's min..max duration range. The
# scorer picks the best moment AT each duration and selection lets
# clips of different durations compete fairly.
#
# Stride (gap between successive starts) scales with size — bigger
# windows step further so we don't over-sample.

def _candidate_window_sizes(min_duration: float, max_duration: float) -> List[Tuple[float, float]]:
    """Return [(window_size_sec, stride_sec), ...] tuples covering the
    duration range. Three sizes by default: short, medium, long."""
    short = max(8.0, min_duration)
    long = max(short + 5.0, max_duration)
    medium = round((short + long) / 2, 1)
    return [
        (short,  max(5.0,  short  * 0.40)),
        (medium, max(7.0,  medium * 0.45)),
        (long,   max(10.0, long   * 0.50)),
    ]

# Max number of segments to feed into the translation prompt at a time.
# Bumped from 30 → 80 so a 200-segment Urdu transcript only takes 3
# requests instead of 7, leaving headroom under Gemini's 20-RPM free
# tier for the visual + scoring stages that come next.
TRANSLATE_BATCH_SIZE = 80


# --------------------------------------------------------------------------
# LANGUAGE DETECTION
# --------------------------------------------------------------------------

def _complete_json_with_retry(
    provider,
    *,
    system: str,
    user: str,
    max_tokens: int,
    max_retries: int = 3,
    on_log=None,
) -> Any:
    """Wrap provider.complete_json() with automatic retry on rate-limit
    errors. Both Gemini's REST 429 and the GeminiProvider class's
    bubbled-up 429 from the google-genai client land here.

    Returns the parsed JSON (whatever shape the provider gave back) on
    success; raises the LAST exception if every retry was rate-limited.
    """
    last_err: Optional[Exception] = None
    for attempt in range(1, max_retries + 1):
        try:
            return provider.complete_json(system=system, user=user, max_tokens=max_tokens)
        except Exception as e:
            last_err = e
            msg = str(e)
            is_rate_limit = (
                "429" in msg
                or "RESOURCE_EXHAUSTED" in msg
                or "rate-limit" in msg.lower()
                or "rate limit" in msg.lower()
                or "quota" in msg.lower()
            )
            if not is_rate_limit or attempt >= max_retries:
                raise
            wait_s = _parse_gemini_retry_after(msg) or (5.0 * attempt)
            wait_s = min(60.0, wait_s + 1.0)
            if on_log:
                on_log(f"⏳ Provider rate-limited — waiting {wait_s:.1f}s (attempt {attempt}/{max_retries})…")
            time.sleep(wait_s)
    if last_err:
        raise last_err
    raise RuntimeError("complete_json retry loop exhausted with no error captured.")


def _looks_non_english(text: str) -> bool:
    """Cheap heuristic: if the ratio of non-ASCII letters is high, treat
    as non-English. Catches Urdu/Arabic/Hindi/Chinese/Russian/etc. without
    needing a language detector. Hinglish/Roman Urdu (Latin-script
    transliteration) WILL slip through — that's handled separately by
    asking the LLM to translate "if the source isn't already English."
    """
    if not text:
        return False
    sample = text[:2000]
    letters = [c for c in sample if c.isalpha()]
    if not letters:
        return False
    non_ascii = sum(1 for c in letters if ord(c) > 127)
    return (non_ascii / len(letters)) > 0.20


# --------------------------------------------------------------------------
# STAGE 2 — TRANSLATION
# --------------------------------------------------------------------------

def translate_segments_to_english(
    segments: List[Dict[str, Any]],
    *,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url: Optional[str],
    on_log=None,
) -> List[Dict[str, Any]]:
    """Translate every segment's text to English while preserving start
    + end timestamps. Returns a NEW list — input is not mutated.

    If the LLM call fails for a batch we keep the original text for
    that batch (fail-soft) — better to have a slightly worse downstream
    pass than to abort the entire pipeline.
    """
    from llm import build_provider, LLMError

    out: List[Dict[str, Any]] = []
    if not segments:
        return out
    try:
        provider = build_provider(
            provider_id=provider_id,
            model=model_name,
            api_key=api_key,
            base_url=base_url,
        )
    except Exception as e:
        if on_log: on_log(f"⚠️  Translation skipped — provider init failed: {e}")
        return [dict(s) for s in segments]

    n = len(segments)
    for i in range(0, n, TRANSLATE_BATCH_SIZE):
        batch = segments[i : i + TRANSLATE_BATCH_SIZE]
        if on_log:
            on_log(f"🌐 Translating segments {i + 1}-{i + len(batch)} of {n}…")
        # Build a numbered list the model can map back 1:1.
        numbered = "\n".join(
            f"{j + 1}. {(s.get('text') or '').strip()}"
            for j, s in enumerate(batch)
        )
        system = (
            "You are a translator. Translate every numbered line to "
            "natural English while keeping the line numbering intact. "
            "If a line is already English, copy it verbatim. If the "
            "source is Roman Urdu / Hinglish (Latin-script transliteration "
            "of Urdu/Hindi), translate to English. Preserve proper nouns, "
            "tickers, and numbers. Return JSON exactly: "
            '{"translations": [{"n": 1, "en": "..."}, ...]}'
        )
        user = f"Translate these {len(batch)} lines:\n\n{numbered}"
        try:
            resp = _complete_json_with_retry(
                provider, system=system, user=user, max_tokens=3500, on_log=on_log,
            )
        except (LLMError, Exception) as e:
            if on_log:
                on_log(f"⚠️  Translation batch {i // TRANSLATE_BATCH_SIZE + 1} failed: {e}")
            out.extend(dict(s) for s in batch)
            continue
        translations: Dict[int, str] = {}
        if isinstance(resp, dict):
            for t in resp.get("translations") or []:
                if isinstance(t, dict) and "n" in t and "en" in t:
                    try:
                        translations[int(t["n"])] = str(t["en"])
                    except (TypeError, ValueError):
                        pass
        for j, s in enumerate(batch):
            new_s = dict(s)
            en = translations.get(j + 1)
            if en:
                new_s["text"] = en
                new_s["_original_text"] = (s.get("text") or "").strip()
            out.append(new_s)
    return out


# --------------------------------------------------------------------------
# STAGE 3 — PER-FRAME VISUAL ANALYSIS
# --------------------------------------------------------------------------

def describe_frames(
    video_path: str,
    *,
    model_id: str,
    api_key: str,
    base_url: str,
    target_frames: int = VISUAL_PASS_FRAMES_DEFAULT,
    on_log=None,
    debug_capture: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Extract `target_frames` keyframes evenly across the video and
    return a list of {"t": seconds, "desc": "..."} pairs.

    Internally we batch frames to respect each provider's per-call
    image limit. Llama 3.2 Vision / LLaVA accept ONE image per call —
    we composite frames into a grid (the same trick the single-call
    picker uses) so each batch becomes one image.
    """
    model = get_model_by_id(model_id)
    if not model:
        raise ValueError(f"Unknown model id: {model_id}")
    provider = model.get("provider", "")
    provider_limit = PROVIDER_FRAME_LIMITS.get(provider, 8)

    # Probe duration so we know how to lay out timestamps.
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True, text=True, timeout=30,
        )
        video_duration = float(proc.stdout.strip())
    except Exception:
        video_duration = 0.0

    # Stride that gives us roughly target_frames samples.
    if video_duration > 0:
        stride = max(2.0, video_duration / target_frames)
    else:
        stride = 4.0
    frames = extract_keyframes(video_path, stride_seconds=stride, max_frames=target_frames)
    if not frames:
        return []
    if on_log:
        on_log(f"🎞  Visual pass: extracted {len(frames)} keyframes (stride {stride:.1f}s)")

    # Each frame's true timestamp from extract_keyframes. The Frame
    # dataclass uses `time_seconds` (not `timestamp_seconds`) — we read
    # via getattr to stay forward-compatible if either name appears.
    frame_paths = [f.image_path for f in frames]
    timestamps = [
        float(getattr(f, "time_seconds", getattr(f, "timestamp_seconds", i * stride)))
        for i, f in enumerate(frames)
    ]

    # Batch frames into provider-sized groups.
    descriptions: List[Dict[str, Any]] = []
    grid_tag = model.get("ollama_tag", "") if provider == "ollama" else ""
    is_grid_provider = (provider == "ollama") and (grid_tag in SINGLE_IMAGE_OLLAMA_TAGS)

    if is_grid_provider:
        # Single-image providers — stitch ALL frames into one grid and
        # ask the model to describe each cell. Cheaper than N calls but
        # less precise; we trade precision for compatibility.
        if on_log:
            on_log(f"🧩 Compositing {len(frames)} frames into grid for {grid_tag}…")
        grid_path, cols, rows = composite_frames_to_grid(frame_paths)
        try:
            cell_count = cols * rows
            ts_lines = "\n".join(
                f"  Cell {i + 1} at row {i // cols + 1}, col {i % cols + 1}: t = {timestamps[i]:.1f}s"
                for i in range(min(cell_count, len(frames)))
            )
            grid_prompt = (
                f"You are looking at a {cols}x{rows} grid composited from "
                f"{len(frames)} keyframes of a single video. Cells are "
                f"numbered left-to-right, top-to-bottom (1 = top-left).\n\n"
                f"Cell timestamps:\n{ts_lines}\n\n"
                f"For each cell, write a one-sentence description: "
                f"who's on screen (face / body / hands / no person), "
                f"what they appear to be doing or feeling (excited / "
                f"angry / surprised / explaining / silent), and the "
                f"scene type (talking-head / chart-on-screen / b-roll / "
                f"text-overlay / cut-away).\n\n"
                f"Return ONLY JSON: "
                f'{{"cells": [{{"n": 1, "t": <seconds>, "desc": "..."}}]}}\n'
                f"No prose, no markdown."
            )
            try:
                ollama_base = base_url or os.getenv(
                    "OLLAMA_BASE_URL", "http://host.docker.internal:11434"
                )
                raw = _call_ollama_vlm(
                    model_tag=grid_tag,
                    prompt=grid_prompt,
                    frame_paths=[grid_path],
                    base_url=ollama_base,
                )
            finally:
                try:
                    os.unlink(grid_path)
                except OSError:
                    pass
            for cell in _parse_descriptions(raw):
                idx = cell.get("n")
                if isinstance(idx, int) and 1 <= idx <= len(timestamps):
                    descriptions.append({
                        "t": float(cell.get("t") or timestamps[idx - 1]),
                        "desc": str(cell.get("desc") or "").strip(),
                    })
        finally:
            for p in frame_paths:
                try: os.unlink(p)
                except OSError: pass
    else:
        # Multi-image providers — batch by provider_limit.
        for batch_start in range(0, len(frames), provider_limit):
            batch = frame_paths[batch_start : batch_start + provider_limit]
            batch_ts = timestamps[batch_start : batch_start + provider_limit]
            if on_log:
                on_log(
                    f"🔍 Visual batch {batch_start // provider_limit + 1}: "
                    f"{len(batch)} frames covering {batch_ts[0]:.0f}-{batch_ts[-1]:.0f}s"
                )
            ts_lines = "\n".join(
                f"  Frame {i + 1}: t = {batch_ts[i]:.1f}s"
                for i in range(len(batch))
            )
            prompt = (
                f"You are watching a sequence of {len(batch)} keyframes from "
                f"a single video, in chronological order.\n\n"
                f"Frame timestamps:\n{ts_lines}\n\n"
                f"For each frame, write a ONE-SENTENCE description: "
                f"who's on screen (face / body / hands / no person), "
                f"what they appear to be doing or feeling, and the "
                f"scene type (talking-head / chart / b-roll / text-overlay / "
                f"cut-away).\n\n"
                f"Return ONLY JSON: "
                f'{{"frames": [{{"n": 1, "t": <seconds>, "desc": "..."}}]}}\n'
                f"No prose, no markdown."
            )
            raw = ""
            err = ""
            try:
                if provider == "ollama":
                    ollama_base = base_url or os.getenv(
                        "OLLAMA_BASE_URL", "http://host.docker.internal:11434"
                    )
                    raw = _call_ollama_vlm(
                        model_tag=model["ollama_tag"],
                        prompt=prompt,
                        frame_paths=batch,
                        base_url=ollama_base,
                    )
                elif provider == "gemini":
                    # Use the flexible (no-schema) call so Gemini can
                    # return our {"frames": [...]} shape instead of
                    # being forced into the picker's {"clips": [...]}.
                    # `on_log` is passed through so 429-retry waits
                    # surface in the user-visible log feed.
                    raw = _call_gemini_describe(
                        model_tag=model_id.split("/", 1)[1],
                        api_key=api_key,
                        prompt=prompt,
                        frame_paths=batch,
                        on_log=on_log,
                    )
                elif provider == "openai":
                    raw = _call_openai_vision(
                        model_tag=model_id.split("/", 1)[1],
                        api_key=api_key,
                        prompt=prompt,
                        frame_paths=batch,
                        base_url=base_url or "https://api.openai.com/v1",
                    )
                elif provider == "anthropic":
                    raw = _call_anthropic_vision(
                        model_tag=model_id.split("/", 1)[1],
                        api_key=api_key,
                        prompt=prompt,
                        frame_paths=batch,
                    )
                else:
                    raw = "{}"
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                if on_log: on_log(f"⚠️  Visual batch {batch_start // provider_limit + 1} threw: {err}")
            # Print AND capture the raw response so we can see what the
            # model actually said when 0 descriptions get extracted.
            if on_log:
                on_log(f"📥 Batch {batch_start // provider_limit + 1} raw ({len(raw or '')} chars): {(raw or '')[:200]!r}")
            parsed = _parse_descriptions(raw, key="frames")
            batch_count = 0
            for fr in parsed:
                idx = fr.get("n")
                if isinstance(idx, int) and 1 <= idx <= len(batch_ts):
                    descriptions.append({
                        "t": float(fr.get("t") or batch_ts[idx - 1]),
                        "desc": str(fr.get("desc") or "").strip(),
                    })
                    batch_count += 1
            if on_log:
                on_log(
                    f"   ↪ parsed {batch_count}/{len(batch)} descriptions "
                    f"(parser found {len(parsed)} entries)"
                )
            if debug_capture is not None:
                debug_capture.append({
                    "batch": batch_start // provider_limit + 1,
                    "frames": len(batch),
                    "raw_chars": len(raw or ""),
                    "raw_head": (raw or "")[:400],
                    "raw_tail": (raw or "")[-200:] if len(raw or "") > 400 else "",
                    "parsed_count": len(parsed),
                    "extracted_count": batch_count,
                    "error": err,
                })
        # Cleanup all extracted frames.
        for p in frame_paths:
            try: os.unlink(p)
            except OSError: pass

    descriptions.sort(key=lambda d: d["t"])
    if on_log:
        on_log(f"✓ Visual pass produced {len(descriptions)} per-frame descriptions")
    return descriptions


def _parse_descriptions(raw: str, key: str = "cells") -> List[Dict[str, Any]]:
    """Tolerant JSON-array extraction. Tries `key`, then `frames`,
    `cells`, `descriptions`, and finally any list value in a top-level
    object. Returns [] if nothing usable came back."""
    if not raw:
        return []
    text = raw.strip()
    # Strip code fences.
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    fb = text.find("{")
    lb = text.rfind("}")
    if fb >= 0 and lb > fb:
        text = text[fb : lb + 1]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, dict):
        return parsed if isinstance(parsed, list) else []
    for k in (key, "frames", "cells", "descriptions"):
        v = parsed.get(k)
        if isinstance(v, list) and v:
            return v
    # Last-ditch: first list value in the dict.
    for v in parsed.values():
        if isinstance(v, list):
            return v
    return []


# --------------------------------------------------------------------------
# STAGE 4 — WINDOW SCORING (pure text reasoning)
# --------------------------------------------------------------------------

def score_windows(
    *,
    video_duration: float,
    transcript_segments: List[Dict[str, Any]],
    visual_descriptions: List[Dict[str, Any]],
    target_clips: int,
    min_duration: float,
    max_duration: float,
    provider_id: str,
    model_name: str,
    api_key: str,
    base_url: Optional[str],
    on_log=None,
    debug_capture: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Build a structured prompt and ask the LLM to score every
    candidate window. Returns a list of:
        {start, end, score, hook, why_viral}
    sorted by score descending. May return more than `target_clips`
    candidates — selection happens in stage 5.
    """
    from llm import build_provider, LLMError

    if video_duration <= 0:
        return []

    # Build MULTI-SIZE candidate windows. We score at multiple durations
    # so the picks don't all come out the same length — short, medium,
    # and long candidates compete in stage 5 on virality score.
    sizes = _candidate_window_sizes(min_duration, max_duration)
    candidates: List[Tuple[float, float]] = []
    seen: set = set()
    for size, stride in sizes:
        t = 0.0
        while t < video_duration:
            end = min(video_duration, t + size)
            if end - t >= max(min_duration * 0.6, 8.0):
                key = (round(t, 1), round(end, 1))
                if key not in seen:
                    seen.add(key)
                    candidates.append((t, end))
            t += stride
    if not candidates:
        return []
    if on_log:
        size_summary = ", ".join(f"{int(s)}s×{int(stride)}step" for s, stride in sizes)
        on_log(f"📐 Stage 4 candidates: {len(candidates)} windows at sizes [{size_summary}]")

    # Sort visual descriptions for fast nearest-time lookup.
    vd_by_t = sorted(visual_descriptions or [], key=lambda d: d["t"])

    def visuals_in(window_start: float, window_end: float) -> str:
        in_window = [d for d in vd_by_t if window_start <= d["t"] < window_end]
        if not in_window:
            return "(no visual annotations in window)"
        return "\n".join(
            f"  · t={d['t']:.0f}s — {d['desc']}"
            for d in in_window
        )

    def transcript_in(window_start: float, window_end: float) -> str:
        lines: List[str] = []
        for seg in transcript_segments or []:
            try:
                ss = float(seg.get("start", 0))
                se = float(seg.get("end", 0))
            except (TypeError, ValueError):
                continue
            # Include any segment that OVERLAPS the window.
            if se <= window_start or ss >= window_end:
                continue
            txt = (seg.get("text") or "").strip()
            if txt:
                lines.append(f"  [{ss:.0f}s-{se:.0f}s] {txt}")
        if not lines:
            return "(silent / no transcript in window)"
        return "\n".join(lines)

    # Chunk candidates so each scoring call fits Gemini's effective
    # output budget. Empirically Gemini 2.5 Flash starts dropping rows
    # past ~25 windows in one shot. 18 keeps a comfortable margin.
    chunk_size = 18

    if on_log:
        on_log(
            f"🧠 Reasoning pass: scoring {len(candidates)} windows "
            f"in {((len(candidates) - 1) // chunk_size) + 1} chunk(s) of up to {chunk_size}…"
        )

    try:
        provider = build_provider(
            provider_id=provider_id,
            model=model_name,
            api_key=api_key,
            base_url=base_url,
        )
    except Exception as e:
        if on_log: on_log(f"⚠️  Reasoning pass: provider init failed: {e}")
        return []

    out: List[Dict[str, Any]] = []
    chunks = [
        (i, candidates[i : i + chunk_size])
        for i in range(0, len(candidates), chunk_size)
    ]

    for chunk_no, (chunk_start, chunk_candidates) in enumerate(chunks, start=1):
        prompt_lines = [
            "You are a senior viral-video editor working on TikTok / Reels / YouTube Shorts.",
            f"You're scoring {len(chunk_candidates)} candidate clip windows "
            f"(chunk {chunk_no} of {len(chunks)}, source duration {video_duration:.0f}s).",
            "",
            "For EACH window below, return a virality score (0-100) and a one-sentence reason.",
            "Score factors (in this priority order):",
            "  1. Has a clear hook in the FIRST 3 seconds (a surprising claim, question, or punchline).",
            "  2. Has a payoff or reveal that lands inside the window.",
            "  3. Visual energy matches audio energy (animated speaker, scene changes, on-screen text).",
            "  4. Self-contained — would still make sense without the surrounding video.",
            "  5. Diverse vs other windows you might also score high.",
            "",
            "Score 0 if the window is just intro/outro, dead air, or repetitive filler.",
            "Score 90+ ONLY if you genuinely think this would do >100k views as a Short.",
            "IMPORTANT: return a row for EVERY window in this chunk, even if its score is 0.",
            "",
            f"Each picked clip must be {min_duration:.0f}-{max_duration:.0f} seconds. "
            f"Window lengths VARY (short/medium/long) — score each on its own merits.",
            "",
            "===== WINDOWS =====",
        ]
        for j, (ws, we) in enumerate(chunk_candidates):
            global_idx = chunk_start + j + 1  # 1-based, global
            prompt_lines.append(
                f"\n--- Window {global_idx}: {ws:.0f}s → {we:.0f}s "
                f"(duration {we - ws:.0f}s) ---"
            )
            prompt_lines.append("Transcript:")
            prompt_lines.append(transcript_in(ws, we))
            prompt_lines.append("Visual:")
            prompt_lines.append(visuals_in(ws, we))
        prompt_lines.extend([
            "",
            "===== END WINDOWS =====",
            "",
            "Return ONLY this JSON shape (no prose, no markdown):",
            '{"scored": [',
            '  {"window": <integer index, 1-based, matching the global "Window N" label above>,',
            '   "score": <0-100>,',
            '   "hook": "<8-12 word headline that would work as the clip caption>",',
            '   "why": "<one sentence explaining why this lands or doesn\'t>"},',
            '  ...',
            ']}',
        ])
        prompt = "\n".join(prompt_lines)

        chunk_err = ""
        chunk_resp_text = ""
        scored: List[Dict[str, Any]] = []
        try:
            resp = _complete_json_with_retry(
                provider,
                system=(
                    "You are a JSON-only response generator. Score viral "
                    "potential of clip windows based on transcript + visual "
                    "annotations. Be discerning — most windows are NOT viral. "
                    "ALWAYS return a row for EVERY window you're shown."
                ),
                user=prompt,
                max_tokens=4000,
                on_log=on_log,
            )
            chunk_resp_text = json.dumps(resp)[:800] if isinstance(resp, (dict, list)) else str(resp)[:800]
            if isinstance(resp, dict):
                cand = resp.get("scored")
                if isinstance(cand, list):
                    scored = cand
                else:
                    # Try alternative keys.
                    for k, v in resp.items():
                        if isinstance(v, list) and v and isinstance(v[0], dict) and "score" in v[0]:
                            scored = v
                            break
            elif isinstance(resp, list):
                scored = resp
        except Exception as e:
            chunk_err = f"{type(e).__name__}: {e}"
            if on_log:
                on_log(f"⚠️  Scoring chunk {chunk_no} failed: {chunk_err}")

        # Map this chunk's scored entries back to absolute timestamps.
        # Window indices in the response are GLOBAL (we told the model so).
        kept = 0
        for s in scored:
            if not isinstance(s, dict):
                continue
            try:
                idx = int(s.get("window"))
            except (TypeError, ValueError):
                continue
            if not (1 <= idx <= len(candidates)):
                continue
            ws, we = candidates[idx - 1]
            try:
                score = float(s.get("score", 0))
            except (TypeError, ValueError):
                score = 0.0
            out.append({
                "start": ws,
                "end": we,
                "score": score,
                "hook": str(s.get("hook") or "").strip()[:160],
                "why_viral": str(s.get("why") or "").strip()[:280],
            })
            kept += 1

        if on_log:
            on_log(
                f"   ↪ Chunk {chunk_no}: parser found {len(scored)} entries, "
                f"kept {kept}/{len(chunk_candidates)} valid window scores."
            )
        if debug_capture is not None:
            debug_capture.append({
                "chunk": chunk_no,
                "candidates": len(chunk_candidates),
                "parsed_count": len(scored),
                "kept_count": kept,
                "resp_head": chunk_resp_text[:400],
                "resp_tail": chunk_resp_text[-200:] if len(chunk_resp_text) > 400 else "",
                "error": chunk_err,
            })

    out.sort(key=lambda x: x["score"], reverse=True)
    if on_log:
        top5 = ", ".join(f"{o['score']:.0f}@{o['start']:.0f}s" for o in out[:5])
        on_log(f"✓ Reasoning produced {len(out)} scored windows (top 5: {top5})")
    return out


# --------------------------------------------------------------------------
# STAGE 5 — GREEDY NON-OVERLAPPING SELECTION
# --------------------------------------------------------------------------

def _snap_to_sentence_boundary(
    target_t: float,
    segments: List[Dict[str, Any]],
    *,
    direction: str,
    max_drift: float = 4.0,
) -> float:
    """Find the closest sentence boundary to `target_t` and return its
    timestamp, but only if the boundary is within `max_drift` seconds.
    Otherwise return `target_t` unchanged.

    `direction`: "start" → snap to the START of the nearest segment.
                 "end"   → snap to the END   of the nearest segment.

    Why this matters: viral clips that begin or end mid-sentence feel
    chopped. Snapping to whisper-detected sentence boundaries is a
    cheap way to make every clip end on a natural beat. We still
    enforce the user's min/max duration; we just nudge the boundary by
    a few seconds when there's a clean cut nearby.
    """
    if not segments:
        return target_t
    best = target_t
    best_dist = float("inf")
    for s in segments:
        try:
            edge = float(s["start"] if direction == "start" else s["end"])
        except (KeyError, TypeError, ValueError):
            continue
        d = abs(edge - target_t)
        if d < best_dist:
            best_dist = d
            best = edge
    if best_dist <= max_drift:
        return best
    return target_t


def _refine_clip_boundaries(
    clip: Dict[str, Any],
    *,
    segments: List[Dict[str, Any]],
    min_duration: float,
    max_duration: float,
    video_duration: float,
) -> Dict[str, Any]:
    """Tighten a clip's start/end to natural transcript beats while
    keeping it inside the duration window. Operates on a single clip
    dict and returns a new dict (input untouched)."""
    ws = float(clip["start"])
    we = float(clip["end"])
    snapped_start = _snap_to_sentence_boundary(ws, segments, direction="start", max_drift=3.0)
    snapped_end = _snap_to_sentence_boundary(we, segments, direction="end", max_drift=4.0)
    # Sanity: don't accept a snap that would push the clip OUTSIDE the
    # original window by more than 1.5 s, or shrink it below min_duration.
    if abs(snapped_start - ws) > 5.0:
        snapped_start = ws
    if abs(snapped_end - we) > 6.0:
        snapped_end = we
    # Don't end before start.
    if snapped_end <= snapped_start + 1.0:
        snapped_start, snapped_end = ws, we
    # Clamp to video bounds.
    snapped_start = max(0.0, snapped_start)
    snapped_end = min(video_duration or snapped_end, snapped_end)
    # Enforce duration constraints — if the snap shrank too far, prefer
    # the original boundaries.
    if snapped_end - snapped_start < min_duration * 0.85:
        snapped_start, snapped_end = ws, we
    if snapped_end - snapped_start > max_duration:
        # Keep the snapped end (more important — viewer remembers the
        # beat) and pull the start back to fit max_duration.
        snapped_start = max(0.0, snapped_end - max_duration)
    out = dict(clip)
    out["start"] = round(snapped_start, 2)
    out["end"] = round(snapped_end, 2)
    out["_snapped"] = (snapped_start != ws) or (snapped_end != we)
    return out


def select_top_windows(
    scored: List[Dict[str, Any]],
    *,
    target_clips: int,
    min_duration: float,
    max_duration: float,
    video_duration: float,
) -> List[Dict[str, Any]]:
    """Greedy: walk scored desc by score, accept a window if it doesn't
    overlap any already-accepted window. Trim each accepted window to
    fit min/max duration constraints (favouring the higher-energy half
    of the window when we have to shrink)."""
    chosen: List[Dict[str, Any]] = []
    for w in scored:
        if len(chosen) >= target_clips:
            break
        ws, we = float(w["start"]), float(w["end"])
        # Skip if overlaps an accepted clip by >25%.
        overlap_too_much = False
        for c in chosen:
            cs, ce = float(c["start"]), float(c["end"])
            ov_start = max(ws, cs)
            ov_end = min(we, ce)
            overlap = max(0.0, ov_end - ov_start)
            shorter = min(we - ws, ce - cs)
            if shorter > 0 and overlap / shorter > 0.25:
                overlap_too_much = True
                break
        if overlap_too_much:
            continue
        # Clamp duration. Keep the WHOLE window if it's already in range.
        dur = we - ws
        if dur > max_duration:
            # Shrink to max_duration centred on the window.
            mid = (ws + we) / 2
            ws = max(0.0, mid - max_duration / 2)
            we = min(video_duration, ws + max_duration)
        if (we - ws) < min_duration:
            # Try to grow to min_duration without leaving the source.
            need = min_duration - (we - ws)
            grow_left = min(ws, need / 2)
            ws -= grow_left
            we = min(video_duration, we + (need - grow_left))
            if (we - ws) < min_duration * 0.6:
                continue
        chosen.append({
            "start": round(ws, 2),
            "end": round(we, 2),
            "hook": w.get("hook", ""),
            "why_viral": w.get("why_viral", ""),
            "_score": w.get("score", 0),
        })
    return chosen


# --------------------------------------------------------------------------
# TOP-LEVEL ENTRY
# --------------------------------------------------------------------------

def run_pro_pipeline(
    video_path: str,
    transcript: Dict[str, Any],
    *,
    model_id: str,
    api_key: str,
    base_url: str,
    target_clips: int = 6,
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    on_log=None,
) -> PickerResult:
    """Run the staged 5-pass pipeline and return a PickerResult so the
    caller's response shape stays identical to the fast path.

    `on_log` is an optional callable receiving human-readable progress
    strings — used by the analyze endpoint to push live logs back to
    the frontend if it's plumbed in. Falls back to print() otherwise.
    """
    log = on_log or (lambda s: print(s))
    t0 = time.time()
    model = get_model_by_id(model_id)
    if not model:
        raise ValueError(f"Unknown model id: {model_id}")
    provider_id = model.get("provider", "")
    # The model_id in MODEL_REGISTRY is "provider/model_tag"; we pass
    # just the tag to text-mode providers via build_provider().
    if "/" in model_id:
        model_tag = model_id.split("/", 1)[1]
    else:
        model_tag = model_id

    # Probe duration up front.
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True, text=True, timeout=30,
        )
        video_duration = float(proc.stdout.strip())
    except Exception:
        video_duration = 0.0

    # ----- STAGE 1 — already done by caller. -----
    log(f"📜 Stage 1 — Transcript: {len(transcript.get('segments') or [])} segments, "
        f"language={transcript.get('language', '?')}")

    # ----- STAGE 2 — translation if needed -----
    segments = transcript.get("segments") or []
    full_text = transcript.get("text") or " ".join(s.get("text", "") for s in segments)
    if _looks_non_english(full_text):
        log("🌐 Stage 2 — Translating non-English transcript to English…")
        segments = translate_segments_to_english(
            segments,
            provider_id=provider_id,
            model_name=model_tag,
            api_key=api_key,
            base_url=base_url or None,
            on_log=log,
        )
    else:
        log("🌐 Stage 2 — Source already English, skipping translation.")

    # ----- STAGE 3 — per-frame visual analysis -----
    log("🎞  Stage 3 — Per-frame visual analysis…")
    stage3_debug: List[Dict[str, Any]] = []
    visual_descs = describe_frames(
        video_path,
        model_id=model_id,
        api_key=api_key,
        base_url=base_url,
        target_frames=VISUAL_PASS_FRAMES_DEFAULT,
        on_log=log,
        debug_capture=stage3_debug,
    )

    # ----- STAGE 4 — window scoring -----
    log("🧠 Stage 4 — Reasoning + scoring windows…")
    stage4_debug: List[Dict[str, Any]] = []
    scored = score_windows(
        video_duration=video_duration,
        transcript_segments=segments,
        visual_descriptions=visual_descs,
        target_clips=target_clips,
        min_duration=min_duration,
        max_duration=max_duration,
        provider_id=provider_id,
        model_name=model_tag,
        api_key=api_key,
        base_url=base_url or None,
        on_log=log,
        debug_capture=stage4_debug,
    )

    # ----- STAGE 5 — selection -----
    log(f"✂️  Stage 5 — Selecting top {target_clips} non-overlapping clips…")
    picks = select_top_windows(
        scored,
        target_clips=target_clips,
        min_duration=min_duration,
        max_duration=max_duration,
        video_duration=video_duration,
    )

    # ----- STAGE 5b — content-aware boundary snap -----
    # Each pick is currently aligned to the candidate-window grid (e.g.
    # exact 35.0s windows starting on 15s boundaries). That's WHY the
    # user saw "every clip is exactly 35 seconds." Snap each pick's
    # start/end to nearby Whisper sentence boundaries so durations
    # actually vary AND clips end on a natural beat instead of mid-word.
    if picks and segments:
        log("🪟 Stage 5b — Snapping clip boundaries to natural sentence beats…")
        snapped = []
        snap_count = 0
        for p in picks:
            r = _refine_clip_boundaries(
                p,
                segments=segments,
                min_duration=min_duration,
                max_duration=max_duration,
                video_duration=video_duration,
            )
            if r.get("_snapped"):
                snap_count += 1
            snapped.append(r)
        picks = snapped
        durations = sorted({round(p["end"] - p["start"], 1) for p in picks})
        log(f"   ↪ Snapped {snap_count}/{len(picks)} clip boundaries. Final durations: {durations}")

    # Funnel through the same _normalize_clips so the response shape
    # exactly matches the fast-path PickerResult.
    clips = _normalize_clips(
        picks,
        min_duration=min_duration,
        max_duration=max_duration,
        video_duration=video_duration,
    )

    # GRACEFUL FALLBACK — when the staged pipeline returns nothing
    # (most likely because one of the LLM calls returned an unexpected
    # shape that we didn't catch), fall back to the fast single-call
    # picker so the user still gets clip candidates instead of an
    # empty result. The Pro stages we DID complete are stored in the
    # raw_response so debugging stays possible.
    if not clips:
        log("↪ Pro pipeline produced 0 clips — falling back to single-call picker.")
        try:
            from multimodal_picker import find_viral_moments_multimodal
            fallback = find_viral_moments_multimodal(
                video_path,
                {"text": full_text, "segments": segments,
                 "language": transcript.get("language", "")},
                model_id=model_id,
                api_key=api_key,
                base_url=base_url,
                target_clips=target_clips,
                min_duration=min_duration,
                max_duration=max_duration,
            )
            if fallback.clips:
                log(f"✓ Fallback picker returned {len(fallback.clips)} candidate(s).")
                clips = fallback.clips
        except Exception as fb_e:
            log(f"⚠️  Fallback picker also failed: {fb_e}")

    # If we ended with no clips AND stage 3 was rate-limited, raise so
    # the API endpoint surfaces a 429 message to the frontend instead
    # of a generic "0 clips" page. The user needs to see the truth: the
    # free-tier quota is exhausted, not that the AI thinks the video
    # has no viral moments.
    if not clips and stage3_debug:
        rate_limited_batches = sum(
            1 for d in stage3_debug
            if "429" in (d.get("error") or "") or "RESOURCE_EXHAUSTED" in (d.get("error") or "")
        )
        if rate_limited_batches and rate_limited_batches == len(stage3_debug):
            raise RuntimeError(
                "Gemini free-tier quota exhausted. "
                "Free tier limit is 20 requests/minute on gemini-2.5-flash. "
                "Translation + visual analysis ran out of budget. "
                "Either wait a few minutes and retry, switch to a paid Gemini plan, "
                "or pick a local Ollama model (no rate limit). "
                f"({rate_limited_batches} of {len(stage3_debug)} visual batches hit 429.)"
            )

    elapsed = round(time.time() - t0, 1)
    log(f"✅ Pro pipeline finished in {elapsed}s — {len(clips)} clip(s) returned.")

    return PickerResult(
        clips=clips,
        raw_response=json.dumps({
            "stage_2_translated": _looks_non_english(full_text),
            "stage_3_descriptions": len(visual_descs),
            "stage_3_debug": stage3_debug,
            "stage_4_scored_windows": len(scored),
            "stage_4_debug": stage4_debug,
            "stage_5_picks": len(picks),
            "fallback_used": (not picks) and bool(clips),
            "top_windows": scored[:10],
        }, indent=2)[:10000],
        provider_used=f"{provider_id} (Pro pipeline)",
        model_used=model_id,
        elapsed_seconds=elapsed,
        frames_examined=len(visual_descs),
    )
