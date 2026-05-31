import React, { useRef, useState } from 'react';
import { Loader2, Check } from 'lucide-react';

/**
 * Split-pane "we're working on it" view shared by the standalone
 * Subtitle and Dub features (and reused for Phase-2 burn rendering).
 *
 *   Left  — the user's source video, muted + autoplay + loop. Aspect
 *           ratio detected from the metadata so vertical / square /
 *           horizontal sources all display naturally without crop.
 *   Right — animated spinner + human-readable status + tail of log
 *           lines. Optional `steps` prop renders a checklist with
 *           the current step highlighted.
 *
 * Mirrors the visual language of the Clip Generator's processing pane
 * so the three products feel like one app, not three.
 */
export default function ProcessingPreview({
    videoUrl,
    logs = [],
    status = 'processing',
    accent = 'orange',
    title,
    // Optional list of named pipeline stages, in order. Each item:
    //   { id: 'transcribing', label: 'Transcribing audio' }
    // The component highlights items that have already been emitted
    // as a status, dims the rest. Useful for a clear "where are we
    // right now" affordance vs just a stream of logs.
    steps = [],
}) {
    const videoRef = useRef(null);
    const [aspect, setAspect] = useState(9 / 16);

    const accentText = {
        orange: 'text-orange-300',
        emerald: 'text-emerald-300',
        primary: 'text-primary',
    }[accent] || 'text-orange-300';
    const accentSpinner = {
        orange: 'text-orange-400',
        emerald: 'text-emerald-400',
        primary: 'text-primary',
    }[accent] || 'text-orange-400';

    const handleLoadedMetadata = (e) => {
        const v = e.target;
        if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
    };

    // Determine which named step (if any) is current. We treat the
    // status string as the active step's id; everything before it in
    // the list counts as done; everything after as pending.
    const activeIdx = steps.findIndex((s) => s.id === status);

    const tailLogs = (logs || []).slice(-15);

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
            {/* Source video preview */}
            <div
                className="rounded-2xl border border-white/10 bg-black overflow-hidden relative w-full mx-auto max-h-[600px]"
                style={{ aspectRatio: aspect }}
            >
                {videoUrl ? (
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        muted loop autoPlay playsInline
                        preload="metadata"
                        onLoadedMetadata={handleLoadedMetadata}
                        className="w-full h-full object-contain bg-black"
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs">
                        No source preview
                    </div>
                )}
                {/* Subtle "processing" badge in the top corner so the
                    user understands the video isn't the OUTPUT yet. */}
                <div className={`absolute top-2 left-2 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full bg-black/60 border border-white/10 ${accentText}`}>
                    <Loader2 size={10} className="animate-spin" />
                    Source · processing
                </div>
            </div>

            {/* Status + logs */}
            <div className="rounded-2xl border border-white/10 bg-surface/40 p-5 flex flex-col">
                <div className="flex items-center gap-3 mb-3">
                    <Loader2 size={22} className={`${accentSpinner} animate-spin shrink-0`} />
                    <div>
                        {title && (
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
                                {title}
                            </div>
                        )}
                        <div className="text-base font-semibold text-white capitalize">
                            {(status || 'processing').replace(/_/g, ' ')}…
                        </div>
                    </div>
                </div>

                {steps.length > 0 && (
                    <ol className="space-y-1.5 mb-3">
                        {steps.map((s, i) => {
                            const done = activeIdx >= 0 && i < activeIdx;
                            const active = activeIdx >= 0 && i === activeIdx;
                            return (
                                <li key={s.id} className="flex items-center gap-2 text-[12px]">
                                    {done ? (
                                        <Check size={12} className="text-green-400 shrink-0" />
                                    ) : active ? (
                                        <Loader2 size={12} className={`${accentSpinner} animate-spin shrink-0`} />
                                    ) : (
                                        <span className="w-3 h-3 rounded-full border border-white/15 inline-block shrink-0" />
                                    )}
                                    <span className={
                                        done ? 'text-zinc-400 line-through decoration-zinc-700'
                                        : active ? 'text-white font-medium'
                                        : 'text-zinc-500'
                                    }>
                                        {s.label}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                )}

                {tailLogs.length > 0 && (
                    <div className="flex-1 min-h-[120px] max-h-[260px] overflow-y-auto custom-scrollbar text-left text-[11px] font-mono text-zinc-400 space-y-1 bg-black/30 rounded-md p-3 border border-white/5">
                        {tailLogs.map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                )}

                <p className="mt-3 text-[10px] text-zinc-500 leading-relaxed">
                    Keep this tab open. Long videos can take a few minutes — the spinner means it's working, not stuck.
                </p>
            </div>
        </div>
    );
}
