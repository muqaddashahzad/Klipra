import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Loader2, Play, Pause, SkipBack, SkipForward, Scissors,
    ZoomIn, ZoomOut, Maximize2, Gauge, Undo2, Redo2, Plus, Trash2,
    ListVideo, Film, CornerDownLeft,
} from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Edit clip timing — a real, NLE-style sequence editor (think DaVinci /
 * Premiere) for re-cutting a clip BEFORE it re-renders.
 *
 * Mental model — two monitors, like every pro editor:
 *
 *   ┌─ SOURCE ────────────────────────────────────────────┐
 *   │  the whole source video + waveform. Play it, mark    │
 *   │  IN / OUT (or drag a selection), then "Add to        │
 *   │  sequence" to drop that span into the program below. │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─ SEQUENCE (the program — what actually exports) ─────┐
 *   │  the kept segments laid out as blocks. Reorder them  │
 *   │  by dragging, trim their edges, select a GAP between  │
 *   │  two ranges and press Delete to ripple-close it so    │
 *   │  the ranges butt together, then ▶ play the assembled │
 *   │  cut. Full undo / redo.                               │
 *   └──────────────────────────────────────────────────────┘
 *
 * The export = the kept segments concatenated in sequence order. Gaps are
 * source footage BETWEEN your ranges; they're never exported — closing a
 * gap is a preview convenience that butts the neighbouring blocks together.
 * To remove an unwanted middle section of a range, marquee-select it on the
 * source and hit "Remove" (or Delete) — the range splits in two and the
 * halves play back-to-back.
 *
 * Backend contract: POST /api/clip/{job}/{idx}/retrim with either the legacy
 * {new_start, new_end} (single segment) or {new_start, new_end, ranges:[…]}
 * (multi). Ranges are rendered in the ORDER sent (the backend no longer
 * force-sorts them), so drag-reorder is honoured.
 */

const FPS = 30;
const EPS = 1 / FPS / 2;

const draftKey = (jobId, index) => `klipra_retrim_seq_draft:${jobId}:${index}`;

// Stable ids for segment blocks so React keys + drag survive re-sorts.
let _segId = 1;
const nextId = () => _segId++;

// ---- Pure interval algebra on the kept-segment list --------------------
// Each segment is {start, end, id} in SOURCE seconds. The list order IS the
// export order.

/** Merge a new [a,b] span into the list (union), keeping things chronological
 *  and collapsing any overlap. Used by "Add to sequence". */
function addSpan(segs, a, b) {
    if (b <= a + EPS) return segs;
    const merged = [...segs.map((s) => ({ ...s })), { start: a, end: b, id: nextId() }]
        .sort((x, y) => x.start - y.start);
    const out = [];
    for (const seg of merged) {
        const last = out[out.length - 1];
        if (last && seg.start <= last.end + EPS) {
            last.end = Math.max(last.end, seg.end);
        } else {
            out.push({ ...seg });
        }
    }
    return out;
}

/** Subtract [a,b] from every segment it overlaps, preserving order and
 *  SPLITTING a segment in two when the cut is interior. This is the
 *  "remove an unwanted middle section" operation. */
function subtractSpan(segs, a, b) {
    if (b <= a + EPS) return segs;
    const out = [];
    for (const seg of segs) {
        if (b <= seg.start + EPS || a >= seg.end - EPS) {
            out.push(seg);            // no overlap — keep as-is
            continue;
        }
        if (a > seg.start + EPS) out.push({ start: seg.start, end: Math.min(a, seg.end), id: seg.id });
        if (b < seg.end - EPS) out.push({ start: Math.max(b, seg.start), end: seg.end, id: nextId() });
        // fully covered → dropped
    }
    return out.filter((s) => s.end > s.start + EPS);
}

