import os
import re
import textwrap
import subprocess
import urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_URL = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSerif/NotoSerif-Bold.ttf"
FONT_DIR = "fonts"
FONT_PATH = os.path.join(FONT_DIR, "NotoSerif-Bold.ttf")

# App-local emoji fonts (bundled into ./fonts, or auto-downloaded on first
# use). These are the DURABLE source of emoji glyphs: the base Docker image's
# fonts-noto-color-emoji package kept getting lost whenever the image was
# rebuilt or restored from a backup, which is why "emoji burn as tofu" kept
# coming back. By keeping our own copy alongside the app (exactly like the
# serif hook font) the burn no longer depends on the OS having an emoji font.
EMOJI_COLOR_LOCAL = os.path.join(FONT_DIR, "NotoColorEmoji.ttf")
EMOJI_MONO_LOCAL = os.path.join(FONT_DIR, "Symbola.ttf")
# Download source if neither the local copy nor a system font exists.
EMOJI_FONT_URL = "https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf"


# ----------------------------------------------------------------------
# Emoji rendering — fallback chain for the hook overlay
# ----------------------------------------------------------------------
# The main hook font (Noto Serif Bold) has no emoji glyphs. Without an
# emoji-capable font, characters like 👽 or 🇺🇸 came out as empty
# tofu squares in the burned video, even though the preview showed them
# correctly (the browser falls back to system emoji automatically).
#
# Resolution: ship a colour-emoji font alongside the main font and
# render emoji runs separately by loading them through Pillow. We try
# Noto Color Emoji (installed via fonts-noto-color-emoji on Linux) and
# fall back to Symbola (monochrome but widely available).
#
# Noto Color Emoji is a CBDT/CBLC bitmap font — older Pillow versions
# could only render it at its native size of 109 px and then required
# resizing. Modern Pillow (>= 8.0) handles size negotiation itself,
# but to be safe we render emoji onto a side canvas at native size
# then scale to the target text height.

EMOJI_FONT_CANDIDATES = [
    # App-local copies FIRST — these always exist (bundled or auto-downloaded)
    # and don't depend on the Docker base image, so emoji never silently
    # disappear after an image rebuild/restore. Color preferred, mono fallback.
    EMOJI_COLOR_LOCAL,
    EMOJI_MONO_LOCAL,
    # System fonts (present when the Docker image's font packages are intact).
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/symbola/Symbola.ttf",
    "/usr/share/fonts/truetype/symbola/Symbola_hint.ttf",
    "/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf",
    # macOS host (when running outside Docker — useful for local dev)
    "/System/Library/Fonts/Apple Color Emoji.ttc",
]

# Regex that matches one emoji "grapheme cluster" — the visible unit
# the user thinks of as one emoji. Covers:
#   • Single-codepoint emoji (faces, animals, food, transport, etc.)
#   • Regional indicator pairs (🇺🇸, 🇵🇰, …)
#   • Skin-tone modifiers
#   • ZWJ sequences (👨‍👩‍👧, 🏳️‍🌈, …)
#   • Variation selectors (text/emoji presentation toggles)
#
# This is intentionally a bit permissive — better to render an
# almost-emoji via the emoji font than to leak tofu into the burn.
_EMOJI_RE = re.compile(
    r"(?:"
    # Flag (two consecutive regional indicators)
    r"[\U0001F1E6-\U0001F1FF]{2}"
    r"|"
    # Generic emoji + optional modifiers + optional ZWJ chains
    r"[\U0001F300-\U0001FAFF"      # most emoji blocks
    r"\U0001F000-\U0001F0FF"       # mahjong/playing cards
    r"\U00002600-\U000027BF"       # misc symbols, dingbats
    r"\U0001F900-\U0001F9FF"       # supplemental symbols
    r"\U00002B00-\U00002BFF]"      # arrows / stars
    r"(?:️)?"                  # variation selector
    r"(?:[\U0001F3FB-\U0001F3FF])?" # skin tone
    r"(?:‍"                    # ZWJ continuation
    r"[\U0001F300-\U0001FAFF"
    r"\U00002600-\U000027BF"
    r"\U0001F900-\U0001F9FF]"
    r"(?:️)?"
    r"(?:[\U0001F3FB-\U0001F3FF])?"
    r")*"
    r")"
)


