import React, { useEffect, useState } from 'react';
import { Key, Eye, EyeOff, Check, Loader2 } from 'lucide-react';
import { getApiUrl } from '../config.js';

/**
 * Multi-provider LLM picker. Drop-in replacement for the previous
 * Gemini-only KeyInput. Calls onKeySet with a config object:
 *   { provider, model, api_key }
 *
 * Backward compat: if `savedKey` arrives as a plain string (the old
 * legacy gemini_key), we use it as a Gemini key on first render.
 */

const FALLBACK_PROVIDERS = [
    {
        id: 'gemini', name: 'Google Gemini', requires_key: true,
        // Order matters — first item becomes the default when the user
        // picks Gemini. We put the FREE-TIER models first so a fresh
        // API key (which has no billing attached) "just works" out of
        // the box. gemini-1.5-flash has the most generous free quota
        // (1500 req/day, 1M tokens/day) — perfect default.
        models: [
            'gemini-1.5-flash',   // free tier — generous, fast (default)
            'gemini-2.5-flash',   // free tier — newer, slightly tighter quota
            'gemini-2.0-flash',   // free tier — middle generation
            'gemini-1.5-pro',     // paid — best 1.5 quality
            'gemini-2.5-pro',     // paid — top of stack
        ],
        notes: '1M+ context, native multimodal. Free tier covers ~5 ten-minute videos/day.',
    },
    {
        id: 'openai', name: 'OpenAI', requires_key: true,
        models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
        notes: 'Strong structured-JSON output.',
    },
    {
        id: 'anthropic', name: 'Anthropic (Claude)', requires_key: true,
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest'],
        notes: 'Best hook + script writing quality.',
    },
    {
        id: 'openrouter', name: 'OpenRouter', requires_key: true,
        models: [
            'openrouter/free',
            'minimax/minimax-m2.5:free', 'minimax/minimax-m2:free',
            'google/gemma-3-27b-it:free', 'meta-llama/llama-3.3-70b-instruct:free',
            'deepseek/deepseek-r1:free',
            'minimax/minimax-m2.7', 'anthropic/claude-sonnet-4.6',
            'openai/gpt-5', 'google/gemini-2.5-pro',
        ],
        notes: '100+ models with one key. ":free" variants need no billing.',
    },
    {
        id: 'groq', name: 'Groq', requires_key: true,
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        notes: 'Fastest inference.',
    },
    {
        id: 'minimax', name: 'MiniMax', requires_key: true,
        models: [
            'MiniMax-M2.7', 'MiniMax-M2.7-highspeed',
            'MiniMax-M2.5', 'MiniMax-M2.5-highspeed',
            'MiniMax-M2.1', 'MiniMax-M2', 'MiniMax-M2-Stable',
        ],
        notes: 'Key from platform.minimax.io — not consumer subscription.',
    },
    {
        id: 'ollama', name: 'Ollama (local)', requires_key: false,
        models: ['llama3.3', 'llama3.1', 'qwen2.5', 'mistral', 'gemma2'],
        notes: 'Runs locally. Zero cost, no data leaves your server.',
    },
];

// Light obfuscation for keys in localStorage. Real protection comes from
// the fact they never leave the browser except as request headers.
const SALT = 'openshorts-llm-v1';
function xorEncode(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
    return btoa(out);
}
function xorDecode(s) {
    try {
        const raw = atob(s);
        let out = '';
        for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
        return out;
    } catch { return ''; }
}

const keyStore = {
    save(provider, key) {
        if (key) localStorage.setItem(`os_llm_key_${provider}`, xorEncode(key));
    },
    load(provider) {
        const v = localStorage.getItem(`os_llm_key_${provider}`);
        return v ? xorDecode(v) : '';
    },
    savePref(k, v) { localStorage.setItem(`os_llm_pref_${k}`, JSON.stringify(v)); },
    loadPref(k, fallback) {
        try {
            const v = localStorage.getItem(`os_llm_pref_${k}`);
            return v ? JSON.parse(v) : fallback;
        } catch { return fallback; }
    },
};

