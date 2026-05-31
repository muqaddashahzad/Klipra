import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Check, Sparkles, ExternalLink, Info, DollarSign, Star, RefreshCw, AlertTriangle } from 'lucide-react';
import { getApiUrl } from '../config.js';

/**
 * Rough cost guide for a 10-minute video. These numbers are based on
 * each provider's published pricing and a typical pipeline run that
 * uses ~2.5K input tokens (transcript + prompt) and produces ~1K output
 * tokens (clip JSON), repeated ~3x across clip-pick + retransliterate +
 * subtitle translation. Real usage varies — these are order-of-magnitude
 * guides, not invoices.
 *
 * `quality` is our subjective rating for THIS use case (clip selection +
 * subtitle generation), not a generic LLM benchmark.
 */
const COST_GUIDE = {
    // Provider id → { perVideo: cost in USD for ~10 min, quality: 1-5, badge, note, affiliate }
    'gemini': {
        perVideo: 0.005,
        quality: 5,
        badge: 'Best free tier',
        note: 'Gemini 2.5 Flash is the cheapest serious model. Free tier covers ~50 videos/day at no cost.',
    },
    'openai': {
        perVideo: 0.18,
        quality: 5,
        badge: 'Premium quality',
        note: 'GPT-4o-mini is the sweet spot — accurate clip picks at ~$0.05/video. GPT-5 is best but pricier (~$0.30).',
    },
    'anthropic': {
        perVideo: 0.22,
        quality: 5,
        badge: 'Best hooks',
        note: 'Claude Sonnet 4.6 writes the most compelling clip titles + descriptions. Slightly pricier than Gemini.',
    },
    'openrouter': {
        perVideo: 0.00,
        quality: 4,
        badge: 'Free models available',
        note: 'Use ":free" model variants (gemma, deepseek-r1:free) at zero cost. Paid models route at OpenRouter\'s rates.',
    },
    'groq': {
        perVideo: 0.02,
        quality: 4,
        badge: 'Fastest',
        note: 'Llama 3.3 70B at 500+ tokens/sec. Generations finish in seconds instead of minutes.',
    },
    'minimax': {
        perVideo: 0.00,
        quality: 5,
        badge: 'Recommended (subscription)',
        note: 'MiniMax M2.7 is what we use day-to-day. The monthly subscription tier covers unlimited API calls — flat fee, no per-request charges.',
        affiliate: 'https://platform.minimax.io',  // <- TODO: replace with your affiliate link
        affiliateLabel: 'Get MiniMax (affiliate)',
        recommended: true,
    },
    'ollama': {
        perVideo: 0.00,
        quality: 3,
        badge: '$0 forever',
        note: 'Runs locally on your machine. Quality depends on which model you load (Llama 3.3 70B is good if you have the RAM).',
    },
};

/**
 * Compact AI provider/model picker for the dashboard front page.
 *
 * Why it exists separately from <KeyInput/> (which lives in Settings):
 *   - Settings is the "edit + test + read the docs" surface.
 *   - The front page just needs a "switch provider, paste key, go" affordance
 *     so people don't have to round-trip through Settings every time.
 *
 * Both components write to the SAME localStorage keys, so anything you set
 * here is immediately visible in Settings and gets used by every API
 * request (App.jsx reads `os_llm_pref_last` + `os_llm_key_<provider>` at
 * request time).
 *
 * Persistence note: once a provider's key is saved, it stays saved across
 * sessions until the user clears it (per-provider storage). Switching
 * provider auto-loads that provider's stored key — no re-typing needed.
 */
