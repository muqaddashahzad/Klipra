import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Loader2, Plus, Trash2, MoveHorizontal, MousePointerClick, PlayCircle,
    Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
} from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Keyframed-pan reframe editor — V2.
 *
 *  - Loads the SOURCE 16:9 video and plays it WITH AUDIO so the user
 *    can listen to the clip while picking focus moments.
 *  - The viewport doubles as a click target: click anywhere on the
 *    frame to drop a keyframe at (currentTime, x%, y%).
 *  - Dedicated transport row (Play / Pause / Jump-to-start / Jump-to-
 *    end / Mute toggle) so playback is obvious and audible.
 *  - Existing keyframes are listed; click ✕ to remove. The 9:16 crop
 *    box at each keyframe is overlaid on the source view.
 *  - Submit re-renders the clip with the keyframes' time axis treated
 *    as clip-local seconds.
 *
 * Times are CLIP-LOCAL (0 = clip start, max = clip duration).
 */
export default function ReframeKeyframeModal({
    clip,
    index,
    jobId,
    sourceUrl,
    onClose,
    onSaved,
}) {
    const videoRef = useRef(null);
    const frameRef = useRef(null);

    const clipStart = Number(clip.start || 0);
    const clipEnd = Number(clip.end || 0);
    const clipDuration = Math.max(0, clipEnd - clipStart);

    const [keyframes, setKeyframes] = useState(() => clip.keyframes || []);
    const [currentTime, setCurrentTime] = useState(0); // clip-local seconds
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    // Mouse-click mode on the preview window:
    //   "keyframe" (default) — clicks drop a focus keyframe and NEVER play/pause.
    //   "playback"           — clicks play / pause and NEVER drop a keyframe.
    // Persisted in localStorage so it remembers per-user.
    const [clickMode, setClickMode] = useState(() => {
        try {
            const v = localStorage.getItem('klipra_reframe_click_mode');
            return v === 'playback' ? 'playback' : 'keyframe';
        } catch (_) { return 'keyframe'; }
    });
    useEffect(() => {
        try { localStorage.setItem('klipra_reframe_click_mode', clickMode); } catch (_) {}
    }, [clickMode]);

    // 9:16 box dimensions, in fractions of the source frame.
    const cropAspect = 9 / 16;
    const sourceAspectAssumption = 16 / 9;
    const boxWidthFrac = cropAspect / sourceAspectAssumption;  // ~0.316
    const boxHeightFrac = 1;

    // Format clip-local seconds → mm:ss.cc
    const fmtClipTime = useCallback((t) => {
        const s = Math.max(0, t || 0);
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        const cs = Math.floor((s - Math.floor(s)) * 100);
        return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }, []);

    // Bind play/pause/timeupdate so the UI reflects reality, and stop
    // playback automatically at the end of the clip's range.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onTime = () => {
            const local = (v.currentTime || 0) - clipStart;
            setCurrentTime(Math.max(0, Math.min(clipDuration, local)));
            // Stop at clip end so listening doesn't drift past the
            // boundary — that's the whole point of the windowed editor.
            if (local >= clipDuration) {
                v.pause();
                try { v.currentTime = clipEnd; } catch (_) {}
            }
        };
        v.addEventListener('play', onPlay);
        v.addEventListener('pause', onPause);
        v.addEventListener('timeupdate', onTime);
        v.addEventListener('ended', onPause);
        return () => {
            v.removeEventListener('play', onPlay);
            v.removeEventListener('pause', onPause);
            v.removeEventListener('timeupdate', onTime);
            v.removeEventListener('ended', onPause);
        };
    }, [clipStart, clipEnd, clipDuration]);

    // Sync mute state with the element.
    useEffect(() => {
        const v = videoRef.current;
        if (v) v.muted = muted;
    }, [muted]);

    // When the user drags the scrubber, seek the video (and pause while
    // scrubbing — feels far more responsive than chasing playback).
    const seekTo = useCallback((tLocal) => {
        const v = videoRef.current;
        if (!v) return;
        const target = clipStart + Math.max(0, Math.min(clipDuration, tLocal));
        try { v.currentTime = target; } catch (_) {}
        setCurrentTime(Math.max(0, Math.min(clipDuration, tLocal)));
    }, [clipStart, clipDuration]);

    const playPause = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        // If we're paused at the very end, jump back to start so play
        // is always meaningful.
        if (v.paused && currentTime >= clipDuration - 0.05) {
            seekTo(0);
        }
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    }, [currentTime, clipDuration, seekTo]);

    function handleFrameClick(e) {
        // In Playback mode, a frame-click only toggles play/pause —
        // never a keyframe. This is the "video-player" mouse mode.
        if (clickMode === 'playback') {
            playPause();
            return;
        }
        // In Keyframe mode (default), a frame-click DROPS a focus
        // keyframe and does NOT touch playback state. So the video
        // keeps playing (or stays paused) while the user clicks.
        // Controls with stopPropagation (transport row, etc.) won't
        // reach here.
        const rect = frameRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const cx = Math.max(0, Math.min(1, x));
        const cy = Math.max(0, Math.min(1, y));
        const t = Math.max(0, Math.min(clipDuration, currentTime));
        setKeyframes((kfs) => {
            const TIME_EPS = 0.25;
            const next = kfs.filter((k) => Math.abs(k.t - t) > TIME_EPS);
            next.push({ t, x: cx, y: cy, cut: true });
            next.sort((a, b) => a.t - b.t);
            return next;
        });
    }

    /** Add a keyframe at currentTime that *clones* the position of the
     *  previous keyframe — useful for "hold here, then jump later". */
    function holdHere() {
        const t = Math.max(0, Math.min(clipDuration, currentTime));
        setKeyframes((kfs) => {
            const prior = [...kfs].reverse().find((k) => k.t < t);
            if (!prior) {
                const next = kfs.filter((k) => Math.abs(k.t - t) > 0.25);
                next.push({ t, x: 0.5, y: 0.5, cut: false });
                next.sort((a, b) => a.t - b.t);
                return next;
            }
            const next = kfs.filter((k) => Math.abs(k.t - t) > 0.25);
            next.push({ t, x: prior.x, y: prior.y, cut: false });
            next.sort((a, b) => a.t - b.t);
            return next;
        });
    }

    function toggleCut(t) {
        setKeyframes((kfs) =>
            kfs.map((k) => (k.t === t ? { ...k, cut: !k.cut } : k))
        );
    }

    function removeKeyframe(t) {
        setKeyframes((kfs) => kfs.filter((k) => k.t !== t));
    }

    async function save() {
        if (keyframes.length === 0) {
            setError('Add at least one keyframe before re-rendering.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(
                getApiUrl(`/api/clip/${jobId}/${index}/reframe-keyframes`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyframes }),
                }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            onSaved?.(data);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setSaving(false);
        }
    }

    // Closest keyframe to currentTime (drives the active state + crop overlay).
    const activeKfIdx = keyframes.length === 0 ? -1
        : keyframes.reduce(
            (bestIdx, kf, i, arr) =>
                Math.abs(kf.t - currentTime) < Math.abs(arr[bestIdx].t - currentTime) ? i : bestIdx,
            0
        );

    return (
        <div
            // Same heavy-blur backdrop as the modernized RetrimModal so
            // all modals share one visual language.
            className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md"
            onClick={onClose}
        >
            <div
                // Modal shell: gradient surface, ring instead of border,
                // soft cyan/indigo accent glow that matches the icon chip.
                className="relative w-full max-w-4xl rounded-3xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.8),0_0_60px_-20px_rgba(34,211,238,0.15)] max-h-[95vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Frosted-glass sticky header */}
                <div className="sticky top-0 z-20 flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/10 bg-zinc-900/85 backdrop-blur-xl">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/30 to-cyan-500/20 ring-1 ring-cyan-400/30 shadow-[0_0_18px_-4px_rgba(34,211,238,0.6)]">
                            <MoveHorizontal size={14} className="text-cyan-200" />
                        </span>
                        <div className="min-w-0">
                            <h3 className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent text-[13px] tracking-tight font-semibold">
                                Reframe — focus cuts
                            </h3>
                            <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                                {clickMode === 'keyframe'
                                    ? 'Click anywhere on the frame to drop a focus keyframe. Playback unaffected.'
                                    : 'Click anywhere on the frame to play / pause. Keyframes off.'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {/* Mouse-mode segmented control */}
                        <div
                            className="inline-flex rounded-xl p-0.5 ring-1 ring-white/10 bg-zinc-900/60 backdrop-blur-md"
                            role="tablist"
                            aria-label="Click mode"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <button
                                onClick={() => setClickMode('keyframe')}
                                title="Clicks place focus keyframes (default)"
                                className={
                                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition ' +
                                    (clickMode === 'keyframe'
                                        ? 'bg-gradient-to-r from-cyan-500/30 to-indigo-500/25 text-cyan-100 ring-1 ring-cyan-300/40 shadow-[0_0_18px_-6px_rgba(34,211,238,0.55)]'
                                        : 'text-zinc-400 hover:text-white hover:bg-white/5')
                                }
                            >
                                <MousePointerClick size={12} />
                                <span>Keyframe</span>
                            </button>
                            <button
                                onClick={() => setClickMode('playback')}
                                title="Clicks play / pause the video"
                                className={
                                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition ' +
                                    (clickMode === 'playback'
                                        ? 'bg-gradient-to-r from-emerald-500/30 to-teal-500/25 text-emerald-100 ring-1 ring-emerald-300/40 shadow-[0_0_18px_-6px_rgba(16,185,129,0.55)]'
                                        : 'text-zinc-400 hover:text-white hover:bg-white/5')
                                }
                            >
                                <PlayCircle size={12} />
                                <span>Playback</span>
                            </button>
                        </div>
                        <button
                            onClick={onClose}
                            disabled={saving}
                            className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 transition disabled:opacity-50"
                            title="Close"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                <div className="space-y-4 p-5">
                    {/* SOURCE VIDEO + CLICK-TO-KEYFRAME / CLICK-TO-PLAY AREA */}
                    <div
                        ref={frameRef}
                        onClick={handleFrameClick}
                        className={
                            'relative aspect-video bg-black rounded-2xl overflow-hidden select-none ring-1 ring-white/10 shadow-2xl shadow-black/40 group ' +
                            (clickMode === 'keyframe' ? 'cursor-crosshair' : 'cursor-pointer')
                        }
                    >
                        {sourceUrl ? (
                            <video
                                ref={videoRef}
                                src={sourceUrl}
                                preload="metadata"
                                playsInline
                                // NOT muted — user explicitly asked to
                                // hear audio while picking focus moments.
                                // Mute toggle in the transport row gives
                                // them an opt-out.
                                className="w-full h-full object-contain pointer-events-none"
                                onLoadedMetadata={() => {
                                    if (videoRef.current) videoRef.current.currentTime = clipStart;
                                }}
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
                                Source video not available
                            </div>
                        )}

                        {/* 9:16 crop overlay at the active keyframe */}
                        {activeKfIdx >= 0 && (() => {
                            const kf = keyframes[activeKfIdx];
                            const wPct = boxWidthFrac * 100;
                            const hPct = boxHeightFrac * 100;
                            const leftPct = Math.max(0, Math.min(100 - wPct, kf.x * 100 - wPct / 2));
                            const topPct = Math.max(0, Math.min(100 - hPct, kf.y * 100 - hPct / 2));
                            return (
                                <div
                                    className="absolute pointer-events-none rounded-md ring-2 ring-cyan-400/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.5),0_0_24px_-4px_rgba(34,211,238,0.6)]"
                                    style={{
                                        left: `${leftPct}%`,
                                        top: `${topPct}%`,
                                        width: `${wPct}%`,
                                        height: `${hPct}%`,
                                    }}
                                />
                            );
                        })()}

                        {/* All keyframe dots — gradient on the active one */}
                        {keyframes.map((kf, i) => (
                            <div
                                key={i}
                                className={
                                    'absolute w-3.5 h-3.5 -ml-1.5 -mt-1.5 rounded-full pointer-events-none ' +
                                    (i === activeKfIdx
                                        ? 'bg-gradient-to-br from-cyan-300 to-cyan-500 ring-2 ring-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.85)]'
                                        : 'bg-cyan-400/60 ring-1 ring-cyan-200/50')
                                }
                                style={{ left: `${kf.x * 100}%`, top: `${kf.y * 100}%` }}
                            />
                        ))}

                        {/* Center play overlay — only in Playback mode so it
                            doesn't intercept the frame-click in Keyframe mode.
                            In Keyframe mode, use the transport row to play. */}
                        {!playing && sourceUrl && clickMode === 'playback' && (
                            <button
                                onClick={(e) => { e.stopPropagation(); playPause(); }}
                                className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/10 via-black/0 to-black/30 hover:from-black/20 hover:to-black/40 transition"
                                aria-label="Play"
                            >
                                <span className="rounded-full bg-white/95 backdrop-blur-xl p-4 text-black shadow-[0_8px_32px_-4px_rgba(0,0,0,0.5),0_0_40px_-8px_rgba(255,255,255,0.4)] ring-1 ring-white/30 hover:scale-105 transition pointer-events-none">
                                    <Play size={24} fill="currentColor" className="ml-0.5" />
                                </span>
                            </button>
                        )}

                        {/* Small mode badge top-left, so the user always
                            knows what clicks will do. */}
                        {sourceUrl && (
                            <div className="pointer-events-none absolute top-2.5 left-2.5 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 backdrop-blur-md shadow-md
                                bg-black/55 ring-white/15 text-zinc-100">
                                {clickMode === 'keyframe' ? (
                                    <>
                                        <MousePointerClick size={10} />
                                        <span>Click = keyframe</span>
                                    </>
                                ) : (
                                    <>
                                        <PlayCircle size={10} />
                                        <span>Click = play / pause</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {/* TRANSPORT BAR — glass pill, mirrors RetrimModal */}
                    <div
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 backdrop-blur-md px-2 py-1.5"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex flex-wrap items-center gap-1">
                            <TransportBtn onClick={playPause} primary title="Play / Pause">
                                {playing ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                                <span className="px-0.5">{playing ? 'Pause' : 'Play'}</span>
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn onClick={() => seekTo(0)} square title="Jump to clip start">
                                <SkipBack size={13} />
                            </TransportBtn>
                            <TransportBtn onClick={() => seekTo(clipDuration)} square title="Jump to clip end">
                                <SkipForward size={13} />
                            </TransportBtn>
                            <span className="mx-1 h-5 w-px bg-white/10" />
                            <TransportBtn
                                onClick={() => setMuted((m) => !m)}
                                square
                                accent={muted ? 'amber' : null}
                                title={muted ? 'Unmute' : 'Mute'}
                            >
                                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                            </TransportBtn>
                        </div>
                        {/* Clock readout */}
                        <div className="flex items-baseline gap-2 px-3 font-mono tabular-nums">
                            <span className="text-sm text-zinc-100">{fmtClipTime(currentTime)}</span>
                            <span className="text-zinc-600">/</span>
                            <span className="text-[11px] text-zinc-500">{fmtClipTime(clipDuration)}</span>
                        </div>
                    </div>

                    {/* SCRUBBER — modern range input with cyan accent */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span className="font-medium text-zinc-400">Clip-local time</span>
                            <span className="text-zinc-600">Drag to scrub · click frame to add a focus cut</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={clipDuration}
                            step={0.05}
                            value={currentTime}
                            onChange={(e) => seekTo(+e.target.value)}
                            className="w-full accent-cyan-400 h-1.5"
                        />
                    </div>

                    {/* KEYFRAMES LIST — card grid instead of plain list */}
                    <div className="rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/60 to-black/60 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                            <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-zinc-400 font-medium">
                                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-md bg-cyan-500/15 ring-1 ring-cyan-400/30 text-cyan-200 font-mono text-[10px]">
                                    {keyframes.length}
                                </span>
                                Keyframes
                            </span>
                            <button
                                onClick={holdHere}
                                className="text-[11px] text-cyan-300 hover:text-cyan-200 inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/5 transition"
                                title="Add a keyframe here that holds the previous keyframe's position"
                            >
                                <Plus size={11} /> Hold here
                            </button>
                        </div>
                        {keyframes.length === 0 ? (
                            <p className="text-xs text-zinc-500 text-center py-6 px-2 leading-relaxed">
                                No keyframes yet. Hit <strong className="text-zinc-300">Play</strong>, listen,
                                then click on the frame at the moment you want focus to snap.
                            </p>
                        ) : (
                            <ul className="p-2 space-y-1 max-h-44 overflow-auto">
                                {keyframes.map((kf, i) => (
                                    <li
                                        key={i}
                                        className={
                                            'flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-lg ring-1 transition ' +
                                            (i === activeKfIdx
                                                ? 'bg-cyan-500/15 text-cyan-100 ring-cyan-400/40 shadow-[0_0_12px_-4px_rgba(34,211,238,0.4)]'
                                                : 'text-zinc-300 ring-white/5 hover:bg-white/5 hover:ring-white/15')
                                        }
                                    >
                                        <button
                                            onClick={() => seekTo(kf.t)}
                                            className="font-mono tabular-nums text-left flex-1 truncate"
                                            title="Jump playhead to this keyframe"
                                        >
                                            <span className="text-zinc-500">@</span>{' '}
                                            <span className={i === activeKfIdx ? 'text-cyan-100' : 'text-zinc-200'}>
                                                {kf.t.toFixed(2)}s
                                            </span>
                                            <span className="text-zinc-600 mx-1">·</span>
                                            <span className="text-zinc-500">x:</span>{(kf.x * 100).toFixed(0)}%
                                            <span className="text-zinc-600 mx-1">·</span>
                                            <span className="text-zinc-500">y:</span>{(kf.y * 100).toFixed(0)}%
                                        </button>
                                        {showAdvanced && (
                                            <button
                                                onClick={() => toggleCut(kf.t)}
                                                className={
                                                    'px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-wider font-bold transition ring-1 ' +
                                                    (kf.cut
                                                        ? 'bg-orange-500/20 text-orange-200 ring-orange-400/40'
                                                        : 'bg-blue-500/20 text-blue-200 ring-blue-400/40')
                                                }
                                                title={
                                                    kf.cut
                                                        ? 'Hard cut — snap into this keyframe (no pan)'
                                                        : 'Smooth pan from previous keyframe'
                                                }
                                            >
                                                {kf.cut ? 'cut' : 'pan'}
                                            </button>
                                        )}
                                        <button
                                            onClick={() => removeKeyframe(kf.t)}
                                            className="text-zinc-500 hover:text-red-400 p-1 rounded hover:bg-white/5 transition"
                                            title="Remove keyframe"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <button
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition"
                    >
                        {showAdvanced ? '− Hide' : '+ Show'} advanced (smooth pan instead of cut)
                    </button>
                    {showAdvanced && (
                        <p className="text-[11px] text-zinc-500 leading-relaxed -mt-2">
                            Each keyframe has a badge: <strong className="text-orange-300">CUT</strong> snaps
                            instantly, <strong className="text-blue-300">PAN</strong> glides smoothly from
                            the previous keyframe. Click a badge to switch modes for that keyframe.
                        </p>
                    )}

                    {error && (
                        <div className="rounded-xl ring-1 ring-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 flex items-start gap-2">
                            <span className="text-red-400">⚠</span>
                            <span>{error}</span>
                        </div>
                    )}
                </div>

                {/* Sticky footer */}
                <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5 bg-zinc-900/85 backdrop-blur-xl">
                    <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1.5">
                        <Plus size={11} /> Click on the frame to add keyframes
                    </span>
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
                            disabled={saving || keyframes.length === 0}
                            className="rounded-lg bg-gradient-to-r from-indigo-500 via-cyan-500 to-teal-500 hover:from-indigo-400 hover:via-cyan-400 hover:to-teal-400 disabled:from-zinc-600 disabled:to-zinc-700 disabled:opacity-50 px-5 py-2 text-xs font-bold text-white shadow-[0_8px_24px_-8px_rgba(34,211,238,0.6),0_0_0_1px_rgba(34,211,238,0.4)] flex items-center gap-2 transition"
                        >
                            {saving && <Loader2 size={13} className="animate-spin" />}
                            {saving ? 'Re-rendering…' : 'Re-render with keyframes'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Glass pill button — same component as in the modernized RetrimModal,
 *  inlined here so this modal stands alone. */
function TransportBtn({ onClick, disabled, title, accent, primary, square, children }) {
    let cls = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-100 ring-1 transition disabled:opacity-30 disabled:cursor-not-allowed ';
    if (square) cls += 'p-1.5 ';
    if (accent === 'fuchsia') {
        cls += 'ring-fuchsia-400/40 bg-gradient-to-b from-fuchsia-500/30 to-fuchsia-600/10 hover:from-fuchsia-500/50 hover:to-fuchsia-600/20 text-fuchsia-50 shadow-[0_0_12px_-4px_rgba(232,121,249,0.5)]';
    } else if (accent === 'emerald') {
        cls += 'ring-emerald-400/40 bg-gradient-to-b from-emerald-500/30 to-emerald-600/10 hover:from-emerald-500/50 hover:to-emerald-600/20 text-emerald-50';
    } else if (accent === 'amber') {
        cls += 'ring-amber-400/40 bg-gradient-to-b from-amber-500/30 to-amber-600/10 hover:from-amber-500/50 hover:to-amber-600/20 text-amber-50';
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