def _find_emoji_font_path():
    """Return the first emoji font on disk, or None if nothing usable.

    Kept for backwards compatibility — new code should use
    _load_all_emoji_fonts() so missing glyphs in one font automatically
    try the next one.
    """
    for p in EMOJI_FONT_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


def _load_all_emoji_fonts(target_height_px):
    """Load EVERY available emoji font, not just the first one.

    The original implementation tried Noto Color Emoji first and gave
    up if a particular emoji glyph wasn't in that font. Result: any
    emoji not in Debian's bundled Noto release rendered as tofu —
    even though Symbola (the secondary candidate) would have happily
    drawn it as a monochrome glyph.

    By loading every candidate font up front, _render_emoji_inline()
    can fall back from one font to the next per-glyph until ONE of
    them produces a non-empty bounding box. Tofu → fallback glyph,
    not a square.

    Returns a list of (font_obj, native_size, path_basename) tuples
    in preferred order. Empty list if no fonts installed.
    """
    out = []
    for path in EMOJI_FONT_CANDIDATES:
        if not os.path.isfile(path):
            continue
        fname = os.path.basename(path).lower()
        is_color_bitmap = "color" in fname  # NotoColorEmoji.ttf
        native_size = 109 if is_color_bitmap else max(64, int(target_height_px))
        try:
            font = ImageFont.truetype(path, native_size)
            out.append((font, native_size, fname))
        except Exception as e:
            # Try the target size for installs where native size fails.
            try:
                font = ImageFont.truetype(path, target_height_px)
                out.append((font, target_height_px, fname))
            except Exception as e2:
                print(f"⚠️ Could not load emoji font {path}: {e2}")
                continue
    return out


def _load_emoji_font(target_height_px):
    """Back-compat shim — returns the first loaded emoji font, or
    (None, 0). New code should call _load_all_emoji_fonts() and try
    every font per-glyph for maximum coverage.
    """
    fonts = _load_all_emoji_fonts(target_height_px)
    if not fonts:
        return None, 0
    font, native_size, _ = fonts[0]
    return font, native_size


def _split_runs(text):
    """Split a string into [(is_emoji, substring), …] runs preserving
    order. An empty input yields an empty list."""
    if not text:
        return []
    runs = []
    last_end = 0
    for m in _EMOJI_RE.finditer(text):
        if m.start() > last_end:
            runs.append((False, text[last_end:m.start()]))
        runs.append((True, m.group(0)))
        last_end = m.end()
    if last_end < len(text):
        runs.append((False, text[last_end:]))
    return runs


