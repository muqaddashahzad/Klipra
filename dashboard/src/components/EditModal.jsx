import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
    X, Loader2, Plus, Trash2, Wand2, RotateCcw, Sparkles, Play, Pause, Eye,
    ChevronLeft, ChevronRight, Palette, Film, Globe2,
} from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Edit modal — Phase 2.
 *
 * What changed since Phase 1:
 *   - Per-region preview now plays IN the main video pane on the left
 *     instead of in a tiny secondary box on the right. Click Preview
 *     and the main player swaps to the rendered preview; click "Back
 *     to source" or change the effect and it goes back.
 *   - 12 new color presets (cinematic, vintage, noir, dreamy, golden
 *     hour, bleach bypass, cyberpunk, matte, autumn, winter, pink vibe).
 *   - "Apply to whole video" toggle on each region — colour grades
 *     can now grade the entire clip without picking a sub-region.
 *   - ±0.5s nudge buttons next to start/end so the user can shift a
 *     selected region a few frames left or right without scrubbing.
 *   - Motion effects (zoom-punch, slow-pan, shake, flash) now use
 *     ease curves on the BACKEND so they fade in and out instead of
 *     popping. Nothing to do here — the recipe is deterministic.
 *   - Effect picker is split into Motion / Color tabs so the long
 *     color list doesn't drown out the four motion effects.
 */