const FALLBACK_PROVIDERS = [
    {
        id: 'gemini', name: 'Google Gemini', requires_key: true,
        // Free-tier models first so users with a fresh aistudio.google.com
        // key (no billing) get something that works on submit. 2.5 Pro
        // and 1.5 Pro return 403 / quota errors on free-tier keys —
        // confusing for new users. Default = 1.5 Flash (most generous
        // free quota: 1500 req/day, 1M tokens/day).
        models: [
            'gemini-1.5-flash',   // FREE — generous, fast (recommended default)
            'gemini-2.5-flash',   // FREE — newer, tighter quota
            'gemini-2.0-flash',   // FREE — mid-generation
            'gemini-1.5-pro',     // PAID — best 1.5 quality
            'gemini-2.5-pro',     // PAID — top of stack
        ],
        default_model: 'gemini-1.5-flash',
        get_key_url: 'https://aistudio.google.com/apikey',
        notes: 'Free tier covers ~5 ten-minute videos/day. 1M+ context, native multimodal.',
    },
    {
        id: 'openai', name: 'OpenAI', requires_key: true,
        models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
        default_model: 'gpt-4o-mini',
        get_key_url: 'https://platform.openai.com/api-keys',
        notes: 'Strong structured-JSON output.',
    },
    {
        id: 'anthropic', name: 'Anthropic (Claude)', requires_key: true,
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
        default_model: 'claude-sonnet-4-6',
        get_key_url: 'https://console.anthropic.com/settings/keys',
        notes: 'Best hook + script writing quality.',
    },
    {
        id: 'openrouter', name: 'OpenRouter', requires_key: true,
        models: [
            'minimax/minimax-m2.5:free', 'google/gemma-3-27b-it:free',
            'meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-r1:free',
            'anthropic/claude-sonnet-4.6', 'openai/gpt-5', 'google/gemini-2.5-pro',
        ],
        default_model: 'minimax/minimax-m2.5:free',
        get_key_url: 'https://openrouter.ai/keys',
        notes: '100+ models with one key. ":free" variants need no billing.',
    },
    {
        id: 'groq', name: 'Groq', requires_key: true,
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        default_model: 'llama-3.3-70b-versatile',
        get_key_url: 'https://console.groq.com/keys',
        notes: 'Fastest inference.',
    },
    {
        id: 'minimax', name: 'MiniMax', requires_key: true,
        models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
        default_model: 'MiniMax-M2.7',
        get_key_url: 'https://platform.minimax.io',
        notes: 'Key from platform.minimax.io — not consumer subscription.',
    },
    {
        id: 'ollama', name: 'Ollama (local)', requires_key: false,
        models: [
            'qwen2.5:72b', 'qwen2.5:32b', 'qwen2.5:14b',
            'llama3.3', 'llama3.1', 'gemma2:27b', 'gemma2:9b', 'mistral',
        ],
        default_model: 'qwen2.5:72b',
        notes: 'Runs locally. Zero cost, no data leaves your machine. qwen2.5:72b is best for multilingual (Urdu/Hindi/Arabic).',
    },
];

// Same XOR scheme KeyInput uses — must match exactly so both components
// can read each other's saved keys.
const SALT = 'openshorts-llm-v1';
const xorEncode = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
    return btoa(out);
};
const xorDecode = (s) => {
    try {
        const raw = atob(s);
        let out = '';
        for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
        return out;
    } catch { return ''; }
};

const loadKey = (pid) => {
    const v = localStorage.getItem(`os_llm_key_${pid}`);
    return v ? xorDecode(v) : '';
};
const saveKey = (pid, key) => {
    if (key) localStorage.setItem(`os_llm_key_${pid}`, xorEncode(key));
};
const loadPref = () => {
    try {
        const v = localStorage.getItem('os_llm_pref_last');
        return v ? JSON.parse(v) : null;
    } catch { return null; }
};
const savePref = (p, m) => {
    localStorage.setItem('os_llm_pref_last', JSON.stringify({ provider: p, model: m }));
};

