import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
    Sparkles, Image as ImageIcon, Music, Wand2, Clock3, X, Info,
    UserCircle2, AudioLines, ChevronRight,
} from 'lucide-react';

/**
 * AI Avatar — talking-head generation (UI placeholder).
 *
 * What the user does here:
 *   1. Drops a face photo.
 *   2. Drops an audio file (or — later — pulls audio from an existing clip).
 *   3. Picks a model + a quality / length preset.
 *   4. Clicks "Generate" — for now the button shows a friendly
 *      "Coming soon" panel because no avatar engine is wired up yet.
 *
 * Why the engine isn't live yet:
 *   LongCat-Video-Avatar, the model the user originally pointed at,
 *   requires NVIDIA CUDA + FlashAttention-2 and 24-80 GB of VRAM per
 *   GPU. That doesn't fit on the user's M1 Mac. When a Mac-compatible
 *   port (MLX / quantized) ships, we plug it in behind this UI and the
 *   user-facing flow stays the same.
 *
 * Intentionally separate from the heavier products so the YouTube demo
 * can show it WITHOUT promising a working engine — the "Coming soon"
 * state is honest and clear.
 */
export default function AIAvatar({ onChooseTab, currentUser }) {
    const [photoFile, setPhotoFile] = useState(null);
    const [photoUrl, setPhotoUrl] = useState('');
    const [audioFile, setAudioFile] = useState(null);
    const [audioUrl, setAudioUrl] = useState('');
    const [engine, setEngine] = useState('longcat-avatar');
    const [resolution, setResolution] = useState('720p');
    const [showComingSoon, setShowComingSoon] = useState(false);

    const photoInputRef = useRef(null);
    const audioInputRef = useRef(null);

    const handlePhoto = useCallback((file) => {
        if (!file) return;
        if (photoUrl) { try { URL.revokeObjectURL(photoUrl); } catch (_) {} }
        setPhotoFile(file);
        setPhotoUrl(URL.createObjectURL(file));
    }, [photoUrl]);

    const handleAudio = useCallback((file) => {
        if (!file) return;
        if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch (_) {} }
        setAudioFile(file);
        setAudioUrl(URL.createObjectURL(file));
    }, [audioUrl]);

    const canGenerate = !!photoFile && !!audioFile;

    const engineOptions = useMemo(() => ([
        {
            id: 'longcat-avatar',
            label: 'LongCat-Video-Avatar',
            tag: 'Foundation',
            tagline: 'Best quality, requires NVIDIA GPU. Currently waiting for Apple Silicon port.',
            disabled: true,
        },
        {
            id: 'sadtalker',
            label: 'SadTalker',
            tag: 'Mac-ready',
            tagline: 'Runs on M-series via PyTorch MPS. ~2-5 min per 10-sec clip. Not yet wired up.',
            disabled: true,
        },
        {
            id: 'musetalk',
            label: 'MuseTalk',
            tag: 'Mac-ready · faster',
            tagline: 'Newer, ~30 sec per 10-sec clip on M1. Lower fidelity than SadTalker but quicker. Not yet wired up.',
            disabled: true,
        },
        {
            id: 'wav2lip',
            label: 'Wav2Lip',
            tag: 'Lip-only · fastest',
            tagline: 'Just animates lips, face stays still. Runs in seconds on Mac. Not yet wired up.',
            disabled: true,
        },
    ]), []);

    function onGenerateClick() {
        if (!canGenerate) return;
        setShowComingSoon(true);
    }

    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-[fadeIn_0.3s_ease-out]">

                {/* Hero */}
                <header className="text-center mb-10">
                    <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-gradient-to-r from-violet-500/15 to-fuchsia-500/10 px-3 py-1 text-[11px] uppercase tracking-wider text-violet-200 mb-5">
                        <Sparkles size={12} /> Experimental · Avatar
                    </div>
                    <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.05]">
                        <span className="bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">A face, a voice,</span>
                        <br />
                        <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-pink-300 bg-clip-text text-transparent">a talking-head clip.</span>
                    </h1>
                    <p className="mt-5 text-zinc-400 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
                        Drop a photo, drop an audio file, and Klipra generates a lipsynced video of that person saying those words.
                        Perfect for hooks, intros, and inserts inside your shorts.
                    </p>
                </header>

                {/* Coming-soon honesty banner */}
                <div className="mb-8 rounded-2xl ring-1 ring-amber-400/30 bg-gradient-to-r from-amber-500/10 via-orange-500/5 to-pink-500/10 px-4 py-3 flex items-start gap-3">
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 ring-1 ring-amber-400/40">
                        <Info size={14} className="text-amber-200" />
                    </span>
                    <div className="text-[12.5px] leading-relaxed text-amber-100/90">
                        <strong className="text-amber-100">Heads up — this feature is a preview.</strong>{' '}
                        The reference model (LongCat-Video-Avatar) is CUDA-only and won't run on Apple Silicon yet.
                        The UI is wired up so you can try the flow, but the actual generation step is held back until a
                        Mac-compatible engine (SadTalker / MuseTalk / quantised LongCat) is plugged in.
                    </div>
                </div>

                {/* Two-column inputs */}
                <div className="grid md:grid-cols-2 gap-4 mb-6">
                    {/* Photo dropzone */}
                    <DropCard
                        title="Face photo"
                        subtitle="One person, looking roughly at the camera. JPEG, PNG."
                        icon={<UserCircle2 size={18} className="text-violet-200" />}
                        accent="violet"
                        file={photoFile}
                        previewNode={photoUrl ? (
                            <div className="relative aspect-square w-full overflow-hidden rounded-xl ring-1 ring-white/10 bg-black">
                                <img src={photoUrl} alt="" className="w-full h-full object-cover" />
                                <button
                                    onClick={(e) => { e.stopPropagation(); setPhotoFile(null); setPhotoUrl(''); }}
                                    className="absolute top-2 right-2 rounded-lg p-1 bg-black/60 hover:bg-black/80 text-white ring-1 ring-white/15"
                                    title="Remove"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        ) : null}
                        onFiles={(files) => handlePhoto(files?.[0])}
                        onPick={() => photoInputRef.current?.click()}
                        accept="image/*"
                        inputRef={photoInputRef}
                    />

                    {/* Audio dropzone */}
                    <DropCard
                        title="Audio file"
                        subtitle="What the avatar should say. MP3, WAV, M4A. 5-30 seconds works best."
                        icon={<AudioLines size={18} className="text-fuchsia-200" />}
                        accent="fuchsia"
                        file={audioFile}
                        previewNode={audioUrl ? (
                            <div className="relative w-full rounded-xl ring-1 ring-white/10 bg-black/30 p-3 flex items-center gap-3">
                                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/20 ring-1 ring-fuchsia-400/40">
                                    <Music size={16} className="text-fuchsia-200" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-[12.5px] text-white truncate">{audioFile?.name || 'audio.mp3'}</p>
                                    <audio controls src={audioUrl} className="w-full mt-2 h-9" />
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); setAudioFile(null); setAudioUrl(''); }}
                                    className="rounded-lg p-1 bg-black/60 hover:bg-black/80 text-white ring-1 ring-white/15 self-start"
                                    title="Remove"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        ) : null}
                        onFiles={(files) => handleAudio(files?.[0])}
                        onPick={() => audioInputRef.current?.click()}
                        accept="audio/*"
                        inputRef={audioInputRef}
                    />
                </div>

                {/* Engine + resolution row */}
                <div className="rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/80 to-zinc-950/80 backdrop-blur-md p-4 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20 ring-1 ring-violet-400/40">
                            <Wand2 size={14} className="text-violet-200" />
                        </span>
                        <h3 className="text-[13px] font-semibold text-white tracking-tight">Engine</h3>
                        <span className="text-[11px] text-zinc-500">Pick the model — all currently disabled until the Mac backend ships.</span>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-2 mb-4">
                        {engineOptions.map((opt) => (
                            <button
                                key={opt.id}
                                onClick={() => setEngine(opt.id)}
                                disabled={opt.disabled}
                                title={opt.disabled ? 'Not yet wired up' : ''}
                                className={
                                    'group relative text-left rounded-xl p-3 transition ring-1 ' +
                                    (engine === opt.id
                                        ? 'bg-gradient-to-r from-violet-500/25 to-fuchsia-500/15 ring-violet-400/50 shadow-[0_0_24px_-6px_rgba(167,139,250,0.4)]'
                                        : 'bg-zinc-900/60 ring-white/10 hover:ring-white/20 hover:bg-zinc-900/80') +
                                    (opt.disabled ? ' opacity-65 cursor-not-allowed' : '')
                                }
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[12.5px] font-semibold text-white">{opt.label}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-300 whitespace-nowrap">
                                        {opt.tag}
                                    </span>
                                </div>
                                <p className="mt-1 text-[11.5px] text-zinc-500 leading-snug">{opt.tagline}</p>
                            </button>
                        ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-zinc-500 mr-1">Resolution</span>
                        {['480p', '720p'].map((r) => (
                            <button
                                key={r}
                                onClick={() => setResolution(r)}
                                className={
                                    'rounded-lg px-3 py-1 text-[11.5px] font-medium transition ring-1 ' +
                                    (resolution === r
                                        ? 'bg-gradient-to-r from-violet-500/30 to-fuchsia-500/20 ring-violet-400/40 text-violet-100'
                                        : 'bg-zinc-900/60 ring-white/10 text-zinc-400 hover:text-white hover:bg-white/5')
                                }
                            >
                                {r}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Footer CTA */}
                <div className="rounded-2xl ring-1 ring-white/10 bg-gradient-to-r from-zinc-900/95 to-zinc-950/95 backdrop-blur-md p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <p className="text-[12.5px] text-white font-semibold tracking-tight">
                            {canGenerate ? 'Ready to generate' : 'Drop both a photo and an audio file to continue'}
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                            The actual render is held back until the backend engine is wired up.
                        </p>
                    </div>
                    <button
                        onClick={onGenerateClick}
                        disabled={!canGenerate}
                        className={
                            'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold transition ' +
                            (canGenerate
                                ? 'bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white shadow-[0_8px_28px_-8px_rgba(217,70,239,0.6)] hover:opacity-95'
                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed')
                        }
                    >
                        <Sparkles size={14} />
                        Generate avatar
                    </button>
                </div>

                {/* Cross-link: while this isn't shipped, point them at
                    products that DO produce talking-head-ish content
                    today. */}
                <div className="mt-8 grid sm:grid-cols-2 gap-3">
                    <CrossLinkCard
                        icon={<AudioLines size={14} />}
                        title="Need a dubbed voice now?"
                        body="Voice Dubbing already re-voices any clip into 30+ languages with optional subtitle burn."
                        cta="Open Voice Dubbing"
                        onClick={() => onChooseTab?.('dub')}
                    />
                    <CrossLinkCard
                        icon={<ImageIcon size={14} />}
                        title="Need viral hook overlays?"
                        body="AI Magic Overlays can drop punchy text + zooms on top of any existing clip, face-aware."
                        cta="Open clip editor"
                        onClick={() => onChooseTab?.('dashboard')}
                    />
                </div>
            </div>

            {/* Coming-soon modal */}
            {showComingSoon && (
                <ComingSoonModal
                    photoUrl={photoUrl}
                    audioUrl={audioUrl}
                    engine={engine}
                    onClose={() => setShowComingSoon(false)}
                />
            )}
        </div>
    );
}

/* ---------- subcomponents ---------- */

function DropCard({ title, subtitle, icon, accent, file, previewNode, onFiles, onPick, accept, inputRef }) {
    const [drag, setDrag] = useState(false);
    const ringColor = accent === 'fuchsia'
        ? 'ring-fuchsia-400/40 shadow-[0_0_28px_-8px_rgba(232,121,249,0.5)]'
        : 'ring-violet-400/40 shadow-[0_0_28px_-8px_rgba(167,139,250,0.5)]';
    return (
        <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
                e.preventDefault(); setDrag(false);
                onFiles?.(Array.from(e.dataTransfer?.files || []));
            }}
            onClick={() => !file && onPick?.()}
            className={
                'rounded-2xl ring-1 bg-gradient-to-b from-zinc-900/85 to-zinc-950/85 backdrop-blur-md p-4 transition ' +
                (file ? 'cursor-default ' : 'cursor-pointer hover:bg-zinc-900/95 ') +
                (drag ? ringColor : 'ring-white/10')
            }
        >
            <div className="flex items-center gap-2 mb-3">
                <span className={'inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1 ' + (accent === 'fuchsia' ? 'bg-fuchsia-500/20 ring-fuchsia-400/40' : 'bg-violet-500/20 ring-violet-400/40')}>
                    {icon}
                </span>
                <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-white tracking-tight">{title}</h3>
                    <p className="text-[11px] text-zinc-500 truncate">{subtitle}</p>
                </div>
            </div>
            {previewNode || (
                <div className="rounded-xl ring-1 ring-dashed ring-white/15 bg-black/30 px-4 py-10 text-center">
                    <p className="text-[12px] text-zinc-400">Drop file here, or click to pick.</p>
                </div>
            )}
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                hidden
                onChange={(e) => onFiles?.(Array.from(e.target.files || []))}
            />
        </div>
    );
}

function CrossLinkCard({ icon, title, body, cta, onClick }) {
    return (
        <button
            onClick={onClick}
            className="text-left rounded-2xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900/80 to-zinc-950/80 hover:from-zinc-900 hover:to-zinc-950 backdrop-blur-md p-4 transition group"
        >
            <div className="flex items-center gap-2 mb-1.5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/5 ring-1 ring-white/10 text-zinc-300">
                    {icon}
                </span>
                <h4 className="text-[12.5px] font-semibold text-white tracking-tight">{title}</h4>
            </div>
            <p className="text-[11.5px] text-zinc-400 leading-snug">{body}</p>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-violet-300 group-hover:text-violet-200">
                {cta}
                <ChevronRight size={12} />
            </span>
        </button>
    );
}

function ComingSoonModal({ photoUrl, audioUrl, engine, onClose }) {
    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-md rounded-3xl ring-1 ring-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.85),0_0_60px_-20px_rgba(217,70,239,0.25)] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    className="absolute top-3 right-3 rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 z-10"
                    title="Close"
                >
                    <X size={16} />
                </button>
                <div className="px-6 pt-7 pb-5 text-center">
                    <div className="mx-auto inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 ring-1 ring-violet-400/40 shadow-[0_0_30px_-6px_rgba(167,139,250,0.7)] mb-3">
                        <Clock3 size={26} className="text-violet-100" />
                    </div>
                    <h3 className="text-[16px] font-bold text-white tracking-tight">
                        Engine not ready yet
                    </h3>
                    <p className="mt-2 text-[12.5px] text-zinc-400 leading-relaxed">
                        Your inputs look great, but the avatar engine isn't plugged in yet. The reference model
                        (LongCat-Video-Avatar) needs an NVIDIA GPU we don't have on the Mac. Once a Mac-compatible
                        engine (SadTalker / MuseTalk / quantised LongCat) is wired up, this exact screen will
                        generate the clip.
                    </p>
                </div>

                {photoUrl && audioUrl && (
                    <div className="px-6 pb-5">
                        <div className="rounded-xl ring-1 ring-white/10 bg-black/30 p-3">
                            <p className="text-[10.5px] uppercase tracking-wider text-zinc-500 mb-2">Saved inputs (for when the engine ships)</p>
                            <div className="flex items-center gap-3">
                                <img src={photoUrl} alt="" className="w-12 h-12 rounded-lg ring-1 ring-white/10 object-cover" />
                                <div className="min-w-0 flex-1">
                                    <audio controls src={audioUrl} className="w-full h-8" />
                                    <p className="text-[10px] text-zinc-500 mt-1">Engine: <span className="text-zinc-300">{engine}</span></p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="px-6 pb-6">
                    <button
                        onClick={onClose}
                        className="w-full rounded-xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white text-[13px] font-semibold py-2.5 hover:opacity-95 transition shadow-[0_8px_28px_-8px_rgba(217,70,239,0.6)]"
                    >
                        Got it
                    </button>
                    <p className="text-center text-[10.5px] text-zinc-500 mt-2.5">
                        Klipra will notify you here when the engine goes live.
                    </p>
                </div>
            </div>
        </div>
    );
}