export default function EditModal({
    isOpen,
    onClose,
    onApplied,    // (newVideoUrl) => void
    videoUrl,
    jobId,
    clipIndex,
    inputFilename,
    durationSec = 30,
}) {
    const videoRef = useRef(null);
    const [catalog, setCatalog] = useState([]);
    const [regions, setRegions] = useState([]);
    const [isRendering, setIsRendering] = useState(false);
    const [error, setError] = useState(null);
    const [playTime, setPlayTime] = useState(0);
    const [playing, setPlaying] = useState(false);

    // Per-region preview cache + inflight tracking. Keyed by a string
    // derived from (start, end, effect, whole) so any change to the
    // region invalidates the cached preview and re-renders.
    const [previews, setPreviews] = useState({});
    const [loadingKeys, setLoadingKeys] = useState(new Set());
    const [previewErrors, setPreviewErrors] = useState({});
    // SFX master controls — when on, the backend mixes a synthetic
    // sound cue at the start of each motion region. Opt-in (off by
    // default) so existing users see no behaviour change. Volume is a
    // master gain 0..1 applied to all cues.
    const [enableSfx, setEnableSfx] = useState(false);
    const [sfxVolume, setSfxVolume] = useState(0.6);

    // The main video pane shows ONE of two things:
    //   - the source video (default), OR
    //   - the preview rendering for `previewingRegionId`.
    // Setting it to null returns the main pane to the source video.
    const [previewingRegionId, setPreviewingRegionId] = useState(null);

    // Pull effect catalog once when modal opens.
    useEffect(() => {
        if (!isOpen) return;
        fetch(getApiUrl('/api/edit/effect-catalog'))
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (d?.effects) setCatalog(d.effects); })
            .catch(() => { /* fall back to no-catalog UI */ });
    }, [isOpen]);

    // CRITICAL: every hook MUST be declared before any early return.
    const sortedRegions = useMemo(
        () => [...regions].sort((a, b) => a.start - b.start),
        [regions]
    );

    if (!isOpen) return null;

    // ----- region helpers -----
    const addRegion = () => {
        // Open a 2-second region centred on the current playhead, snapped
        // inside the clip duration.
        const half = 1;
        const center = playTime || durationSec / 2;
        const s = Math.max(0, center - half);
        const e = Math.min(durationSec, center + half);
        setRegions((prev) => [...prev, {
            id: Math.random().toString(36).slice(2, 10),
            start: +s.toFixed(2),
            end: +e.toFixed(2),
            effect: catalog[0]?.id || 'zoom-punch',
            whole: false,
        }]);
    };

    const removeRegion = (id) => {
        setRegions((prev) => prev.filter((r) => r.id !== id));
        // If we were previewing the removed region, drop back to source.
        if (previewingRegionId === id) setPreviewingRegionId(null);
    };

    const updateRegion = (id, patch) => {
        setRegions((prev) => prev.map((r) => r.id === id ? { ...r, ...patch } : r));
        // Any param change invalidates the preview — go back to source
        // until the user re-clicks Preview.
        if (previewingRegionId === id) setPreviewingRegionId(null);
    };

    // Shift the region left / right by `delta` seconds (negative = left,
    // positive = right). Clamps to clip bounds and minimum 0.1s width.
    // Useful when scrubbing to the exact frame is fiddly — the user
    // can drop a roughly-placed region and nudge it from there.
    // Seek the main player to a specific time. Used by region cards
    // (click the timestamp) and timeline markers (click the strip below
    // the video) so the user can jump straight to the moment they want
    // to edit instead of scrubbing manually.
    const seekTo = (t) => {
        const v = videoRef.current;
        if (!v) return;
        const target = Math.max(0, Math.min(durationSec, Number(t) || 0));
        try {
            v.currentTime = target;
            setPlayTime(target);
        } catch {}
    };

    const shiftRegion = (id, delta) => {
        setRegions((prev) => prev.map((r) => {
            if (r.id !== id) return r;
            const width = r.end - r.start;
            let newStart = +(r.start + delta).toFixed(2);
            let newEnd = +(r.end + delta).toFixed(2);
            if (newStart < 0) { newStart = 0; newEnd = +(width).toFixed(2); }
            if (newEnd > durationSec) {
                newEnd = +durationSec.toFixed(2);
                newStart = +(durationSec - width).toFixed(2);
            }
            return { ...r, start: newStart, end: newEnd };
        }));
        if (previewingRegionId === id) setPreviewingRegionId(null);
    };

    // ----- preview helpers -----
    const regionKey = (region) =>
        region.whole
            ? `whole|${region.effect || ''}`
            : `${region.start.toFixed(3)}|${region.end.toFixed(3)}|${region.effect || ''}`;

    const requestPreview = async (region) => {
        const key = regionKey(region);
        // Already cached? Just swap the main pane to it — no network.
        if (previews[key]) {
            setPreviewingRegionId(region.id);
            return previews[key];
        }
        setLoadingKeys((prev) => {
            const next = new Set(prev); next.add(key); return next;
        });
        setPreviewErrors((prev) => ({ ...prev, [region.id]: null }));
        try {
            const res = await fetch(getApiUrl('/api/clip/edit-region-preview'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    input_filename: inputFilename,
                    region: {
                        start: region.start,
                        end: region.end,
                        effect: region.effect,
                        whole: !!region.whole,
                    },
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (!data.preview_url) throw new Error('No preview URL returned.');
            const ready = { url: getApiUrl(data.preview_url), duration: data.duration };
            setPreviews((prev) => ({ ...prev, [key]: ready }));
            setPreviewingRegionId(region.id);
            return ready;
        } catch (e) {
            const msg = (e && e.message) || String(e);
            setPreviewErrors((prev) => ({ ...prev, [region.id]: msg }));
            return null;
        } finally {
            setLoadingKeys((prev) => {
                const next = new Set(prev); next.delete(key); return next;
            });
        }
    };

    const render = async () => {
        if (regions.length === 0) {
            setError('Add at least one region first.');
            return;
        }
        setError(null);
        setIsRendering(true);
        try {
            const res = await fetch(getApiUrl('/api/clip/edit-timeline'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    input_filename: inputFilename,
                    regions: regions.map(({ id, ...rest }) => rest),
                    enable_sfx: enableSfx,
                    sfx_volume: sfxVolume,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                onApplied?.(data.new_video_url);
                onClose?.();
            }
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setIsRendering(false);
        }
    };

    // Resolve which video the main pane should play. If we're previewing
    // a region and that region's preview has loaded, use it; otherwise
    // fall back to the source.
    const previewingRegion = sortedRegions.find((r) => r.id === previewingRegionId);
    const activePreview = previewingRegion ? previews[regionKey(previewingRegion)] : null;
    const mainVideoSrc = activePreview ? activePreview.url : videoUrl;
    const isShowingPreview = !!activePreview;

    // Friendly error summary — collapse the raw FFmpeg stderr dump
    // into a one-line "what went wrong" message. Users don't need to
    // read the codec dump, they need to know what to try next.
    const friendlyError = (raw) => {
        if (!raw) return '';
        const s = String(raw);
        if (s.includes("'eval' to filter 'crop'"))
            return 'FFmpeg crop filter issue — restart the backend so the new filter pattern loads.';
        if (s.includes('Option not found'))
            return 'FFmpeg rejected an option. Make sure the backend has been restarted recently.';
        if (s.includes('No such file'))
            return 'Source clip file is missing on the server. Try re-generating the clip.';
        if (s.includes('Timeout') || s.includes('timed out'))
            return 'Render timed out. Try a shorter region or fewer simultaneous effects.';
        // Generic — take the FIRST line of stderr which usually has the gist.
        const firstError = s.split('\n').find((l) => /error|failed/i.test(l));
        return (firstError || s).slice(0, 200);
    };

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-5xl rounded-3xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.8),0_0_60px_-20px_rgba(168,85,247,0.18)] max-h-[95vh] overflow-y-auto custom-scrollbar"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Sticky frosted header */}
                <div className="sticky top-0 z-20 flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-zinc-900/85 backdrop-blur-xl">
                    <div className="flex items-center gap-2.5">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500/30 to-indigo-600/20 ring-1 ring-purple-400/30 shadow-[0_0_18px_-4px_rgba(168,85,247,0.6)]">
                            <Sparkles size={14} className="text-purple-200" />
                        </span>
                        <div>
                            <h3 className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent text-[13px] tracking-tight font-semibold">
                                Edit clip
                            </h3>
                            <p className="text-[11px] text-zinc-500 mt-0.5">
                                Add regions, pick presets, preview each effect, then render.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isRendering}
                        className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 transition disabled:opacity-50"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 p-5">
                    {/* LEFT — main player + timeline */}
                    <div className="space-y-3">
                        <div className="bg-black rounded-2xl overflow-hidden aspect-[9/16] max-h-[500px] relative ring-1 ring-white/10 shadow-2xl shadow-black/40">
                            {/* When previewing, the main player swaps to the
                                effect preview so the user sees the change at
                                full size, not in a tiny side panel. The
                                source returns as soon as they press the
                                "Back to source" button or change anything. */}
                            <video
                                ref={videoRef}
                                src={mainVideoSrc}
                                key={mainVideoSrc}     /* force re-mount on src swap */
                                className="w-full h-full object-contain"
                                controls={isShowingPreview}
                                autoPlay={isShowingPreview}
                                loop={isShowingPreview}
                                muted={isShowingPreview}
                                onTimeUpdate={(e) => {
                                    if (!isShowingPreview) setPlayTime(e.target.currentTime || 0);
                                }}
                                onPlay={() => setPlaying(true)}
                                onPause={() => setPlaying(false)}
                                playsInline
                            />
                            {/* Region markers overlaid on the video — only
                                while showing the source. While previewing,
                                they'd be misleading (the playhead refers
                                to the trimmed preview clip, not the full). */}
                            {!isShowingPreview && sortedRegions.length > 0 && (
                                <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/40">
                                    {sortedRegions.map((r) => (
                                        // Click a region marker to jump
                                        // the player to that region's
                                        // start. Whole-video regions
                                        // jump to 0.
                                        <button
                                            type="button"
                                            key={r.id}
                                            onClick={() => seekTo(r.whole ? 0 : r.start)}
                                            className={'absolute h-full cursor-pointer hover:brightness-125 ' + (r.whole ? 'bg-pink-500/60' : 'bg-purple-500/80')}
                                            style={r.whole ? { left: 0, width: '100%' } : {
                                                 left: `${(r.start / durationSec) * 100}%`,
                                                 width: `${((r.end - r.start) / durationSec) * 100}%`,
                                            }}
                                            title={r.whole ? 'Whole-video region' : `Jump to ${r.start.toFixed(1)}s`}
                                        />
                                    ))}
                                    {/* Playhead */}
                                    <div className="absolute top-0 h-full w-0.5 bg-yellow-400 pointer-events-none"
                                         style={{ left: `${(playTime / durationSec) * 100}%` }} />
                                </div>
                            )}
                            {/* Preview banner */}
                            {isShowingPreview && (
                                <div className="absolute top-2 left-2 right-2 z-10 flex items-center gap-2">
                                    <span className="text-[10px] px-2 py-1 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-bold uppercase tracking-wider shadow-lg">
                                        Previewing effect
                                    </span>
                                    <button
                                        onClick={() => setPreviewingRegionId(null)}
                                        className="ml-auto text-[10px] px-2 py-1 rounded-full bg-black/60 text-white hover:bg-black/80 backdrop-blur-sm ring-1 ring-white/10"
                                    >
                                        Back to source
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Timeline scrubber — glass pill bar like RetrimModal */}
                        <div className={'rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 backdrop-blur-md p-2 ' + (isShowingPreview ? 'opacity-50 pointer-events-none' : '')}>
                            <div className="flex items-center gap-2 mb-2">
                                <button
                                    onClick={() => {
                                        const v = videoRef.current;
                                        if (!v) return;
                                        if (v.paused) v.play(); else v.pause();
                                    }}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ring-1 ring-white/15 bg-gradient-to-b from-white/15 to-white/5 hover:from-white/25 hover:to-white/10 text-white text-xs">
                                    {playing ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                                    <span className="px-0.5">{playing ? 'Pause' : 'Play'}</span>
                                </button>
                                <span className="font-mono text-[11px] text-zinc-300 tabular-nums px-1">
                                    {fmtTime(playTime)} <span className="text-zinc-600">/</span> {fmtTime(durationSec)}
                                </span>
                                <button
                                    onClick={addRegion}
                                    className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 hover:from-purple-400 hover:via-fuchsia-400 hover:to-pink-400 text-white text-xs font-bold shadow-[0_4px_16px_-4px_rgba(168,85,247,0.6)]">
                                    <Plus size={12} /> Add region at playhead
                                </button>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max={durationSec}
                                step="0.05"
                                value={playTime}
                                onChange={(e) => {
                                    const t = parseFloat(e.target.value);
                                    setPlayTime(t);
                                    if (videoRef.current) videoRef.current.currentTime = t;
                                }}
                                className="w-full accent-purple-500 h-1.5"
                            />
                        </div>
                    </div>

                    {/* RIGHT — region list */}
                    <div className="space-y-3 overflow-y-auto custom-scrollbar pr-1 max-h-[600px]">
                        <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center justify-between">
                            <span className="inline-flex items-center gap-1.5">
                                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-md bg-purple-500/15 ring-1 ring-purple-400/30 text-purple-200 font-mono text-[10px]">
                                    {regions.length}
                                </span>
                                Regions
                            </span>
                            {regions.length > 0 && (
                                <button onClick={() => { setRegions([]); setPreviewingRegionId(null); }}
                                    className="text-[10px] text-zinc-400 hover:text-red-400 transition">
                                    Clear all
                                </button>
                            )}
                        </div>
                        {regions.length === 0 && (
                            <div className="rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/60 to-black/60 p-6 text-center text-[12px] text-zinc-500 leading-relaxed">
                                <div className="text-[11px] uppercase tracking-widest text-purple-300/80 mb-2 font-bold">No regions yet</div>
                                Scrub to a moment in the video, click <strong className="text-zinc-300">Add region at playhead</strong>, then pick an effect.
                                <div className="mt-3 text-[10px] text-zinc-600">
                                    Toggle <strong>Apply to whole video</strong> for full-clip colour grades. Hit <strong>Preview this effect</strong> to audition before rendering.
                                </div>
                            </div>
                        )}
                        {sortedRegions.map((r, i) => (
                            <RegionCard
                                key={r.id}
                                index={i + 1}
                                region={r}
                                catalog={catalog}
                                durationSec={durationSec}
                                onUpdate={(patch) => updateRegion(r.id, patch)}
                                onRemove={() => removeRegion(r.id)}
                                onShift={(delta) => shiftRegion(r.id, delta)}
                                onSeek={seekTo}
                                preview={previews[regionKey(r)] || null}
                                isPreviewLoading={loadingKeys.has(regionKey(r))}
                                previewError={previewErrors[r.id] || null}
                                isCurrentlyPreviewing={previewingRegionId === r.id}
                                onRequestPreview={() => requestPreview(r)}
                                onCancelPreview={() => setPreviewingRegionId(null)}
                            />
                        ))}

                        {error && (
                            <div className="rounded-xl ring-1 ring-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 flex items-start gap-2">
                                <span className="text-red-400 mt-px">⚠</span>
                                <div className="space-y-1.5">
                                    <div className="font-semibold">Render failed</div>
                                    <div className="text-red-300/90 leading-relaxed">{friendlyError(error)}</div>
                                    <details className="text-[10px] text-red-400/70">
                                        <summary className="cursor-pointer hover:text-red-300">Technical details</summary>
                                        <pre className="mt-1 whitespace-pre-wrap break-all max-h-32 overflow-auto opacity-70">{error}</pre>
                                    </details>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* SFX section — modernized card */}
                <div className="mx-5 mb-5 rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/60 to-black/60 p-4">
                    <label className="flex items-start gap-2.5 cursor-pointer text-xs text-zinc-300 hover:text-white">
                        <input
                            type="checkbox"
                            checked={enableSfx}
                            onChange={(e) => setEnableSfx(e.target.checked)}
                            className="mt-0.5 accent-amber-500 w-4 h-4"
                        />
                        <span>
                            <span className="font-semibold inline-flex items-center gap-1.5">
                                <Sparkles size={12} className="text-amber-300" /> Add sound effects to motion
                            </span>
                            <span className="block text-[10px] text-zinc-500 mt-0.5">
                                Auto-mixes a whoosh / impact / riser / ding cue at the start of each motion region. Color grades stay silent.
                            </span>
                        </span>
                    </label>
                    {enableSfx && (
                        <div className="mt-3 ml-6 rounded-xl ring-1 ring-amber-500/30 bg-gradient-to-b from-amber-500/10 to-amber-500/5 p-3">
                            <label className="text-[10px] text-amber-200 mb-1.5 flex justify-between">
                                <span className="font-bold uppercase tracking-wider">Master volume</span>
                                <span className="tabular-nums text-zinc-100 font-mono">{Math.round(sfxVolume * 100)}%</span>
                            </label>
                            <input
                                type="range" min={0} max={1} step={0.05}
                                value={sfxVolume}
                                onChange={(e) => setSfxVolume(+e.target.value)}
                                className="w-full accent-amber-500 h-1.5"
                            />
                            <p className="text-[10px] text-zinc-500 mt-2 leading-snug">
                                Cue mapping: <strong className="text-zinc-400">zoom-punch / shake</strong> → impact,
                                <strong className="text-zinc-400"> slow-pan</strong> → riser,
                                <strong className="text-zinc-400"> flash</strong> → ding.
                            </p>
                        </div>
                    )}
                </div>

                {/* Sticky footer — gradient Render button as primary action */}
                <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5 bg-zinc-900/85 backdrop-blur-xl">
                    <div className="text-[10px] text-zinc-500">
                        Backend re-renders from original source — ~10–30s per region.
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            disabled={isRendering}
                            className="rounded-lg ring-1 ring-white/10 bg-white/5 px-3.5 py-2 text-xs text-zinc-300 hover:bg-white/10 hover:ring-white/20 transition disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={render}
                            disabled={isRendering || regions.length === 0}
                            className="rounded-lg bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 hover:from-purple-400 hover:via-fuchsia-400 hover:to-pink-400 disabled:from-zinc-600 disabled:to-zinc-700 disabled:opacity-50 px-5 py-2 text-xs font-bold text-white shadow-[0_8px_24px_-8px_rgba(168,85,247,0.6),0_0_0_1px_rgba(168,85,247,0.4)] flex items-center gap-2 transition"
                        >
                            {isRendering ? <><Loader2 size={13} className="animate-spin" /> Rendering…</> : <><Wand2 size={13} /> Render edit</>}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function RegionCard({
    index, region, catalog, durationSec, onUpdate, onRemove, onShift, onSeek,
    preview, isPreviewLoading, previewError,
    isCurrentlyPreviewing, onRequestPreview, onCancelPreview,
}) {
    // Tabs for the effect picker — splits Motion (4) and Color (12+)
    // so the long color list doesn't drown out motion. Defaults to
    // whichever group the current effect belongs to.
    const motionEffects = (catalog || []).filter((e) => e.category === 'motion');
    const colorEffects = (catalog || []).filter((e) => e.category === 'color');
    const currentInColor = colorEffects.some((e) => e.id === region.effect);
    const [tab, setTab] = useState(currentInColor ? 'color' : 'motion');

    return (
        <div className={
            'rounded-2xl ring-1 bg-gradient-to-b from-zinc-900/70 to-black/60 p-3.5 space-y-3 transition ' +
            (isCurrentlyPreviewing
                ? 'ring-purple-400/60 shadow-[0_0_20px_-4px_rgba(168,85,247,0.5)]'
                : 'ring-white/10 hover:ring-white/20')
        }>
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => onSeek?.(region.whole ? 0 : region.start)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-300 hover:text-purple-200 transition cursor-pointer"
                    title="Jump player to this region"
                >
                    <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md bg-purple-500/15 ring-1 ring-purple-400/30 text-purple-200 font-mono text-[10px]">
                        {index}
                    </span>
                    <span className="uppercase tracking-wider">Region</span>
                    {!region.whole && (
                        <span className="text-zinc-500 font-mono tabular-nums">
                            {fmtTime(region.start)}
                        </span>
                    )}
                </button>
                <button
                    onClick={onRemove}
                    className="text-zinc-500 hover:text-red-400 p-1.5 rounded-md hover:bg-white/5 transition"
                    title="Remove region"
                >
                    <Trash2 size={12} />
                </button>
            </div>

            {/* Whole-video toggle */}
            <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg ring-1 ring-white/10 bg-black/30 cursor-pointer hover:ring-pink-400/40 hover:bg-pink-500/5 transition">
                <input
                    type="checkbox"
                    checked={!!region.whole}
                    onChange={(e) => onUpdate({ whole: e.target.checked })}
                    className="accent-pink-500 w-3.5 h-3.5"
                />
                <Globe2 size={12} className="text-pink-300" />
                <span className="text-[11px] text-zinc-200">Apply to whole video</span>
            </label>

            {/* Time inputs (hidden when whole=true since they're ignored) */}
            {!region.whole && (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="block text-[10px] text-zinc-400">
                            Start
                            <input type="number" min={0} max={durationSec} step={0.05}
                                value={region.start}
                                onChange={(e) => {
                                    const v = clamp(parseFloat(e.target.value) || 0, 0, region.end - 0.1);
                                    onUpdate({ start: +v.toFixed(2) });
                                }}
                                onFocus={() => onSeek?.(region.start)}
                                className="mt-1 w-full bg-black/40 border border-white/10 rounded-md py-1.5 px-2 text-xs text-white font-mono focus:outline-none focus:border-purple-500/50" />
                        </label>
                        <label className="block text-[10px] text-zinc-400">
                            End
                            <input type="number" min={0} max={durationSec} step={0.05}
                                value={region.end}
                                onChange={(e) => {
                                    const v = clamp(parseFloat(e.target.value) || 0, region.start + 0.1, durationSec);
                                    onUpdate({ end: +v.toFixed(2) });
                                }}
                                onFocus={() => onSeek?.(region.end)}
                                className="mt-1 w-full bg-black/40 border border-white/10 rounded-md py-1.5 px-2 text-xs text-white font-mono focus:outline-none focus:border-purple-500/50" />
                        </label>
                    </div>
                    {/* Nudge buttons — shift the WHOLE region (start AND
                        end together) ±0.5s, so the user can drop a
                        roughly-placed region and slide it onto the right
                        beat without scrubbing twice. */}
                    <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="text-zinc-500">Nudge:</span>
                        <button onClick={() => onShift(-0.5)}
                            className="px-2 py-1 rounded-md bg-black/40 hover:bg-white/10 text-zinc-300 flex items-center gap-1 disabled:opacity-30"
                            disabled={region.start <= 0}>
                            <ChevronLeft size={10} /> 0.5s
                        </button>
                        <button onClick={() => onShift(-0.1)}
                            className="px-2 py-1 rounded-md bg-black/40 hover:bg-white/10 text-zinc-300 flex items-center gap-1 disabled:opacity-30"
                            disabled={region.start <= 0}>
                            <ChevronLeft size={10} /> 0.1s
                        </button>
                        <button onClick={() => onShift(0.1)}
                            className="px-2 py-1 rounded-md bg-black/40 hover:bg-white/10 text-zinc-300 flex items-center gap-1 disabled:opacity-30"
                            disabled={region.end >= durationSec}>
                            0.1s <ChevronRight size={10} />
                        </button>
                        <button onClick={() => onShift(0.5)}
                            className="px-2 py-1 rounded-md bg-black/40 hover:bg-white/10 text-zinc-300 flex items-center gap-1 disabled:opacity-30"
                            disabled={region.end >= durationSec}>
                            0.5s <ChevronRight size={10} />
                        </button>
                        <span className="ml-auto text-zinc-500">{(region.end - region.start).toFixed(2)}s</span>
                    </div>
                </>
            )}

            {/* Effect picker — Motion / Color tabs (segmented control) */}
            <div>
                <div className="inline-flex w-full rounded-xl ring-1 ring-white/10 bg-black/40 p-0.5 mb-2.5">
                    <button onClick={() => setTab('motion')}
                        className={'flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 transition ' +
                            (tab === 'motion'
                                ? 'bg-gradient-to-b from-purple-500/40 to-purple-700/20 text-white ring-1 ring-purple-400/50 shadow-[0_0_12px_-4px_rgba(168,85,247,0.5)]'
                                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')}>
                        <Film size={10} /> Motion
                    </button>
                    <button onClick={() => setTab('color')}
                        className={'flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 transition ' +
                            (tab === 'color'
                                ? 'bg-gradient-to-b from-pink-500/40 to-rose-700/20 text-white ring-1 ring-pink-400/50 shadow-[0_0_12px_-4px_rgba(236,72,153,0.5)]'
                                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')}>
                        <Palette size={10} /> Color presets
                    </button>
                </div>
                {(tab === 'motion' ? motionEffects : colorEffects).length > 0 ? (
                    <div className="grid grid-cols-2 gap-1.5">
                        {(tab === 'motion' ? motionEffects : colorEffects).map((eff) => (
                            <button key={eff.id} onClick={() => onUpdate({ effect: eff.id })}
                                className={
                                    'rounded-xl ring-1 px-2.5 py-2 text-left transition ' +
                                    (region.effect === eff.id
                                        ? (tab === 'motion'
                                            ? 'ring-purple-400/60 bg-gradient-to-br from-purple-500/20 to-purple-700/10 text-white shadow-[0_0_12px_-4px_rgba(168,85,247,0.4)]'
                                            : 'ring-pink-400/60 bg-gradient-to-br from-pink-500/20 to-rose-700/10 text-white shadow-[0_0_12px_-4px_rgba(236,72,153,0.4)]')
                                        : 'ring-white/5 bg-black/30 text-zinc-300 hover:ring-white/20 hover:bg-white/5')
                                }>
                                <div className="text-[11px] font-semibold">{eff.name}</div>
                                <div className="text-[9px] text-zinc-500 leading-tight mt-0.5">{eff.desc}</div>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="text-[10px] text-zinc-500">Loading effect library…</div>
                )}
                {tab === 'motion' && region.whole && (
                    <p className="mt-2 text-[10px] text-amber-300/80 leading-snug bg-amber-500/5 ring-1 ring-amber-500/20 rounded-lg p-2">
                        Heads-up: motion effects on a whole clip play continuously and often look weird. Colour presets work better full-clip.
                    </p>
                )}
            </div>

            {/* Preview button — plays in the LEFT-side main video pane */}
            <div className="pt-2.5 border-t border-white/5">
                {!isCurrentlyPreviewing ? (
                    <button
                        type="button"
                        onClick={onRequestPreview}
                        disabled={isPreviewLoading}
                        className="w-full rounded-lg ring-1 ring-purple-400/40 bg-gradient-to-b from-purple-500/20 to-purple-700/10 hover:from-purple-500/30 hover:to-purple-700/15 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs text-purple-100 font-semibold flex items-center justify-center gap-1.5 transition shadow-[0_0_12px_-4px_rgba(168,85,247,0.4)]"
                    >
                        {isPreviewLoading ? (
                            <><Loader2 size={12} className="animate-spin" /> Rendering preview…</>
                        ) : preview ? (
                            <><Eye size={12} /> Show this preview in player</>
                        ) : (
                            <><Eye size={12} /> Preview this effect</>
                        )}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={onCancelPreview}
                        className="w-full rounded-lg ring-1 ring-white/15 bg-white/5 hover:bg-white/10 px-3 py-2 text-xs text-zinc-200 font-medium flex items-center justify-center gap-1.5 transition"
                    >
                        <RotateCcw size={12} /> Stop previewing — show source
                    </button>
                )}
                {previewError && (
                    <div className="mt-2 rounded-lg ring-1 ring-red-500/40 bg-red-500/10 p-2 text-[10px] text-red-200 flex items-start gap-1.5">
                        <span className="text-red-400">⚠</span>
                        <span>{previewError.includes("'eval' to filter 'crop'")
                            ? 'Restart the backend so the new filter loads, then try again.'
                            : (previewError.length > 200 ? previewError.slice(0, 200) + '…' : previewError)}</span>
                    </div>
                )}
            </div>
        </div>
    );
}

function fmtTime(t) {
    const s = Math.max(0, +t || 0);
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return `${m}:${sec.padStart(4, '0')}`;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
