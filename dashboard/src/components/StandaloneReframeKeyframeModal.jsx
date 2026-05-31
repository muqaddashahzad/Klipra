import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, MoveHorizontal } from 'lucide-react';

/**
 * Keyframed-pan reframe editor for the *standalone* subtitle burn flow.
 *
 * Differences from ReframeKeyframeModal (which is the clip-generation
 * version):
 *  - Operates on the FULL uploaded video. Time axis is video-local
 *    seconds, not clip-local. There is no [start, end] window.
 *  - Parameterised by target aspect (9/16 for vertical output, 16/9 for
 *    horizontal). The crop overlay reshapes accordingly so the user
 *    sees the exact rectangle that will be cut out.
 *  - Stateless w.r.t. the backend: this component just edits a list of
 *    keyframes in memory and hands the final list back to its parent
 *    via onSave. The parent (StandaloneSubtitle Phase 2) bundles them
 *    into the burn POST.
 *
 * Each keyframe is { t, x, y, cut }:
 *  - t: seconds, 0 = video start
 *  - x, y: 0..1, fraction of source frame, CENTER of the crop window
 *  - cut: true = hard-snap into this position (default — matches user
 *         expectation that "click here means jump here at this moment").
 *         false = smoothly pan from the previous keyframe.
 */
export default function StandaloneReframeKeyframeModal({
    videoUrl,
    targetAspect = 9 / 16,
    initialKeyframes = [],
    onClose,
    onSave,
}) {
    const videoRef = useRef(null);
    const frameRef = useRef(null);

    const [duration, setDuration] = useState(0);
    const [sourceAspect, setSourceAspect] = useState(16 / 9);
    const [keyframes, setKeyframes] = useState(() =>
        // Defensive copy + sort + clamp so a malformed prop doesn't
        // break the editor.
        [...(initialKeyframes || [])]
            .map((kf) => ({
                t: Math.max(0, Number(kf.t) || 0),
                x: Math.max(0, Math.min(1, Number(kf.x) ?? 0.5)),
                y: Math.max(0, Math.min(1, Number(kf.y) ?? 0.5)),
                cut: kf.cut === undefined ? true : Boolean(kf.cut),
            }))
            .sort((a, b) => a.t - b.t)
    );
    const [currentTime, setCurrentTime] = useState(0);
    const [showAdvanced, setShowAdvanced] = useState(false);

    // Crop overlay box dimensions, in fractions of the source frame.
    // We pick the largest target-aspect rectangle that fits inside the
    // source — same rule reframe_kf.py uses on the backend, so the
    // preview rectangle matches the burned output 1:1.
    const boxWidthFrac =
        sourceAspect >= targetAspect
            ? targetAspect / sourceAspect // wide source: box is full height, narrower
            : 1; // narrow source: box is full width
    const boxHeightFrac =
        sourceAspect >= targetAspect
            ? 1
            : sourceAspect / targetAspect;

    // Seek the video to currentTime when it's nudged externally
    // (clicking a keyframe row). Avoid the seek-loop when the user is
    // scrubbing the slider — onTimeUpdate keeps currentTime in sync.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (Math.abs(v.currentTime - currentTime) > 0.05) {
            v.currentTime = currentTime;
        }
    }, [currentTime]);

    function handleLoadedMetadata(e) {
        const v = e.target;
        if (v.duration && Number.isFinite(v.duration)) setDuration(v.duration);
        if (v.videoWidth && v.videoHeight) {
            setSourceAspect(v.videoWidth / v.videoHeight);
        }
    }

    function handleFrameClick(e) {
        const rect = frameRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Frame click coords -> 0..1 fractions. The video uses
        // object-fit:contain, so the actual video pixels may not fill
        // the whole click area when source/container aspects differ.
        // Clamp by the visible video area: the video is letterboxed
        // either left/right or top/bottom inside the container.
        const containerAspect = rect.width / rect.height;
        let visW = rect.width;
        let visH = rect.height;
        let offX = 0;
        let offY = 0;
        if (sourceAspect > containerAspect) {
            // Letterboxed top/bottom — full width, shorter height.
            visH = rect.width / sourceAspect;
            offY = (rect.height - visH) / 2;
        } else {
            // Pillarboxed left/right — full height, narrower width.
            visW = rect.height * sourceAspect;
            offX = (rect.width - visW) / 2;
        }
        const localX = e.clientX - rect.left - offX;
        const localY = e.clientY - rect.top - offY;
        if (localX < 0 || localX > visW || localY < 0 || localY > visH) {
            // Click was on the letterbox bars — ignore.
            return;
        }
        const cx = Math.max(0, Math.min(1, localX / visW));
        const cy = Math.max(0, Math.min(1, localY / visH));
        const t = Math.max(0, Math.min(duration || currentTime, currentTime));
        setKeyframes((kfs) => {
            // Replace any keyframe within 0.25s of this one — saves the
            // user from accumulating duplicates while fine-tuning.
            const TIME_EPS = 0.25;
            const next = kfs.filter((k) => Math.abs(k.t - t) > TIME_EPS);
            // Default to a HARD CUT — most users want their click to
            // mean "snap focus here at this moment", not "smoothly pan
            // toward here over several seconds." The advanced toggle
            // exposes pan/cut per-keyframe.
            next.push({ t, x: cx, y: cy, cut: true });
            next.sort((a, b) => a.t - b.t);
            return next;
        });
    }

    function holdHere() {
        const t = Math.max(0, Math.min(duration || currentTime, currentTime));
        setKeyframes((kfs) => {
            const prior = [...kfs].reverse().find((k) => k.t < t);
            const next = kfs.filter((k) => Math.abs(k.t - t) > 0.25);
            if (!prior) {
                next.push({ t, x: 0.5, y: 0.5, cut: false });
            } else {
                next.push({ t, x: prior.x, y: prior.y, cut: false });
            }
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

    function clearAll() {
        setKeyframes([]);
    }

    function save() {
        onSave?.(keyframes);
    }

    // Pick the keyframe whose time is closest to currentTime so we can
    // highlight it in the list and draw the crop box at its position.
    const activeKfIdx =
        keyframes.length === 0
            ? -1
            : keyframes.reduce(
                (bestIdx, kf, i, arr) =>
                    Math.abs(kf.t - currentTime) <
                        Math.abs(arr[bestIdx].t - currentTime)
                        ? i
                        : bestIdx,
                0
            );

    // Also compute the "current" effective box position for the overlay
    // — the same logic the burn pipeline uses: hold previous position
    // until the next CUT keyframe, otherwise lerp.
    const overlay = (() => {
        if (keyframes.length === 0) return { x: 0.5, y: 0.5 };
        const sorted = [...keyframes].sort((a, b) => a.t - b.t);
        const last = sorted[sorted.length - 1];
        if (currentTime >= last.t) return { x: last.x, y: last.y };
        const first = sorted[0];
        if (currentTime <= first.t) return { x: first.x, y: first.y };
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            if (currentTime >= a.t && currentTime < b.t) {
                if (b.cut || b.t - a.t < 0.01) {
                    return { x: a.x, y: a.y };
                }
                const u = (currentTime - a.t) / (b.t - a.t);
                return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
            }
        }
        return { x: 0.5, y: 0.5 };
    })();

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-3xl shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar"
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-zinc-500 hover:text-white"
                >
                    <X size={20} />
                </button>

                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center">
                        <MoveHorizontal size={20} className="text-white" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">
                            Reframe — focus cuts
                        </h3>
                        <p className="text-xs text-zinc-500">
                            Click anywhere on the frame to drop a hard cut at this moment.
                            The crop window will snap to that focus point until the next cut.
                        </p>
                    </div>
                </div>

                {/* Source video viewer with click-to-keyframe */}
                <div
                    ref={frameRef}
                    onClick={handleFrameClick}
                    className="relative w-full bg-black rounded-lg overflow-hidden cursor-crosshair select-none mb-3"
                    style={{ aspectRatio: `${sourceAspect}` }}
                >
                    {videoUrl ? (
                        <video
                            ref={videoRef}
                            src={videoUrl}
                            preload="metadata"
                            playsInline
                            muted
                            className="w-full h-full object-contain pointer-events-none"
                            onLoadedMetadata={handleLoadedMetadata}
                            onTimeUpdate={(e) => {
                                const t = e.target.currentTime;
                                if (Math.abs(t - currentTime) > 0.05) setCurrentTime(t);
                            }}
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
                            Source video not available
                        </div>
                    )}

                    {/* Target-aspect crop overlay at the current effective position */}
                    {keyframes.length > 0 && (() => {
                        const wPct = boxWidthFrac * 100;
                        const hPct = boxHeightFrac * 100;
                        const leftPct = Math.max(
                            0,
                            Math.min(100 - wPct, overlay.x * 100 - wPct / 2)
                        );
                        const topPct = Math.max(
                            0,
                            Math.min(100 - hPct, overlay.y * 100 - hPct / 2)
                        );
                        return (
                            <div
                                className="absolute pointer-events-none border-2 border-cyan-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                                style={{
                                    left: `${leftPct}%`,
                                    top: `${topPct}%`,
                                    width: `${wPct}%`,
                                    height: `${hPct}%`,
                                }}
                            />
                        );
                    })()}

                    {/* All keyframe dots */}
                    {keyframes.map((kf, i) => (
                        <div
                            key={i}
                            className={
                                'absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full pointer-events-none ' +
                                (i === activeKfIdx
                                    ? 'bg-cyan-400 ring-2 ring-cyan-200'
                                    : 'bg-cyan-400/60 ring-1 ring-cyan-200/50')
                            }
                            style={{
                                left: `${kf.x * 100}%`,
                                top: `${kf.y * 100}%`,
                            }}
                        />
                    ))}
                </div>

                {/* Time scrubber */}
                <div className="mb-3">
                    <div className="flex items-baseline justify-between mb-1 text-xs text-zinc-400">
                        <span>Time in video</span>
                        <span className="font-mono tabular-nums text-zinc-200">
                            {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                        </span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(duration, 0.01)}
                        step={0.05}
                        value={currentTime}
                        onChange={(e) => setCurrentTime(+e.target.value)}
                        className="w-full accent-cyan-400"
                    />
                </div>

                {/* Keyframe list + Hold-here helper */}
                <div className="rounded-lg border border-white/5 bg-black/30 mb-4 max-h-44 overflow-auto">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                            Keyframes ({keyframes.length})
                        </span>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={holdHere}
                                className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                                title="Add a keyframe here that holds the previous keyframe's position"
                            >
                                <Plus size={11} /> Hold here
                            </button>
                            {keyframes.length > 0 && (
                                <button
                                    onClick={clearAll}
                                    className="text-[11px] text-zinc-400 hover:text-red-400"
                                    title="Remove all keyframes and revert to the static X/Y sliders"
                                >
                                    Clear all
                                </button>
                            )}
                        </div>
                    </div>
                    {keyframes.length === 0 ? (
                        <p className="text-xs text-zinc-500 text-center py-3 px-2">
                            No keyframes yet. Scrub, then click on the frame to add one.
                            With zero keyframes, the burn falls back to the X/Y sliders.
                        </p>
                    ) : (
                        <ul className="p-2 space-y-1">
                            {keyframes.map((kf, i) => (
                                <li
                                    key={i}
                                    className={
                                        'flex items-center justify-between gap-2 text-xs py-1 px-2 rounded ' +
                                        (i === activeKfIdx
                                            ? 'bg-cyan-500/15 text-cyan-200'
                                            : 'text-zinc-300 hover:bg-white/5')
                                    }
                                >
                                    <button
                                        onClick={() => setCurrentTime(kf.t)}
                                        className="font-mono tabular-nums text-left flex-1 truncate"
                                    >
                                        @ {kf.t.toFixed(2)}s · x:{(kf.x * 100).toFixed(0)}% · y:
                                        {(kf.y * 100).toFixed(0)}%
                                    </button>
                                    {showAdvanced && (
                                        <button
                                            onClick={() => toggleCut(kf.t)}
                                            className={
                                                'px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-bold transition ' +
                                                (kf.cut
                                                    ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                                                    : 'bg-blue-500/20 text-blue-300 border border-blue-500/40')
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
                                        className="text-zinc-500 hover:text-red-400"
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
                    className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 mb-3"
                >
                    {showAdvanced ? '− Hide' : '+ Show'} advanced (smooth pan instead of cut)
                </button>
                {showAdvanced && (
                    <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
                        Each keyframe has a badge:{' '}
                        <strong className="text-orange-300">CUT</strong> snaps instantly,{' '}
                        <strong className="text-blue-300">PAN</strong> glides smoothly from
                        the previous keyframe. Click a badge to switch modes for that
                        keyframe.
                    </p>
                )}

                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                        <Plus size={12} /> Click on the frame to add · drag the slider to
                        pick a time
                    </span>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="px-3 py-1.5 rounded-lg border border-white/10 bg-black/30 text-xs text-zinc-300 hover:border-white/20"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={save}
                            className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-cyan-500 text-xs font-semibold text-white shadow flex items-center gap-2"
                        >
                            Save keyframes
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
