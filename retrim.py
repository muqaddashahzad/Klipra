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
    p.add_argument("--start", required=True, type=float)
    p.add_argument("--end", required=True, type=float)
    p.add_argument("--output", required=True, help="Where to write the new vertical clip")
    args = p.parse_args()

    if args.start < 0 or args.end <= args.start:
        print(f"❌ Invalid range: start={args.start} end={args.end}", file=sys.stderr)
        return 2
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
        # 1. Cut the new range from the source into a clean-named file.
        cut_cmd = [
            "ffmpeg", "-y",
            "-ss", f"{args.start:.3f}",
            "-to", f"{args.end:.3f}",
            "-i", args.source,
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-c:a", "aac",
            tmp_in_path,
        ]
        result = subprocess.run(cut_cmd, capture_output=True)
        if result.returncode != 0:
            sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
            return result.returncode

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
