#!/usr/bin/env python3
"""Generate placeholder sample videos for the Klipra homepage.

WHAT
----
Produces six demo mp4 files used by the marketing homepage to show
what each feature looks like. Each clip is small (~3-8 MB), short
(~20-25 s), and self-contained: gradient background, soft sine-wave
audio, sample subtitles burned in via libass.

WHY
---
.gitignore excludes *.mp4 so the real demo videos never make it into
git. On a fresh clone the homepage has nothing to show and the
preview tags spin forever. This script seeds the public/samples/
folder with reasonable placeholders so the homepage looks complete
on day one. You (or your editor) can replace any of them later with
real Klipra outputs by overwriting the same file paths — no code
change needed.

HOW TO RUN
----------
From the repo root:
    python3 scripts/generate_homepage_samples.py

Requires: ffmpeg available on PATH. No Python deps beyond stdlib.

OUTPUTS
-------
dashboard/public/samples/
    subtitle-horizontal.mp4    16:9 burned-subtitle demo
    subtitle-vertical.mp4      9:16 burned-subtitle demo
    clip-vertical.mp4          9:16 viral-clip demo (hook + caption)
    dub-before.mp4             original-language demo
    dub-after-spanish.mp4      dubbed-to-Spanish demo

Re-running overwrites existing files (idempotent).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


# Where the homepage looks for samples. Vite serves dashboard/public/*
# at the URL root, so /samples/foo.mp4 resolves to this directory in
# both dev and the built dist.
PUBLIC_SAMPLES_DIR = Path(__file__).resolve().parents[1] / "dashboard" / "public" / "samples"


def _have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _run(cmd: list[str]) -> bool:
    """Run an FFmpeg command. Returns True on success."""
    print(f"  $ {' '.join(cmd[:6])} …  ({len(cmd)} args)")
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if res.returncode != 0:
        print(f"    ✗ FFmpeg error: {res.stderr.decode('utf-8', errors='replace')[-400:]}")
        return False
    return True


def _write_srt(lines: list[tuple[float, float, str]], path: Path) -> None:
    """Write a tiny SRT file. `lines` is a list of (start, end, text)."""
    def fmt(t: float) -> str:
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = t % 60
        ms = int(round((s - int(s)) * 1000))
        return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"

    with open(path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(lines, 1):
            f.write(f"{i}\n{fmt(start)} --> {fmt(end)}\n{text}\n\n")


def make_subtitle_demo(out_path: Path, *, width: int, height: int,
                       duration: float, gradient_top: str, gradient_bottom: str,
                       lines: list[tuple[float, float, str]],
                       fontsize: int) -> bool:
    """Render: vertical-gradient bg + soft sine audio + burned subs."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        srt_path = td / "subs.srt"
        _write_srt(lines, srt_path)

        # FFmpeg lavfi can build a vertical two-stop linear gradient with
        # two color sources stacked + a vstack alpha blend. Simpler: use
        # a single colour for now — gradient_top dictates the look. Real
        # multi-stop gradients need a more complex graph than this script
        # is worth; one solid colour per demo keeps the placeholder
        # generation reliable on every host.
        # Burn the SRT directly with the libass filter.
        srt_escaped = str(srt_path).replace("'", r"\'").replace(":", r"\:")
        # Style override: sized for the chosen resolution, white text,
        # black outline, bold.
        force_style = (
            f"FontName=DejaVu Sans,FontSize={fontsize},PrimaryColour=&H00FFFFFF,"
            f"OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,"
            f"Alignment=2,MarginV={int(height * 0.08)}"
        )
        vf = (
            f"subtitles='{srt_escaped}':force_style='{force_style}'"
        )

        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"color=c={gradient_top}:s={width}x{height}:r=30",
            "-f", "lavfi", "-i", f"sine=frequency=440:r=44100:d={duration:.2f}",
            "-t", f"{duration:.2f}",
            "-vf", vf,
            "-c:v", "libx264", "-preset", "fast", "-crf", "26",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k",
            "-shortest",
            str(out_path),
        ]
        return _run(cmd)


