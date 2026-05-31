"""Face-tracking helper for Smart Clipper's horizontal → vertical reframe.

Given a source video and a [start, end] window inside it, sample face
positions at evenly-spaced timestamps, smooth the trajectory, and emit
a list of keyframes compatible with reframe_kf._build_xy_expr().

The output is a time-varying crop that keeps the dominant face inside
the visible 9:16 window — same idea as main.py's SmoothedCameraman, but
much cheaper because we precompute the path before ffmpeg renders.
"""

from __future__ import annotations

import os
import subprocess
from typing import List, Optional, Tuple, Dict


def _probe_dimensions(path: str) -> Tuple[int, int]:
    """Return (width, height) of the first video stream."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            path,
        ],
        check=True, capture_output=True, text=True, timeout=30,
    )
    w, h = out.stdout.strip().split(",")
    return int(w), int(h)


def detect_scene_cuts(
    source_path: str,
    start: float,
    end: float,
    threshold: float = 0.30,
) -> List[float]:
    """Return CLIP-LOCAL timestamps where a hard scene cut happens
    inside [start, end]. Uses ffmpeg's `select='gt(scene,T)'` filter to
    score frame-to-frame difference. The default `threshold=0.30` is a
    good balance between catching real cuts (camera A → camera B) and
    ignoring fast pans (which rarely score above 0.20).

    Empty list if ffmpeg is missing or the probe fails — caller should
    treat that as "no cuts detected" and pan smoothly as before.
    """
    if end <= start:
        return []
    duration = end - start
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "info",
                "-ss", f"{start:.3f}",
                "-i", source_path,
                "-t", f"{duration:.3f}",
                "-vf", f"select='gt(scene,{threshold})',showinfo",
                "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=120,
        )
    except Exception:
        return []
    cuts: List[float] = []
    # showinfo writes lines like:
    #   [Parsed_showinfo_1 @ ...] n: 0 pts:..., pts_time:1.234 ...
    # We extract pts_time and convert to clip-local seconds.
    import re
    for m in re.finditer(r"pts_time:([0-9.]+)", proc.stderr or ""):
        try:
            t = float(m.group(1))
            # Skip the very first frame (always shows a "cut" because it's the open)
            # and anything within 0.4 s of clip start/end (snap there is jarring).
            if 0.4 < t < (duration - 0.4):
                cuts.append(round(t, 3))
        except ValueError:
            continue
    return cuts


def sample_face_track(
    source_path: str,
    start: float,
    end: float,
    num_samples: int = 12,
) -> List[Dict[str, float]]:
    """Sample mediapipe face positions across [start, end] of source.

    Returns a list of keyframes:
        [{"t": clip_local_seconds, "x": 0..1, "y": 0..1}, ...]

    `t` is relative to the START of the clip (so the first keyframe is
    typically t=0). `x` / `y` are the centre of the dominant face as a
    fraction of the source frame's width/height. Empty list if mediapipe
    or cv2 isn't available, or no faces are found in any sample.
    """
    if end <= start:
        return []
    try:
        import cv2
        import mediapipe as mp
    except Exception:
        return []
    if not os.path.isfile(source_path):
        return []

    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        return []
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        if fps <= 0:
            fps = 30.0
        n = max(2, int(num_samples))
        # Evenly-spaced timestamps from `start` to `end`.
        ts = [start + (end - start) * (i / (n - 1)) for i in range(n)]

        mp_face_det = mp.solutions.face_detection
        det = mp_face_det.FaceDetection(model_selection=1, min_detection_confidence=0.5)
        kfs: List[Dict[str, float]] = []
        last_xy = (0.5, 0.5)  # fallback if no face in a frame
        try:
            for t_src in ts:
                # Seek by frame index for accuracy.
                frame_idx = int(t_src * fps)
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    # Reuse the last known centre rather than skip the
                    # keyframe — keeping the timestamp grid even is
                    # important for smooth interpolation.
                    cx, cy = last_xy
                else:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res = det.process(rgb)
                    if res.detections:
                        # Pick the largest face (closest to camera).
                        best = max(
                            res.detections,
                            key=lambda d: (
                                d.location_data.relative_bounding_box.width
                                * d.location_data.relative_bounding_box.height
                            ),
                        )
                        bb = best.location_data.relative_bounding_box
                        cx = bb.xmin + bb.width / 2
                        cy = bb.ymin + bb.height / 2
                        # Bias slightly above middle — eyes are more
                        # interesting than chins. Pull cy 6% upward
                        # (toward 0) within the face box.
                        cy = max(0.0, cy - 0.06 * bb.height)
                        last_xy = (cx, cy)
                    else:
                        cx, cy = last_xy
                kfs.append({
                    "t": round(t_src - start, 3),
                    "x": round(max(0.0, min(1.0, cx)), 4),
                    "y": round(max(0.0, min(1.0, cy)), 4),
                })
        finally:
            try:
                det.close()
            except Exception:
                pass
        return _smooth_keyframes(kfs)
    finally:
        cap.release()


def _smooth_keyframes(
    kfs: List[Dict[str, float]],
    window: int = 3,
) -> List[Dict[str, float]]:
    """Box-filter smoothing on x/y so the crop pans gently rather than
    jittering when a face wobbles between frames."""
    if not kfs or window <= 1:
        return kfs
    n = len(kfs)
    half = window // 2
    out: List[Dict[str, float]] = []
    for i, kf in enumerate(kfs):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        avg_x = sum(kfs[j]["x"] for j in range(lo, hi)) / (hi - lo)
        avg_y = sum(kfs[j]["y"] for j in range(lo, hi)) / (hi - lo)
        out.append({
            "t": kf["t"],
            "x": round(avg_x, 4),
            "y": round(avg_y, 4),
        })
    return out


def build_face_track_filter(
    source_path: str,
    start: float,
    end: float,
    target_aspect: float = 9 / 16,
    target_w: int = 720,
    target_h: int = 1280,
) -> Optional[str]:
    """End-to-end helper. Sample faces, build a time-varying crop
    expression that keeps the speaker centred, and return an ffmpeg
    -vf string ready to be plugged into the cut command.

    Returns None if face detection isn't available or no faces were
    found — caller should fall back to the original center-crop.
    """
    try:
        src_w, src_h = _probe_dimensions(source_path)
    except Exception:
        return None
    if src_w <= 0 or src_h <= 0:
        return None

    kfs = sample_face_track(source_path, start, end)
    if not kfs:
        return None

    # Detect hard scene cuts inside the clip and INJECT keyframes at
    # each cut position with `cut: True`. _build_xy_expr uses cut=True
    # to mean "hold the previous position until this t, then snap"
    # — which is exactly what we want: the camera doesn't pan across
    # a real scene change (looks weird), it snaps. Without this the
    # interpolation would smoothly pan from speaker A's face to
    # speaker B's face for the entire segment between samples, which
    # the user described as "panning continues for 3-4 seconds and
    # the person goes out of focus during the panning".
    cut_ts = detect_scene_cuts(source_path, start, end)
    if cut_ts:
        # For each cut, find the closest face sample AFTER the cut and
        # insert a keyframe at the cut timestamp using THAT sample's
        # x/y. That way the crop snaps to the new speaker's position
        # exactly when the cut happens.
        cut_kfs: List[Dict[str, float]] = []
        for ct in cut_ts:
            # Closest sample at or after the cut.
            after = [k for k in kfs if k["t"] >= ct]
            target = after[0] if after else kfs[-1]
            cut_kfs.append({
                "t": ct,
                "x": target["x"],
                "y": target["y"],
                "cut": True,
            })
        # Merge + dedupe by timestamp (cut keyframes win — they have
        # cut: True). Sort by time for the expression builder.
        merged = {round(k["t"], 3): k for k in kfs}
        for ck in cut_kfs:
            merged[round(ck["t"], 3)] = ck
        kfs = sorted(merged.values(), key=lambda k: k["t"])
        print(
            f"✂️  Face track: {len(cut_ts)} scene cut(s) detected "
            f"in [{start:.1f}s,{end:.1f}s]; crop will snap on each."
        )

    # Compute crop window dimensions inside the source frame.
    if src_w / src_h >= target_aspect:
        crop_h = src_h
        crop_w = int(round(crop_h * target_aspect))
    else:
        crop_w = src_w
        crop_h = int(round(crop_w / target_aspect))
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2

    # Build the x_expr / y_expr by reusing reframe_kf's helper. Each kf
    # is a face CENTER, _build_xy_expr converts to top-left and clamps.
    try:
        from reframe_kf import _build_xy_expr
    except Exception:
        # Fallback: static average position (better than nothing).
        avg_x = sum(k["x"] for k in kfs) / len(kfs)
        avg_y = sum(k["y"] for k in kfs) / len(kfs)
        x_tl = max(0, min(src_w - crop_w, int(avg_x * src_w - crop_w / 2)))
        y_tl = max(0, min(src_h - crop_h, int(avg_y * src_h - crop_h / 2)))
        return (
            f"crop={crop_w}:{crop_h}:{x_tl}:{y_tl},"
            f"scale={target_w}:{target_h}"
        )

    x_expr, y_expr = _build_xy_expr(kfs, src_w, src_h, crop_w, crop_h)
    # NOTE on filter syntax:
    #   ffmpeg's crop filter has positional args w:h:x:y:keep_aspect:exact.
    #   `x` and `y` are evaluated per frame automatically when they
    #   reference `t`, so we DO NOT add `:eval=frame` — that would land
    #   on the keep_aspect slot (an integer) and ffmpeg would error out.
    #   reframe_kf.py uses the exact same pattern below and is the
    #   reference for what production-level cropping looks like.
    #
    #   `setpts=PTS-STARTPTS` resets the filter graph's `t` to 0 at the
    #   first output frame so our clip-local x/y expressions land at
    #   the timestamps we computed.
    return (
        f"setpts=PTS-STARTPTS,"
        f"crop={crop_w}:{crop_h}:'{x_expr}':'{y_expr}',"
        f"scale={target_w}:{target_h}"
    )
