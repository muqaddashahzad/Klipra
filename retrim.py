#!/usr/bin/env python3
"""Re-cut and re-reframe one clip with new in/out points.

Invoked by app.py's /api/clip/{job}/{idx}/retrim endpoint as a subprocess
so torch / MediaPipe / YOLO load only when actually needed (not at server
boot). Spawning Python here is acceptable because retrim is an explicit
user action and the user expects a few seconds of work.

Usage:
    python retrim.py \
        --source /path/to/source.mp4 \
        --start 12.34 \
        --end 47.89 \
        --output /path/to/clip_3.mp4
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

from main import process_video_to_vertical


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True, help="Path to the original (horizontal) source video")
    p.add_argument("--start", type=float, default=None,
                   help="Single-range start (seconds). Ignored if --ranges-file is provided.")
    p.add_argument("--end",   type=float, default=None,
                   help="Single-range end (seconds). Ignored if --ranges-file is provided.")
    p.add_argument("--ranges-file", default=None,
                   help="Path to a JSON file containing a list of {start, end} ranges. "
                        "When present, extract each range and concatenate them (hard "
                        "cut) before reframing. Output direction is chronological "
                        "(left-to-right by start time, regardless of order in file).")
    p.add_argument("--output", required=True, help="Where to write the new vertical clip")
    args = p.parse_args()

    # Resolve ranges from either --ranges-file (multi) or --start/--end (single).
    import json as _json
    if args.ranges_file:
        try:
            with open(args.ranges_file) as _f:
                _raw_ranges = _json.load(_f)
        except Exception as e:
            print(f"❌ Could not read --ranges-file {args.ranges_file}: {e}", file=sys.stderr)
            return 2
        if not isinstance(_raw_ranges, list) or not _raw_ranges:
            print(f"❌ --ranges-file must contain a non-empty JSON array", file=sys.stderr)
            return 2
        # Preserve the order the caller sent — the timeline editor lets the
        # user reorder segments (drag a block before/after another), and the
        # concatenated output must follow that arrangement, NOT a forced
        # chronological sort. The API layer already validated the ranges.
        ranges = [{"start": float(r["start"]), "end": float(r["end"])} for r in _raw_ranges]
        for i, r in enumerate(ranges):
            if r["start"] < 0 or r["end"] <= r["start"]:
                print(f"❌ Range #{i+1}: invalid (start={r['start']}, end={r['end']})", file=sys.stderr)
                return 2
    else:
        if args.start is None or args.end is None:
            print(f"❌ Either --ranges-file OR both --start and --end must be provided", file=sys.stderr)
            return 2
        if args.start < 0 or args.end <= args.start:
            print(f"❌ Invalid range: start={args.start} end={args.end}", file=sys.stderr)
            return 2
        ranges = [{"start": args.start, "end": args.end}]
    if not os.path.isfile(args.source):
        print(f"❌ Source not found: {args.source}", file=sys.stderr)
        return 3

    # Both source AND output go through cleanly-named temp files. The
    # user's filenames sometimes contain $, em-dashes, parens, etc. that
    # make some FFmpeg filter parameters glitch even though argv is OK.
    # Sanitizing both ends eliminates an entire class of "second retrim
    # silently failed" bugs.
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_in:
        tmp_in_path = tmp_in.name
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_out:
        tmp_out_path = tmp_out.name
    try:
        # 1. Cut the requested ranges from source into clean-named files,
        #    then concatenate them with a hard cut into tmp_in_path.
        #    Single-range case: same effective behavior as before — one
        #    extract, no concat. Multi-range: extract each, concat via
        #    ffmpeg's concat demuxer (re-encoded, not stream-copy, so the
        #    boundary frames are always valid even across keyframe-misaligned
        #    cuts).
        seg_paths: list[str] = []
        try:
            for i, r in enumerate(ranges):
                seg_path = tempfile.NamedTemporaryFile(
                    prefix=f"_retrim_seg{i}_", suffix=".mp4", delete=False
                ).name
                seg_paths.append(seg_path)
                cut_cmd = [
                    "ffmpeg", "-y",
                    "-ss", f"{r['start']:.3f}",
                    "-to", f"{r['end']:.3f}",
                    "-i", args.source,
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                    "-c:a", "aac",
                    seg_path,
                ]
                result = subprocess.run(cut_cmd, capture_output=True)
                if result.returncode != 0:
                    sys.stderr.write(
                        f"Segment {i+1}/{len(ranges)} extract failed "
                        f"({r['start']:.3f}-{r['end']:.3f}):\n"
                    )
                    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
                    return result.returncode

            if len(seg_paths) == 1:
                # Skip concat, just rename: tmp_in_path was a placeholder.
                shutil.move(seg_paths[0], tmp_in_path)
                seg_paths[0] = None  # type: ignore[assignment]
            else:
                # Build concat list file (FFmpeg concat demuxer format).
                concat_list_path = tempfile.NamedTemporaryFile(
                    prefix="_retrim_concat_", suffix=".txt", delete=False
                ).name
                with open(concat_list_path, "w") as cf:
                    for p in seg_paths:
                        # Single-quote the path to escape ffmpeg's concat parser.
                        # Apostrophes in the path are escaped as '\''
                        safe = (p or "").replace("'", "'\\''")
                        cf.write(f"file '{safe}'\n")
                try:
                    concat_cmd = [
                        "ffmpeg", "-y",
                        "-f", "concat", "-safe", "0",
                        "-i", concat_list_path,
                        # Re-encode rather than stream-copy: the segments were
                        # cut with different keyframe alignment, and stream-copy
                        # produces visible glitches at boundaries.
                        "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                        "-c:a", "aac",
                        tmp_in_path,
                    ]
                    result = subprocess.run(concat_cmd, capture_output=True)
                    if result.returncode != 0:
                        sys.stderr.write(
                            f"Concat of {len(seg_paths)} segments failed:\n"
                        )
                        sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
                        return result.returncode
                    print(
                        f"✅ Merged {len(seg_paths)} ranges into single clip "
                        f"(total {sum(r['end']-r['start'] for r in ranges):.2f}s)"
                    )
                finally:
                    try:
                        os.unlink(concat_list_path)
                    except OSError:
                        pass
        finally:
            # Always clean up per-segment temps (whether we moved or concatted)
            for p in seg_paths:
                if p:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

        # 2. Run the vertical reframing pipeline. Capture its stdout so
        # the failure reason isn't lost — process_video_to_vertical writes
        # error explanations via print(), not via exceptions.
        import contextlib, io
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                ok = process_video_to_vertical(tmp_in_path, tmp_out_path)
        finally:
            sys.stdout.write(captured.getvalue())
            sys.stdout.flush()
        if not ok:
            tail = captured.getvalue().splitlines()[-15:]
            print(
                "❌ process_video_to_vertical reported failure. Last 15 log lines:",
                file=sys.stderr,
            )
            for ln in tail:
                print("   " + ln, file=sys.stderr)
            return 4

        # 3. Move temp file to final destination. Use shutil.move so it
        # works across filesystems (e.g. /tmp and /app/output are on
        # different devices inside the Docker container — os.replace
        # would raise EXDEV / "Invalid cross-device link").
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        # If the destination already exists (this is a re-render),
        # remove it first so shutil.move doesn't error.
        if os.path.exists(args.output):
            try:
                os.unlink(args.output)
            except OSError:
                pass
        shutil.move(tmp_out_path, args.output)
        tmp_out_path = None

        size_mb = os.path.getsize(args.output) / (1024 * 1024)
        print(f"✅ Retrim complete: {args.output} ({size_mb:.2f} MB)")
        return 0
    finally:
        for p in (tmp_in_path, tmp_out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


if __name__ == "__main__":
    sys.exit(main())
