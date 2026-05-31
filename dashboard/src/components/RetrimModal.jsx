import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Loader2, Play, Pause, SkipBack, SkipForward, Scissors,
    ZoomIn, ZoomOut, Maximize2, Gauge, Undo2, History,
} from 'lucide-react';
import { getApiUrl } from '../config';

// localStorage key for the per-clip retrim draft. Stored as JSON so we
// can carry both the in/out times AND the zoom/speed UI state forward.
// Cleared after a successful save (the new clip times take effect).
const draftKey = (jobId, index) => `klipra_retrim_draft:${jobId}:${index}`;

/**
 * Modal for adjusting a clip's in/out points AFTER rendering.
 *
 * V3 — full editor experience:
 *   • Source video preview at top (was added in v2)
 *   • Audio waveform under the timeline so silences and beats are visible
 *   • Zoom controls — the timeline can show a tight slice of the source
 *     instead of the whole thing, so frame-level dragging is precise
 *   • Playback speed presets (0.5× / 1× / 1.5× / 2× / 3×) for fast
 *     scrubbing or careful study
 *   • Mark-IN / Mark-OUT buttons that snap newStart/newEnd to the live
 *     playhead so you can press play, listen, and click I or O at the
 *     exact moment you hear the right cut point
 *   • Keyboard shortcuts: space = play/pause, I = mark in, O = mark out,
 *     ←/→ = nudge playhead one frame
 *
 * Backend contract is unchanged: POST /api/clip/{job}/{idx}/retrim with
 * {new_start, new_end} in absolute source seconds.
 */
