"""Horizontal → Vertical pipeline.

The user has a long horizontal video (lecture, podcast, YouTube upload,
screen-recording with talking head) and wants to:

  1. Slice it into one or more vertical 9:16 clips.
  2. Have AI pick the topic boundaries automatically, so a 30-minute
     podcast that covers "Ethereum price + DeFi reality check" becomes
     two coherent vertical clips, NOT one mush.
  3. Intelligently MERGE non-contiguous segments that talk about the
     same topic (e.g. the speaker drops a "back to Ethereum…" callback
     20 minutes later — that callback should fuse into the Ethereum clip).
  4. Default to face-tracking the speaker, with a manual escape hatch
     so the user can mark hard cuts to a screen-share region.

This module is the BACKEND brain. It exposes two pure-ish functions:

    detect_topic_segments(transcript, llm_provider, llm_model, llm_key)
        → list of proposed vertical clips, each with:
            { "title", "summary", "segments": [{"start","end","text"}] }

    render_h2v_clip(source_path, segments, keyframes, output_path,
                    aspect, focus_mode, face_track_kfs)
        → renders ONE vertical clip from possibly multiple source ranges,
          concatenated. Reuses reframe_kf.py for the actual crop.

It deliberately does NOT touch the FastAPI layer — the endpoints in
app.py wrap these functions with job state, persistence, and async.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

# Local imports (lazy where possible — keeps cold-import cheap for the
# app.py reloader).
try:
    from llm.factory import build_provider  # noqa: E402
    from llm.base import LLMError  # noqa: E402
except Exception:  # pragma: no cover — keeps import working in test harnesses
    build_provider = None  # type: ignore
    LLMError = RuntimeError  # type: ignore


# ---------------------------------------------------------------------------
# Topic detection
# ---------------------------------------------------------------------------

TOPIC_DETECTION_SYSTEM = """You are a senior podcast/long-form video editor.
You're given the FULL transcript of a horizontal long-form video (lecture,
podcast, vlog, screen-recorded talk). Your job is to identify the major
TOPICS the speaker covers and group the transcript lines into a small
number of coherent vertical-clip-worthy chunks.

Rules:
  • Aim for 2–6 topics. Fewer is fine. NEVER more than 8.
  • Each topic must have AT LEAST 25 seconds of speaker content
    (sum of segments) — anything shorter is too small for a vertical clip.
  • A SINGLE topic may pull segments from DIFFERENT non-contiguous time
    ranges. If the speaker returns to a topic 10 minutes later with a
    callback, fuse those segments together. This is the whole point.
  • Drop filler: pure greetings, sponsor reads, "subscribe to my channel"
    outros, dead silence — do NOT put those in any topic.
  • Topic titles are CRISP (3–7 words). Think social-media hook:
      ✅ "Is Ethereum's bull run over?"
      ✅ "Why DeFi is a scam"
      ❌ "Discussion on Ethereum prices and DeFi"
  • Summary is one short sentence describing what the speaker actually
    SAYS in this topic — not what the topic is about in general.
"""

TOPIC_DETECTION_USER_TEMPLATE = """Transcript (each line is one segment):

{lines}

Return JSON with this shape:
{{
  "topics": [
    {{
      "title": "Crisp 3-7 word hook title",
      "summary": "One-sentence what the speaker actually says.",
      "segment_indexes": [0, 1, 2, 14, 15]   // 0-based indexes into the list above
    }}
  ]
}}

