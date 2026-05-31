/**
 * MotionGraphicsModal — AI-generated motion graphics + SFX.
 *
 * DEFAULT (Auto mode): one-click. The modal opens, immediately fires
 * a single POST with auto=true, the backend generates a face-aware
 * plan AND renders it in the same request, and the modal closes
 * itself when the new mp4 is ready. No toggling, no second click.
 *
 * Advanced (Customize mode): click "Customize events" to drop into
 * the original two-phase flow — preview the plan, toggle events
 * on/off, optionally tweak with a style hint, then apply.
 *
 * Either way the backend runs face detection on the clip and steers
 * overlays away from the speaker's face so text never covers a face.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    X, Sparkles, Loader2, RefreshCw, CheckCircle2, AlertTriangle,
    Wand2, Volume2, VolumeX, Music, Cpu, ChevronDown,
} from 'lucide-react';
import { getApiUrl } from '../config';

const TYPE_LABELS = {
    text_burst:      { label: 'Text burst',     emoji: '💥' },
    callout_box:     { label: 'Callout',        emoji: '📢' },
    emoji_burst:     { label: 'Emoji',          emoji: '😀' },
    highlight_strip: { label: 'Highlight bar',  emoji: '▬' },
};

// Compact provider list for the per-clip picker — matches ProviderPicker's
// FALLBACK_PROVIDERS so saved API keys roll over without re-entry.
const MG_PROVIDERS = [
    {
        id: 'gemini', name: 'Google Gemini',
        models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-pro'],
    },
    {
        id: 'ollama', name: 'Ollama (local, free)',
        models: ['llama3.2', 'qwen2.5', 'llama3.1', 'llama3.3', 'mistral', 'gemma2'],
    },
    {
        id: 'openai', name: 'OpenAI',
        models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    },
    {
        id: 'anthropic', name: 'Anthropic (Claude)',
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    },
    {
        id: 'openrouter', name: 'OpenRouter',
        models: ['google/gemma-3-27b-it:free', 'meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-r1:free'],
    },
    {
        id: 'groq', name: 'Groq',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    },
    {
        id: 'minimax', name: 'MiniMax',
        models: ['MiniMax-M2.7', 'MiniMax-M2.5'],
    },
];

// XOR scheme that ProviderPicker / KeyInput use — must match exactly so we
// can pull saved keys for any provider the user has already entered.
const MG_KEY_SALT = 'openshorts-llm-v1';
const mgDecodeKey = (b64) => {
    try {
        const raw = atob(b64);
        let out = '';
        for (let i = 0; i < raw.length; i++) {
            out += String.fromCharCode(raw.charCodeAt(i) ^ MG_KEY_SALT.charCodeAt(i % MG_KEY_SALT.length));
        }
        return out;
    } catch { return ''; }
};
const mgLoadStoredKey = (providerId) => {
    try {
        const v = localStorage.getItem(`os_llm_key_${providerId}`);
        return v ? mgDecodeKey(v) : '';
    } catch { return ''; }
};

// Per-clip override persistence. Each clip has its own (provider, model)
// remembered across page reloads, so swapping AI on Clip 3 doesn't change
// Clip 4. We DON'T persist the API key per-clip — keys live globally per
// provider in os_llm_key_<provider> (which ProviderPicker manages).
const mgClipPrefKey = (jobId, clipIndex) => `mg_llm_pref_${jobId}_${clipIndex}`;
const mgLoadClipPref = (jobId, clipIndex) => {
    try {
        const raw = localStorage.getItem(mgClipPrefKey(jobId, clipIndex));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
};
const mgSaveClipPref = (jobId, clipIndex, provider, model) => {
    try {
        localStorage.setItem(
            mgClipPrefKey(jobId, clipIndex),
            JSON.stringify({ provider, model }),
        );
    } catch { /* quota / private mode — ignore */ }
};

const SFX_LABELS = {
    pop:            'Pop',
    whoosh:         'Whoosh',
    impact:         'Impact',
    ding:           'Ding',
    riser:          'Riser',
    reverse_whoosh: 'Reverse whoosh',
};

const POSITION_LABELS = {
    'center':        'Center',
    'top-center':    'Top center',
    'top-left':      'Top left',
    'top-right':     'Top right',
    'bottom-center': 'Bottom center',
    'bottom-left':   'Bottom left',
    'bottom-right':  'Bottom right',
    'left':          'Middle left',
    'right':         'Middle right',
};

