/**
 * Font fallback map — MUST stay in lockstep with subtitles.py's
 * PROPRIETARY_FONT_FALLBACKS. Both the preview and the burn need to
 * pick the SAME font, otherwise the preview lies about what the burn
 * will produce. This file is the single source of truth on the
 * frontend; if you change one, change the other.
 *
 * The picker offers familiar Microsoft / Apple font names so users
 * recognise them. Behind the scenes the burn substitutes free Linux
 * fonts (libass goes through fontconfig in the Docker image, which
 * only has stock free fonts). For the preview to MATCH the burn, we
 * apply the same substitution in CSS too — so what the user sees in
 * Phase 2 is exactly what they'll get in the burned MP4.
 *
 * The CSS values include comma-separated fallback chains so browsers
 * also fall back gracefully when a Linux-only font isn't installed
 * locally on the user's Mac. The first entry is the same family-name
 * libass picks; subsequent entries are widely-installed Mac/Win
 * equivalents so previews on a fresh laptop don't show a generic
 * Helvetica.
 */
// Each chain prefers the ORIGINAL (Microsoft) name first. Two reasons:
//   1. The Docker backend now installs ttf-mscorefonts-installer, so the
//      genuine font IS available for the burn. With "Impact" first, the
//      browser finds local Impact (on Mac/Win) and matches what the burn
//      will produce byte-for-byte.
//   2. On a stripped-down system without MS fonts, the browser walks the
//      chain and lands on the free Linux equivalent — same as what the
//      backend's resolve_burn_fontname returns when fc-match can't find
//      the original. Either way, preview matches burn.
export const PROPRIETARY_FONT_FALLBACKS = {
    Verdana: '"Verdana", "DejaVu Sans", sans-serif',
    Arial: '"Arial", "Liberation Sans", "Helvetica Neue", sans-serif',
    Helvetica: '"Helvetica", "Helvetica Neue", "Liberation Sans", sans-serif',
    'Times New Roman': '"Times New Roman", "Liberation Serif", "Times", serif',
    Georgia: '"Georgia", "DejaVu Serif", serif',
    'Courier New': '"Courier New", "Liberation Mono", "Courier", monospace',
    Impact: '"Impact", "Haettenschweiler", "DejaVu Sans Condensed", "Arial Narrow Bold", sans-serif',
    'Comic Sans MS': '"Comic Sans MS", "Comic Neue", "DejaVu Sans", sans-serif',
};

/**
 * Resolve a picked font name to the CSS font-family stack that the
 * preview should use. Unmapped names pass through unchanged so users
 * who upload a custom .ass template referencing a Linux-native font
 * (e.g. "DejaVu Sans") still work.
 */
export function resolvePreviewFontFamily(pickedName) {
    if (!pickedName) return 'sans-serif';
    return PROPRIETARY_FONT_FALLBACKS[pickedName] || pickedName;
}


// -----------------------------------------------------------------------------
// JS mirror of subtitles.py's overflow-shrink helpers. Both files MUST stay
// in sync; if you change a magic number here, change it there too.
//
// These exist because the BURN auto-shrinks fontsize so subtitles fit within
// the frame, and the PREVIEW must produce the same proportions or the user
// sees one size in Phase 2 and a different (smaller) size in the rendered
// MP4 — exactly the bug the user reported.
// -----------------------------------------------------------------------------

const PREVIEW_MAX_LINE_CHARS = 38;
const PREVIEW_MAX_LINES = 2;

/** JS port of subtitles.py wrap_to_two_lines — break text at word boundaries
 *  onto at most maxLines lines, each ≤ maxLine chars. Returns an array of lines.
 */
export function wrapToTwoLines(text, maxLine = PREVIEW_MAX_LINE_CHARS, maxLines = PREVIEW_MAX_LINES) {
    const t = (text || '').toString().trim();
    if (!t) return [];
    if (t.length <= maxLine) return [t];
    const words = t.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if (!cur) { cur = w; continue; }
        if (cur.length + 1 + w.length <= maxLine) {
            cur += ' ' + w;
        } else {
            lines.push(cur);
            cur = w;
            if (lines.length >= maxLines) break;
        }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
}