const segDur = (s) => Math.max(0, s.end - s.start);
const totalKept = (segs) => segs.reduce((sum, s) => sum + segDur(s), 0);
const sigOf = (segs) => segs.map((s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`).join('|');

export default function RetrimModal({ clip, index, jobId, onClose, onSaved }) {
    const sourceUrl = useMemo(() => getApiUrl(`/api/job/${jobId}/source-video`), [jobId]);

    // ---- Initial segments: hydrate from the clip's existing ranges, or
    //      start with the whole current clip as one segment. ----
    const initialSegments = useMemo(() => {
        if (Array.isArray(clip.ranges) && clip.ranges.length > 0) {
            return clip.ranges.map((r) => ({ start: Number(r.start), end: Number(r.end), id: nextId() }));
        }
        return [{ start: Number(clip.start ?? 0), end: Number(clip.end ?? 0), id: nextId() }];
    }, [clip.ranges, clip.start, clip.end]);

    // Restore a saved draft if it matches the same original clip.
    const restoredDraft = useMemo(() => {
        try {
            const raw = localStorage.getItem(draftKey(jobId, index));
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Math.abs((obj.origStart ?? -1) - (clip.start ?? 0)) > 0.01
                || Math.abs((obj.origEnd ?? -1) - (clip.end ?? 0)) > 0.01) return null;
            if (!Array.isArray(obj.segments) || !obj.segments.length) return null;
            return obj;
        } catch (_) { return null; }
    }, [jobId, index, clip.start, clip.end]);

    const [segments, setSegments] = useState(
        () => (restoredDraft?.segments || initialSegments).map((s) => ({ ...s, id: s.id ?? nextId() }))
    );
    const [closedGaps, setClosedGaps] = useState(() => new Set(restoredDraft?.closedGaps || []));

    // Undo / redo stacks hold {segments, closedGaps} snapshots.
    const [past, setPast] = useState([]);
    const [futureStack, setFutureStack] = useState([]);

    // Selection: either a sequence segment (by id), a gap (by boundary key),
    // or a marquee span on the source ribbon. Mutually exclusive.
    const [selSegId, setSelSegId] = useState(null);
    const [selGapKey, setSelGapKey] = useState(null);
    const [marquee, setMarquee] = useState(null); // {start, end} in source secs

    // Source / playback state.
    const [srcDuration, setSrcDuration] = useState(0);
    const [playheadT, setPlayheadT] = useState(clip.start ?? 0);
    const [playing, setPlaying] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(restoredDraft?.playbackRate ?? 1.0);
    const [waveform, setWaveform] = useState([]);

    // Source-ribbon zoom view [viewStart, viewEnd]; viewEnd 0 = full source.
    const [viewStart, setViewStart] = useState(restoredDraft?.viewStart ?? 0);
    const [viewEnd, setViewEnd] = useState(restoredDraft?.viewEnd ?? 0);

    // Program (assembled) playback.
    const [programPlaying, setProgramPlaying] = useState(false);
    const [programT, setProgramT] = useState(0); // seconds into the assembled cut

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [videoErr, setVideoErr] = useState(null);

    const videoRef = useRef(null);
    const srcRibbonRef = useRef(null);
    const reelRef = useRef(null);
    // Refs mirror state for the <video> timeupdate handler (avoids stale closures).
    const segmentsRef = useRef(segments);
    const programRef = useRef({ playing: false, idx: 0 });
    const marqueeStopRef = useRef(null); // {end} to auto-pause when previewing a span/segment
    useEffect(() => { segmentsRef.current = segments; }, [segments]);

    const snapFrame = useCallback((t) => Math.round(t * FPS) / FPS, []);
    const fmtTime = useCallback((seconds) => {
        const s = Math.max(0, seconds || 0);
        const m = Math.floor(s / 60);
        const restSec = Math.floor(s - m * 60);
        const frames = Math.round((s - Math.floor(s)) * FPS);
        return `${m}:${String(restSec).padStart(2, '0')}.${String(frames).padStart(2, '0')}f`;
    }, []);

    const effViewEnd = viewEnd > 0 ? viewEnd : srcDuration;
    const viewSpan = Math.max(0.001, effViewEnd - viewStart);
    const programDur = useMemo(() => totalKept(segments), [segments]);
    const changed = sigOf(segments) !== sigOf(initialSegments);
    const valid = programDur >= 1 && changed;

    // ---- Mutations go through commit() so undo/redo + draft stay in sync --
    const snapshot = useCallback(() => ({ segments, closedGaps }), [segments, closedGaps]);
    const commit = useCallback((nextSegs, nextClosed) => {
        setPast((p) => [...p.slice(-59), { segments, closedGaps }]);
        setFutureStack([]);
        setSegments(nextSegs);
        if (nextClosed !== undefined) setClosedGaps(nextClosed);
    }, [segments, closedGaps]);

    const undo = useCallback(() => {
        setPast((p) => {
            if (!p.length) return p;
            const prev = p[p.length - 1];
            setFutureStack((f) => [{ segments, closedGaps }, ...f].slice(0, 60));
            setSegments(prev.segments);
            setClosedGaps(prev.closedGaps instanceof Set ? prev.closedGaps : new Set(prev.closedGaps));
            setSelSegId(null); setSelGapKey(null);
            return p.slice(0, -1);
        });
    }, [segments, closedGaps]);

    const redo = useCallback(() => {
        setFutureStack((f) => {
            if (!f.length) return f;
            const nxt = f[0];
            setPast((p) => [...p, { segments, closedGaps }].slice(-60));
            setSegments(nxt.segments);
            setClosedGaps(nxt.closedGaps instanceof Set ? nxt.closedGaps : new Set(nxt.closedGaps));
            setSelSegId(null); setSelGapKey(null);
            return f.slice(1);
        });
    }, [segments, closedGaps]);

    // ---- Persist a draft so closing + reopening restores work-in-progress -
    useEffect(() => {
        if (!jobId) return;
        const key = draftKey(jobId, index);
        if (!changed) { try { localStorage.removeItem(key); } catch (_) {} return; }
        try {
            localStorage.setItem(key, JSON.stringify({
                origStart: clip.start ?? 0,
                origEnd: clip.end ?? 0,
                segments: segments.map((s) => ({ start: s.start, end: s.end, id: s.id })),
                closedGaps: [...closedGaps],
                viewStart, viewEnd, playbackRate,
                savedAt: Date.now(),
            }));
        } catch (_) { /* quota / blocked — non-fatal */ }
    }, [jobId, index, clip.start, clip.end, segments, closedGaps, viewStart, viewEnd, playbackRate, changed]);

    // ---- Source duration via ffprobe (instant) ----------------------------
    // The source is frequently a multi-GB original whose moov atom is at the
    // end of the file, so the <video> element can take 30s+ to report its
    // duration (it has to download gigabytes first). Probe it server-side so
    // the ruler, waveform and scrubbing are usable the moment the modal opens
    // — the <video> metadata, when it eventually arrives, just confirms it.
    useEffect(() => {
        if (!jobId) return;
        let alive = true;
        fetch(getApiUrl(`/api/job/${jobId}/duration`))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d && d.duration > 0) setSrcDuration((cur) => cur || d.duration); })
            .catch(() => {});
        return () => { alive = false; };
    }, [jobId]);

    // ---- Waveform fetch (cached server-side) ------------------------------
    useEffect(() => {
        if (!jobId) return;
        let alive = true;
        fetch(getApiUrl(`/api/job/${jobId}/waveform?bins=800`))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (alive && data && Array.isArray(data.data)) setWaveform(data.data); })
            .catch(() => {});
        return () => { alive = false; };
    }, [jobId]);

    // ---- Video element wiring ---------------------------------------------
    const onLoadedMetadata = (e) => {
        const v = e.currentTarget;
        const dur = isFinite(v.duration) ? v.duration : 0;
        setSrcDuration(dur);
        const first = segmentsRef.current[0];
        try { v.currentTime = Math.max(0, first ? first.start : 0); } catch (_) {}
    };

    const stopProgram = useCallback(() => {
        programRef.current.playing = false;
        setProgramPlaying(false);
        const v = videoRef.current;
        if (v && !v.paused) v.pause();
    }, []);

    const onTimeUpdate = (e) => {
        const v = e.currentTarget;
        const t = v.currentTime || 0;
        setPlayheadT(t);

        // Assembled-program playback: hop from one segment to the next so the
        // kept ranges play back-to-back with the gaps skipped.
        if (programRef.current.playing) {
            const segs = segmentsRef.current;
            const cur = segs[programRef.current.idx];
            if (!cur) { stopProgram(); return; }
            if (t >= cur.end - EPS) {
                const ni = programRef.current.idx + 1;
                if (ni >= segs.length) { stopProgram(); setProgramT(programDur); return; }
                programRef.current.idx = ni;
                try { v.currentTime = segs[ni].start; } catch (_) {}
            }
            // Assembled time = kept duration of finished segments + offset.
            let acc = 0;
            for (let i = 0; i < programRef.current.idx; i++) acc += segDur(segs[i]);
            const within = Math.max(0, Math.min(segDur(cur), t - cur.start));
            setProgramT(acc + within);
            return;
        }

        // Single-span preview (Play selection / Play segment) auto-pause.
        if (marqueeStopRef.current != null && t >= marqueeStopRef.current - EPS) {
            v.pause();
            marqueeStopRef.current = null;
        }
    };

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.playbackRate = playbackRate;
    }, [playbackRate]);

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const on = () => setPlaying(true);
        const off = () => setPlaying(false);
        v.addEventListener('play', on);
        v.addEventListener('pause', off);
        v.addEventListener('ended', off);
        return () => {
            v.removeEventListener('play', on);
            v.removeEventListener('pause', off);
            v.removeEventListener('ended', off);
        };
    }, []);

    const playPause = () => {
        const v = videoRef.current;
        if (!v) return;
        if (programRef.current.playing) { stopProgram(); return; }
        marqueeStopRef.current = null;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    };

    const seekTo = (t) => {
        const v = videoRef.current;
        if (!v) return;
        marqueeStopRef.current = null;
        if (programRef.current.playing) stopProgram();
        try { v.currentTime = Math.max(0, Math.min(srcDuration || t, t)); } catch (_) {}
    };

    // Play the whole assembled program from the top.
    const playProgram = () => {
        const v = videoRef.current;
        if (!v || !segments.length) return;
        setSelSegId(null); setSelGapKey(null); setMarquee(null);
        programRef.current = { playing: true, idx: 0 };
        setProgramPlaying(true);
        setProgramT(0);
        try { v.currentTime = segments[0].start; } catch (_) {}
        v.play().catch(() => {});
    };

    // Preview just one span [a,b] (used by Play selection / double-click seg).
    const playSpan = (a, b) => {
        const v = videoRef.current;
        if (!v) return;
        if (programRef.current.playing) stopProgram();
        try { v.currentTime = a; } catch (_) {}
        marqueeStopRef.current = b;
        v.play().catch(() => {});
    };

    // ---- Atomic timeline operations ---------------------------------------
    const addMarquee = useCallback(() => {
        if (!marquee) return;
        commit(addSpan(segments, snapFrame(marquee.start), snapFrame(marquee.end)));
        setMarquee(null);
    }, [marquee, segments, commit, snapFrame]);

    const removeMarquee = useCallback(() => {
        if (!marquee) return;
        commit(subtractSpan(segments, snapFrame(marquee.start), snapFrame(marquee.end)));
        setMarquee(null);
    }, [marquee, segments, commit, snapFrame]);

    const deleteSegment = useCallback((id) => {
        if (segments.length <= 1) {
            setError('A clip needs at least one segment — add another before deleting this one.');
            return;
        }
        commit(segments.filter((s) => s.id !== id));
        setSelSegId(null);
    }, [segments, commit]);

    const toggleGap = useCallback((key, close) => {
        const next = new Set(closedGaps);
        if (close) next.add(key); else next.delete(key);
        commit(segments, next);
    }, [segments, closedGaps, commit]);

    // ---- Mark IN / OUT build the marquee from the playhead ----------------
    const markIn = useCallback(() => {
        const t = snapFrame(videoRef.current?.currentTime ?? playheadT);
        setMarquee((m) => {
            const end = m && m.end > t ? m.end : Math.min(srcDuration || t + 1, t + 1);
            return { start: t, end };
        });
        setSelSegId(null); setSelGapKey(null);
    }, [playheadT, srcDuration, snapFrame]);

    const markOut = useCallback(() => {
        const t = snapFrame(videoRef.current?.currentTime ?? playheadT);
        setMarquee((m) => {
            const start = m && m.start < t ? m.start : Math.max(0, t - 1);
            return { start, end: t };
        });
        setSelSegId(null); setSelGapKey(null);
    }, [playheadT, snapFrame]);

    // ---- Source-ribbon geometry + drag (scrub / marquee) ------------------
    const srcXToTime = useCallback((clientX) => {
        const el = srcRibbonRef.current;
        if (!el || !srcDuration) return 0;
        const rect = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return snapFrame(viewStart + frac * viewSpan);
    }, [srcDuration, snapFrame, viewStart, viewSpan]);

    const [srcDrag, setSrcDrag] = useState(null);
    const onSrcMouseDown = (e) => {
        if (!srcDuration) return;
        e.preventDefault();
        const t = srcXToTime(e.clientX);
        setSrcDrag({ anchor: t, moved: false });
    };
    useEffect(() => {
        if (!srcDrag) return;
        const onMove = (e) => {
            const t = srcXToTime(e.clientX);
            const lo = Math.min(srcDrag.anchor, t);
            const hi = Math.max(srcDrag.anchor, t);
            if (hi - lo > 0.05) {
                setMarquee({ start: lo, end: hi });
                setSelSegId(null); setSelGapKey(null);
                setSrcDrag((d) => ({ ...d, moved: true }));
            }
        };
        const onUp = (e) => {
            setSrcDrag((d) => {
                if (d && !d.moved) seekTo(d.anchor); // a click = scrub
                return null;
            });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [srcDrag, srcXToTime]);

    // ---- Reel (sequence) layout — blocks + gaps in export order ----------
    // The reel is measured in seconds: each segment is its own duration wide,
    // each OPEN gap is its real source-gap duration wide. Closed gaps collapse
    // to a hairline seam.
    const reel = useMemo(() => {
        const items = [];
        let acc = 0;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (i > 0) {
                const prev = segments[i - 1];
                const gap = seg.start - prev.end;
                const key = `${prev.id}|${seg.id}`;
                if (gap > 1 / FPS) {
                    if (closedGaps.has(key)) {
                        items.push({ type: 'seam', key, x: acc, w: 0, gap });
                    } else {
                        items.push({ type: 'gap', key, x: acc, w: gap, gap });
                        acc += gap;
                    }
                }
                // gap <= 0 (adjacent or reordered) → blocks simply butt together
            }
            const d = segDur(seg);
            items.push({ type: 'seg', seg, index: i, x: acc, w: d });
            acc += d;
        }
        return { items, total: Math.max(0.001, acc) };
    }, [segments, closedGaps]);

    // Program playhead position within the reel (in seconds), only meaningful
    // while assembling: walk to the playing segment + offset.
    const reelPlayheadX = useMemo(() => {
        if (!programRef.current.playing && !programPlaying) return null;
        const idx = programRef.current.idx;
        const item = reel.items.find((it) => it.type === 'seg' && it.index === idx);
        if (!item) return null;
        const seg = segments[idx];
        const within = Math.max(0, Math.min(segDur(seg), playheadT - seg.start));
        return item.x + within;
    }, [reel, segments, playheadT, programPlaying]);

    // ---- Reel drag: trim edges / move (reorder) ---------------------------
    const reelXToFrac = useCallback((clientX) => {
        const el = reelRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }, []);

    const [reelDrag, setReelDrag] = useState(null);
    const onSegHandleDown = (idx, edge) => (e) => {
        e.stopPropagation();
        e.preventDefault();
        setReelDrag({ mode: edge === 'start' ? 'trim-start' : 'trim-end', idx, before: segments });
    };
    const onSegBodyDown = (idx) => (e) => {
        e.preventDefault();
        const seg = segments[idx];
        setSelSegId(seg.id); setSelGapKey(null); setMarquee(null);
        seekTo(seg.start);
        setReelDrag({ mode: 'maybe-move', idx, startX: e.clientX, before: segments, moved: false });
    };
    useEffect(() => {
        if (!reelDrag) return;
        const onMove = (e) => {
            const frac = reelXToFrac(e.clientX);
            const tSeconds = frac * reel.total; // reel-space seconds
            if (reelDrag.mode === 'trim-start' || reelDrag.mode === 'trim-end') {
                // Map reel-space x back to the dragged block, then to source time.
                const item = reel.items.find((it) => it.type === 'seg' && it.index === reelDrag.idx);
                if (!item) return;
                const seg = segments[reelDrag.idx];
                const localSec = tSeconds - item.x;             // seconds into the block
                const srcT = snapFrame(seg.start + localSec);   // block start maps to seg.start
                setSegments((prev) => prev.map((s, i) => {
                    if (i !== reelDrag.idx) return s;
                    if (reelDrag.mode === 'trim-start') {
                        return { ...s, start: Math.max(0, Math.min(s.end - 1 / FPS, srcT)) };
                    }
                    return { ...s, end: Math.min(srcDuration || srcT, Math.max(s.start + 1 / FPS, srcT)) };
                }));
            } else if (reelDrag.mode === 'maybe-move' || reelDrag.mode === 'move') {
                if (reelDrag.mode === 'maybe-move' && Math.abs(e.clientX - reelDrag.startX) < 6) return;
                // Determine drop index from pointer position over the OTHER blocks.
                const others = segments.filter((_, i) => i !== reelDrag.idx);
                const layout = [];
                let a = 0;
                for (let i = 0; i < others.length; i++) {
                    const d = segDur(others[i]);
                    layout.push({ center: a + d / 2 }); a += d;
                }
                let drop = others.length;
                for (let i = 0; i < layout.length; i++) {
                    if (tSeconds < layout[i].center) { drop = i; break; }
                }
                const moving = segments[reelDrag.idx];
                const reordered = [...others.slice(0, drop), moving, ...others.slice(drop)];
                setSegments(reordered);
                setReelDrag((d) => ({ ...d, mode: 'move', moved: true, idx: drop }));
            }
        };
        const onUp = () => {
            setReelDrag((d) => {
                if (d && (d.mode === 'move' || d.mode === 'trim-start' || d.mode === 'trim-end')
                    && sigOf(d.before) !== sigOf(segmentsRef.current)) {
                    // Record one undo step for the whole drag gesture.
                    setPast((p) => [...p.slice(-59), { segments: d.before, closedGaps }]);
                    setFutureStack([]);
                }
                return null;
            });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [reelDrag, reel, segments, reelXToFrac, srcDuration, snapFrame, closedGaps]);

    // ---- Zoom (source ribbon) ---------------------------------------------
    const zoomBy = (factor) => {
        if (!srcDuration) return;
        const center = Math.max(viewStart, Math.min(effViewEnd, playheadT));
        const newSpan = Math.max(0.5, Math.min(srcDuration, viewSpan / factor));
        let s = center - newSpan / 2;
        let e = center + newSpan / 2;
        if (s < 0) { s = 0; e = newSpan; }
        if (e > srcDuration) { e = srcDuration; s = srcDuration - newSpan; }
        setViewStart(s);
        setViewEnd(e >= srcDuration ? 0 : e);
    };
    const zoomReset = () => { setViewStart(0); setViewEnd(0); };

    // ---- Keyboard shortcuts -----------------------------------------------
    useEffect(() => {
        const handler = (e) => {
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
            const meta = e.metaKey || e.ctrlKey;
            if (meta && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
                return;
            }
            if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
            if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); playPause(); }
            else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); markIn(); }
            else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); markOut(); }
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (selGapKey) { toggleGap(selGapKey, true); setSelGapKey(null); }
                else if (selSegId != null) deleteSegment(selSegId);
                else if (marquee) removeMarquee();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                seekTo((videoRef.current?.currentTime ?? playheadT) - (e.shiftKey ? 1 : 1 / FPS));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                seekTo((videoRef.current?.currentTime ?? playheadT) + (e.shiftKey ? 1 : 1 / FPS));
            } else if (e.key === 'Escape') {
                onClose?.();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [playheadT, markIn, markOut, undo, redo, selGapKey, selSegId, marquee, toggleGap, deleteSegment, removeMarquee, onClose]);

    // ---- Save -------------------------------------------------------------
    async function save() {
        if (!valid) return;
        setSaving(true);
        setError(null);
        try {
            const ranges = segments.map((s) => ({ start: Number(s.start), end: Number(s.end) }))
                .filter((r) => r.end > r.start);
            const span = {
                start: Math.min(...ranges.map((r) => r.start)),
                end: Math.max(...ranges.map((r) => r.end)),
            };
            const body = ranges.length > 1
                ? { new_start: span.start, new_end: span.end, ranges }
                : { new_start: ranges[0].start, new_end: ranges[0].end };
            const res = await fetch(getApiUrl(`/api/clip/${jobId}/${index}/retrim`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            try { localStorage.removeItem(draftKey(jobId, index)); } catch (_) {}
            onSaved?.(data);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setSaving(false);
        }
    }

    // ---- Source-ribbon helpers (px geometry) ------------------------------
    const srcPct = (t) => {
        if (viewSpan <= 0) return 0;
        return Math.max(0, Math.min(100, ((t - viewStart) / viewSpan) * 100));
    };

    const selectedSeg = segments.find((s) => s.id === selSegId) || null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-6xl rounded-3xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.85),0_0_60px_-20px_rgba(232,121,249,0.18)] max-h-[96vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 z-30 flex items-center justify-between px-5 py-3 border-b border-white/10 bg-zinc-900/85 backdrop-blur-xl">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2.5">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/30 to-fuchsia-700/10 ring-1 ring-fuchsia-400/30 shadow-[0_0_18px_-4px_rgba(232,121,249,0.6)]">
                            <Scissors size={13} className="text-fuchsia-200" />
                        </span>
                        <span className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent text-[13px] tracking-tight font-semibold">
                            Edit clip timing — sequence editor
                        </span>
                    </h3>
                    <div className="flex items-center gap-1.5">
                        <IconBtn onClick={undo} disabled={!past.length} title="Undo (⌘Z)"><Undo2 size={13} /></IconBtn>
                        <IconBtn onClick={redo} disabled={!futureStack.length} title="Redo (⌘⇧Z)"><Redo2 size={13} /></IconBtn>
                        <span className="mx-1 h-5 w-px bg-white/10" />
                        <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 transition" title="Close (Esc)">
                            <X size={16} />
                        </button>
                    </div>
                </div>

                <div className="space-y-4 p-5">
                    {/* PREVIEW MONITOR */}
                    <div className="relative w-full overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black aspect-video shadow-2xl shadow-black/40 group">
                        <video
                            ref={videoRef}
                            src={sourceUrl}
                            onLoadedMetadata={onLoadedMetadata}
                            onTimeUpdate={onTimeUpdate}
                            onError={() => setVideoErr('Source video not available — was the job cleaned up?')}
                            preload="metadata"
                            className="absolute inset-0 h-full w-full"
                            playsInline
                        />
                        {videoErr && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-4 text-center text-xs text-red-300 backdrop-blur-sm">
                                {videoErr}
                            </div>
                        )}
                        {programPlaying && (
                            <div className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-lg ring-1 ring-white/20">
                                <ListVideo size={11} /> Playing sequence
                            </div>
                        )}
                        {!playing && !videoErr && (
                            <button
                                onClick={playPause}
                                className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/10 via-black/0 to-black/30 hover:from-black/20 hover:to-black/40 transition"
                                aria-label="Play"
                            >
                                <span className="rounded-full bg-white/95 backdrop-blur-xl p-4 text-black shadow-[0_8px_32px_-4px_rgba(0,0,0,0.5)] ring-1 ring-white/30 hover:scale-105 transition">
                                    <Play size={24} fill="currentColor" className="ml-0.5" />
                                </span>
                            </button>
                        )}
                    </div>

                    {/* TRANSPORT */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 backdrop-blur-md px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-1">
                            <TransportBtn onClick={playPause} disabled={!!videoErr} primary title="Play / Pause (Space)">
                                {playing && !programPlaying ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                                <span className="px-0.5">{playing && !programPlaying ? 'Pause' : 'Play'}</span>
                            </TransportBtn>
                            <TransportBtn onClick={playProgram} disabled={!!videoErr || !segments.length} accent="emerald" title="Play the assembled sequence top-to-bottom">
                                <ListVideo size={13} /> Play sequence
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn onClick={markIn} disabled={!!videoErr} accent="fuchsia" title="Set selection IN to playhead (I)">
                                <span className="font-mono text-[10px] bg-fuchsia-500/40 ring-1 ring-fuchsia-300/30 px-1 rounded-md">I</span> Mark IN
                            </TransportBtn>
                            <TransportBtn onClick={markOut} disabled={!!videoErr} accent="fuchsia" title="Set selection OUT to playhead (O)">
                                <span className="font-mono text-[10px] bg-fuchsia-500/40 ring-1 ring-fuchsia-300/30 px-1 rounded-md">O</span> Mark OUT
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn onClick={() => seekTo((segments[0]?.start) ?? 0)} disabled={!!videoErr} title="Jump to sequence start" square>
                                <SkipBack size={13} />
                            </TransportBtn>
                            <TransportBtn onClick={() => seekTo((segments[segments.length - 1]?.end) ?? 0)} disabled={!!videoErr} title="Jump to sequence end" square>
                                <SkipForward size={13} />
                            </TransportBtn>
                        </div>
                        <div className="flex items-baseline gap-2 px-3 font-mono tabular-nums">
                            <span className="text-sm text-zinc-100">{fmtTime(programPlaying ? playheadT : playheadT)}</span>
                            {srcDuration > 0 && (<><span className="text-zinc-600">/</span><span className="text-[11px] text-zinc-500">{fmtTime(srcDuration)}</span></>)}
                        </div>
                    </div>

                    {/* SPEED + ZOOM + selection actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 uppercase tracking-wider font-medium"><Gauge size={11} /> Speed</span>
                            <div className="inline-flex rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5">
                                {[0.5, 1, 1.5, 2, 3].map((r) => (
                                    <button key={r} onClick={() => setPlaybackRate(r)}
                                        className={'rounded-lg px-2.5 py-1 text-[10px] font-mono tabular-nums transition ' +
                                            (Math.abs(playbackRate - r) < 0.01
                                                ? 'bg-gradient-to-b from-primary/40 to-primary/20 text-white ring-1 ring-primary/40'
                                                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')}
                                        title={`Play at ${r}× speed`}>{r}×</button>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-medium">Source zoom</span>
                            <div className="inline-flex rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5">
                                <SegBtn onClick={() => zoomBy(2)} disabled={!srcDuration} title="Zoom in around playhead"><ZoomIn size={11} /> In</SegBtn>
                                <SegBtn onClick={() => zoomBy(0.5)} disabled={!srcDuration} title="Zoom out"><ZoomOut size={11} /> Out</SegBtn>
                                <SegBtn onClick={zoomReset} disabled={!srcDuration} title="Show full video"><Maximize2 size={11} /> Full</SegBtn>
                            </div>
                        </div>
                    </div>

                    {/* ===== SOURCE RIBBON ===== */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px]">
                            <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-300 uppercase tracking-wider">
                                <Film size={11} className="text-cyan-300" /> Source
                                <span className="font-normal text-zinc-500 normal-case tracking-normal">
                                    {viewStart === 0 && (viewEnd === 0 || viewEnd >= srcDuration - 0.01)
                                        ? '· full video'
                                        : <> · zoomed <span className="font-mono text-fuchsia-300/80">{fmtTime(viewStart)}–{fmtTime(effViewEnd)}</span></>}
                                </span>
                            </span>
                            <span className="text-zinc-600">drag to select · click to scrub · I/O to mark</span>
                        </div>
                        <div
                            ref={srcRibbonRef}
                            onMouseDown={onSrcMouseDown}
                            className="relative h-20 select-none cursor-text rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black overflow-hidden shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]"
                            style={{ touchAction: 'none' }}
                        >
                            <Waveform peaks={waveform} srcDuration={srcDuration} t0={viewStart} t1={effViewEnd} />
                            {/* Existing kept segments shown faintly so you see coverage */}
                            {srcDuration > 0 && segments.map((s, i) => {
                                const l = srcPct(s.start), r = srcPct(s.end);
                                if (s.end <= viewStart || s.start >= effViewEnd) return null;
                                return (
                                    <div key={s.id} className="absolute inset-y-2 rounded bg-fuchsia-400/10 ring-1 ring-fuchsia-400/30 pointer-events-none"
                                        style={{ left: `${l}%`, width: `${Math.max(0.4, r - l)}%` }}>
                                        <span className="absolute -top-0.5 left-1 text-[8px] font-mono text-fuchsia-300/70">{i + 1}</span>
                                    </div>
                                );
                            })}
                            {/* Marquee selection */}
                            {srcDuration > 0 && marquee && (() => {
                                const l = srcPct(marquee.start), r = srcPct(marquee.end);
                                if (marquee.end <= viewStart || marquee.start >= effViewEnd) return null;
                                return (
                                    <div className="absolute inset-y-1 rounded-lg bg-cyan-400/20 ring-2 ring-cyan-300/80 shadow-[0_0_18px_-4px_rgba(103,232,249,0.7)]"
                                        style={{ left: `${l}%`, width: `${Math.max(0.5, r - l)}%` }} title="Selection — Add or Remove below" />
                                );
                            })()}
                            {/* Playhead */}
                            {srcDuration > 0 && playheadT >= viewStart && playheadT <= effViewEnd && (
                                <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-gradient-to-b from-cyan-300 via-cyan-200 to-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.95)]"
                                    style={{ left: `${srcPct(playheadT)}%` }} />
                            )}
                            {!srcDuration && !videoErr && (
                                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">Loading timeline…</div>
                            )}
                        </div>

                        {/* Selection action bar */}
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {marquee ? (
                                <>
                                    <span className="text-[10px] font-mono text-cyan-200 bg-cyan-500/10 ring-1 ring-cyan-400/30 rounded-md px-2 py-1">
                                        {fmtTime(marquee.start)} → {fmtTime(marquee.end)} · {(marquee.end - marquee.start).toFixed(2)}s
                                    </span>
                                    <ActionBtn onClick={addMarquee} accent="emerald" title="Add this span to the sequence">
                                        <Plus size={12} /> Add to sequence
                                    </ActionBtn>
                                    <ActionBtn onClick={removeMarquee} accent="rose" title="Cut this span out of the sequence (splits a range)">
                                        <Scissors size={12} /> Remove span
                                    </ActionBtn>
                                    <ActionBtn onClick={() => playSpan(marquee.start, marquee.end)} title="Preview just this span">
                                        <Play size={11} fill="currentColor" /> Preview
                                    </ActionBtn>
                                    <button onClick={() => setMarquee(null)} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-1.5 py-1">clear</button>
                                </>
                            ) : (
                                <span className="text-[10px] text-zinc-500 inline-flex items-center gap-1.5">
                                    <CornerDownLeft size={11} className="text-zinc-600" />
                                    Drag across the source (or press <Kbd>I</Kbd>/<Kbd>O</Kbd>) to select a span, then add or remove it.
                                </span>
                            )}
                        </div>
                    </div>

                    {/* ===== SEQUENCE REEL ===== */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px]">
                            <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-300 uppercase tracking-wider">
                                <ListVideo size={11} className="text-emerald-300" /> Sequence
                                <span className="font-normal text-zinc-500 normal-case tracking-normal">
                                    · {segments.length} segment{segments.length === 1 ? '' : 's'} · {programDur.toFixed(2)}s export
                                </span>
                            </span>
                            <span className="text-zinc-600">drag a block to reorder · drag edges to trim · select a gap + Delete to close it</span>
                        </div>
                        <div
                            ref={reelRef}
                            className="relative h-24 select-none rounded-2xl ring-1 ring-white/10 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.015)_0_10px,transparent_10px_20px)] bg-zinc-950 overflow-hidden shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]"
                            style={{ touchAction: 'none' }}
                            onMouseDown={() => { setSelSegId(null); setSelGapKey(null); }}
                        >
                            {reel.items.map((it) => {
                                const leftPct = (it.x / reel.total) * 100;
                                const wPct = (it.w / reel.total) * 100;
                                if (it.type === 'gap') {
                                    const selected = selGapKey === it.key;
                                    return (
                                        <button
                                            key={'gap-' + it.key}
                                            onMouseDown={(e) => { e.stopPropagation(); setSelGapKey(it.key); setSelSegId(null); setMarquee(null); }}
                                            onDoubleClick={() => toggleGap(it.key, true)}
                                            className={'absolute inset-y-0 flex flex-col items-center justify-center group ' +
                                                (selected ? 'z-20' : 'z-10')}
                                            style={{ left: `${leftPct}%`, width: `${wPct}%` }}
                                            title={`Gap ${it.gap.toFixed(2)}s of skipped source — select + Delete (or double-click) to close it`}
                                        >
                                            <span className={'absolute inset-y-2 inset-x-0.5 rounded border border-dashed ' +
                                                (selected
                                                    ? 'border-rose-300 bg-rose-500/20 shadow-[0_0_18px_-4px_rgba(244,63,94,0.7)]'
                                                    : 'border-zinc-600/60 bg-black/40 group-hover:border-zinc-400/70')} />
                                            <span className={'relative text-[9px] font-mono ' + (selected ? 'text-rose-200' : 'text-zinc-500')}>
                                                {it.gap >= 1 ? `${it.gap.toFixed(1)}s` : `${Math.round(it.gap * 1000)}ms`}
                                            </span>
                                            <span className={'relative text-[8px] uppercase tracking-wider ' + (selected ? 'text-rose-300' : 'text-zinc-600 group-hover:text-zinc-400')}>
                                                gap
                                            </span>
                                        </button>
                                    );
                                }
                                if (it.type === 'seam') {
                                    return (
                                        <button
                                            key={'seam-' + it.key}
                                            onMouseDown={(e) => { e.stopPropagation(); toggleGap(it.key, false); }}
                                            className="absolute inset-y-1 z-20 -ml-1 w-2 flex items-center justify-center group"
                                            style={{ left: `${leftPct}%` }}
                                            title="Closed gap — click to re-open it"
                                        >
                                            <span className="h-full w-0.5 bg-amber-300/80 group-hover:bg-amber-200 shadow-[0_0_8px_rgba(252,211,77,0.8)]" />
                                        </button>
                                    );
                                }
                                // segment block
                                const seg = it.seg;
                                const selected = selSegId === seg.id;
                                return (
                                    <div
                                        key={'seg-' + seg.id}
                                        onMouseDown={onSegBodyDown(it.index)}
                                        onDoubleClick={() => playSpan(seg.start, seg.end)}
                                        className={'absolute inset-y-2 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing ' +
                                            (selected
                                                ? 'ring-2 ring-fuchsia-300 shadow-[0_0_22px_-4px_rgba(232,121,249,0.7)] z-10'
                                                : 'ring-1 ring-white/15 hover:ring-white/30')}
                                        style={{ left: `${leftPct}%`, width: `${Math.max(1.5, wPct)}%` }}
                                        title={`Segment ${it.index + 1}: ${fmtTime(seg.start)}–${fmtTime(seg.end)} (${segDur(seg).toFixed(2)}s)`}
                                    >
                                        <div className="absolute inset-0 bg-gradient-to-b from-fuchsia-500/30 via-fuchsia-600/15 to-fuchsia-500/25" />
                                        <Waveform peaks={waveform} srcDuration={srcDuration} t0={seg.start} t1={seg.end} tint="seg" />
                                        <div className="absolute top-1 left-1.5 text-[9px] font-mono font-bold text-white/90 drop-shadow">{it.index + 1}</div>
                                        <div className="absolute bottom-1 left-1.5 right-1.5 flex items-center justify-between text-[8px] font-mono text-fuchsia-100/80">
                                            <span>{segDur(seg).toFixed(1)}s</span>
                                        </div>
                                        {/* trim handles */}
                                        <div onMouseDown={onSegHandleDown(it.index, 'start')}
                                            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-fuchsia-300/0 hover:bg-fuchsia-300/30 active:bg-fuchsia-300/50">
                                            <span className="absolute inset-y-2 left-0.5 w-0.5 rounded bg-fuchsia-200/70" />
                                        </div>
                                        <div onMouseDown={onSegHandleDown(it.index, 'end')}
                                            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-fuchsia-300/0 hover:bg-fuchsia-300/30 active:bg-fuchsia-300/50">
                                            <span className="absolute inset-y-2 right-0.5 w-0.5 rounded bg-fuchsia-200/70" />
                                        </div>
                                    </div>
                                );
                            })}
                            {/* program playhead */}
                            {reelPlayheadX != null && (
                                <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-gradient-to-b from-emerald-200 via-emerald-300 to-emerald-200 shadow-[0_0_10px_rgba(110,231,183,0.95)] z-30"
                                    style={{ left: `${(reelPlayheadX / reel.total) * 100}%` }} />
                            )}
                            {!segments.length && (
                                <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
                                    Sequence is empty — select a span on the source above and "Add to sequence".
                                </div>
                            )}
                        </div>

                        {/* Selected-segment / gap action bar */}
                        <div className="flex flex-wrap items-center gap-2 pt-0.5 min-h-[26px]">
                            {selectedSeg ? (
                                <>
                                    <span className="text-[10px] font-mono text-fuchsia-200 bg-fuchsia-500/10 ring-1 ring-fuchsia-400/30 rounded-md px-2 py-1">
                                        segment · {fmtTime(selectedSeg.start)}–{fmtTime(selectedSeg.end)}
                                    </span>
                                    <ActionBtn onClick={() => playSpan(selectedSeg.start, selectedSeg.end)} title="Preview this segment">
                                        <Play size={11} fill="currentColor" /> Preview
                                    </ActionBtn>
                                    <ActionBtn onClick={() => deleteSegment(selectedSeg.id)} accent="rose" title="Delete this segment (Delete)">
                                        <Trash2 size={12} /> Delete segment
                                    </ActionBtn>
                                </>
                            ) : selGapKey ? (
                                <>
                                    <span className="text-[10px] font-mono text-rose-200 bg-rose-500/10 ring-1 ring-rose-400/30 rounded-md px-2 py-1">
                                        gap selected
                                    </span>
                                    <ActionBtn onClick={() => { toggleGap(selGapKey, true); setSelGapKey(null); }} accent="rose" title="Close the gap so the ranges butt together (Delete)">
                                        <Scissors size={12} /> Close gap (Delete)
                                    </ActionBtn>
                                    <span className="text-[10px] text-zinc-500">This footage is never exported — closing just butts the ranges together in the preview.</span>
                                </>
                            ) : (
                                <span className="text-[10px] text-zinc-500">Click a block to select it · double-click to preview it · drag to reorder.</span>
                            )}
                        </div>
                    </div>

                    {/* SUMMARY */}
                    <div className="grid grid-cols-3 gap-2 rounded-2xl ring-1 ring-white/5 bg-gradient-to-b from-zinc-900/60 to-black/60 p-3 text-xs">
                        <Stat label="Original" value={`${fmtTime(clip.start)}–${fmtTime(clip.end)}`} />
                        <Stat label="Segments" value={`${segments.length} · ${closedGaps.size} gap${closedGaps.size === 1 ? '' : 's'} closed`} />
                        <Stat label="Export length" value={`${programDur.toFixed(2)}s`} highlight />
                    </div>

                    {error && (
                        <div className="rounded-xl ring-1 ring-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 flex items-start gap-2">
                            <span className="text-red-400">⚠</span><span>{error}</span>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="sticky bottom-0 z-20 flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5 bg-zinc-900/85 backdrop-blur-xl">
                    <div className="text-[10px] text-zinc-500">
                        Backend re-cuts {segments.length > 1 ? `+ concatenates ${segments.length} segments` : '+ reframes'} from the original source — ~5–15s.
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={onClose} disabled={saving} className="rounded-lg ring-1 ring-white/10 bg-white/5 px-3.5 py-2 text-xs text-zinc-300 hover:bg-white/10 hover:ring-white/20 transition disabled:opacity-50">
                            Cancel
                        </button>
                        <button onClick={save} disabled={saving || !valid}
                            className="rounded-lg bg-gradient-to-r from-fuchsia-500 via-pink-500 to-rose-500 hover:from-fuchsia-400 hover:via-pink-400 hover:to-rose-400 disabled:from-zinc-600 disabled:to-zinc-700 disabled:opacity-50 px-5 py-2 text-xs font-bold text-white shadow-[0_8px_24px_-8px_rgba(232,121,249,0.6),0_0_0_1px_rgba(232,121,249,0.4)] flex items-center gap-2 transition">
                            {saving && <Loader2 size={13} className="animate-spin" />}
                            {saving ? 'Re-rendering…' : 'Re-render clip'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Waveform SVG for a [t0,t1] window of the source. Reused by the source
 *  ribbon (full/zoom view) and each sequence block (its own slice). */
function Waveform({ peaks, srcDuration, t0, t1, tint }) {
    const bars = useMemo(() => {
        if (!peaks?.length || !srcDuration || t1 <= t0) return null;
        const W = 1000, H = 40, mid = H / 2;
        const binDur = srcDuration / peaks.length;
        const firstBin = Math.max(0, Math.floor(t0 / binDur));
        const lastBin = Math.min(peaks.length, Math.ceil(t1 / binDur));
        const span = Math.max(0.001, t1 - t0);
        const binsInView = Math.max(1, lastBin - firstBin);
        const stride = Math.max(1, Math.ceil(binsInView / W));
        const out = [];
        for (let i = firstBin; i < lastBin; i += stride) {
            const t = i * binDur;
            const x = ((t - t0) / span) * W;
            let peak = 0;
            for (let j = i; j < Math.min(lastBin, i + stride); j++) if (peaks[j] > peak) peak = peaks[j];
            const h = Math.max(0.5, peak * (H * 0.9));
            out.push(<rect key={i} x={x} y={mid - h / 2} width={Math.max(0.5, (W / binsInView) * stride * 0.8)} height={h} rx={0.6} />);
        }
        return out;
    }, [peaks, srcDuration, t0, t1]);
    if (!bars) return null;
    const gradId = tint === 'seg' ? 'wfSeg' : 'wfSrc';
    return (
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    {tint === 'seg' ? (
                        <>
                            <stop offset="0%" stopColor="rgb(250,232,255)" stopOpacity="0.35" />
                            <stop offset="50%" stopColor="rgb(250,232,255)" stopOpacity="0.85" />
                            <stop offset="100%" stopColor="rgb(250,232,255)" stopOpacity="0.35" />
                        </>
                    ) : (
                        <>
                            <stop offset="0%" stopColor="rgb(192,132,252)" stopOpacity="0.25" />
                            <stop offset="50%" stopColor="rgb(232,121,249)" stopOpacity="0.8" />
                            <stop offset="100%" stopColor="rgb(192,132,252)" stopOpacity="0.25" />
                        </>
                    )}
                </linearGradient>
            </defs>
            <g fill={`url(#${gradId})`}>{bars}</g>
        </svg>
    );
}

function Stat({ label, value, highlight }) {
    return (
        <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500 font-medium">{label}</div>
            <div className={'mt-1 truncate font-mono tabular-nums text-[11px] ' +
                (highlight ? 'text-fuchsia-300 font-semibold' : 'text-zinc-300')}>{value}</div>
        </div>
    );
}

function TransportBtn({ onClick, disabled, title, accent, primary, square, children }) {
    let cls = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-100 ring-1 transition disabled:opacity-30 disabled:cursor-not-allowed ';
    if (square) cls += 'p-1.5 ';
    if (accent === 'fuchsia') cls += 'ring-fuchsia-400/40 bg-gradient-to-b from-fuchsia-500/30 to-fuchsia-600/10 hover:from-fuchsia-500/50 text-fuchsia-50';
    else if (accent === 'emerald') cls += 'ring-emerald-400/40 bg-gradient-to-b from-emerald-500/30 to-emerald-600/10 hover:from-emerald-500/50 text-emerald-50';
    else if (primary) cls += 'ring-white/15 bg-gradient-to-b from-white/15 to-white/5 hover:from-white/25';
    else cls += 'ring-white/10 bg-white/5 hover:bg-white/10 hover:ring-white/20 text-zinc-300';
    return <button onClick={onClick} disabled={disabled} title={title} className={cls}>{children}</button>;
}

function ActionBtn({ onClick, accent, title, children }) {
    let cls = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ring-1 transition ';
    if (accent === 'emerald') cls += 'ring-emerald-400/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25';
    else if (accent === 'rose') cls += 'ring-rose-400/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25';
    else cls += 'ring-white/15 bg-white/5 text-zinc-200 hover:bg-white/10';
    return <button onClick={onClick} title={title} className={cls}>{children}</button>;
}

function SegBtn({ onClick, disabled, title, children }) {
    return (
        <button onClick={onClick} disabled={disabled} title={title}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition disabled:opacity-30 disabled:cursor-not-allowed">
            {children}
        </button>
    );
}

function IconBtn({ onClick, disabled, title, children }) {
    return (
        <button onClick={onClick} disabled={disabled} title={title}
            className="inline-flex items-center justify-center rounded-lg p-1.5 text-zinc-300 ring-1 ring-white/10 bg-white/5 hover:bg-white/10 hover:text-white transition disabled:opacity-25 disabled:cursor-not-allowed">
            {children}
        </button>
    );
}

function Kbd({ children }) {
    return (
        <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-zinc-800/80 ring-1 ring-white/10 text-[9px] font-mono text-zinc-300">
            {children}
        </kbd>
    );
}
