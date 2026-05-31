import React, { useState, useRef, useEffect } from 'react';
import { Upload, Languages, Loader2, Download, RotateCcw, Lightbulb, Check, AlertCircle, ChevronLeft, X, Sparkles } from 'lucide-react';
import { getApiUrl } from '../config';
import StandalonePastList from './StandalonePastList';
import ProcessingPreview from './ProcessingPreview';
import StandaloneReframeKeyframeModal from './StandaloneReframeKeyframeModal';

// Pipeline stages emitted by the backend's /api/standalone/dub job.
// Drives the checklist in ProcessingPreview while the dub runs.
const DUB_STEPS = [
    { id: 'queued', label: 'Queued' },
    { id: 'transcribing', label: 'Transcribing audio' },
    { id: 'translating', label: 'AI translation' },
    { id: 'rendering', label: 'Synthesizing voice & muxing' },
];

/**
 * Standalone "Dub a whole video into another language" feature.
 *
 * Same Stage 1 / Stage 2 pipeline as the rest of Klipra, plus a
 * Stage 3 voice synthesis step:
 *   1. Transcribe (Whisper Turbo or ElevenLabs Scribe).
 *   2. AI translate WITH FULL-CLIP CONTEXT — so the LLM fixes Whisper
 *      mishears before translating ("trail" in a trading video → "trade"
 *      → translated correctly).
 *   3. Voice synthesis: free Microsoft Edge TTS in 21 languages, or
 *      ElevenLabs voice cloning if the user has a key. Mux onto video.
 *
 * Whole-video flow — not per-clip. User uploads, picks target language,
 * gets a single dubbed file back.
 */