export default function RetrimModal({ clip, index, jobId, onClose, onSaved }) {
    const FPS = 30;

    const sourceUrl = useMemo(
        () => getApiUrl(`/api/job/${jobId}/source-video`),
        [jobId]
    );

    // Restore a previous draft from localStorage when reopening. Stored
    // per-clip so editing clip 0 doesn't clobber clip 1's draft. We pull
    // synchronously inside useState's initializer so the first paint
    // already has the restored values — no flash of "original" times.
    const draft = useMemo(() => {
        try {
            const raw = localStorage.getItem(draftKey(jobId, index));
            if (!raw) return null;
            const obj = JSON.parse(raw);
            // Sanity-check: only restore if the saved draft references the
            // SAME original clip (start+end). If the clip was already
            // re-rendered behind the modal's back, we'd be restoring
            // stale times.
            if (Math.abs((obj.origStart ?? -1) - (clip.start ?? 0)) > 0.01
                || Math.abs((obj.origEnd ?? -1) - (clip.end ?? 0)) > 0.01) {
                return null;
            }
            return obj;
        } catch (_) {
            return null;
        }
    }, [jobId, index, clip.start, clip.end]);

    // Absolute source-video timestamps of the chosen in/out points.
    // Initialized from draft when available — that's the "remember last
    // edit when reopening the window" the user asked for.
    const [newStart, setNewStart] = useState(draft?.newStart ?? clip.start ?? 0);
    const [newEnd, setNewEnd] = useState(draft?.newEnd ?? clip.end ?? 0);
    const [srcDuration, setSrcDuration] = useState(0);
    const [playheadT, setPlayheadT] = useState(clip.start ?? 0);
    const [playing, setPlaying] = useState(false);
    const [autoStopAtEnd, setAutoStopAtEnd] = useState(false);

    // Zoom = which portion of the source is currently rendered on the
    // timeline. Stored as [start, end] in seconds. Default = whole video.
    const [viewStart, setViewStart] = useState(draft?.viewStart ?? 0);
    const [viewEnd, setViewEnd] = useState(draft?.viewEnd ?? 0); // 0 sentinel = srcDuration

    // Playback speed (1.0 = normal). Applied to <video>.playbackRate.
    const [playbackRate, setPlaybackRate] = useState(draft?.playbackRate ?? 1.0);

    // Has-draft flag shown in the header so the user knows we restored
    // state from a previous session (and gives them a one-click way to
    // discard it).
    const [draftWasRestored] = useState(!!draft);

    // Audio waveform peaks (0..1 floats). Empty array until fetched.
    const [waveform, setWaveform] = useState([]);

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [videoErr, setVideoErr] = useState(null);

    const videoRef = useRef(null);
    const timelineRef = useRef(null);

    const snapFrame = useCallback((t) => Math.round(t * FPS) / FPS, []);

    const fmtTime = useCallback((seconds) => {
        const s = Math.max(0, seconds || 0);
        const m = Math.floor(s / 60);
        const restSec = Math.floor(s - m * 60);
        const frames = Math.round((s - Math.floor(s)) * FPS);
        return `${m}:${String(restSec).padStart(2, '0')}.${String(frames).padStart(2, '0')}f`;
    }, []);

    const newDuration = Math.max(0, newEnd - newStart);
    const changed = (
        Math.abs(newStart - (clip.start ?? 0)) > 1 / FPS / 2 ||
        Math.abs(newEnd - (clip.end ?? 0)) > 1 / FPS / 2
    );
    const valid = newDuration >= 1 && newStart < newEnd && changed;

    // Persist every meaningful change to localStorage so a closed-then-
    // reopened modal restores the user's WIP. We key on the ORIGINAL
    // clip times so if someone re-renders, the next open isn't poisoned
    // by stale draft data. We only persist when the user actually
    // changed something — pristine state means no draft on disk.
    useEffect(() => {
        if (!jobId) return;
        const key = draftKey(jobId, index);
        if (!changed) {
            // No edits — drop any stale draft.
            try { localStorage.removeItem(key); } catch (_) {}
            return;
        }
        try {
            localStorage.setItem(key, JSON.stringify({
                origStart: clip.start ?? 0,
                origEnd: clip.end ?? 0,
                newStart,
                newEnd,
                viewStart,
                viewEnd,
                playbackRate,
                savedAt: Date.now(),
            }));
        } catch (_) {
            // localStorage full / blocked — silently fail; the user
            // just loses cross-session persistence, modal still works.
        }
    }, [jobId, index, clip.start, clip.end, newStart, newEnd, viewStart, viewEnd, playbackRate, changed]);

    // Undo button: revert all unsaved edits to the original clip times.
    // We deliberately do NOT touch zoom/playback rate — those are UI
    // preferences and undoing the in/out without losing your view
    // position is what you'd expect from an editor.
    const undoEdits = useCallback(() => {
        setNewStart(clip.start ?? 0);
        setNewEnd(clip.end ?? 0);
        // Also clear the on-disk draft so a future open doesn't restore
        // the just-undone state.
        try { localStorage.removeItem(draftKey(jobId, index)); } catch (_) {}
    }, [clip.start, clip.end, jobId, index]);

    // View bounds — when viewEnd is the 0 sentinel, fall back to full
    // source. This keeps "default zoom = whole video" simple while still
    // letting us mutate the view range as needed.
    const effViewEnd = viewEnd > 0 ? viewEnd : srcDuration;
    const viewSpan = Math.max(0.001, effViewEnd - viewStart);

    // Fetch the audio waveform once metadata is loaded. Cheap to do at
    // 800 bins for a podcast-length source; ffmpeg work happens once on
    // the backend and is cached on disk.
    useEffect(() => {
        if (!jobId) return;
        let alive = true;
        fetch(getApiUrl(`/api/job/${jobId}/waveform?bins=800`))
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
                if (!alive || !data || !Array.isArray(data.data)) return;
                setWaveform(data.data);
            })
            .catch(() => { /* waveform is optional — timeline still works without it */ });
        return () => { alive = false; };
    }, [jobId]);

    // ---- Video element wiring -------------------------------------------
    const onLoadedMetadata = (e) => {
        const v = e.currentTarget;
        const dur = isFinite(v.duration) ? v.duration : 0;
        setSrcDuration(dur);
        if (dur > 0) {
            if (newEnd > dur) setNewEnd(dur);
            if (newStart > dur) setNewStart(Math.max(0, dur - 1));
        }
        try { v.currentTime = Math.max(0, newStart); } catch (_) {}
    };

    const onTimeUpdate = (e) => {
        const t = e.currentTarget.currentTime || 0;
        setPlayheadT(t);
        if (autoStopAtEnd && t >= newEnd) {
            e.currentTarget.pause();
            setAutoStopAtEnd(false);
        }
    };

    const playPause = () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    };

    const playRange = () => {
        const v = videoRef.current;
        if (!v) return;
        try { v.currentTime = newStart; } catch (_) {}
        setAutoStopAtEnd(true);
        v.play().catch(() => {});
    };

    const seekTo = (t) => {
        const v = videoRef.current;
        if (!v) return;
        try { v.currentTime = Math.max(0, Math.min(srcDuration || t, t)); } catch (_) {}
        setAutoStopAtEnd(false);
    };

    // Apply playback speed to the video element whenever the user picks
    // a new preset. Stored separately so the user's choice survives
    // pauses and seeks.
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

    // ---- Mark IN / Mark OUT — click while playing to set the bound ------
    const markIn = useCallback(() => {
        const t = snapFrame(videoRef.current?.currentTime || playheadT);
        // Clamp: in must stay below out.
        const ns = Math.max(0, Math.min(newEnd - 1 / FPS, t));
        setNewStart(ns);
    }, [playheadT, newEnd, snapFrame]);

    const markOut = useCallback(() => {
        const t = snapFrame(videoRef.current?.currentTime || playheadT);
        const ne = Math.min(srcDuration || t, Math.max(newStart + 1 / FPS, t));
        setNewEnd(ne);
    }, [playheadT, newStart, srcDuration, snapFrame]);

    // ---- Timeline mouse handling ----------------------------------------
    const [drag, setDrag] = useState(null);

    const xToTime = useCallback((clientX) => {
        const el = timelineRef.current;
        if (!el || !srcDuration) return 0;
        const rect = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // Map the click position to source-time *within the current zoom view*.
        return snapFrame(viewStart + frac * viewSpan);
    }, [srcDuration, snapFrame, viewStart, viewSpan]);

    const onTimelineMouseDown = (e) => {
        if (!srcDuration) return;
        const t = xToTime(e.clientX);
        if (t < newStart || t > newEnd) {
            seekTo(t);
            return;
        }
        e.preventDefault();
        setDrag({
            mode: 'band',
            anchorT: t,
            anchorStart: newStart,
            anchorEnd: newEnd,
        });
    };

    const onHandleMouseDown = (which) => (e) => {
        e.stopPropagation();
        e.preventDefault();
        setDrag({ mode: which });
    };

    useEffect(() => {
        if (!drag) return;
        const onMove = (e) => {
            const t = xToTime(e.clientX);
            if (drag.mode === 'start') {
                const nt = Math.max(0, Math.min(newEnd - 1 / FPS, t));
                setNewStart(nt);
                seekTo(nt);
            } else if (drag.mode === 'end') {
                const nt = Math.min(srcDuration || t, Math.max(newStart + 1 / FPS, t));
                setNewEnd(nt);
                seekTo(nt);
            } else if (drag.mode === 'band') {
                const dt = t - drag.anchorT;
                const dur = drag.anchorEnd - drag.anchorStart;
                let s = drag.anchorStart + dt;
                let e2 = drag.anchorEnd + dt;
                if (s < 0) { s = 0; e2 = dur; }
                if (e2 > srcDuration) { e2 = srcDuration; s = srcDuration - dur; }
                setNewStart(snapFrame(s));
                setNewEnd(snapFrame(e2));
            }
        };
        const onUp = () => setDrag(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag, newStart, newEnd, srcDuration, xToTime, snapFrame]);

    // ---- Zoom controls --------------------------------------------------
    // Centered zoom around the current playhead — that's the
    // intuitive behavior for editors used to NLE-style timelines.
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
    // Zoom-to-selection — show only [newStart, newEnd] with 10% padding.
    const zoomToSelection = () => {
        if (!srcDuration || newDuration <= 0) return;
        const pad = newDuration * 0.1;
        const s = Math.max(0, newStart - pad);
        const e = Math.min(srcDuration, newEnd + pad);
        setViewStart(s);
        setViewEnd(e >= srcDuration ? 0 : e);
    };

    // ---- Nudge buttons --------------------------------------------------
    const nudgeStart = (deltaSec) => {
        setNewStart((s) => {
            const ns = Math.max(0, Math.min(newEnd - 1 / FPS, snapFrame(s + deltaSec)));
            seekTo(ns);
            return ns;
        });
    };
    const nudgeEnd = (deltaSec) => {
        setNewEnd((e) => {
            const ne = Math.min(srcDuration || (e + deltaSec), Math.max(newStart + 1 / FPS, snapFrame(e + deltaSec)));
            seekTo(ne);
            return ne;
        });
    };

    // ---- Keyboard shortcuts: Space / I / O / ←→ -------------------------
    // Bound on the modal root so they only fire when the modal is open.
    // Skipping when focus is in a text input so typing in the future
    // proofread fields doesn't trigger transport actions.
    useEffect(() => {
        const handler = (e) => {
            // Don't hijack typing in form controls.
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                playPause();
            } else if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                markIn();
            } else if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                markOut();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                seekTo((videoRef.current?.currentTime || playheadT) - 1 / FPS);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                seekTo((videoRef.current?.currentTime || playheadT) + 1 / FPS);
            } else if (e.key === 'Escape') {
                onClose?.();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [playheadT, markIn, markOut, onClose]);

    // ---- Save -----------------------------------------------------------
    async function save() {
        if (!valid) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(getApiUrl(`/api/clip/${jobId}/${index}/retrim`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_start: newStart, new_end: newEnd }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            // Successful save — drop the on-disk draft so future opens
            // see the freshly-rendered clip times, not the stale draft
            // that points at the OLD source range.
            try { localStorage.removeItem(draftKey(jobId, index)); } catch (_) {}
            onSaved?.(data);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setSaving(false);
        }
    }

    // ---- Geometry helpers — convert source-time to % of timeline view --
    // (used by handles, band, playhead, and selection-outline)
    const pct = (t) => {
        if (viewSpan <= 0) return 0;
        return Math.max(0, Math.min(100, ((t - viewStart) / viewSpan) * 100));
    };
    const startPct = pct(newStart);
    const endPct = pct(newEnd);
    const playPct = pct(playheadT);

    // Build SVG path for the waveform, only rendering bins within the
    // current zoom view. Each bin is rendered as a centered bar (peak
    // amplitude both above and below the centerline for a clean look).
    const waveformSvg = useMemo(() => {
        if (!waveform.length || !srcDuration || viewSpan <= 0) return null;
        const W = 1000;     // virtual width, scales via viewBox
        const H = 40;
        const mid = H / 2;
        // Each bin maps to a source-time range.
        const binDur = srcDuration / waveform.length;
        const firstBin = Math.max(0, Math.floor(viewStart / binDur));
        const lastBin = Math.min(waveform.length, Math.ceil(effViewEnd / binDur));
        const binsInView = Math.max(1, lastBin - firstBin);
        // Don't render too many bars — collapse if there are more bins
        // than pixels. Drawing 800 SVG rects every frame is fine; 8000
        // would lag.
        const stride = Math.max(1, Math.ceil(binsInView / W));
        const bars = [];
        for (let i = firstBin; i < lastBin; i += stride) {
            const t = i * binDur;
            const x = ((t - viewStart) / viewSpan) * W;
            // Take the loudest sample within this stride bucket.
            let peak = 0;
            for (let j = i; j < Math.min(lastBin, i + stride); j++) {
                if (waveform[j] > peak) peak = waveform[j];
            }
            const h = Math.max(0.5, peak * (H * 0.9));
            bars.push(
                <rect
                    key={i}
                    x={x}
                    y={mid - h / 2}
                    width={Math.max(0.5, W / binsInView * stride * 0.85)}
                    height={h}
                    rx={0.6}
                />
            );
        }
        return (
            <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
            >
                {/* Gradient fill for the bars — bright magenta at the
                    centerline tapering to softer purple at the edges.
                    Much more dynamic than flat fuchsia. */}
                <defs>
                    <linearGradient id="wfGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgb(192, 132, 252)" stopOpacity="0.25" />
                        <stop offset="50%" stopColor="rgb(232, 121, 249)" stopOpacity="0.85" />
                        <stop offset="100%" stopColor="rgb(192, 132, 252)" stopOpacity="0.25" />
                    </linearGradient>
                </defs>
                <g fill="url(#wfGrad)">
                    {bars}
                </g>
            </svg>
        );
    }, [waveform, srcDuration, viewStart, effViewEnd, viewSpan]);

    return (
        <div
            // Heavier backdrop blur + radial gradient hint gives the
            // modal a "stage" effect — the dashboard behind it dissolves.
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md"
            onClick={onClose}
        >
            <div
                // Modal shell: gradient surface from neutral-900 → black,
                // tight ring instead of a hard border (less visual noise),
                // and a soft fuchsia glow at the edges that hints at the
                // accent color used throughout the timeline.
                className="relative w-full max-w-5xl rounded-3xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.8),0_0_60px_-20px_rgba(232,121,249,0.18)] max-h-[95vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Sticky header — frosted glass with a subtle gradient
                    underline (animated brand bar). The Scissors icon now
                    sits in a chip with a soft glow. */}
                <div className="sticky top-0 z-20 flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-zinc-900/85 backdrop-blur-xl">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2.5">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/30 to-fuchsia-700/10 ring-1 ring-fuchsia-400/30 shadow-[0_0_18px_-4px_rgba(232,121,249,0.6)]">
                            <Scissors size={13} className="text-fuchsia-200" />
                        </span>
                        <span className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent text-[13px] tracking-tight font-semibold">
                            Edit clip timing
                        </span>
                        {/* "Draft restored" pill — pops the user with a
                            subtle amber chip when reopening with WIP. */}
                        {draftWasRestored && changed && (
                            <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono text-amber-200 bg-amber-500/10 ring-1 ring-amber-400/30"
                                title="Your previous unsaved edits were restored automatically."
                            >
                                <History size={10} />
                                draft restored
                            </span>
                        )}
                    </h3>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={undoEdits}
                            disabled={!changed}
                            className="inline-flex items-center gap-1.5 rounded-lg ring-1 ring-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10 hover:ring-white/20 transition disabled:opacity-30 disabled:cursor-not-allowed"
                            title={changed ? 'Revert all unsaved in/out edits' : 'Nothing to undo'}
                        >
                            <Undo2 size={11} />
                            Undo edits
                        </button>
                        <button
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 transition"
                            title="Close (Esc)"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                <div className="space-y-4 p-5">
                    {/* Tagline + keyboard hint chips — kbd elements use
                        the same rounded-md ring style as buttons for
                        consistency across the modal. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-400">
                        <span>Drag handles, scrub, or use keyboard shortcuts:</span>
                        <span className="inline-flex items-center gap-1"><Kbd>Space</Kbd> play/pause</span>
                        <span className="inline-flex items-center gap-1"><Kbd>I</Kbd> mark in</span>
                        <span className="inline-flex items-center gap-1"><Kbd>O</Kbd> mark out</span>
                        <span className="inline-flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd> nudge 1 frame</span>
                    </div>

                    {/* SOURCE VIDEO PREVIEW — softer rounding, subtle
                        ring with a fuchsia glow on hover. Play overlay
                        is a glass button instead of a hard white circle. */}
                    <div className="relative w-full overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black aspect-video shadow-2xl shadow-black/40 group">
                        <video
                            ref={videoRef}
                            src={sourceUrl}
                            onLoadedMetadata={onLoadedMetadata}
                            onTimeUpdate={onTimeUpdate}
                            onError={() => setVideoErr('Source video not available — was the job cleaned up?')}
                            preload="metadata"
                            className="absolute inset-0 h-full w-full"
                            controls={false}
                            playsInline
                        />
                        {videoErr && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-4 text-center text-xs text-red-300 backdrop-blur-sm">
                                {videoErr}
                            </div>
                        )}
                        {!playing && !videoErr && (
                            <button
                                onClick={playPause}
                                className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/10 via-black/0 to-black/30 hover:from-black/20 hover:to-black/40 transition"
                                aria-label="Play"
                            >
                                <span className="rounded-full bg-white/95 backdrop-blur-xl p-4 text-black shadow-[0_8px_32px_-4px_rgba(0,0,0,0.5),0_0_40px_-8px_rgba(255,255,255,0.4)] ring-1 ring-white/30 hover:scale-105 transition">
                                    <Play size={24} fill="currentColor" className="ml-0.5" />
                                </span>
                            </button>
                        )}
                    </div>

                    {/* TRANSPORT ROW + MARK-IN / MARK-OUT — wrapped in a
                        unified glass pill bar with subtle separators between
                        logical groups (play | range/mark | seek). */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 backdrop-blur-md px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-1">
                            <TransportBtn
                                onClick={playPause}
                                disabled={!!videoErr}
                                primary
                                title="Play / Pause (Space)"
                            >
                                {playing ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                                <span className="px-0.5">{playing ? 'Pause' : 'Play'}</span>
                            </TransportBtn>
                            <TransportBtn
                                onClick={playRange}
                                disabled={!!videoErr || newDuration < 0.1}
                                accent="emerald"
                                title="Play just the selected slice and auto-pause at the end"
                            >
                                <Play size={12} fill="currentColor" />
                                Play range
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn
                                onClick={markIn}
                                disabled={!!videoErr}
                                accent="fuchsia"
                                title="Set IN point to current playhead (I)"
                            >
                                <span className="font-mono text-[10px] bg-fuchsia-500/40 ring-1 ring-fuchsia-300/30 px-1 rounded-md">I</span>
                                Mark IN
                            </TransportBtn>
                            <TransportBtn
                                onClick={markOut}
                                disabled={!!videoErr}
                                accent="fuchsia"
                                title="Set OUT point to current playhead (O)"
                            >
                                <span className="font-mono text-[10px] bg-fuchsia-500/40 ring-1 ring-fuchsia-300/30 px-1 rounded-md">O</span>
                                Mark OUT
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn
                                onClick={() => seekTo(newStart)}
                                disabled={!!videoErr}
                                title="Jump playhead to IN"
                                square
                            >
                                <SkipBack size={13} />
                            </TransportBtn>
                            <TransportBtn
                                onClick={() => seekTo(newEnd)}
                                disabled={!!videoErr}
                                title="Jump playhead to OUT"
                                square
                            >
                                <SkipForward size={13} />
                            </TransportBtn>
                        </div>
                        {/* Big clock-style time readout that lives in the
                            transport bar — feels like real NLE software. */}
                        <div className="flex items-baseline gap-2 px-3 font-mono tabular-nums">
                            <span className="text-sm text-zinc-100">{fmtTime(playheadT)}</span>
                            {srcDuration > 0 && (
                                <>
                                    <span className="text-zinc-600">/</span>
                                    <span className="text-[11px] text-zinc-500">{fmtTime(srcDuration)}</span>
                                </>
                            )}
                        </div>
                    </div>

                    {/* PLAYBACK-SPEED + ZOOM CONTROLS */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 uppercase tracking-wider font-medium">
                                <Gauge size={11} /> Speed
                            </span>
                            <div className="inline-flex rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5">
                                {[0.5, 1, 1.5, 2, 3].map((r) => (
                                    <button
                                        key={r}
                                        onClick={() => setPlaybackRate(r)}
                                        className={
                                            'rounded-lg px-2.5 py-1 text-[10px] font-mono tabular-nums transition ' +
                                            (Math.abs(playbackRate - r) < 0.01
                                                ? 'bg-gradient-to-b from-primary/40 to-primary/20 text-white shadow-[0_0_12px_-4px_rgba(99,102,241,0.6)] ring-1 ring-primary/40'
                                                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')
                                        }
                                        title={`Play at ${r}× speed`}
                                    >
                                        {r}×
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-medium">Zoom</span>
                            <div className="inline-flex rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5">
                                <SegBtn onClick={() => zoomBy(2)} disabled={!srcDuration} title="Zoom in around playhead">
                                    <ZoomIn size={11} /> In
                                </SegBtn>
                                <SegBtn onClick={() => zoomBy(0.5)} disabled={!srcDuration} title="Zoom out">
                                    <ZoomOut size={11} /> Out
                                </SegBtn>
                                <SegBtn onClick={zoomToSelection} disabled={!srcDuration || newDuration <= 0} title="Zoom to selected range">
                                    Fit selection
                                </SegBtn>
                                <SegBtn onClick={zoomReset} disabled={!srcDuration} title="Show full video">
                                    <Maximize2 size={11} /> Full
                                </SegBtn>
                            </div>
                        </div>
                    </div>

                    {/* TIMELINE STRIP — heart of the new UX. Bigger,
                        elevated, framed by a soft outer ring with a
                        subtle inner shadow for depth. */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span className="font-medium">
                                {viewStart === 0 && (viewEnd === 0 || viewEnd >= srcDuration - 0.01)
                                    ? <span className="text-zinc-400">Full video</span>
                                    : <span className="text-fuchsia-300/80">Zoomed: <span className="font-mono">{fmtTime(viewStart)}–{fmtTime(effViewEnd)}</span> <span className="text-zinc-500">({(srcDuration / viewSpan).toFixed(1)}×)</span></span>}
                            </span>
                            <span className="text-zinc-600">Drag handles · click empty track to seek · drag band to move both</span>
                        </div>
                        <div
                            ref={timelineRef}
                            onMouseDown={onTimelineMouseDown}
                            className="relative h-24 select-none cursor-pointer rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black overflow-hidden shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]"
                            style={{ touchAction: 'none' }}
                        >
                            {/* Audio waveform layer — sits behind everything else */}
                            {waveformSvg}

                            {/* Tick marks every 10% of the view for orientation */}
                            {srcDuration > 0 && Array.from({ length: 11 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="absolute top-0 h-2 w-px bg-white/15"
                                    style={{ left: `${i * 10}%` }}
                                />
                            ))}

                            {/* Selection band — translucent fuchsia with
                                a gradient overlay and a brighter outline.
                                Looks like a real NLE selection. */}
                            {srcDuration > 0 && (() => {
                                const visibleStart = Math.max(0, startPct);
                                const visibleEnd = Math.min(100, endPct);
                                if (newEnd <= viewStart || newStart >= effViewEnd) {
                                    return (
                                        <div
                                            className="absolute top-1/2 -translate-y-1/2 text-[10px] text-fuchsia-300 pointer-events-none"
                                            style={{
                                                left: newEnd <= viewStart ? 4 : undefined,
                                                right: newStart >= effViewEnd ? 4 : undefined,
                                            }}
                                        >
                                            {newEnd <= viewStart ? '← selection before view' : 'selection after view →'}
                                        </div>
                                    );
                                }
                                return (
                                    <div
                                        className="absolute inset-y-2 rounded-lg bg-gradient-to-b from-fuchsia-400/30 via-fuchsia-500/20 to-fuchsia-400/30 ring-2 ring-fuchsia-400/80 shadow-[0_0_24px_-4px_rgba(232,121,249,0.6)] backdrop-blur-[1px]"
                                        style={{
                                            left: `${visibleStart}%`,
                                            width: `${Math.max(0, visibleEnd - visibleStart)}%`,
                                        }}
                                        title="Selected slice — drag to move"
                                    />
                                );
                            })()}

                            {/* START handle — modernized pill with thicker
                                vertical bar, brighter glow on hover, and
                                a rounded chip label that floats above. */}
                            {srcDuration > 0 && newStart >= viewStart && newStart <= effViewEnd && (
                                <div
                                    onMouseDown={onHandleMouseDown('start')}
                                    className="absolute top-0 bottom-0 -ml-2.5 w-5 cursor-ew-resize group z-10"
                                    style={{ left: `${startPct}%` }}
                                    title={`IN: ${fmtTime(newStart)} — drag`}
                                >
                                    <div className="absolute inset-y-1 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-gradient-to-b from-fuchsia-300 via-fuchsia-400 to-fuchsia-500 group-hover:from-white group-hover:via-fuchsia-200 group-hover:to-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.85)] transition" />
                                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 rounded-md bg-gradient-to-b from-fuchsia-500 to-fuchsia-700 ring-1 ring-fuchsia-300/40 px-1.5 py-0.5 text-[9px] font-mono font-bold text-white tracking-wide shadow-lg">
                                        IN
                                    </div>
                                </div>
                            )}
                            {/* END handle */}
                            {srcDuration > 0 && newEnd >= viewStart && newEnd <= effViewEnd && (
                                <div
                                    onMouseDown={onHandleMouseDown('end')}
                                    className="absolute top-0 bottom-0 -ml-2.5 w-5 cursor-ew-resize group z-10"
                                    style={{ left: `${endPct}%` }}
                                    title={`OUT: ${fmtTime(newEnd)} — drag`}
                                >
                                    <div className="absolute inset-y-1 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-gradient-to-b from-fuchsia-300 via-fuchsia-400 to-fuchsia-500 group-hover:from-white group-hover:via-fuchsia-200 group-hover:to-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.85)] transition" />
                                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 rounded-md bg-gradient-to-b from-fuchsia-500 to-fuchsia-700 ring-1 ring-fuchsia-300/40 px-1.5 py-0.5 text-[9px] font-mono font-bold text-white tracking-wide shadow-lg">
                                        OUT
                                    </div>
                                </div>
                            )}
                            {/* Playhead — bright cyan glow, more cinematic */}
                            {srcDuration > 0 && playheadT >= viewStart && playheadT <= effViewEnd && (
                                <div
                                    className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-gradient-to-b from-cyan-300 via-cyan-200 to-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.95),0_0_20px_rgba(103,232,249,0.4)]"
                                    style={{ left: `${playPct}%` }}
                                />
                            )}
                            {!srcDuration && !videoErr && (
                                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
                                    Loading video timeline…
                                </div>
                            )}
                            {srcDuration > 0 && !waveform.length && (
                                <div className="absolute bottom-1 right-2 text-[9px] text-zinc-600">
                                    waveform loading…
                                </div>
                            )}
                        </div>
                    </div>

                    {/* IN / OUT READOUT + NUDGE CONTROLS */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <NudgeBlock
                            label="IN"
                            value={newStart}
                            fmtTime={fmtTime}
                            onNudge={nudgeStart}
                            origValue={clip.start ?? 0}
                        />
                        <NudgeBlock
                            label="OUT"
                            value={newEnd}
                            fmtTime={fmtTime}
                            onNudge={nudgeEnd}
                            origValue={clip.end ?? 0}
                        />
                    </div>

                    {/* SUMMARY — three columns of compact pill cards
                        showing the before/after at a glance. */}
                    <div className="grid grid-cols-3 gap-2 rounded-2xl ring-1 ring-white/5 bg-gradient-to-b from-zinc-900/60 to-black/60 p-3 text-xs">
                        <Stat label="Original" value={`${fmtTime(clip.start)}–${fmtTime(clip.end)}`} />
                        <Stat label="New" value={`${fmtTime(newStart)}–${fmtTime(newEnd)}`} highlight />
                        <Stat label="Duration" value={`${newDuration.toFixed(2)}s`} />
                    </div>

                    {error && (
                        <div className="rounded-xl ring-1 ring-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 flex items-start gap-2">
                            <span className="text-red-400">⚠</span>
                            <span>{error}</span>
                        </div>
                    )}
                </div>

                {/* Sticky footer — frosted glass, Re-render button gets a
                    bright gradient so it's unmissable as the primary action. */}
                <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5 bg-zinc-900/85 backdrop-blur-xl">
                    <div className="text-[10px] text-zinc-500">
                        Backend re-cuts + reframes from original source — takes ~5–15s.
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            disabled={saving}
                            className="rounded-lg ring-1 ring-white/10 bg-white/5 px-3.5 py-2 text-xs text-zinc-300 hover:bg-white/10 hover:ring-white/20 transition disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={save}
                            disabled={saving || !valid}
                            className="rounded-lg bg-gradient-to-r from-fuchsia-500 via-pink-500 to-rose-500 hover:from-fuchsia-400 hover:via-pink-400 hover:to-rose-400 disabled:from-zinc-600 disabled:to-zinc-700 disabled:opacity-50 px-5 py-2 text-xs font-bold text-white shadow-[0_8px_24px_-8px_rgba(232,121,249,0.6),0_0_0_1px_rgba(232,121,249,0.4)] flex items-center gap-2 transition"
                        >
                            {saving && <Loader2 size={13} className="animate-spin" />}
                            {saving ? 'Re-rendering…' : 'Re-render clip'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Inline +/- nudge controls + numeric readout for one edge of the range.
 *  Modernized with a "clock display" feel — big monospace time readout
 *  with a coloured accent pill for the IN/OUT label. */
function NudgeBlock({ label, value, fmtTime, onNudge, origValue }) {
    const delta = value - origValue;
    const FPS = 30;
    const isChanged = Math.abs(delta) >= 1 / FPS / 2;
    return (
        <div className="relative rounded-2xl ring-1 ring-white/10 bg-gradient-to-br from-zinc-900 via-zinc-950 to-black p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-fuchsia-500/20 to-fuchsia-500/10 ring-1 ring-fuchsia-400/30 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold text-fuchsia-200">
                    {label}
                </span>
                <span className={
                    'font-mono tabular-nums text-[11px] ' +
                    (isChanged ? 'text-fuchsia-300' : 'text-zinc-500')
                }>
                    {!isChanged
                        ? 'no change'
                        : (delta > 0 ? '+' : '') + delta.toFixed(2) + 's'}
                </span>
            </div>
            {/* The "clock" — big, monospace, slightly glowing when changed. */}
            <div className={
                'mt-2 font-mono text-2xl tabular-nums tracking-tight ' +
                (isChanged
                    ? 'text-white drop-shadow-[0_0_8px_rgba(232,121,249,0.4)]'
                    : 'text-zinc-300')
            }>
                {fmtTime(value)}
            </div>
            {/* Nudge buttons grouped as one segmented control. */}
            <div className="mt-3 inline-flex rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5">
                <NudgeBtn onClick={() => onNudge(-1)}>−1s</NudgeBtn>
                <NudgeBtn onClick={() => onNudge(-0.1)}>−0.1s</NudgeBtn>
                <NudgeBtn onClick={() => onNudge(-1 / FPS)}>−1f</NudgeBtn>
                <span className="self-stretch w-px bg-white/10 mx-0.5" />
                <NudgeBtn onClick={() => onNudge(+1 / FPS)}>+1f</NudgeBtn>
                <NudgeBtn onClick={() => onNudge(+0.1)}>+0.1s</NudgeBtn>
                <NudgeBtn onClick={() => onNudge(+1)}>+1s</NudgeBtn>
            </div>
        </div>
    );
}

function NudgeBtn({ onClick, children }) {
    return (
        <button
            onClick={onClick}
            className="rounded-lg px-2 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition"
        >
            {children}
        </button>
    );
}

function Stat({ label, value, highlight }) {
    return (
        <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500 font-medium">{label}</div>
            <div className={
                'mt-1 truncate font-mono tabular-nums text-[11px] ' +
                (highlight
                    ? 'text-fuchsia-300 drop-shadow-[0_0_6px_rgba(232,121,249,0.3)] font-semibold'
                    : 'text-zinc-300')
            }>
                {value}
            </div>
        </div>
    );
}

/** Glass pill button used for all transport actions. `accent` adds a
 *  colored gradient. `primary` is the default Play button style. */
function TransportBtn({ onClick, disabled, title, accent, primary, square, children }) {
    let cls = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-100 ring-1 transition disabled:opacity-30 disabled:cursor-not-allowed ';
    if (square) cls += 'p-1.5 ';
    if (accent === 'fuchsia') {
        cls += 'ring-fuchsia-400/40 bg-gradient-to-b from-fuchsia-500/30 to-fuchsia-600/10 hover:from-fuchsia-500/50 hover:to-fuchsia-600/20 text-fuchsia-50 shadow-[0_0_12px_-4px_rgba(232,121,249,0.5)]';
    } else if (accent === 'emerald') {
        cls += 'ring-emerald-400/40 bg-gradient-to-b from-emerald-500/30 to-emerald-600/10 hover:from-emerald-500/50 hover:to-emerald-600/20 text-emerald-50 shadow-[0_0_12px_-4px_rgba(52,211,153,0.5)]';
    } else if (primary) {
        cls += 'ring-white/15 bg-gradient-to-b from-white/15 to-white/5 hover:from-white/25 hover:to-white/10';
    } else {
        cls += 'ring-white/10 bg-white/5 hover:bg-white/10 hover:ring-white/20 text-zinc-300';
    }
    return (
        <button onClick={onClick} disabled={disabled} title={title} className={cls}>
            {children}
        </button>
    );
}

/** Single segmented-control button used by the zoom toolbar. */
function SegBtn({ onClick, disabled, title, children }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
            {children}
        </button>
    );
}

/** Inline keyboard shortcut chip. */
function Kbd({ children }) {
    return (
        <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-zinc-800/80 ring-1 ring-white/10 text-[9px] font-mono text-zinc-300 shadow-sm">
            {children}
        </kbd>
    );
}
