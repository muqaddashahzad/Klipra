"""Edit-modal effect library — converts a list of timeline regions into
a single FFmpeg filter chain.

A region is a {start, end, effect, whole?} dict. When `whole` is true
the effect applies to the ENTIRE video (no `enable` clause), letting
the user apply a colour grade to the whole clip without picking a
sub-region. When `whole` is false (default), the effect is wrapped in
`enable='between(t,start,end)'` so it only fires inside the region.

Ease curves
-----------
Earlier motion effects (shake, flash, slow-pan) used either a linear
ramp or a hard on/off. That made the effect snap in suddenly which
looked amateurish. Every motion effect in this file now multiplies its
amplitude by `_ease_window()` — a sin² envelope that's 0 at the
boundaries and 1 in the middle, so the effect fades in and fades out
smoothly. That's the difference between "TikTok shake" (eases in) and
"glitch shake" (snaps in), and we want the polished version.

Time-varying scale
------------------
The zoom effects use `crop` with time-varying expressions, then a
`scale` to bring the cropped window back to the source's size. FFmpeg's
`scale` filter defaults to `eval=init`, which CRASHES with the message
"Expressions with frame variables 'n', 't', 'pos' are not valid in
init eval_mode" when you reference `t`. We fix that by ALWAYS appending
`:eval=frame` to time-varying scale calls. The same fix had to be
backported when the FFmpeg parser changed in 6.x.
"""
from __future__ import annotations

from typing import List, Dict, Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _inside(start: float, end: float) -> str:
    """Filter-graph-safe form of `between(t, start, end)`.

    FFmpeg's filter description lexer treats unescaped commas as
    filter-chain separators. Inside `enable='between(...)'` the single
    quotes already protect the commas, but for expressions interpolated
    raw into option values (e.g. shake's x=, y=) we MUST escape the
    commas with backslashes — otherwise the parser errors out.
    """
    return f"between(t\\,{start:.3f}\\,{end:.3f})"


def _ease_window(start: float, end: float) -> str:
    """Sin² envelope: 0 at boundaries, 1 in the middle, smooth ease in
    and out. Multiplied into motion-effect amplitudes so they don't
    pop on/off — they fade.

    Outside [start, end] this evaluates to 0 because we multiply by
    the inside() mask. Inside, sin(PI*p)² rises from 0 to 1 and back.
    """
    duration = max(0.001, end - start)
    inside = _inside(start, end)
    p = f"((t-{start:.3f})/{duration:.3f})"
    return f"(sin(PI*{p})*sin(PI*{p})*{inside})"


def _smoothstep_window(start: float, end: float) -> str:
    """Smoothstep envelope: 0 at start, smoothly rising to 1 at end.
    Used for slow-pan-style effects that should ease IN over the whole
    region, not pulse like _ease_window. Outside the region this is 0
    (so the effect snaps off cleanly at end — pair with _hold_after if
    you want it to stay zoomed-in afterwards).
    """
    duration = max(0.001, end - start)
    inside = _inside(start, end)
    p = f"((t-{start:.3f})/{duration:.3f})"
    return f"((3*{p}*{p}-2*{p}*{p}*{p})*{inside})"


def _enable(start: float, end: float, whole: bool) -> str:
    """Build the `:enable='...'` clause for filters that support it.
    For whole-video application we return '' so the filter runs every
    frame. The colon-prefix is added by the caller — this returns just
    the body."""
    if whole:
        return ""
    return f"enable='between(t,{start:.3f},{end:.3f})'"


def _attach_enable(filt: str, start: float, end: float, whole: bool) -> str:
    """Append :enable=... to a single filter call ONLY if not whole-video."""
    if whole:
        return filt
    return f"{filt}:enable='between(t,{start:.3f},{end:.3f})'"


# ---------------------------------------------------------------------------
# Motion effects — all use eval=frame on scale, all use ease envelopes
# ---------------------------------------------------------------------------