export default function KeyInput({ onKeySet, savedKey }) {
    const [providers, setProviders] = useState(FALLBACK_PROVIDERS);

    const initial = (() => {
        const pref = keyStore.loadPref('last', null);
        if (pref) {
            return {
                provider: pref.provider || 'gemini',
                model: pref.model || 'gemini-2.5-flash',
                api_key: keyStore.load(pref.provider || 'gemini') || '',
            };
        }
        const legacy = typeof savedKey === 'string' ? savedKey : '';
        return {
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            api_key: legacy,
        };
    })();

    const [provider, setProvider] = useState(initial.provider);
    const [model, setModel] = useState(initial.model);
    const [apiKey, setApiKey] = useState(initial.api_key);
    const [visible, setVisible] = useState(false);
    const [isSaved, setIsSaved] = useState(!!initial.api_key);
    const [testing, setTesting] = useState(false);
    const [testStatus, setTestStatus] = useState(null); // 'ok' | 'fail' | null
    const [testMsg, setTestMsg] = useState('');

    // Try to fetch the live catalog (overrides FALLBACK_PROVIDERS).
    useEffect(() => {
        let alive = true;
        fetch(getApiUrl('/api/providers'))
            .then((r) => (r.ok ? r.json() : Promise.reject()))
            .then((list) => {
                if (alive && Array.isArray(list) && list.length) setProviders(list);
            })
            .catch(() => { /* keep fallback */ });
        return () => { alive = false; };
    }, []);

    // Push the current config up so the parent can use it for requests.
    useEffect(() => {
        keyStore.savePref('last', { provider, model });
        if (apiKey) keyStore.save(provider, apiKey);
        onKeySet?.({ provider, model, api_key: apiKey });
    }, [provider, model, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const current = providers.find((p) => p.id === provider) || providers[0];

    function handleProvider(pid) {
        setProvider(pid);
        const next = providers.find((p) => p.id === pid);
        const restoredKey = keyStore.load(pid);
        setModel(next?.models?.[0] || '');
        setApiKey(restoredKey);
        setIsSaved(!!restoredKey || !next?.requires_key);
        setTestStatus(null);
    }

    function handleSave() {
        if (current?.requires_key && !apiKey.trim()) return;
        keyStore.save(provider, apiKey);
        setIsSaved(true);
        setTestStatus(null);
    }

    async function handleTest() {
        setTesting(true);
        setTestStatus(null);
        try {
            const res = await fetch(getApiUrl('/api/providers/test'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, model, api_key: apiKey }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            setTestStatus('ok');
            setTestMsg(data.response || 'Provider responded');
        } catch (e) {
            setTestStatus('fail');
            setTestMsg(String(e.message || e));
        } finally {
            setTesting(false);
        }
    }

    return (
        <div className="bg-surface border border-white/5 rounded-2xl p-6 mb-8 animate-[fadeIn_0.5s_ease-out]">
            <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-accent/20 rounded-lg text-accent">
                    <Key size={20} />
                </div>
                <div className="flex-1">
                    <h2 className="text-lg font-semibold">AI Provider</h2>
                    <p className="text-xs text-zinc-500">Pick any provider. Your key stays in this browser.</p>
                </div>
            </div>

            {/* Provider tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
                {providers.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => handleProvider(p.id)}
                        className={
                            'rounded-xl border px-3 py-2 text-left text-sm transition ' +
                            (p.id === provider
                                ? 'border-primary bg-primary/10 text-white'
                                : 'border-white/5 bg-black/20 text-zinc-300 hover:border-white/10')
                        }
                    >
                        <div className="font-medium">{p.name}</div>
                        <div className="text-[11px] text-zinc-500">
                            {p.requires_key ? 'API key' : 'No key — local'}
                        </div>
                    </button>
                ))}
            </div>

            {/* Model + key */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-sm">
                    <span className="mb-1 block text-zinc-400">Model</span>
                    <input
                        list={`models-${provider}`}
                        value={model}
                        onChange={(e) => { setModel(e.target.value); setIsSaved(false); }}
                        placeholder="e.g. gemini-2.5-flash"
                        className="input-field font-mono"
                    />
                    <datalist id={`models-${provider}`}>
                        {(current?.models || []).map((m) => <option key={m} value={m} />)}
                    </datalist>
                </label>

                {current?.requires_key && (
                    <label className="block text-sm">
                        <span className="mb-1 block text-zinc-400">API key</span>
                        <div className="relative">
                            <input
                                type={visible ? 'text' : 'password'}
                                value={apiKey}
                                onChange={(e) => { setApiKey(e.target.value); setIsSaved(false); }}
                                placeholder="sk-..."
                                className="input-field pr-10 font-mono"
                                autoComplete="off"
                            />
                            <button
                                type="button"
                                onClick={() => setVisible((v) => !v)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                            >
                                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                    </label>
                )}
            </div>

            {/* Notes + Save + Test */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
                <p className="text-xs text-zinc-500 flex-1 min-w-[200px]">{current?.notes}</p>

                <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !model || (current?.requires_key && !apiKey)}
                    className="px-3 py-1.5 rounded-lg border border-white/5 bg-black/20 text-sm text-zinc-200 hover:border-white/10 disabled:opacity-40 flex items-center gap-2"
                >
                    {testing && <Loader2 size={14} className="animate-spin" />}
                    {testing ? 'Testing…' : 'Test'}
                </button>

                <button
                    type="button"
                    onClick={handleSave}
                    disabled={current?.requires_key && (!apiKey || isSaved)}
                    className={
                        'px-4 py-1.5 rounded-lg font-medium transition-all flex items-center gap-2 text-sm ' +
                        (isSaved
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-primary hover:bg-blue-600 text-white shadow-lg shadow-primary/20')
                    }
                >
                    {isSaved ? <><Check size={14} /> Ready</> : 'Save'}
                </button>
            </div>

            {testStatus === 'ok' && (
                <p className="mt-3 text-xs text-green-400">✓ {testMsg.slice(0, 200)}</p>
            )}
            {testStatus === 'fail' && (
                <p className="mt-3 text-xs text-red-400">✗ {testMsg}</p>
            )}
        </div>
    );
}