export default function MotionGraphicsModal({
    open,
    onClose,
    jobId,
    clipIndex,
    clipDuration = 30,
    aspect = '9:16',
    llmHeaders,
    onApplied,
}) {
    // 'auto' is the default: open → run → close, no toggles.
    // 'customize' drops into the original review-and-toggle flow.
    const [mode, setMode] = useState('auto');
    // auto-mode status: idle|running|done|error
    const [autoStatus, setAutoStatus] = useState('idle');
    const [autoStep, setAutoStep] = useState(''); // friendly progress label
    const [planStatus, setPlanStatus] = useState('idle'); // idle|loading|loaded|error
    const [planError, setPlanError] = useState('');
    const [events, setEvents] = useState([]);
    const [enabledIndices, setEnabledIndices] = useState({});  // {0:true, 1:false}
    const [styleHint, setStyleHint] = useState('');
    const [applying, setApplying] = useState(false);
    const [appliedUrl, setAppliedUrl] = useState('');

    // TRANSCRIPT — when set, gets passed to the LLM as primary context.
    // Uses the SAME /api/clip/regenerate-transcript endpoint as the
    // Subtitle modal, with the same 5-mode cleanup picker (Original,
    // Roman, Hinglish, Urglish, Translate) and target-language
    // dropdown. AI cleanup runs through the user's chosen LLM
    // (via X-LLM-* headers) so Whisper's mis-readings get corrected.
    const [transcriptMode, setTranscriptMode] = useState('auto'); // 'auto' | 'paste' | 'none'
    const [transcript, setTranscript] = useState('');
    const [transcriptStatus, setTranscriptStatus] = useState('idle'); // idle|loading|loaded|error
    const [transcriptError, setTranscriptError] = useState('');
    const [transcriptOpen, setTranscriptOpen] = useState(true);
    // cleanup_mode passed to /api/clip/regenerate-transcript:
    //   'auto'       = raw Whisper output, no AI cleanup
    //   'roman'      = transliterate to Roman/Latin
    //   'hinglish'   = Hindi → Roman, keep English words English
    //   'urglish'    = Urdu → Roman, keep English words English
    //   'translate'  = translate to `targetLanguage`
    // 'auto' WITH cleanup_intent='cleanup' would be a smart-only-clean
    // pass — we just pipe straight Whisper here since the existing
    // backend already does the auto-detect language.
    const [regenCleanupMode, setRegenCleanupMode] = useState('auto');
    const [regenTargetLang, setRegenTargetLang] = useState('en');

    // Per-clip AI model picker — overrides whatever the parent passed in
    // via llmHeaders. Persisted in localStorage so each clip remembers
    // its own choice across page reloads. Starts from the parent's
    // current provider/model the first time the modal opens.
    const initialProvider = (llmHeaders && llmHeaders['X-LLM-Provider']) || 'gemini';
    const initialModel = (llmHeaders && llmHeaders['X-LLM-Model']) || 'gemini-2.5-flash';
    const [clipProvider, setClipProvider] = useState(initialProvider);
    const [clipModel, setClipModel] = useState(initialModel);
    // Tracks whether the picker row is expanded. Expanded by default
    // so the user notices the model picker before clicking Apply Magic
    // (they can collapse it after they've made their choice).
    const [pickerOpen, setPickerOpen] = useState(true);
    // Live Ollama models fetched from the user's daemon — so the
    // dropdown only shows models they actually have installed.
    // Empty array = haven't fetched yet or none installed.
    const [ollamaInstalled, setOllamaInstalled] = useState([]);
    const [ollamaProbeStatus, setOllamaProbeStatus] = useState('idle'); // idle|loading|ok|nodaemon|nomodels

    // When the user picks Ollama, hit /api/providers (which the
    // backend already populates from the live `ollama list`) so we
    // can show their actually-installed models — and auto-snap the
    // model field to the first one if the saved one isn't there.
    //
    // refreshOllamaList() can be called manually (the refresh button
    // in the picker) with bustCache=true to bypass the 5s server-side
    // cache so newly-pulled models appear immediately.
    const refreshOllamaList = React.useCallback((bustCache = false) => {
        let alive = true;
        setOllamaProbeStatus('loading');
        const url = bustCache ? '/api/providers?refresh=1' : '/api/providers';
        fetch(getApiUrl(url))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('providers fetch failed'))))
            .then((list) => {
                if (!alive) return;
                const ol = (Array.isArray(list) ? list : []).find((p) => p.id === 'ollama');
                const installed = (ol && Array.isArray(ol.models)) ? ol.models : [];
                setOllamaInstalled(installed);
                if (!installed.length) {
                    setOllamaProbeStatus('nomodels');
                    return;
                }
                setOllamaProbeStatus('ok');
                // If the currently chosen model isn't actually installed,
                // snap to the first one that IS so the user doesn't hit
                // 404 on click. Exact match OR base-name match (so the
                // saved "qwen2.5" picks up "qwen2.5:14b" automatically).
                if (clipModel && !installed.some((m) => m === clipModel
                        || m.startsWith(clipModel + ':')
                        || clipModel.startsWith(m + ':'))) {
                    setClipModel(installed[0]);
                } else if (!clipModel) {
                    setClipModel(installed[0]);
                }
            })
            .catch(() => {
                if (!alive) return;
                setOllamaInstalled([]);
                setOllamaProbeStatus('nodaemon');
            });
        return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipModel]);

    useEffect(() => {
        if (!open || clipProvider !== 'ollama') return;
        return refreshOllamaList(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, clipProvider]);

    // On open / clip change: hydrate the per-clip override from
    // localStorage if one exists, otherwise inherit the parent's
    // current global choice.
    useEffect(() => {
        if (!open) return;
        const saved = mgLoadClipPref(jobId, clipIndex);
        if (saved && saved.provider) {
            setClipProvider(saved.provider);
            setClipModel(saved.model || '');
        } else {
            setClipProvider(initialProvider);
            setClipModel(initialModel);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, jobId, clipIndex]);

    // Persist any change so the choice survives modal close + reopen.
    useEffect(() => {
        if (!open) return;
        mgSaveClipPref(jobId, clipIndex, clipProvider, clipModel);
    }, [open, jobId, clipIndex, clipProvider, clipModel]);

    // Build the headers we actually send. We overlay the per-clip choice
    // on top of whatever the parent gave us, and freshly look up the
    // stored API key for the chosen provider (so switching from Gemini
    // to OpenAI doesn't send the Gemini key).
    const effectiveLlmHeaders = useMemo(() => {
        const base = { ...(llmHeaders || {}) };
        const storedKey = mgLoadStoredKey(clipProvider);
        return {
            ...base,
            'X-LLM-Provider': clipProvider,
            'X-LLM-Model': clipModel || initialModel,
            'X-LLM-Key': storedKey || (clipProvider === initialProvider ? (base['X-LLM-Key'] || '') : ''),
            'X-Gemini-Key': clipProvider === 'gemini'
                ? (storedKey || base['X-Gemini-Key'] || '')
                : '',
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [llmHeaders, clipProvider, clipModel]);

    const currentProviderInfo = MG_PROVIDERS.find((p) => p.id === clipProvider) || MG_PROVIDERS[0];
    const needsKey = clipProvider !== 'ollama';
    const hasKey = !!effectiveLlmHeaders['X-LLM-Key'];
    const keyStatusOk = !needsKey || hasKey;

    // When the picker changes mid-modal, reset to a clean state and
    // re-fetch with the new provider so the user immediately sees the
    // result from their new model.
    const handleChangeProvider = (pid) => {
        setClipProvider(pid);
        // Snap model to the first model of the new provider so the user
        // doesn't end up sending "claude-opus-4-6" to Gemini.
        const next = MG_PROVIDERS.find((p) => p.id === pid);
        setClipModel(next?.models?.[0] || '');
    };

    /** Make sure we have a transcript before kicking off a Magic run.
     * - mode='auto':  fetch via Subtitle's regenerate-transcript
     *                 endpoint (using the picked cleanup_mode +
     *                 language) if we don't have one yet, otherwise
     *                 reuse the existing one.
     * - mode='paste': use whatever the user pasted (or empty).
     * - mode='none':  skip — send no transcript.
     * Returns the transcript text to use, or '' if mode is 'none'. */
    const ensureTranscriptBeforeRun = async () => {
        if (transcriptMode === 'none') return '';
        if (transcriptMode === 'paste') return (transcript || '').trim();
        // auto mode — reuse cached fetch result if we have one.
        if (transcript && transcript.trim()) return transcript.trim();
        // No transcript yet. Fetch inline so the user sees the
        // "Transcribing your clip…" step before the AI step.
        // We MUST grab the result from the response — React state
        // updates aren't visible in the same tick.
        setAutoStep(regenCleanupMode === 'translate'
            ? `Transcribing + translating to ${regenTargetLang}…`
            : (regenCleanupMode === 'auto'
                ? 'Transcribing your clip with Whisper…'
                : `Transcribing + cleaning (${regenCleanupMode})…`));
        try {
            const r = await fetch(
                getApiUrl('/api/clip/regenerate-transcript'),
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...effectiveLlmHeaders,
                    },
                    body: JSON.stringify({
                        job_id: jobId,
                        clip_index: clipIndex,
                        cleanup_mode: regenCleanupMode,
                        target_language: regenCleanupMode === 'translate' ? regenTargetLang : null,
                    }),
                },
            );
            if (!r.ok) return '';
            const data = await r.json();
            const segs = Array.isArray(data.segments) ? data.segments : [];
            let text = '';
            if (segs.length) {
                text = segs
                    .map((s) => {
                        const t = (s.text || '').trim();
                        if (!t) return '';
                        return `[${(s.start || 0).toFixed(1)}-${(s.end || 0).toFixed(1)}s] ${t}`;
                    })
                    .filter(Boolean)
                    .join('\n');
            }
            if (!text) text = (data.text || '').trim();
            // Surface it in the picker UI too so a user who clicks
            // through fast still sees what got sent to the AI.
            setTranscript(text);
            setTranscriptStatus('loaded');
            return text;
        } catch { return ''; }
    };

    /** One-shot auto run: POST auto=true, backend generates+renders. */
    const runAuto = async () => {
        setAutoStatus('running');
        setAutoStep('Preparing transcript and detecting faces…');
        setPlanError('');
        try {
            // Make sure we have transcript context first (cached, sliced,
            // or fresh-transcribed) before we burn an LLM call.
            const transcriptText = await ensureTranscriptBeforeRun();
            // Friendly progress text — purely cosmetic since the actual
            // request is a single POST. We rotate hints while the
            // backend works so the user has something to look at.
            const hints = [
                'AI is reading the transcript…',
                'Picking zoom + glitch + color moments…',
                'Designing text overlays + sound effects…',
                'Rendering the new clip…',
            ];
            let hintIdx = 0;
            setAutoStep(hints[0]);
            const timer = setInterval(() => {
                hintIdx = (hintIdx + 1) % hints.length;
                setAutoStep(hints[hintIdx]);
            }, 2200);

            const r = await fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/motion-graphics`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...effectiveLlmHeaders },
                body: JSON.stringify({
                    aspect,
                    style_hint: '',
                    auto: true,
                    transcript: transcriptText,
                }),
            });
            clearInterval(timer);
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            if (!data.rendered) {
                // Backend returned a plan but couldn't render it (e.g.
                // empty events list). Surface a helpful error.
                throw new Error(
                    data.plan && data.plan.error
                        ? `AI couldn't propose any overlays: ${data.plan.error}`
                        : 'The AI returned an empty plan. Try again or switch to Customize mode.'
                );
            }
            setAppliedUrl(data.clip_url || '');
            if (typeof onApplied === 'function') onApplied(data);
            setAutoStatus('done');
            // Close after the success state so the user sees the ✓.
            setTimeout(() => onClose && onClose(), 900);
        } catch (e) {
            setAutoStatus('error');
            setPlanError(e.message || String(e));
        }
    };

    const fetchPlan = async () => {
        setPlanStatus('loading');
        setPlanError('');
        setEvents([]);
        try {
            const transcriptText = await ensureTranscriptBeforeRun();
            const r = await fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/motion-graphics`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...effectiveLlmHeaders },
                body: JSON.stringify({
                    aspect,
                    style_hint: styleHint,
                    regenerate: true,
                    transcript: transcriptText,
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            const evs = (data.plan && data.plan.events) || [];
            setEvents(evs);
            // Default-enable every event.
            const defs = {};
            evs.forEach((_, i) => { defs[i] = true; });
            setEnabledIndices(defs);
            setPlanStatus('loaded');
            if (data.plan && data.plan.error) {
                setPlanError(data.plan.error);
            }
        } catch (e) {
            setPlanStatus('error');
            setPlanError(e.message || String(e));
        }
    };

    useEffect(() => {
        if (!open) return;
        // Reset state on open — but DON'T auto-run. The user might
        // want to switch AI model first (e.g. Gemini quota hit → pick
        // Ollama). Wait for them to click the "Apply Magic" button.
        setAutoStatus('idle');
        setPlanStatus('idle');
        setPlanError('');
        setAppliedUrl('');
        setEvents([]);
        setPickerOpen(true);
        // Reset transcript so each open of the modal starts fresh.
        // We don't auto-fetch — the user explicitly opts in via mode
        // or by clicking "Fetch now" below.
        setTranscript('');
        setTranscriptStatus('idle');
        setTranscriptError('');
        setTranscriptMode('auto');
        setTranscriptOpen(true);
        setRegenCleanupMode('auto');
        setRegenTargetLang('en');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, jobId, clipIndex, mode]);

    // Fetch the clip's transcript via the SAME endpoint the Subtitle
    // modal's Regenerate uses (/api/clip/regenerate-transcript). This
    // re-runs Whisper on JUST this clip's audio and optionally pipes
    // the result through the user's chosen LLM for cleanup —
    //   'auto'      → raw Whisper, no AI cleanup
    //   'roman'     → transliterate Hindi/Urdu/Arabic to Latin
    //   'hinglish'  → Hindi → Roman, keep English words English
    //   'urglish'   → Urdu → Roman, keep English words English
    //   'translate' → translate to the chosen target language
    // The same X-LLM-* headers we use for AI Magic are sent here, so
    // whichever AI you picked (Ollama qwen3:32b, Gemini, etc.) does
    // the cleanup. Returns segments[{start,end,text}] which we then
    // join into the timestamped string the Magic prompt expects.
    const fetchTranscript = React.useCallback(async () => {
        setTranscriptStatus('loading');
        setTranscriptError('');
        try {
            const r = await fetch(
                getApiUrl('/api/clip/regenerate-transcript'),
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...effectiveLlmHeaders,
                    },
                    body: JSON.stringify({
                        job_id: jobId,
                        clip_index: clipIndex,
                        cleanup_mode: regenCleanupMode,
                        target_language: regenCleanupMode === 'translate' ? regenTargetLang : null,
                    }),
                },
            );
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            // Build the timestamped string the Motion Graphics prompt
            // expects. If the backend gave us segments use those (with
            // timing), otherwise fall back to the plain text blob.
            const segs = Array.isArray(data.segments) ? data.segments : [];
            let text = '';
            if (segs.length) {
                text = segs
                    .map((s) => {
                        const t = (s.text || '').trim();
                        if (!t) return '';
                        return `[${(s.start || 0).toFixed(1)}-${(s.end || 0).toFixed(1)}s] ${t}`;
                    })
                    .filter(Boolean)
                    .join('\n');
            }
            if (!text) text = (data.text || '').trim();
            setTranscript(text);
            setTranscriptStatus('loaded');
        } catch (e) {
            setTranscriptStatus('error');
            setTranscriptError(e.message || String(e));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobId, clipIndex, regenCleanupMode, regenTargetLang, effectiveLlmHeaders]);

    const toggleEvent = (i) => {
        setEnabledIndices((prev) => ({ ...prev, [i]: !prev[i] }));
    };

    const apply = async () => {
        setApplying(true);
        setPlanError('');
        try {
            const chosen = events.filter((_, i) => enabledIndices[i]);
            if (!chosen.length) {
                throw new Error('Pick at least one event to apply.');
            }
            const r = await fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/motion-graphics`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...effectiveLlmHeaders },
                body: JSON.stringify({ plan: { events: chosen }, aspect }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setAppliedUrl(data.clip_url || '');
            if (typeof onApplied === 'function') onApplied(data);
            // Auto-close after a short success state so the user has time
            // to see the ✓.
            setTimeout(() => onClose && onClose(), 900);
        } catch (e) {
            setPlanError(e.message || String(e));
        } finally {
            setApplying(false);
        }
    };

    if (!open) return null;

    const enabledCount = Object.values(enabledIndices).filter(Boolean).length;

    return (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-violet-400/30 flex items-center justify-center">
                            <Sparkles size={18} className="text-violet-300" />
                        </div>
                        <div>
                            <div className="text-sm font-bold text-white">AI Motion Graphics + SFX</div>
                            <div className="text-[11px] text-zinc-500">
                                Clip {clipIndex + 1} · {Math.round(clipDuration)}s · {aspect}
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10">
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-4">
                    {/* PER-CLIP AI MODEL PICKER — collapsible. Keeps the
                        modal clean for one-click users but always one
                        click away when you need to switch (e.g. Gemini
                        quota hit → swap to Ollama). The choice is
                        remembered per-clip in localStorage. */}
                    <div className={
                        "rounded-lg border " +
                        (pickerOpen
                            ? "border-white/15 bg-black/40"
                            : "border-white/5 bg-black/20")
                    }>
                        <button
                            type="button"
                            onClick={() => setPickerOpen((v) => !v)}
                            className="w-full flex items-center justify-between px-3 py-2 text-left"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="w-6 h-6 rounded-md bg-violet-500/15 border border-violet-400/30 flex items-center justify-center shrink-0">
                                    <Cpu size={12} className="text-violet-300" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold leading-tight">
                                        AI model for this clip
                                    </div>
                                    <div className="text-[12px] text-white font-medium truncate">
                                        {currentProviderInfo?.name || clipProvider}
                                        <span className="text-zinc-500 mx-1.5">·</span>
                                        <span className="font-mono text-zinc-300">{clipModel || '—'}</span>
                                        {!keyStatusOk && (
                                            <span className="ml-2 text-[10px] text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded px-1.5 py-0.5">
                                                no key
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <ChevronDown
                                size={14}
                                className={"text-zinc-400 transition shrink-0 " + (pickerOpen ? "rotate-180" : "")}
                            />
                        </button>
                        {pickerOpen && (
                            <div className="px-3 pb-3 pt-1 border-t border-white/5 space-y-2">
                                <label className="block">
                                    <span className="block text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">
                                        Provider
                                    </span>
                                    <select
                                        value={clipProvider}
                                        onChange={(e) => handleChangeProvider(e.target.value)}
                                        className="w-full bg-black/50 border border-white/10 rounded-md py-1.5 px-2 text-[12px] text-white focus:outline-none focus:border-violet-500/50"
                                    >
                                        {MG_PROVIDERS.map((p) => (
                                            <option key={p.id} value={p.id} className="bg-zinc-900">
                                                {p.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">
                                        <span>Model</span>
                                        {clipProvider === 'ollama' && (
                                            <span className="flex items-center gap-2 normal-case tracking-normal">
                                                {ollamaProbeStatus === 'ok' && (
                                                    <span className="text-emerald-400">
                                                        {ollamaInstalled.length} installed
                                                    </span>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => refreshOllamaList(true)}
                                                    disabled={ollamaProbeStatus === 'loading'}
                                                    title="Re-check which models you have installed"
                                                    className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-white disabled:opacity-50"
                                                >
                                                    <RefreshCw size={10} className={ollamaProbeStatus === 'loading' ? 'animate-spin' : ''} />
                                                    <span className="text-[10px]">Refresh</span>
                                                </button>
                                            </span>
                                        )}
                                    </span>
                                    {/* On Ollama: dropdown of actually-installed models so the
                                        user can't pick one that 404s. Show a clean loading
                                        state while the probe runs so we never flash a
                                        misleading hardcoded list. On other providers: free-text
                                        input with autocomplete suggestions. */}
                                    {clipProvider === 'ollama' ? (
                                        ollamaProbeStatus === 'loading' || ollamaProbeStatus === 'idle' ? (
                                            <div className="w-full bg-black/30 border border-white/10 rounded-md py-1.5 px-2 text-[12px] text-zinc-400 font-mono inline-flex items-center gap-2">
                                                <Loader2 size={11} className="animate-spin" />
                                                Fetching installed Ollama models…
                                            </div>
                                        ) : ollamaInstalled.length > 0 ? (
                                            <select
                                                value={clipModel}
                                                onChange={(e) => setClipModel(e.target.value)}
                                                className="w-full bg-black/50 border border-white/10 rounded-md py-1.5 px-2 text-[12px] text-white font-mono focus:outline-none focus:border-violet-500/50"
                                            >
                                                {ollamaInstalled.map((m) => (
                                                    <option key={m} value={m} className="bg-zinc-900">{m}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <div className="w-full bg-black/30 border border-yellow-500/30 rounded-md py-1.5 px-2 text-[12px] text-yellow-200 font-mono">
                                                {ollamaProbeStatus === 'nodaemon'
                                                    ? 'Ollama daemon not reachable — open the Ollama app first'
                                                    : 'No Ollama models installed yet'}
                                            </div>
                                        )
                                    ) : (
                                        <input
                                            list={`mg-models-${clipProvider}`}
                                            value={clipModel}
                                            onChange={(e) => setClipModel(e.target.value)}
                                            placeholder={currentProviderInfo?.models?.[0] || ''}
                                            className="w-full bg-black/50 border border-white/10 rounded-md py-1.5 px-2 text-[12px] text-white font-mono focus:outline-none focus:border-violet-500/50"
                                        />
                                    )}
                                    <datalist id={`mg-models-${clipProvider}`}>
                                        {(currentProviderInfo?.models || []).map((m) => (
                                            <option key={m} value={m} />
                                        ))}
                                    </datalist>
                                </label>
                                <p className="text-[10px] text-zinc-500 leading-snug">
                                    {clipProvider === 'ollama'
                                        ? (ollamaProbeStatus === 'loading'
                                            ? 'Checking which models you have installed…'
                                            : ollamaProbeStatus === 'nodaemon'
                                              ? 'Could not reach the Ollama daemon at host.docker.internal:11434. Open the Ollama app on your Mac.'
                                              : ollamaProbeStatus === 'nomodels'
                                                ? 'Ollama is running but no models are installed. Double-click "Install-Ollama-Model.command" in your Klipra folder to install qwen2.5:14b (the recommended one for this task).'
                                                : 'Runs locally on your Mac — no API key needed, no quota. Recommended: qwen2.5 family for best results.')
                                        : keyStatusOk
                                          ? 'Using the API key you saved for this provider. Change it in the AI picker on the main page.'
                                          : 'No API key saved for this provider. Open the AI picker on the main page (top bar) to add one, or pick a free provider like Ollama.'}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* TRANSCRIPT SECTION — collapsible. Massively boosts
                        AI quality by anchoring events to actual spoken
                        moments instead of guessing from hook metadata.
                        Three modes: auto-generate, paste, none. */}
                    <div className={
                        "rounded-lg border " +
                        (transcriptOpen ? "border-white/15 bg-black/40" : "border-white/5 bg-black/20")
                    }>
                        <button
                            type="button"
                            onClick={() => setTranscriptOpen((v) => !v)}
                            className="w-full flex items-center justify-between px-3 py-2 text-left"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="w-6 h-6 rounded-md bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center shrink-0">
                                    <Music size={12} className="text-emerald-300" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold leading-tight">
                                        Transcript for AI context
                                    </div>
                                    <div className="text-[12px] text-white font-medium truncate">
                                        {transcriptMode === 'none' && 'No transcript (use clip metadata only)'}
                                        {transcriptMode === 'paste' && (transcript
                                            ? `Pasted (${transcript.length} chars)`
                                            : 'Paste manually — empty')}
                                        {transcriptMode === 'auto' && (transcript
                                            ? `Auto-generated (${transcriptSource || 'ready'})`
                                            : 'Auto-generate when you click Apply Magic')}
                                    </div>
                                </div>
                            </div>
                            <ChevronDown
                                size={14}
                                className={"text-zinc-400 transition shrink-0 " + (transcriptOpen ? "rotate-180" : "")}
                            />
                        </button>
                        {transcriptOpen && (
                            <div className="px-3 pb-3 pt-1 border-t border-white/5 space-y-2">
                                {/* Three radio-style mode buttons */}
                                <div className="flex items-center gap-1.5">
                                    {[
                                        { id: 'auto', label: 'Auto-generate', hint: 'Uses Whisper (free, cached after first run)' },
                                        { id: 'paste', label: 'Paste manually', hint: 'You provide the transcript text' },
                                        { id: 'none', label: 'None', hint: 'Use hook/description only' },
                                    ].map((opt) => (
                                        <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => setTranscriptMode(opt.id)}
                                            title={opt.hint}
                                            className={
                                                'flex-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition ' +
                                                (transcriptMode === opt.id
                                                    ? 'border-emerald-500/50 bg-emerald-500/10 text-white'
                                                    : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                                            }
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>

                                {/* AUTO MODE — same Regenerate flow the Subtitle modal uses:
                                    re-runs Whisper on this clip's audio, then optionally
                                    pipes the result through the chosen AI for cleanup.
                                    Five-button picker for output language/script + target
                                    language dropdown when Translate is chosen. */}
                                {transcriptMode === 'auto' && (
                                    <div className="space-y-2">
                                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
                                            Output language / script
                                        </div>
                                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                                            {[
                                                ['auto',      'Original',  'Keep the source language as Whisper transcribed it (e.g. Urdu, Hindi).'],
                                                ['roman',     'Roman',     'Transliterate everything into Roman/Latin. Same words, different script.'],
                                                ['hinglish',  'Hinglish',  'Hindi → Roman, English words and phrases stay in English.'],
                                                ['urglish',   'Urglish',   'Urdu → Roman, English words and phrases stay in English.'],
                                                ['translate', 'Translate', 'Translate to a target language using your AI.'],
                                            ].map(([m, lbl, hint]) => (
                                                <button
                                                    key={m}
                                                    type="button"
                                                    title={hint}
                                                    onClick={() => {
                                                        setRegenCleanupMode(m);
                                                        // Clear any cached transcript — mode changed.
                                                        setTranscript('');
                                                        setTranscriptStatus('idle');
                                                    }}
                                                    className={
                                                        'px-2 py-1.5 rounded text-[11px] font-medium transition ' +
                                                        (regenCleanupMode === m
                                                            ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-500/50'
                                                            : 'bg-black/30 text-zinc-300 border border-white/5 hover:border-white/20')
                                                    }
                                                >
                                                    {lbl}
                                                </button>
                                            ))}
                                        </div>

                                        {/* Target-language dropdown — only when Translate is picked */}
                                        {regenCleanupMode === 'translate' && (
                                            <select
                                                value={regenTargetLang}
                                                onChange={(e) => {
                                                    setRegenTargetLang(e.target.value);
                                                    setTranscript('');
                                                    setTranscriptStatus('idle');
                                                }}
                                                className="w-full bg-black/40 border border-white/10 rounded-md py-1.5 px-2 text-[12px] text-white focus:outline-none focus:border-emerald-500/50"
                                            >
                                                {[
                                                    ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
                                                    ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
                                                    ['ru', 'Russian'], ['zh', 'Chinese (Simplified)'],
                                                    ['ja', 'Japanese'], ['ko', 'Korean'],
                                                    ['hi', 'Hindi'], ['ur', 'Urdu'], ['ar', 'Arabic'],
                                                    ['tr', 'Turkish'], ['id', 'Indonesian'], ['vi', 'Vietnamese'],
                                                    ['th', 'Thai'], ['fa', 'Persian'], ['pl', 'Polish'],
                                                    ['nl', 'Dutch'], ['bn', 'Bengali'],
                                                ].map(([code, name]) => (
                                                    <option key={code} value={code} className="bg-zinc-900">{name}</option>
                                                ))}
                                            </select>
                                        )}

                                        <div className="flex items-center justify-between gap-2 pt-1">
                                            <button
                                                type="button"
                                                onClick={fetchTranscript}
                                                disabled={transcriptStatus === 'loading'}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 text-[11px] font-medium disabled:opacity-50"
                                            >
                                                {transcriptStatus === 'loading'
                                                    ? <Loader2 size={11} className="animate-spin" />
                                                    : <RefreshCw size={11} />}
                                                {transcript ? 'Regenerate transcript' : 'Generate transcript now'}
                                            </button>
                                            {transcriptStatus === 'loaded' && transcript && (
                                                <span className="text-[10px] text-emerald-400 inline-flex items-center gap-1">
                                                    <CheckCircle2 size={10} />
                                                    {regenCleanupMode === 'auto' ? 'Whisper' : `Whisper + ${regenCleanupMode}`}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[10px] text-zinc-500 leading-snug">
                                            {regenCleanupMode === 'auto'
                                                ? 'Re-runs Whisper on this clip. No AI cleanup — fastest option.'
                                                : regenCleanupMode === 'translate'
                                                    ? `Re-runs Whisper, then your AI translates to ${regenTargetLang.toUpperCase()}.`
                                                    : `Re-runs Whisper, then your AI cleans + transliterates to ${regenCleanupMode}.`}
                                            {' '}AI cleanup uses the model you picked below.
                                        </p>
                                        {transcript && transcriptStatus === 'loaded' && (
                                            <div className="max-h-40 overflow-y-auto rounded-md border border-white/5 bg-black/40 p-2 text-[11px] text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed">
                                                {transcript}
                                            </div>
                                        )}
                                        {transcriptStatus === 'error' && (
                                            <p className="text-[11px] text-red-300">Couldn't fetch: {transcriptError}</p>
                                        )}
                                    </div>
                                )}

                                {/* PASTE MODE — textarea */}
                                {transcriptMode === 'paste' && (
                                    <div className="space-y-1">
                                        <textarea
                                            value={transcript}
                                            onChange={(e) => setTranscript(e.target.value)}
                                            placeholder="Paste the clip's transcript here. Including timestamps in [0.0-1.5s] format gives the best results, but plain text also works."
                                            rows={6}
                                            className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2 text-[11px] text-white font-mono focus:outline-none focus:border-emerald-500/50 leading-relaxed"
                                        />
                                        <p className="text-[10px] text-zinc-500">
                                            Tip: copy from the Subtitle modal if you've already transcribed this clip there.
                                        </p>
                                    </div>
                                )}

                                {/* NONE MODE — explanation */}
                                {transcriptMode === 'none' && (
                                    <p className="text-[11px] text-zinc-500 leading-snug">
                                        The AI will only see this clip's hook + description.
                                        Quality will be noticeably lower — most events will feel generic
                                        and mis-timed. Pick Auto-generate for best results.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    {/* AUTO MODE — idle (waiting for user to click Apply Magic) */}
                    {mode === 'auto' && autoStatus === 'idle' && (
                        <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-violet-400/30 flex items-center justify-center mb-4">
                                <Sparkles size={26} className="text-violet-300" />
                            </div>
                            <div className="text-base font-bold text-white mb-1">
                                Ready when you are
                            </div>
                            <div className="text-[12px] text-zinc-400 max-w-sm mb-5">
                                Pick your AI model above, then click below.
                                Klipra will detect faces, design overlays + SFX, and
                                render the new clip in one go. Usually ~10–25 s.
                            </div>
                            <button
                                onClick={runAuto}
                                disabled={!keyStatusOk}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-violet-500 hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-violet-500/20"
                            >
                                <Wand2 size={14} />
                                Apply Magic
                            </button>
                            {!keyStatusOk && (
                                <div className="mt-3 text-[11px] text-yellow-300">
                                    No API key saved for {currentProviderInfo?.name}. Pick Ollama (no key needed) or open the AI picker on the main page to add one.
                                </div>
                            )}
                            <button
                                onClick={() => { setMode('customize'); }}
                                className="mt-5 text-[11px] text-zinc-400 hover:text-white underline"
                            >
                                Customize events instead →
                            </button>
                        </div>
                    )}

                    {/* CUSTOMIZE MODE — idle (waiting for user to click Generate plan) */}
                    {mode === 'customize' && planStatus === 'idle' && (
                        <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-violet-400/30 flex items-center justify-center mb-4">
                                <Sparkles size={26} className="text-violet-300" />
                            </div>
                            <div className="text-base font-bold text-white mb-1">
                                Customize mode
                            </div>
                            <div className="text-[12px] text-zinc-400 max-w-sm mb-5">
                                Pick your AI model above, then generate a plan.
                                You'll be able to toggle each overlay event on or
                                off before rendering.
                            </div>
                            <button
                                onClick={fetchPlan}
                                disabled={!keyStatusOk}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-violet-500 hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-violet-500/20"
                            >
                                <Sparkles size={14} />
                                Generate plan
                            </button>
                            {!keyStatusOk && (
                                <div className="mt-3 text-[11px] text-yellow-300">
                                    No API key saved for {currentProviderInfo?.name}. Pick Ollama (no key needed) or open the AI picker on the main page to add one.
                                </div>
                            )}
                            <button
                                onClick={() => { setMode('auto'); }}
                                className="mt-5 text-[11px] text-zinc-400 hover:text-white underline"
                            >
                                ← Back to Auto Magic
                            </button>
                        </div>
                    )}

                    {/* AUTO MODE — running */}
                    {mode === 'auto' && autoStatus === 'running' && (
                        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                            <div className="relative mb-6">
                                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-violet-400/30 flex items-center justify-center">
                                    <Sparkles size={28} className="text-violet-300 animate-pulse" />
                                </div>
                                <Loader2
                                    size={72}
                                    className="absolute -top-2 -left-2 text-violet-400/40 animate-spin"
                                    style={{ animationDuration: '2.4s' }}
                                />
                            </div>
                            <div className="text-base font-bold text-white mb-1">
                                AI is making your clip pop
                            </div>
                            <div className="text-[12px] text-zinc-400 mb-4 min-h-[18px]">
                                {autoStep}
                            </div>
                            <div className="text-[11px] text-zinc-500 max-w-sm">
                                Detecting speakers' faces · placing text in safe zones · picking SFX · rendering. Usually ~10–25 s.
                            </div>
                            <button
                                onClick={() => { setMode('customize'); }}
                                className="mt-6 text-[11px] text-zinc-400 hover:text-white underline"
                            >
                                Customize events instead →
                            </button>
                        </div>
                    )}

                    {/* AUTO MODE — done */}
                    {mode === 'auto' && autoStatus === 'done' && (
                        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                            <div className="w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center mb-4">
                                <CheckCircle2 size={32} className="text-emerald-300" />
                            </div>
                            <div className="text-base font-bold text-white mb-1">
                                Magic applied
                            </div>
                            <div className="text-[12px] text-zinc-400">
                                Your clip is updating now…
                            </div>
                        </div>
                    )}

                    {/* AUTO MODE — error: offer retry + customize fallback */}
                    {mode === 'auto' && autoStatus === 'error' && (
                        <div className="space-y-3">
                            <div className="flex items-start gap-2 text-red-300 text-sm bg-red-500/5 border border-red-500/20 rounded-md p-3">
                                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                <div>
                                    <div className="font-bold mb-1">Auto magic failed</div>
                                    <div className="text-[12px] text-zinc-300">{planError}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 justify-center">
                                <button
                                    onClick={runAuto}
                                    className="px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-400 text-white text-[12px] font-bold inline-flex items-center gap-1.5"
                                >
                                    <RefreshCw size={12} /> Try again
                                </button>
                                <button
                                    onClick={() => setMode('customize')}
                                    className="px-3 py-1.5 rounded-md border border-white/10 hover:border-white/30 text-white text-[12px]"
                                >
                                    Customize manually
                                </button>
                            </div>
                        </div>
                    )}

                    {mode === 'customize' && planStatus === 'loading' && (
                        <div className="flex items-center justify-center py-12 text-zinc-400 text-sm">
                            <Loader2 size={16} className="animate-spin mr-2" />
                            AI is designing motion graphics for this clip…
                        </div>
                    )}

                    {mode === 'customize' && planStatus === 'error' && (
                        <div className="flex items-start gap-2 text-red-300 text-sm bg-red-500/5 border border-red-500/20 rounded-md p-3">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                            <div>
                                <div className="font-bold mb-1">Could not generate plan</div>
                                <div className="text-[12px] text-zinc-300">{planError}</div>
                            </div>
                        </div>
                    )}

                    {mode === 'customize' && planStatus === 'loaded' && events.length === 0 && (
                        <div className="text-center py-12 text-zinc-400 text-sm">
                            The AI didn't propose any overlays for this clip. Try regenerating with a style hint.
                        </div>
                    )}

                    {mode === 'customize' && planStatus === 'loaded' && events.length > 0 && (
                        <>
                            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">
                                Proposed events ({events.length})
                            </div>
                            <ul className="space-y-2">
                                {events.map((ev, i) => {
                                    const t = TYPE_LABELS[ev.type] || { label: ev.type, emoji: '✨' };
                                    const enabled = !!enabledIndices[i];
                                    return (
                                        <li key={i}>
                                            <label
                                                className={
                                                    'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition '
                                                    + (enabled
                                                        ? 'border-violet-500/40 bg-violet-500/5'
                                                        : 'border-white/10 bg-black/30 opacity-60')
                                                }
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={enabled}
                                                    onChange={() => toggleEvent(i)}
                                                    className="mt-1 accent-violet-500"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="text-base shrink-0">{t.emoji}</span>
                                                        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">
                                                            {t.label}
                                                        </span>
                                                        <span className="text-[10px] font-mono text-zinc-500">
                                                            {ev.start.toFixed(1)}s → {(ev.start + ev.duration).toFixed(1)}s
                                                        </span>
                                                        {ev.sfx ? (
                                                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">
                                                                <Volume2 size={10} /> {SFX_LABELS[ev.sfx] || ev.sfx}
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
                                                                <VolumeX size={10} /> silent
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-sm text-white font-medium break-words" style={{ color: ev.color }}>
                                                        {ev.content}
                                                    </div>
                                                    <div className="text-[10px] text-zinc-500 mt-0.5">
                                                        {POSITION_LABELS[ev.position] || ev.position}
                                                    </div>
                                                </div>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>

                            <div className="rounded-lg border border-white/5 bg-black/30 p-3">
                                <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1.5">
                                    Style hint (optional)
                                </div>
                                <input
                                    type="text"
                                    placeholder="e.g. minimal, only callouts; or chaotic, lots of bursts"
                                    value={styleHint}
                                    onChange={(e) => setStyleHint(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-violet-500/50"
                                />
                                <button
                                    type="button"
                                    onClick={fetchPlan}
                                    className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-zinc-300 hover:text-white"
                                >
                                    <RefreshCw size={12} /> Regenerate plan with this hint
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer — only shown in customize mode (auto mode has no footer) */}
                {mode === 'customize' && planStatus === 'loaded' && events.length > 0 && (
                    <div className="border-t border-white/5 px-5 py-3 flex items-center justify-between gap-3">
                        <div className="text-[11px] text-zinc-500">
                            {enabledCount} of {events.length} events enabled
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={onClose}
                                className="px-3 py-1.5 text-[12px] text-zinc-300 hover:text-white"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={apply}
                                disabled={applying || enabledCount === 0}
                                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-white text-[12px] font-bold"
                            >
                                {applying ? (
                                    <>
                                        <Loader2 size={12} className="animate-spin" /> Rendering…
                                    </>
                                ) : appliedUrl ? (
                                    <>
                                        <CheckCircle2 size={12} /> Applied
                                    </>
                                ) : (
                                    <>
                                        <Wand2 size={12} /> Apply to clip
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