# Version-tolerant zoom filter.
#
# The original implementation used `crop=...:eval=frame,scale=...:eval=frame`
# which works on ffmpeg 5.0+ but BREAKS on 4.x: the crop filter in 4.x
# doesn't accept the `eval` option at all and bails with
# "Error applying option 'eval' to filter 'crop': Option not found."
#
# The user's container is python:3.11-slim → debian bookworm, which
# typically ships ffmpeg 5.x, but cached layers from older bullseye
# builds (or any user on bullseye) still see 4.x. We need a filter
# that works on EVERY ffmpeg version users could plausibly have.
#
# Strategy: scale-up first (time-varying), then crop back to the
# ORIGINAL frame size at the centre. The original size is plugged in
# as literal numbers — passed in by the caller via `source_width` /
# `source_height` — so the crop's w/h are CONSTANTS and don't need
# the `eval` option. Only `scale` is time-varying, and scale's
# `eval=frame` IS supported in 4.x.
def _zoom_scale_crop(zexpr: str, source_width: int, source_height: int) -> str:
    """Time-varying centre-zoom pattern that works on every ffmpeg.

    `zexpr` is the zoom factor expression (e.g. `(1+0.25*sin(...))`).
    `source_width` / `source_height` are the input clip's dims — used
    as literal constants in the static crop so no `eval=frame` is
    needed on crop.
    """
    sw = int(source_width)
    sh = int(source_height)
    # 1) Scale up by zexpr. Use `iw`/`ih` (refers to filter-input
    #    dims at THIS link, which is the original frame) so the user
    #    doesn't need to know source dims for this step. trunc/*2*2
    #    keeps dims even (libx264 hates odd). eval=frame is REQUIRED
    #    here so `t` works.
    # 2) Crop back to original size at centre. iw/ih here refer to
    #    the post-scale dims, so the offset math uses literal source
    #    dims rather than re-deriving them.
    return (
        f"scale=w='trunc(iw*{zexpr}/2)*2':h='trunc(ih*{zexpr}/2)*2':eval=frame,"
        f"crop=w={sw}:h={sh}:x=(iw-{sw})/2:y=(ih-{sh})/2,"
        f"setsar=1"
    )


def _zoom_punch(start: float, end: float, whole: bool, source_width: int = 0, source_height: int = 0) -> str:
    """Quick zoom in (1.0 → 1.25× → 1.0) over the region.

    `source_width` / `source_height`: clip dimensions. When 0 (the
    legacy 2-arg signature) we fall back to the older crop+scale
    pattern that only works on ffmpeg 5.0+.
    """
    if whole:
        zexpr = "(1+0.10*abs(sin(PI*t/6)))"
    else:
        inside = _inside(start, end)
        duration = max(0.001, end - start)
        zexpr = (
            f"(1+0.25*sin(PI*(t-{start:.3f})/{duration:.3f})*sin(PI*(t-{start:.3f})/{duration:.3f})*{inside})"
        )
    if source_width and source_height:
        return _zoom_scale_crop(zexpr, source_width, source_height)
    # Legacy fallback (eval=frame on crop — ffmpeg 5.0+ only).
    return (
        f"crop=w=iw/{zexpr}:h=ih/{zexpr}:x=(iw-iw/{zexpr})/2:y=(ih-ih/{zexpr})/2:eval=frame,"
        f"scale=w='trunc(iw*{zexpr}/2)*2':h='trunc(ih*{zexpr}/2)*2':eval=frame,"
        f"setsar=1"
    )


def _slow_pan(start: float, end: float, whole: bool, source_width: int = 0, source_height: int = 0) -> str:
    """Slow zoom from 1.0 to 1.18× across the region with smoothstep ease."""
    if whole:
        zexpr = "(1+0.18*(1-cos(PI*min(t,30)/30))/2)"
    else:
        duration = max(0.001, end - start)
        inside = _inside(start, end)
        progress = f"((t-{start:.3f})/{duration:.3f})"
        smoothed = f"(3*{progress}*{progress}-2*{progress}*{progress}*{progress})"
        zexpr = f"(1+0.18*{smoothed}*{inside})"
    if source_width and source_height:
        return _zoom_scale_crop(zexpr, source_width, source_height)
    # Legacy fallback.
    return (
        f"crop=w=iw/{zexpr}:h=ih/{zexpr}:x=(iw-iw/{zexpr})/2:y=(ih-ih/{zexpr})/2:eval=frame,"
        f"scale=w='trunc(iw*{zexpr}/2)*2':h='trunc(ih*{zexpr}/2)*2':eval=frame,"
        f"setsar=1"
    )


