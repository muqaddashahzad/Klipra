/**
 * subtitleLines — keep on-screen captions readable.
 *
 * Long, paragraph-y subtitles are hard to scan and look unprofessional.
 * The industry rule of thumb (BBC, Netflix, YouTube auto-caption guides)
 * is at most TWO lines on screen at once, ~32–42 chars each.
 *
 * This helper takes any subtitle text and reflows it onto at most
 * `maxLines` lines (default 2), preferring word boundaries. It's used
 * everywhere we render captions on screen — Phase 1 transcript preview,
 * Phase 2 live overlay, ProcessingPreview, and clip-gen final cards —
 * so the look stays consistent across the whole product.
 *
 * Wrapping strategy:
 *   1. If the text is shorter than `softWidth`, return as-is.
 *   2. Otherwise split into words. Greedy-pack into lines of <= softWidth
 *      chars while staying under maxLines.
 *   3. If we run out of room, the last line gets an ellipsis appended
 *      so the user sees that some words were dropped (only relevant in
 *      preview — the burned mp4 still has the full text per segment).
 */

const DEFAULT_SOFT_WIDTH = 38;       // chars per line — eyeballed for ~480-640px overlays
const DEFAULT_MAX_LINES = 2;

export function limitSubtitleLines(text, maxLines = DEFAULT_MAX_LINES, softWidth = DEFAULT_SOFT_WIDTH) {
    const t = (text || '').trim();
    if (!t) return '';
    if (t.length <= softWidth) return t;

    const words = t.split(/\s+/);
    const lines = [];
    let current = '';
    for (const w of words) {
        if (lines.length >= maxLines) break;
        if (!current) {
            current = w;
            continue;
        }
        if (current.length + 1 + w.length <= softWidth) {
            current += ' ' + w;
        } else {
            lines.push(current);
            current = w;
        }
    }
    if (current && lines.length < maxLines) lines.push(current);

    // Did we drop words? Mark the tail with an ellipsis so the preview
    // signals the truncation. (The burn-time path uses a separate
    // server-side splitter that breaks long segments into multiple
    // shorter ASS events instead.)
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length && lines.length) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/[.!?,;:]+$/, '') + '…';
    }
    return lines.join('\n');
}

/**
 * Split a long caption into multiple shorter timed segments instead of
 * truncating. Used by the burn-time pipeline so the user keeps EVERY
 * word — they just appear sequentially across the segment's duration.
 *
 * Returns an array of { start, end, text } where each text is at most
 * maxLines * softWidth chars and the start/end values divide the
 * original duration proportionally to character count.
 */
export function splitSegmentForLineLimit(seg, maxLines = DEFAULT_MAX_LINES, softWidth = DEFAULT_SOFT_WIDTH) {
    const start = +seg.start || 0;
    const end = +seg.end || 0;
    const duration = Math.max(0, end - start);
    const text = (seg.text || '').trim();
    if (!text || duration <= 0) return [seg];

    const maxChars = maxLines * softWidth;
    if (text.length <= maxChars) return [seg];

    // Build chunks of <= maxChars chars on word boundaries.
    const words = text.split(/\s+/);
    const chunks = [];
    let cur = '';
    for (const w of words) {
        if (!cur) { cur = w; continue; }
        if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
        else { chunks.push(cur); cur = w; }
    }
    if (cur) chunks.push(cur);

    // Distribute time proportional to chunk length.
    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let cursor = start;
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
        const portion = chunks[i].length / totalChars;
        const segEnd = i === chunks.length - 1 ? end : cursor + duration * portion;
        out.push({ start: cursor, end: segEnd, text: chunks[i] });
        cursor = segEnd;
    }
    return out;
}
