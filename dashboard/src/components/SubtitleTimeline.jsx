/**
 * SubtitleTimeline — CapCut / Premiere style horizontal subtitle editor.
 *
 * Each subtitle becomes a draggable colored block on a horizontal time
 * axis. The user can:
 *   • Click a block       → select it (keyboard shortcuts apply to it)
 *   • Drag block body     → move start (duration preserved)
 *   • Drag left/right edge→ resize (extend/shrink duration)
 *   • Click "Split"        → split selected at the current playhead
 *   • Click "Add"          → insert a new empty subtitle at the playhead
 *   • Click trash icon     → delete selected
 *   • Cmd/Ctrl+Z / Shift+Z → undo / redo (last 50 ops)
 *   • +/−                  → zoom in / out (pixels per second)
 *   • Drag the ruler       → seek the audio/video
 *
 * The component is designed to live INSIDE Phase1Preview, sharing the
 * same `segments` state as the existing segment list. Edits propagate
 * immediately to the preview overlay.
 *
 * Why we built it (vs. using a library): subtitle editing has very
 * specific UX needs (snapping to neighbours, split-at-playhead, locked
 * lyric text on BYOL) that don't fit generic timeline libraries
 * cleanly. Plus zero new deps.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Plus, Scissors, Trash2, Undo2, Redo2, ZoomIn, ZoomOut, Maximize2, Layers, MousePointer, MoveHorizontal, Hand, Copy as CopyIcon, ClipboardPaste, CopyPlus, Combine } from 'lucide-react';

// Module-scope clipboard so copy/paste survives across mounts of the
// timeline (e.g. switching between Timed and Aligned tabs). Plain JSON
// snapshots of segments — no live references.
const _timelineClipboard = { segments: [] };

// ─── Audio waveform extraction ─────────────────────────────────────────
// Decodes the source audio with Web Audio API once, downsamples to a
// flat peaks array (~4000 entries), and caches in module-scope so a
// re-mounted timeline doesn't re-decode the same file. Decoding ~3 min
// of audio takes 1-2s on a modern Mac; the pre-computed peaks let us
// render instantly during playback.
const _peaksCache = new Map();  // url → Float32Array of peaks

async function extractAudioPeaks(url, targetSamples = 4000) {
    if (_peaksCache.has(url)) return _peaksCache.get(url);
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const res = await fetch(url, { cache: 'force-cache' });
        const buf = await res.arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const samplesPerPeak = Math.max(1, Math.floor(data.length / targetSamples));
        const peaks = new Float32Array(targetSamples);
        for (let i = 0; i < targetSamples; i++) {
            let max = 0;
            const start = i * samplesPerPeak;
            const end = Math.min(start + samplesPerPeak, data.length);
            for (let j = start; j < end; j++) {
                const v = Math.abs(data[j]);
                if (v > max) max = v;
            }
            peaks[i] = max;
        }
        try { ctx.close(); } catch {}
        _peaksCache.set(url, { peaks, durationS: audio.duration });
        return _peaksCache.get(url);
    } catch (err) {
        console.warn('[SubtitleTimeline] waveform extraction failed:', err);
        return null;
    }
}

// ─── small util helpers ─────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const fmtTime = (t) => {
    const total = Math.max(0, +t || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

// Stable color from an index — keeps each subtitle visually distinct
// without relying on full random (otherwise React re-renders shift hues).
const blockColor = (idx, selected) => {
    const palette = [
        ['#7c3aed', '#a78bfa'], // violet
        ['#2563eb', '#60a5fa'], // blue
        ['#0891b2', '#67e8f9'], // cyan
        ['#059669', '#6ee7b7'], // emerald
        ['#ca8a04', '#fde047'], // amber
        ['#db2777', '#f9a8d4'], // pink
        ['#dc2626', '#fca5a5'], // red
    ];
    const [base, light] = palette[idx % palette.length];
    return {
        background: selected ? light : base,
        borderColor: selected ? '#fff' : 'transparent',
    };
};

const cloneSegments = (segs) => (segs || []).map((s) => ({
    ...s,
    words: Array.isArray(s.words) ? s.words.map((w) => ({ ...w })) : undefined,
}));

// ─── component ─────────────────────────────────────────────────────────────

export default function SubtitleTimeline({
    segments,
    setSegments,
    videoRef,             // shared ref with Phase1Preview's <video>
    videoUrl,             // for waveform extraction
    duration: durationProp,
    height = 96,
    minPixelsPerSecond = 20,
    initialPixelsPerSecond = 60,
    maxPixelsPerSecond = 300,
}) {
    const safeSegs = Array.isArray(segments) ? segments : [];
    const [pps, setPps] = useState(initialPixelsPerSecond); // pixels per second
    const [selectedIdx, setSelectedIdx] = useState(-1);
    // Multi-selection — Set of indices. Single-click clears and adds
    // one; Shift+click toggles. Most operations (delete, copy,
    // duplicate, group-shift) operate on this set when non-empty.
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    // Tool mode — 'select' (default, individual subtitle editing) or
    // 'group-shift' (drag anywhere → shifts ALL subtitles in time).
    // Switching to group-shift changes the cursor to grab and disables
    // per-block drag handlers; the empty-track area becomes a giant
    // drag surface that moves every segment in lockstep.
    const [toolMode, setToolMode] = useState('select'); // 'select' | 'group-shift'
    const [playheadT, setPlayheadT] = useState(0);
    const [dragInfo, setDragInfo] = useState(null);  // {idx, mode, startX, startSeg, ...}
    // Rubber-band marquee selection in 'select' tool mode. When non-null,
    // a translucent rectangle is drawn over the track. Any segment whose
    // visual bounds intersect the marquee gets selected.
    // Coordinates are stored in TRACK-SCROLL space (i.e. include
    // trackRef.scrollLeft) so the marquee stays anchored when the user
    // scrolls horizontally during a drag.
    const [marquee, setMarquee] = useState(null);
    // Inline text edit — double-click a block to enter edit mode.
    // Lives outside dragInfo so the user can resize / move first, then
    // double-click to fix the wording without re-selecting.
    const [editingIdx, setEditingIdx] = useState(-1);
    const [editingText, setEditingText] = useState('');
    // JKL playback rates — same convention as Premiere / Resolve / Avid.
    //   • Space          → toggle play/pause at current rate
    //   • L              → forward; each press multiplies (1× → 2× → 4× → 8×)
    //   • K              → pause, reset rate to 1×
    //   • J              → reverse; each press multiplies (1× → 2× → 4× → 8×)
    // reverseRate > 0    means we're playing backwards via the rAF loop
    // below (HTML5 video doesn't reliably support negative playbackRate).
    const [reverseRate, setReverseRate] = useState(0);
    const [rateHud, setRateHud] = useState(null); // {label, ts} for transient HUD
    // Audio waveform — peaks array + audio duration. null until decoded.
    const [waveform, setWaveform] = useState(null);
    const [waveformLoading, setWaveformLoading] = useState(false);
    const trackRef = useRef(null);
    const rulerRef = useRef(null);
    const waveformCanvasRef = useRef(null);

    // Decode audio peaks once per videoUrl change.
    useEffect(() => {
        if (!videoUrl) return;
        let alive = true;
        setWaveformLoading(true);
        extractAudioPeaks(videoUrl).then((data) => {
            if (!alive) return;
            setWaveform(data);
            setWaveformLoading(false);
        }).catch(() => {
            if (alive) setWaveformLoading(false);
        });
        return () => { alive = false; };
    }, [videoUrl]);

    // Layer count — derived from segments. Each segment can carry an
    // optional `layer` field (default 0). The timeline renders one row
    // per layer; segments are vertically positioned by their layer.
    // Drag a segment up past the top of its row → it gets bumped to a
    // new (numerically higher) layer. Drag below row 0 → clamped to 0.
    const numLayers = useMemo(() => {
        let max = 0;
        for (const s of safeSegs) {
            const l = +(s.layer || 0);
            if (l > max) max = l;
        }
        // Always show at least 1 layer (the default), and one extra
        // empty layer above the top so users have a visible drop zone
        // for "drag up to create a new layer".
        return Math.max(1, max + 2);
    }, [safeSegs]);
    const LAYER_HEIGHT = 36; // pixels per subtitle lane
    const WAVEFORM_HEIGHT = 48;

    // Reverse-playback loop — when reverseRate > 0, decrement the
    // video's currentTime each frame by the chosen multiplier. We
    // pause the actual <video> element (so its built-in audio doesn't
    // glitch) and drive the playhead manually instead.
    useEffect(() => {
        if (!reverseRate) return;
        const v = videoRef?.current;
        if (!v) return;
        try { v.pause(); } catch {}
        let last = performance.now();
        let raf;
        const tick = (now) => {
            const dt = (now - last) / 1000;
            last = now;
            const next = (v.currentTime || 0) - dt * reverseRate;
            if (next <= 0) {
                v.currentTime = 0;
                setReverseRate(0);
                return;
            }
            v.currentTime = next;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [reverseRate, videoRef]);

    // Auto-clear the playback-rate HUD after a moment.
    useEffect(() => {
        if (!rateHud) return;
        const id = setTimeout(() => setRateHud(null), 1100);
        return () => clearTimeout(id);
    }, [rateHud]);

    // Undo / redo stack — store snapshots of segments. Capped at 50
    // entries each so we don't grow unbounded over a long edit session.
    const undoRef = useRef([]);
    const redoRef = useRef([]);
    const pushUndo = useCallback(() => {
        undoRef.current.push(cloneSegments(safeSegs));
        if (undoRef.current.length > 50) undoRef.current.shift();
        redoRef.current = [];
    }, [safeSegs]);

    // Compute total duration: prefer the prop, else fall back to the
    // last segment's end + small padding.
    const duration = useMemo(() => {
        if (durationProp && durationProp > 0) return durationProp;
        const last = safeSegs.reduce((m, s) => Math.max(m, +s.end || 0), 0);
        return Math.max(10, last + 5);
    }, [durationProp, safeSegs]);

    const trackWidth = duration * pps;

    // Playhead sync — read videoRef.current.currentTime on rAF.
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const v = videoRef?.current;
            if (v) setPlayheadT(v.currentTime || 0);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [videoRef]);

    // ─── Auto-scroll at viewport edges during any drag ────────────────
    // When the user drags a clip or marquee past the left/right edge of
    // the visible timeline, scroll the track to follow the cursor. A
    // requestAnimationFrame loop runs while a drag is active, checking
    // cursor position relative to the scroll container; when it gets
    // within EDGE_PX of either edge, we add a scrollLeft delta scaled
    // to how close we are to the edge (further past the edge = faster
    // scroll). Standard NLE behaviour.
    const lastPointerXRef = useRef(0);
    useEffect(() => {
        const onPointerMoveTrack = (e) => { lastPointerXRef.current = e.clientX; };
        window.addEventListener('pointermove', onPointerMoveTrack);
        return () => window.removeEventListener('pointermove', onPointerMoveTrack);
    }, []);
    useEffect(() => {
        if (!dragInfo && !marquee) return;
        const trackEl = trackRef.current;
        if (!trackEl) return;
        const EDGE_PX = 40;
        const MAX_SPEED = 18; // pixels per frame at the very edge
        let raf;
        const tick = () => {
            const rect = trackEl.getBoundingClientRect();
            const x = lastPointerXRef.current;
            const distLeft = x - rect.left;
            const distRight = rect.right - x;
            let delta = 0;
            if (distLeft < EDGE_PX && distLeft > -200) {
                // Negative scroll (towards earlier time)
                const factor = Math.max(0, (EDGE_PX - distLeft) / EDGE_PX);
                delta = -Math.ceil(factor * MAX_SPEED);
            } else if (distRight < EDGE_PX && distRight > -200) {
                const factor = Math.max(0, (EDGE_PX - distRight) / EDGE_PX);
                delta = Math.ceil(factor * MAX_SPEED);
            }
            if (delta !== 0) {
                trackEl.scrollLeft = Math.max(0, trackEl.scrollLeft + delta);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [dragInfo, marquee]);

    // ─── Marquee (rubber-band) selection ──────────────────────────────
    // Live during drag — recomputes selection set as the rectangle
    // grows. On pointerup, finalizes and disposes of the marquee.
    useEffect(() => {
        if (!marquee) return;
        const onMove = (e) => {
            const trackEl = trackRef.current;
            if (!trackEl) return;
            // The .overflow-x-auto container hosts the scroll. The
            // track div lives inside it; we find the lane area by
            // querying the scroll-container's bounding rect plus
            // adjusting for the ruler+waveform offset.
            const rect = trackEl.getBoundingClientRect();
            const sl = trackEl.scrollLeft || 0;
            const x2 = e.clientX - rect.left + sl;
            const y2 = e.clientY - rect.top - 18 - WAVEFORM_HEIGHT;  // relative to lane top
            setMarquee((prev) => prev ? { ...prev, x2, y2 } : prev);
        };
        const onUp = () => {
            // Finalize: nothing to do — selectedIds was kept in sync
            // each frame by the effect below. Just dispose of the
            // marquee rectangle.
            setMarquee(null);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [marquee, WAVEFORM_HEIGHT]);

    // While the marquee is active, recompute selectedIds based on
    // 2D rectangle intersection (BOTH time AND layer). A clip on a
    // different layer than the marquee is NOT selected, even if its
    // time range overlaps — that's the standard NLE behaviour and what
    // the user expects when they're trying to multi-select within a
    // specific layer.
    useEffect(() => {
        if (!marquee) return;
        const minX = Math.min(marquee.x1, marquee.x2);
        const maxX = Math.max(marquee.x1, marquee.x2);
        const minY = Math.min(marquee.y1, marquee.y2);
        const maxY = Math.max(marquee.y1, marquee.y2);
        const minT = minX / pps;
        const maxT = maxX / pps;
        // For each clip, derive its on-screen Y bounds (in the same
        // lane-relative coords as the marquee Y) from its layer.
        const clipYBounds = (s) => {
            const layer = Math.max(0, +(s.layer || 0));
            const visualRow = numLayers - 1 - layer;
            const topY = visualRow * LAYER_HEIGHT + 4;
            const bottomY = topY + (LAYER_HEIGHT - 8);
            return { topY, bottomY };
        };
        const intersects = (s) => {
            const ss = +s.start || 0;
            const se = +s.end || ss;
            // X overlap: clip's [start, end] intersects marquee's [minT, maxT]
            const xHit = se >= minT && ss <= maxT;
            if (!xHit) return false;
            // Y overlap: clip's vertical row intersects marquee's
            // vertical extent. This is what restricts selection to
            // the layer(s) the user is actually dragging across.
            const { topY, bottomY } = clipYBounds(s);
            const yHit = bottomY >= minY && topY <= maxY;
            return yHit;
        };
        const newSel = new Set();
        safeSegs.forEach((s, i) => { if (intersects(s)) newSel.add(i); });
        setSelectedIds((prev) => {
            if (marquee.additive) {
                const merged = new Set(prev);
                newSel.forEach((i) => merged.add(i));
                return merged;
            }
            return newSel;
        });
        if (newSel.size > 0) setSelectedIdx(Math.min(...newSel));
    }, [marquee, pps, safeSegs, numLayers, LAYER_HEIGHT]);

    // Auto-scroll: keep playhead visible (centred-ish) while playing.
    useEffect(() => {
        const track = trackRef.current;
        if (!track) return;
        const playheadX = playheadT * pps;
        const viewportLeft = track.scrollLeft;
        const viewportRight = viewportLeft + track.clientWidth;
        if (playheadX < viewportLeft + 40 || playheadX > viewportRight - 40) {
            track.scrollLeft = Math.max(0, playheadX - track.clientWidth / 2);
        }
    }, [playheadT, pps]);

    // Render the waveform onto its canvas whenever peaks or zoom change.
    // We use a fixed pixel-density of 1px per peak, then draw vertical
    // bars at heights proportional to each peak's amplitude. The canvas
    // is sized to the full timeline width so it scrolls in lockstep.
    useEffect(() => {
        const canvas = waveformCanvasRef.current;
        if (!canvas) return;
        const trackPxWidth = duration * pps;
        canvas.width = Math.max(100, trackPxWidth);
        canvas.height = WAVEFORM_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!waveform || !waveform.peaks?.length) {
            // Loading state — draw a faint line so users see something.
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.moveTo(0, canvas.height / 2);
            ctx.lineTo(canvas.width, canvas.height / 2);
            ctx.stroke();
            return;
        }
        const peaks = waveform.peaks;
        const mid = canvas.height / 2;
        const maxAmp = canvas.height * 0.42;
        // Map each on-screen pixel to the right peak index for THIS
        // duration. We use waveform.durationS so timing matches video.
        const wfDur = waveform.durationS || duration || 1;
        ctx.fillStyle = 'rgba(96, 165, 250, 0.55)';  // soft blue
        ctx.strokeStyle = 'rgba(147, 197, 253, 0.85)';
        ctx.lineWidth = 1;
        const wfDurOnScreen = Math.min(wfDur, duration);
        const wfWidthOnScreen = wfDurOnScreen * pps;
        for (let x = 0; x < wfWidthOnScreen; x++) {
            const t = x / pps;             // seconds at this x
            const peakIdx = Math.min(peaks.length - 1, Math.floor((t / wfDur) * peaks.length));
            const amp = peaks[peakIdx] * maxAmp;
            ctx.fillRect(x, mid - amp, 1, amp * 2);
        }
        // Centre line for visual reference.
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(canvas.width, mid);
        ctx.stroke();
    }, [waveform, duration, pps, WAVEFORM_HEIGHT]);

    // ─── editing operations ───────────────────────────────────────────────

    const updateSegment = useCallback((idx, patch) => {
        if (idx < 0 || idx >= safeSegs.length) return;
        const next = cloneSegments(safeSegs);
        next[idx] = { ...next[idx], ...patch };
        // Re-sort when timing changed so the timeline stays in order.
        if ('start' in patch || 'end' in patch) next.sort((a, b) => (a.start || 0) - (b.start || 0));
        setSegments(next);
    }, [safeSegs, setSegments]);

    const splitAt = useCallback((idx, t) => {
        if (idx < 0 || idx >= safeSegs.length) return;
        const seg = safeSegs[idx];
        if (t <= (seg.start || 0) + 0.05 || t >= (seg.end || 0) - 0.05) return;
        pushUndo();
        const next = cloneSegments(safeSegs);
        const original = next[idx];
        const text = (original.text || '').trim();
        const words = text.split(/\s+/);
        // Pick a split word index proportional to where t falls in the seg.
        const ratio = (t - original.start) / Math.max(0.01, original.end - original.start);
        const splitWordIdx = clamp(Math.round(ratio * words.length), 1, words.length - 1);
        const leftText = words.slice(0, splitWordIdx).join(' ');
        const rightText = words.slice(splitWordIdx).join(' ');
        const left = { ...original, end: t, text: leftText };
        const right = { ...original, start: t, text: rightText };
        // Word-level timings: split across the boundary.
        if (Array.isArray(original.words) && original.words.length) {
            const lw = original.words.filter((w) => (w.end || 0) <= t);
            const rw = original.words.filter((w) => (w.end || 0) > t);
            left.words = lw.length ? lw : undefined;
            right.words = rw.length ? rw : undefined;
        }
        next.splice(idx, 1, left, right);
        setSegments(next);
        setSelectedIdx(idx + 1);
    }, [safeSegs, pushUndo, setSegments]);

    const deleteAt = useCallback((idx) => {
        if (idx < 0 || idx >= safeSegs.length) return;
        pushUndo();
        const next = cloneSegments(safeSegs);
        next.splice(idx, 1);
        setSegments(next);
        setSelectedIdx(-1);
    }, [safeSegs, pushUndo, setSegments]);

    const addAt = useCallback((t) => {
        pushUndo();
        const next = cloneSegments(safeSegs);
        const start = clamp(t, 0, duration - 1);
        const end = clamp(start + 2.0, start + 0.5, duration);
        const inserted = { start, end, text: 'New subtitle', words: [] };
        next.push(inserted);
        next.sort((a, b) => (a.start || 0) - (b.start || 0));
        setSegments(next);
        const newIdx = next.findIndex((s) => s === inserted);
        setSelectedIdx(newIdx);
    }, [safeSegs, pushUndo, duration, setSegments]);

    // ─── Multi-select helpers ─────────────────────────────────────────
    const setSingleSelection = useCallback((idx) => {
        setSelectedIdx(idx);
        setSelectedIds(idx >= 0 ? new Set([idx]) : new Set());
    }, []);
    const toggleSelection = useCallback((idx) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
        setSelectedIdx(idx);
    }, []);

    // ─── Copy / Paste / Duplicate ─────────────────────────────────────
    // Copy: snapshot the currently-selected segment(s) to module-scope
    // clipboard. We deep-clone so future edits don't mutate the copy.
    const copySelection = useCallback(() => {
        const indices = selectedIds.size > 0
            ? Array.from(selectedIds).sort((a, b) => a - b)
            : (selectedIdx >= 0 ? [selectedIdx] : []);
        if (!indices.length) return;
        _timelineClipboard.segments = indices
            .map((i) => safeSegs[i])
            .filter(Boolean)
            .map((s) => JSON.parse(JSON.stringify(s)));
    }, [selectedIds, selectedIdx, safeSegs]);

    // Paste: drop the clipboard at the playhead, preserving the
    // relative spacing between copied segments.
    const pasteAtPlayhead = useCallback(() => {
        const clip = _timelineClipboard.segments;
        if (!clip || !clip.length) return;
        pushUndo();
        const baseStart = clip[0].start || 0;
        const offset = playheadT - baseStart;
        const next = cloneSegments(safeSegs);
        const newSegs = clip.map((s) => ({
            ...JSON.parse(JSON.stringify(s)),
            start: clamp((s.start || 0) + offset, 0, duration - 0.2),
            end: clamp((s.end || 0) + offset, 0.2, duration),
        }));
        next.push(...newSegs);
        next.sort((a, b) => (a.start || 0) - (b.start || 0));
        setSegments(next);
        // Select the just-pasted segments by reference.
        const pastedTextSet = new Set(newSegs.map((s) => `${s.start.toFixed(3)}|${s.text}`));
        const newSelection = new Set();
        next.forEach((s, i) => {
            if (pastedTextSet.has(`${(s.start || 0).toFixed(3)}|${s.text}`)) {
                newSelection.add(i);
            }
        });
        setSelectedIds(newSelection);
    }, [safeSegs, playheadT, duration, pushUndo, setSegments]);

    // Duplicate: copy + paste in one shot, placing the copies right
    // AFTER the latest selected segment. Behaves like CapCut/Premiere.
    const duplicateSelection = useCallback(() => {
        const indices = selectedIds.size > 0
            ? Array.from(selectedIds).sort((a, b) => a - b)
            : (selectedIdx >= 0 ? [selectedIdx] : []);
        if (!indices.length) return;
        pushUndo();
        const sources = indices.map((i) => safeSegs[i]).filter(Boolean);
        if (!sources.length) return;
        const lastEnd = Math.max(...sources.map((s) => s.end || 0));
        const baseStart = Math.min(...sources.map((s) => s.start || 0));
        const offset = lastEnd - baseStart;
        const next = cloneSegments(safeSegs);
        const newSegs = sources.map((s) => ({
            ...JSON.parse(JSON.stringify(s)),
            start: clamp((s.start || 0) + offset, 0, duration - 0.2),
            end: clamp((s.end || 0) + offset, 0.2, duration),
        }));
        next.push(...newSegs);
        next.sort((a, b) => (a.start || 0) - (b.start || 0));
        setSegments(next);
        const dupTextSet = new Set(newSegs.map((s) => `${s.start.toFixed(3)}|${s.text}`));
        const newSelection = new Set();
        next.forEach((s, i) => {
            if (dupTextSet.has(`${(s.start || 0).toFixed(3)}|${s.text}`)) {
                newSelection.add(i);
            }
        });
        setSelectedIds(newSelection);
    }, [safeSegs, selectedIds, selectedIdx, duration, pushUndo, setSegments]);

    // Merge: take 2+ selected clips and collapse them into ONE clip,
    // ordered by start time. Text is concatenated with single-space
    // separation and excess whitespace squashed. Word-level timings
    // (used by word-by-word subtitle rendering) are concatenated in
    // time order too. The merged clip inherits the EARLIEST clip's
    // layer.
    //
    // Punctuation handling: we don't insert a space if the previous
    // clip already ends in punctuation followed by a space, so
    // "boom and bust," + "we rise from the dust" → "boom and bust, we
    // rise from the dust" rather than "boom and bust , we rise...".
    const smartJoin = (texts) => {
        const cleaned = (texts || []).map((t) => (t || '').trim()).filter(Boolean);
        return cleaned.join(' ').replace(/\s+/g, ' ').trim();
    };
    const mergeSelection = useCallback(() => {
        const indices = selectedIds.size > 1
            ? Array.from(selectedIds).sort((a, b) => a - b)
            : [];
        if (indices.length < 2) return;
        // Sort the actual clips by start time (not by their array index,
        // which the user might have re-ordered with prior edits).
        const clipsToMerge = indices
            .map((i) => safeSegs[i])
            .filter(Boolean)
            .slice()
            .sort((a, b) => (+a.start || 0) - (+b.start || 0));
        if (clipsToMerge.length < 2) return;
        pushUndo();
        const start = +clipsToMerge[0].start || 0;
        const end = +clipsToMerge[clipsToMerge.length - 1].end || 0;
        const text = smartJoin(clipsToMerge.map((c) => c.text || ''));
        const words = clipsToMerge.flatMap((c) => Array.isArray(c.words) ? c.words : []);
        const merged = {
            ...clipsToMerge[0],
            start, end, text,
            words: words.length ? words : undefined,
            layer: +(clipsToMerge[0].layer || 0),
        };
        const next = safeSegs.filter((_, i) => !indices.includes(i));
        next.push(merged);
        next.sort((a, b) => (+a.start || 0) - (+b.start || 0));
        setSegments(next);
        const newIdx = next.findIndex((s) => s === merged);
        setSelectedIdx(newIdx);
        setSelectedIds(new Set([newIdx]));
    }, [selectedIds, safeSegs, pushUndo, setSegments]);

    const undo = useCallback(() => {
        if (!undoRef.current.length) return;
        redoRef.current.push(cloneSegments(safeSegs));
        const prev = undoRef.current.pop();
        setSegments(prev);
        setSelectedIdx(-1);
    }, [safeSegs, setSegments]);
    const redo = useCallback(() => {
        if (!redoRef.current.length) return;
        undoRef.current.push(cloneSegments(safeSegs));
        const next = redoRef.current.pop();
        setSegments(next);
    }, [safeSegs, setSegments]);

    // ─── pointer handling ────────────────────────────────────────────────

    const startDrag = (e, idx, mode) => {
        e.stopPropagation();
        e.preventDefault();
        pushUndo();

        // MULTI-CLIP DRAG: when the dragged clip is part of an active
        // multi-selection AND the user is doing a 'move' (not edge
        // resize), drag every selected clip together by the same delta.
        // For edge-resize (resize-l / resize-r) the drag stays per-clip
        // since resizing several different-length clips by the same dt
        // doesn't make geometric sense.
        const isInMultiSel = selectedIds.has(idx) && selectedIds.size > 1;
        let multiIndices = null;
        let multiStartSegs = null;
        if (isInMultiSel && mode === 'move') {
            multiIndices = Array.from(selectedIds);
            multiStartSegs = multiIndices.map((i) => ({
                ...safeSegs[i],
                words: Array.isArray(safeSegs[i].words)
                    ? safeSegs[i].words.map((w) => ({ ...w }))
                    : safeSegs[i].words,
            }));
        } else {
            // Plain single-clip drag — clear multi-selection so the
            // user's NEXT drag starts with just one clip.
            setSelectedIdx(idx);
            setSelectedIds(new Set([idx]));
        }

        setDragInfo({
            idx, mode,
            startX: e.clientX, startY: e.clientY,
            startSeg: { ...safeSegs[idx] },
            multiIndices, multiStartSegs,
        });
    };

    useEffect(() => {
        if (!dragInfo) return;
        const onMove = (e) => {
            const dx = e.clientX - dragInfo.startX;
            const dy = e.clientY - dragInfo.startY;
            const dt = dx / pps;

            // GROUP-SHIFT (DIRECTIONAL ripple): the user clicks an
            // anchor clip and drags. The DIRECTION is LOCKED at the
            // moment of the first significant movement, then stays
            // locked for the rest of the drag — so a user can pull
            // right, hesitate, pull back through zero and into the
            // negative without the affected SET swapping mid-drag.
            //
            //   Initial drag RIGHT  → set = anchor + every clip with
            //                         start ≥ anchor (the right-side
            //                         set). LOCKED for this drag.
            //   Initial drag LEFT   → set = anchor + every clip with
            //                         start ≤ anchor (the left-side
            //                         set). LOCKED for this drag.
            //
            // After release, the next click+drag re-locks the
            // direction based on its own initial movement.
            //
            // anchorStart is captured at drag-start (dragInfo.anchorStart).
            // If the anchor wasn't a specific clip (dragging on empty
            // track), behave like the old "shift everything" mode and
            // apply dt to all segments regardless of direction.
            if (dragInfo.mode === 'group-shift') {
                if (!dragInfo.startSegs) return;
                const anchorStart = dragInfo.anchorStart;

                // Lock direction on first significant motion (>2 px
                // threshold avoids accidental locks from cursor jitter).
                if (dragInfo.lockedDirection === undefined && Math.abs(dx) > 2) {
                    dragInfo.lockedDirection = dx > 0 ? 'right' : 'left';
                }
                const locked = dragInfo.lockedDirection; // 'right' | 'left' | undefined

                const affected = (s) => {
                    if (anchorStart === undefined || anchorStart === null) return true;
                    if (locked === undefined) return false; // no movement yet
                    const ss = +s.start || 0;
                    return locked === 'right' ? ss >= anchorStart : ss <= anchorStart;
                };
                // Compute the affected set ONCE (locked direction →
                // membership doesn't change for the rest of the drag).
                const affectedSegs = dragInfo.startSegs.filter(affected);
                if (affectedSegs.length === 0) return;
                const minStart = Math.min(...affectedSegs.map((s) => +s.start || 0));
                const maxEnd = Math.max(...affectedSegs.map((s) => +s.end || 0));
                const minAllowed = -minStart;
                const maxAllowed = duration - maxEnd;
                // Apply the SIGNED dt — once direction is locked, the
                // user can pull either way and the set tracks the cursor.
                const shift = clamp(dt, minAllowed, maxAllowed);
                const shifted = dragInfo.startSegs.map((s) => {
                    if (!affected(s)) return s;
                    return {
                        ...s,
                        start: (+s.start || 0) + shift,
                        end: (+s.end || 0) + shift,
                        words: Array.isArray(s.words) ? s.words.map((w) => ({
                            ...w,
                            start: (+w.start || 0) + shift,
                            end: (+w.end || 0) + shift,
                        })) : s.words,
                    };
                });
                setSegments(shifted);
                return;
            }

            const orig = dragInfo.startSeg;
            const next = cloneSegments(safeSegs);
            const cur = next[dragInfo.idx];
            if (!cur) return;

            // MULTI-CLIP MOVE — when multiIndices is populated, apply
            // the same dt + dy to every selected clip, preserving
            // their relative spacing. Clamp the shift so the earliest
            // start stays ≥ 0 and the latest end stays ≤ duration.
            if (dragInfo.mode === 'move' && dragInfo.multiIndices) {
                const startSegs = dragInfo.multiStartSegs;
                const minStart = Math.min(...startSegs.map((s) => +s.start || 0));
                const maxEnd = Math.max(...startSegs.map((s) => +s.end || 0));
                const minAllowed = -minStart;
                const maxAllowed = duration - maxEnd;
                const shift = clamp(dt, minAllowed, maxAllowed);

                // Layer shift — clamp so no clip drops below layer 0.
                const minLayer = Math.min(...startSegs.map((s) => +(s.layer || 0)));
                const layerDeltaRaw = -Math.round(dy / LAYER_HEIGHT);
                const layerDelta = Math.max(-minLayer, layerDeltaRaw);

                for (let k = 0; k < dragInfo.multiIndices.length; k++) {
                    const i = dragInfo.multiIndices[k];
                    const o = startSegs[k];
                    const c = next[i];
                    if (!c || !o) continue;
                    c.start = (+o.start || 0) + shift;
                    c.end = (+o.end || 0) + shift;
                    c.layer = (+(o.layer || 0)) + layerDelta;
                    if (Array.isArray(o.words)) {
                        c.words = o.words.map((w) => ({
                            ...w,
                            start: (+w.start || 0) + shift,
                            end: (+w.end || 0) + shift,
                        }));
                    }
                }
                setSegments(next);
                return;
            }

            if (dragInfo.mode === 'move') {
                const newStart = clamp(orig.start + dt, 0, duration - (orig.end - orig.start));
                cur.start = newStart;
                cur.end = newStart + (orig.end - orig.start);
                // Vertical drag → change layer. Inverted because in CSS
                // moving "up" decreases Y (smaller pixel value) but
                // visually the user expects a higher layer NUMBER. We
                // map negative dy → higher layer.
                const startLayer = +(orig.layer || 0);
                const layerDelta = -Math.round(dy / LAYER_HEIGHT);
                const newLayer = Math.max(0, startLayer + layerDelta);
                cur.layer = newLayer;
            } else if (dragInfo.mode === 'resize-l') {
                cur.start = clamp(orig.start + dt, 0, orig.end - 0.2);
            } else if (dragInfo.mode === 'resize-r') {
                cur.end = clamp(orig.end + dt, orig.start + 0.2, duration);
            }
            setSegments(next);
        };
        const onUp = () => setDragInfo(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [dragInfo, pps, duration, safeSegs, setSegments, LAYER_HEIGHT]);

    // Seek by clicking the ruler.
    const seekFromX = useCallback((clientX) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const x = clientX - rect.left + track.scrollLeft;
        const t = clamp(x / pps, 0, duration);
        const v = videoRef?.current;
        if (v) v.currentTime = t;
        setPlayheadT(t);
    }, [pps, duration, videoRef]);

    // Zoom helper that preserves the VIEWPORT CENTER. Without this,
    // hitting +/- snaps the visible window away from whatever the
    // user is looking at because the scroll-left stays at the same
    // pixel value but the time-per-pixel changes. By recording the
    // center in time-space before zoom and restoring it after, the
    // user's current focus stays put through the zoom.
    //
    // (Defined HERE — before the keyboard-shortcut effect — because
    // the keyboard effect lists `zoomBy` in its dependency array.
    // JS const declarations are hoisted into the temporal dead zone,
    // so referencing `zoomBy` before this line throws a ReferenceError
    // at first render. Putting the const ABOVE the effect avoids that.)
    const zoomBy = useCallback((factor) => {
        setPps((cur) => {
            const newPps = clamp(cur * factor, minPixelsPerSecond, maxPixelsPerSecond);
            const trackEl = trackRef.current;
            if (trackEl) {
                const visibleW = trackEl.clientWidth || 1;
                const centerX = trackEl.scrollLeft + visibleW / 2;
                const centerT = centerX / cur;
                // After the next paint the new pps is in effect; we
                // queue the scroll adjustment for the same frame so
                // the user sees the change as a single zoom.
                requestAnimationFrame(() => {
                    if (!trackEl) return;
                    const newScrollLeft = Math.max(0, centerT * newPps - visibleW / 2);
                    trackEl.scrollLeft = newScrollLeft;
                });
            }
            return newPps;
        });
    }, [minPixelsPerSecond, maxPixelsPerSecond]);

    // Keyboard shortcuts.
    useEffect(() => {
        const onKey = (e) => {
            // Only handle when the timeline (or its container) has focus
            // OR no input/textarea is focused — avoids hijacking text edit.
            const tag = (document.activeElement?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
            const cmd = e.metaKey || e.ctrlKey;
            const v = videoRef?.current;
            const key = e.key.toLowerCase();

            // ─── Editing shortcuts ────────────────────────────────────
            if (cmd && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            } else if (cmd && key === 'c') {
                e.preventDefault();
                copySelection();
            } else if (cmd && key === 'x') {
                // Cut = copy + delete. Standard NLE behaviour: clip
                // disappears from the timeline; ⌘V at any later spot
                // pastes it (preserving relative spacing if multiple).
                e.preventDefault();
                copySelection();
                if (selectedIds.size > 0 || selectedIdx >= 0) {
                    pushUndo();
                    const sortedDesc = selectedIds.size > 0
                        ? Array.from(selectedIds).sort((a, b) => b - a)
                        : [selectedIdx];
                    let next = cloneSegments(safeSegs);
                    for (const idx of sortedDesc) next.splice(idx, 1);
                    setSegments(next);
                    setSelectedIds(new Set());
                    setSelectedIdx(-1);
                }
            } else if (cmd && key === 'v') {
                e.preventDefault();
                pasteAtPlayhead();
            } else if (cmd && key === 'd') {
                e.preventDefault();
                duplicateSelection();
            } else if (cmd && key === 'm') {
                e.preventDefault();
                mergeSelection();
            } else if (cmd && key === 'a') {
                e.preventDefault();
                // Select all
                const all = new Set(safeSegs.map((_, i) => i));
                setSelectedIds(all);
                if (safeSegs.length) setSelectedIdx(0);
            } else if (e.key === 'Escape') {
                // Standard "deselect everything" key. Also cancels
                // any in-progress inline text edit (the input's own
                // Esc handler already covers that), and cancels a
                // marquee in progress.
                e.preventDefault();
                setSelectedIdx(-1);
                setSelectedIds(new Set());
                setMarquee(null);
            } else if (key === 'v' && !cmd) {
                // 'V' (no cmd) = switch to select tool — Premiere convention
                e.preventDefault();
                setToolMode('select');
            } else if (key === 'h' && !cmd) {
                // 'H' = group-shift (hand) tool
                e.preventDefault();
                setToolMode('group-shift');
            } else if (key === 's' && selectedIdx >= 0) {
                e.preventDefault();
                splitAt(selectedIdx, playheadT);
            } else if ((e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault();
                // Delete all selected; fall back to selectedIdx for legacy paths.
                if (selectedIds.size > 0) {
                    pushUndo();
                    const sortedDesc = Array.from(selectedIds).sort((a, b) => b - a);
                    let next = cloneSegments(safeSegs);
                    for (const idx of sortedDesc) next.splice(idx, 1);
                    setSegments(next);
                    setSelectedIds(new Set());
                    setSelectedIdx(-1);
                } else if (selectedIdx >= 0) {
                    deleteAt(selectedIdx);
                }
            } else if (e.key === '+' || (e.key === '=' && e.shiftKey === false)) {
                zoomBy(1.25);
            } else if (e.key === '-' || e.key === '_') {
                zoomBy(1 / 1.25);
            }
            // ─── JKL playback shortcuts (NLE-standard) ────────────────
            // Space, J, K, L. Hold-to-repeat is intentionally NOT used —
            // each TAP of L doubles the rate, each TAP of J doubles the
            // reverse rate. This matches Premiere/Resolve behavior.
            else if (e.key === ' ' && v) {
                e.preventDefault();
                if (reverseRate > 0) {
                    setReverseRate(0);
                    setRateHud({ label: 'Paused' });
                    return;
                }
                if (v.paused) {
                    try { v.playbackRate = 1; v.play(); } catch {}
                    setRateHud({ label: 'Playing 1×' });
                } else {
                    try { v.pause(); } catch {}
                    setRateHud({ label: 'Paused' });
                }
            }
            else if (key === 'l' && !cmd && v) {
                e.preventDefault();
                // Cancel any reverse play first.
                if (reverseRate > 0) setReverseRate(0);
                // Successive presses: 1 → 2 → 4 → 8, then wraps back to 1.
                let cur = (v.playbackRate && v.playbackRate >= 1) ? v.playbackRate : 1;
                let next;
                if (v.paused) next = 1;
                else if (cur >= 8) next = 1;
                else next = Math.min(8, cur * 2);
                try {
                    v.playbackRate = next;
                    if (v.paused) v.play();
                } catch {}
                setRateHud({ label: `▶ ${next}×` });
            }
            else if (key === 'k' && !cmd && v) {
                e.preventDefault();
                setReverseRate(0);
                try { v.pause(); v.playbackRate = 1; } catch {}
                setRateHud({ label: 'Paused' });
            }
            else if (key === 'j' && !cmd && v) {
                e.preventDefault();
                // Reverse play. 1 → 2 → 4 → 8, then wraps.
                try { v.pause(); v.playbackRate = 1; } catch {}
                setReverseRate((r) => {
                    let next;
                    if (!r) next = 1;
                    else if (r >= 8) next = 1;
                    else next = Math.min(8, r * 2);
                    setRateHud({ label: `◀ ${next}×` });
                    return next;
                });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedIdx, selectedIds, playheadT, undo, redo, splitAt, deleteAt, minPixelsPerSecond, maxPixelsPerSecond, videoRef, reverseRate, copySelection, pasteAtPlayhead, duplicateSelection, mergeSelection, safeSegs, pushUndo, setSegments, zoomBy]);

    // (zoomBy moved above the keyboard-shortcut effect — see comment there.)

    // Build ruler tick marks every 5s (or every 1s if zoomed in tight).
    const tickInterval = pps > 80 ? 1 : pps > 40 ? 5 : 10;
    const ticks = [];
    for (let t = 0; t <= duration; t += tickInterval) ticks.push(t);

    return (
        <div className="rounded-xl border border-white/10 bg-black/40 overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/10 bg-black/40 text-[11px]">
                {/* TOOL SELECTOR — two cursor modes:
                    • Select tool (V)        → individual subtitle editing
                    • Group-shift tool (H)    → drag anywhere to move ALL
                                                 subtitles in time at once.
                    The active tool gets a brighter ring; the cursor over
                    the track also changes (default vs ew-resize). */}
                <div className="inline-flex items-stretch rounded border border-white/10 bg-black/40 mr-1">
                    <button
                        onClick={() => setToolMode('select')}
                        title="Select tool (V) — click subtitles to edit one at a time. Shift-click to multi-select."
                        className={
                            'inline-flex items-center gap-1 px-2 py-1 transition '
                            + (toolMode === 'select'
                                ? 'bg-blue-500/30 text-blue-100'
                                : 'text-zinc-400 hover:text-white')
                        }
                    >
                        <MousePointer size={12} />
                    </button>
                    <button
                        onClick={() => setToolMode('group-shift')}
                        title="Group-shift tool (H, hand) — click a clip then drag left or right to move that clip + every clip on its side together. Direction locks at the first significant motion."
                        className={
                            'inline-flex items-center gap-1 px-2 py-1 transition border-l border-white/10 '
                            + (toolMode === 'group-shift'
                                ? 'bg-amber-500/30 text-amber-100'
                                : 'text-zinc-400 hover:text-white')
                        }
                    >
                        <Hand size={12} />
                    </button>
                </div>
                <button
                    onClick={() => addAt(playheadT)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-emerald-600/30 text-emerald-200 hover:bg-emerald-600/50"
                    title="Add a new subtitle at the playhead (then click it to edit)"
                >
                    <Plus size={12} /> Add
                </button>
                <button
                    onClick={() => selectedIdx >= 0 && splitAt(selectedIdx, playheadT)}
                    disabled={selectedIdx < 0}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-violet-600/30 text-violet-200 hover:bg-violet-600/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Split the selected subtitle at the playhead (S)"
                >
                    <Scissors size={12} /> Split
                </button>
                <button
                    onClick={() => selectedIdx >= 0 && deleteAt(selectedIdx)}
                    disabled={selectedIdx < 0 && selectedIds.size === 0}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-rose-600/30 text-rose-200 hover:bg-rose-600/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Delete the selected subtitle(s) (Del / Backspace)"
                >
                    <Trash2 size={12} /> Delete
                </button>
                <div className="mx-2 h-4 w-px bg-white/10" />
                {/* Copy / Paste / Duplicate — standard NLE keyboard
                    shortcuts work too: ⌘C / ⌘V / ⌘D. Buttons exist for
                    discoverability and touch-screen / iPad support. */}
                <button
                    onClick={copySelection}
                    disabled={selectedIdx < 0 && selectedIds.size === 0}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Copy the selected subtitle(s) to clipboard (⌘C / Ctrl+C)"
                >
                    <CopyIcon size={12} />
                </button>
                <button
                    onClick={pasteAtPlayhead}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50"
                    title="Paste copied subtitle(s) at the playhead (⌘V / Ctrl+V)"
                >
                    <ClipboardPaste size={12} />
                </button>
                <button
                    onClick={duplicateSelection}
                    disabled={selectedIdx < 0 && selectedIds.size === 0}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Duplicate the selected subtitle(s) right after the original (⌘D / Ctrl+D)"
                >
                    <CopyPlus size={12} />
                </button>
                <button
                    onClick={mergeSelection}
                    disabled={selectedIds.size < 2}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-violet-600/20 text-violet-200 hover:bg-violet-600/40 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Merge selected subtitles into one (⌘M / Ctrl+M). Text is concatenated in time order with proper spacing; the merged clip spans from the earliest start to the latest end."
                >
                    <Combine size={12} /> Merge
                </button>
                <div className="mx-2 h-4 w-px bg-white/10" />
                <button onClick={undo} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50" title="Undo (⌘Z)">
                    <Undo2 size={12} />
                </button>
                <button onClick={redo} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50" title="Redo (⌘⇧Z)">
                    <Redo2 size={12} />
                </button>
                <div className="mx-2 h-4 w-px bg-white/10" />
                <button
                    onClick={() => zoomBy(1 / 1.25)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50"
                    title="Zoom out (-) — keeps the visible center anchored, so you don't lose your place"
                >
                    <ZoomOut size={12} />
                </button>
                <button
                    onClick={() => zoomBy(1.25)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50"
                    title="Zoom in (+) — keeps the visible center anchored, so you don't lose your place"
                >
                    <ZoomIn size={12} />
                </button>
                <button
                    onClick={() => setPps(initialPixelsPerSecond)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/30 text-zinc-300 hover:bg-black/50"
                    title="Reset zoom"
                >
                    <Maximize2 size={12} />
                </button>
                <div className="ml-auto text-zinc-400 tabular-nums flex items-center gap-2">
                    {/* Transient playback-rate HUD — shows current rate
                        for ~1s after each Space/J/K/L tap so the user
                        gets explicit feedback on what they pressed. */}
                    {rateHud && (
                        <span
                            className="px-2 py-0.5 rounded-md bg-blue-500/25 border border-blue-400/40 text-blue-100 text-[10px] tabular-nums"
                            style={{ animation: 'fadeIn 120ms ease-out' }}
                        >
                            {rateHud.label}
                        </span>
                    )}
                    <span>
                        Playhead {fmtTime(playheadT)} · {safeSegs.length} subs
                    </span>
                </div>
            </div>

            {/* Scroll viewport with ruler + waveform + multi-lane track.
                BOTTOM_GUTTER reserves space below the bottom lane so the
                horizontal scrollbar doesn't overlap the bottom-row clips
                — without it the scroll thumb sits right on top of the
                bottom layer's blocks and clicks miss. */}
            <div ref={trackRef} className="overflow-x-auto" style={{ height: 18 + WAVEFORM_HEIGHT + numLayers * LAYER_HEIGHT + 24 }}>
                <div style={{ position: 'relative', width: trackWidth, height: 18 + WAVEFORM_HEIGHT + numLayers * LAYER_HEIGHT + 24 }}>
                    {/* Ruler — clicking seeks the audio */}
                    <div
                        ref={rulerRef}
                        onPointerDown={(e) => seekFromX(e.clientX)}
                        className="select-none cursor-pointer"
                        style={{
                            position: 'absolute', top: 0, left: 0,
                            width: trackWidth, height: 18,
                            background: 'rgba(0,0,0,0.4)',
                            borderBottom: '1px solid rgba(255,255,255,0.1)',
                        }}
                    >
                        {ticks.map((t) => (
                            <div
                                key={t}
                                style={{
                                    position: 'absolute', left: t * pps, top: 0,
                                    height: 18, paddingLeft: 4, fontSize: 10,
                                    color: 'rgba(255,255,255,0.5)',
                                    borderLeft: '1px solid rgba(255,255,255,0.1)',
                                }}
                            >
                                {fmtTime(t)}
                            </div>
                        ))}
                    </div>

                    {/* AUDIO WAVEFORM — sits between ruler and the
                        subtitle lanes. Read-only visual reference; users
                        align subtitle blocks against the visible audio
                        peaks. Clicking it seeks the playhead. */}
                    <div
                        onPointerDown={(e) => seekFromX(e.clientX)}
                        title={waveformLoading ? 'Decoding audio…' : (waveform ? 'Click to seek' : 'No audio waveform available')}
                        style={{
                            position: 'absolute', top: 18, left: 0,
                            width: trackWidth, height: WAVEFORM_HEIGHT,
                            background: 'rgba(0,0,0,0.55)',
                            borderBottom: '1px solid rgba(255,255,255,0.08)',
                            cursor: 'pointer',
                            overflow: 'hidden',
                        }}
                    >
                        <canvas
                            ref={waveformCanvasRef}
                            style={{ display: 'block', width: trackWidth, height: WAVEFORM_HEIGHT }}
                        />
                        {waveformLoading && (
                            <div style={{
                                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: 'rgba(255,255,255,0.5)', fontSize: 10, pointerEvents: 'none',
                            }}>
                                Decoding audio waveform…
                            </div>
                        )}
                    </div>

                    {/* Layer rail labels on the LEFT (sticky, doesn't
                        scroll horizontally) so users can see "Layer 1",
                        "Layer 2", etc. Fixed-position relative to the
                        viewport, not the scrolling content. */}
                    {Array.from({ length: numLayers }).map((_, layerIdx) => {
                        // We render layers TOP = highest index (so a
                        // higher layer number appears physically above).
                        const visualRow = numLayers - 1 - layerIdx;
                        return (
                            <div
                                key={`lane-bg-${layerIdx}`}
                                style={{
                                    position: 'absolute',
                                    top: 18 + WAVEFORM_HEIGHT + visualRow * LAYER_HEIGHT,
                                    left: 0, width: trackWidth, height: LAYER_HEIGHT,
                                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                                    background: layerIdx === 0
                                        ? 'rgba(16,185,129,0.04)'   // base layer faint emerald
                                        : 'rgba(96,165,250,0.04)',  // higher layers faint blue
                                }}
                            />
                        );
                    })}

                    {/* Subtitle track — clickable empty area:
                        • In 'select' mode → drag to draw a rubber-band
                          marquee. Any clips intersecting the rectangle
                          get selected.
                        • In 'group-shift' mode → start a group drag
                          that shifts segments in time. */}
                    <div
                        onPointerDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (toolMode === 'group-shift' && safeSegs.length > 0) {
                                e.preventDefault();
                                pushUndo();
                                setDragInfo({
                                    mode: 'group-shift',
                                    startX: e.clientX, startY: e.clientY,
                                    // Snapshot ALL segments at drag-start so the
                                    // delta math is stable across frames.
                                    startSegs: safeSegs.map((s) => ({
                                        ...s,
                                        words: Array.isArray(s.words) ? s.words.map((w) => ({ ...w })) : s.words,
                                    })),
                                });
                                return;
                            }
                            if (toolMode === 'select') {
                                e.preventDefault();
                                // Start a marquee selection. Use the OUTER
                                // scroll container's rect as our reference
                                // frame — same as the move handler — so
                                // the start point and end point share one
                                // coordinate system. (Earlier we used the
                                // inner subtitle-track rect AND added
                                // scrollLeft, which double-counted the
                                // scroll and made the marquee start
                                // hundreds of pixels to the right of the
                                // actual click position.)
                                const trackEl = trackRef.current;
                                if (!trackEl) return;
                                const rect = trackEl.getBoundingClientRect();
                                const sl = trackEl.scrollLeft || 0;
                                const x = e.clientX - rect.left + sl;
                                const y = e.clientY - rect.top - 18 - WAVEFORM_HEIGHT;
                                setMarquee({ x1: x, y1: y, x2: x, y2: y, additive: e.shiftKey });
                                if (!e.shiftKey) {
                                    setSelectedIdx(-1);
                                    setSelectedIds(new Set());
                                }
                            }
                        }}
                        style={{
                            position: 'absolute',
                            top: 18 + WAVEFORM_HEIGHT, left: 0,
                            width: trackWidth, height: numLayers * LAYER_HEIGHT,
                            background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.02), rgba(255,255,255,0.02) 1px, transparent 1px, transparent 40px)',
                            cursor: toolMode === 'group-shift' ? 'grab' : 'crosshair',
                        }}
                    >
                        {safeSegs.map((seg, idx) => {
                            const start = +seg.start || 0;
                            const end = +seg.end || start + 1;
                            const left = start * pps;
                            const width = Math.max(20, (end - start) * pps);
                            // A block is "selected" if it's in the multi-select
                            // set, OR (when the set is empty) if it matches
                            // selectedIdx — keeps single-click behaviour familiar.
                            const isSel = selectedIds.has(idx) || (selectedIds.size === 0 && idx === selectedIdx);
                            const c = blockColor(idx, isSel);
                            // Compute vertical position from layer index.
                            // Higher layer number → physically higher
                            // visual row (so dragging UP increases layer).
                            const layer = Math.max(0, +(seg.layer || 0));
                            const visualRow = numLayers - 1 - layer;
                            const blockTop = visualRow * LAYER_HEIGHT + 4;
                            const blockHeight = LAYER_HEIGHT - 8;
                            return (
                                <div
                                    key={idx}
                                    onPointerDown={(e) => {
                                        // Don't start a drag while user is editing — let
                                        // the click pass through to the input field.
                                        if (editingIdx === idx) return;
                                        // In GROUP-SHIFT tool mode, clicking a block
                                        // anchors the directional ripple at THIS
                                        // segment's start time. Drag right → this
                                        // clip + all later clips move; drag left →
                                        // this clip + all earlier clips move.
                                        if (toolMode === 'group-shift' && safeSegs.length > 0) {
                                            e.stopPropagation();
                                            e.preventDefault();
                                            pushUndo();
                                            setSelectedIdx(idx);
                                            setSelectedIds(new Set([idx]));
                                            setDragInfo({
                                                mode: 'group-shift',
                                                startX: e.clientX, startY: e.clientY,
                                                anchorStart: +seg.start || 0,
                                                anchorIdx: idx,
                                                startSegs: safeSegs.map((s) => ({
                                                    ...s,
                                                    words: Array.isArray(s.words) ? s.words.map((w) => ({ ...w })) : s.words,
                                                })),
                                            });
                                            return;
                                        }
                                        startDrag(e, idx, 'move');
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        // Shift OR Cmd/Ctrl click → toggle into the
                                        // multi-selection (Cmd is the Mac convention,
                                        // Shift is the Windows convention; supporting
                                        // both is the standard cross-platform behaviour).
                                        if (e.shiftKey || e.metaKey || e.ctrlKey) {
                                            toggleSelection(idx);
                                            return;
                                        }
                                        // Plain click on a clip ALREADY in a
                                        // multi-selection → keep the multi-selection
                                        // intact (user is probably about to drag the
                                        // group). Plain click on a different clip →
                                        // collapse to single selection.
                                        if (selectedIds.has(idx) && selectedIds.size > 1) {
                                            setSelectedIdx(idx);
                                            return;
                                        }
                                        setSingleSelection(idx);
                                    }}
                                    onDoubleClick={(e) => {
                                        // Double-click anywhere in the block → enter
                                        // text-edit mode. The block stays in place
                                        // (no drag) until the user blurs / Enters.
                                        e.stopPropagation();
                                        setEditingIdx(idx);
                                        setEditingText(seg.text || '');
                                        setSelectedIdx(idx);
                                    }}
                                    style={{
                                        position: 'absolute',
                                        top: blockTop,
                                        left,
                                        width,
                                        height: blockHeight,
                                        background: c.background,
                                        borderRadius: 6,
                                        border: `2px solid ${c.borderColor}`,
                                        boxShadow: isSel ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none',
                                        cursor: editingIdx === idx ? 'text' : 'grab',
                                        overflow: 'hidden',
                                        padding: '4px 6px',
                                        fontSize: 11,
                                        lineHeight: 1.2,
                                        color: 'white',
                                        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                                        userSelect: editingIdx === idx ? 'text' : 'none',
                                        whiteSpace: 'nowrap',
                                        textOverflow: 'ellipsis',
                                    }}
                                    title={editingIdx === idx
                                        ? 'Editing — Enter to save, Esc to cancel.'
                                        : `${fmtTime(start)} → ${fmtTime(end)}\n${seg.text || ''}\nClick to select. Drag to move. Drag edges to resize. Double-click to edit text.`
                                    }
                                >
                                    {/* Left resize handle — hidden during text edit */}
                                    {editingIdx !== idx && (
                                        <div
                                            onPointerDown={(e) => startDrag(e, idx, 'resize-l')}
                                            style={{
                                                position: 'absolute', left: 0, top: 0, bottom: 0,
                                                width: 6, cursor: 'ew-resize',
                                                background: 'rgba(0,0,0,0.25)',
                                            }}
                                        />
                                    )}
                                    {/* Right resize handle — hidden during text edit */}
                                    {editingIdx !== idx && (
                                        <div
                                            onPointerDown={(e) => startDrag(e, idx, 'resize-r')}
                                            style={{
                                                position: 'absolute', right: 0, top: 0, bottom: 0,
                                                width: 6, cursor: 'ew-resize',
                                                background: 'rgba(0,0,0,0.25)',
                                            }}
                                        />
                                    )}
                                    {editingIdx === idx ? (
                                        <input
                                            autoFocus
                                            value={editingText}
                                            onChange={(e) => setEditingText(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    pushUndo();
                                                    updateSegment(idx, { text: editingText });
                                                    setEditingIdx(-1);
                                                } else if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    setEditingIdx(-1);
                                                    setEditingText('');
                                                }
                                                e.stopPropagation();
                                            }}
                                            onBlur={() => {
                                                // Save on blur so users can also click
                                                // away to commit (matches typical web
                                                // editor expectations).
                                                if (editingText !== (seg.text || '')) {
                                                    pushUndo();
                                                    updateSegment(idx, { text: editingText });
                                                }
                                                setEditingIdx(-1);
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            style={{
                                                width: '100%',
                                                background: 'rgba(0,0,0,0.55)',
                                                border: '1px solid rgba(255,255,255,0.6)',
                                                borderRadius: 3,
                                                color: 'white',
                                                fontSize: 11,
                                                padding: '1px 4px',
                                                outline: 'none',
                                            }}
                                        />
                                    ) : (
                                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {seg.text || '(empty)'}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                    </div>

                    {/* MARQUEE — translucent selection rectangle drawn
                        while the user is rubber-band-selecting clips
                        in 'select' tool mode. Positioned over the
                        subtitle lanes (below ruler+waveform). */}
                    {marquee && (() => {
                        const minX = Math.min(marquee.x1, marquee.x2);
                        const maxX = Math.max(marquee.x1, marquee.x2);
                        const minY = Math.min(marquee.y1, marquee.y2);
                        const maxY = Math.max(marquee.y1, marquee.y2);
                        return (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: minX,
                                    top: 18 + WAVEFORM_HEIGHT + Math.max(0, minY),
                                    width: Math.max(1, maxX - minX),
                                    height: Math.max(1, maxY - minY),
                                    background: 'rgba(96,165,250,0.18)',
                                    border: '1px dashed rgba(96,165,250,0.85)',
                                    pointerEvents: 'none',
                                    zIndex: 9,
                                }}
                            />
                        );
                    })()}

                    {/* Playhead — spans the full timeline (ruler +
                        waveform + all subtitle lanes). Sits OUTSIDE the
                        subtitle track div so it stays on top of the
                        waveform too. */}
                    <div
                        style={{
                            position: 'absolute',
                            top: 0, bottom: 0,
                            left: playheadT * pps,
                            width: 2,
                            background: '#f43f5e',
                            pointerEvents: 'none',
                            boxShadow: '0 0 6px rgba(244,63,94,0.7)',
                            zIndex: 10,
                        }}
                    />
                </div>
            </div>

            {/* Hint footer */}
            <div className="px-3 py-1.5 border-t border-white/10 bg-black/40 text-[10px] text-zinc-500">
                Click to select · Drag horizontally to retime · <strong className="text-zinc-300">Drag UP to add a new layer</strong> · Drag edges to resize · Double-click to edit text · <kbd className="px-1 rounded bg-white/10 text-zinc-300">S</kbd> split · <kbd className="px-1 rounded bg-white/10 text-zinc-300">Del</kbd> remove · <kbd className="px-1 rounded bg-white/10 text-zinc-300">⌘Z</kbd> undo · <kbd className="px-1 rounded bg-white/10 text-zinc-300">Space</kbd> play/pause · <kbd className="px-1 rounded bg-white/10 text-zinc-300">J</kbd>/<kbd className="px-1 rounded bg-white/10 text-zinc-300">K</kbd>/<kbd className="px-1 rounded bg-white/10 text-zinc-300">L</kbd> reverse/pause/forward
            </div>
        </div>
    );
}