def _shake(start: float, end: float, whole: bool) -> str:
    """Earthquake / camera-shake. Amplitude is now multiplied by an
    ease envelope so the shake fades in over the first ~third of the
    region and fades out over the last third — no more sudden snap.
    """
    if whole:
        env = "(0.5+0.5*sin(PI*t/4))"  # subtle continuous wobble
    else:
        env = _ease_window(start, end)
    # 12 Hz wobble with peak ±10 px amplitude (now scaled by env).
    #
    # Pad the frame by 10px on every side first, then crop a SOURCE-SIZED
    # window back out with a moving offset. The old `crop=iw-20:ih-20`
    # shrank every output frame below the source size, so the muxer rescaled
    # — and thus visibly re-framed — the WHOLE clip, not just the shake
    # region (the bug the user reported). With the pad, output dims == source.
    # Outside the region env=0 ⇒ the offset is centred (x=y=10) ⇒ the crop
    # lands exactly on the original content ⇒ those frames are pixel-identical
    # to the source. Inside the region the window jitters ±10px (a thin dark
    # edge may peek in at the peaks — the classic earthquake look).
    return (
        f"pad=w=iw+20:h=ih+20:x=10:y=10,"
        f"crop=w=iw-20:h=ih-20:"
        f"x=10+10*sin(2*PI*t*12)*{env}:"
        f"y=10+10*cos(2*PI*t*12)*{env}"
    )


def _flash(start: float, end: float, whole: bool) -> str:
    """White flash at the START of the region — quick burst with sin²
    fade so it snaps in and fades out, instead of a hard rectangle.
    """
    if whole:
        # No-op for whole-video flash (would be one giant flash).
        return ""
    flash_end = min(end, start + 0.30)
    duration = max(0.001, flash_end - start)
    # Brightness eased: 0 → 0.5 → 0 over [start, flash_end].
    inside_flash = _inside(start, flash_end)
    p = f"((t-{start:.3f})/{duration:.3f})"
    bright_expr = f"(0.5*sin(PI*{p})*sin(PI*{p})*{inside_flash})"
    # eq's brightness option doesn't support the enable clause well
    # with expressions, so we use the expression directly.
    return f"eq=brightness='{bright_expr}'"


# ---------------------------------------------------------------------------
# Color effects — every one supports whole-video application by
# omitting the enable clause. These are the meat of the new "color
# panel" the user asked for: grade the whole clip OR a region.
# ---------------------------------------------------------------------------

def _bw(start: float, end: float, whole: bool) -> str:
    return _attach_enable(f"hue=s=0", start, end, whole)


def _warm(start: float, end: float, whole: bool) -> str:
    return ",".join([
        _attach_enable("colorbalance=rs=0.15:gs=0.05:bs=-0.10", start, end, whole),
        _attach_enable("eq=saturation=1.15:contrast=1.05", start, end, whole),
    ])


def _cool(start: float, end: float, whole: bool) -> str:
    return ",".join([
        _attach_enable("colorbalance=rs=-0.10:gs=0:bs=0.18", start, end, whole),
        _attach_enable("eq=saturation=1.10", start, end, whole),
    ])


def _vibrant(start: float, end: float, whole: bool) -> str:
    return _attach_enable("eq=saturation=1.45:contrast=1.20:gamma=0.95", start, end, whole)


def _cinematic(start: float, end: float, whole: bool) -> str:
    """Hollywood teal-and-orange — push shadows toward teal and
    midtones/highlights toward orange. The classic blockbuster look."""
    return ",".join([
        _attach_enable("colorbalance=rs=0.08:gs=-0.02:bs=-0.05:rm=0.15:gm=0.05:bm=-0.05:rh=0.05:gh=0:bh=-0.10", start, end, whole),
        _attach_enable("eq=saturation=1.05:contrast=1.12:gamma=0.95", start, end, whole),
    ])


def _vintage(start: float, end: float, whole: bool) -> str:
    """Sepia-tinted + lifted blacks for that old-film feel."""
    return ",".join([
        _attach_enable("eq=saturation=0.55:contrast=0.92:gamma=1.05", start, end, whole),
        _attach_enable("colorbalance=rs=0.15:gs=0.05:bs=-0.20:rm=0.10:bm=-0.10", start, end, whole),
    ])