Indexes must refer to lines that actually exist (0 to {max_idx}).
Same index MUST NOT appear in two topics."""


def _format_transcript_for_llm(segments: List[Dict[str, Any]]) -> str:
    """Turn Whisper segments into a numbered, time-stamped list for the LLM."""
    lines = []
    for i, s in enumerate(segments):
        start = float(s.get("start", 0))
        end = float(s.get("end", start))
        text = (s.get("text") or "").strip().replace("\n", " ")
        # Trim absurdly long single segments so a single 200-word segment
        # doesn't blow the context budget. The LLM only needs the gist.
        if len(text) > 280:
            text = text[:277] + "…"
        lines.append(f"[{i:03d}] {_fmt_ts(start)}–{_fmt_ts(end)}  {text}")
    return "\n".join(lines)


def _fmt_ts(t: float) -> str:
    """Seconds → m:ss."""
    t = max(0.0, float(t))
    m = int(t // 60)
    s = t - 60 * m
    return f"{m}:{s:05.2f}"


def detect_topic_segments(
    segments: List[Dict[str, Any]],
    *,
    llm_provider: str = "gemini",
    llm_model: str = "gemini-2.5-flash",
    llm_key: str = "",
    llm_base_url: Optional[str] = None,
    min_topic_seconds: float = 25.0,
) -> List[Dict[str, Any]]:
    """Run the topic-grouping LLM pass.

    Returns a list of topic dicts:
        [{ "title", "summary", "segments": [{"start","end","text"}],
            "total_duration": seconds, "source_index_ranges": [(i0,i1)..] }]
    """
    if not segments:
        return []

    if build_provider is None:
        return _fallback_naive_topics(segments, min_topic_seconds=min_topic_seconds)

    try:
        provider = build_provider(
            llm_provider, llm_model, api_key=llm_key, base_url=llm_base_url
        )
    except Exception as e:
        print(f"⚠️  H2V: build_provider failed ({e}); using naive fallback")
        return _fallback_naive_topics(segments, min_topic_seconds=min_topic_seconds)

    user_prompt = TOPIC_DETECTION_USER_TEMPLATE.format(
        lines=_format_transcript_for_llm(segments),
        max_idx=len(segments) - 1,
    )

    try:
        data = provider.complete_json(
            TOPIC_DETECTION_SYSTEM, user_prompt, max_tokens=4096
        )
    except Exception as e:
        print(f"⚠️  H2V: LLM topic detection failed ({e}); using naive fallback")
        return _fallback_naive_topics(segments, min_topic_seconds=min_topic_seconds)

    raw_topics = []
    if isinstance(data, dict):
        raw_topics = data.get("topics") or data.get("clips") or []
    elif isinstance(data, list):
        raw_topics = data

    out: List[Dict[str, Any]] = []
    used_idx: set = set()
    for t in raw_topics:
        if not isinstance(t, dict):
            continue
        title = str(t.get("title") or "").strip() or "Untitled clip"
        summary = str(t.get("summary") or "").strip()
        idx_raw = t.get("segment_indexes") or t.get("indexes") or t.get("segments") or []
        idxs: List[int] = []
        for v in idx_raw:
            try:
                vi = int(v)
            except Exception:
                continue
            if 0 <= vi < len(segments) and vi not in used_idx:
                idxs.append(vi)
        if not idxs:
            continue
        idxs.sort()
        used_idx.update(idxs)

        # Bundle the actual segment dicts.
        bundled = [
            {
                "start": float(segments[i]["start"]),
                "end": float(segments[i]["end"]),
                "text": str(segments[i].get("text") or "").strip(),
                "src_idx": i,
            }
            for i in idxs
        ]
        # Compute index ranges for merge-display: [(i0,i1), (i5,i6), ...].
        ranges = _contiguous_ranges(idxs)
        # Compute final source-side time ranges (one per range), merged.
        time_ranges = _segments_to_time_ranges(bundled, ranges)
        total_dur = sum(b["end"] - b["start"] for b in bundled)
        if total_dur < min_topic_seconds and len(time_ranges) <= 1:
            # Skip tiny topics; but keep multi-range ones (the LLM thinks
            # they're related across time — those are the most interesting).
            continue
        out.append({
            "title": title[:120],
            "summary": summary[:240],
            "segments": bundled,
            "total_duration": round(total_dur, 3),
            "time_ranges": time_ranges,
            "is_merged": len(time_ranges) > 1,
        })

    if not out:
        return _fallback_naive_topics(segments, min_topic_seconds=min_topic_seconds)

    # Order by first appearance in the source video so the user sees them
    # in narrative order, not in whatever order the LLM emitted them.
    out.sort(key=lambda t: (t["time_ranges"][0]["start"] if t["time_ranges"] else 0))
    return out


def _contiguous_ranges(idxs: List[int]) -> List[Tuple[int, int]]:
    """[0,1,2,5,6,10] → [(0,2),(5,6),(10,10)]."""
    if not idxs:
        return []
    out = []
    start = prev = idxs[0]
    for i in idxs[1:]:
        if i == prev + 1:
            prev = i
        else:
            out.append((start, prev))
            start = prev = i
    out.append((start, prev))
    return out


def _segments_to_time_ranges(
    bundled: List[Dict[str, Any]],
    ranges: List[Tuple[int, int]],
) -> List[Dict[str, float]]:
    """Convert (idx_lo, idx_hi) pairs into actual time windows. Includes
    a small 0.25 s lead so the cut doesn't crop the first phoneme, and
    0.25 s tail for breathing room."""
    out = []
    pad_in, pad_out = 0.25, 0.25
    by_src_idx = {b["src_idx"]: b for b in bundled}
    for lo, hi in ranges:
        if lo not in by_src_idx or hi not in by_src_idx:
            continue
        start = max(0.0, by_src_idx[lo]["start"] - pad_in)
        end = by_src_idx[hi]["end"] + pad_out
        if end <= start + 0.1:
            continue
        out.append({"start": round(start, 3), "end": round(end, 3)})
    # Merge any time ranges that overlap or sit within 0.5 s of each
    # other — the padding above can cause adjacent ranges to touch.
    out.sort(key=lambda r: r["start"])
    merged: List[Dict[str, float]] = []
    for r in out:
        if merged and r["start"] <= merged[-1]["end"] + 0.5:
            merged[-1]["end"] = max(merged[-1]["end"], r["end"])
        else:
            merged.append(dict(r))
    return merged


def _fallback_naive_topics(
    segments: List[Dict[str, Any]],
    *,
    min_topic_seconds: float = 25.0,
    target_clip_seconds: float = 60.0,
) -> List[Dict[str, Any]]:
    """If the LLM is unavailable or returns garbage, slice the transcript
    into roughly target_clip_seconds chunks at sentence boundaries."""
    out: List[Dict[str, Any]] = []
    if not segments:
        return out
    cur: List[Dict[str, Any]] = []
    cur_dur = 0.0
    cur_idx0 = 0
    for i, s in enumerate(segments):
        d = float(s.get("end", 0)) - float(s.get("start", 0))
        cur.append({
            "start": float(s["start"]),
            "end": float(s["end"]),
            "text": str(s.get("text") or "").strip(),
            "src_idx": i,
        })
        cur_dur += d
        text = (s.get("text") or "").strip()
        sentence_ended = text.endswith((".", "?", "!", "…"))
        if cur_dur >= target_clip_seconds and sentence_ended:
            ranges = _contiguous_ranges([b["src_idx"] for b in cur])
            time_ranges = _segments_to_time_ranges(cur, ranges)
            out.append({
                "title": _auto_title_from_text(cur[0]["text"]),
                "summary": " ".join(b["text"] for b in cur[:2])[:180],
                "segments": cur,
                "total_duration": round(cur_dur, 3),
                "time_ranges": time_ranges,
                "is_merged": False,
            })
            cur = []
            cur_dur = 0.0
            cur_idx0 = i + 1
    if cur and cur_dur >= min_topic_seconds:
        ranges = _contiguous_ranges([b["src_idx"] for b in cur])
        time_ranges = _segments_to_time_ranges(cur, ranges)
        out.append({
            "title": _auto_title_from_text(cur[0]["text"]),
            "summary": " ".join(b["text"] for b in cur[:2])[:180],
            "segments": cur,
            "total_duration": round(cur_dur, 3),
            "time_ranges": time_ranges,
            "is_merged": False,
        })
    return out


def _auto_title_from_text(text: str) -> str:
    """Trim a transcript line into a short title. First N words, no
    punctuation at the end, capitalize first letter."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    words = text.split(" ")[:7]
    if not words:
        return "Clip"
    title = " ".join(words).rstrip(",.;:!?…")
    return title[:1].upper() + title[1:]