export default function ProviderPicker({ onChange }) {
    const [providers, setProviders] = useState(FALLBACK_PROVIDERS);
    const [open, setOpen] = useState(false);

    const [provider, setProvider] = useState(() => loadPref()?.provider || 'gemini');
    const [model, setModel] = useState(() => loadPref()?.model || 'gemini-2.5-flash');
    const [apiKey, setApiKey] = useState(() => loadKey(loadPref()?.provider || 'gemini'));
    const [showKey, setShowKey] = useState(false);
    const [savedFlash, setSavedFlash] = useState(false);

    const wrapRef = useRef(null);
    // Tracks the live-probe state for the Ollama picker so we can show
    // the user whether the daemon is reachable and how many models it
    // returned. Without this, "no models found" looks identical to
    // "Ollama not running" and the user has no way to debug.
    const [ollamaState, setOllamaState] = useState({
        status: 'idle',          // 'idle' | 'loading' | 'ok' | 'down'
        count: 0,
        lastChecked: null,
    });

    // Try the live catalog (same as KeyInput) so this picker stays in
    // sync if the backend adds a new provider.
    //
    // For Ollama specifically, the model list comes from the actual
    // running daemon (`ollama list`). If the user previously saved a
    // model that has since been removed (or was never installed), the
    // saved value would silently 404 on every test. Auto-correct: if
    // the persisted Ollama model isn't in the live list, fall back to
    // the first installed model and re-save the preference.
    //
    // Pulled into a named function so the refresh button in the
    // dropdown can re-run it after the user does `ollama pull <model>`
    // in their terminal — no page reload needed.
    const refreshCatalog = React.useCallback((opts = {}) => {
        const { force = false } = opts;
        setOllamaState((s) => ({ ...s, status: 'loading' }));
        const url = getApiUrl(`/api/providers${force ? '?refresh=1' : ''}`);
        return fetch(url)
            .then((r) => (r.ok ? r.json() : Promise.reject()))
            .then((list) => {
                if (!Array.isArray(list) || !list.length) return;
                setProviders(list);
                const ollama = list.find((p) => p.id === 'ollama');
                const live = (ollama && Array.isArray(ollama.models)) ? ollama.models : [];
                // If the live list looks like the static fallback (the
                // hardcoded suggestions like 'qwen2.5:72b'), the daemon
                // is almost certainly down. The backend returns the
                // static list as a fallback when /api/tags fails, so we
                // can't tell apart "0 installed" from "daemon dead" —
                // but for typical users, having ONLY the static suggestions
                // strongly implies the daemon never replied.
                const looksStatic = live.length > 0
                    && live.every((m) => /^(qwen2\.5|llama3|gemma2|mistral)/.test(m))
                    && !live.some((m) => m.includes(':latest'));
                setOllamaState({
                    status: looksStatic ? 'down' : (live.length > 0 ? 'ok' : 'down'),
                    count: live.length,
                    lastChecked: Date.now(),
                });
                // Snap to the first installed Ollama model if the
                // saved one is no longer available.
                const cur = list.find((p) => p.id === provider);
                if (cur && Array.isArray(cur.models) && cur.models.length > 0
                    && !cur.models.includes(model)) {
                    const next = cur.models[0];
                    console.log(`[ProviderPicker] Saved model "${model}" not in live list for ${provider}; switching to "${next}".`);
                    setModel(next);
                }
            })
            .catch(() => {
                setOllamaState({ status: 'down', count: 0, lastChecked: Date.now() });
            });
    }, [provider, model]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let alive = true;
        refreshCatalog({ force: false }).finally(() => { if (!alive) {/* noop */} });
        return () => { alive = false; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Close the dropdown when clicking outside.
    useEffect(() => {
        if (!open) return;
        const close = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [open]);

    // Persist + bubble up on every change so App.jsx state can mirror it.
    useEffect(() => {
        savePref(provider, model);
        if (apiKey) saveKey(provider, apiKey);
        onChange?.({ provider, model, api_key: apiKey });
    }, [provider, model, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const current = providers.find((p) => p.id === provider) || providers[0];
    const ok = apiKey || !current?.requires_key;

    const handleProviderClick = (pid) => {
        setProvider(pid);
        const next = providers.find((p) => p.id === pid);
        setModel(next?.default_model || next?.models?.[0] || '');
        setApiKey(loadKey(pid));
    };

    const handleSave = () => {
        if (apiKey) saveKey(provider, apiKey);
        savePref(provider, model);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
    };

    return (
        <div ref={wrapRef} className="relative inline-block">
            {/* Trigger chip — replaces the old read-only ActiveProviderBadge */}
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={
                    'inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-mono transition ' +
                    (ok
                        ? 'bg-green-500/10 border border-green-500/20 text-green-200 hover:bg-green-500/15'
                        : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-200 hover:bg-yellow-500/15')
                }
            >
                <Sparkles size={12} />
                <span className="text-zinc-500 uppercase tracking-wider not-italic">AI</span>
                <span className="font-bold">{current?.name?.split(' ')[0] || provider}</span>
                <span className="text-zinc-500">·</span>
                <span className="truncate max-w-[180px]">{model}</span>
                {!ok && <span className="text-yellow-300 ml-1">· no key</span>}
                <ChevronDown size={12} className={'transition ' + (open ? 'rotate-180' : '')} />
            </button>

            {/* Dropdown panel */}
            {open && (
                <div className="absolute z-50 mt-2 left-1/2 -translate-x-1/2 w-[min(92vw,560px)] rounded-2xl border border-white/10 bg-[#121214] shadow-2xl p-4 text-left">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h3 className="text-sm font-semibold text-white">AI provider</h3>
                            <p className="text-[11px] text-zinc-500 mt-0.5">Saved per-provider in this browser. Stays until you change it.</p>
                        </div>
                        {savedFlash && (
                            <span className="text-[11px] text-green-400 flex items-center gap-1"><Check size={12} /> Saved</span>
                        )}
                    </div>

                    {/* Provider tiles — compact 3-col grid with cost & quality */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mb-3">
                        {providers.map((p) => {
                            const hasKey = !!loadKey(p.id) || !p.requires_key;
                            const cost = COST_GUIDE[p.id] || {};
                            const isRecommended = !!cost.recommended;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => handleProviderClick(p.id)}
                                    className={
                                        'relative rounded-lg border px-2.5 py-2 text-left transition ' +
                                        (p.id === provider
                                            ? 'border-primary/60 bg-primary/10 text-white'
                                            : isRecommended
                                              ? 'border-amber-500/40 bg-amber-500/5 text-zinc-200 hover:border-amber-500/60'
                                              : 'border-white/5 bg-black/30 text-zinc-300 hover:border-white/15')
                                    }
                                >
                                    {isRecommended && (
                                        <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 rounded-full bg-amber-500 text-[8px] uppercase font-bold text-black tracking-wider">
                                            ★
                                        </span>
                                    )}
                                    <div className="text-xs font-medium truncate">{p.name}</div>
                                    <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center justify-between gap-1">
                                        <span>
                                            {hasKey
                                                ? <span className="text-green-400 inline-flex items-center gap-0.5"><Check size={9} /> Ready</span>
                                                : <span className="text-yellow-400/70">Needs key</span>}
                                        </span>
                                        {cost.perVideo !== undefined && (
                                            <span className="text-zinc-400 tabular-nums">
                                                {cost.perVideo === 0 ? 'free' : `~$${cost.perVideo.toFixed(3)}`}
                                            </span>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Inline cost note for the currently-selected provider */}
                    {COST_GUIDE[provider] && (
                        <div className={
                            'rounded-lg border p-3 mb-3 text-[11px] leading-relaxed ' +
                            (COST_GUIDE[provider].recommended
                                ? 'border-amber-500/40 bg-amber-500/5 text-amber-100/90'
                                : 'border-white/5 bg-black/20 text-zinc-300')
                        }>
                            <div className="flex items-center gap-1.5 mb-1">
                                <DollarSign size={11} className="text-zinc-400" />
                                <span className="font-bold text-white">
                                    {COST_GUIDE[provider].perVideo === 0
                                        ? 'Free'
                                        : `~$${COST_GUIDE[provider].perVideo.toFixed(3)} per 10-min video`}
                                </span>
                                <span className="text-zinc-600">·</span>
                                <span className="inline-flex items-center text-amber-300">
                                    {Array.from({length: COST_GUIDE[provider].quality}).map((_, i) => (
                                        <Star key={i} size={9} fill="currentColor" />
                                    ))}
                                </span>
                                {COST_GUIDE[provider].badge && (
                                    <>
                                        <span className="text-zinc-600">·</span>
                                        <span className="text-zinc-400">{COST_GUIDE[provider].badge}</span>
                                    </>
                                )}
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-snug">
                                {COST_GUIDE[provider].note}
                            </p>
                            {COST_GUIDE[provider].affiliate && (
                                <a
                                    href={COST_GUIDE[provider].affiliate}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-2 inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 text-[11px] font-medium"
                                >
                                    {COST_GUIDE[provider].affiliateLabel || 'Get a key'} <ExternalLink size={10} />
                                </a>
                            )}
                        </div>
                    )}

                    {/* Model picker */}
                    <label className="block text-xs mb-3">
                        <span className="text-zinc-400 mb-1 flex items-center justify-between">
                            <span>Model</span>
                            {provider === 'ollama' && (
                                // Ollama-specific helper: a refresh button to
                                // re-probe the local daemon after `ollama pull`,
                                // plus a short status badge so the user knows
                                // whether we found any installed models.
                                <span className="flex items-center gap-2">
                                    {ollamaState.status === 'ok' && ollamaState.count > 0 && (
                                        <span className="text-[10px] text-green-400 inline-flex items-center gap-1">
                                            <Check size={9} /> {ollamaState.count} installed
                                        </span>
                                    )}
                                    {ollamaState.status === 'down' && (
                                        <span className="text-[10px] text-yellow-400 inline-flex items-center gap-1">
                                            <AlertTriangle size={9} /> daemon not reachable
                                        </span>
                                    )}
                                    {ollamaState.status === 'loading' && (
                                        <span className="text-[10px] text-zinc-400 inline-flex items-center gap-1">
                                            <RefreshCw size={9} className="animate-spin" /> probing…
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        onClick={(e) => { e.preventDefault(); refreshCatalog({ force: true }); }}
                                        title="Re-probe Ollama for installed models"
                                        className="text-[10px] text-zinc-400 hover:text-white inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 hover:border-white/30"
                                    >
                                        <RefreshCw size={9} /> Refresh
                                    </button>
                                </span>
                            )}
                        </span>
                        <input
                            list={`pp-models-${provider}`}
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder={current?.default_model || 'e.g. gemini-2.5-flash'}
                            className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white font-mono focus:outline-none focus:border-primary/50"
                        />
                        <datalist id={`pp-models-${provider}`}>
                            {(current?.models || []).map((m) => <option key={m} value={m} />)}
                        </datalist>
                        {provider === 'ollama' && ollamaState.status === 'down' && (
                            <p className="mt-1.5 text-[10px] text-yellow-300/80 leading-snug">
                                Couldn't reach Ollama. Open the <strong>Ollama</strong> app from Applications
                                (or run <code className="text-yellow-200">ollama serve</code> in Terminal),
                                then click Refresh. If you haven't installed any models yet, run
                                <code className="text-yellow-200"> ollama pull llama3.2</code> to get started.
                            </p>
                        )}
                        {provider === 'ollama' && ollamaState.status === 'ok' && ollamaState.count > 0 && (
                            <p className="mt-1.5 text-[10px] text-zinc-500 leading-snug">
                                Showing models installed on your Mac. Pull more with
                                <code className="text-zinc-400"> ollama pull &lt;name&gt;</code>, then hit Refresh.
                            </p>
                        )}
                    </label>

                    {/* Key field — only when this provider needs one */}
                    {current?.requires_key && (
                        <label className="block text-xs mb-3">
                            <span className="text-zinc-400 mb-1 flex items-center justify-between">
                                <span>API key</span>
                                {current?.get_key_url && (
                                    <a
                                        href={current.get_key_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-primary/80 hover:text-primary inline-flex items-center gap-1"
                                    >
                                        Get a key <ExternalLink size={10} />
                                    </a>
                                )}
                            </span>
                            <div className="relative">
                                <input
                                    type={showKey ? 'text' : 'password'}
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    placeholder="sk-..."
                                    autoComplete="off"
                                    className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 pr-9 text-xs text-white font-mono focus:outline-none focus:border-primary/50"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowKey((v) => !v)}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                                >
                                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                            </div>
                        </label>
                    )}

                    {/* Notes + save row */}
                    <div className="flex items-center gap-3 pt-1 border-t border-white/5">
                        <p className="text-[11px] text-zinc-500 flex-1">{current?.notes}</p>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={current?.requires_key && !apiKey}
                            className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary hover:bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Save
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