const SOURCE_LANGS = [
    ['', 'Auto-detect'], ['en', 'English'], ['ur', 'Urdu'], ['hi', 'Hindi'],
    ['ar', 'Arabic'], ['fa', 'Persian'], ['es', 'Spanish'], ['fr', 'French'],
    ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['tr', 'Turkish'],
];
const TARGET_LANGS = [
    ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
    ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['hi', 'Hindi'],
    ['ur', 'Urdu'], ['ar', 'Arabic'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['zh', 'Chinese'], ['tr', 'Turkish'], ['nl', 'Dutch'], ['sv', 'Swedish'],
    ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['pl', 'Polish'],
];

export default function StandaloneDub({ llmHeaders, elevenLabsKey, homeBump = 0 }) {
    const fileInputRef = useRef(null);
    const [file, setFile] = useState(null);
    // URL ingest path. yt-dlp downloads server-side from any public
    // social platform.
    const [url, setUrl] = useState('');
    const [transcribeProvider, setTranscribeProvider] = useState('whisper');
    const [sourceLang, setSourceLang] = useState('');
    const [targetLang, setTargetLang] = useState('en');
    const [dubProvider, setDubProvider] = useState(elevenLabsKey ? 'elevenlabs' : 'edge');
    const [voiceGender, setVoiceGender] = useState('auto');
    const [keepOriginal, setKeepOriginal] = useState(false);
    const [originalVolume, setOriginalVolume] = useState(0.2);
    // Output aspect. 'original' keeps the source aspect (default).
    // 'vertical' / 'horizontal' crops to 9:16 / 16:9 respectively,
    // with manual reframe via crop offsets when the auto-centre isn't
    // on the right part of the frame.
    const [outputOrientation, setOutputOrientation] = useState('original');
    const [cropXOffsetPct, setCropXOffsetPct] = useState(50);
    const [cropYOffsetPct, setCropYOffsetPct] = useState(50);
    // When true, after the dub renders the backend ALSO transcribes the
    // dubbed audio (in the target language) and burns matching captions
    // onto the output video. One-step "Spanish dub + Spanish captions".
    const [burnSubtitlesInTargetLang, setBurnSubtitlesInTargetLang] = useState(false);

    // Subtitle styling — same shape as Auto Subtitle's Phase 2 state
    // so users get the SAME controls inside Dubbing they already know.
    const [subFontName, setSubFontName] = useState('Verdana');
    const [subFontSize, setSubFontSize] = useState(32);
    const [subFontColor, setSubFontColor] = useState('#FFFFFF');
    const [subBorderColor, setSubBorderColor] = useState('#000000');
    const [subBorderWidth, setSubBorderWidth] = useState(2);
    const [subBgColor, setSubBgColor] = useState('#000000');
    const [subBgOpacity, setSubBgOpacity] = useState(0.0);
    const [subPositionPct, setSubPositionPct] = useState(85);

    // Keyframed crop for the dub video orientation. Same shape as the
    // Auto Subtitle keyframes — list of {t,x,y,cut}. Empty = use the
    // static cropX/Y sliders. Modal flag is local UI state.
    const [dubCropKeyframes, setDubCropKeyframes] = useState([]);
    const [dubReframeModalOpen, setDubReframeModalOpen] = useState(false);

    const [jobId, setJobId] = useState(null);
    const [status, setStatus] = useState('idle');
    const [logs, setLogs] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    // When the user clicks "Dub →" on a past project card, this holds
    // the source job we'll re-dub from. Non-null means the modal is open.
    const [redubSourceJob, setRedubSourceJob] = useState(null);
    const [redubTargetLang, setRedubTargetLang] = useState('en');
    const [redubBusy, setRedubBusy] = useState(false);
    // Errors from submitRedub get rendered INSIDE the modal so the user
    // sees them. The page-level `error` state is hidden behind the
    // modal backdrop and was the reason "Generate dub" appeared to do
    // nothing — the request was failing but the error was off-screen.
    const [redubError, setRedubError] = useState(null);
    // Spinner flag for the result-panel "Add subtitles" button.
    const [addingSubsBusy, setAddingSubsBusy] = useState(false);
    // Inline error for the "Add subtitles" action — rendered ON the
    // result panel so failures aren't silenced behind a hidden form.
    const [addingSubsError, setAddingSubsError] = useState(null);
    // Modal flag for the result-panel "Add subtitles" action. When the
    // user clicks the button we now open a styling modal first so they
    // can pick font / colour / background / position before the burn
    // fires — instead of silently using the page-level defaults.
    const [addSubsModalOpen, setAddSubsModalOpen] = useState(false);

    // Source-video preview URL — same three-case rule as the Subtitle
    // page. File upload → blob URL. URL ingest with a known job_id →
    // server-streamed source. Otherwise null.
    const [localPreviewUrl, setLocalPreviewUrl] = useState(null);
    useEffect(() => {
        if (file) {
            const u = URL.createObjectURL(file);
            setLocalPreviewUrl(u);
            return () => URL.revokeObjectURL(u);
        }
        if (jobId) {
            setLocalPreviewUrl(getApiUrl(`/api/standalone/${jobId}/source-video`));
            return;
        }
        setLocalPreviewUrl(null);
    }, [file, jobId]);

    useEffect(() => {
        if (!jobId || status === 'completed' || status === 'failed') return;
        const id = setInterval(async () => {
            try {
                const r = await fetch(getApiUrl(`/api/standalone/status/${jobId}`));
                if (!r.ok) return;
                const data = await r.json();
                setStatus(data.status);
                setLogs(data.logs || []);
                // Surface the actual backend error rather than the
                // generic placeholder when the pipeline fails. The
                // backend writes the exception summary as the last
                // log line on failure.
                if (data.status === 'failed') {
                    const last = (data.logs || []).slice().reverse()
                        .find((line) => /error|fail/i.test(line || ''));
                    setError(last || (data.logs && data.logs[data.logs.length - 1]) || 'Pipeline failed without an error message — check Docker logs.');
                }
                if (data.result) setResult(data.result);
            } catch { /* keep polling */ }
        }, 2000);
        return () => clearInterval(id);
    }, [jobId, status]);

    const reset = () => {
        setJobId(null);
        setStatus('idle');
        setLogs([]);
        setResult(null);
        setError(null);
        setFile(null);
        setUrl('');
    };

    // Header re-click → reset to home. App.jsx increments `homeBump`
    // each time the user clicks the Voice Dubbing tab while it's
    // already active, signaling "take me back to the upload screen".
    // Initial mount has bump=0 which we ignore to avoid wiping any
    // restored session state on first render.
    useEffect(() => {
        if (homeBump > 0) {
            reset();
            try { localStorage.removeItem('klipra_dub_active_job'); } catch {}
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [homeBump]);

    // Persist the active jobId so a browser refresh doesn't lose
    // the connection to a still-running dub. Same logic as the
    // subtitle page — backend keeps running, frontend reattaches.
    useEffect(() => {
        const TERMINAL = ['idle', 'completed', 'failed'];
        try {
            if (jobId && !TERMINAL.includes(status)) {
                localStorage.setItem(
                    'klipra_dub_active_job',
                    JSON.stringify({ jobId, status, savedAt: Date.now() }),
                );
            } else {
                localStorage.removeItem('klipra_dub_active_job');
            }
        } catch {}
    }, [jobId, status]);

    // Restore an active dub on mount. If the user refreshed while a
    // dub was running, this re-attaches polling so they don't have to
    // fish through Past Projects to find their job.
    useEffect(() => {
        try {
            const raw = localStorage.getItem('klipra_dub_active_job');
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (!saved?.jobId) return;
            const ageMs = Date.now() - (saved.savedAt || 0);
            if (ageMs > 24 * 3600 * 1000) {
                localStorage.removeItem('klipra_dub_active_job');
                return;
            }
            (async () => {
                try {
                    const r = await fetch(getApiUrl(`/api/standalone/status/${saved.jobId}`));
                    if (!r.ok) {
                        localStorage.removeItem('klipra_dub_active_job');
                        return;
                    }
                    const data = await r.json();
                    if (data.kind && data.kind !== 'dub') return;
                    setJobId(saved.jobId);
                    setStatus(data.status || 'queued');
                    setLogs(data.logs || []);
                    if (data.result) setResult(data.result);
                    if (data.status === 'failed') {
                        const last = (data.logs || []).slice().reverse()
                            .find((line) => /error|fail/i.test(line || ''));
                        setError(last || 'Job ended in failure while you were away.');
                    }
                } catch { /* leave for next attempt */ }
            })();
        } catch {}
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Cross-product handoff from Auto Subtitle. When the user clicks
    // "Dub voice" on a finished subtitle, that page stashes the source
    // job_id under `klipra_redub_target` and switches to this tab. We
    // pick the message up here, fetch enough info about the source to
    // populate the redub modal, then clear the key so a refresh
    // doesn't keep re-opening the modal.
    useEffect(() => {
        let cancelled = false;
        try {
            const raw = localStorage.getItem('klipra_redub_target');
            if (!raw) return undefined;
            const saved = JSON.parse(raw);
            // Stale (older than 5 minutes) — drop it. Avoids the modal
            // popping open days later if the user never came back.
            const ageMs = Date.now() - (saved?.savedAt || 0);
            if (!saved?.source_job_id || ageMs > 5 * 60 * 1000) {
                localStorage.removeItem('klipra_redub_target');
                return undefined;
            }
            (async () => {
                try {
                    const r = await fetch(getApiUrl(`/api/standalone/status/${saved.source_job_id}`));
                    if (!r.ok || cancelled) return;
                    const data = await r.json();
                    if (cancelled) return;
                    // Build a job-shaped object the redub modal expects.
                    setRedubSourceJob({
                        job_id: saved.source_job_id,
                        title: saved.title || (data.result?.transcript_text || 'Saved video').slice(0, 80),
                        language: (data.result?.language || data.result?.target_language || '').toLowerCase(),
                    });
                    setRedubError(null);
                    setRedubTargetLang('en');
                } finally {
                    try { localStorage.removeItem('klipra_redub_target'); } catch {}
                }
            })();
        } catch {
            try { localStorage.removeItem('klipra_redub_target'); } catch {}
        }
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Open a saved past Dub project — jump straight to the result panel
    // so the user can replay / download the previously dubbed video without
    // re-running the pipeline.
    const openPastJob = (job) => {
        if (!job?.video_url) return;
        setJobId(job.job_id);
        setStatus('completed');
        setResult({ video_url: job.video_url, target_language: job.language });
        setError(null);
    };

    // Submit a redub from a completed past project. Reuses the source
    // job's saved transcript so the user skips the slow Whisper pass.
    // Carries over the CURRENT page's voice / orientation settings as
    // the new dub's preferences — that way the user can pre-set the
    // voice / orientation on this page, then redub past projects with
    // those settings without re-touching them in the modal.
    // Result-panel "Dub in another language" — opens the redub modal
    // pre-targeted at the just-finished job. Same modal Past Projects
    // uses, so the styling and submit flow are identical.
    const dubAnotherFromResult = () => {
        if (!jobId || !result) return;
        const targetLang = (result.target_language || '').toLowerCase();
        setRedubSourceJob({
            job_id: jobId,
            title: (result.translated_text || '').slice(0, 80) || 'this dub',
            language: targetLang,
        });
        setRedubError(null);
        setRedubTargetLang(targetLang && targetLang !== 'en' ? 'en' : 'es');
    };

    // Result-panel "Add subtitles" — calls the burn-on-existing endpoint.
    // Uses the page's CURRENT subtitle styling state (defaults if user
    // never customised). Switches the view back to the running state so
    // the existing polling effect tracks progress for the user.
    const addSubtitlesFromResult = async () => {
        // eslint-disable-next-line no-console
        console.log('[add-subtitles] click', { jobId, hasResult: !!result });
        if (!jobId) {
            setAddingSubsError('No active dub to add subtitles to.');
            return;
        }
        setAddingSubsBusy(true);
        setAddingSubsError(null);
        setError(null);
        try {
            const res = await fetch(
                getApiUrl(`/api/standalone/dub/${jobId}/burn-subtitles`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        subtitle_font_name: subFontName,
                        subtitle_font_size: subFontSize,
                        subtitle_font_color: subFontColor,
                        subtitle_border_color: subBorderColor,
                        subtitle_border_width: subBorderWidth,
                        subtitle_bg_color: subBgColor,
                        subtitle_bg_opacity: subBgOpacity,
                        subtitle_position_pct: subPositionPct,
                    }),
                },
            );
            // eslint-disable-next-line no-console
            console.log('[add-subtitles] response', res.status, res.statusText);
            if (!res.ok) {
                let detail = '';
                try {
                    const errBody = await res.json();
                    detail = errBody?.detail || JSON.stringify(errBody);
                } catch {
                    try { detail = await res.text(); } catch { /* */ }
                }
                throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
            }
            // Switch the view back to running. The polling effect will
            // pick up the new status (rendering -> completed) and swap
            // result.video_url to the subtitled mp4 when done.
            setStatus('rendering');
            setResult(null);
            setLogs(['Adding subtitles to existing dub…']);
            setAddSubsModalOpen(false);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[add-subtitles] failed', e);
            const msg = e.message || String(e);
            // Render inline on the result panel — page-level error state
            // is hidden behind the result view so the old setError(...)
            // path was effectively silent.
            setAddingSubsError(
                msg.includes('404')
                    ? `${msg} — Looks like the backend may not have been restarted after the last update. Try: docker compose restart backend`
                    : msg,
            );
        } finally {
            setAddingSubsBusy(false);
        }
    };

    const submitRedub = async () => {
        // eslint-disable-next-line no-console
        console.log('[redub] submit clicked', {
            source: redubSourceJob?.job_id, target: redubTargetLang,
            provider: dubProvider, voice: voiceGender,
        });
        if (!redubSourceJob || !redubTargetLang) {
            setRedubError('Pick a target language first.');
            return;
        }
        if (dubProvider === 'elevenlabs' && !elevenLabsKey) {
            setRedubError('ElevenLabs voice cloning needs an API key. Close this modal and switch to Edge TTS, or add the key in Settings.');
            return;
        }
        setRedubBusy(true);
        setRedubError(null);
        setError(null);
        try {
            const res = await fetch(getApiUrl('/api/standalone/dub/redub'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(llmHeaders || {}),
                    ...(elevenLabsKey ? { 'X-ElevenLabs-Key': elevenLabsKey } : {}),
                },
                body: JSON.stringify({
                    source_job_id: redubSourceJob.job_id,
                    target_language: redubTargetLang,
                    dub_provider: dubProvider,
                    voice_gender: voiceGender,
                    keep_original: keepOriginal,
                    original_volume: originalVolume,
                    output_orientation: outputOrientation,
                    crop_x_offset_pct: cropXOffsetPct,
                    crop_y_offset_pct: cropYOffsetPct,
                    crop_keyframes: dubCropKeyframes.length ? dubCropKeyframes : null,
                    burn_subtitles_in_target_lang: burnSubtitlesInTargetLang,
                    subtitle_font_name: subFontName,
                    subtitle_font_size: subFontSize,
                    subtitle_font_color: subFontColor,
                    subtitle_border_color: subBorderColor,
                    subtitle_border_width: subBorderWidth,
                    subtitle_bg_color: subBgColor,
                    subtitle_bg_opacity: subBgOpacity,
                    subtitle_position_pct: subPositionPct,
                }),
            });
            // eslint-disable-next-line no-console
            console.log('[redub] response', res.status, res.statusText);
            if (!res.ok) {
                // Try to surface the backend's HTTPException detail —
                // FastAPI returns it as { detail: "..." } in JSON. Fall
                // back to plain text if the body isn't JSON.
                let detail = '';
                try {
                    const errBody = await res.json();
                    detail = errBody?.detail || JSON.stringify(errBody);
                } catch {
                    try { detail = await res.text(); } catch { detail = ''; }
                }
                throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
            }
            const data = await res.json();
            // eslint-disable-next-line no-console
            console.log('[redub] success, new job_id =', data.job_id);
            // Switch into the running view so the existing polling
            // effect picks up the new job and surfaces progress to
            // the user. We start at 'translating' because the redub
            // path skips transcription.
            setJobId(data.job_id);
            setStatus('translating');
            setLogs(['Re-using saved transcript — no Whisper pass.']);
            setRedubSourceJob(null);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[redub] failed', e);
            setRedubError(e.message || String(e));
        } finally {
            setRedubBusy(false);
        }
    };

    const submit = async () => {
        if (!file && !(url || '').trim()) {
            setError('Pick a video file or paste a video link first.');
            return;
        }
        if (dubProvider === 'elevenlabs' && !elevenLabsKey) {
            setError('ElevenLabs voice cloning needs an API key. Add it in Settings, or pick Edge TTS.');
            return;
        }
        setError(null);
        try {
            const fd = new FormData();
            if (file) {
                fd.append('file', file);
            } else {
                fd.append('url', url.trim());
            }
            fd.append('transcribe_provider', transcribeProvider);
            fd.append('source_language', sourceLang || '');
            fd.append('target_language', targetLang);
            fd.append('dub_provider', dubProvider);
            fd.append('voice_gender', voiceGender);
            fd.append('keep_original', String(keepOriginal));
            fd.append('original_volume', String(originalVolume));
            fd.append('output_orientation', outputOrientation);
            fd.append('crop_x_offset_pct', String(cropXOffsetPct));
            fd.append('crop_y_offset_pct', String(cropYOffsetPct));
            fd.append('burn_subtitles_in_target_lang', String(burnSubtitlesInTargetLang));
            // Keyframes — JSON-encode so FastAPI's Form field can parse it
            // server-side. Empty array becomes "null" so the backend
            // takes the static-crop path.
            fd.append('crop_keyframes', dubCropKeyframes.length ? JSON.stringify(dubCropKeyframes) : '');
            // Subtitle styling fields (only meaningful when the burn
            // toggle is on, but harmless to send always).
            fd.append('subtitle_font_name', subFontName);
            fd.append('subtitle_font_size', String(subFontSize));
            fd.append('subtitle_font_color', subFontColor);
            fd.append('subtitle_border_color', subBorderColor);
            fd.append('subtitle_border_width', String(subBorderWidth));
            fd.append('subtitle_bg_color', subBgColor);
            fd.append('subtitle_bg_opacity', String(subBgOpacity));
            fd.append('subtitle_position_pct', String(subPositionPct));
            const res = await fetch(getApiUrl('/api/standalone/dub'), {
                method: 'POST',
                headers: {
                    ...(llmHeaders || {}),
                    ...(elevenLabsKey ? { 'X-ElevenLabs-Key': elevenLabsKey } : {}),
                },
                body: fd,
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            setJobId(data.job_id);
            setStatus('queued');
        } catch (e) {
            setError(e.message || String(e));
        }
    };

    const isProcessing = jobId && !['completed', 'failed', 'idle'].includes(status);
    // Show a Back-to-home button whenever we're not on the empty
    // upload screen — covers running pipeline, completed result,
    // failure state, and past-project-loaded views.
    const isInsideJob = isProcessing || status === 'completed' || !!jobId;

    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
                {isInsideJob && (
                    <button
                        type="button"
                        onClick={reset}
                        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-zinc-400 hover:text-white px-2.5 py-1.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition"
                    >
                        <ChevronLeft size={14} /> Back to Voice Dubbing home
                    </button>
                )}
                <header className="mb-8">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] uppercase tracking-wider mb-3">
                        <Languages size={12} /> Standalone dub
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
                        Translate &amp; dub any video
                    </h1>
                    <p className="text-zinc-400 mt-2 text-sm sm:text-base leading-relaxed">
                        Whole-video translation with AI voice replacement. Same two-stage pipeline as Clip Generator — transcribe, AI cleans + translates with full-clip context, then synthesize the new voice.
                    </p>
                </header>

                {!isProcessing && status !== 'completed' && (
                    <div className="space-y-5">
                        {/* Past Dub projects — auto-hides when empty.
                            Clicking a card surfaces the saved result panel
                            so the user can replay / download the previously
                            dubbed video without re-running the pipeline. */}
                        <StandalonePastList
                            kind="dub"
                            accent="emerald"
                            onOpen={openPastJob}
                            llmHeaders={llmHeaders}
                            onResume={(job) => {
                                // Backend already kicked off the resume.
                                // Switch this view into the running state
                                // so the existing polling effect picks
                                // up the new jobId and surfaces progress.
                                setJobId(job.job_id);
                                setStatus('translating');
                                setError(null);
                                setLogs(['Resuming from saved checkpoint…']);
                            }}
                            // Redub a completed project into a different
                            // target language WITHOUT re-running Whisper.
                            // Opens the language picker modal below; on
                            // submit we hit /api/standalone/dub/redub and
                            // switch into the running state to track the
                            // new job.
                            onRedub={(job) => {
                                setRedubSourceJob(job);
                                setRedubError(null);
                                // Default to a language that's NOT the
                                // job's own language so the picker opens
                                // to a sensible alternative. If we can't
                                // tell, default to English.
                                const cur = (job.language || '').toLowerCase();
                                setRedubTargetLang(cur && cur !== 'en' ? 'en' : 'es');
                            }}
                        />

                        <UploadDropzone
                            file={file} onFile={setFile} fileInputRef={fileInputRef}
                            url={url} onUrlChange={setUrl}
                        />

                        <Section title="Stage 1 · Transcription">
                            <EngineToggle value={transcribeProvider} onChange={setTranscribeProvider} hasElevenKey={!!elevenLabsKey} />
                            <div className="mt-3">
                                <label className="text-xs text-zinc-400 mb-1.5 block">Source language</label>
                                <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-primary/50">
                                    {SOURCE_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                                </select>
                            </div>
                        </Section>

                        <Section title="Stage 2 · Target language &amp; AI translation">
                            <label className="text-xs text-zinc-400 mb-1.5 block">Translate to</label>
                            <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-primary/50">
                                {TARGET_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                            </select>
                            <p className="mt-2.5 text-[11px] text-amber-200/80 leading-relaxed flex items-start gap-1.5">
                                <Lightbulb size={11} className="mt-0.5 shrink-0 text-amber-400" />
                                <span>The AI fixes Whisper mishears using full-video context BEFORE translating, so the dub is built on a corrected transcript.</span>
                            </p>
                        </Section>

                        <Section title="Stage 3 · Voice">
                            <div className="grid grid-cols-2 gap-2">
                                <button type="button" onClick={() => setDubProvider('edge')}
                                    className={'rounded-md border px-2.5 py-2.5 text-left transition ' + (dubProvider === 'edge' ? 'border-primary/60 bg-primary/10 text-white' : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')}>
                                    <div className="text-xs font-medium">Edge TTS</div>
                                    <div className="text-[10px] text-zinc-500 mt-0.5">Free · 21 languages · neural voices</div>
                                </button>
                                <button type="button" onClick={() => setDubProvider('elevenlabs')}
                                    className={'rounded-md border px-2.5 py-2.5 text-left transition ' + (dubProvider === 'elevenlabs' ? 'border-emerald-500/60 bg-emerald-500/10 text-white' : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')}>
                                    <div className="text-xs font-medium">ElevenLabs</div>
                                    <div className="text-[10px] text-zinc-500 mt-0.5">Paid · voice cloning · key needed</div>
                                </button>
                            </div>
                            {dubProvider === 'edge' && (
                                <div className="mt-3">
                                    <label className="text-xs text-zinc-400 mb-1.5 block">Voice gender</label>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {[['auto', 'Auto'], ['male', 'Male'], ['female', 'Female']].map(([v, l]) => (
                                            <button key={v} onClick={() => setVoiceGender(v)}
                                                className={'rounded-md border px-2 py-1.5 text-xs font-medium transition ' + (voiceGender === v ? 'bg-primary/15 text-primary border-primary/40' : 'bg-black/30 text-zinc-300 border-white/10 hover:border-white/20')}>
                                                {l}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <label className="mt-3 flex items-start gap-2 cursor-pointer">
                                <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)}
                                    className="mt-0.5 h-4 w-4 accent-emerald-500" />
                                <div className="flex-1">
                                    <span className="block text-xs font-medium text-white">Keep original voice underneath</span>
                                    <span className="text-[10px] text-zinc-500">Documentary-style — original speaker plays softly, dub plays on top.</span>
                                </div>
                            </label>
                            {keepOriginal && (
                                <div className="mt-2 pl-6">
                                    <label className="text-[10px] text-zinc-500">Original volume · {Math.round(originalVolume * 100)}%</label>
                                    <input type="range" min={0.05} max={0.7} step={0.05}
                                        value={originalVolume}
                                        onChange={(e) => setOriginalVolume(+e.target.value)}
                                        className="w-full accent-emerald-500" />
                                </div>
                            )}
                        </Section>

                        <Section title="Stage 4 · Output orientation">
                            <p className="text-[11px] text-zinc-500 leading-relaxed mb-3">
                                Crop the dubbed output to a vertical or horizontal aspect ratio — useful when the original isn't shaped right for where you want to post it.
                            </p>
                            <div className="grid grid-cols-3 gap-2 mb-3">
                                {[
                                    { id: 'original', label: 'Original', sub: 'Keep source aspect' },
                                    { id: 'vertical', label: 'Vertical 9:16', sub: 'TikTok / Reels' },
                                    { id: 'horizontal', label: 'Horizontal 16:9', sub: 'YouTube / Web' },
                                ].map(({ id, label, sub }) => {
                                    const active = outputOrientation === id;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setOutputOrientation(id)}
                                            className={`py-2 px-2 rounded-md border text-xs font-medium text-left transition ${active ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' : 'bg-black/30 text-zinc-300 border-white/10 hover:border-white/20'}`}
                                        >
                                            <div>{label}</div>
                                            <div className="text-[9px] text-zinc-500 normal-case mt-0.5">{sub}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {/* Reframe sliders shown only when actually
                                cropping. Whichever axis matches the
                                source's "longer side" is the one that
                                actually moves the crop window — the
                                other becomes a no-op. We surface both
                                so the UI works for either source aspect. */}
                            {outputOrientation !== 'original' && (
                                <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3">
                                    <div className="text-[10px] text-zinc-400 leading-relaxed">
                                        <strong className="text-zinc-200">Reframe:</strong> if the auto-crop misses the important part of the frame (e.g. a face that's offset to the side), slide to shift the crop window — or set keyframes below to track a moving subject.
                                    </div>
                                    <div className={dubCropKeyframes.length > 0 ? 'opacity-40 pointer-events-none' : ''}>
                                        <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                                            <span>Horizontal position (left ↔ right)</span>
                                            <span className="tabular-nums text-zinc-200">{Math.round(cropXOffsetPct)}%</span>
                                        </label>
                                        <input
                                            type="range" min={0} max={100} step={1}
                                            value={cropXOffsetPct}
                                            onChange={(e) => setCropXOffsetPct(parseInt(e.target.value, 10))}
                                            className="w-full accent-emerald-500"
                                            disabled={dubCropKeyframes.length > 0}
                                        />
                                    </div>
                                    <div className={dubCropKeyframes.length > 0 ? 'opacity-40 pointer-events-none' : ''}>
                                        <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                                            <span>Vertical position (top ↔ bottom)</span>
                                            <span className="tabular-nums text-zinc-200">{Math.round(cropYOffsetPct)}%</span>
                                        </label>
                                        <input
                                            type="range" min={0} max={100} step={1}
                                            value={cropYOffsetPct}
                                            onChange={(e) => setCropYOffsetPct(parseInt(e.target.value, 10))}
                                            className="w-full accent-emerald-500"
                                            disabled={dubCropKeyframes.length > 0}
                                        />
                                    </div>
                                    {/* Keyframe reframe — same modal Auto Subtitle uses */}
                                    <div className="pt-2 mt-1 border-t border-white/5 flex items-center justify-between gap-3 flex-wrap">
                                        <div className="text-[10px] text-zinc-400 leading-relaxed">
                                            <strong className="text-zinc-200">Track a moving subject:</strong> drop hard-cut keyframes so the crop follows your speaker.
                                            {dubCropKeyframes.length > 0 && (
                                                <span className="ml-1 inline-flex items-center gap-1 text-emerald-300">
                                                    · {dubCropKeyframes.length} keyframe{dubCropKeyframes.length === 1 ? '' : 's'} set
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {dubCropKeyframes.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setDubCropKeyframes([])}
                                                    className="text-[11px] px-2 py-1 rounded border border-white/10 text-zinc-300 hover:border-white/20 hover:text-white"
                                                >
                                                    Clear keyframes
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => setDubReframeModalOpen(true)}
                                                disabled={!localPreviewUrl}
                                                className="text-[11px] px-3 py-1 rounded bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold shadow disabled:opacity-50 disabled:cursor-not-allowed"
                                                title={localPreviewUrl ? 'Open keyframe editor' : 'Pick a video first'}
                                            >
                                                {dubCropKeyframes.length > 0 ? 'Edit keyframes' : 'Set keyframes'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Section>

                        <Section title="Stage 5 · Subtitles (optional)">
                            <p className="text-[11px] text-zinc-500 leading-relaxed mb-3">
                                Burn matching captions in the target language onto the dubbed output. The backend transcribes the dubbed audio after rendering, so the on-screen text exactly matches what the new voice says. Adds ~1-2 minutes to the run.
                            </p>
                            <label className="flex items-start gap-2 cursor-pointer text-xs text-zinc-300 hover:text-white mb-3">
                                <input
                                    type="checkbox"
                                    checked={burnSubtitlesInTargetLang}
                                    onChange={(e) => setBurnSubtitlesInTargetLang(e.target.checked)}
                                    className="mt-0.5 accent-emerald-500"
                                />
                                <span>
                                    <span className="font-semibold">Also burn subtitles in {targetLang.toUpperCase()}</span>
                                    <span className="block text-[10px] text-zinc-500 mt-0.5">
                                        Customise the look below — same controls as Auto Subtitle Phase 2.
                                    </span>
                                </span>
                            </label>

                            {/* Full subtitle styling controls — only shown
                                when the burn toggle is on. Same controls
                                as Auto Subtitle so users get a familiar
                                experience inside Dubbing. */}
                            {burnSubtitlesInTargetLang && (
                                <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 block">Font</label>
                                            <select
                                                value={subFontName}
                                                onChange={(e) => setSubFontName(e.target.value)}
                                                className="w-full bg-black/40 border border-white/10 rounded-md py-1.5 px-2 text-[11px] text-white focus:outline-none focus:border-emerald-500/50"
                                            >
                                                {['Verdana', 'Arial', 'Impact', 'Helvetica', 'Georgia', 'Courier New', 'Times New Roman', 'Comic Sans MS'].map((f) => (
                                                    <option key={f} value={f}>{f}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                                <span>Size</span><span className="tabular-nums text-zinc-200">{subFontSize}px</span>
                                            </label>
                                            <input
                                                type="range" min={14} max={72} step={1}
                                                value={subFontSize}
                                                onChange={(e) => setSubFontSize(+e.target.value)}
                                                className="w-full accent-emerald-500"
                                            />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 block">Text colour</label>
                                            <div className="flex items-center gap-2">
                                                <input type="color" value={subFontColor}
                                                    onChange={(e) => setSubFontColor(e.target.value)}
                                                    className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer" />
                                                <input type="text" value={subFontColor}
                                                    onChange={(e) => setSubFontColor(e.target.value)}
                                                    className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-emerald-500/50" />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 block">Outline colour</label>
                                            <div className="flex items-center gap-2">
                                                <input type="color" value={subBorderColor}
                                                    onChange={(e) => setSubBorderColor(e.target.value)}
                                                    className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer" />
                                                <input type="text" value={subBorderColor}
                                                    onChange={(e) => setSubBorderColor(e.target.value)}
                                                    className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-emerald-500/50" />
                                            </div>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                            <span>Outline width</span><span className="tabular-nums text-zinc-200">{subBorderWidth}px</span>
                                        </label>
                                        <input type="range" min={0} max={10} step={1}
                                            value={subBorderWidth}
                                            onChange={(e) => setSubBorderWidth(+e.target.value)}
                                            className="w-full accent-emerald-500" />
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 block">Background colour</label>
                                            <div className="flex items-center gap-2">
                                                <input type="color" value={subBgColor}
                                                    onChange={(e) => setSubBgColor(e.target.value)}
                                                    className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer" />
                                                <input type="text" value={subBgColor}
                                                    onChange={(e) => setSubBgColor(e.target.value)}
                                                    className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-emerald-500/50" />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                                <span>BG opacity</span><span className="tabular-nums text-zinc-200">{Math.round(subBgOpacity * 100)}%</span>
                                            </label>
                                            <input type="range" min={0} max={1} step={0.05}
                                                value={subBgOpacity}
                                                onChange={(e) => setSubBgOpacity(+e.target.value)}
                                                className="w-full accent-emerald-500" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                            <span>Vertical position (from top)</span><span className="tabular-nums text-zinc-200">{Math.round(subPositionPct)}%</span>
                                        </label>
                                        <input type="range" min={0} max={100} step={1}
                                            value={subPositionPct}
                                            onChange={(e) => setSubPositionPct(+e.target.value)}
                                            className="w-full accent-emerald-500" />
                                    </div>
                                    <div className="text-[10px] text-zinc-500">
                                        Tip: opacity 0 = outlined text only; turn it up for a translucent caption box behind the words.
                                    </div>
                                </div>
                            )}
                        </Section>

                        {error && (
                            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300">
                                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <button onClick={submit} disabled={!file && !(url || '').trim()}
                            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                            <Languages size={18} /> Dub video
                        </button>
                    </div>
                )}

                {isProcessing && (
                    <ProcessingPreview
                        videoUrl={localPreviewUrl}
                        logs={logs}
                        status={status}
                        accent="emerald"
                        title="Voice dubbing"
                        steps={DUB_STEPS}
                    />
                )}

                {status === 'completed' && result && (
                    <ResultPanel
                        result={result}
                        onAgain={reset}
                        onDubAnotherLanguage={dubAnotherFromResult}
                        // Click on "Add subtitles" no longer fires the
                        // request directly — it opens the styling modal
                        // first so the user can pick font, colour,
                        // background opacity, position, etc. before the
                        // burn runs. The modal's submit button is what
                        // ultimately calls addSubtitlesFromResult.
                        onAddSubtitles={() => {
                            setAddingSubsError(null);
                            setAddSubsModalOpen(true);
                        }}
                        addingSubs={addingSubsBusy}
                        addingSubsError={addingSubsError}
                    />
                )}

                {status === 'failed' && (
                    <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">
                        <div className="flex items-start gap-2 text-red-200">
                            <AlertCircle size={16} className="mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="font-bold mb-1">Dub failed</div>
                                <div className="text-red-300 leading-relaxed break-words">
                                    {error || (logs && logs.length ? logs[logs.length - 1] : 'No error details — check Docker logs for the backend traceback.')}
                                </div>
                            </div>
                        </div>
                        {logs && logs.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-red-500/20">
                                <div className="text-[10px] uppercase tracking-wider text-red-300/70 font-bold mb-1">Last steps</div>
                                <div className="font-mono text-[11px] text-red-200/80 space-y-0.5 max-h-32 overflow-y-auto custom-scrollbar">
                                    {logs.slice(-6).map((line, i) => (
                                        <div key={i} className="break-words">{line}</div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="mt-3 pt-3 border-t border-red-500/20 flex gap-2 flex-wrap">
                            <button
                                onClick={async () => {
                                    if (!jobId) { reset(); return; }
                                    try {
                                        const r = await fetch(getApiUrl(`/api/standalone/${jobId}/resume`), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json', ...(llmHeaders || {}) },
                                        });
                                        if (r.ok) {
                                            setStatus('translating');
                                            setError(null);
                                            setLogs(['Retrying from last checkpoint…']);
                                        } else {
                                            reset();
                                        }
                                    } catch {
                                        reset();
                                    }
                                }}
                                className="px-3 py-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100 text-xs font-bold flex items-center gap-1.5"
                            >
                                <RotateCcw size={12} /> Retry from last checkpoint
                            </button>
                            <button
                                onClick={reset}
                                className="px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 text-zinc-300 text-xs font-bold flex items-center gap-1.5"
                            >
                                Start over with new file
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ADD-SUBTITLES STYLING MODAL — opens when the user clicks
                "Add subtitles" on the result panel. Wraps the same
                styling controls the form has so the user can pick
                font / colour / background / position BEFORE the burn
                fires. Submitting calls addSubtitlesFromResult, which
                POSTs to /api/standalone/dub/{id}/burn-subtitles with
                the current state values. */}
            {addSubsModalOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                    onClick={() => !addingSubsBusy && setAddSubsModalOpen(false)}
                >
                    <div
                        className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-lg shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setAddSubsModalOpen(false)}
                            disabled={addingSubsBusy}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-white disabled:opacity-50"
                        >
                            <X size={20} />
                        </button>
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                                <Sparkles size={20} className="text-white" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-white">
                                    Style the subtitles
                                </h3>
                                <p className="text-[11px] text-zinc-500 leading-snug">
                                    Pick font, colour, background, and position. Backend transcribes the dubbed audio, then burns these styles in.
                                </p>
                            </div>
                        </div>

                        {/* LIVE PREVIEW — plays the dubbed video with the
                            current styling rendered as a CSS overlay on
                            top, exactly where the burn will place it.
                            Sample text uses the first ~8 words of the
                            translated transcript so users see the
                            ACTUAL language they're styling, not lorem
                            ipsum. */}
                        {result?.video_url && (() => {
                            const sample = (() => {
                                const t = (result.translated_text || '').trim();
                                if (t) return t.split(/\s+/).slice(0, 8).join(' ');
                                return 'Sample subtitle text';
                            })();
                            const bw = Math.max(0, subBorderWidth || 0);
                            const outlineShadow = bw > 0
                                ? [
                                    `-${bw}px -${bw}px 0 ${subBorderColor}`,
                                    `${bw}px -${bw}px 0 ${subBorderColor}`,
                                    `-${bw}px ${bw}px 0 ${subBorderColor}`,
                                    `${bw}px ${bw}px 0 ${subBorderColor}`,
                                    `0 -${bw}px 0 ${subBorderColor}`,
                                    `0 ${bw}px 0 ${subBorderColor}`,
                                    `-${bw}px 0 0 ${subBorderColor}`,
                                    `${bw}px 0 0 ${subBorderColor}`,
                                ].join(', ')
                                : 'none';
                            // Same cqh-based sizing as the main preview:
                            // sliderVal/6 = % of preview height, matches
                            // the burn's slider*video_h/600 proportion.
                            const cqhPct = ((subFontSize || 32) / 6).toFixed(2);
                            const overlayStyle = {
                                fontFamily: subFontName,
                                color: subFontColor,
                                fontSize: `clamp(11px, ${cqhPct}cqh, 200px)`,
                                fontWeight: 'bold',
                                maxWidth: '92%',
                                padding: '6px 12px',
                                borderRadius: '4px',
                                textAlign: 'center',
                                lineHeight: '1.25',
                                whiteSpace: 'normal',
                                wordBreak: 'normal',
                                ...(subBgOpacity > 0
                                    ? {
                                        backgroundColor: `${subBgColor}${Math.round(subBgOpacity * 255).toString(16).padStart(2, '0')}`,
                                        textShadow: 'none',
                                    }
                                    : { textShadow: outlineShadow }),
                            };
                            return (
                                <div
                                    className="rounded-xl border border-white/10 bg-black overflow-hidden relative w-full mx-auto max-h-[280px] mb-4"
                                    style={{ aspectRatio: '16 / 9', containerType: 'size' }}
                                >
                                    <video
                                        src={getApiUrl(result.video_url)}
                                        muted autoPlay loop playsInline preload="metadata"
                                        className="w-full h-full object-contain bg-black"
                                    />
                                    <div
                                        className="absolute left-0 right-0 px-4 flex justify-center pointer-events-none"
                                        style={{ top: `${Math.max(0, Math.min(100, subPositionPct))}%` }}
                                    >
                                        <span style={overlayStyle}>{sample}</span>
                                    </div>
                                    <div className="absolute top-2 left-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full bg-black/60 text-amber-300 border border-amber-500/30 z-10">
                                        Live preview
                                    </div>
                                </div>
                            );
                        })()}

                        <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3 mb-4">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] text-zinc-400 mb-1 block">Font</label>
                                    <select
                                        value={subFontName}
                                        onChange={(e) => setSubFontName(e.target.value)}
                                        disabled={addingSubsBusy}
                                        className="w-full bg-black/40 border border-white/10 rounded-md py-1.5 px-2 text-[11px] text-white focus:outline-none focus:border-amber-500/50 disabled:opacity-60"
                                    >
                                        {['Verdana', 'Arial', 'Impact', 'Helvetica', 'Georgia', 'Courier New', 'Times New Roman', 'Comic Sans MS'].map((f) => (
                                            <option key={f} value={f}>{f}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                        <span>Size</span><span className="tabular-nums text-zinc-200">{subFontSize}px</span>
                                    </label>
                                    <input
                                        type="range" min={14} max={72} step={1}
                                        value={subFontSize}
                                        onChange={(e) => setSubFontSize(+e.target.value)}
                                        disabled={addingSubsBusy}
                                        className="w-full accent-amber-500"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] text-zinc-400 mb-1 block">Text colour</label>
                                    <div className="flex items-center gap-2">
                                        <input type="color" value={subFontColor}
                                            onChange={(e) => setSubFontColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer disabled:opacity-60" />
                                        <input type="text" value={subFontColor}
                                            onChange={(e) => setSubFontColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-amber-500/50 disabled:opacity-60" />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[10px] text-zinc-400 mb-1 block">Outline colour</label>
                                    <div className="flex items-center gap-2">
                                        <input type="color" value={subBorderColor}
                                            onChange={(e) => setSubBorderColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer disabled:opacity-60" />
                                        <input type="text" value={subBorderColor}
                                            onChange={(e) => setSubBorderColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-amber-500/50 disabled:opacity-60" />
                                    </div>
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                    <span>Outline width</span><span className="tabular-nums text-zinc-200">{subBorderWidth}px</span>
                                </label>
                                <input type="range" min={0} max={10} step={1}
                                    value={subBorderWidth}
                                    onChange={(e) => setSubBorderWidth(+e.target.value)}
                                    disabled={addingSubsBusy}
                                    className="w-full accent-amber-500" />
                            </div>
                            {/* Background pair — most-requested control. */}
                            <div className="grid grid-cols-2 gap-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
                                <div>
                                    <label className="text-[10px] text-amber-200 mb-1 block font-bold">Background colour</label>
                                    <div className="flex items-center gap-2">
                                        <input type="color" value={subBgColor}
                                            onChange={(e) => setSubBgColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="w-7 h-7 rounded border border-white/10 bg-transparent cursor-pointer disabled:opacity-60" />
                                        <input type="text" value={subBgColor}
                                            onChange={(e) => setSubBgColor(e.target.value)}
                                            disabled={addingSubsBusy}
                                            className="flex-1 bg-black/40 border border-white/10 rounded-md py-1 px-2 text-[10px] text-white font-mono focus:outline-none focus:border-amber-500/50 disabled:opacity-60" />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[10px] text-amber-200 mb-1 flex justify-between font-bold">
                                        <span>BG opacity</span><span className="tabular-nums text-zinc-200">{Math.round(subBgOpacity * 100)}%</span>
                                    </label>
                                    <input type="range" min={0} max={1} step={0.05}
                                        value={subBgOpacity}
                                        onChange={(e) => setSubBgOpacity(+e.target.value)}
                                        disabled={addingSubsBusy}
                                        className="w-full accent-amber-500" />
                                    <p className="text-[9px] text-zinc-500 mt-1">Set above 0 to get a black caption box behind the words.</p>
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] text-zinc-400 mb-1 flex justify-between">
                                    <span>Vertical position (from top)</span><span className="tabular-nums text-zinc-200">{Math.round(subPositionPct)}%</span>
                                </label>
                                <input type="range" min={0} max={100} step={1}
                                    value={subPositionPct}
                                    onChange={(e) => setSubPositionPct(+e.target.value)}
                                    disabled={addingSubsBusy}
                                    className="w-full accent-amber-500" />
                            </div>
                            {/* Quick presets — common looks one click away. */}
                            <div className="pt-2 border-t border-white/5">
                                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1.5">Quick presets</div>
                                <div className="grid grid-cols-3 gap-1.5">
                                    <button type="button" disabled={addingSubsBusy}
                                        onClick={() => {
                                            setSubFontColor('#FFFFFF'); setSubBorderColor('#000000');
                                            setSubBorderWidth(2); setSubBgColor('#000000'); setSubBgOpacity(0.0);
                                        }}
                                        className="px-2 py-1.5 rounded-md border border-white/10 bg-black/30 text-[10px] text-zinc-200 hover:border-white/20 disabled:opacity-50">
                                        White + outline
                                    </button>
                                    <button type="button" disabled={addingSubsBusy}
                                        onClick={() => {
                                            setSubFontColor('#FFFFFF'); setSubBorderColor('#000000');
                                            setSubBorderWidth(0); setSubBgColor('#000000'); setSubBgOpacity(0.7);
                                        }}
                                        className="px-2 py-1.5 rounded-md border border-white/10 bg-black/30 text-[10px] text-zinc-200 hover:border-white/20 disabled:opacity-50">
                                        White on black box
                                    </button>
                                    <button type="button" disabled={addingSubsBusy}
                                        onClick={() => {
                                            setSubFontColor('#FFEB00'); setSubBorderColor('#000000');
                                            setSubBorderWidth(4); setSubBgColor('#000000'); setSubBgOpacity(0.0);
                                            setSubFontName('Impact'); setSubFontSize(40);
                                        }}
                                        className="px-2 py-1.5 rounded-md border border-white/10 bg-black/30 text-[10px] text-zinc-200 hover:border-white/20 disabled:opacity-50">
                                        TikTok yellow
                                    </button>
                                </div>
                            </div>
                        </div>

                        {addingSubsError && (
                            <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 leading-relaxed flex items-start gap-1.5">
                                <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-400" />
                                <span className="break-words">{addingSubsError}</span>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => setAddSubsModalOpen(false)}
                                disabled={addingSubsBusy}
                                className="px-3 py-1.5 rounded-lg border border-white/10 bg-black/30 text-xs text-zinc-300 hover:border-white/20 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={addSubtitlesFromResult}
                                disabled={addingSubsBusy}
                                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 text-xs font-semibold text-black shadow disabled:opacity-50 flex items-center gap-2"
                            >
                                {addingSubsBusy && <Loader2 size={12} className="animate-spin" />}
                                {addingSubsBusy ? 'Burning…' : 'Burn subtitles'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* KEYFRAME REFRAME MODAL — drives the dub video's crop
                window through hard-cut keyframes. Same component the
                Auto Subtitle Phase 2 uses, so the UX is identical. */}
            {dubReframeModalOpen && (
                <StandaloneReframeKeyframeModal
                    videoUrl={localPreviewUrl}
                    targetAspect={outputOrientation === 'horizontal' ? 16 / 9 : 9 / 16}
                    initialKeyframes={dubCropKeyframes || []}
                    onClose={() => setDubReframeModalOpen(false)}
                    onSave={(kfs) => {
                        setDubCropKeyframes(kfs);
                        setDubReframeModalOpen(false);
                    }}
                />
            )}

            {/* REDUB MODAL — opens when the user clicks "Dub →" on a
                past project card. Lets them pick a new target language
                without re-uploading or re-transcribing. The voice +
                orientation settings come from the page's current state,
                so users can preset those once and reuse across redubs. */}
            {redubSourceJob && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                    onClick={() => !redubBusy && setRedubSourceJob(null)}
                >
                    <div
                        className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setRedubSourceJob(null)}
                            disabled={redubBusy}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-white disabled:opacity-50"
                        >
                            <X size={20} />
                        </button>
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                                <Languages size={20} className="text-white" />
                            </div>
                            <div>
                                <h3 className="text-base font-bold text-white">
                                    Dub in another language
                                </h3>
                                <p className="text-[11px] text-zinc-500 leading-snug">
                                    Reuses the saved transcript — no Whisper re-run.
                                </p>
                            </div>
                        </div>
                        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 mb-3 text-[11px] text-emerald-200/90 leading-relaxed flex items-start gap-1.5">
                            <Sparkles size={11} className="mt-0.5 shrink-0 text-emerald-300" />
                            <span>
                                Source: <span className="font-semibold">{redubSourceJob.title || 'Untitled'}</span>
                            </span>
                        </div>
                        <label className="text-xs text-zinc-400 mb-1.5 block">Target language</label>
                        <select
                            value={redubTargetLang}
                            onChange={(e) => setRedubTargetLang(e.target.value)}
                            disabled={redubBusy}
                            className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-emerald-500/50 mb-3 disabled:opacity-60"
                        >
                            {TARGET_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                        </select>
                        <label className="flex items-start gap-2 cursor-pointer text-xs text-zinc-300 hover:text-white mb-4 rounded-md border border-white/10 bg-black/30 p-2.5">
                            <input
                                type="checkbox"
                                checked={burnSubtitlesInTargetLang}
                                onChange={(e) => setBurnSubtitlesInTargetLang(e.target.checked)}
                                className="mt-0.5 accent-emerald-500"
                            />
                            <span>
                                <span className="font-semibold">Also burn subtitles in {redubTargetLang.toUpperCase()}</span>
                                <span className="block text-[10px] text-zinc-500 mt-0.5">
                                    Captions match the new voice exactly — backend transcribes the dubbed audio. ~1-2 min extra.
                                </span>
                            </span>
                        </label>
                        <p className="text-[10px] text-zinc-500 leading-relaxed mb-4">
                            Voice ({voiceGender}), provider ({dubProvider === 'edge' ? 'Edge TTS' : 'ElevenLabs'}), and orientation ({outputOrientation}) follow the settings on this page. Adjust them on the page first if needed, then re-open this modal.
                        </p>
                        {redubError && (
                            <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 leading-relaxed flex items-start gap-1.5">
                                <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-400" />
                                <span className="break-words">{redubError}</span>
                            </div>
                        )}
                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => setRedubSourceJob(null)}
                                disabled={redubBusy}
                                className="px-3 py-1.5 rounded-lg border border-white/10 bg-black/30 text-xs text-zinc-300 hover:border-white/20 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={submitRedub}
                                disabled={redubBusy}
                                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-xs font-semibold text-black shadow disabled:opacity-50 flex items-center gap-2"
                            >
                                {redubBusy && <Loader2 size={12} className="animate-spin" />}
                                {redubBusy ? 'Starting…' : 'Generate dub'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Local copies of the small helper components — same shape as
// StandaloneSubtitle's. Kept inline so each page is self-contained.
function Section({ title, children }) {
    return (
        <div className="rounded-xl border border-white/10 bg-surface/40 p-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-3">{title}</div>
            {children}
        </div>
    );
}

function EngineToggle({ value, onChange, hasElevenKey }) {
    return (
        <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => onChange('whisper')}
                className={'rounded-md border px-2.5 py-2.5 text-left transition ' + (value === 'whisper' ? 'border-primary/60 bg-primary/10 text-white' : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')}>
                <div className="text-xs font-medium">Whisper Turbo</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Free · runs locally · default</div>
            </button>
            <button type="button" onClick={() => onChange('elevenlabs')}
                className={'rounded-md border px-2.5 py-2.5 text-left transition ' + (value === 'elevenlabs' ? 'border-emerald-500/60 bg-emerald-500/10 text-white' : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')}>
                <div className="text-xs font-medium">ElevenLabs Scribe</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Paid · ~$0.40/hr · pro accuracy</div>
            </button>
            {value === 'elevenlabs' && !hasElevenKey && (
                <p className="col-span-2 text-[10px] text-amber-300">No ElevenLabs key in Settings — will fall back to Whisper.</p>
            )}
        </div>
    );
}

function UploadDropzone({ file, onFile, fileInputRef, url, onUrlChange }) {
    // Same two-mode picker as the Subtitle page. yt-dlp on the backend
    // handles platform detection so any public URL Just Works.
    const [tab, setTab] = useState(file ? 'file' : (url ? 'url' : 'file'));
    if (tab === 'url') {
        return (
            <div className="space-y-2">
                <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-[11px]">
                    <button type="button"
                        onClick={() => { setTab('file'); onUrlChange?.(''); }}
                        className="px-3 py-1.5 transition bg-black/30 text-zinc-400 hover:text-white">
                        Upload file
                    </button>
                    <button type="button"
                        onClick={() => setTab('url')}
                        className="px-3 py-1.5 transition bg-emerald-500/15 text-emerald-200">
                        Paste link
                    </button>
                </div>
                <div className="rounded-2xl border-2 border-dashed border-white/10 bg-surface/30 p-5">
                    <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">
                        Video link
                    </label>
                    <input
                        type="url"
                        autoFocus
                        value={url || ''}
                        onChange={(e) => onUrlChange?.(e.target.value)}
                        placeholder="https://www.tiktok.com/@user/video/…"
                        className="w-full bg-black/40 border border-white/10 rounded-md py-2.5 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
                    />
                    <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                        Works with YouTube, TikTok, X/Twitter, Instagram, Facebook, Reddit, Vimeo, and most other public video links.
                    </p>
                </div>
            </div>
        );
    }
    return (
      <div className="space-y-2">
        <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-[11px]">
            <button type="button"
                onClick={() => setTab('file')}
                className="px-3 py-1.5 transition bg-emerald-500/15 text-emerald-200">
                Upload file
            </button>
            <button type="button"
                onClick={() => { setTab('url'); onFile?.(null); }}
                className="px-3 py-1.5 transition bg-black/30 text-zinc-400 hover:text-white">
                Paste link
            </button>
        </div>
        <div onClick={() => fileInputRef.current?.click()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
            onDragOver={(e) => e.preventDefault()}
            className={'border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition ' + (file ? 'border-primary/40 bg-primary/5' : 'border-white/10 bg-surface/30 hover:border-white/30')}>
            <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            <Upload size={28} className="mx-auto text-zinc-500 mb-2" />
            {file ? (
                <>
                    <div className="text-sm font-medium text-white truncate">{file.name}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{(file.size / (1024 * 1024)).toFixed(1)} MB · click to swap</div>
                </>
            ) : (
                <>
                    <div className="text-sm text-zinc-300">Drag &amp; drop a video, or click to choose</div>
                    <div className="text-[10px] text-zinc-500 mt-1">MP4, MOV, MKV up to 5 GB</div>
                </>
            )}
        </div>
      </div>
    );
}

function ProgressPanel({ logs, status }) {
    return (
        <div className="rounded-2xl border border-white/10 bg-surface/40 p-6 text-center">
            <Loader2 size={28} className="text-emerald-400 animate-spin mx-auto mb-3" />
            <div className="text-sm font-medium text-white capitalize">{(status || 'processing').replace('_', ' ')}…</div>
            <div className="mt-4 max-h-40 overflow-y-auto text-left text-[11px] font-mono text-zinc-400 space-y-1">
                {(logs || []).slice(-10).map((l, i) => <div key={i}>{l}</div>)}
            </div>
        </div>
    );
}

function ResultPanel({ result, onAgain, onDubAnotherLanguage, onAddSubtitles, addingSubs, addingSubsError }) {
    // Match the input video's aspect ratio. The dub step replaces audio
    // only — it never touches video dimensions — so the output is
    // exactly the same shape the user uploaded. Use object-contain +
    // generous max-height so wide / square / tall sources all display
    // naturally without being forced into a vertical box.
    const hasBurnedSubs = !!result.has_burned_subtitles;
    return (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center space-y-4">
            <Check size={28} className="text-emerald-400 mx-auto" />
            <h3 className="text-lg font-bold text-white">Your dubbed video is ready</h3>
            <video src={getApiUrl(result.video_url)} controls playsInline preload="metadata"
                className="w-full max-h-[500px] mx-auto rounded-xl bg-black object-contain" />
            <div className="flex gap-3 justify-center flex-wrap">
                <a href={getApiUrl(result.video_url)} download
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-bold text-sm">
                    <Download size={14} /> Download
                </a>
                {/* Dub in another language — opens the redub modal with
                    the just-finished job as the source. Same flow users
                    already know from past project cards. */}
                {onDubAnotherLanguage && (
                    <button
                        onClick={onDubAnotherLanguage}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-sm font-semibold"
                        title="Generate a dub of the SAME source in another language — reuses the saved transcript so it's fast"
                    >
                        <Languages size={14} /> Dub in another language
                    </button>
                )}
                {/* Add subtitles — runs Stage 4 (transcribe dubbed audio
                    + burn captions) on the existing dub output without
                    re-running translate/synth. Hidden if the dub
                    already has subtitles burned in. */}
                {onAddSubtitles && !hasBurnedSubs && (
                    <button
                        onClick={onAddSubtitles}
                        disabled={addingSubs}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
                        title="Transcribe the dubbed audio and burn matching subtitles onto this video (uses the styling from the form on this page)"
                    >
                        {addingSubs ? (
                            <><Loader2 size={14} className="animate-spin" /> Adding subtitles…</>
                        ) : (
                            <><Sparkles size={14} /> Add subtitles</>
                        )}
                    </button>
                )}
                <button onClick={onAgain}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/15 text-zinc-200 hover:bg-white/5 text-sm">
                    <RotateCcw size={14} /> Do another
                </button>
            </div>
            {hasBurnedSubs && (
                <p className="text-[11px] text-emerald-300/80 leading-relaxed flex items-center justify-center gap-1.5">
                    <Check size={11} /> Subtitles already burned into this video
                </p>
            )}
            {/* Inline error for the Add-subtitles action — rendered HERE
                so users on the result panel actually see what went wrong
                instead of having the error vanish into a hidden form. */}
            {addingSubsError && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 leading-relaxed flex items-start gap-1.5 text-left">
                    <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-400" />
                    <span className="break-words">{addingSubsError}</span>
                </div>
            )}
        </div>
    );
}
