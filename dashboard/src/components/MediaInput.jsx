import React, { useState, useEffect } from 'react';
import { Youtube, Upload, FileVideo, X, ChevronDown, ChevronUp, FolderOpen } from 'lucide-react';
import { getApiUrl } from '../config';

// Languages we surface in the source-language picker. Picking one forces
// Whisper to transcribe in that language — matters most for Urdu where
// auto-detect commonly mis-fires as Hindi (Devanagari script).
const SOURCE_LANGS = [
    ['ur', 'Urdu'],
    ['hi', 'Hindi'],
    ['ar', 'Arabic'],
    ['fa', 'Persian / Farsi'],
    ['en', 'English'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['tr', 'Turkish'],
    ['id', 'Indonesian'],
    ['ms', 'Malay'],
    ['vi', 'Vietnamese'],
    ['th', 'Thai'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh', 'Chinese'],
    ['nl', 'Dutch'],
    ['pl', 'Polish'],
    ['bn', 'Bengali'],
    ['ta', 'Tamil'],
    ['pa', 'Punjabi'],
];

export default function MediaInput({ onProcess, isProcessing, provider }) {
    const [mode, setMode] = useState('url'); // 'url' | 'file' | 'local'
    const [url, setUrl] = useState('');
    const [file, setFile] = useState(null);
    // LOCAL-FILE MODE — see backend `_resolve_local_media_path`. Hidden
    // unless the server has KLIPRA_LOCAL_MODE=1 set. The user drops a
    // file (or clicks Choose File). We send name + size to the backend's
    // /api/local/find which scans the bind-mounted folders and resolves
    // it to an in-container path. No bytes are uploaded.
    const [localPath, setLocalPath] = useState(
        () => localStorage.getItem('klipra_last_local_path') || ''
    );
    const [localFileName, setLocalFileName] = useState('');  // display only
    const [localFileSize, setLocalFileSize] = useState(0);   // bytes, display only
    // Keep the File object the browser handed us when the user dropped
    // / picked. We never UPLOAD it — just hand it through to the
    // ProcessingAnimation component so it can do URL.createObjectURL
    // for the in-progress preview. Same File object the browser
    // already holds in memory; no extra disk activity, no network.
    const [localFileBlob, setLocalFileBlob] = useState(null);
    const [localResolveStatus, setLocalResolveStatus] = useState('idle');
    // states: idle | resolving | resolved | multiple | not_found | error
    const [localResolveError, setLocalResolveError] = useState('');
    const [localCandidates, setLocalCandidates] = useState([]); // [{path, size}]
    const [localCfg, setLocalCfg] = useState({
        enabled: false,
        roots: [],
        allowed_extensions: [],
        max_size_mb: 0,
    });
    useEffect(() => {
        // One-shot probe — the result rarely changes during a session,
        // and we only need it to decide whether to render the tab.
        fetch(getApiUrl('/api/local/config'))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d) setLocalCfg(d); })
            .catch(() => { /* default = disabled, no harm done */ });
    }, []);

    // RESOLVE A DROPPED FILE → IN-CONTAINER PATH
    //
    // Browsers cannot expose absolute filesystem paths to a webpage,
    // so when the user drops a video we have only `file.name` and
    // `file.size`. The backend's /api/local/find walks the configured
    // KLIPRA_LOCAL_MEDIA_ROOTS looking for files matching that
    // name+size combination — effectively unique on a personal
    // machine. We then auto-fill localPath with the resolved
    // in-container path. Zero bytes are uploaded.
    const resolveLocalFile = async (f) => {
        if (!f) return;
        setLocalFileName(f.name);
        setLocalFileSize(f.size);
        setLocalFileBlob(f);
        setLocalResolveStatus('resolving');
        setLocalResolveError('');
        setLocalCandidates([]);
        setLocalPath('');
        try {
            const params = new URLSearchParams({
                name: f.name,
                size: String(f.size || 0),
            });
            const res = await fetch(getApiUrl(`/api/local/find?${params.toString()}`));
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const matches = Array.isArray(data.matches) ? data.matches : [];
            if (matches.length === 1) {
                setLocalPath(matches[0].path);
                setLocalResolveStatus('resolved');
            } else if (matches.length > 1) {
                setLocalCandidates(matches);
                setLocalResolveStatus('multiple');
            } else {
                setLocalResolveStatus('not_found');
            }
        } catch (e) {
            setLocalResolveStatus('error');
            setLocalResolveError(e.message || String(e));
        }
    };

    const clearLocalFile = () => {
        setLocalFileName('');
        setLocalFileSize(0);
        setLocalFileBlob(null);
        setLocalPath('');
        setLocalCandidates([]);
        setLocalResolveStatus('idle');
        setLocalResolveError('');
    };

    // Clip-selection options. Persist last-used values so the user doesn't
    // have to re-set sliders on every job.
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [minClips, setMinClips] = useState(() => +(localStorage.getItem('os_min_clips') || 3));
    const [maxClips, setMaxClips] = useState(() => +(localStorage.getItem('os_max_clips') || 8));
    const [minDur, setMinDur] = useState(() => +(localStorage.getItem('os_min_dur') || 20));
    const [maxDur, setMaxDur] = useState(() => +(localStorage.getItem('os_max_dur') || 60));

    // Whisper speed picker is gone — backend always uses large-v3-turbo
    // now (same accuracy as Large-v3 but ~8× faster, so the old
    // Fast/Balanced/Best tradeoff doesn't exist anymore).
    const [transcriptLang, setTranscriptLang] = useState(
        () => localStorage.getItem('os_transcript_lang') || ''
    );
    const [transcriptScript, setTranscriptScript] = useState(
        () => localStorage.getItem('os_transcript_script') || 'auto'
    );
    // Stage-1 engine: 'whisper' (default, free, local) or 'elevenlabs'
    // (paid, requires ElevenLabs key — same key the dub feature uses).
    const [transcribeProvider, setTranscribeProvider] = useState(
        () => localStorage.getItem('os_transcribe_provider') || 'whisper'
    );
    // Pause-for-manual-cleanup: after transcription, stop and let the user
    // clean the transcript in an external AI (aistudio.google.com), then
    // proceed. Defaults ON ONLY when the selected AI provider is
    // gemini-subscription (whose cookie auth is flaky for long runs);
    // optional + default OFF for every other provider (Ollama, Gemini API
    // key, OpenAI, …). The live provider is passed in as a prop so this
    // re-evaluates whenever the user switches models in the picker.
    const _liveProvider = () => {
        if (provider) return provider;
        try { return JSON.parse(localStorage.getItem('os_llm_pref_last') || '{}')?.provider; }
        catch { return undefined; }
    };
    const [pauseForCleanup, setPauseForCleanup] = useState(() => _liveProvider() === 'gemini-subscription');
    // Track whether the user manually toggled the checkbox. Until they do, we
    // keep the default in sync with the selected provider (ON for the
    // subscription, OFF otherwise) — that's the bug fix: previously the value
    // was frozen at mount, so switching from the default gemini-subscription
    // to a Gemini API key still paused. Once the user touches it, respect them.
    const [pauseTouched, setPauseTouched] = useState(false);
    React.useEffect(() => {
        if (!pauseTouched) setPauseForCleanup((provider || _liveProvider()) === 'gemini-subscription');
    }, [provider, pauseTouched]); // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect(() => {
        localStorage.setItem('os_min_clips', String(minClips));
        localStorage.setItem('os_max_clips', String(maxClips));
        localStorage.setItem('os_min_dur', String(minDur));
        localStorage.setItem('os_max_dur', String(maxDur));
        localStorage.setItem('os_transcript_lang', transcriptLang);
        localStorage.setItem('os_transcript_script', transcriptScript);
        localStorage.setItem('os_transcribe_provider', transcribeProvider);
    }, [minClips, maxClips, minDur, maxDur, transcriptLang, transcriptScript, transcribeProvider]);

    const clipOptions = {
        minClips, maxClips, minDur, maxDur,
        transcriptLang, transcriptScript, transcribeProvider,
        pauseForCleanup,
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (mode === 'url' && url) {
            onProcess({ type: 'url', payload: url, options: clipOptions });
        } else if (mode === 'file' && file) {
            onProcess({ type: 'file', payload: file, options: clipOptions });
        } else if (mode === 'local' && localPath.trim()) {
            // Persist last-used path so the user doesn't retype it on
            // every clip job. Backend validates the path on submit and
            // returns a clear error if the file moved or got deleted.
            localStorage.setItem('klipra_last_local_path', localPath.trim());
            // Hand the in-memory File along too so the in-progress
            // preview can play the video without uploading. The
            // backend never sees `previewBlob` — only `payload` (the
            // path string) goes over the wire.
            onProcess({
                type: 'local',
                payload: localPath.trim(),
                previewBlob: localFileBlob,
                options: clipOptions,
            });
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
            setMode('file');
        }
    };

    return (
        <div className="bg-surface border border-white/5 rounded-2xl p-6 animate-[fadeIn_0.6s_ease-out]">
            <div className="flex gap-4 mb-6 border-b border-white/5 pb-4">
                <button
                    onClick={() => setMode('url')}
                    className={`flex items-center gap-2 pb-2 px-2 transition-all ${mode === 'url'
                        ? 'text-primary border-b-2 border-primary -mb-[17px]'
                        : 'text-zinc-400 hover:text-white'
                        }`}
                >
                    <Youtube size={18} />
                    YouTube URL
                </button>
                <button
                    onClick={() => setMode('file')}
                    className={`flex items-center gap-2 pb-2 px-2 transition-all ${mode === 'file'
                        ? 'text-primary border-b-2 border-primary -mb-[17px]'
                        : 'text-zinc-400 hover:text-white'
                        }`}
                >
                    <Upload size={18} />
                    Upload File
                </button>
                {/* LOCAL-FILE TAB — only rendered when the server has
                    opted into KLIPRA_LOCAL_MODE. The server-side
                    allowlist (KLIPRA_LOCAL_MEDIA_ROOTS) prevents path
                    traversal, but we ALSO hide the UI in production
                    deployments so users don't get a confusing 403. */}
                {localCfg.enabled && (
                    <button
                        onClick={() => setMode('local')}
                        className={`flex items-center gap-2 pb-2 px-2 transition-all ${mode === 'local'
                            ? 'text-primary border-b-2 border-primary -mb-[17px]'
                            : 'text-zinc-400 hover:text-white'
                            }`}
                    >
                        <FolderOpen size={18} />
                        Use file from disk
                    </button>
                )}
            </div>

            <form onSubmit={handleSubmit}>
                {mode === 'url' && (
                    <div className="space-y-4">
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://www.youtube.com/watch?v=..."
                            className="input-field"
                            required
                        />
                    </div>
                )}
                {mode === 'file' && (
                    <div
                        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${file ? 'border-primary/50 bg-primary/5' : 'border-zinc-700 hover:border-zinc-500 bg-white/5'
                            }`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {file ? (
                            <div className="flex items-center justify-center gap-3 text-white">
                                <FileVideo className="text-primary" />
                                <span className="font-medium">{file.name}</span>
                                <button
                                    type="button"
                                    onClick={() => setFile(null)}
                                    className="p-1 hover:bg-white/10 rounded-full"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        ) : (
                            <label className="cursor-pointer block">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                                    className="hidden"
                                />
                                <Upload className="mx-auto mb-3 text-zinc-500" size={24} />
                                <p className="text-zinc-400">Click to upload or drag and drop</p>
                                <p className="text-xs text-zinc-600 mt-1">MP4, MOV, MKV up to 5 GB</p>
                            </label>
                        )}
                    </div>
                )}
                {mode === 'local' && (
                    <div className="space-y-2">
                        {/* DRAG-DROP / PICKER ZONE — same visual shape as
                            the Upload File tab so it feels familiar. The
                            underlying mechanic is different though: we
                            never read the bytes. We only extract name +
                            size and ask the backend to resolve them to
                            an in-container path. */}
                        <div
                            className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                                localResolveStatus === 'resolved'
                                    ? 'border-emerald-500/60 bg-emerald-500/5'
                                    : localResolveStatus === 'not_found' || localResolveStatus === 'error'
                                        ? 'border-amber-500/50 bg-amber-500/5'
                                        : localFileName
                                            ? 'border-primary/50 bg-primary/5'
                                            : 'border-zinc-700 hover:border-zinc-500 bg-white/5'
                            }`}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                const f = e.dataTransfer?.files?.[0];
                                if (f) resolveLocalFile(f);
                            }}
                        >
                            {localFileName ? (
                                <div className="space-y-2">
                                    <div className="flex items-center justify-center gap-3 text-white">
                                        <FileVideo className="text-primary shrink-0" size={20} />
                                        <span className="font-medium truncate max-w-[26rem]">{localFileName}</span>
                                        <button
                                            type="button"
                                            onClick={clearLocalFile}
                                            className="p-1 hover:bg-white/10 rounded-full shrink-0"
                                            title="Clear and pick another file"
                                        >
                                            <X size={16} />
                                        </button>
                                    </div>
                                    <div className="text-[11px] text-zinc-500">
                                        {(localFileSize / (1024 * 1024)).toFixed(1)} MB
                                    </div>
                                    {localResolveStatus === 'resolving' && (
                                        <div className="text-[11px] text-zinc-400 mt-1">
                                            Locating file in allowed folders…
                                        </div>
                                    )}
                                    {localResolveStatus === 'resolved' && (
                                        <div className="text-[11px] text-emerald-300 mt-1">
                                            ✓ Found at <code className="bg-black/30 px-1 rounded">{localPath}</code>
                                        </div>
                                    )}
                                    {localResolveStatus === 'multiple' && (
                                        <div className="space-y-1.5 mt-2 text-left">
                                            <div className="text-[11px] text-zinc-400">
                                                Multiple matches — pick one:
                                            </div>
                                            <div className="space-y-1">
                                                {localCandidates.map((c) => (
                                                    <button
                                                        key={c.path}
                                                        type="button"
                                                        onClick={() => {
                                                            setLocalPath(c.path);
                                                            setLocalResolveStatus('resolved');
                                                        }}
                                                        className={
                                                            'block w-full text-left text-[11px] font-mono px-2.5 py-1.5 rounded border transition '
                                                            + (localPath === c.path
                                                                ? 'border-primary/60 bg-primary/10 text-white'
                                                                : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                                                        }
                                                    >
                                                        {c.path}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {localResolveStatus === 'not_found' && (
                                        <div className="text-[11px] text-amber-300 mt-1 leading-snug">
                                            Couldn't find <code className="bg-black/30 px-1 rounded">{localFileName}</code> in any allowed folder.
                                            <br />
                                            Move or copy this file into{' '}
                                            <code className="bg-black/30 px-1 rounded">~/Desktop/Movies</code>
                                            {' '}on your Mac, then drop it here again.
                                        </div>
                                    )}
                                    {localResolveStatus === 'error' && (
                                        <div className="text-[11px] text-amber-300 mt-1">
                                            Lookup failed: {localResolveError}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <label className="cursor-pointer block">
                                    <input
                                        type="file"
                                        accept="video/*,audio/*"
                                        onChange={(e) => {
                                            const f = e.target.files?.[0];
                                            if (f) resolveLocalFile(f);
                                        }}
                                        className="hidden"
                                    />
                                    <FolderOpen className="mx-auto mb-3 text-zinc-500" size={24} />
                                    <p className="text-zinc-300 font-medium">Drop your video here, or click to choose</p>
                                    <p className="text-[11px] text-zinc-500 mt-1.5 leading-snug">
                                        No upload — Klipra reads the file directly from disk.
                                    </p>
                                </label>
                            )}
                        </div>
                        {localCfg.roots.length > 0 ? (
                            <div className="text-[10px] text-zinc-500 leading-snug">
                                Files must live inside{' '}
                                {localCfg.roots.map((r, i) => (
                                    <span key={r}>
                                        <code className="text-zinc-300 bg-black/40 px-1 rounded">{r}</code>
                                        {i < localCfg.roots.length - 1 ? ' or ' : ''}
                                    </span>
                                ))}
                                {' '}(your <code className="text-zinc-300 bg-black/40 px-1 rounded">~/Desktop/Movies</code> on Mac).
                            </div>
                        ) : (
                            <div className="text-[10px] text-amber-300/80 leading-snug">
                                No KLIPRA_LOCAL_MEDIA_ROOTS configured on the server.
                            </div>
                        )}
                    </div>
                )}

                {/* --- Advanced options --- */}
                <div className="mt-4 rounded-xl border border-white/5 bg-black/20">
                    <button
                        type="button"
                        onClick={() => setAdvancedOpen((v) => !v)}
                        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-zinc-300 hover:text-white"
                    >
                        <span className="flex items-center gap-2 font-medium">
                            Options
                            <span className="text-[11px] text-zinc-500">
                                {minClips}–{maxClips} clips · {minDur}–{maxDur}s
                                {transcriptScript === 'roman' ? ' · Roman' : ''}
                                {transcriptLang ? ` · ${transcriptLang.toUpperCase()}` : ''}
                            </span>
                        </span>
                        {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {advancedOpen && (
                        <div className="border-t border-white/5 p-4 space-y-5">

                            {/* --- Transcription --- */}
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                                    Stage 1 · Transcription
                                </div>

                                {/* Two engines:
                                      • Whisper Turbo — free, runs locally, Klipra default.
                                      • ElevenLabs Scribe — paid, ~$0.40/hr, top accuracy
                                        especially on noisy / multilingual / accented audio.
                                        Uses the same key as the Dub feature (Settings page). */}
                                <label className="block text-xs text-zinc-400 mb-1.5">
                                    Transcription engine
                                </label>
                                <div className="grid grid-cols-2 gap-1.5 mb-4">
                                    <button
                                        type="button"
                                        onClick={() => setTranscribeProvider('whisper')}
                                        className={
                                            'rounded-md border px-2.5 py-2 text-left transition ' +
                                            (transcribeProvider === 'whisper'
                                                ? 'border-primary/60 bg-primary/10 text-white'
                                                : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                                        }
                                    >
                                        <div className="text-xs font-medium">Whisper Turbo</div>
                                        <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">Free · runs locally · default</div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setTranscribeProvider('elevenlabs')}
                                        className={
                                            'rounded-md border px-2.5 py-2 text-left transition ' +
                                            (transcribeProvider === 'elevenlabs'
                                                ? 'border-emerald-500/60 bg-emerald-500/10 text-white'
                                                : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                                        }
                                    >
                                        <div className="text-xs font-medium">ElevenLabs Scribe</div>
                                        <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">Paid · ~$0.40/hr · pro accuracy</div>
                                    </button>
                                </div>
                                {transcribeProvider === 'elevenlabs' && (
                                    <p className="-mt-2 mb-3 text-[10px] text-amber-200/80 leading-relaxed">
                                        Requires an ElevenLabs API key (Settings → Social Integration). Falls back to Whisper Turbo automatically if the key is missing or rate-limited.
                                    </p>
                                )}

                                {/* Source language picker */}
                                <label className="block text-xs text-zinc-400 mb-1.5">
                                    Source language
                                    <span className="text-zinc-600">
                                        {' '}— forces Whisper. Leave on Auto-detect if unsure.
                                    </span>
                                </label>
                                <select
                                    value={transcriptLang}
                                    onChange={(e) => setTranscriptLang(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white mb-4 focus:outline-none focus:border-primary/50"
                                >
                                    <option value="">Auto-detect</option>
                                    {SOURCE_LANGS.map(([code, name]) => (
                                        <option key={code} value={code}>{name}</option>
                                    ))}
                                </select>

                                {/* Script picker */}
                                <label className="block text-xs text-zinc-400 mb-1.5">
                                    Transcript script
                                </label>
                                <div className="grid grid-cols-2 gap-1.5">
                                    {[
                                        ['auto',  'Original', 'Devanagari, Arabic, etc.'],
                                        ['roman', 'Roman',    'Roman Urdu / Hinglish / Latin letters'],
                                    ].map(([v, label, hint]) => (
                                        <button
                                            key={v}
                                            type="button"
                                            onClick={() => setTranscriptScript(v)}
                                            title={hint}
                                            className={
                                                'rounded-md border px-2.5 py-2 text-left transition ' +
                                                (transcriptScript === v
                                                    ? 'border-primary/60 bg-primary/10 text-white'
                                                    : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                                            }
                                        >
                                            <div className="text-xs font-medium">{label}</div>
                                            <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">{hint}</div>
                                        </button>
                                    ))}
                                </div>
                                {transcriptScript === 'roman' && (
                                    <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                                        After transcription, an LLM rewrites the transcript in
                                        Roman/Latin letters before clips are picked. Costs one
                                        small extra LLM call. Skipped automatically when the
                                        detected language is already Latin script.
                                    </p>
                                )}

                                {/* Pause for manual transcript cleanup (external AI) */}
                                <label className="mt-3 flex items-start gap-2.5 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={pauseForCleanup}
                                        onChange={(e) => { setPauseTouched(true); setPauseForCleanup(e.target.checked); }}
                                        className="mt-0.5 h-4 w-4 accent-cyan-400 cursor-pointer"
                                    />
                                    <span className="flex-1">
                                        <span className="text-xs font-medium text-zinc-200">
                                            Pause for manual transcript cleanup
                                        </span>
                                        <span className="block text-[10px] text-zinc-500 leading-snug mt-0.5">
                                            After transcription, stop and let you clean the transcript in an
                                            external AI (Google AI Studio / Gemini), then paste it back and
                                            continue. Recommended when using the Gemini Subscription model.
                                        </span>
                                    </span>
                                </label>
                            </div>

                            {/* --- Clip selection --- */}
                            <div>
                                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                                    Clip selection
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <SliderRow label="Min clips" value={minClips} min={1} max={20}
                                               onChange={(v) => { setMinClips(v); if (v > maxClips) setMaxClips(v); }} />
                                    <SliderRow label="Max clips" value={maxClips} min={1} max={30}
                                               onChange={(v) => { setMaxClips(v); if (v < minClips) setMinClips(v); }} />
                                    <SliderRow label="Min duration" value={minDur} min={5} max={120} unit="s"
                                               onChange={(v) => { setMinDur(v); if (v > maxDur) setMaxDur(v); }} />
                                    <SliderRow label="Max duration" value={maxDur} min={10} max={300} unit="s"
                                               onChange={(v) => { setMaxDur(v); if (v < minDur) setMinDur(v); }} />
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <button
                    type="submit"
                    disabled={
                        isProcessing
                        || (mode === 'url' && !url)
                        || (mode === 'file' && !file)
                        // Local mode: enable as soon as a path is known —
                        // either auto-resolved from a drop ('resolved')
                        // or chosen from the multi-match picker
                        // (localPath is set, status='resolved').
                        || (mode === 'local' && (!localPath.trim() || localResolveStatus === 'resolving'))
                    }
                    className="w-full btn-primary mt-6 flex items-center justify-center gap-2"
                >
                    {isProcessing ? (
                        <>
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Processing Video...
                        </>
                    ) : (
                        <>
                            Generate Clips
                        </>
                    )}
                </button>
            </form>
        </div>
    );
}

function SliderRow({ label, value, min, max, onChange, unit = '' }) {
    return (
        <label className="block text-xs">
            <div className="mb-1 flex items-baseline justify-between text-zinc-400">
                <span>{label}</span>
                <span className="tabular-nums text-zinc-200 font-medium">{value}{unit}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                value={value}
                onChange={(e) => onChange(+e.target.value)}
                className="w-full accent-primary"
            />
        </label>
    );
}