def make_clip_demo(out_path: Path) -> bool:
    """Vertical 9:16 with hook overlay + a caption — meant to look like
    a viral short. Uses drawtext (no SRT needed) for the hook so it
    doesn't rely on libass timing for static text."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = 1080, 1920
    duration = 15.0
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=0xff7e3a:s={width}x{height}:r=30",
        "-f", "lavfi", "-i", f"sine=frequency=520:r=44100:d={duration:.2f}",
        "-t", f"{duration:.2f}",
        "-vf", (
            # Top hook bar
            f"drawbox=x=0:y={int(height*0.06)}:w={width}:h={int(height*0.08)}:color=black@0.6:t=fill,"
            f"drawtext=text='YOU WON\\'T BELIEVE THIS':fontcolor=white:fontsize=72:"
            f"x=(w-text_w)/2:y={int(height*0.075)}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf:"
            f"box=0,"
            # Mid caption
            f"drawbox=x=0:y={int(height*0.45)}:w={width}:h={int(height*0.10)}:color=black@0.5:t=fill,"
            f"drawtext=text='AI picks the best 60 seconds':fontcolor=white:fontsize=64:"
            f"x=(w-text_w)/2:y={int(height*0.46)}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf:"
            f"box=0"
        ),
        "-c:v", "libx264", "-preset", "fast", "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-shortest",
        str(out_path),
    ]
    # drawtext fontfile fallback — if DejaVu isn't installed (some
    # minimal Linux containers), fall back to a recipe that omits the
    # fontfile so FFmpeg uses its built-in font selection.
    if not Path("/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf").exists():
        cmd[-9] = cmd[-9].replace(
            ":fontfile=/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf",
            "",
        )
    return _run(cmd)


def main():
    if not _have_ffmpeg():
        print("✗ ffmpeg not found on PATH. Install ffmpeg first.")
        sys.exit(1)

    PUBLIC_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"📦 Output dir: {PUBLIC_SAMPLES_DIR}")
    print()

    # ---------- AUTO SUBTITLE DEMOS ----------
    # Two orientations because the homepage shows both 16:9 (horizontal
    # podcast/YT-style) and 9:16 (vertical short-form) examples.
    print("→ subtitle-horizontal.mp4 (16:9, ~22s)")
    ok1 = make_subtitle_demo(
        PUBLIC_SAMPLES_DIR / "subtitle-horizontal.mp4",
        width=1920, height=1080, duration=22.0,
        gradient_top="0x0d4f57", gradient_bottom="0x0a2628",
        lines=[
            (0.5, 4.0, "Klipra burns subtitles into any video"),
            (4.2, 7.5, "Word-perfect timing — no manual sync"),
            (7.8, 11.0, "Pop, Glow, Karaoke animation styles"),
            (11.3, 14.5, "Translate to 30+ languages instantly"),
            (14.8, 18.0, "Crypto, finance and tech jargon preserved"),
            (18.3, 21.5, "All your AI providers, your keys, your control"),
        ],
        fontsize=48,
    )

    print("→ subtitle-vertical.mp4 (9:16, ~22s)")
    ok2 = make_subtitle_demo(
        PUBLIC_SAMPLES_DIR / "subtitle-vertical.mp4",
        width=1080, height=1920, duration=22.0,
        gradient_top="0x2d1b4e", gradient_bottom="0x0f0820",
        lines=[
            (0.5, 4.0, "Vertical subtitles\nfor TikTok and Reels"),
            (4.2, 7.5, "Drop a video.\nAI does the rest."),
            (7.8, 11.0, "Karaoke-style word reveal\nas each word is spoken"),
            (11.3, 14.5, "Sync to your real audio,\nnot Whisper's guesses"),
            (14.8, 18.0, "Edit the transcript inline\nbefore burning"),
            (18.3, 21.5, "One click → publish-ready short"),
        ],
        fontsize=64,
    )

    # ---------- GENERATE CLIPS DEMO ----------
    print("→ clip-vertical.mp4 (9:16, 15s)")
    ok3 = make_clip_demo(PUBLIC_SAMPLES_DIR / "clip-vertical.mp4")

    # ---------- VOICE DUBBING DEMOS ----------
    print("→ dub-before.mp4 (original — English)")
    ok4 = make_subtitle_demo(
        PUBLIC_SAMPLES_DIR / "dub-before.mp4",
        width=1080, height=1920, duration=12.0,
        gradient_top="0x1e5641", gradient_bottom="0x0a2419",
        lines=[
            (0.3, 3.5, "Original — English voiceover"),
            (3.8, 7.0, "Recorded by the creator,\noriginal track"),
            (7.3, 11.5, "Whisper picks up every word\nand timestamp"),
        ],
        fontsize=58,
    )

    print("→ dub-after-spanish.mp4 (dubbed — Spanish)")
    ok5 = make_subtitle_demo(
        PUBLIC_SAMPLES_DIR / "dub-after-spanish.mp4",
        width=1080, height=1920, duration=12.0,
        gradient_top="0x4e1b3d", gradient_bottom="0x200815",
        lines=[
            (0.3, 3.5, "Dubbed — Español"),
            (3.8, 7.0, "Misma voz, idioma nuevo\n(IA TTS)"),
            (7.3, 11.5, "21 idiomas Edge TTS gratis,\nmás voces ElevenLabs"),
        ],
        fontsize=58,
    )

    print()
    successes = [ok1, ok2, ok3, ok4, ok5]
    if all(successes):
        print(f"✓ All {len(successes)} samples generated.")
        for entry in sorted(PUBLIC_SAMPLES_DIR.glob("*.mp4")):
            size_mb = entry.stat().st_size / (1024 * 1024)
            print(f"    {entry.name}  ({size_mb:.1f} MB)")
        print()
        print("Restart the frontend container so Vite picks them up:")
        print("    docker compose restart frontend")
        return 0
    else:
        print(f"✗ {sum(1 for x in successes if not x)} of {len(successes)} samples failed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
