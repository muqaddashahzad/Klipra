"""Stock background catalog for the standalone subtitle / audio-to-video flow.

WHY THIS FILE EXISTS
--------------------
When the user uploads an audio file (vocals, podcast, voice memo) — or
just wants to change the background of a video they already burned —
they need a SOURCE OF VISUAL FRAMES to put their subtitles on top of.

We provide three flavours:
  1. STOCK — pre-defined backgrounds we generate on demand from
     FFmpeg lavfi sources. No bundled .mp4 assets, no CDN fees, no
     storage cost. Each entry is a small FFmpeg recipe that produces
     an infinite-loop video at any resolution & duration.
  2. UPLOADED — user uploads their own .mp4. Handled directly by the
     change-background endpoint, not in this catalog.
  3. (future) HOSTED — designer-made backgrounds in S3 / R2. The
     catalog shape here is forward-compatible: just add `tier: 'pro'`
     entries with `kind: 'hosted', url: '...'`.

CATALOG SHAPE
-------------
Each entry: {
    'id'         (str)   — stable handle used by the API.
    'name'       (str)   — human label shown in the picker.
    'category'   (str)   — 'gradient' | 'minimal' | 'audio-react' | 'lyric-card'.
    'tier'       (str)   — 'free' or 'pro'.
    'kind'       (str)   — 'lavfi' (generate) or 'hosted' (URL).
    'lavfi'      (str)   — FFmpeg lavfi input string (for kind=lavfi).
                           Use {w}, {h}, {dur} placeholders the renderer
                           substitutes at burn time.
    'preview'    (dict)  — { type: 'css', css: '...' } static thumbnail
                           hint for the picker grid (so we don't have to
                           render every stock just to show a preview).
}

ADDING NEW BACKGROUNDS
----------------------
For a new gradient: add an entry with a `lavfi` recipe. Test locally:
    ffmpeg -f lavfi -i "<your recipe>" -t 5 -y test.mp4
For a hosted designer background: add `kind: 'hosted', url: '<https>'`
and the change-background endpoint will fetch it.

CRITICAL — every recipe MUST work at any width/height/duration. Test
with vertical (1080x1920) AND horizontal (1920x1080) before shipping.
"""

# Default catalog. Order = display order in the picker.
STOCK_BACKGROUNDS = [
    # ---------------- gradients ----------------
    {
        'id': 'klipra-teal',
        'name': 'Klipra Teal',
        'category': 'gradient',
        'tier': 'free',
        'kind': 'lavfi',
        # Linear gradient: deep teal → near-black. Matches the Klipra
        # brand palette so it feels like the rest of the app.
        'lavfi': 'color=c=0x0d4f57:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': 'linear-gradient(180deg, #0d4f57 0%, #0a2628 100%)'},
    },
    {
        'id': 'sunset-fade',
        'name': 'Sunset Fade',
        'category': 'gradient',
        'tier': 'free',
        'kind': 'lavfi',
        # Warm orange. Single colour for now; future entries can compose
        # multiple colour layers via FFmpeg's filter graph.
        'lavfi': 'color=c=0xff7e3a:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': 'linear-gradient(180deg, #ff7e3a 0%, #b94c1d 100%)'},
    },
    {
        'id': 'midnight-violet',
        'name': 'Midnight Violet',
        'category': 'gradient',
        'tier': 'free',
        'kind': 'lavfi',
        'lavfi': 'color=c=0x2d1b4e:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': 'linear-gradient(180deg, #2d1b4e 0%, #0f0820 100%)'},
    },
    {
        'id': 'forest-mint',
        'name': 'Forest Mint',
        'category': 'gradient',
        'tier': 'free',
        'kind': 'lavfi',
        'lavfi': 'color=c=0x1e5641:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': 'linear-gradient(180deg, #1e5641 0%, #0a2419 100%)'},
    },
    # ---------------- minimal ----------------
    {
        'id': 'pure-black',
        'name': 'Pure Black',
        'category': 'minimal',
        'tier': 'free',
        'kind': 'lavfi',
        'lavfi': 'color=c=black:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': '#000000'},
    },
    {
        'id': 'pure-white',
        'name': 'Pure White',
        'category': 'minimal',
        'tier': 'free',
        'kind': 'lavfi',
        # When the user picks white, they almost certainly want DARK
        # subtitle text — the burn endpoint doesn't auto-flip colours,
        # so the modal should warn / suggest setting font_color to
        # something dark before burning. Documented in the picker UI.
        'lavfi': 'color=c=white:s={w}x{h}:d={dur}',
        'preview': {'type': 'css', 'css': '#ffffff'},
    },
    # ---------------- audio-react (placeholders for now) ----------------
    # These will eventually use FFmpeg's `showwaves` / `showspectrum` /
    # `avectorscope` filters to react to the audio. They're tagged 'pro'
    # so they show in the picker but require an upgrade. v1 produces a
    # simple animated noise pattern as a stand-in.
    {
        'id': 'wave-react',
        'name': 'Audio Waveform',
        'category': 'audio-react',
        'tier': 'pro',
        'kind': 'lavfi',
        # Animated noise — placeholder until showwaves is wired in.
        'lavfi': "color=c=0x111111:s={w}x{h}:d={dur},geq=lum='128+random(0)*40':cb=128:cr=128",
        'preview': {'type': 'css', 'css': 'linear-gradient(180deg, #111 0%, #1ABC9C 50%, #111 100%)'},
    },
]


def get_stock_by_id(stock_id: str) -> dict | None:
    """Fetch a catalog entry by id. Returns None if unknown."""
    for entry in STOCK_BACKGROUNDS:
        if entry['id'] == stock_id:
            return entry
    return None


def render_stock_lavfi(entry: dict, width: int, height: int, duration_s: float) -> str:
    """Substitute {w}/{h}/{dur} placeholders in a lavfi recipe.

    Returns the full lavfi string ready to feed to FFmpeg's
    `-f lavfi -i <here>` arg.
    """
    if entry.get('kind') != 'lavfi':
        raise ValueError(f"Stock entry {entry.get('id')} is not a lavfi recipe")
    return entry['lavfi'].format(
        w=int(width),
        h=int(height),
        dur=f"{max(0.5, float(duration_s)):.3f}",
    )
