#!/usr/bin/env python3
"""Re-render one clip with a *keyframed* 9:16 crop that pans horizontally
between user-defined points.

Inputs:
    --source            path to the original 16:9 video (or any wider-than-9:16)
    --start, --end      clip in/out points in source seconds
    --keyframes         JSON file: [{"t":0.0,"x":0.32,"y":0.5}, ...]
                        t in CLIP-local seconds (0 = clip start)
                        x, y in 0..1 (fraction of source frame, center of crop)
    --output            destination path

We bypass main.py's full SmoothedCameraman pipeline because the user has
explicitly told us where to look. Just cut + crop with an FFmpeg
expression and ship. Much faster than the auto-tracking pipeline (5–10 s
typical, vs 30+ s for a full retrim).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


# ---------------------------------------------------------------------------
# Probe helpers
# ---------------------------------------------------------------------------

def _probe_dimensions(path: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True,
    )
    w, h = out.stdout.strip().split(",")
    return int(w), int(h)


# ---------------------------------------------------------------------------
# Build the FFmpeg time-varying crop expression
# ---------------------------------------------------------------------------

def _build_xy_expr(
    keypoints: list[dict],
    src_w: int,
    src_h: int,
    crop_w: int,
    crop_h: int,
) -> tuple[str, str]:
    """Return (x_expr, y_expr) — FFmpeg `crop` expressions that walk the
    crop window's TOP-LEFT corner through the user's keyframes.

    Each input keyframe is a center point (cx, cy) as a fraction. We
    convert to top-left pixels and clamp to [0, max].
    """
    max_x = max(0.0, src_w - crop_w)
    max_y = max(0.0, src_h - crop_h)

    if not keypoints:
        return f"{max_x / 2:.2f}", f"{max_y / 2:.2f}"

    # Convert each keyframe to (t, x_topleft_pixels, y_topleft_pixels, cut).
    # The `cut` flag means "hard transition INTO this keyframe": instead of
    # smoothly panning from the previous keyframe over the elapsed time,
    # hold the previous position and snap instantly at this t.
    pts: list[tuple[float, float, float, bool]] = []
    for kf in keypoints:
        t = float(kf["t"])
        cx = float(kf.get("x", 0.5))
        cy = float(kf.get("y", 0.5))
        cut = bool(kf.get("cut", False))
        x_tl = max(0.0, min(max_x, cx * src_w - crop_w / 2))
        y_tl = max(0.0, min(max_y, cy * src_h - crop_h / 2))
        pts.append((t, x_tl, y_tl, cut))
    pts.sort(key=lambda p: p[0])

    # Single keyframe = static crop
    if len(pts) == 1:
        return f"{pts[0][1]:.2f}", f"{pts[0][2]:.2f}"

    # Build the time-varying expression. For each segment between consecutive
    # keyframes (i-1, i):
    #   - If keyframe i has cut=True, hold p0 for the entire segment, then
    #     snap to p1 at exactly t1. Implemented as: segment value = p0
    #     until t < t1; then the outer chain selects p1.
    #   - Otherwise (smooth), linearly interpolate between p0 and p1.
    def _interp(idx: int) -> str:
        # idx 1 = x, idx 2 = y
        # Tail: hold the last keyframe's value after the final t.
        expr = f"{pts[-1][idx]:.2f}"
        for i in range(len(pts) - 1, 0, -1):
            t0, p0 = pts[i - 1][0], pts[i - 1][idx]
            t1, p1 = pts[i][0], pts[i][idx]
            cut = pts[i][3]
            if cut or (t1 - t0) < 0.01:
                # Hold previous value through the segment, snap at t1.
                # The transition into p1 happens via the outer chain
                # entering the i-th segment when t >= t1.
                segment = f"{p0:.2f}"
            else:
                slope = (p1 - p0) / (t1 - t0)
                segment = f"({p0:.2f}+{slope:.3f}*(t-{t0:.2f}))"
            expr = f"if(lt(t,{t1:.2f}),{segment},{expr})"
        # Head: hold the first keyframe's value before its t.
        expr = f"if(lt(t,{pts[0][0]:.2f}),{pts[0][idx]:.2f},{expr})"
        return expr

    return _interp(1), _interp(2)


# ---------------------------------------------------------------------------
# Compute crop window dimensions for a 9:16 vertical from arbitrary source
# ---------------------------------------------------------------------------

def _compute_crop_size(
    src_w: int, src_h: int, aspect: float = 9 / 16,
) -> tuple[int, int]:
    """Pick the largest target-aspect rectangle that fits inside the source frame.

    `aspect` is width/height of the desired crop window. Default 9/16 (vertical).
    Pass 16/9 for horizontal output, 1.0 for square, etc.
    """
    if src_w / src_h >= aspect:
        # Source wider than the target — crop is full height
        crop_h = src_h
        crop_w = int(round(crop_h * aspect))
    else:
        # Source narrower than the target — crop is full width
        crop_w = src_w
        crop_h = int(round(crop_w / aspect))
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2
    return crop_w, crop_h


def _parse_aspect(s: str) -> float:
    """Parse 'W:H' or a bare float. '9:16' -> 0.5625. '16:9' -> 1.7777."""
    s = (s or "").strip()
    if ":" in s:
        a, b = s.split(":", 1)
        return float(a) / float(b)
    return float(s)


def _target_output_size(aspect: float) -> tuple[int, int]:
    """Pick a sensible output resolution for a given aspect.

    9:16  -> 1080x1920  (the rest of the app uses this for vertical)
    16:9  -> 1920x1080
    1:1   -> 1080x1080
    Anything else -> base on 1080 short side.
    """
    if abs(aspect - 9 / 16) < 0.01:
        return 1080, 1920
    if abs(aspect - 16 / 9) < 0.01:
        return 1920, 1080
    if aspect >= 1.0:
        # Landscape-ish: 1080 tall.
        h = 1080
        w = int(round(h * aspect))
        return w - w % 2, h
    # Portrait-ish: 1080 wide.
    w = 1080
    h = int(round(w / aspect))
    return w, h - h % 2


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    # --start / --end are CLIP-MODE only. When both are omitted we treat
    # this as "process the whole source video" — used by the standalone
    # subtitle burn flow which has no clip window.
    p.add_argument("--start", type=float, default=None)
    p.add_argument("--end", type=float, default=None)
    p.add_argument("--keyframes", required=True,
                   help="Path to a JSON file: [{t,x,y,cut?}, ...]")
    p.add_argument("--output", required=True)
    # Target aspect of the crop window. Default 9:16 preserves the
    # behaviour the existing clip-reframe pipeline depends on. Pass
    # '16:9' (or '1.7778') for horizontal-from-vertical re-framing.
    p.add_argument("--aspect", default="9:16",
                   help="Target aspect ratio for the crop window (e.g. '9:16', '16:9'). Default 9:16.")
    args = p.parse_args()

    # Decide CLIP MODE vs FULL-VIDEO MODE up front.
    # Validation differs: clip mode demands both start AND end and a
    # >=0.5s window; full-video mode just runs on the whole input.
    clip_mode = args.start is not None or args.end is not None
    if clip_mode and (args.start is None or args.end is None):
        print("❌ --start and --end must be provided together (or both omitted for full-video mode).", file=sys.stderr)
        return 2

    if not os.path.isfile(args.source):
        print(f"❌ Source not found: {args.source}", file=sys.stderr)
        return 3
    if clip_mode and args.end <= args.start + 0.5:
        print("❌ Clip must be at least 0.5 s", file=sys.stderr)
        return 4
    if not os.path.isfile(args.keyframes):
        print(f"❌ Keyframes file not found: {args.keyframes}", file=sys.stderr)
        return 5

    with open(args.keyframes) as f:
        keypoints = json.load(f)
    if not isinstance(keypoints, list) or not keypoints:
        print("❌ Keyframes must be a non-empty JSON array", file=sys.stderr)
        return 6

    try:
        aspect_val = _parse_aspect(args.aspect)
        if aspect_val <= 0:
            raise ValueError("aspect must be positive")
    except Exception as e:
        print(f"❌ Invalid --aspect: {e}", file=sys.stderr)
        return 7

    src_w, src_h = _probe_dimensions(args.source)
    crop_w, crop_h = _compute_crop_size(src_w, src_h, aspect=aspect_val)
    print(f"📐 Source {src_w}x{src_h} → {args.aspect} crop {crop_w}x{crop_h}")
    x_expr, y_expr = _build_xy_expr(keypoints, src_w, src_h, crop_w, crop_h)
    print(f"🎯 Keyframes: {len(keypoints)} ({'clip mode' if clip_mode else 'full-video mode'})")
    if len(x_expr) > 200:
        print(f"   x expr ({len(x_expr)} chars): {x_expr[:200]}…")
    else:
        print(f"   x expr: {x_expr}")

    # Final scaled output size: pick a canonical resolution for the
    # chosen aspect so the subtitle burn / downstream consumers don't
    # have to deal with arbitrary dimensions.
    target_w, target_h = _target_output_size(aspect_val)
    # CRITICAL: setpts=PTS-STARTPTS resets the filter graph's `t` to 0
    # at the FIRST output frame. Without it, fast input seek (`-ss
    # BEFORE -i`) snaps to the nearest keyframe BEFORE args.start, and
    # filter `t` then carries that pre-roll offset (1–2 seconds typical).
    # The hard-cut expressions `if(lt(t, t_user), …)` would then fire
    # 1–2 s EARLIER than the user marked. setpts fixes the timeline so
    # clip-local t=0 actually means t=0 in the filter expressions.
    # In FULL-VIDEO mode we don't seek, so PTS already starts at 0 — but
    # the reset is harmless and keeps the filter graph identical.
    vfilter = (
        f"setpts=PTS-STARTPTS,"
        f"crop={crop_w}:{crop_h}:'{x_expr}':'{y_expr}',"
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:black"
    )

    # Write to a clean temp path, atomic-rename at the end (special-char
    # safety — see retrim.py for why this matters).
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_out:
        tmp_out_path = tmp_out.name
    try:
        cmd = [
            "ffmpeg", "-y",
            # Explicit accurate_seek to make sure FFmpeg does NOT include
            # the pre-keyframe roll. (Default is on, but some build
            # configurations differ — be defensive.) Only meaningful in
            # clip mode, but cheap to leave on for full-video mode too.
            "-accurate_seek",
        ]
        if clip_mode:
            cmd += ["-ss", f"{args.start:.3f}", "-to", f"{args.end:.3f}"]
        cmd += [
            "-i", args.source,
            "-vf", vfilter,
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-profile:v", "high", "-level", "4.1", "-tune", "film",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            tmp_out_path,
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
            return result.returncode

        # Move across filesystems if needed (Docker /tmp vs /app/output).
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        if os.path.exists(args.output):
            try:
                os.unlink(args.output)
            except OSError:
                pass
        shutil.move(tmp_out_path, args.output)
        tmp_out_path = None
        size_mb = os.path.getsize(args.output) / (1024 * 1024)
        print(f"✅ Reframe complete: {args.output} ({size_mb:.2f} MB)")
        return 0
    finally:
        if tmp_out_path and os.path.exists(tmp_out_path):
            try:
                os.unlink(tmp_out_path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