# ---------------------------------------------------------------------------
# Rendering — one vertical clip from one OR MORE source ranges
# ---------------------------------------------------------------------------

def render_h2v_clip(
    source_path: str,
    *,
    time_ranges: List[Dict[str, float]],
    output_path: str,
    aspect: str = "9:16",
    focus_mode: str = "auto",       # "auto" (mediapipe face) | "manual" (keyframes) | "center"
    manual_keyframes: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """Render ONE vertical clip from possibly multiple source time ranges.

    Multi-range = the AI's "intelligent merge": clip pulls segments from
    different times in the source and concatenates them in narrative order.

    Strategy:
      1. For each range, render an intermediate mp4 using reframe_kf.py
         (which handles the time-varying crop + scale + pad to canonical
         output size). Keyframes are either:
            • mediapipe face-track output (focus_mode='auto')
            • the user-provided manual list (focus_mode='manual')
            • static center crop (focus_mode='center')
      2. ffmpeg concat-demuxer the intermediates into the final output.
      3. Clean up intermediates.
    """
    if not time_ranges:
        raise ValueError("render_h2v_clip: time_ranges is empty")
    if not os.path.isfile(source_path):
        raise FileNotFoundError(source_path)

    # Build the per-range keyframe list.
    work = tempfile.mkdtemp(prefix="h2v_")
    intermediates: List[str] = []
    try:
        for i, r in enumerate(time_ranges):
            start = float(r["start"])
            end = float(r["end"])
            if end <= start + 0.2:
                continue

            # Decide the keyframe set for this range.
            if focus_mode == "manual" and manual_keyframes:
                # Manual keyframes are video-local (t in source seconds).
                # Translate to clip-local t by subtracting `start`, and
                # filter to keyframes that fall inside this range.
                rkf = []
                for kf in manual_keyframes:
                    kt = float(kf.get("t", 0))
                    if start - 0.05 <= kt <= end + 0.05:
                        rkf.append({
                            "t": round(max(0.0, kt - start), 3),
                            "x": float(kf.get("x", 0.5)),
                            "y": float(kf.get("y", 0.5)),
                            "cut": bool(kf.get("cut", True)),
                        })
                if not rkf:
                    # Fall back to a single center keyframe if the user
                    # gave manual mode but no keyframes inside this range.
                    rkf = [{"t": 0.0, "x": 0.5, "y": 0.5, "cut": True}]
            elif focus_mode == "center":
                rkf = [{"t": 0.0, "x": 0.5, "y": 0.5, "cut": True}]
            else:
                # Default: auto face tracking, with scene-cut snapping.
                rkf = _build_auto_face_keyframes(source_path, start, end)

            # Write keyframes to a temp json and call reframe_kf.
            kf_path = os.path.join(work, f"kf_{i:03d}.json")
            with open(kf_path, "w") as f:
                json.dump(rkf, f)
            inter_path = os.path.join(work, f"part_{i:03d}.mp4")
            cmd = [
                sys.executable,
                os.path.join(os.path.dirname(__file__) or ".", "reframe_kf.py"),
                "--source", source_path,
                "--start", f"{start:.3f}",
                "--end", f"{end:.3f}",
                "--keyframes", kf_path,
                "--aspect", aspect,
                "--output", inter_path,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not os.path.isfile(inter_path):
                err = (r.stderr or "")[:500]
                raise RuntimeError(
                    f"reframe_kf failed for range [{start:.2f}, {end:.2f}]: {err}"
                )
            intermediates.append(inter_path)

        if not intermediates:
            raise RuntimeError("All time ranges produced empty intermediates")

        # Concat. Single-part: just move it in place.
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        if len(intermediates) == 1:
            shutil.copy2(intermediates[0], output_path)
            return

        list_path = os.path.join(work, "concat.txt")
        with open(list_path, "w") as f:
            for p in intermediates:
                # ffmpeg concat needs single-quoted POSIX-style paths.
                f.write(f"file '{p}'\n")
        # Re-encode on concat: the intermediates are all same codec/res
        # already, but a stream-copy concat occasionally produces a
        # corrupt audio track when the parts come from different source
        # ranges (timestamps reset). 1080×1920 reencodes are fast.
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", list_path,
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(output_path):
            raise RuntimeError(f"ffmpeg concat failed: {(r.stderr or '')[:500]}")
    finally:
        try:
            shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass


def _build_auto_face_keyframes(
    source_path: str, start: float, end: float
) -> List[Dict[str, Any]]:
    """Sample mediapipe faces across [start, end] and emit clip-local
    keyframes. Falls back to a static center crop if face detection
    isn't available."""
    try:
        from face_track import sample_face_track, detect_scene_cuts  # type: ignore
    except Exception:
        return [{"t": 0.0, "x": 0.5, "y": 0.5, "cut": True}]

    n_samples = max(4, min(24, int((end - start) / 1.5)))
    kfs = sample_face_track(source_path, start, end, num_samples=n_samples) or []
    if not kfs:
        return [{"t": 0.0, "x": 0.5, "y": 0.5, "cut": True}]

    # Snap on scene cuts so the camera doesn't pan across hard edits.
    cuts = detect_scene_cuts(source_path, start, end) or []
    if cuts:
        cut_kfs = []
        for ct in cuts:
            after = [k for k in kfs if k["t"] >= ct]
            target = after[0] if after else kfs[-1]
            cut_kfs.append({
                "t": ct, "x": target["x"], "y": target["y"], "cut": True,
            })
        merged = {round(k["t"], 3): k for k in kfs}
        for ck in cut_kfs:
            merged[round(ck["t"], 3)] = ck
        kfs = sorted(merged.values(), key=lambda k: k["t"])
    return kfs


# ---------------------------------------------------------------------------
# Lightweight CLI for ad-hoc invocation / debugging
# ---------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--transcript", required=True, help="JSON file: {'segments': [...]}")
    p.add_argument("--provider", default="gemini")
    p.add_argument("--model", default="gemini-2.5-flash")
    p.add_argument("--key", default="")
    args = p.parse_args()

    with open(args.transcript) as f:
        data = json.load(f)
    topics = detect_topic_segments(
        data.get("segments") or [],
        llm_provider=args.provider, llm_model=args.model, llm_key=args.key,
    )
    print(json.dumps(topics, indent=2))