def _noir(start: float, end: float, whole: bool) -> str:
    """High-contrast monochrome — film-noir style."""
    return ",".join([
        _attach_enable("hue=s=0", start, end, whole),
        _attach_enable("eq=contrast=1.45:brightness=-0.05:gamma=0.85", start, end, whole),
    ])


def _dreamy(start: float, end: float, whole: bool) -> str:
    """Soft pastel + slight glow — works great for vlogs and lifestyle.
    Uses an unsharp-mask negative pass for the soft look."""
    return ",".join([
        _attach_enable("eq=saturation=0.85:contrast=0.92:brightness=0.05:gamma=1.08", start, end, whole),
        _attach_enable("colorbalance=rs=0.05:bs=0.05", start, end, whole),
    ])


def _golden_hour(start: float, end: float, whole: bool) -> str:
    """Warm sunset glow — strong orange push without going full sepia."""
    return ",".join([
        _attach_enable("colorbalance=rs=0.22:gs=0.08:bs=-0.18:rm=0.10:gm=0.02", start, end, whole),
        _attach_enable("eq=saturation=1.20:contrast=1.05:gamma=0.95", start, end, whole),
    ])


def _bleach_bypass(start: float, end: float, whole: bool) -> str:
    """Desaturated high-contrast — that gritty Saving Private Ryan
    look. Blends a desaturated copy on top mathematically by reducing
    sat hard and pushing contrast."""
    return _attach_enable("eq=saturation=0.30:contrast=1.35:gamma=0.92", start, end, whole)


def _cyberpunk(start: float, end: float, whole: bool) -> str:
    """Neon contrast — heavy magenta/cyan separation, crushed blacks.
    Looks great on night-time city footage."""
    return ",".join([
        _attach_enable("colorbalance=rs=0.18:gs=-0.10:bs=0.18:rm=-0.05:gm=-0.05:bm=0.10", start, end, whole),
        _attach_enable("eq=saturation=1.55:contrast=1.25:brightness=-0.05", start, end, whole),
    ])


def _matte(start: float, end: float, whole: bool) -> str:
    """Flat film matte — lifted blacks, lowered contrast, slight
    desaturation. Great as a base before adding warm/cool."""
    return _attach_enable("eq=contrast=0.85:saturation=0.85:gamma=1.10", start, end, whole)


def _autumn(start: float, end: float, whole: bool) -> str:
    """Warm orange/red push for fall vibes."""
    return ",".join([
        _attach_enable("colorbalance=rs=0.18:gs=0:bs=-0.15:rm=0.08", start, end, whole),
        _attach_enable("eq=saturation=1.25:contrast=1.05", start, end, whole),
    ])


def _winter(start: float, end: float, whole: bool) -> str:
    """Cold cyan/blue desaturated tones."""
    return ",".join([
        _attach_enable("colorbalance=rs=-0.15:gs=-0.05:bs=0.20:rh=-0.05:bh=0.15", start, end, whole),
        _attach_enable("eq=saturation=0.85:contrast=1.05", start, end, whole),
    ])


def _vibe_pink(start: float, end: float, whole: bool) -> str:
    """Pink/magenta wash — TikTok-friendly pretty look."""
    return ",".join([
        _attach_enable("colorbalance=rs=0.20:gs=-0.05:bs=0.10", start, end, whole),
        _attach_enable("eq=saturation=1.20:brightness=0.04", start, end, whole),
    ])


# ---------------------------------------------------------------------------
# Effect registry
# ---------------------------------------------------------------------------

EFFECT_RECIPES = {
    # motion
    "zoom-punch":    _zoom_punch,
    "slow-pan":      _slow_pan,
    "shake":         _shake,
    "flash":         _flash,
    # color — basic
    "bw":            _bw,
    "warm":          _warm,
    "cool":          _cool,
    "vibrant":       _vibrant,
    # color — pro presets
    "cinematic":     _cinematic,
    "vintage":       _vintage,
    "noir":          _noir,
    "dreamy":        _dreamy,
    "golden-hour":   _golden_hour,
    "bleach-bypass": _bleach_bypass,
    "cyberpunk":     _cyberpunk,
    "matte":         _matte,
    "autumn":        _autumn,
    "winter":        _winter,
    "vibe-pink":     _vibe_pink,
}


