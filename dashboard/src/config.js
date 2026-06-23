// Configuration for API endpoints
// If VITE_API_URL is set (e.g. in production), use it.
// Otherwise, default to empty string which means relative paths (proxied in dev).

export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Clip files live at /videos/<job_id>/<filename> where <filename> derives
// from the user's upload and can contain '?' or '#'. The browser misparses
// those as query-string / fragment starts, breaking <video src>, <a download>
// and fetch() (MEDIA_ERR_SRC_NOT_SUPPORTED). Percent-encode ONLY those two
// characters, ONLY in the path portion, ONLY for /videos/ URLs.
//
// A trailing cache-bust query — appended by the backend (?v=<ts>) and by
// ResultCard / StandaloneSubtitle (?v=/&v=/&t=) — is a REAL query and must
// survive untouched, so we match it explicitly (split at the LAST '?' iff
// what follows looks like a cache-bust) instead of encoding every '?'.
// API paths (/api/...?refresh=1, ?bins=800, ?kind=, /api/local/find?...)
// never start with /videos/, so they are never touched.
const CACHE_BUST_QUERY_RE = /^[vt]=\d+(?:&[vt]=\d+)*$/;

// IDEMPOTENT, FULL encoder for /videos/ clip URLs. This is the SINGLE
// source of truth for clip-URL encoding — safePlayerSrc and every other
// consumer must NOT re-encode on top of it.
//
// "Idempotent" = applying it twice yields the same result, so even if a
// stale cached module double-calls it (or a getApiUrl output is fed back
// in), the URL stays correct. Achieved by decode-then-encode per path
// segment: decodeURIComponent collapses any prior %XX (including a real
// '?' that was already %3F), then encodeURIComponent re-applies exactly
// one level. Spaces, U+2019, '?', '#' all get handled; '/' separators and
// a trailing ?v=/&t= cache-bust query are preserved.
export const encodeClipPath = (url) => {
    if (!url || typeof url !== 'string') return url;
    const videosIdx = url.indexOf('/videos/');
    if (videosIdx === -1) return url;          // not a clip URL — untouched
    // Peel off a trailing real cache-bust query (?v=123 / ?v=1&t=2).
    let main = url, bust = '';
    const q = url.lastIndexOf('?');
    if (q !== -1 && CACHE_BUST_QUERY_RE.test(url.slice(q + 1))) {
        main = url.slice(0, q);
        bust = url.slice(q);
    }
    const prefix = main.slice(0, videosIdx);   // scheme+host (or '')
    const pathPart = main.slice(videosIdx);    // /videos/<job>/<filename...>
    const encoded = pathPart.split('/').map((seg) => {
        if (!seg) return seg;
        let decoded;
        try { decoded = decodeURIComponent(seg); } catch { decoded = seg; }
        return encodeURIComponent(decoded);
    }).join('/');
    return prefix + encoded + bust;
};

// Extract the real on-disk filename from a clip URL for sending back to the
// backend as `input_filename`. Strips ONLY a trailing cache-bust query
// (?v=.../&t=...) — never a '?' that is part of the filename itself — then
// takes the basename and decodes any %XX. Mirrors backend
// _clip_filename_from_url. The old inline `url.split('?')[0].split('/').pop()`
// truncated names like "...Crypto? (Wall St)_clip_1.mp4" at the '?', dropping
// the "_clip_1.mp4" — which broke subtitle/dub burns (FFmpeg got an
// extension-less output name → "Invalid argument" muxer error).
export const clipFilenameFromUrl = (url) => {
    if (!url || typeof url !== 'string') return '';
    const cleaned = url.replace(/\?[vt]=\d+(?:&[vt]=\d+)*$/, '');
    const base = cleaned.split('/').pop() || '';
    try { return decodeURIComponent(base); } catch { return base; }
};

export const getApiUrl = (path) => {
    // Tolerate null / undefined / empty input. Without this, any past
    // project that has a clip with a missing video_url crashes ResultCard
    // during render — which blanks the entire dashboard tab.
    if (!path || typeof path !== 'string') return API_BASE_URL || '';
    if (path.startsWith('http') || path.startsWith('blob:')) return path;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${API_BASE_URL}${encodeClipPath(normalizedPath)}`;
};

// XOR scheme shared by KeyInput / ProviderPicker for at-rest obfuscation of
// API keys in localStorage. Must match those components EXACTLY so all three
// can read each other's saved keys.
const LLM_SALT = 'openshorts-llm-v1';
const xorDecodeKey = (s) => {
    try {
        const raw = atob(s);
        let out = '';
        for (let i = 0; i < raw.length; i++) {
            out += String.fromCharCode(raw.charCodeAt(i) ^ LLM_SALT.charCodeAt(i % LLM_SALT.length));
        }
        return out;
    } catch {
        return '';
    }
};

/**
 * Build the X-LLM-* request headers from the LIVE provider choice in
 * localStorage — read at CALL TIME, not at React render time.
 *
 * Why this exists: the standalone Subtitle / Dub / SEO pages embed their own
 * <ProviderPicker/> (via CompactModelBar) that persists the user's choice to
 * `os_llm_pref_last` in localStorage but does NOT bubble the change up to
 * App.jsx. App.jsx computes its `llmHeaders` prop once at render time, so if
 * the user switches provider on the page (e.g. Gemini → Ollama) without
 * triggering an App re-render, the stale prop still carries the OLD provider
 * and the request hits the wrong backend (symptom: picked Ollama, still got a
 * Gemini 429 quota error).
 *
 * Calling this at request time guarantees the header always reflects exactly
 * what the picker shows — the same approach the full-pipeline submit already
 * uses successfully. `os_llm_pref_last` is the single source of truth that
 * ProviderPicker writes on every change.
 *
 * @param {object} [fallback] optional fallback used only when nothing is
 *        saved in localStorage yet. Accepts EITHER {provider, model, key}
 *        or the X-LLM-* header shape ({'X-LLM-Provider', 'X-LLM-Model',
 *        'X-LLM-Key'}) so callers can pass their existing llmHeaders prop
 *        straight through.
 */
export const buildLlmHeaders = (fallback = {}) => {
    let provider = fallback.provider || fallback['X-LLM-Provider'] || 'gemini-subscription';
    let model = fallback.model || fallback['X-LLM-Model'] || 'gemini-3-flash-plus';
    let key = fallback.key || fallback['X-LLM-Key'] || '';
    try {
        const prefRaw = localStorage.getItem('os_llm_pref_last');
        if (prefRaw) {
            const p = JSON.parse(prefRaw);
            if (p?.provider) provider = p.provider;
            if (p?.model) model = p.model;
        }
        const keyRaw = localStorage.getItem(`os_llm_key_${provider}`);
        if (keyRaw) {
            const decoded = xorDecodeKey(keyRaw);
            if (decoded) key = decoded;
        }
    } catch {
        /* localStorage unavailable (private mode / SSR) — use fallback */
    }
    return {
        'X-LLM-Provider': provider,
        'X-LLM-Model': model,
        'X-LLM-Key': key,
        // Legacy header — only meaningful on Gemini.
        'X-Gemini-Key': provider === 'gemini' ? key : '',
    };
};