/** JS port of subtitles.py _avg_glyph_em_for_font. Glyph-em estimates tuned
 *  per font family so the shrink doesn't fire too aggressively for narrow
 *  display fonts (Impact/DejaVu Sans Condensed) or too loosely for monospace.
 */
export function avgGlyphEmForFont(fontName) {
    if (!fontName) return 0.50;
    const n = fontName.toString().toLowerCase();
    if (n.includes('condensed') || n.includes('narrow') || n === 'anton' || n === 'impact') return 0.42;
    if (n.includes('mono') || n === 'courier new' || n === 'courier') return 0.60;
    return 0.50;
}

/**
 * Find the longest line, in characters, that the burn pipeline will emit
 * given a list of {text} segments. Mirrors what _longest_wrapped_line_chars
 * does on the backend so the preview shrink uses the same input value.
 */
export function longestWrappedLineChars(segments) {
    let longest = 0;
    for (const s of segments || []) {
        const txt = (s && s.text) || '';
        if (!txt) continue;
        const lines = wrapToTwoLines(txt);
        for (const line of lines) {
            if (line.length > longest) longest = line.length;
        }
    }
    return longest;
}

/**
 * Longest SEGMENT (caption block) length in characters, ignoring wrapping.
 * This is the input to the 2-line capacity shrink: we decide font size by
 * whether the whole caption fits across two wrapped lines, NOT by a single
 * pre-wrapped line. Using this (instead of longestWrappedLineChars) is what
 * lets the user's font-size slider actually change the rendered size — the
 * old one-line shrink pinned the size to a constant whenever text overflowed.
 */
export function longestSegmentChars(segments) {
    let longest = 0;
    for (const s of segments || []) {
        const n = ((s && s.text) || '').trim().length;
        if (n > longest) longest = n;
    }
    return longest;
}

/**
 * Returns the shrink ratio (0..1) the burn pipeline would apply for the
 * given inputs, OR 1.0 if no shrink is needed. Multiply your requested
 * font-size by this to get the size the burn will actually use.
 *
 * Inputs are unitless because we operate on a ratio:
 *   - requestedFontsize: the slider's chosen size (any unit)
 *   - longestLineChars : output of longestWrappedLineChars(segments)
 *   - frameWidthUnits  : frame width in REAL PIXELS (e.g. 1080 for a 9:16
 *                        frame of a 1920-tall reference). Must be real px
 *                        because the margin floor/cap below are absolute px.
 *   - fontName         : resolved (post-fallback) font, drives glyph-em.
 *
 * Mirrors subtitles.py exactly: horizontal margins are
 *   margin_h = clamp(5% of width, 40px, 100px)  on EACH side,
 * the drawable area is (width − 2·margin_h), and the overflow guard adds a
 * 2% safety buffer on top of that drawable area. Keep this in lock-step with
 * srt_to_ass()/compute_safe_fontsize() so preview == burn.
 *
 * TWO-LINE MODEL: `charCount` is the longest SEGMENT's total length, and the
 * text is allowed to wrap across `maxLines` lines (default 2). We only shrink
 * if the caption can't fit in that many lines at the requested size — so for
 * normal-length captions the ratio is 1.0 and the user's font-size slider is
 * fully respected (the old one-line model pinned the size to a constant
 * whenever a line overflowed, which is why resizing "did nothing").
 */
export function computeSafeShrinkRatio({
    requestedFontsize, charCount, frameWidthUnits, fontName,
    maxLines = 2, minPx = 12,
}) {
    if (!requestedFontsize || !charCount || !frameWidthUnits) return 1.0;
    const glyphEm = avgGlyphEmForFont(fontName);
    const marginH = Math.max(40, Math.min(frameWidthUnits * 0.05, 100));
    const drawable = Math.max(1, frameWidthUnits - 2 * marginH);
    const safeWidth = drawable * 0.98;            // 2% buffer — matches burn margin_pct
    const capacity = safeWidth * Math.max(1, maxLines);  // total width across N lines
    const requestedTotalWidth = requestedFontsize * glyphEm * charCount;
    if (requestedTotalWidth <= capacity) return 1.0;
    const safeFontsize = Math.max(minPx, capacity / (glyphEm * charCount));
    return safeFontsize / requestedFontsize;
}