EFFECT_CATALOG = [
    # Motion
    {"id": "zoom-punch",    "name": "Zoom punch",    "category": "motion", "desc": "Eased zoom-in and back, sin² curve"},
    {"id": "slow-pan",      "name": "Slow pan",      "category": "motion", "desc": "Smoothstep zoom across the region"},
    {"id": "shake",         "name": "Shake",         "category": "motion", "desc": "Eased camera shake — fades in & out"},
    {"id": "flash",         "name": "Flash",         "category": "motion", "desc": "Soft white flash, fades in & out"},
    # Color basics
    {"id": "bw",            "name": "Black & White", "category": "color",  "desc": "Desaturate to monochrome"},
    {"id": "warm",          "name": "Warm",          "category": "color",  "desc": "Sunlit / golden hue push"},
    {"id": "cool",          "name": "Cool",          "category": "color",  "desc": "Cyan / blue hue push"},
    {"id": "vibrant",       "name": "Vibrant pop",   "category": "color",  "desc": "Boost saturation + contrast"},
    # Color pro presets
    {"id": "cinematic",     "name": "Cinematic",     "category": "color",  "desc": "Hollywood teal & orange grade"},
    {"id": "vintage",       "name": "Vintage",       "category": "color",  "desc": "Sepia-tinted lifted-blacks film look"},
    {"id": "noir",          "name": "Noir",          "category": "color",  "desc": "High-contrast crushed-black B&W"},
    {"id": "dreamy",        "name": "Dreamy",        "category": "color",  "desc": "Soft pastel for vlogs & lifestyle"},
    {"id": "golden-hour",   "name": "Golden hour",   "category": "color",  "desc": "Warm sunset glow"},
    {"id": "bleach-bypass", "name": "Bleach bypass", "category": "color",  "desc": "Gritty desaturated high-contrast"},
    {"id": "cyberpunk",     "name": "Cyberpunk",     "category": "color",  "desc": "Neon magenta/cyan, crushed blacks"},
    {"id": "matte",         "name": "Matte film",    "category": "color",  "desc": "Lifted blacks, low-contrast base"},
    {"id": "autumn",        "name": "Autumn",        "category": "color",  "desc": "Warm orange/red fall vibes"},
    {"id": "winter",        "name": "Winter",        "category": "color",  "desc": "Cold cyan/blue desaturated"},
    {"id": "vibe-pink",     "name": "Pink vibe",     "category": "color",  "desc": "Soft pink/magenta TikTok wash"},
]


# ---------------------------------------------------------------------------
# Top-level: build a single filter string from a regions array
# ---------------------------------------------------------------------------

def build_filter_from_timeline(
    regions: List[Dict[str, Any]],
    source_width: int = 0,
    source_height: int = 0,
) -> str:
    """Compose the full FFmpeg filter chain from a region list.

    `source_width` / `source_height` are the input clip's dimensions —
    when provided, motion effects (zoom-punch, slow-pan) use the
    scale-then-static-crop pattern which works on every ffmpeg version.
    When 0 / not provided, they fall back to the eval=frame-on-crop
    pattern (ffmpeg 5.0+ only) for backwards compatibility.
    """
    parts: List[str] = []
    for r in regions or []:
        try:
            start = float(r.get("start", 0))
            end = float(r.get("end", 0))
        except (TypeError, ValueError):
            continue
        whole = bool(r.get("whole"))
        if not whole and end <= start + 0.05:
            continue
        effect = (r.get("effect") or "").strip()
        recipe = EFFECT_RECIPES.get(effect)
        if not recipe:
            continue
        # Try the new 5-arg signature first; fall back gracefully for
        # recipes that only take (start, end, whole) or (start, end).
        snippet = None
        for args in [
            (start, end, whole, source_width, source_height),
            (start, end, whole),
            (start, end),
        ]:
            try:
                snippet = recipe(*args)
                break
            except TypeError:
                continue
        if snippet:
            parts.append(snippet)
    return ",".join(parts)