def _measure_run(draw, text, font):
    """Width of a single run when rendered with `font`."""
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _try_render_emoji_to_scratch(emoji_str, emoji_font, native_size):
    """Render emoji_str at native size to a scratch canvas. Returns the
    cropped glyph image, or None if the font didn't produce any pixels
    (tofu / missing glyph)."""
    scratch_w = native_size * 6
    scratch_h = native_size + native_size // 2
    scratch = Image.new("RGBA", (scratch_w, scratch_h), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(scratch)
    try:
        s_draw.text((0, 0), emoji_str, font=emoji_font, embedded_color=True)
    except TypeError:
        # Pillow < 9.2 — no embedded_color kwarg. Falls back to
        # whatever colour the font has (monochrome fonts only).
        s_draw.text((0, 0), emoji_str, font=emoji_font)
    bbox = scratch.getbbox()
    if not bbox:
        return None
    # Heuristic: detect "tofu" rectangles. A missing glyph in many
    # fonts is drawn as a small solid rectangle. We accept the render
    # if it produced something — but log a hint if the result looks
    # uniform (all one colour, suggesting a placeholder box).
    return scratch.crop(bbox)


def _render_emoji_inline(canvas, x, y, emoji_str, emoji_fonts, target_size_px):
    """Render `emoji_str` onto `canvas` at (x, y), scaled to roughly
    `target_size_px` tall.

    `emoji_fonts` is a list of (font, native_size, name) tuples — we
    try each one in order until one produces a non-empty render. This
    is the fix for "newer emojis showing as tofu": Noto Color Emoji
    might not have the rocket-with-flag variant the LLM emitted, but
    Symbola does (as a monochrome outline). Falling back automatically
    means the user never sees a tofu square unless EVERY font on the
    system lacks the glyph.

    Pipeline:
      1. For each candidate font, try rendering at its native size.
      2. Crop to the painted bounding box (alpha > 0).
      3. Resize that crop to `target_size_px` tall preserving aspect.
      4. Composite onto the main canvas.

    Returns the rendered width on the main canvas, or 0 if every
    font failed.
    """
    if not emoji_fonts or not emoji_str:
        return 0
    try:
        glyph = None
        used_font = None
        for font, native_size, name in emoji_fonts:
            try:
                glyph = _try_render_emoji_to_scratch(emoji_str, font, native_size)
                if glyph is not None:
                    used_font = name
                    break
            except Exception as e:
                # Move on to the next font candidate.
                continue
        if glyph is None:
            # Every font failed. Better to drop the emoji silently
            # than leave tofu — the surrounding text reads fine.
            print(f"⚠️ Emoji {emoji_str!r} (codepoints={[hex(ord(c)) for c in emoji_str]}) "
                  f"not in any installed emoji font — dropping from hook.")
            return 0
        gw, gh = glyph.size

        # Resize so HEIGHT matches the target. Aspect ratio preserved.
        # We target ~95% of font_size so the emoji baseline sits
        # alongside the cap-height of the surrounding text instead of
        # poking above it.
        target_h = max(1, int(target_size_px * 0.95))
        if gh != target_h:
            target_w = max(1, int(round(gw * (target_h / gh))))
            try:
                glyph = glyph.resize((target_w, target_h), Image.LANCZOS)
            except Exception:
                glyph = glyph.resize((target_w, target_h))
            gw, gh = glyph.size

        # Vertical alignment: nudge down a hair so the visual middle
        # of the emoji sits on the text's visual middle rather than
        # the top of the cap-line.
        baseline_nudge = int(target_size_px * 0.10)

        # Composite onto the main canvas. Using `paste` with the
        # glyph as its own mask preserves the bitmap's alpha.
        canvas.paste(glyph, (int(x), int(y) + baseline_nudge), glyph)
        return gw
    except Exception as e:
        print(f"⚠️ Emoji render failed for {emoji_str!r}: {e}")
        return 0

def download_font_if_needed():
    """Downloads a serif font for the hook text if not present."""
    if not os.path.exists(FONT_DIR):
        os.makedirs(FONT_DIR)
    if not os.path.exists(FONT_PATH):
        print(f"⬇️ Downloading font from {FONT_URL}...")
        try:
            # Add user agent to avoid 403s slightly
            req = urllib.request.Request(
                FONT_URL, 
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req) as response, open(FONT_PATH, 'wb') as out_file:
                out_file.write(response.read())
            print("✅ Font downloaded.")
        except Exception as e:
            print(f"❌ Failed to download font: {e}")


def download_emoji_font_if_needed():
    """Ensure at least one emoji font exists, downloading Noto Color Emoji
    into ./fonts if none is found.

    This is the DURABILITY fix for the recurring "emoji in the viral hook
    burn as a tofu block" bug. The real cause was that the base Docker image's
    `fonts-noto-color-emoji` package kept disappearing (image rebuilt from an
    older layer / restored from a backup), so at burn time Pillow had no emoji
    font and the renderer painted the emoji codepoint with the serif font —
    a .notdef box. We now keep our own emoji font next to the app (same as the
    serif hook font), so it survives any image change. No-op once on disk.
    """
    # Already have an emoji font somewhere? Nothing to do.
    for p in EMOJI_FONT_CANDIDATES:
        if os.path.isfile(p):
            return
    try:
        if not os.path.exists(FONT_DIR):
            os.makedirs(FONT_DIR)
        print("⬇️ No emoji font found — downloading Noto Color Emoji into "
              f"./{FONT_DIR} (one-time, ~11 MB)…")
        req = urllib.request.Request(EMOJI_FONT_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response, open(EMOJI_COLOR_LOCAL, 'wb') as out_file:
            out_file.write(response.read())
        print(f"✅ Emoji font ready: {EMOJI_COLOR_LOCAL}")
    except Exception as e:
        print(f"⚠️ Could not download emoji font ({e}). Emoji will be dropped "
              "from the hook (no tofu) until a font is available.")


def _hex_to_rgb(hex_str, fallback=(255, 255, 255)):
    """Tiny helper — accepts '#RRGGBB' / 'RRGGBB' / shorter forms."""
    try:
        s = (hex_str or '').strip().lstrip('#')
        if len(s) == 3:
            s = ''.join(c + c for c in s)
        if len(s) == 6:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except Exception:
        pass
    return fallback


def create_hook_image(
    text,
    target_width,
    output_image_path="hook_overlay.png",
    font_scale=1.0,
    text_color="#000000",
    bg_color="#FFFFFF",
    bg_opacity=0.94,
):
    """
    Generates a colored box with serif text using pixel-based wrapping.
    target_width:  max box width (e.g. 85% of video)
    text_color:    hex string like "#000000" — color of the rendered text
    bg_color:      hex string like "#FFFFFF" — color of the rounded box
    bg_opacity:    0.0–1.0 — alpha multiplier for the box (0.94 ≈ 240/255)
    """
    download_font_if_needed()
    download_emoji_font_if_needed()

    # Configuration
    padding_x = 30 # Balanced padding
    padding_y = 25 
    line_spacing = 20 # Increased spacing
    cornerradius = 20
    shadow_offset = (5, 5) 
    shadow_blur = 10
    
    # Font Size Calculation (approx 5% of width - tuned to match Noto Serif Bold metrics in browser)
    base_font_size = int(target_width * 0.05)
    font_size = int(base_font_size * font_scale)
    
    try:
        font = ImageFont.truetype(FONT_PATH, font_size)
    except Exception as e:
        print(f"⚠️ Warning: Could not load font {FONT_PATH}, using default. Error: {e}")
        font = ImageFont.load_default()

    # Load ALL available emoji fonts so we can fall back per-glyph when
    # one font lacks a specific codepoint. _render_emoji_inline tries
    # them in order until one produces a non-empty render. This is the
    # cure for "the rocket renders, but the saturn comes out as tofu" —
    # newer emoji often need Noto, older ones look better in Symbola.
    emoji_fonts = _load_all_emoji_fonts(font_size)
    emoji_font = emoji_fonts[0][0] if emoji_fonts else None
    if not emoji_fonts:
        # Soft warning — burn still works, emojis just won't render.
        # The Dockerfile installs fonts-noto-color-emoji so this
        # branch is mostly relevant when running outside Docker.
        print("⚠️ No emoji font found — emoji in the hook will fall back to the main font (likely tofu).")
    else:
        print(f"   Loaded {len(emoji_fonts)} emoji font(s) for hook: "
              + ", ".join(f[2] for f in emoji_fonts))

    # Width an emoji will occupy AFTER the side-canvas resize step in
    # _render_emoji_inline. Estimating it directly (without doing the
    # full render) keeps wrapping decisions cheap. Most emoji are
    # roughly square at the target text height; ZWJ family sequences
    # can be wider, but the difference is small enough that the box
    # auto-sizes via _measure_mixed afterwards.
    def _measure_emoji_target(run):
        # ~font_size × number_of_visible_glyphs. Flags = 1 visible
        # glyph from 2 codepoints, so we use grapheme count via the
        # already-stored split (each match in _EMOJI_RE is one cluster).
        return int(font_size * 0.95)

    # Helper: measure a possibly-mixed-script line correctly. Plain
    # runs measured with the serif font, emoji runs measured at the
    # POST-RESIZE width (≈ font_size each) so wrapping decisions match
    # what the renderer actually draws.
    def _measure_mixed(s):
        if not s:
            return 0
        total = 0
        for is_e, run in _split_runs(s):
            if is_e and emoji_font:
                total += _measure_emoji_target(run)
            else:
                total += _measure_run(draw, run, font)
        return total

    # Wrap text logic (Pixel-based)
    dummy_img = Image.new('RGBA', (1, 1))
    draw = ImageDraw.Draw(dummy_img)

    max_text_width = target_width - (2 * padding_x)
    
    # Handle manual newlines first
    paragraphs = text.split('\n')
    lines = []
    
    for p in paragraphs:
        if not p.strip():
            lines.append("") 
            continue
            
        words = p.split()
        current_line = []
        
        for word in words:
            # Test if adding word fits
            test_line = ' '.join(current_line + [word])
            # Mixed-script measurement — emoji glyphs are usually wider
            # than equivalent text glyphs, so this prevents overflow
            # when a hook ends in a flag or icon.
            w = _measure_mixed(test_line)

            if w <= max_text_width:
                current_line.append(word)
            else:
                # Line full, push current_line and start new
                if current_line:
                    lines.append(' '.join(current_line))
                    current_line = [word]
                else:
                    # Single word too long? Force it.
                    lines.append(word)
                    current_line = []
        
        if current_line:
            lines.append(' '.join(current_line))
    
    # Recalculate true width/height
    max_line_width = 0
    text_heights = []

    for line in lines:
        if not line:
            text_heights.append(font_size) # Use font size for empty line height
            continue

        # Use the mixed-script measurer for width so emoji-bearing
        # lines size their box correctly. Height comes from the main
        # font's metrics — emoji typically don't exceed text height.
        w = _measure_mixed(line)
        bbox = draw.textbbox((0, 0), line, font=font)
        h = bbox[3] - bbox[1]
        max_line_width = max(max_line_width, w)
        text_heights.append(h)
    
    # Box dimensions
    # We want the box to fit the text exactly + padding
    # Ensure min width for aesthetic reasons if text is short (at least 30% of target)
    box_width = max(max_line_width + (2 * padding_x), int(target_width * 0.3))
    
    # Total Text Height: sum(heights) + spacing * (n-1)
    if not text_heights:
         total_text_height = font_size
    else:
         total_text_height = sum(text_heights) + (len(text_heights) - 1) * line_spacing
         
    box_height = total_text_height + (2 * padding_y)
    
    # Create Final Image with Rounded Corners and Shadow
    # 1. Canvas for Shadow (larger than box)
    canvas_w = box_width + 40
    canvas_h = box_height + 40
    
    img = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 2. Draw Shadow
    shadow_box = [
        (20 + shadow_offset[0], 20 + shadow_offset[1]),
        (20 + box_width + shadow_offset[0], 20 + box_height + shadow_offset[1])
    ]
    draw.rounded_rectangle(shadow_box, radius=cornerradius, fill=(0, 0, 0, 100))
    
    # 3. Blur Shadow
    img = img.filter(ImageFilter.GaussianBlur(5))
    
    # 4. Draw colored box (sharper, on top of blurred shadow)
    draw_final = ImageDraw.Draw(img)

    main_box = [
        (20, 20),
        (20 + box_width, 20 + box_height)
    ]
    bg_rgb = _hex_to_rgb(bg_color, (255, 255, 255))
    bg_alpha = max(0, min(255, int(round(float(bg_opacity) * 255))))
    draw_final.rounded_rectangle(
        main_box, radius=cornerradius, fill=(bg_rgb[0], bg_rgb[1], bg_rgb[2], bg_alpha)
    )
    
    # 5. Draw Text — emoji-aware. Each line is split into runs of
    #    {is_emoji, substring}; non-emoji runs are drawn with the main
    #    font in the user's chosen colour, emoji runs are drawn with the
    #    emoji font using Pillow's `embedded_color=True` so the bitmap
    #    glyph keeps its native colour. The x cursor advances by each
    #    run's measured width so spacing matches what was measured
    #    during wrapping.
    text_rgb = _hex_to_rgb(text_color, (0, 0, 0))
    current_y = 20 + padding_y - 2  # Minor visual adjustment
    for i, line in enumerate(lines):
        if not line:
            current_y += font_size + line_spacing
            continue

        line_w = _measure_mixed(line)
        line_h = text_heights[i] if i < len(text_heights) else font_size

        # Center X for the whole line, then walk runs left-to-right.
        x = 20 + (box_width - line_w) // 2
        for is_emoji_run, run in _split_runs(line):
            if not run:
                continue
            if is_emoji_run:
                # EMOJI RUN — render with the emoji font pipeline. CRITICAL:
                # never fall through to the serif `draw.text` below for an
                # emoji, because Noto Serif has no emoji glyphs and would
                # paint a .notdef tofu box — THAT was the "emoji → block"
                # bug. If no emoji font is available, or the glyph is missing
                # in every font, we DROP the emoji (advance by its reserved
                # width so wrapping stays aligned) instead of drawing tofu.
                w = 0
                if emoji_fonts:
                    w = _render_emoji_inline(
                        img, x, current_y, run, emoji_fonts,
                        target_size_px=font_size,
                    )
                    # Refresh the draw handle — the inline renderer pasted
                    # onto the underlying image.
                    draw_final = ImageDraw.Draw(img)
                # Advance the cursor by the rendered width, or by the
                # reserved emoji width if it was dropped, so the rest of the
                # line stays where wrapping expected it.
                x += w if w else _measure_emoji_target(run)
            else:
                draw_final.text((x, current_y), run, font=font, fill=text_rgb)
                x += _measure_run(draw_final, run, font)

        current_y += line_h + line_spacing

    img.save(output_image_path)
    return output_image_path, canvas_w, canvas_h

def add_hook_to_video(
    video_path,
    text,
    output_path,
    position="top",
    font_scale=1.0,
    text_color="#000000",
    bg_color="#FFFFFF",
    bg_opacity=0.94,
    y_offset_pct=None,
    h_align="center",
    v_align=None,
    margin_x=40,
    margin_y=40,
):
    """
    Overlays text hook onto video.

    NEW flexible 2-D placement (preferred):
      h_align:  'left' | 'center' | 'right' — horizontal anchor. When left/
                right, the box hugs that edge offset by `margin_x` px.
      v_align:  'top' | 'center' | 'bottom' — vertical anchor. When top/
                bottom, the box hugs that edge offset by `margin_y` px.
      margin_x: px gap from the left/right edge (used when h_align != center).
      margin_y: px gap from the top/bottom edge (used when v_align top/bottom).
      → e.g. h_align='right', v_align='top', margin_x=50, margin_y=50 places
        the hook in the top-right corner, 50 px in from the top and right.

    LEGACY vertical placement (still honoured when v_align is None, so older
    saved hooks render unchanged):
      position:     'top', 'center', 'bottom' (used when y_offset_pct is None)
      y_offset_pct: 0–100, % from top of frame to box CENTER; overrides
                    `position` when provided.

    font_scale:   float multiplier (1.0 = default)
    text_color:   hex string for the rendered text color
    bg_color:     hex string for the rounded box behind the text
    bg_opacity:   0.0–1.0 alpha for the box
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video {video_path} not found")

    # 1. Probe video width to scale text properly
    try:
        cmd = ['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', video_path]
        res = subprocess.check_output(cmd).decode().strip()
        # Takes first stream if multiple
        dims = res.split('\n')[0].split('x')
        video_width = int(dims[0])
        video_height = int(dims[1])
    except Exception as e:
        print(f"⚠️ FFprobe failed: {e}. Assuming 1080x1920")
        video_width = 1080
        video_height = 1920
        
    # 2. Generate Image
    # Box width cap. A centred hook may span up to 90% of the frame (banner
    # style). But a hook anchored to the LEFT or RIGHT edge must be COMPACT,
    # otherwise a 90%-wide box right-anchored still spans the whole frame and
    # "top-right" looks identical to "top-centre" (the bug the user hit). Cap
    # edge-anchored hooks to ~50% so they form a real corner element.
    _edge_anchored = (h_align or "center").lower() in ("left", "right")
    target_box_width = int(video_width * (0.50 if _edge_anchored else 0.9))
    
    # Unique name in the OUTPUT video's own folder (not CWD). The old
    # basename-only name in CWD collided across concurrent burns of
    # same-basename clips (every batch has clip_00.mp4 …) — one burn would
    # delete another's overlay mid-render.
    import uuid as _uuid, tempfile as _tempfile
    _hook_dir = os.path.dirname(os.path.abspath(output_path)) or _tempfile.gettempdir()
    hook_filename = os.path.join(_hook_dir, f"temp_hook_{_uuid.uuid4().hex}.png")
    
    try:
        img_path, box_w, box_h = create_hook_image(
            text, target_box_width, hook_filename,
            font_scale=font_scale,
            text_color=text_color,
            bg_color=bg_color,
            bg_opacity=bg_opacity,
        )
        
        # 3. Calculate Overlay Position
        # --- Horizontal: left / center / right, hugging the edge by margin_x.
        _ha = (h_align or "center").lower()
        try:
            _mx = max(0, int(margin_x if margin_x is not None else 40))
        except (TypeError, ValueError):
            _mx = 40
        if _ha == "left":
            overlay_x = _mx
        elif _ha == "right":
            overlay_x = video_width - box_w - _mx
        else:
            overlay_x = (video_width - box_w) // 2
        overlay_x = max(0, min(overlay_x, max(0, video_width - box_w)))

        # --- Vertical: prefer the explicit v_align anchor (new model), then
        # fall back to the legacy y_offset_pct slider, then position presets.
        try:
            _my = max(0, int(margin_y if margin_y is not None else 40))
        except (TypeError, ValueError):
            _my = 40
        _va = (v_align or "").lower()
        if _va in ("top", "center", "bottom"):
            if _va == "top":
                overlay_y = _my
            elif _va == "bottom":
                overlay_y = video_height - box_h - _my
            else:
                overlay_y = (video_height - box_h) // 2
        elif y_offset_pct is not None:
            # Custom slider — % from top of frame to box CENTER.
            pct = max(0.0, min(100.0, float(y_offset_pct))) / 100.0
            target_center_y = int(video_height * pct)
            overlay_y = target_center_y - box_h // 2
        elif position == "center":
            overlay_y = (video_height - box_h) // 2
        elif position == "bottom":
            # Bottom 25% mark — center of box at ~75% from top.
            overlay_y = max(0, int(video_height * 0.75) - box_h // 2)
        else:
            # 'top' — center of box at ~20% from top.
            overlay_y = max(0, int(video_height * 0.20) - box_h // 2)
        # Clamp so the box always stays fully on-screen.
        overlay_y = max(0, min(overlay_y, max(0, video_height - box_h)))
        
        # 4. FFmpeg Command
        print(f"🎬 Overlaying hook: '{text}' at {overlay_x},{overlay_y}")
        
        ffmpeg_cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', img_path,
            '-filter_complex', f"[0:v][1:v]overlay={overlay_x}:{overlay_y}",
            '-c:a', 'copy',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
            output_path
        ]
        
        subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        print(f"✅ Hook added to {output_path}")
        return True
        
    except subprocess.CalledProcessError as e:
        print(f"❌ FFmpeg Error: {e.stderr.decode() if e.stderr else 'Unknown'}")
        raise e
    except Exception as e:
        print(f"❌ Hook Gen Error: {e}")
        raise e
    finally:
        # Cleanup temp image
        if os.path.exists(hook_filename):
            os.remove(hook_filename)
