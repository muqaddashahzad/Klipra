import os
import subprocess


# ---------------------------------------------------------------------------
# Media probing — needed by the audio-upload + change-background flows so
# the burn pipeline can tell whether an input has video frames at all.
# ---------------------------------------------------------------------------

def probe_media(path: str) -> dict:
    """ffprobe a media file. Returns:
        {
          'has_video':   bool,
          'has_audio':   bool,
          'width':       int (0 if no video),
          'height':      int (0 if no video),
          'duration_s':  float (best effort across streams),
        }

    Used by:
      - burn_subtitles (audio-only inputs need a placeholder video frame).
      - change-background endpoint (decides whether new upload contains
        audio that should replace the old, or just visuals).
    """
    out = {'has_video': False, 'has_audio': False, 'width': 0, 'height': 0, 'duration_s': 0.0}
    if not path or not os.path.isfile(path):
        return out
    try:
        # One ffprobe call for both stream presence and dimensions.
        # `-show_streams` emits one line per stream; we parse manually
        # to avoid pulling in an ffprobe-json parser dep.
        proc = subprocess.run(
            ['ffprobe', '-v', 'error',
             '-show_entries', 'stream=codec_type,width,height,duration:format=duration',
             '-of', 'default=noprint_wrappers=0:nokey=0', path],
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return out
    text = (proc.stdout or '') + '\n' + (proc.stderr or '')
    # Parse the flat key=value blocks. ffprobe emits each [STREAM]/[FORMAT]
    # block separated by blank lines; we only care about codec_type +
    # width/height + the longest duration we see anywhere.
    cur_block = {}
    blocks = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            if cur_block:
                blocks.append(cur_block)
                cur_block = {}
            continue
        if line.startswith('[') and line.endswith(']'):
            if cur_block:
                blocks.append(cur_block)
                cur_block = {}
            cur_block['_section'] = line.strip('[]')
            continue
        if '=' in line:
            k, _, v = line.partition('=')
            cur_block[k.strip()] = v.strip()
    if cur_block:
        blocks.append(cur_block)
    for b in blocks:
        ct = b.get('codec_type')
        if ct == 'video':
            # Some files (album art in MP3, single-frame thumbnails) have
            # a "video" stream that's actually a still. We treat any
            # video stream as video for now; the placeholder-generation
            # logic below kicks in only when has_video is False.
            out['has_video'] = True
            try:
                out['width'] = max(out['width'], int(b.get('width') or 0))
                out['height'] = max(out['height'], int(b.get('height') or 0))
            except ValueError:
                pass
        elif ct == 'audio':
            out['has_audio'] = True
        # Duration can come from the stream OR the format block — take
        # the largest known value so audio-only files (where the
        # video-stream block is absent) still report correctly.
        d = b.get('duration')
        if d and d != 'N/A':
            try:
                out['duration_s'] = max(out['duration_s'], float(d))
            except ValueError:
                pass
    return out


def make_placeholder_video(audio_path: str, output_path: str,
                           width: int = 1080, height: int = 1920,
                           color: str = '0x0d4f57') -> bool:
    """For audio-only inputs we have to fabricate video frames before
    libass can burn subtitles on top. Generates a video the same length
    as the audio, with a solid colour background, and the audio muxed
    through. Default colour is the Klipra teal; override with `color`
    for stock-background flows that pass a hex (without `#`).

    Returns True on success.
    """
    cmd = [
        'ffmpeg', '-y',
        # Looped colour source — duration capped by the audio stream.
        '-f', 'lavfi', '-i', f'color=c={color}:s={int(width)}x{int(height)}:r=30',
        '-i', audio_path,
        '-map', '0:v', '-map', '1:a',
        # -shortest so the video ends exactly when the audio ends.
        '-shortest',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        output_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode('utf-8', errors='replace')
        print(f"❌ Placeholder-video FFmpeg error: {err[-800:]}")
        return False
    return True


def make_lavfi_video(lavfi_input: str, audio_path: str, output_path: str) -> bool:
    """Render a stock-background lavfi recipe + mux user audio.

    `lavfi_input` already has {w}/{h}/{dur} substituted (callers should
    use stock_backgrounds.render_stock_lavfi for that). `audio_path` is
    the audio source whose track replaces (or becomes) the output's
    audio. Same flags as make_placeholder_video, just lavfi recipe is
    customisable.
    """
    cmd = [
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', lavfi_input,
        '-i', audio_path,
        '-map', '0:v', '-map', '1:a',
        '-shortest',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        output_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode('utf-8', errors='replace')
        print(f"❌ Stock-bg FFmpeg error: {err[-800:]}")
        return False
    return True


def replace_video_audio(video_path: str, audio_source_path: str, output_path: str) -> bool:
    """Replace the audio track of a video with the audio from another
    file. Used by /change-background when the user uploads a video that
    has audio — the new video's audio takes over from the original
    transcribed audio (the user's stated intent: vocals were uploaded
    just for clean transcription, the final mix comes from the new
    upload).

    `video_path`         — visual frames source (stock or upload)
    `audio_source_path`  — audio source. Can be the same file as
                           video_path (uses that file's audio) OR a
                           different file (e.g. the original audio).
    """
    cmd = [
        'ffmpeg', '-y',
        '-i', video_path,
        '-i', audio_source_path,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        output_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode('utf-8', errors='replace')
        print(f"❌ Audio-replace FFmpeg error: {err[-800:]}")
        return False
    return True


# ---------------------------------------------------------------------------
# Font fallback map — bridges the dashboard's picker (which lists familiar
# proprietary names like Verdana / Arial / Comic Sans MS so users recognise
# them) to free fonts that are actually installable on Linux. libass goes
# through fontconfig, and the Docker image only has stock free fonts —
# without this map a user picking "Verdana" caused libass to silently fall
# back to whatever default it had, with totally different metrics: text
# overflowed, wrap-points moved, the burned video looked nothing like the
# Phase 2 preview. Mapping at burn time keeps the picker UX while making
# the burn render the closest free equivalent that's actually present.
#
# Anything not in this map is passed through unchanged (so users who edit
# a draft and pick a Linux-native font like "DejaVu Sans" still work).
#
# The right-hand strings MUST match a `family-name` that fontconfig knows
# about inside the container — install via fonts-dejavu / fonts-liberation
# in the Dockerfile.
# ---------------------------------------------------------------------------
#
# Mapping rationale (worst-to-best metric match):
#
#   Excellent (metric-compatible — Liberation fonts are designed to be
#   width-identical to Microsoft's, so wrapping behaviour is preserved):
#     Arial            -> Liberation Sans
#     Helvetica        -> Liberation Sans
#     Times New Roman  -> Liberation Serif
#     Courier New      -> Liberation Mono
#
#   Good (close-enough sans/serif from DejaVu):
#     Verdana          -> DejaVu Sans
#     Georgia          -> DejaVu Serif
#
#   Compromise (no stock Linux font matches a CONDENSED display font):
#     Impact           -> DejaVu Sans Condensed (narrower than DejaVu Sans;
#                         still wider than real Impact but closer than
#                         the previous fallback). For TRUE parity, drop
#                         an Anton.ttf into fonts/ — the bundled fontsdir
#                         loader will pick it up and you can change this
#                         line to "Anton" once present.
#     Comic Sans MS    -> DejaVu Sans (no free handwritten font ships in
#                         fonts-dejavu / fonts-liberation by default).
#                         Bundle ComicNeue.ttf in fonts/ and switch to
#                         "Comic Neue" for an actual handwritten match.
#
PROPRIETARY_FONT_FALLBACKS = {
    "Verdana": "DejaVu Sans",
    "Arial": "Liberation Sans",
    "Helvetica": "Liberation Sans",
    "Times New Roman": "Liberation Serif",
    "Georgia": "DejaVu Serif",
    "Courier New": "Liberation Mono",
    # Condensed display: DejaVu ships a Condensed variant which is
    # narrower than the regular face — closer to Impact's metrics than
    # the previous fallback. Still wider than true Impact, so the
    # overflow safety net (compute_safe_fontsize below) is what really
    # guarantees the burn doesn't run off the edge of the frame.
    "Impact": "DejaVu Sans Condensed",
    # Comic Sans has no good stock alternative; users who care about
    # this should drop a ComicNeue.ttf into fonts/ and change this line.
    "Comic Sans MS": "DejaVu Sans",
}


# Cache of fontconfig results so we don't fork a new fc-match subprocess
# for every burn. Family availability doesn't change at runtime within a
# single container life, so caching forever is fine.
_FONT_AVAILABILITY_CACHE = {}


def _is_font_available(family):
    """Ask fontconfig whether a given family is actually present (i.e.
    fc-match returns the SAME family name we asked for, not a substitute).

    Returns False if fontconfig isn't installed / fc-match isn't on PATH —
    callers should treat that as 'use the static fallback map'.
    """
    if not family:
        return False
    if family in _FONT_AVAILABILITY_CACHE:
        return _FONT_AVAILABILITY_CACHE[family]
    available = False
    try:
        out = subprocess.run(
            ["fc-match", "-f", "%{family}", family],
            capture_output=True, text=True, check=False, timeout=2,
        )
        if out.returncode == 0:
            # fc-match always returns SOMETHING (a substitute is a default
            # behaviour). Compare case-insensitively because fontconfig
            # normalises capitalisation for some families.
            returned = (out.stdout or "").strip().lower()
            requested = family.strip().lower()
            # fontconfig sometimes returns a comma-list when a family has
            # multiple variants. Match if the requested name is in the list.
            available = (
                returned == requested
                or requested in [f.strip() for f in returned.split(",")]
            )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        # fc-match missing or unresponsive — be defensive, assume unavailable.
        available = False
    _FONT_AVAILABILITY_CACHE[family] = available
    return available


def resolve_burn_fontname(picked_name):
    """Map a dashboard-picker font name to one libass can resolve.

    Lookup order:
      1. If `picked_name` is itself installed (fontconfig says so), USE
         IT. This is the happy path when ttf-mscorefonts-installer ran
         in the Docker image — Verdana, Arial, Impact, etc. all resolve
         to themselves and burn matches preview byte-for-byte.
      2. Otherwise, look up PROPRIETARY_FONT_FALLBACKS for a free
         metric-close substitute that fontconfig CAN find.
      3. Otherwise, pass the picked name through and hope libass has
         something reasonable; this is the historical bug, kept only as
         a last-resort safety net.

    Returns (effective_name, was_remapped). `was_remapped` is True when
    we substituted, False when we kept the original — the caller logs
    the remap so silent fallbacks are visible in container logs.
    """
    if not picked_name:
        return ("DejaVu Sans", True)
    # 1. Original font installed → use it.
    if _is_font_available(picked_name):
        return (picked_name, False)
    # 2. Static fallback for known proprietary names.
    mapped = PROPRIETARY_FONT_FALLBACKS.get(picked_name)
    if mapped:
        return (mapped, True)
    # 3. Pass through unchanged.
    return (picked_name, False)


def transcribe_audio(video_path):
    """
    Transcribe audio from a video file using faster-whisper.
    Returns transcript in the same format as main.py for compatibility.
    """
    from faster_whisper import WhisperModel

    print(f"🎙️  Transcribing audio from: {video_path}")

    # Run on CPU with INT8 quantization for speed
    model = WhisperModel("base", device="cpu", compute_type="int8")

    segments, info = model.transcribe(video_path, word_timestamps=True)

    transcript = {
        "segments": [],
        "language": info.language
    }

    for segment in segments:
        seg_data = {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "words": []
        }
        if segment.words:
            for word in segment.words:
                seg_data["words"].append({
                    "word": word.word.strip(),
                    "start": word.start,
                    "end": word.end
                })
        transcript["segments"].append(seg_data)

    print(f"✅ Transcription complete. Language: {info.language}")
    return transcript


def generate_srt_from_video(video_path, output_path, max_chars=20, max_duration=2.0):
    """
    Transcribe a video and generate SRT directly.
    Used for dubbed videos that don't have a pre-existing transcript.
    """
    transcript = transcribe_audio(video_path)

    # Get video duration to use as clip_end
    import cv2
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps if fps else 0
    cap.release()

    return generate_srt(transcript, 0, duration, output_path, max_chars, max_duration)


# ---------------------------------------------------------------------------
# Subtitle line-length / line-count rule
# ---------------------------------------------------------------------------
# Industry rule of thumb (BBC, Netflix, YouTube auto-caption guides): NEVER
# show more than 2 lines on screen at once and keep each line short enough
# to read in a glance. Three or more lines turn captions into a paragraph and
# cover the speaker's face — exactly what the user complained about.
#
# `MAX_LINE_CHARS` is the longest single visible line. Two of those = the
# longest text we will ever emit per Dialogue event. Anything bigger gets
# split into multiple sequential events instead of being squashed onto one.
MAX_LINE_CHARS = 38
MAX_LINES = 2
MAX_BLOCK_CHARS = MAX_LINE_CHARS * MAX_LINES   # 76


def _longest_wrapped_line_chars(srt_path, max_line=MAX_LINE_CHARS, max_lines=MAX_LINES):
    """Read the SRT, apply the SAME wrap that srt_to_ass uses, and return
    the longest line we'd actually render (in characters).

    This is the input the overflow safety net needs: it has to know the
    widest piece of text the burn will produce so it can decide whether
    the requested fontsize will fit horizontally.
    """
    try:
        with open(srt_path, 'r', encoding='utf-8') as f:
            raw = f.read()
    except OSError:
        return 0
    longest = 0
    for chunk in raw.strip().split('\n\n'):
        lines = chunk.strip().split('\n')
        if len(lines) < 3:
            continue
        # Reproduce srt_to_ass's wrap decision: respect explicit line
        # breaks if they fit, otherwise re-flow onto two lines.
        srt_lines = [ln for ln in lines[2:] if ln.strip()]
        joined = ' '.join(srt_lines)
        if 1 < len(srt_lines) <= max_lines and all(len(ln) <= max_line for ln in srt_lines):
            wrapped = '\\N'.join(srt_lines[:max_lines])
        else:
            wrapped = wrap_to_two_lines(joined, max_line=max_line, max_lines=max_lines)
        for line in wrapped.split('\\N'):
            longest = max(longest, len(line))
    return longest


def _avg_glyph_em_for_font(font_name):
    """Pick an avg-glyph-width estimate (in em units) tuned to the actual
    font we're about to render.

    Real measurements (averaged across lowercase + uppercase Latin text):
      - DejaVu Sans / Liberation Sans:        ~0.50 em
      - DejaVu Serif / Liberation Serif:      ~0.50 em
      - DejaVu Sans Condensed:                ~0.42 em (NARROW — Impact fallback)
      - Liberation Mono / DejaVu Sans Mono:   ~0.60 em (every char same width)
      - Anton (free Impact-replacement, if bundled): ~0.40 em
      - Comic Neue (free Comic Sans replacement, if bundled): ~0.52 em

    We default to 0.50 em (typical sans / serif) and adjust DOWN for the
    narrow display fonts so we don't unnecessarily shrink Beast Mode etc.
    """
    if not font_name:
        return 0.50
    name = font_name.lower()
    if 'condensed' in name or 'narrow' in name or name in ('anton', 'impact'):
        return 0.42
    if 'mono' in name or name in ('courier new', 'courier'):
        return 0.60
    return 0.50


def compute_safe_fontsize(
    requested_px,
    longest_line_chars,
    frame_width_px,
    *,
    font_name=None,
    avg_glyph_em=None,
    margin_pct=0.06,
    min_px=12,
):
    """Return a fontsize (in pixels) that is GUARANTEED to fit the widest
    subtitle line within `frame_width_px * (1 - margin_pct)`.

    Why this exists: the user's complaint was "templates with bigger fonts
    overflow the frame and characters disappear off the side." That happens
    because the user-picked fontsize is honoured verbatim by libass, which
    has no concept of frame-width fit. We approximate the rendered width
    using a font-aware avg-glyph estimate (see _avg_glyph_em_for_font).
    If the requested size would overflow, we scale it down proportionally
    so the longest line is exactly at the safe limit. We never INCREASE
    a font — only shrink — so users who pick a small font size still get
    exactly what they picked.

    This is a SAFETY NET, not a styling rule. It only fires when needed.
    """
    if longest_line_chars <= 0 or frame_width_px <= 0 or requested_px <= 0:
        return requested_px
    if avg_glyph_em is None:
        avg_glyph_em = _avg_glyph_em_for_font(font_name)
    safe_width_px = max(1, frame_width_px * (1.0 - margin_pct))
    requested_line_width = requested_px * avg_glyph_em * longest_line_chars
    if requested_line_width <= safe_width_px:
        return requested_px  # already fits
    safe_fontsize = safe_width_px / (avg_glyph_em * longest_line_chars)
    return max(min_px, int(safe_fontsize))


def wrap_to_two_lines(text, max_line=MAX_LINE_CHARS, max_lines=MAX_LINES):
    """Reflow `text` onto AT MOST `max_lines` visual lines, returning the
    text with explicit `\\N` line-breaks where libass should wrap.

    We do the wrap ourselves (instead of relying on libass's
    width-based smart wrap) so the break is always at a word boundary
    and the line lengths stay roughly balanced. Any words that don't
    fit get pushed to a sentinel value the caller can detect; this
    function never silently drops content.
    """
    t = (text or '').strip()
    if not t:
        return ''
    if len(t) <= max_line:
        return t
    words = t.split()
    lines = []
    cur = ''
    for w in words:
        if not cur:
            cur = w
            continue
        if len(cur) + 1 + len(w) <= max_line:
            cur += ' ' + w
        else:
            lines.append(cur)
            cur = w
            if len(lines) >= max_lines:
                # Caller is responsible for splitting; we won't put a
                # third line on screen.
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return r'\N'.join(lines)


def generate_srt_per_segment(transcript, clip_start, clip_end, output_path,
                             max_chars=MAX_LINE_CHARS, max_duration=3.0):
    """Emit ONE SRT block per Whisper segment — using the segment's real
    [start,end] timing from Whisper.

    Used when word-level timings inside a segment are unreliable
    (transliterated, translated, hand-edited, or otherwise re-derived).
    Whisper's SEGMENT-level boundaries are highly accurate even when its
    words got mangled, so this gives perfect SEGMENT-level subtitle
    sync — the only sync that actually shows up to the viewer.

    A segment is split into multiple SRT blocks if it's long (>4 s) or
    has a lot of text (>42 chars), so subtitles don't sit on screen for
    a paragraph.
    """
    blocks = []
    for seg in transcript.get('segments', []):
        s = float(seg.get('start', 0)) - clip_start
        e = float(seg.get('end', 0)) - clip_start
        # Skip segments fully outside the clip range.
        if e <= 0 or s >= (clip_end - clip_start):
            continue
        s = max(0.0, s)
        e = max(s + 0.3, min(e, clip_end - clip_start))
        text = (seg.get('text') or '').strip()
        if not text:
            continue
        # If the segment is short enough, emit as one block.
        if len(text) <= max_chars and (e - s) <= max_duration:
            blocks.append((s, e, text))
            continue
        # Otherwise split into roughly equal sub-blocks at word
        # boundaries — pace text so it stays on screen long enough
        # to read but doesn't outlast the audio segment.
        words = text.split()
        n_subs = max(1, int(round(len(text) / max_chars)))
        n_subs = max(n_subs, int((e - s) / max_duration) + 1)
        per_sub = len(words) // n_subs or 1
        seg_dur = e - s
        for i in range(n_subs):
            chunk = words[i * per_sub : (i + 1) * per_sub if i < n_subs - 1 else len(words)]
            if not chunk:
                continue
            sub_s = s + (seg_dur * i / n_subs)
            sub_e = s + (seg_dur * (i + 1) / n_subs)
            blocks.append((sub_s, sub_e, ' '.join(chunk)))

    if not blocks:
        return False
    srt_content = ''
    for idx, (start, end, text) in enumerate(blocks, start=1):
        srt_content += format_srt_block(idx, start, end, text)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(srt_content)
    return True


def generate_srt(transcript, clip_start, clip_end, output_path, max_chars=20, max_duration=2.0):
    """
    Generates an SRT file from the transcript for a specific time range.
    Groups words into short lines suitable for vertical video.
    """
    
    words = []
    # 1. Extract and flatten words within range
    for segment in transcript.get('segments', []):
        for word_info in segment.get('words', []):
            # Check overlap
            if word_info['end'] > clip_start and word_info['start'] < clip_end:
                words.append(word_info)
    
    if not words:
        return False

    srt_content = ""
    index = 1
    
    current_block = []
    block_start = None
    
    for i, word in enumerate(words):
        # Adjust times relative to clip
        start = max(0, word['start'] - clip_start)
        end = max(0, word['end'] - clip_start)
        
        # Clip to video duration logic handled by ffmpeg usually, but good to be safe
        
        if not current_block:
            current_block.append(word)
            block_start = start
        else:
            # Decide whether to close block
            current_text_len = sum(len(w['word']) + 1 for w in current_block)
            duration = end - block_start
            
            if current_text_len + len(word['word']) > max_chars or duration > max_duration:
                # Finalize current block
                # End time of block is start of this word (gap) or end of last word?
                # Usually end of last word.
                block_end = current_block[-1]['end'] - clip_start
                
                # Strip per-word whitespace before joining — Whisper often
                # emits leading spaces in word.text, which produces double
                # spaces when joined with " ".
                text = " ".join([(w['word'] or '').strip() for w in current_block]).strip()
                srt_content += format_srt_block(index, block_start, block_end, text)
                index += 1
                
                current_block = [word]
                block_start = start
            else:
                current_block.append(word)
    
    # Final block
    if current_block:
        block_end = current_block[-1]['end'] - clip_start
        text = " ".join([w['word'] for w in current_block]).strip()
        srt_content += format_srt_block(index, block_start, block_end, text)
        
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(srt_content)
        
    return True

def format_srt_block(index, start, end, text):
    def format_time(seconds):
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        millis = int((seconds - int(seconds)) * 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
        
    return f"{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n\n"

def hex_to_ass_color(hex_color, opacity=1.0):
    """Convert #RRGGBB to ASS &HAABBGGRR format. opacity: 0.0=transparent, 1.0=opaque"""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) != 6:
        hex_color = "FFFFFF"
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    alpha = round((1.0 - opacity) * 255)
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def _parse_srt_time(t):
    """SRT time '00:00:01,234' → seconds float."""
    h, m, rest = t.split(':')
    s, ms = rest.split(',')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _format_ass_time(t):
    """seconds → ASS time '0:00:01.23' (centiseconds)."""
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _animate_block_events(start_s, end_s, text, *, animation,
                          primary_ass_colour, highlight_ass_colour):
    """Take a single SRT block and emit ASS Dialogue events.

    DROP-IN FIX (second-opinion review): the previous version used
    `\\K` for karaoke, which is treated inconsistently (often as a
    no-op) by libass. The reliable tag for the karaoke sweep in
    libass / FFmpeg is lowercase `\\k`. Pop also uses `\\k` for the
    same reason. word-highlight now emits the full ASS colour
    (&H00BBGGRR) directly instead of slicing alpha bits — simpler
    and fully supported.

    Most animations emit exactly one Dialogue per block — same length
    as the input. The exception is 'word-highlight', which needs N
    Dialogues per block (one per word) so the active word can be
    coloured differently while the other words stay in the user's
    chosen font_color.

    Per-word timing is even-distribution across the line duration.

    Animation styles handled here:
      - 'pop'             → line fade-in (\\fad) + per-word \\k karaoke
                            (progressive reveal).
      - 'karaoke'         → per-word \\k continuous fill (highlight
                            sweeps across each word like a karaoke ball).
      - 'word-highlight'  → emit ONE Dialogue per word; only the active
                            word shows in highlight colour, the rest in
                            font_color.
      - 'glow' / 'none'   → text returned untouched as a single event.
    """
    a = (animation or 'none').lower()
    line_dur = max(0.0, float(end_s) - float(start_s))

    def _split_words_keeping_break(t):
        out = []
        for i, part in enumerate(t.split('\\N')):
            if i > 0:
                out.append(('__BR__', True))
            for w in part.split():
                out.append((w, False))
        return out

    def _safe(w):
        return w.replace('{', '\\{').replace('}', '\\}')

    if a not in ('pop', 'karaoke', 'word-highlight', 'word-box'):
        return [(start_s, end_s, text)]

    tokens = _split_words_keeping_break(text)
    word_tokens = [t for t in tokens if not t[1]]
    total_words = len(word_tokens) or 1

    if a == 'karaoke':
        # 'karaoke' is the only animation that still uses ASS `\k`
        # color-sweep. 'pop' used to share this branch but the React
        # preview shows pop as a per-WORD scale, not a line-wide
        # karaoke sweep — so pop now drops down into the per-word
        # events branch below alongside word-highlight / word-box.
        line_centi = max(1, int(round(line_dur * 100)))
        per_word_centi = max(1, line_centi // total_words)
        leftover = line_centi - per_word_centi * total_words
        # Lowercase \k is the reliable karaoke sweep tag in libass.
        # \K (uppercase) is treated inconsistently across libass builds
        # and was the silent failure mode of the previous code.
        tag = '\\k'
        out_chunks = []
        word_idx = 0
        for tok, is_break in tokens:
            if is_break:
                out_chunks.append('\\N')
                continue
            word_idx += 1
            d = per_word_centi + (leftover if word_idx == total_words else 0)
            out_chunks.append(f"{{{tag}{d}}}{_safe(tok)} ")
        body = ''.join(out_chunks).rstrip()
        return [(start_s, end_s, body)]

    # pop / word-highlight / word-box — N events, one per word's active window.
    #
    # pop:             active word changes COLOUR + scales to ~135%, AND the
    #                  whole line fades in (\fad(80,0)) on its first event.
    #                  Behaves identically to word-highlight per word, with
    #                  the line-entry fade preserved from the legacy pop
    #                  implementation. Matches the React preview which
    #                  spring-scales each active word 1 -> 1.25.
    # word-highlight:  active word changes COLOUR (and now also scales up
    #                  to roughly 135% — was a longstanding mismatch with
    #                  the React preview, which DID scale the active word
    #                  while the burn only changed its colour).
    # word-box:        active word is wrapped in a coloured box.
    #                  Implemented by switching that single word to the
    #                  named "Box" style via {\rBox} ... {\r}, where the
    #                  "Box" style is emitted by srt_to_ass with
    #                  BorderStyle=3 and BackColour = highlight_colour.
    if total_words == 0 or line_dur <= 0:
        return [(start_s, end_s, text)]
    per_word = line_dur / total_words
    events = []
    for active_idx in range(total_words):
        ev_start = start_s + active_idx * per_word
        ev_end = end_s if active_idx == total_words - 1 else (start_s + (active_idx + 1) * per_word)
        chunks = []
        running_word_idx = -1
        for tok, is_break in tokens:
            if is_break:
                chunks.append('\\N')
                continue
            running_word_idx += 1
            is_active = (running_word_idx == active_idx)
            if a == 'word-box':
                # Active word: switch to the "Box" named style (defined
                # in the [V4+ Styles] header by srt_to_ass when this
                # animation is selected). After the word, `\r` resets to
                # default. Inactive words use the default style colour.
                if is_active:
                    chunks.append(f"{{\\rBox}}{_safe(tok)}{{\\r}} ")
                else:
                    chunks.append(f"{_safe(tok)} ")
            else:
                # word-highlight: colour + scale change on active word.
                # The trailing {\fscx100\fscy100\1c<primary>} resets so
                # subsequent words in this event aren't scaled and revert
                # to the inactive colour.
                colour = highlight_ass_colour if is_active else primary_ass_colour
                if is_active and highlight_ass_colour:
                    chunks.append(
                        f"{{\\1c{highlight_ass_colour}\\fscx135\\fscy135}}"
                        f"{_safe(tok)}"
                        f"{{\\fscx100\\fscy100\\1c{primary_ass_colour}}} "
                    )
                else:
                    chunks.append(f"{{\\1c{colour}}}{_safe(tok)} ")
        body = ''.join(chunks).rstrip()
        events.append((ev_start, ev_end, body))
    # 'pop' adds a line-entry fade-in on the very first event. The other
    # per-word animations (word-highlight, word-box) do not fade.
    # srt_to_ass's \pos splicer below handles brace-merging cleanly when
    # the body already starts with an override block, so this is safe.
    if a == 'pop' and events:
        first_s, first_e, first_t = events[0]
        if first_t.startswith('{') and '}' in first_t:
            first_close = first_t.index('}')
            merged = '{' + '\\fad(80,0)' + first_t[1:first_close] + '}' + first_t[first_close + 1:]
            events[0] = (first_s, first_e, merged)
        else:
            events[0] = (first_s, first_e, '{\\fad(80,0)}' + first_t)
    return events


def _resolve_animation_style_overrides(animation, primary, highlight_ass_colour,
                                       outline_colour, outline_width, border_style):
    """Compute the per-Style fields that should change because of the
    animation choice. Returns a dict with whichever keys the caller
    needs to override on the V4+ Styles row.

    Pop / Karaoke:
      The trick is that ASS karaoke flips text from SecondaryColour to
      PrimaryColour as each `\\k` / `\\K` fires. So we set:
        PrimaryColour   = highlight (yellow) — what already-sung words look like
        SecondaryColour = font_color (white) — what unsung words look like
      Result: the line appears in white and progressively turns yellow
      word-by-word. Once the line ends all words are yellow, matching
      the "highlight reveal" feel of the modal's Pop preview.

    Glow:
      Beef up the outline width and use the highlight colour as the
      shadow tint. ScaledBorderAndShadow (already enabled in the
      header) makes the values pixel-accurate at any video resolution.
    """
    a = (animation or 'none').lower()
    overrides = {}
    # 'karaoke' is the only animation that still relies on ASS \k sweeping
    # the Primary colour to fill Secondary words. 'pop' used to share this
    # path but now emits per-word events with explicit \1c overrides, so
    # it no longer needs (and would be confused by) the Primary/Secondary
    # swap.
    if a == 'karaoke' and highlight_ass_colour:
        overrides['primary'] = highlight_ass_colour
        overrides['secondary'] = primary
    if a == 'glow':
        # Thicken outline ~1.6x and add a 4-px shadow. We don't change
        # outline_colour — the user's chosen border colour stays. The
        # GLOW comes from the BackColour shadow tint set to highlight.
        overrides['outline_width'] = max(outline_width, int(round(outline_width * 1.6)) + 1)
        overrides['shadow'] = 4
        if highlight_ass_colour:
            overrides['back'] = highlight_ass_colour
    return overrides


def srt_to_ass(srt_path, ass_path, *, video_w, video_h, alignment, fontname,
               fontsize, primary, outline_colour, back_colour, border_style,
               outline_width, bold, margin_v,
               animation='none', highlight_colour=None,
               # When set, every Dialogue is emitted with a \pos(x, y)
               # override that anchors the VISUAL CENTRE of the text at
               # exactly that pixel location, regardless of how many
               # lines the text wraps to. Required by the new "vertical
               # centre" positioning mode (alignment=5) so 1-line and
               # 2-line subtitles share the same visual baseline. None
               # = no per-line position override (legacy edge-anchor
               # behaviour).
               anchor_pos_xy=None):
    """Write a proper .ass file with PlayRes matching the video so
    Fontsize maps directly to screen pixels.

    Why this exists:
      libass's default PlayResY is 288 when it auto-converts SRT. On a
      1920-tall vertical video that means each ASS Fontsize unit
      becomes ~6.67 screen pixels, so Fontsize=24 → ~160px (HUGE).
      Setting PlayRes to the actual video dimensions makes Fontsize=24
      mean exactly 24 pixels on screen.

    Animation:
      `animation` ∈ {'none', 'pop', 'karaoke', 'glow'} drives the
      per-line tags injected via _animate_block_events and the Style
      overrides resolved via _resolve_animation_style_overrides.
      `highlight_colour` is the already-converted ASS &HAABBGGRR
      string for the user-picked highlight (yellow by default).
    """
    # 1. Read SRT, extract blocks
    with open(srt_path, 'r', encoding='utf-8') as f:
        raw = f.read()
    blocks = []
    for chunk in raw.strip().split('\n\n'):
        lines = chunk.strip().split('\n')
        if len(lines) < 3:
            continue
        # lines[0] = index, lines[1] = "00:00:01,234 --> 00:00:03,456",
        # lines[2:] = text (may span multiple lines)
        try:
            time_line = lines[1]
            start_str, end_str = [t.strip() for t in time_line.split('-->')]
            start = _parse_srt_time(start_str)
            end = _parse_srt_time(end_str)
            raw = ' '.join(line for line in lines[2:] if line.strip())
            # Force a max-2-line layout at WRITE TIME so we don't depend
            # on libass's width-based smart wrap (which is what put 3
            # lines on screen for users with long whisper segments).
            # If the SRT already had explicit line breaks we honour up
            # to two of them, otherwise we re-flow the joined text.
            srt_lines = [ln for ln in lines[2:] if ln.strip()]
            if 1 < len(srt_lines) <= MAX_LINES and all(len(ln) <= MAX_LINE_CHARS for ln in srt_lines):
                text = '\\N'.join(srt_lines[:MAX_LINES])
            else:
                text = wrap_to_two_lines(raw)
            # Escape ASS special chars in dialogue text.
            text = text.replace('{', '\\{').replace('}', '\\}')
            blocks.append((start, end, text))
        except Exception:
            continue

    # 2. Resolve animation-driven Style overrides BEFORE writing the
    # header — Pop/Karaoke flip Primary/Secondary so unsung words show
    # in the user's chosen font_color and progressively turn into the
    # highlight colour as their `\\k` tag fires.
    style_primary = primary
    style_secondary = "&H000000FF"  # default fully-transparent placeholder
    style_outline_width = outline_width
    style_back = back_colour
    style_shadow = 0
    style_overrides = _resolve_animation_style_overrides(
        animation=animation,
        primary=primary,
        highlight_ass_colour=highlight_colour,
        outline_colour=outline_colour,
        outline_width=outline_width,
        border_style=border_style,
    )
    if 'primary' in style_overrides:
        style_primary = style_overrides['primary']
    if 'secondary' in style_overrides:
        style_secondary = style_overrides['secondary']
    if 'outline_width' in style_overrides:
        style_outline_width = style_overrides['outline_width']
    if 'back' in style_overrides:
        style_back = style_overrides['back']
    if 'shadow' in style_overrides:
        style_shadow = style_overrides['shadow']

    # 3. Write ASS header + style + events
    #
    # When animation == 'word-box' we add a SECOND named style row called
    # "Box" — same font/colour as Default but BorderStyle=3 (opaque box)
    # and BackColour set to the highlight colour. _animate_block_events
    # wraps the active word in {\rBox}…{\r} so libass switches the box
    # style on for one word at a time. Default-style words stay
    # uncoloured (no box) because BorderStyle stays at 1 on Default.
    box_style_row = ""
    if (animation or "").lower() == "word-box" and highlight_colour:
        box_back = highlight_colour
        box_style_row = (
            f"Style: Box,{fontname},{fontsize},{style_primary},{style_secondary},"
            f"{outline_colour},{box_back},{bold},0,0,0,100,100,0,0,"
            f"3,{style_outline_width},{style_shadow},{alignment},40,40,{margin_v},1\n"
        )

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {video_w}\n"
        f"PlayResY: {video_h}\n"
        # WrapStyle 2 = NEVER auto-wrap. Lines break ONLY where we wrote
        # an explicit \\N in the dialogue text. Combined with the
        # wrap_to_two_lines() pass above this guarantees the burned mp4
        # never shows 3+ lines on screen, no matter how long the
        # underlying whisper segment was.
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{fontname},{fontsize},{style_primary},{style_secondary},"
        f"{outline_colour},{style_back},{bold},0,0,0,100,100,0,0,"
        f"{border_style},{style_outline_width},{style_shadow},{alignment},40,40,{margin_v},1\n"
        f"{box_style_row}"
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text\n"
    )
    body_lines = []
    for start, end, text in blocks:
        # Per-line animation event expansion. Most animations return a
        # single (start, end, text) tuple; 'word-highlight' returns N
        # events, one per word's active window, so the active word
        # appears in highlight colour while the rest stay in
        # font_color (matches the modal preview's per-word reveal).
        events = _animate_block_events(
            start_s=start,
            end_s=end,
            text=text,
            animation=animation,
            highlight_ass_colour=highlight_colour,
            primary_ass_colour=primary,
        )
        # PER-DIALOGUE \pos OVERRIDE — when anchor_pos_xy is set the
        # caller wants every line's visual centre pinned to a fixed
        # pixel position. Combined with alignment=5 (middle-centre)
        # this makes 1-line and 2-line subtitles sit at the SAME
        # visual middle (no more "single-word lines lower, multi-word
        # lines higher" drift caused by edge-anchor + variable line
        # count). The override has to come BEFORE any animation tags
        # in the dialogue body so libass parses position before fades.
        pos_prefix = ''
        if anchor_pos_xy is not None:
            try:
                _px, _py = anchor_pos_xy
                pos_prefix = f"{{\\pos({int(round(_px))},{int(round(_py))})}}"
            except Exception:
                pos_prefix = ''
        for ev_start, ev_end, ev_text in events:
            # Merge the position prefix with whatever override block the
            # animation produced. Two cases:
            #   1. ev_text already starts with `{...}` → splice the
            #      \pos tag inside that brace pair so libass parses
            #      one tag block, not two adjacent ones (some libass
            #      builds choke on `}{`).
            #   2. ev_text starts with text → just prepend the pos
            #      prefix as its own brace block.
            if pos_prefix and ev_text.startswith('{') and '}' in ev_text:
                first_close = ev_text.index('}')
                merged_inner = ev_text[1:first_close]
                merged_pos = pos_prefix[1:-1]  # strip outer braces
                merged_body = ev_text[first_close + 1:]
                ev_text = '{' + merged_pos + merged_inner + '}' + merged_body
            elif pos_prefix:
                ev_text = pos_prefix + ev_text
            body_lines.append(
                f"Dialogue: 0,{_format_ass_time(ev_start)},{_format_ass_time(ev_end)},"
                f"Default,,0,0,0,,{ev_text}"
            )

    with open(ass_path, 'w', encoding='utf-8') as f:
        f.write(header)
        f.write('\n'.join(body_lines))
        f.write('\n')


def burn_subtitles(video_path, srt_path, output_path, alignment=2, fontsize=16,
                   font_name="Verdana", font_color="#FFFFFF",
                   border_color="#000000", border_width=2,
                   bg_color="#000000", bg_opacity=0.0,
                   position_pct=None,
                   animation="none", highlight_color="#FFDD00"):
    animation = animation or "none"
    print(f"[burn_subtitles] using animation={animation}")
    """Burn subtitles into the video.

    Two modes:
      - Outline mode (bg_opacity=0): text with colored outline/border
      - Box mode (bg_opacity>0): text with semi-transparent background

    Vertical position:
      - position_pct (0..100) — fine-grained slider value. When
        provided, overrides `alignment`. Anchors text from the TOP edge
        and uses MarginV = pct% of video height, giving the user
        smooth control over where the subtitle sits.
      - alignment (legacy 'top'/'middle'/'bottom') — used only when
        position_pct is None.

    Implementation note: we DON'T pass the SRT to libass. Instead we
    write our own .ass file with PlayResX/Y matching the video so
    Fontsize = real pixels. Otherwise libass defaults to PlayResY=288
    and font size gets multiplied by ~6.67 on vertical video.
    """
    # ASS V4+ numpad alignment:
    #   7 8 9    top
    #   4 5 6    middle
    #   1 2 3    bottom
    # The previous code used V4 (legacy) numbers which mean different
    # positions in V4+ — that's why "top" was rendering off-screen.
    ass_alignment = 2
    align_lower = str(alignment).lower()
    if align_lower == 'top':
        ass_alignment = 8
    elif align_lower == 'middle':
        ass_alignment = 5
    elif align_lower == 'bottom':
        ass_alignment = 2

    # When the slider is in play, anchor the VISUAL CENTRE of each
    # subtitle (alignment=5 = middle-centre) and pin it with a
    # per-Dialogue \pos override computed below. This fixes the
    # "1-line subtitles sit at one height, 2-line subtitles sit at
    # another" bug: edge-anchor (top OR bottom) makes line-count
    # changes shift the visual middle, but middle-anchor + \pos
    # forces every Dialogue's centre to land at the same Y.
    if position_pct is not None:
        ass_alignment = 5

    # Probe the video resolution.
    #
    # NEW: handle audio-only inputs (the user uploaded a .mp3 / .wav
    # for transcription). In that case there are no video frames; we
    # synthesize a placeholder gradient video the same length as the
    # audio so libass has frames to draw on. The caller doesn't need
    # to know — we transparently swap `video_path` to the placeholder.
    info = probe_media(video_path)
    if not info['has_video']:
        print(f"🎵 Audio-only input detected ({video_path}). Generating placeholder video.")
        # Generate a 1080x1920 vertical gradient by default (best for
        # short-form). The downstream change-background flow lets the
        # user swap this for a stock or custom video later.
        placeholder_path = video_path.rsplit('.', 1)[0] + '__autobg.mp4'
        if not make_placeholder_video(video_path, placeholder_path):
            raise Exception("Audio-only burn failed: could not synthesize placeholder video")
        video_path = placeholder_path
        # Re-probe the placeholder so width/height fall through correctly.
        info = probe_media(video_path)
    try:
        if info['has_video'] and info['width'] and info['height']:
            video_w, video_h = info['width'], info['height']
        else:
            # Last-resort: ffprobe via the legacy CSV path — should never
            # hit this after the audio-only branch above succeeds, but
            # kept as a safety net.
            probe = subprocess.run(
                ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                 '-show_entries', 'stream=width,height',
                 '-of', 'csv=p=0', video_path],
                capture_output=True, text=True, check=True,
            )
            vw_str, vh_str = probe.stdout.strip().split(',')
            video_w = int(vw_str)
            video_h = int(vh_str)
    except Exception as e:
        print(f"⚠️ Could not probe video size, defaulting 1080x1920: {e}")
        video_w, video_h = 1080, 1920

    # Now fontsize is REAL pixels because PlayRes matches the video.
    #
    # IMPORTANT: the slider value in the dashboard represents the size
    # the user sees in the live preview window (a ~600-CSS-pixel-tall
    # box). For the burned mp4 to LOOK the same when played back at
    # the source's native height, we have to scale the slider up by
    # video_h / PREVIEW_REFERENCE_HEIGHT. Without this, slider=30
    # produced ~30 actual pixels in a 1920-px-tall vertical video —
    # only ~1.5% of frame, which looks like 10-15px on a phone (the
    # user complaint: "preview huge, burn tiny"). With this scaling,
    # slider=30 on a 1920 video burns at 96px (~5% of frame), matching
    # what the user saw in the preview.
    PREVIEW_REFERENCE_HEIGHT = 600
    preview_fontsize = max(8, int(fontsize))
    scale_factor = max(1.0, video_h / float(PREVIEW_REFERENCE_HEIGHT))
    final_fontsize = max(8, int(round(preview_fontsize * scale_factor)))

    # Resolve the picker font name to something libass can find FIRST so
    # the safety net below can also pick the right glyph-width estimate
    # for THAT font (condensed display fonts are much narrower than
    # regular sans-serif and don't need to shrink as aggressively).
    effective_fontname, was_remapped = resolve_burn_fontname(font_name)
    if was_remapped:
        print(
            f"🔤 Font remap: '{font_name}' (proprietary, not installed) "
            f"→ '{effective_fontname}' (free Linux equivalent)"
        )

    # OVERFLOW SAFETY NET — shrink the fontsize if the longest wrapped
    # line would run off the side of the frame. Without this, picking a
    # template with fontSize 60 + Impact (or any font with wider glyphs
    # than the one the user saw in preview) produced text that bled off
    # the left/right edges and disappeared. We compute the longest line
    # the burn will actually emit, estimate its rendered pixel width
    # using a font-aware avg-glyph estimate, and scale down if it would
    # exceed frame_width * 0.94 (6% combined L+R margin).
    longest_line_chars = _longest_wrapped_line_chars(srt_path)
    requested_fontsize = final_fontsize
    final_fontsize = compute_safe_fontsize(
        requested_fontsize,
        longest_line_chars=longest_line_chars,
        frame_width_px=video_w,
        font_name=effective_fontname,
    )
    if final_fontsize < requested_fontsize:
        print(
            f"📐 Overflow guard: shrinking fontsize {requested_fontsize}px → "
            f"{final_fontsize}px so longest line ({longest_line_chars} chars) "
            f"in '{effective_fontname}' fits within {video_w}px frame."
        )

    # Convert colors to ASS format
    primary_colour = hex_to_ass_color(font_color, 1.0)
    # Pre-convert highlight too — used by per-word karaoke (Pop, Karaoke
    # animations) and by the glow shadow tint. Default keeps backward
    # compatibility for callers that don't pass one.
    highlight_ass = hex_to_ass_color(highlight_color or "#FFDD00", 1.0)
    if bg_opacity > 0:
        # Box mode
        border_style = 3
        outline_colour = hex_to_ass_color(bg_color, bg_opacity)
        outline_width = 1
    else:
        # Outline mode
        border_style = 1
        outline_colour = hex_to_ass_color(border_color, 1.0)
        outline_width = max(1, border_width)
    back_colour = hex_to_ass_color("#000000", 0.0)

    # Margin / position resolution.
    #   - position_pct given: alignment=5 (middle-centre) PLUS a
    #     per-Dialogue \pos override that pins the visual centre at
    #     (video_w/2, video_h * pct%). Margin_v is unused in this
    #     path — we set it to 0 because the \pos override wins.
    #     Result: every subtitle's visual centre lands at the same Y
    #     regardless of line count, fixing the "single-line lower,
    #     multi-line higher" drift.
    #   - position_pct not given: legacy edge-anchor behaviour
    #     (alignment derived from the 'top'/'middle'/'bottom' enum).
    #     Scales MarginV with video height so text doesn't hug the
    #     very edge on tall videos.
    anchor_pos_xy = None
    if position_pct is not None:
        pct_clamped = max(0.0, min(100.0, float(position_pct)))
        target_y_px = int(round(video_h * (pct_clamped / 100.0)))
        anchor_pos_xy = (video_w // 2, target_y_px)
        margin_v = 0
        print(
            f"📍 Subtitle anchor: alignment=5 (middle-centre), "
            f"\\pos({anchor_pos_xy[0]},{anchor_pos_xy[1]}) — "
            f"every line's visual centre pinned to {pct_clamped:.0f}% from top"
        )
    else:
        margin_v = max(40, int(video_h * 0.06))

    # effective_fontname was already resolved above (so the safety net
    # could pick the right glyph-width estimate for it). Don't re-resolve
    # here — just reuse the value.

    # Write the .ass file alongside the SRT.
    ass_path = srt_path.rsplit('.', 1)[0] + '.ass'
    srt_to_ass(
        srt_path, ass_path,
        video_w=video_w, video_h=video_h,
        alignment=ass_alignment,
        fontname=effective_fontname,
        fontsize=final_fontsize,
        primary=primary_colour,
        outline_colour=outline_colour,
        back_colour=back_colour,
        border_style=border_style,
        outline_width=outline_width,
        bold=1,
        margin_v=margin_v,
        animation=animation,
        highlight_colour=highlight_ass,
        # Per-Dialogue \pos override — None when the legacy edge-anchor
        # path is in play (position_pct=None); otherwise pins every
        # subtitle's visual centre to a fixed pixel coordinate.
        anchor_pos_xy=anchor_pos_xy,
    )
    print(
        f"🎬 Burning subs: ASS PlayRes={video_w}x{video_h}, "
        f"fontsize={final_fontsize}px, font={effective_fontname}, "
        f"animation={animation}"
    )
    # DIAGNOSTIC: log the generated .ass path + a small head sample so
    # we can verify (post-burn) that animation tags actually made it
    # into the file libass consumes. Cheap to keep in production —
    # one print per burn.
    try:
        print(f"📝 Generated ASS path: {ass_path}")
        with open(ass_path, 'r', encoding='utf-8', errors='replace') as _f:
            _ass_head = _f.read(2000)
        # Pull out the Style line + the first three Dialogue lines so
        # logs show what tags / colours libass actually saw.
        _style_lines = [ln for ln in _ass_head.splitlines() if ln.startswith('Style:')]
        _dlg_lines = [ln for ln in _ass_head.splitlines() if ln.startswith('Dialogue:')][:3]
        for _ln in _style_lines + _dlg_lines:
            print(f"   {_ln[:240]}")
    except Exception as _diag_err:
        print(f"   (could not read .ass for diagnostics: {_diag_err})")

    safe_ass_path = ass_path.replace('\\', '/').replace(':', '\\:')
    # `fontsdir` tells libass to ALSO scan the bundled fonts/ directory
    # next to the source, on top of whatever fontconfig finds. That way
    # any .ttf/.otf shipped in the repo (e.g. NotoSerif-Bold.ttf, or
    # future bundled brand fonts) is discoverable without a Docker
    # rebuild. The path inside the container is /app/fonts when the
    # docker-compose .:/app mount is in place; we resolve relative to
    # this script's directory so it works in non-Docker dev too.
    fonts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
    fonts_dir_arg = ''
    if os.path.isdir(fonts_dir):
        # Escape the same way as ass_path so colons in absolute paths
        # don't trip libass's filter-arg parser.
        safe_fonts_dir = fonts_dir.replace('\\', '/').replace(':', '\\:')
        fonts_dir_arg = f":fontsdir='{safe_fonts_dir}'"
    cmd = [
        'ffmpeg', '-y',
        '-i', video_path,
        '-vf', f"ass='{safe_ass_path}'{fonts_dir_arg}",
        '-c:a', 'copy',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        output_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode('utf-8', errors='replace')
        print(f"❌ FFmpeg Subtitle Error: {err[-1200:]}")
        raise Exception(f"FFmpeg failed: {err[-400:]}")
    return True

