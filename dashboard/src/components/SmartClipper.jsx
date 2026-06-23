/**
 * Smart Clipper — multimodal viral-moment picker.
 *
 * Sits alongside Generate Clips. The legacy clip-gen flow is text-only
 * (LLM reads the transcript and picks moments). Smart Clipper is
 * multimodal — the model actually watches the video frames + listens
 * to audio + reads the transcript. Catches viral beats text alone
 * misses (a perfectly-timed reaction, a shocked face, a scene cut).
 *
 * Backend endpoints used:
 *   GET  /api/multimodal-clip/models        — registry + installed flag
 *   POST /api/multimodal-clip/pull-model    — Ollama download (SSE)
 *   POST /api/multimodal-clip/analyze       — run the picker
 *
 * Provider tiers:
 *   • free-local  — Ollama VLMs running on the user's machine.
 *   • free-cloud  — Gemini Flash variants with generous free tiers.
 *   • paid-cloud  — Gemini Pro / GPT-4o / Claude Sonnet (BYOK).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Sparkles, Download, CheckCircle2, Cloud, HardDrive, Wand2,
    Loader2, Play, FileVideo, X, FolderOpen, AlertTriangle,
    Brain, Zap, Activity, ChevronLeft, Eye,
} from 'lucide-react';
import { getApiUrl } from '../config';
import ProcessingAnimation from './ProcessingAnimation';
import ResultCard from './ResultCard';

const TIER_META = {
    'free-local': { label: 'Free · Local', icon: HardDrive, accent: 'text-emerald-300', ring: 'ring-emerald-500/30', bg: 'bg-emerald-500/5' },
    'free-cloud': { label: 'Free tier', icon: Cloud, accent: 'text-sky-300', ring: 'ring-sky-500/30', bg: 'bg-sky-500/5' },
    'paid-cloud': { label: 'Paid · BYOK', icon: Sparkles, accent: 'text-amber-300', ring: 'ring-amber-500/30', bg: 'bg-amber-500/5' },
};

export default function SmartClipper({
    currentUser,
    onChooseTab,
    // ResultCard pass-through props — same names App.jsx uses for
    // Generate Clips so we can wire each cut clip to the full editor
    // suite (Subtitle / Dub / Edit / Reframe / Post).
    uploadPostKey = '',
    uploadUserId = '',
    geminiApiKey = '',
    llmConfig = null,
    elevenLabsKey = '',
}) {
    // ---- Model registry ---------------------------------------------------
    const [models, setModels] = useState([]);
    const [ollamaReachable, setOllamaReachable] = useState(true);
    const [registryLoading, setRegistryLoading] = useState(true);
    const [registryError, setRegistryError] = useState('');

    // The user's current pick. Defaults to the first FREE-LOCAL installed
    // model on first load; falls back to gemini-1.5-flash if no local
    // is installed yet.
    const [selectedModelId, setSelectedModelId] = useState(
        () => localStorage.getItem('klipra_smartclip_model') || ''
    );

    const fetchModels = async () => {
        setRegistryLoading(true);
        setRegistryError('');
        try {
            const r = await fetch(getApiUrl('/api/multimodal-clip/models'));
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setModels(data.models || []);
            setOllamaReachable(!!data.ollama_reachable);
            if (!selectedModelId && (data.models || []).length) {
                const installedLocal = (data.models || []).find((m) => m.tier === 'free-local' && m.installed);
                const fallback = (data.models || []).find((m) => m.id === 'gemini/gemini-1.5-flash');
                const pick = installedLocal || fallback || data.models[0];
                if (pick) setSelectedModelId(pick.id);
            }
        } catch (e) {
            setRegistryError(e.message || String(e));
        } finally {
            setRegistryLoading(false);
        }
    };
    useEffect(() => { fetchModels(); /* eslint-disable-next-line */ }, []);
    useEffect(() => {
        if (selectedModelId) localStorage.setItem('klipra_smartclip_model', selectedModelId);
    }, [selectedModelId]);

    const selectedModel = models.find((m) => m.id === selectedModelId) || null;

    // ---- Ollama auto-download ---------------------------------------------
    // pullProgress: { ollamaTag → { status, completed, total, error } }
    const [pullProgress, setPullProgress] = useState({});

    const startPull = async (ollamaTag) => {
        setPullProgress((p) => ({ ...p, [ollamaTag]: { status: 'starting' } }));
        try {
            const res = await fetch(getApiUrl('/api/multimodal-clip/pull-model'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ollama_tag: ollamaTag }),
            });
            if (!res.ok || !res.body) throw new Error(await res.text());
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            // Server-Sent-Events: each event is "data: {...}\n\n"
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop();
                for (const evt of events) {
                    if (!evt.startsWith('data:')) continue;
                    const payload = evt.slice(5).trim();
                    if (!payload) continue;
                    try {
                        const parsed = JSON.parse(payload);
                        setPullProgress((p) => ({ ...p, [ollamaTag]: parsed }));
                        if (parsed.status === 'complete' || parsed.status === 'success') {
                            // Re-fetch models so the badge flips from "Download" to "Installed".
                            fetchModels();
                        }
                    } catch { /* ignore malformed events */ }
                }
            }
        } catch (e) {
            setPullProgress((p) => ({ ...p, [ollamaTag]: { status: 'error', error: e.message || String(e) } }));
        }
    };

    // ---- Source video ------------------------------------------------------
    // We support TWO input modes — same as Generate Clips:
    //   • Drop / pick a local file (fastest — no upload, server reads the
    //     file from the user's bind-mounted folder).
    //   • Paste an existing job_id from a past Generate Clips run.
    const [localPath, setLocalPath] = useState('');
    const [localFileName, setLocalFileName] = useState('');
    const [localFileSize, setLocalFileSize] = useState(0);
    const [localFileBlob, setLocalFileBlob] = useState(null);
    const [localResolveStatus, setLocalResolveStatus] = useState('idle'); // idle|resolving|resolved|not_found|error
    const [localResolveError, setLocalResolveError] = useState('');
    const [localRoots, setLocalRoots] = useState([]);

    useEffect(() => {
        fetch(getApiUrl('/api/local/config'))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d && d.enabled) setLocalRoots(d.roots || []); })
            .catch(() => {});
    }, []);

    const resolveLocalFile = async (f) => {
        if (!f) return;
        setLocalFileName(f.name);
        setLocalFileSize(f.size);
        setLocalFileBlob(f);
        setLocalResolveStatus('resolving');
        setLocalResolveError('');
        setLocalPath('');
        try {
            const params = new URLSearchParams({ name: f.name, size: String(f.size || 0) });
            const r = await fetch(getApiUrl(`/api/local/find?${params.toString()}`));
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            const matches = Array.isArray(data.matches) ? data.matches : [];
            if (matches.length >= 1) {
                setLocalPath(matches[0].path);
                setLocalResolveStatus('resolved');
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
        setLocalResolveStatus('idle');
        setLocalResolveError('');
    };

    const previewVideoUrl = useMemo(
        () => (localFileBlob ? URL.createObjectURL(localFileBlob) : ''),
        [localFileBlob]
    );
    useEffect(() => () => { if (previewVideoUrl) URL.revokeObjectURL(previewVideoUrl); }, [previewVideoUrl]);
    const videoRef = useRef(null);

    // ---- Picker run --------------------------------------------------------
    const [analyzeStatus, setAnalyzeStatus] = useState('idle');  // idle|running|done|error
    const [analyzeError, setAnalyzeError] = useState('');
    const [picks, setPicks] = useState([]);
    const [pickerMeta, setPickerMeta] = useState(null);

    const [targetClips, setTargetClips] = useState(6);
    const [minDuration, setMinDuration] = useState(20);
    const [maxDuration, setMaxDuration] = useState(60);
    const [reframeToVertical, setReframeToVertical] = useState(true);
    // Smart Clipper mode toggle. 'fast' = single-call multimodal picker
    // (the original flow). 'pro' = staged 5-pass pipeline
    // (transcribe → translate → per-frame visual → text reasoning →
    //  greedy selection). Pro is much smarter but ~3× slower because
    // it makes multiple LLM calls. Persisted across sessions.
    const [clipperMode, setClipperMode] = useState(() => {
        try { return localStorage.getItem('klipra.smartClipper.mode') || 'fast'; }
        catch { return 'fast'; }
    });
    const setClipperModePersisted = (m) => {
        setClipperMode(m);
        try { localStorage.setItem('klipra.smartClipper.mode', m); } catch { /* ignore */ }
    };

    // Scoring rubric — 'signals' (default) makes the picker score
    // each clip against six named signals (punchline, reversal,
    // awkward_pause, one_liner, audio_peak, visual_energy). 'classic'
    // keeps the legacy single hook + why_viral shape for A/B
    // comparison. Persisted so a power user can pin their preferred
    // setting across runs.
    const [scoringRubric, setScoringRubric] = useState(() => {
        try { return localStorage.getItem('klipra.smartClipper.scoringRubric') || 'signals'; }
        catch { return 'signals'; }
    });
    const setScoringRubricPersisted = (r) => {
        setScoringRubric(r);
        try { localStorage.setItem('klipra.smartClipper.scoringRubric', r); } catch { /* ignore */ }
    };

    // Cut clips — populated by the auto-cut step that runs after a
    // successful analyze. Each entry matches the standard Klipra
    // `shorts` shape so ResultCard renders it identically to the
    // Generate Clips output (Subtitle / Dub / Edit / Reframe / Post
    // all just work). batchId is used as the synthetic jobId by
    // ResultCard's per-clip API calls.
    const [cutClips, setCutClips] = useState([]);
    const [batchJobId, setBatchJobId] = useState('');
    const [cuttingStatus, setCuttingStatus] = useState('idle'); // idle|cutting|done|error
    const [cuttingError, setCuttingError] = useState('');

    // Live log feed shown in the split-pane layout. The /analyze endpoint
    // is a single blocking call (the LLM does its work in one round-trip),
    // so we don't have real-time progress to stream — but the user wants
    // the same "alive" feel that Generate Clips' processing view has.
    // We synthesise plausible phase entries on a timer, in the same
    // monospace voice Klipra's existing logs use, so the page never looks
    // stuck. Cleared at the start of each run.
    const [logs, setLogs] = useState([]);
    const logsEndRef = useRef(null);
    useEffect(() => {
        if (analyzeStatus !== 'running') return;
        const phases = [
            'Probing video duration & dimensions…',
            'Extracting keyframes (1 frame every 4 seconds)…',
            'Running Whisper transcript with word-level timing…',
            (() => {
                const m = models.find((x) => x.id === selectedModelId);
                return `Loading ${m?.label || 'AI model'} — first call may stream the model into RAM…`;
            })(),
            'Sending frames + transcript to the AI model…',
            'AI is watching the video. This is the bulk of the wait.',
            'Scoring candidate viral moments by visual + audio energy…',
            'Filtering overlapping clips and ranking by virality…',
            'Normalising start/end timestamps to safe duration windows…',
        ];
        let i = 0;
        const push = (line) => {
            const t = new Date().toLocaleTimeString([], { hour12: false });
            setLogs((prev) => [...prev, { t, line }]);
        };
        push(phases[0]);
        i = 1;
        const interval = setInterval(() => {
            if (i >= phases.length) {
                clearInterval(interval);
                return;
            }
            push(phases[i]);
            i += 1;
        }, 7000);
        return () => clearInterval(interval);
    }, [analyzeStatus, selectedModelId, models]);
    useEffect(() => {
        // Keep the log scrolled to the latest entry.
        if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [logs.length]);

    // Read the user's saved API keys out of localStorage in the SAME
    // shape Settings (KeyInput.jsx) writes them. Each provider's key
    // lives at `os_llm_key_${provider}` XOR-encoded with the salt below.
    // The earlier version read `os_llm_pref` which doesn't exist —
    // that's why Gemini's analyze 403'd with "no API key configured".
    const SALT = 'openshorts-llm-v1';
    const xorDecode = (s) => {
        try {
            const raw = atob(s);
            let out = '';
            for (let i = 0; i < raw.length; i++) {
                out += String.fromCharCode(raw.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
            }
            return out;
        } catch {
            return '';
        }
    };
    const loadProviderKey = (provider) => {
        const v = localStorage.getItem(`os_llm_key_${provider}`);
        return v ? xorDecode(v) : '';
    };

    const llmHeaders = () => {
        const headers = { 'Content-Type': 'application/json' };
        // Provider-specific keys — we send all of them. The backend
        // picks the matching one based on the chosen multimodal model.
        const gemini = loadProviderKey('gemini');
        const openai = loadProviderKey('openai');
        const anthropic = loadProviderKey('anthropic');
        if (gemini)    headers['X-Gemini-Key'] = gemini;
        if (openai)    headers['X-OpenAI-Key'] = openai;
        if (anthropic) headers['X-Anthropic-Key'] = anthropic;
        // Generic X-LLM-Key fallback so the backend's "or" chain
        // catches any other provider we plug in later.
        try {
            const lastPref = JSON.parse(localStorage.getItem('os_llm_pref_last') || 'null');
            if (lastPref?.provider) {
                const k = loadProviderKey(lastPref.provider);
                if (k) headers['X-LLM-Key'] = k;
                if (lastPref.model) headers['X-LLM-Model'] = lastPref.model;
                headers['X-LLM-Provider'] = lastPref.provider;
            }
        } catch {}
        return headers;
    };

    const runAnalysis = async () => {
        if (!localPath) {
            setAnalyzeError('Pick a video first.');
            return;
        }
        if (!selectedModelId) {
            setAnalyzeError('Pick a model first.');
            return;
        }
        setAnalyzeStatus('running');
        setAnalyzeError('');
        setPicks([]);
        setPickerMeta(null);
        setLogs([]);  // fresh log buffer for this run
        try {
            const r = await fetch(getApiUrl('/api/multimodal-clip/analyze'), {
                method: 'POST',
                headers: llmHeaders(),
                body: JSON.stringify({
                    local_path: localPath,
                    model_id: selectedModelId,
                    target_clips: targetClips,
                    min_duration: minDuration,
                    max_duration: maxDuration,
                    pro_mode: clipperMode === 'pro',
                    // Per-signal rubric flag — backend defaults to
                    // 'signals' but we send explicitly so the picker
                    // log includes whichever mode actually ran.
                    scoring_rubric: scoringRubric,
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setPicks(data.clips || []);
            setPickerMeta({
                provider: data.provider_used,
                model: data.model_used,
                elapsed: data.elapsed_seconds,
                frames: data.frames_examined,
                rawExcerpt: data.raw_response_excerpt || '',
                rawLength: data.raw_response_length || 0,
                proMode: !!data.pro_mode,
            });
            setAnalyzeStatus('done');
            // Final log entries — backend is done so we can be honest about
            // exactly what happened (frames examined, elapsed time, count).
            const t = new Date().toLocaleTimeString([], { hour12: false });
            setLogs((prev) => [
                ...prev,
                { t, line: `✓ AI returned ${data.clips?.length || 0} viral moment candidates.` },
                { t, line: `Examined ${data.frames_examined || 0} frames in ${data.elapsed_seconds || 0}s with ${data.model_used}.` },
            ]);
            // PHASE A — auto-cut the picks into real mp4s so the user
            // can play each one with audio + controls. Runs in the
            // background; logs progress.
            if ((data.clips || []).length > 0 && localPath) {
                cutClipsForPicks(data.clips, localPath);
            }
        } catch (e) {
            setAnalyzeStatus('error');
            setAnalyzeError(e.message || String(e));
            const t = new Date().toLocaleTimeString([], { hour12: false });
            setLogs((prev) => [...prev, { t, line: `✗ ${e.message || String(e)}` }]);
        }
    };

    // Reset analysis state and return the page to the setup steps.
    const backToSetup = () => {
        setAnalyzeStatus('idle');
        setAnalyzeError('');
        setPicks([]);
        setPickerMeta(null);
        setLogs([]);
        setSavedProjectId(null);
        setCutClips([]);
        setCuttingStatus('idle');
        setCuttingError('');
    };

    // PHASE A — cut the picks into real mp4 files via the backend
    // /api/multimodal-clip/cut endpoint. Runs after analyze succeeds
    // so each pick on the right pane becomes a playable inline video
    // (with audio + controls) instead of a text-only summary.
    const cutClipsForPicks = async (picksToCut, sourcePath) => {
        setCuttingStatus('cutting');
        setCuttingError('');
        setCutClips([]);
        const t = new Date().toLocaleTimeString([], { hour12: false });
        setLogs((prev) => [
            ...prev,
            { t, line: `Cutting ${picksToCut.length} clip${picksToCut.length === 1 ? '' : 's'} from source…` },
        ]);
        try {
            const r = await fetch(getApiUrl('/api/multimodal-clip/cut'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: sourcePath,
                    picks: picksToCut,
                    reframe_to_vertical: reframeToVertical,
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setCutClips(data.clips || []);
            setBatchJobId(data.job_id || data.batch_id || '');
            setCuttingStatus('done');
            const tt = new Date().toLocaleTimeString([], { hour12: false });
            setLogs((prev) => [
                ...prev,
                { t: tt, line: `✓ Cut ${(data.clips || []).length} clip${(data.clips || []).length === 1 ? '' : 's'} (batch ${data.batch_id}).` },
            ]);
        } catch (e) {
            setCuttingStatus('error');
            setCuttingError(e.message || String(e));
            const tt = new Date().toLocaleTimeString([], { hour12: false });
            setLogs((prev) => [
                ...prev,
                { t: tt, line: `✗ Could not cut clips: ${e.message || String(e)}` },
            ]);
        }
    };

    // ---- Save / past projects --------------------------------------------
    const [savedProjectId, setSavedProjectId] = useState(null);
    const [savingProject, setSavingProject] = useState(false);
    const [pastProjects, setPastProjects] = useState([]);
    const [pastProjectsStatus, setPastProjectsStatus] = useState('idle'); // idle|loading|loaded

    const refreshPastProjects = async () => {
        setPastProjectsStatus('loading');
        try {
            const r = await fetch(getApiUrl('/api/multimodal-clip/projects'));
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setPastProjects(data.projects || []);
        } catch (e) {
            // non-fatal; just show empty list
            setPastProjects([]);
        } finally {
            setPastProjectsStatus('loaded');
        }
    };
    // Pull list when user is at the setup screen.
    useEffect(() => {
        if (analyzeStatus === 'idle') refreshPastProjects();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analyzeStatus]);

    const onSaveProject = async () => {
        if (!picks.length || !localPath) return;
        setSavingProject(true);
        try {
            const r = await fetch(getApiUrl('/api/multimodal-clip/save-project'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: localPath,
                    source_filename: localFileName,
                    model_id: selectedModelId,
                    model_label: selectedModel?.label || '',
                    target_clips: targetClips,
                    min_duration: minDuration,
                    max_duration: maxDuration,
                    picks,
                    elapsed_seconds: pickerMeta?.elapsed || 0,
                    frames_examined: pickerMeta?.frames || 0,
                    title: localFileName || 'Smart Clipper project',
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setSavedProjectId(data.id);
        } catch (e) {
            alert('Could not save project: ' + (e.message || String(e)));
        } finally {
            setSavingProject(false);
        }
    };

    const openPastProject = async (proj) => {
        try {
            const r = await fetch(getApiUrl(`/api/multimodal-clip/projects/${proj.id}`));
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            // Restore the right side state so the user sees the same picks.
            setLocalPath(data.source_path || '');
            setLocalFileName(data.source_filename || '');
            setSelectedModelId(data.model_id || selectedModelId);
            setTargetClips(data.target_clips || 6);
            setMinDuration(data.min_duration || 20);
            setMaxDuration(data.max_duration || 60);
            setPicks(data.picks || []);
            setPickerMeta({
                provider: (data.model_id || '').split('/')[0],
                model: data.model_id,
                elapsed: data.elapsed_seconds || 0,
                frames: data.frames_examined || 0,
            });
            setSavedProjectId(data.id);
            setLogs([
                { t: '—', line: `Reopened past project: ${data.title || data.source_filename}` },
                { t: '—', line: `${(data.picks || []).length} viral moments saved on ${new Date((data.created_at || 0) * 1000).toLocaleString()}.` },
            ]);
            // No source video blob (file may not be open in the browser any
            // more). Preview will show the "no preview" state but the picks
            // still display. User can drop the file again to restore preview.
            setLocalFileBlob(null);
            setAnalyzeStatus('done');
        } catch (e) {
            alert('Could not open project: ' + (e.message || String(e)));
        }
    };

    const deletePastProject = async (projId) => {
        if (!confirm('Delete this project? This cannot be undone.')) return;
        try {
            const r = await fetch(getApiUrl(`/api/multimodal-clip/projects/${projId}`), {
                method: 'DELETE',
            });
            if (!r.ok) throw new Error(await r.text());
            await refreshPastProjects();
        } catch (e) {
            alert('Could not delete: ' + (e.message || String(e)));
        }
    };

    // Sync state for the embedded ProcessingAnimation player. When the
    // user clicks the 👁 button on a pick we hand the timestamp here;
    // ProcessingAnimation's own useEffect picks it up and seeks +
    // plays. syncTrigger is bumped on every click so re-clicking the
    // SAME pick re-triggers the seek (state value alone wouldn't
    // change in that case, so the effect wouldn't re-run).
    const [syncedTime, setSyncedTime] = useState(0);
    const [isSyncedPlaying, setIsSyncedPlaying] = useState(false);
    const [syncTrigger, setSyncTrigger] = useState(0);

    const playPick = (clip) => {
        const t = Math.max(0, Number(clip.start) || 0);
        setSyncedTime(t);
        setIsSyncedPlaying(true);
        setSyncTrigger((x) => x + 1);
    };

    const tierBadge = (tier) => {
        const meta = TIER_META[tier] || TIER_META['free-local'];
        const Icon = meta.icon;
        return (
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${meta.accent} ${meta.bg} px-1.5 py-0.5 rounded`}>
                <Icon size={10} /> {meta.label}
            </span>
        );
    };

    // ===== render =========================================================
    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
                {/* Header */}
                <header className="flex items-start justify-between gap-3">
                    <div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[11px] uppercase tracking-wider text-violet-200 mb-3">
                            <Brain size={12} /> NEW · multimodal
                        </div>
                        <h1 className="text-3xl sm:text-4xl font-black tracking-tight leading-[1.05]">
                            <span className="bg-gradient-to-r from-violet-300 via-primary to-emerald-300 bg-clip-text text-transparent">
                                Smart Clipper
                            </span>
                        </h1>
                        <p className="mt-2 max-w-2xl text-zinc-400 text-sm leading-relaxed">
                            Drop a long-form video. The AI watches the actual frames + reads the transcript
                            and picks the strongest viral moments — facial reactions, scene cuts, punchlines.
                            Works on horizontal or vertical input.
                        </p>
                    </div>
                </header>

                {/* SETUP STEPS — hidden once the picker is running. While
                    running OR done we render the split-pane processing
                    layout below (preview + logs on the left, results on
                    the right) so users see exactly what the AI is doing. */}
                {(analyzeStatus === 'idle' || analyzeStatus === 'error') && (
                <>
                <ContentTypeRouter onChooseTab={onChooseTab} />

                {/* PAST PROJECTS — only shown when there's at least one
                    saved analysis. Lets the user reopen a previous run
                    without re-paying the multimodal cost. */}
                {pastProjects.length > 0 && (
                    <section className="rounded-2xl border border-white/10 bg-surface/60 p-5">
                        <div className="flex items-center justify-between mb-3">
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Past projects</div>
                                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                    <FileVideo size={18} className="text-violet-300" /> {pastProjects.length} saved
                                </h2>
                            </div>
                            <button
                                onClick={refreshPastProjects}
                                className="text-[11px] text-zinc-400 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20"
                                title="Refresh list"
                            >
                                Refresh
                            </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {pastProjects.map((p) => (
                                <div key={p.id} className="rounded-lg border border-white/10 bg-black/30 p-3 flex items-center justify-between gap-3">
                                    <button
                                        type="button"
                                        onClick={() => openPastProject(p)}
                                        className="flex-1 min-w-0 text-left"
                                    >
                                        <div className="text-sm font-medium text-white truncate">{p.title}</div>
                                        <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
                                            {p.pick_count} picks · {p.model_label || p.model_id}
                                            {' · '}
                                            {p.created_at ? new Date(p.created_at * 1000).toLocaleDateString() : ''}
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => deletePastProject(p.id)}
                                        className="p-1 text-zinc-500 hover:text-red-300 rounded"
                                        title="Delete project"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}


                {/* Step 1 — Pick a model ====================================== */}
                <section className="rounded-2xl border border-white/10 bg-surface/60 p-5">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Step 1</div>
                            <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                <Wand2 size={18} className="text-violet-300" /> Pick the AI model
                            </h2>
                        </div>
                        <button
                            onClick={fetchModels}
                            className="text-[11px] text-zinc-400 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20"
                            title="Refresh installed status"
                        >
                            Refresh
                        </button>
                    </div>

                    {!ollamaReachable && (
                        <div className="mb-3 flex items-start gap-2 text-[12px] text-amber-200/90 bg-amber-500/5 border border-amber-500/20 rounded-md p-2.5">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                            <span>
                                Ollama isn't reachable from this server. Local (free) models will be unavailable.
                                {' '}Start Ollama with <code className="bg-black/30 px-1 rounded">ollama serve</code> and refresh.
                                Cloud models (Gemini / OpenAI / Anthropic) still work with a key.
                            </span>
                        </div>
                    )}

                    {registryLoading && (
                        <div className="text-zinc-400 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading models…</div>
                    )}
                    {registryError && (
                        <div className="text-red-300 text-sm">Could not load models: {registryError}</div>
                    )}
                    {!registryLoading && !registryError && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {models.map((m) => {
                                const isSelected = m.id === selectedModelId;
                                const meta = TIER_META[m.tier] || TIER_META['free-local'];
                                const tag = m.ollama_tag;
                                const progress = tag ? pullProgress[tag] : null;
                                const isDownloading = progress && !['complete', 'success', 'error'].includes(progress.status);
                                const downloadFailed = progress && progress.status === 'error';
                                const sizeMb = m.size_mb;
                                const downloadedPct = (() => {
                                    if (!progress) return 0;
                                    if (typeof progress.completed === 'number' && typeof progress.total === 'number' && progress.total > 0) {
                                        return Math.round((progress.completed / progress.total) * 100);
                                    }
                                    return 0;
                                })();
                                return (
                                    // div+role, NOT <button>: the card contains nested
                                    // <button>s (Download / Try again) and button-in-button
                                    // is invalid HTML — browsers reparent the inner button
                                    // out of the outer one, breaking layout and clicks.
                                    <div
                                        key={m.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setSelectedModelId(m.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                setSelectedModelId(m.id);
                                            }
                                        }}
                                        className={
                                            'text-left rounded-xl border p-3 transition relative cursor-pointer ' +
                                            (isSelected
                                                ? `${meta.bg} ring-2 ${meta.ring} border-white/20`
                                                : 'bg-black/30 border-white/10 hover:border-white/20')
                                        }
                                    >
                                        <div className="flex items-start justify-between gap-2 mb-1.5">
                                            <div className="text-sm font-bold text-white truncate">{m.label}</div>
                                            {isSelected && <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />}
                                        </div>
                                        <div className="flex items-center gap-2 mb-2">
                                            {tierBadge(m.tier)}
                                            <span className="text-[10px] text-zinc-500 truncate">{m.vendor}</span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 leading-snug mb-2 line-clamp-2">
                                            {m.notes}
                                        </div>
                                        <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                                            <span className="inline-flex items-center gap-1">
                                                <Sparkles size={10} /> {m.quality}/100 quality
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <Zap size={10} /> ~{m.speed_seconds}s
                                            </span>
                                            {sizeMb && (
                                                <span className="inline-flex items-center gap-1">
                                                    <HardDrive size={10} /> {(sizeMb / 1024).toFixed(1)} GB
                                                </span>
                                            )}
                                        </div>

                                        {/* Local model: download CTA */}
                                        {m.tier === 'free-local' && (
                                            <div className="mt-3">
                                                {m.installed ? (
                                                    <div className="text-[11px] text-emerald-300 inline-flex items-center gap-1">
                                                        <CheckCircle2 size={12} /> Installed
                                                    </div>
                                                ) : isDownloading ? (
                                                    <div className="space-y-1">
                                                        <div className="text-[11px] text-zinc-400 inline-flex items-center gap-1">
                                                            <Loader2 size={12} className="animate-spin" />
                                                            {progress.status || 'downloading'}{downloadedPct > 0 ? ` · ${downloadedPct}%` : ''}
                                                        </div>
                                                        {downloadedPct > 0 && (
                                                            <div className="h-1 rounded bg-white/5 overflow-hidden">
                                                                <div
                                                                    className="h-full bg-violet-500 transition-all"
                                                                    style={{ width: `${downloadedPct}%` }}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : downloadFailed ? (
                                                    <div className="space-y-1">
                                                        <div className="text-[11px] text-red-300">Download failed: {progress.error}</div>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => { e.stopPropagation(); startPull(tag); }}
                                                            className="text-[11px] text-zinc-300 underline"
                                                        >
                                                            Try again
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); startPull(tag); }}
                                                        disabled={!ollamaReachable}
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold rounded bg-violet-500 hover:bg-violet-400 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                                    >
                                                        <Download size={12} /> Download {(sizeMb / 1024).toFixed(1)} GB
                                                    </button>
                                                )}
                                            </div>
                                        )}

                                        {/* Cloud model: tier note */}
                                        {(m.tier === 'free-cloud' || m.tier === 'paid-cloud') && (
                                            <div className="mt-3 text-[10px] text-zinc-500">
                                                {m.free_tier_note && <div>{m.free_tier_note}</div>}
                                                {m.cost_per_video && <div>Cost: {m.cost_per_video}</div>}
                                                <div className="mt-1 text-zinc-400">
                                                    Uses your <strong>{m.byok_setting}</strong> API key from Settings.
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>

                {/* Step 2 — Drop a video ===================================== */}
                <section className="rounded-2xl border border-white/10 bg-surface/60 p-5">
                    <div className="mb-3">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Step 2</div>
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <FolderOpen size={18} className="text-emerald-300" /> Drop your video
                        </h2>
                    </div>
                    <div
                        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                            localResolveStatus === 'resolved'
                                ? 'border-emerald-500/60 bg-emerald-500/5'
                                : (localResolveStatus === 'not_found' || localResolveStatus === 'error')
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
                                    <button type="button" onClick={clearLocalFile} className="p-1 hover:bg-white/10 rounded-full">
                                        <X size={16} />
                                    </button>
                                </div>
                                <div className="text-[11px] text-zinc-500">{(localFileSize / (1024 * 1024)).toFixed(1)} MB</div>
                                {localResolveStatus === 'resolving' && (
                                    <div className="text-[11px] text-zinc-400 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Locating in allowed folders…</div>
                                )}
                                {localResolveStatus === 'resolved' && (
                                    <div className="text-[11px] text-emerald-300">✓ Found at <code className="bg-black/30 px-1 rounded">{localPath}</code></div>
                                )}
                                {localResolveStatus === 'not_found' && (
                                    <div className="text-[11px] text-amber-300 leading-snug">
                                        Couldn't find <code className="bg-black/30 px-1 rounded">{localFileName}</code> in any allowed folder.
                                        Move it into <code className="bg-black/30 px-1 rounded">~/Desktop/Movies</code> first.
                                    </div>
                                )}
                                {localResolveStatus === 'error' && (
                                    <div className="text-[11px] text-amber-300">Lookup failed: {localResolveError}</div>
                                )}
                            </div>
                        ) : (
                            <label className="cursor-pointer block">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f) resolveLocalFile(f); }}
                                    className="hidden"
                                />
                                <FolderOpen className="mx-auto mb-3 text-zinc-500" size={24} />
                                <p className="text-zinc-300 font-medium">Drop your video here, or click to choose</p>
                                <p className="text-[11px] text-zinc-500 mt-1.5">No upload — Klipra reads it directly from disk.</p>
                            </label>
                        )}
                    </div>
                    {localRoots.length > 0 && (
                        <div className="mt-2 text-[10px] text-zinc-500">
                            Files must live inside{' '}
                            {localRoots.map((r, i) => (
                                <span key={r}>
                                    <code className="text-zinc-300 bg-black/40 px-1 rounded">{r}</code>
                                    {i < localRoots.length - 1 ? ' or ' : ''}
                                </span>
                            ))}
                            .
                        </div>
                    )}
                </section>

                {/* Step 3 — Tune + run ====================================== */}
                <section className="rounded-2xl border border-white/10 bg-surface/60 p-5">
                    <div className="mb-3">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Step 3</div>
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <Sparkles size={18} className="text-amber-300" /> Find viral moments
                        </h2>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                        <NumberInput label="How many clips" value={targetClips} setValue={setTargetClips} min={1} max={12} />
                        <NumberInput label="Min duration (s)" value={minDuration} setValue={setMinDuration} min={5} max={120} />
                        <NumberInput label="Max duration (s)" value={maxDuration} setValue={setMaxDuration} min={10} max={300} />
                    </div>

                    {/* Mode picker — Fast (single VLM call) vs Pro (staged pipeline). */}
                    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-1.5 flex gap-1">
                        <button
                            type="button"
                            onClick={() => setClipperModePersisted('fast')}
                            className={
                                'flex-1 rounded-lg px-3 py-2.5 text-left transition '
                                + (clipperMode === 'fast'
                                    ? 'bg-violet-500/20 border border-violet-400/40 text-white'
                                    : 'border border-transparent text-zinc-400 hover:text-white')
                            }
                        >
                            <div className="flex items-center gap-2 text-[12px] font-bold">
                                <Wand2 size={13} className={clipperMode === 'fast' ? 'text-violet-300' : 'text-zinc-500'} />
                                Fast
                                <span className="ml-auto text-[10px] font-mono text-zinc-500">~2-4 min</span>
                            </div>
                            <div className="text-[10px] text-zinc-400 mt-0.5">
                                Single VLM call. Good for short videos and quick drafts.
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={() => setClipperModePersisted('pro')}
                            className={
                                'flex-1 rounded-lg px-3 py-2.5 text-left transition '
                                + (clipperMode === 'pro'
                                    ? 'bg-amber-500/15 border border-amber-400/40 text-white'
                                    : 'border border-transparent text-zinc-400 hover:text-white')
                            }
                        >
                            <div className="flex items-center gap-2 text-[12px] font-bold">
                                <Sparkles size={13} className={clipperMode === 'pro' ? 'text-amber-300' : 'text-zinc-500'} />
                                Pro
                                <span className="ml-1 text-[9px] font-bold uppercase tracking-wider text-amber-200 bg-amber-400/20 border border-amber-300/30 rounded px-1 py-0.5">
                                    NEW
                                </span>
                                <span className="ml-auto text-[10px] font-mono text-zinc-500">~6-12 min</span>
                            </div>
                            <div className="text-[10px] text-zinc-400 mt-0.5">
                                5-pass pipeline · translates · per-frame analysis · text reasoning. Best for long mixed-language videos.
                            </div>
                        </button>
                    </div>

                    {/* Scoring rubric — Signals (default, new) vs Classic.
                        Tucked under the Fast/Pro pills as a smaller toggle
                        because it's the second-most-important picker
                        decision after speed. Persisted across sessions. */}
                    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-2 flex items-center gap-2">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold pl-1 pr-2">
                            Scoring
                        </div>
                        <button
                            type="button"
                            onClick={() => setScoringRubricPersisted('signals')}
                            className={
                                'flex-1 rounded-md px-2 py-1.5 text-[11px] transition '
                                + (scoringRubric === 'signals'
                                    ? 'bg-violet-500/20 border border-violet-400/40 text-violet-100 font-bold'
                                    : 'border border-transparent text-zinc-400 hover:text-white')
                            }
                            title="Score each clip against six named signals: punchline, reversal, awkward_pause, one_liner, audio_peak, visual_energy."
                        >
                            Signals <span className="opacity-60">· per-signal scores</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setScoringRubricPersisted('classic')}
                            className={
                                'flex-1 rounded-md px-2 py-1.5 text-[11px] transition '
                                + (scoringRubric === 'classic'
                                    ? 'bg-zinc-500/20 border border-zinc-400/40 text-zinc-100 font-bold'
                                    : 'border border-transparent text-zinc-400 hover:text-white')
                            }
                            title="Legacy single hook + why_viral output. Use for A/B comparison."
                        >
                            Classic <span className="opacity-60">· single judgment</span>
                        </button>
                    </div>

                    <button
                        onClick={runAnalysis}
                        disabled={analyzeStatus === 'running' || !localPath || !selectedModelId}
                        className="w-full btn-primary flex items-center justify-center gap-2"
                    >
                        {analyzeStatus === 'running' ? (
                            <>
                                <Loader2 size={16} className="animate-spin" /> Watching the video…
                            </>
                        ) : (
                            <>
                                <Wand2 size={16} />
                                {clipperMode === 'pro' ? 'Run Pro analysis with ' : 'Find viral moments with '}
                                {selectedModel?.label || '…'}
                            </>
                        )}
                    </button>

                    {analyzeError && (
                        <div className="mt-3 text-[12px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md p-2.5">
                            {analyzeError}
                        </div>
                    )}
                </section>

                </>
                )}
                {/* end of SETUP STEPS gate */}

                {/* PROCESSING / RESULTS — split-pane layout matching the
                    Generate Clips processing UI. Big silent video preview
                    top-left with scan HUD overlay; rolling activity log
                    underneath; results card grid on the right. Same shell
                    serves both the running and done states — only the
                    right pane and the HUD label change. */}
                {(analyzeStatus === 'running' || analyzeStatus === 'done') && (
                    <ProcessingSplitView
                        // ProcessingAnimation expects a `media` prop in
                        // the same shape the rest of Klipra uses for its
                        // processing UI: { type, payload, previewBlob }.
                        // For the local-file path that's the File blob.
                        previewMedia={
                            localFileBlob
                                ? { type: 'local', payload: localPath, previewBlob: localFileBlob }
                                : null
                        }
                        isRunning={analyzeStatus === 'running'}
                        modelLabel={selectedModel?.label || ''}
                        logs={logs}
                        logsEndRef={logsEndRef}
                        picks={picks}
                        pickerMeta={pickerMeta}
                        onPlayPick={playPick}
                        onBack={backToSetup}
                        onSaveProject={onSaveProject}
                        savedProjectId={savedProjectId}
                        // Sync-playback wiring — ProcessingAnimation's
                        // own effect seeks the <video> when these props
                        // change, so clicking 👁 on a pick triggers a
                        // jump-to-timestamp inside the preview.
                        syncedTime={syncedTime}
                        isSyncedPlaying={isSyncedPlaying}
                        syncTrigger={syncTrigger}
                        // Cut clips — populated by cutClipsForPicks
                        // after analyze. Each entry has .index + .url
                        // so we can match against picks[i] and render
                        // a playable <video controls> per pick.
                        cutClips={cutClips}
                        cuttingStatus={cuttingStatus}
                        cuttingError={cuttingError}
                        batchJobId={batchJobId}
                        // BYOK keys passed straight through to
                        // ResultCard so the Subtitle / Dub / Edit
                        // modals it owns have the right credentials.
                        uploadPostKey={uploadPostKey}
                        uploadUserId={uploadUserId}
                        geminiApiKey={geminiApiKey}
                        llmConfig={llmConfig}
                        elevenLabsKey={elevenLabsKey}
                    />
                )}
            </div>
        </div>
    );
}

// =====================================================================
// ProcessingSplitView
// ---------------------------------------------------------------------
// The "watching the video" / results layout. Mirrors the Generate Clips
// processing screen so users get familiar visual feedback during the
// multi-minute multimodal picker run instead of a static spinner.
// =====================================================================
function ProcessingSplitView({
    previewMedia, isRunning, modelLabel,
    logs, logsEndRef, picks, pickerMeta, onPlayPick, onBack,
    onSaveProject, savedProjectId,
    syncedTime, isSyncedPlaying, syncTrigger,
    cutClips, cuttingStatus, cuttingError, batchJobId,
    uploadPostKey, uploadUserId, geminiApiKey, llmConfig, elevenLabsKey,
}) {
    // Layout mode — when analysis is done AND clips are cut, default
    // to "expanded" so the clip grid uses the whole screen width.
    // While running OR mid-cut we stay in split view so the user sees
    // the preview + logs.
    const [layoutMode, setLayoutMode] = React.useState('split'); // 'split' | 'expanded'
    React.useEffect(() => {
        if (cuttingStatus === 'done' && cutClips.length > 0) {
            setLayoutMode('expanded');
        } else if (isRunning || cuttingStatus === 'cutting') {
            setLayoutMode('split');
        }
    }, [cuttingStatus, cutClips.length, isRunning]);
    return (
        <div className="space-y-4">
            {/* Top bar — back button + status pill */}
            <div className="flex items-center justify-between">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1.5 text-[12px] text-zinc-300 hover:text-white px-3 py-1.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition"
                >
                    <ChevronLeft size={14} /> Back to setup
                </button>
                <div className="flex items-center gap-2">
                    {/* Layout toggle — shows once analysis is done so the
                        user can either expand the clip grid full-width
                        or fall back to the split-pane view to compare
                        a pick to the source. */}
                    {!isRunning && cutClips && cutClips.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setLayoutMode((m) => (m === 'expanded' ? 'split' : 'expanded'))}
                            className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition"
                            title={layoutMode === 'expanded' ? 'Show source preview again' : 'Hide preview and expand clips'}
                        >
                            {layoutMode === 'expanded' ? '⤡ Show preview' : '⤢ Expand clips'}
                        </button>
                    )}
                    <div
                        className={
                            'inline-flex items-center gap-2 px-3 py-1.5 rounded-md font-mono text-[11px] uppercase tracking-wider border ' +
                            (isRunning
                                ? 'bg-violet-500/10 border-violet-500/40 text-violet-200 animate-pulse'
                                : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300')
                        }
                    >
                        {isRunning ? (
                            <><Activity size={12} className="animate-bounce" /> Processing</>
                        ) : (
                            <><CheckCircle2 size={12} /> Analysis complete</>
                        )}
                    </div>
                </div>
            </div>

            <div className={
                layoutMode === 'expanded'
                    ? 'grid grid-cols-1 gap-4'
                    : 'grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4'
            }>
                {/* LEFT — preview + log stack. Hidden when the user
                    has expanded the clip grid full-width. */}
                {layoutMode !== 'expanded' && (
                <div className="space-y-3">
                    {/* Use the EXACT same component the Generate Clips
                        flow uses for its in-progress preview. That gives
                        us identical visual behaviour — grayscale + dim
                        on rest, full colour on hover, scanning HUD,
                        analysis-complete state — without re-implementing
                        any of it. */}
                    <ProcessingAnimation
                        media={previewMedia}
                        isComplete={!isRunning}
                        llmConfig={{ provider: 'multimodal', model: modelLabel }}
                        syncedTime={syncedTime}
                        isSyncedPlaying={isSyncedPlaying}
                        syncTrigger={syncTrigger}
                    />

                    {/* Activity log */}
                    <div className="rounded-2xl border border-white/10 bg-black/60 overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 text-[10px] uppercase tracking-wider text-zinc-400 font-bold font-mono">
                            <Activity size={12} className="text-violet-300" /> System logs
                        </div>
                        <div className="p-3 max-h-56 overflow-y-auto custom-scrollbar font-mono text-[11px] text-zinc-300 leading-relaxed space-y-0.5">
                            {logs.length === 0 ? (
                                <div className="text-zinc-500">Starting…</div>
                            ) : (
                                logs.map((entry, i) => (
                                    <div key={i} className="flex gap-2">
                                        <span className="text-zinc-500 shrink-0">{entry.t}</span>
                                        <span className="text-zinc-200 break-words">{entry.line}</span>
                                    </div>
                                ))
                            )}
                            <div ref={logsEndRef} />
                        </div>
                    </div>
                </div>
                )}
                {/* end of LEFT column conditional */}

                {/* RIGHT — picks panel (or "waiting" placeholder) */}
                <div className="rounded-2xl border border-white/10 bg-surface/60 overflow-hidden flex flex-col">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                        <div>
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Viral moments</div>
                            <div className="text-sm font-bold text-white">
                                {isRunning && picks.length === 0 ? 'AI is thinking…' : `${picks.length} picked`}
                            </div>
                        </div>
                        {pickerMeta && (
                            <div className="text-[10px] text-zinc-500 text-right font-mono leading-tight">
                                <div className="truncate max-w-[10rem]">{pickerMeta.model}</div>
                                <div>{pickerMeta.frames} frames · {pickerMeta.elapsed}s</div>
                            </div>
                        )}
                    </div>

                    {/* Adaptive grid: each ResultCard wants ~520px to
                        breathe (vertical video + sidebar of buttons).
                        CSS auto-fit + minmax means the browser picks
                        1/2/3 columns based on the actual panel width
                        — never cramped regardless of screen size. */}
                    <div
                        className={
                            layoutMode === 'expanded'
                                ? 'flex-1 overflow-y-auto custom-scrollbar p-4 grid gap-4'
                                : 'flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2'
                        }
                        style={
                            layoutMode === 'expanded'
                                ? { gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))' }
                                : undefined
                        }
                    >
                        {/* Skeleton placeholders while running so the panel
                            doesn't look empty. They animate quietly to
                            mirror the activity on the left. */}
                        {isRunning && picks.length === 0 && (
                            <>
                                {[0, 1, 2].map((k) => (
                                    <div key={k} className="rounded-lg border border-white/10 bg-black/30 p-3 animate-pulse">
                                        <div className="h-3 bg-white/5 rounded w-1/3 mb-2" />
                                        <div className="h-4 bg-white/10 rounded w-3/4 mb-1.5" />
                                        <div className="h-3 bg-white/5 rounded w-2/3" />
                                    </div>
                                ))}
                                <div className="text-[11px] text-zinc-500 italic px-1">
                                    Picks will appear here as soon as the AI returns. Average wait: 30s–5min depending on model + video length.
                                </div>
                            </>
                        )}
                        {/* Once cuts are ready, render the SAME ResultCard
                            component Generate Clips uses — that gives
                            full feature parity (Subtitle / Dub / Edit /
                            Reframe / Post). The Smart Clipper backend
                            registered batchJobId in the jobs dict and
                            wrote a metadata.json in the standard shape,
                            so all of ResultCard's per-clip API calls
                            just work. */}
                        {cuttingStatus === 'done' && cutClips.length > 0 && batchJobId && (
                            cutClips.map((cl, i) => (
                                <ResultCard
                                    key={cl.video_url || i}
                                    clip={cl}
                                    index={i}
                                    jobId={batchJobId}
                                    uploadPostKey={uploadPostKey}
                                    uploadUserId={uploadUserId}
                                    geminiApiKey={geminiApiKey}
                                    llmConfig={llmConfig}
                                    elevenLabsKey={elevenLabsKey}
                                    onPlay={() => onPlayPick({ start: cl.start })}
                                    onPause={() => {}}
                                />
                            ))
                        )}
                        {/* While cutting OR pre-cut → small text card +
                            placeholder. ResultCard renders only AFTER
                            cuts exist so its modals always have a
                            playable mp4. */}
                        {cuttingStatus !== 'done' && picks.map((c, i) => (
                            <div key={i} className="rounded-lg border border-white/10 bg-black/30 overflow-hidden hover:border-white/20 transition">
                                {cuttingStatus === 'cutting' && (
                                    <div className="w-full aspect-video bg-black/60 flex items-center justify-center text-[11px] text-zinc-400">
                                        <Loader2 size={14} className="animate-spin mr-2" /> rendering clip…
                                    </div>
                                )}
                                <div className="p-3">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <div className="text-[11px] text-zinc-500 font-mono">
                                            {fmtTime(c.start)} → {fmtTime(c.end)} <span className="text-zinc-600">({(c.end - c.start).toFixed(1)}s)</span>
                                        </div>
                                        <button onClick={() => onPlayPick(c)} className="p-1 rounded hover:bg-white/10" title="Jump preview to this moment">
                                            <Eye size={14} className="text-emerald-300" />
                                        </button>
                                    </div>
                                    <div className="text-sm font-bold text-white leading-snug mb-1">
                                        {c.hook || `Clip ${i + 1}`}
                                    </div>
                                    {c.why_viral && (
                                        <div className="text-[11px] text-zinc-400 leading-relaxed">{c.why_viral}</div>
                                    )}
                                    {/* Per-signal "Why?" panel — only renders
                                        when the backend used the Signals
                                        rubric and the model emitted a
                                        signals dict. Otherwise hidden. */}
                                    <SignalBars
                                        signals={c.signals}
                                        rationale={c.signal_rationale}
                                    />
                                </div>
                            </div>
                        ))}
                        {cuttingStatus === 'error' && (
                            <div className="text-[11px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md p-2">
                                Could not cut clips: {cuttingError}
                            </div>
                        )}
                        {!isRunning && picks.length === 0 && (
                            <div className="text-amber-300/90 text-[12px] bg-amber-500/5 border border-amber-500/20 rounded-md p-3 space-y-2">
                                <div>
                                    The model returned no viral moments. Try a different model, lower the minimum duration, or pick a more dynamic source video.
                                </div>
                                {pickerMeta?.rawExcerpt && (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-zinc-300 hover:text-white text-[11px]">
                                            Show what the model actually returned
                                            {pickerMeta.rawLength ? ` (${pickerMeta.rawLength} chars)` : ''}
                                        </summary>
                                        <pre className="mt-2 max-h-72 overflow-auto bg-black/60 border border-white/10 rounded p-2 text-[10px] text-zinc-300 whitespace-pre-wrap break-words font-mono">
{pickerMeta.rawExcerpt}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        )}
                    </div>

                    {!isRunning && picks.length > 0 && (
                        <div className="border-t border-white/5 px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
                            <button
                                type="button"
                                onClick={onSaveProject}
                                disabled={!!savedProjectId}
                                className={
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold transition '
                                    + (savedProjectId
                                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 cursor-default'
                                        : 'bg-violet-500 hover:bg-violet-400 text-white')
                                }
                            >
                                {savedProjectId ? <><CheckCircle2 size={12} /> Saved</> : <>💾 Save project</>}
                            </button>
                            <span className="text-[10px] text-zinc-500">
                                Next step (coming soon): one-click cut each pick into a vertical 9:16 mp4.
                            </span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * ContentTypeRouter — banner at the top of Smart Clipper's setup
 * page that helps users self-route to the right product. Smart
 * Clipper is best for VISUAL content (vlogs, reactions, on-camera
 * interviews); Generate Clips is best for AUDIO-HEAVY content
 * (podcasts, music, off-camera interviews). The router is purely
 * advisory — users can ignore it. Dismissing it persists in
 * localStorage so it doesn't nag returning users.
 */
/**
 * SignalBars — collapsed "Why?" panel that shows the picker's six
 * per-signal scores when the Signals rubric was used. Renders nothing
 * when the clip is unscored (Classic rubric, or the model omitted
 * `signals` from its response). Expand-on-click so quiet clips don't
 * eat vertical space.
 *
 * Each signal is shown as a horizontal bar 0-100%, color-coded by
 * intensity. The model's per-signal rationale (if any) sits at the
 * bottom in muted text.
 *
 * The six signals are deliberately fixed-order — same order as
 * SIGNAL_RUBRIC in multimodal_picker.py — so the user can A/B compare
 * clips by glancing at the bar stack without re-reading labels.
 */
function SignalBars({ signals, rationale }) {
    const [open, setOpen] = useState(false);
    if (!signals || typeof signals !== 'object') return null;
    const order = ['punchline', 'reversal', 'awkward_pause',
                   'one_liner', 'audio_peak', 'visual_energy'];
    const present = order.filter((k) => typeof signals[k] === 'number');
    if (!present.length) return null;
    const max = Math.max(...present.map((k) => signals[k] || 0));
    const labelMap = {
        punchline: 'Punchline',
        reversal: 'Reversal',
        awkward_pause: 'Awkward pause',
        one_liner: 'One-liner',
        audio_peak: 'Audio peak',
        visual_energy: 'Visual energy',
    };
    return (
        <div className="mt-2 text-[10px]">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-300"
            >
                {open ? '▾' : '▸'} Why this clip?
                <span className="ml-1 text-zinc-600">top signal: {labelMap[present.find((k) => signals[k] === max)] || '—'} ({Math.round(max * 100)}%)</span>
            </button>
            {open && (
                <div className="mt-1.5 space-y-1 bg-black/40 border border-white/5 rounded-md p-2">
                    {order.map((k) => {
                        const v = typeof signals[k] === 'number' ? signals[k] : null;
                        const pct = v == null ? 0 : Math.max(0, Math.min(1, v));
                        // Color ramp: <0.3 zinc, <0.6 amber, <0.8 violet, ≥0.8 emerald.
                        const tone =
                            v == null    ? 'bg-zinc-700'
                            : pct >= 0.8 ? 'bg-emerald-400'
                            : pct >= 0.6 ? 'bg-violet-400'
                            : pct >= 0.3 ? 'bg-amber-400'
                            :              'bg-zinc-500';
                        return (
                            <div key={k} className="flex items-center gap-2">
                                <div className="w-24 text-zinc-400 shrink-0">{labelMap[k]}</div>
                                <div className="flex-1 h-1.5 bg-white/5 rounded overflow-hidden">
                                    <div
                                        className={'h-full ' + tone + ' transition-all'}
                                        style={{ width: `${pct * 100}%` }}
                                    />
                                </div>
                                <div className="w-10 text-right tabular-nums text-zinc-500">
                                    {v == null ? '—' : `${Math.round(pct * 100)}%`}
                                </div>
                            </div>
                        );
                    })}
                    {rationale && (
                        <div className="text-[10px] text-zinc-500 leading-snug pt-1 mt-1 border-t border-white/5 italic">
                            {rationale}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}


function ContentTypeRouter({ onChooseTab }) {
    const [dismissed, setDismissed] = useState(() => {
        try { return localStorage.getItem('klipra_smartclip_router_dismissed') === '1'; }
        catch { return false; }
    });
    const dismiss = () => {
        try { localStorage.setItem('klipra_smartclip_router_dismissed', '1'); } catch {}
        setDismissed(true);
    };
    if (dismissed) return null;

    return (
        <section className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/5 to-transparent p-4 mb-2">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-violet-300 font-bold mb-1">
                        Pick the right tool
                    </div>
                    <div className="text-sm text-zinc-200">
                        Smart Clipper analyses your video frames + transcript. For some content types the classic text-only Generate Clips works better — quick triage:
                    </div>
                </div>
                <button onClick={dismiss} className="text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5">
                    Dismiss
                </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                    type="button"
                    onClick={dismiss}
                    className="text-left rounded-lg border border-violet-500/40 bg-violet-500/10 p-3 hover:bg-violet-500/15 transition"
                    title="Stay on Smart Clipper"
                >
                    <div className="flex items-center gap-1.5 mb-1">
                        <Brain size={14} className="text-violet-300" />
                        <div className="text-sm font-bold text-white">Visual content</div>
                        <span className="text-[10px] text-violet-300 ml-auto">→ here</span>
                    </div>
                    <div className="text-[11px] text-zinc-400 leading-snug">
                        Vlogs, on-camera interviews, reactions, sports, anything with face / motion / scene cuts.
                    </div>
                </button>
                <button
                    type="button"
                    onClick={() => onChooseTab && onChooseTab('dashboard')}
                    className="text-left rounded-lg border border-white/10 bg-black/30 p-3 hover:border-white/20 transition"
                    title="Switch to Generate Clips"
                >
                    <div className="flex items-center gap-1.5 mb-1">
                        <Sparkles size={14} className="text-primary" />
                        <div className="text-sm font-bold text-white">Audio-heavy</div>
                        <span className="text-[10px] text-primary ml-auto">→ Generate Clips</span>
                    </div>
                    <div className="text-[11px] text-zinc-400 leading-snug">
                        Podcasts, music, voiceover, off-camera interviews. Text picker reads transcript, picks beats by words.
                    </div>
                </button>
                <button
                    type="button"
                    onClick={dismiss}
                    className="text-left rounded-lg border border-white/10 bg-black/30 p-3 hover:border-white/20 transition"
                    title="Stay on Smart Clipper"
                >
                    <div className="flex items-center gap-1.5 mb-1">
                        <Wand2 size={14} className="text-zinc-300" />
                        <div className="text-sm font-bold text-white">Not sure</div>
                        <span className="text-[10px] text-zinc-500 ml-auto">→ try this first</span>
                    </div>
                    <div className="text-[11px] text-zinc-400 leading-snug">
                        Mixed content or you're new — start with Smart Clipper, switch later if results feel off.
                    </div>
                </button>
            </div>
        </section>
    );
}

function NumberInput({ label, value, setValue, min, max }) {
    return (
        <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">{label}</div>
            <input
                type="number"
                min={min}
                max={max}
                value={value}
                onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!Number.isNaN(n)) setValue(Math.max(min, Math.min(max, n)));
                }}
                className="w-full bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-primary/50"
            />
        </label>
    );
}

function fmtTime(secs) {
    const s = Math.max(0, Number(secs) || 0);
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(1);
    return `${m}:${String(r).padStart(4, '0')}`;
}
