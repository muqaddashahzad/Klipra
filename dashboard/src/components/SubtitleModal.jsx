import React, { useState, useEffect } from 'react';
import { X, Type, Loader2, RotateCcw, Lightbulb, Copy } from 'lucide-react';
import { getApiUrl, buildLlmHeaders } from '../config';
import RemotionPreview from './RemotionPreview';
import ProviderPicker from './ProviderPicker';
import { Sparkles } from 'lucide-react';

const FONT_OPTIONS = [
    { value: 'Verdana', label: 'Verdana' },
    { value: 'Arial', label: 'Arial' },
    { value: 'Impact', label: 'Impact' },
    { value: 'Helvetica', label: 'Helvetica' },
    { value: 'Georgia', label: 'Georgia' },
    { value: 'Courier New', label: 'Courier New' },
];

const COLOR_PRESETS = [
    { color: '#FFFFFF', label: 'White' },
    { color: '#FFFF00', label: 'Yellow' },
    { color: '#00FFFF', label: 'Cyan' },
    { color: '#00FF00', label: 'Green' },
    { color: '#FF0000', label: 'Red' },
    { color: '#FF69B4', label: 'Pink' },
];

const ANIMATION_OPTIONS = [
    { value: 'pop', label: 'Pop' },
    { value: 'word-highlight', label: 'Glow' },
    { value: 'karaoke', label: 'Karaoke' },
    { value: 'none', label: 'None' },
];

export default function SubtitleModal({ isOpen, onClose, onGenerate, isProcessing, videoUrl, jobId, clipIndex, existingHook, currentVideoFilename, llmHeaders, subtitlesInvalidatedAt }) {
    const [position, setPosition] = useState('bottom');
    // Default 64px — sized for vertical (1920-tall) phone subs. Slider
    // values now map 1:1 to real pixels on the burned video, so this is
    // the actual on-screen size the viewer will see.
    const [fontSize, setFontSize] = useState(64);
    const [fontName, setFontName] = useState('Verdana');
    const [fontColor, setFontColor] = useState('#FFFFFF');
    const [highlightColor, setHighlightColor] = useState('#FFDD00');
    const [borderColor, setBorderColor] = useState('#000000');
    const [borderWidth, setBorderWidth] = useState(2);
    const [bgColor, setBgColor] = useState('#000000');
    const [bgOpacity, setBgOpacity] = useState(0.0);
    const [animation, setAnimation] = useState('pop');
    // Default OPEN — surfacing the editor by default is the only way
    // users discover they can fix Whisper misreads. Previously hidden
    // behind a collapsed toggle most people never clicked.
    const [showTextEditor, setShowTextEditor] = useState(true);
    // Auto-mode Sync state — separate from the regenerate-mode sync
    // because they operate on different text sources (editableText vs
    // regenEditedText). Both call /api/clip/sync-transcript under the
    // hood; this lets a user fix misreads in auto mode and align timing
    // without going through the slower regenerate flow.
    const [autoSyncStatus, setAutoSyncStatus] = useState(null); // null | 'syncing' | 'done' | 'stale' | 'error'
    const [autoSyncError, setAutoSyncError] = useState(null);

    // Subtitle text-script options.
    // Modes: 'auto' (use cached) | 'roman' (LLM transliterate) |
    //        'translate' (LLM translate) | 'regenerate' (two-phase:
    //        Whisper re-transcribe → optional AI cleanup → user
    //        approves → burn).
    const [scriptMode, setScriptMode] = useState('auto');
    const [targetLanguage, setTargetLanguage] = useState('en');

    // --- Two-phase Regenerate state ---
    // Phase 1 result. While this is non-null, the modal shows the
    // editable preview and the burn button instead of the regenerate
    // button. Cleared when user closes/cancels regenerate.
    const [regenResult, setRegenResult] = useState(null);
    const [regenStatus, setRegenStatus] = useState(null); // 'transcribing' | 'cleaning' | 'done' | 'error'
    const [regenError, setRegenError] = useState(null);
    const [regenCleanupMode, setRegenCleanupMode] = useState('auto'); // 'auto' | 'roman' | 'translate'
    const [regenTargetLang, setRegenTargetLang] = useState('en');
    // After phase 1, the user can edit the cleaned text inline before burning.
    const [regenEditedText, setRegenEditedText] = useState('');
    // Brief "Copied!" confirmation for the "Copy for external AI" button.
    const [extCopied, setExtCopied] = useState(false);

    // Build a self-contained Urglish prompt + transcript so the user can do
    // the AI cleanup in an external tool (aistudio.google.com, Gemini app,
    // ChatGPT, etc.) when the in-app subscription cookies are flaky, then
    // paste the result back into the editor below.
    const buildExternalAiPrompt = () => {
        // Prefer one-line-per-segment (clean mapping); fall back to the
        // current editable text.
        const segs = regenResult?.segments || [];
        const lines = segs.length
            ? segs.map(s => (s.text || '').trim()).filter(Boolean)
            : (regenEditedText || '').split('\n').map(l => l.trim()).filter(Boolean);
        const transcript = lines.join('\n');
        return (
`You are an expert "Urglish" (Roman Urdu + English) writer. Below is a Whisper transcript of Urdu speech that frequently code-switches into English.

YOUR JOB — rewrite every line as clean, readable Urglish:
- Urdu words -> Roman/Latin transliteration the way a Pakistani native types on an English keyboard (e.g. "ہے" -> "hai", "کیا" -> "kya", "نہیں" -> "nahi").
- English words AND phrases -> KEEP THEM IN ENGLISH, verbatim. Do NOT phoneticise English. "community" stays "community" (not "komyuniti"), "Bitcoin" stays "Bitcoin", "crypto" stays "crypto", "market" stays "market".
- Proper nouns (people, brands, places, projects) -> use the correct/canonical English spelling (e.g. Reuters, Trump, Ethereum, Binance).
- Numbers -> digits (e.g. "2.3 million", "$50").
- Keep the SAME number of lines, in the SAME order. Do NOT merge, split, add, drop, or renumber lines. No commentary, no quotes, no bullet points.

Return ONLY the rewritten lines — one line per input line, in order.

TRANSCRIPT (${lines.length} lines):
${transcript}`
        );
    };

    const copyExternalAiPrompt = async () => {
        try {
            await navigator.clipboard.writeText(buildExternalAiPrompt());
            setExtCopied(true);
            setTimeout(() => setExtCopied(false), 2500);
        } catch (e) {
            // Clipboard API can fail on http origins / permissions — fall back
            // to a temporary textarea select+copy.
            try {
                const ta = document.createElement('textarea');
                ta.value = buildExternalAiPrompt();
                ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                setExtCopied(true);
                setTimeout(() => setExtCopied(false), 2500);
            } catch (_) {
                alert('Could not copy automatically. Select the transcript text and copy it manually.');
            }
        }
    };
    // Phase-3 Sync state: tracks whether the synced timing has been
    // computed and saved on the server (true after a successful Sync run).
    const [syncStatus, setSyncStatus] = useState(null); // null | 'syncing' | 'done' | 'error'
    const [syncError, setSyncError] = useState(null);
    const [syncedAt, setSyncedAt] = useState(null);

    // Remotion preview state
    const [captions, setCaptions] = useState([]);
    const [originalCaptions, setOriginalCaptions] = useState([]);
    const [editableText, setEditableText] = useState('');
    const [durationSec, setDurationSec] = useState(30);
    const [captionsLoading, setCaptionsLoading] = useState(false);
    const [useRemotionPreview, setUseRemotionPreview] = useState(false);

    // ---- Bring-Your-Own-Lyrics state ----
    // When the user has the official lyrics for a song, Whisper-as-source
    // is broken (mishears at every line, then the LLM compounds it on
    // translate). Pasting ground-truth lyrics here forces the burn path
    // to use the user's text and only Whisper's word TIMINGS for sync.
    const [showLyricsPanel, setShowLyricsPanel] = useState(false);
    const [userLyrics, setUserLyrics] = useState('');
    const [lyricsKeepTags, setLyricsKeepTags] = useState(false);
    const [lyricsAlignStatus, setLyricsAlignStatus] = useState(null); // null | 'aligning' | 'done' | 'error'
    const [lyricsAlignError, setLyricsAlignError] = useState(null);
    const [lyricsAlignSummary, setLyricsAlignSummary] = useState(null); // { lines, words, method }

    // Fetch word-level captions when modal opens
    useEffect(() => {
        if (!isOpen || !jobId || clipIndex === undefined) return;

        setCaptionsLoading(true);
        fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/transcript`))
            .then((res) => res.ok ? res.json() : null)
            .then((data) => {
                if (data && data.captions && data.captions.length > 0) {
                    setCaptions(data.captions);
                    setOriginalCaptions(data.captions);
                    setEditableText(data.captions.map(c => c.text).join(' '));
                    setDurationSec(data.durationSec || 30);
                    setUseRemotionPreview(true);
                } else {
                    setUseRemotionPreview(false);
                }
            })
            .catch(() => setUseRemotionPreview(false))
            .finally(() => setCaptionsLoading(false));
    }, [isOpen, jobId, clipIndex]);

    // When user edits text, redistribute words across original timestamps
    const handleTextEdit = (newText) => {
        setEditableText(newText);
        // Mark a previously-good sync as stale so the user knows they
        // should re-Sync before burning. Auto-resync would be too
        // expensive for every keystroke.
        if (autoSyncStatus === 'done') setAutoSyncStatus('stale');
        const newWords = newText.split(/\s+/).filter(w => w.length > 0);
        if (newWords.length === 0 || originalCaptions.length === 0) {
            setCaptions([]);
            return;
        }

        // Distribute new words across the time span of original captions
        const totalDurationMs = originalCaptions[originalCaptions.length - 1].endMs - originalCaptions[0].startMs;
        const startMs = originalCaptions[0].startMs;
        const wordDurationMs = totalDurationMs / newWords.length;

        const newCaptions = newWords.map((word, i) => ({
            text: word,
            startMs: Math.round(startMs + i * wordDurationMs),
            endMs: Math.round(startMs + (i + 1) * wordDurationMs),
        }));
        setCaptions(newCaptions);
    };

    // Convert a segments-with-text response into the word-level
    // `captions` shape the live Remotion preview consumes. Each segment
    // is split into words and the words are distributed evenly across
    // the segment's [start, end] window.
    //
    // Why this exists: after Regenerate or Sync, the preview should
    // show the NEW text the user will see burned in. Without this
    // conversion the preview keeps rendering the original Whisper
    // captions, so the user can't tell what they're about to commit to.
    const captionsFromSegments = (segments) => {
        const out = [];
        for (const seg of segments || []) {
            const text = (seg.text || '').trim();
            if (!text) continue;
            const start = Number(seg.start) || 0;
            const end = Number(seg.end) || 0;
            const dur = Math.max(0.05, end - start);
            const words = text.split(/\s+/).filter(Boolean);
            if (words.length === 0) continue;
            const per = dur / words.length;
            for (let i = 0; i < words.length; i++) {
                out.push({
                    text: words[i],
                    startMs: Math.round((start + i * per) * 1000),
                    endMs: Math.round((start + (i + 1) * per) * 1000),
                });
            }
        }
        return out;
    };

    // Phase-1 of two-phase Regenerate. Re-transcribes JUST this clip's
    // audio + optional AI cleanup, then lets the user proofread before
    // burning. Burn happens via the standard onGenerate path.
    // Accepts explicit mode/lang overrides so the "Re-run Step 1 in X" button
    // can pass the freshly-picked language DIRECTLY, instead of relying on a
    // setTimeout + state-closure dance (which could fire with a stale mode and
    // make the re-run appear to "do nothing" / keep the previous language).
    const runRegenerate = async (modeOverride, langOverride) => {
        // Type-guard: if called directly as an onClick handler the first arg
        // is a DOM/synthetic event, not a mode string. Only accept real string
        // overrides — otherwise an event object would leak into JSON.stringify
        // and throw "Converting circular structure to JSON".
        const mode = (typeof modeOverride === 'string') ? modeOverride : regenCleanupMode;
        const lang = (typeof langOverride === 'string') ? langOverride : regenTargetLang;
        setRegenStatus(mode === 'auto' ? 'transcribing' : 'cleaning');
        setRegenError(null);
        setRegenResult(null);
        try {
            const res = await fetch(getApiUrl('/api/clip/regenerate-transcript'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Read the LIVE provider from localStorage at request time,
                    // not the stale llmHeaders prop. The in-app provider picker
                    // persists there but doesn't re-render this modal, so the
                    // prop could still say Gemini after the user switched to
                    // Ollama — which 429'd (Gemini free quota) and surfaced as
                    // a generic "Internal Server Error".
                    ...buildLlmHeaders(llmHeaders),
                    // Force-bypass any HTTP cache so a repeat re-run always
                    // hits the backend fresh.
                    'Cache-Control': 'no-cache',
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    input_filename: currentVideoFilename || null,
                    cleanup_mode: mode,
                    target_language: mode === 'translate' ? lang : null,
                }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setRegenResult(data);
            setRegenEditedText(data.text || '');
            setRegenStatus('done');
            // Update the preview's captions so the user can SEE the
            // new text overlaid on the video before they commit to burn.
            const previewCaps = captionsFromSegments(data.segments || []);
            if (previewCaps.length) {
                setCaptions(previewCaps);
                setUseRemotionPreview(true);
            }
        } catch (e) {
            setRegenStatus('error');
            setRegenError(e.message || String(e));
        }
    };

    const cancelRegenerate = () => {
        setRegenResult(null);
        setRegenStatus(null);
        setRegenError(null);
        setRegenEditedText('');
        setSyncStatus(null);
        setSyncError(null);
        setSyncedAt(null);
        setScriptMode('auto');
        // Restore the original captions in the preview (we replaced
        // them when regen ran) so the user sees the un-modified video
        // again.
        if (originalCaptions.length) {
            setCaptions(originalCaptions);
        }
    };

    // BYOL — align user-provided lyrics to the clip audio. POSTs to
    // /api/clip/{job}/{idx}/lyrics-align which uses difflib forced-
    // alignment against Whisper's word timestamps. Saves the result
    // as the clip's regenerated_transcript so subsequent burns (and
    // any translate run) read the user's ground-truth text.
    const runLyricsAlign = async () => {
        if (!userLyrics.trim()) {
            setLyricsAlignError('Paste your lyrics first');
            return;
        }
        setLyricsAlignStatus('aligning');
        setLyricsAlignError(null);
        setLyricsAlignSummary(null);
        try {
            const res = await fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/lyrics-align`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lyrics: userLyrics,
                    keep_structure_tags: lyricsKeepTags,
                }),
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setLyricsAlignStatus('done');
            setLyricsAlignSummary({
                lines: data.lines_count,
                words: data.words_count,
                whisperWords: data.whisper_words_used,
                method: data.alignment_method,
            });
            // Refresh the in-modal preview so the user sees their lyrics
            // overlaid on the video, not Whisper's noisy version. The
            // alignment endpoint already saved the regenerated_transcript;
            // re-fetch the per-clip transcript to update the preview.
            try {
                const r2 = await fetch(getApiUrl(`/api/clip/${jobId}/${clipIndex}/transcript`));
                if (r2.ok) {
                    const cap = await r2.json();
                    if (cap?.captions?.length) {
                        setCaptions(cap.captions);
                        setOriginalCaptions(cap.captions);
                        setEditableText(cap.captions.map((c) => c.text).join(' '));
                        setUseRemotionPreview(true);
                    }
                }
            } catch { /* preview refresh is best-effort */ }
        } catch (err) {
            setLyricsAlignStatus('error');
            setLyricsAlignError(String(err?.message || err));
        }
    };

    // AUTO-MODE SYNC — run the same sync-transcript endpoint against
    // the user's edits in the default 'auto' script mode. The Phase 1
    // transcribe already happened during clip generation; this is just
    // re-aligning timestamps to the user's corrected text. ~3-5s on a
    // 30s clip versus 30+s for full Regenerate.
    const runAutoSync = async () => {
        if (!editableText || !editableText.trim()) {
            setAutoSyncError('Edit some text first.');
            return;
        }
        setAutoSyncStatus('syncing');
        setAutoSyncError(null);
        try {
            const res = await fetch(getApiUrl('/api/clip/sync-transcript'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Read the LIVE provider from localStorage at request time,
                    // not the stale llmHeaders prop. The in-app provider picker
                    // persists there but doesn't re-render this modal, so the
                    // prop could still say Gemini after the user switched to
                    // Ollama — which 429'd (Gemini free quota) and surfaced as
                    // a generic "Internal Server Error".
                    ...buildLlmHeaders(llmHeaders),
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    edited_text: editableText,
                    input_filename: currentVideoFilename || null,
                }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setAutoSyncStatus('done');
            // Replace the editable text with the synced version (text
            // is unchanged, but we update for consistency).
            if (data.text) setEditableText(data.text);
            // Update preview captions with the SYNCED segment timings
            // so the user can verify alignment BEFORE burn.
            const previewCaps = captionsFromSegments(data.segments || []);
            if (previewCaps.length) {
                setCaptions(previewCaps);
                setUseRemotionPreview(true);
            }
        } catch (e) {
            setAutoSyncStatus('error');
            setAutoSyncError(e.message || String(e));
        }
    };

    // Phase-3: sync the user's edited text against fresh Whisper
    // segment boundaries so the burned subtitles line up with the spoken
    // audio. Optional but strongly recommended after edits.
    const runSync = async () => {
        setSyncStatus('syncing');
        setSyncError(null);
        try {
            const res = await fetch(getApiUrl('/api/clip/sync-transcript'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Read the LIVE provider from localStorage at request time,
                    // not the stale llmHeaders prop. The in-app provider picker
                    // persists there but doesn't re-render this modal, so the
                    // prop could still say Gemini after the user switched to
                    // Ollama — which 429'd (Gemini free quota) and surfaced as
                    // a generic "Internal Server Error".
                    ...buildLlmHeaders(llmHeaders),
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    edited_text: regenEditedText,
                    input_filename: currentVideoFilename || null,
                }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setSyncStatus('done');
            setSyncedAt(Date.now());
            // Replace the editable text with the synced version (text is
            // unchanged, but we update for consistency).
            if (data.text) setRegenEditedText(data.text);
            // Update preview captions with the SYNCED segment timings so
            // the user can verify the alignment looks right BEFORE burn.
            const previewCaps = captionsFromSegments(data.segments || []);
            if (previewCaps.length) {
                setCaptions(previewCaps);
                setUseRemotionPreview(true);
            }
        } catch (e) {
            setSyncStatus('error');
            setSyncError(e.message || String(e));
        }
    };

    // If user re-edits text after syncing, mark sync as stale AND
    // refresh the preview captions so the video overlay shows the
    // current edit (best-effort — segment boundaries from the last
    // regenerate/sync are reused, words redistributed across them).
    const handleRegenTextEdit = (val) => {
        setRegenEditedText(val);
        if (syncStatus === 'done') setSyncStatus('stale');

        // Live update the preview overlay with the edited text.
        const segs = regenResult?.segments || [];
        if (!segs.length) return;
        const words = val.trim().split(/\s+/).filter(Boolean);
        if (!words.length) {
            setCaptions([]);
            return;
        }
        const totalDur = segs.reduce((acc, s) => acc + Math.max(0, (s.end || 0) - (s.start || 0)), 0) || 1;
        const newSegs = [];
        let cursor = 0;
        for (const s of segs) {
            const segDur = Math.max(0.05, (s.end || 0) - (s.start || 0));
            const take = Math.max(1, Math.round(words.length * (segDur / totalDur)));
            const slice = words.slice(cursor, cursor + take);
            cursor += take;
            if (!slice.length) continue;
            newSegs.push({ text: slice.join(' '), start: s.start, end: s.end });
        }
        if (cursor < words.length && newSegs.length) {
            newSegs[newSegs.length - 1].text += ' ' + words.slice(cursor).join(' ');
        }
        const previewCaps = captionsFromSegments(newSegs);
        if (previewCaps.length) {
            setCaptions(previewCaps);
            setUseRemotionPreview(true);
        }
    };

    if (!isOpen) return null;

    // Build subtitle config for Remotion.
    //
    // The slider value is the user's "size at 600-px reference height"
    // — the same reference the backend uses (subtitles.burn_subtitles
    // PREVIEW_REFERENCE_HEIGHT=600). To make the Remotion preview show
    // the same proportional size as the burn, multiply by
    // (canvas_HEIGHT / 600).
    //
    // BUGFIX: the Remotion composition is 1080×1920 — i.e. 1080 WIDE and
    // 1920 TALL (RemotionPreview.jsx compositionWidth=1080, compositionHeight
    // =1920). The previous value 1.8 = 1080/600 mistakenly used the WIDTH as
    // the height, so the preview font was only 1.8/3.2 ≈ 0.56× of the burn —
    // i.e. the BURN came out ~1.78× LARGER than the preview (the user's
    // "font is bigger after burning" bug). The correct scale is the canvas
    // HEIGHT over the reference: 1920/600 = 3.2, which is exactly the
    // video_h/600 factor burn_subtitles() applies, so preview == burn.
    const REMOTION_CANVAS_HEIGHT = 1920;
    const PREVIEW_REFERENCE_HEIGHT = 600;
    const PREVIEW_FONT_SCALE = REMOTION_CANVAS_HEIGHT / PREVIEW_REFERENCE_HEIGHT; // 3.2
    const subtitleConfig = {
        captions,
        position,
        style: {
            fontFamily: fontName,
            fontSize: fontSize * PREVIEW_FONT_SCALE,
            fontColor,
            highlightColor,
            borderColor,
            borderWidth: borderWidth * 1.5,
            bgColor,
            bgOpacity,
            animation,
        },
    };

    // Fallback: static CSS preview (same as original)
    const bw = Math.max(borderWidth, 0);
    const bc = borderColor;
    const outlineShadow = bw > 0 ? [
        `-${bw}px -${bw}px 0 ${bc}`, `${bw}px -${bw}px 0 ${bc}`,
        `-${bw}px ${bw}px 0 ${bc}`, `${bw}px ${bw}px 0 ${bc}`,
        `0 -${bw}px 0 ${bc}`, `0 ${bw}px 0 ${bc}`,
        `-${bw}px 0 0 ${bc}`, `${bw}px 0 0 ${bc}`,
    ].join(', ') : 'none';

    // Use container-query units so the preview text is the SAME
    // fraction of preview height that the burn is of video frame
    // height. The slider value here is the typed pt-size (default
    // ~30) — divide by 6 to get cqh percentage that matches the
    // backend's video_h/600 scaling. clamp() guarantees readability
    // on tiny preview windows and prevents oversize on huge ones.
    const sliderVal = Number(fontSize) || 30;
    const cqhPct = (sliderVal / 6).toFixed(2);
    const fallbackPreviewStyle = {
        fontFamily: fontName,
        color: fontColor,
        fontSize: `clamp(11px, ${cqhPct}cqh, 200px)`,
        fontWeight: 'bold',
        maxWidth: '85%',
        padding: '6px 12px',
        borderRadius: '4px',
        textAlign: 'center',
        lineHeight: '1.3',
        ...(bgOpacity > 0
            ? {
                backgroundColor: `${bgColor}${Math.round(bgOpacity * 255).toString(16).padStart(2, '0')}`,
                textShadow: 'none',
            }
            : { textShadow: outlineShadow }
        ),
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
            <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-5xl shadow-2xl relative flex flex-col md:flex-row gap-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-zinc-500 hover:text-white z-10"
                >
                    <X size={20} />
                </button>

                {/* Left: Preview. containerType: size makes this a
                    query container so the cqh font-size unit on the
                    fallback preview text resolves to a percentage of
                    THIS element's height. */}
                <div className="flex-1 flex flex-col items-center justify-center bg-black rounded-lg border border-white/5 overflow-hidden relative aspect-[9/16] max-h-[600px]"
                     style={{ containerType: 'size' }}>
                    {/* What's the preview currently showing? Helps the user
                        verify Step 3 actually applied before they burn. */}
                    {regenResult && (
                        <div className="absolute top-2 left-2 right-2 z-20 flex items-center gap-1.5 flex-wrap">
                            <span className={
                                'text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ' +
                                (syncStatus === 'done'
                                    ? 'bg-blue-500/30 text-blue-100 border border-blue-400/40'
                                    : syncStatus === 'stale'
                                      ? 'bg-amber-500/30 text-amber-100 border border-amber-400/40'
                                      : 'bg-green-500/30 text-green-100 border border-green-400/40')
                            }>
                                {syncStatus === 'done'
                                    ? '✓ Synced preview'
                                    : syncStatus === 'stale'
                                      ? '⚠ Edited after sync — re-sync'
                                      : 'Regenerated · not synced'}
                            </span>
                            <span className="text-[10px] text-zinc-400 bg-black/60 px-2 py-0.5 rounded-full">
                                {captions.length} word{captions.length === 1 ? '' : 's'}
                            </span>
                        </div>
                    )}
                    {captionsLoading ? (
                        <div className="flex items-center gap-2 text-zinc-400">
                            <Loader2 size={16} className="animate-spin" />
                            <span className="text-sm">Loading preview...</span>
                        </div>
                    ) : useRemotionPreview ? (
                        <RemotionPreview
                            videoUrl={videoUrl}
                            durationInSeconds={durationSec}
                            subtitles={subtitleConfig}
                            hook={existingHook || null}
                        />
                    ) : (
                        <>
                            <video src={videoUrl} className="w-full h-full object-contain opacity-50" muted playsInline />
                            <div className={`absolute w-full px-8 text-center transition-all duration-300 pointer-events-none flex flex-col items-center justify-center
                                ${position === 'top' ? 'top-20' : ''}
                                ${position === 'middle' ? 'top-0 bottom-0' : ''}
                                ${position === 'bottom' ? 'bottom-20' : ''}
                            `}>
                                <span style={fallbackPreviewStyle}>
                                    This is how your subtitles<br/>will appear on the video
                                </span>
                            </div>
                        </>
                    )}
                </div>

                {/* Right: Controls */}
                <div className="w-full md:w-80 flex flex-col">
                    <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2 shrink-0">
                        <Type className="text-primary" /> Auto Subtitles
                    </h3>

                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        {/* Stale-transcript banner. Surfaced when retrim
                            (timing edit) just changed the clip's
                            start/end. The cached transcript still
                            refers to the OLD time range, so a plain
                            "Generate Subtitles" burn would line up
                            captions with audio that no longer exists.
                            One-click switches to Regenerate mode and
                            triggers Step 1 immediately. */}
                        {subtitlesInvalidatedAt && scriptMode !== 'regenerate' && !regenResult && (
                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100 space-y-2">
                                <div className="flex items-start gap-2">
                                    <span className="text-base leading-none">⚠️</span>
                                    <div className="flex-1">
                                        <div className="font-bold mb-0.5">Timing changed — subtitles need refreshing</div>
                                        <div className="text-amber-200/80 leading-snug">
                                            You edited this clip's start/end after Whisper transcribed it.
                                            Burn now would line up old caption timing against the new
                                            audio — Regenerate gets a fresh transcript synced to the
                                            current cut.
                                        </div>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setScriptMode('regenerate');
                                        // Defer one tick so scriptMode propagates before
                                        // runRegenerate reads it (it reads scriptMode-driven
                                        // language defaults via regenCleanupMode/regenTargetLang).
                                        setTimeout(() => runRegenerate(), 0);
                                    }}
                                    className="w-full py-1.5 px-2 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-50 text-xs font-bold transition-all"
                                >
                                    Regenerate now →
                                </button>
                            </div>
                        )}

                        {/* Bring-Your-Own-Lyrics panel.
                            Shown collapsed by default — expanded only
                            when the user clicks the header. The toggle
                            does NOT auto-expand for songs because we
                            can't reliably detect "is a song" client-
                            side; the user opts in. Once aligned, the
                            cached regenerated_transcript flows into
                            every downstream subtitle/translate burn
                            on this clip until they retrim. */}
                        <div className="rounded-lg border border-violet-500/20 bg-violet-500/5">
                            <button
                                type="button"
                                onClick={() => setShowLyricsPanel(!showLyricsPanel)}
                                className="w-full flex items-center justify-between p-3 text-xs font-bold text-violet-300 uppercase tracking-wider"
                            >
                                <span className="flex items-center gap-1.5">
                                    🎵 Use my own lyrics
                                    {lyricsAlignStatus === 'done' && (
                                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-100 border border-emerald-400/40 normal-case">
                                            ✓ aligned
                                        </span>
                                    )}
                                </span>
                                <span className={`transition-transform ${showLyricsPanel ? 'rotate-180' : ''}`}>▾</span>
                            </button>
                            {showLyricsPanel && (
                                <div className="px-3 pb-3 space-y-2 animate-[fadeIn_0.2s_ease-out]">
                                    <p className="text-[11px] text-violet-200/70 leading-snug">
                                        Whisper struggles with songs in mixed languages
                                        (Roman Urdu + English, etc.) and the AI translation
                                        compounds the errors. Paste your <strong>official
                                        lyrics</strong> below — we'll use them as ground truth
                                        and only use Whisper for timing alignment.
                                    </p>
                                    <textarea
                                        value={userLyrics}
                                        onChange={(e) => setUserLyrics(e.target.value)}
                                        placeholder={"[Verse 1]\nBitcoin hai naya par Crypto hai puraana\nEe Cash, Hash Cash aur Bit-Gold ka tha zamaana\n\n[Chorus]\nBoom and bust, we rise from the dust!\nCrypto cycles, in them we trust!"}
                                        rows={8}
                                        className="w-full rounded-md bg-black/40 border border-violet-500/20 text-zinc-100 text-xs p-2 font-mono resize-y placeholder:text-zinc-600 focus:outline-none focus:border-violet-400"
                                    />
                                    <label className="flex items-center gap-2 text-[11px] text-violet-200/80">
                                        <input
                                            type="checkbox"
                                            checked={lyricsKeepTags}
                                            onChange={(e) => setLyricsKeepTags(e.target.checked)}
                                            className="accent-violet-500"
                                        />
                                        Keep [Verse]/[Chorus] tags as on-screen subtitles
                                    </label>
                                    <button
                                        type="button"
                                        onClick={runLyricsAlign}
                                        disabled={lyricsAlignStatus === 'aligning' || !userLyrics.trim()}
                                        className="w-full py-1.5 px-2 rounded-md bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 text-violet-50 text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                                    >
                                        {lyricsAlignStatus === 'aligning' ? (
                                            <><Loader2 size={12} className="animate-spin" /> Aligning to audio…</>
                                        ) : (
                                            <>Align to audio →</>
                                        )}
                                    </button>
                                    {lyricsAlignStatus === 'done' && lyricsAlignSummary && (
                                        <div className="text-[11px] text-emerald-300/90 leading-snug">
                                            ✓ Aligned <strong>{lyricsAlignSummary.lines}</strong> lines
                                            ({lyricsAlignSummary.words} words, {lyricsAlignSummary.whisperWords} Whisper anchors)
                                            via {lyricsAlignSummary.method}.
                                            Now pick <strong>Translate</strong> below if you want to
                                            translate, then <strong>Generate Subtitles</strong>.
                                        </div>
                                    )}
                                    {lyricsAlignStatus === 'error' && (
                                        <div className="text-[11px] text-red-300 leading-snug">
                                            Alignment failed: {lyricsAlignError}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Position Selector */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Position</label>
                            <div className="grid grid-cols-3 gap-2">
                                {['top', 'middle', 'bottom'].map((pos) => (
                                    <button
                                        key={pos}
                                        onClick={() => setPosition(pos)}
                                        className={`p-2 rounded-lg border text-center text-xs font-medium transition-all ${position === pos ? 'bg-primary/20 border-primary text-white' : 'bg-white/5 border-white/5 text-zinc-400 hover:bg-white/10'}`}
                                    >
                                        {pos.charAt(0).toUpperCase() + pos.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Animation Style (new) */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Animation</label>
                            <div className="grid grid-cols-2 gap-2">
                                {ANIMATION_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setAnimation(opt.value)}
                                        className={`p-2 rounded-lg border text-center text-xs font-medium transition-all ${animation === opt.value ? 'bg-primary/20 border-primary text-white' : 'bg-white/5 border-white/5 text-zinc-400 hover:bg-white/10'}`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Editable transcript — visible by DEFAULT now,
                            because hiding it behind a collapsed toggle
                            meant most users never realised they could
                            fix Whisper misreads. Renamed to make the
                            purpose obvious: "Fix wrong words" not
                            "Edit Text". Sync button below aligns timing
                            to actual audio after edits — same /sync-
                            transcript endpoint Regenerate uses, but
                            available in the default Auto mode too. */}
                        {useRemotionPreview && (
                            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
                                <button
                                    type="button"
                                    onClick={() => setShowTextEditor(!showTextEditor)}
                                    className="w-full flex items-center justify-between text-xs font-bold text-emerald-300 uppercase tracking-wider"
                                >
                                    <span className="flex items-center gap-1.5">
                                        <Type size={12} /> Fix wrong words ({captions.length} words detected)
                                    </span>
                                    <span className={`transition-transform ${showTextEditor ? 'rotate-180' : ''}`}>▾</span>
                                </button>
                                {showTextEditor && (
                                    <>
                                        <p className="text-[10px] text-zinc-400 leading-relaxed">
                                            Whisper got something wrong? Edit the text below — each word will be re-aligned to the audio when you click Sync. Then Generate Subtitles to burn.
                                        </p>
                                        <textarea
                                            value={editableText}
                                            onChange={(e) => handleTextEdit(e.target.value)}
                                            rows={5}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 resize-none leading-relaxed animate-[fadeIn_0.15s_ease-out]"
                                            placeholder="Edit subtitle text..."
                                        />
                                        <div className="flex items-center justify-between gap-2 flex-wrap">
                                            <div className="text-[10px] text-zinc-500 leading-snug">
                                                {autoSyncStatus === 'done' && (
                                                    <span className="text-emerald-300 inline-flex items-center gap-1">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Timing synced — ready to burn.
                                                    </span>
                                                )}
                                                {autoSyncStatus === 'stale' && (
                                                    <span className="text-amber-300 inline-flex items-center gap-1">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Edits made — re-Sync recommended.
                                                    </span>
                                                )}
                                                {autoSyncStatus === 'syncing' && 'Aligning words to audio…'}
                                                {autoSyncStatus === 'error' && (
                                                    <span className="text-red-300 break-words">{autoSyncError}</span>
                                                )}
                                                {!autoSyncStatus && 'Edits use the original Whisper timing until you Sync.'}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={runAutoSync}
                                                disabled={autoSyncStatus === 'syncing' || !editableText?.trim()}
                                                className="text-[11px] px-3 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 font-bold"
                                                title="Re-align word timing to the actual audio using your edited text. Takes ~3-5s."
                                            >
                                                {autoSyncStatus === 'syncing' ? (
                                                    <><Loader2 size={11} className="animate-spin" /> Syncing…</>
                                                ) : (
                                                    <><RotateCcw size={11} /> Sync to audio</>
                                                )}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {/* AI MODEL — the Roman / Translate / Regenerate steps
                            call an LLM. Without a picker here the modal used
                            whatever provider was saved globally (often Gemini,
                            whose free tier is 20 req/day) and there was no way
                            to switch — so a quota error left the user stuck.
                            ProviderPicker persists to the same localStorage key
                            buildLlmHeaders() reads at request time, so changing
                            it here takes effect immediately. Pick Ollama for a
                            free, local, no-quota provider. */}
                        <div className="rounded-lg border border-white/10 bg-surface/40 p-3">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center gap-1.5">
                                    <Sparkles size={11} className="text-primary" /> AI model
                                </div>
                                <div className="flex-1 min-w-[200px] flex justify-end">
                                    <ProviderPicker />
                                </div>
                            </div>
                            <p className="text-[10px] text-zinc-500 mt-2 leading-snug">
                                Used by Roman / Translate / Regenerate. Pick <strong className="text-zinc-300">Ollama</strong> (free, local, no quota) if Gemini hits its daily limit.
                            </p>
                        </div>

                        {/* Subtitle script — original / roman / translate / regenerate.
                            Two rows on small viewports, one row on wider. */}
                        <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2.5">
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider block">Subtitle text</label>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                                {[
                                    ['auto',       'Original'],
                                    ['roman',      'Roman'],
                                    ['translate',  'Translate'],
                                    ['regenerate', 'Regenerate'],
                                ].map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => {
                                            // Inherit the user's last script intent into
                                            // the Regenerate panel's cleanup mode so that
                                            // when they click "Roman" then "Regenerate",
                                            // the regenerate path actually produces Roman
                                            // output instead of raw mixed Whisper text.
                                            // Same for Translate → keeps the target lang.
                                            if (mode === 'regenerate') {
                                                if (scriptMode === 'roman') {
                                                    setRegenCleanupMode('roman');
                                                } else if (scriptMode === 'translate') {
                                                    setRegenCleanupMode('translate');
                                                    setRegenTargetLang(targetLanguage || 'en');
                                                }
                                                // If scriptMode was 'auto' and the user
                                                // explicitly switched to Regenerate, leave
                                                // whatever they already picked in the
                                                // Regenerate panel — that's an explicit
                                                // sub-choice.
                                            }
                                            // When user goes BACK to a top tab (Roman /
                                            // Translate / Original), pull their pick into
                                            // the regen cleanup so flipping between tabs
                                            // doesn't lose intent.
                                            if (mode === 'roman') setRegenCleanupMode('roman');
                                            if (mode === 'translate') setRegenCleanupMode('translate');
                                            setScriptMode(mode);
                                        }}
                                        className={
                                            'px-2.5 py-2 rounded-md text-xs font-medium transition ' +
                                            (scriptMode === mode
                                                ? 'bg-primary/15 text-primary border border-primary/40'
                                                : 'bg-black/30 text-zinc-400 border border-white/5 hover:border-white/15 hover:text-zinc-200')
                                        }
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            {scriptMode === 'translate' && (
                                <select
                                    value={targetLanguage}
                                    onChange={(e) => setTargetLanguage(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50"
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
                                        <option key={code} value={code}>{name}</option>
                                    ))}
                                </select>
                            )}
                            <p className="text-[11px] text-zinc-500 leading-relaxed">
                                {scriptMode === 'auto' && 'Use the transcript exactly as Whisper output it.'}
                                {scriptMode === 'roman' && 'Transliterate Hindi/Urdu/Arabic/etc. into Roman/Latin script. Same words — different writing system.'}
                                {scriptMode === 'translate' && 'Translate the transcript to the chosen language using your AI provider.'}
                                {scriptMode === 'regenerate' && 'Re-run Whisper on this clip’s audio from scratch — useful when the original transcribe was wrong (mis-detected language, dropped words, etc.). Slower than other modes.'}
                            </p>
                            {(scriptMode === 'roman' || scriptMode === 'translate') && (
                                <div className="flex items-start gap-1.5 text-[11px] text-amber-200/80 bg-amber-500/5 border border-amber-500/15 rounded-md p-2">
                                    <Lightbulb size={12} className="mt-0.5 shrink-0 text-amber-400" />
                                    <span className="leading-relaxed">
                                        Don&apos;t love the result? Click <strong>Generate Subtitles</strong> again — each run produces a fresh
                                        AI rewrite, so a second or third try often reads better. Or pick <strong>Regenerate</strong>{' '}
                                        to re-transcribe the audio from scratch first.
                                    </span>
                                </div>
                            )}
                            {scriptMode === 'regenerate' && (
                                <>
                                    <div className="flex items-start gap-1.5 text-[11px] text-amber-200/80 bg-amber-500/5 border border-amber-500/15 rounded-md p-2">
                                        <Lightbulb size={12} className="mt-0.5 shrink-0 text-amber-400" />
                                        <span className="leading-relaxed">
                                            Four steps. <strong>1</strong>: re-transcribe with Whisper.
                                            <strong> 2</strong>: proofread &amp; edit the text.
                                            <strong> 3</strong>: sync timing to the spoken audio.
                                            <strong> 4</strong>: burn onto the video. Each step is separate — you can
                                            stop and inspect after any of them.
                                        </span>
                                    </div>

                                    {/* Phase-1 controls — show when no result yet */}
                                    {!regenResult && regenStatus !== 'transcribing' && regenStatus !== 'cleaning' && (
                                        <div className="rounded-md border border-white/10 bg-black/40 p-3 space-y-3">
                                            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">
                                                Step 1 · Pick the output language / script
                                            </div>
                                            {/* Five-button grid: keeping the original transcript
                                                language, romanising it, code-switch-preserving
                                                Hinglish/Urglish (English words stay English), or
                                                translating to a target language. The latter shows
                                                its target picker below. */}
                                            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                                                {[
                                                    ['auto', 'Original',         'Keep the source language as Whisper transcribed it (e.g. Urdu, Hindi).'],
                                                    ['roman', 'Roman',           'Transliterate everything into Roman/Latin script. Same words, different writing system.'],
                                                    ['hinglish', 'Hinglish',     'Hindi → Roman, English words and phrases stay in English (e.g. "yeh layer zero hai").'],
                                                    ['urglish', 'Urglish',       'Urdu → Roman, English words and phrases stay in English (e.g. "Bitcoin hold karo, community ke saath").'],
                                                    ['translate', 'Translate',   'Translate to a target language (English, Spanish, French, etc.).'],
                                                ].map(([m, lbl, hint]) => (
                                                    <button
                                                        key={m}
                                                        type="button"
                                                        title={hint}
                                                        onClick={() => setRegenCleanupMode(m)}
                                                        className={
                                                            'px-2 py-1.5 rounded text-[11px] font-medium transition ' +
                                                            (regenCleanupMode === m
                                                                ? 'bg-primary/20 text-primary border border-primary/40'
                                                                : 'bg-black/30 text-zinc-300 border border-white/5 hover:border-white/20')
                                                        }
                                                    >
                                                        {lbl}
                                                    </button>
                                                ))}
                                            </div>
                                            {/* One-line description of the active mode so the
                                                user gets immediate feedback without hovering. */}
                                            <p className="text-[11px] text-zinc-500 leading-relaxed">
                                                {regenCleanupMode === 'auto' && 'Output the transcript in the language Whisper detected — no rewrite, no transliteration.'}
                                                {regenCleanupMode === 'roman' && 'Transliterate Hindi/Urdu/Arabic into Roman/Latin script. Same words, different writing system.'}
                                                {regenCleanupMode === 'hinglish' && 'Hindi → Roman; every English word stays in English (e.g. layer zero, community, Bitcoin).'}
                                                {regenCleanupMode === 'urglish' && 'Urdu → Roman; every English word stays in English (e.g. layer zero, community, Bitcoin).'}
                                                {regenCleanupMode === 'translate' && 'Translate the transcript to the chosen target language.'}
                                            </p>
                                            {regenCleanupMode === 'translate' && (
                                                <select
                                                    value={regenTargetLang}
                                                    onChange={(e) => setRegenTargetLang(e.target.value)}
                                                    className="w-full bg-black/40 border border-white/10 rounded-md p-2 text-xs text-white focus:outline-none focus:border-primary/50"
                                                >
                                                    {[
                                                        ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
                                                        ['de', 'German'], ['hi', 'Hindi'], ['ur', 'Urdu'],
                                                        ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'],
                                                        ['ko', 'Korean'], ['pt', 'Portuguese'], ['it', 'Italian'],
                                                        ['ru', 'Russian'], ['tr', 'Turkish'],
                                                    ].map(([code, name]) => (
                                                        <option key={code} value={code}>{name}</option>
                                                    ))}
                                                </select>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => runRegenerate()}
                                                disabled={regenStatus === 'transcribing' || regenStatus === 'cleaning'}
                                                className="w-full py-2 rounded-md bg-primary hover:bg-blue-600 text-white text-xs font-bold flex items-center justify-center gap-2"
                                            >
                                                <RotateCcw size={14} /> Re-transcribe this clip
                                            </button>
                                            {regenError && <p className="text-[11px] text-red-400">{regenError}</p>}
                                        </div>
                                    )}

                                    {/* Phase-1 progress */}
                                    {(regenStatus === 'transcribing' || regenStatus === 'cleaning') && (
                                        <div className="rounded-md border border-white/10 bg-black/40 p-3 flex items-center gap-2 text-[12px] text-zinc-200">
                                            <Loader2 size={14} className="animate-spin text-primary" />
                                            {regenStatus === 'transcribing' ? 'Re-transcribing audio…' : 'AI cleaning the transcript…'}
                                        </div>
                                    )}

                                    {/* Phase-2 preview + edit */}
                                    {regenResult && (
                                        <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2.5">
                                            <div className="flex items-center justify-between">
                                                <div className="text-[11px] uppercase tracking-wider text-green-300 font-bold flex items-center gap-2 flex-wrap">
                                                    <span>Step 2 · Proofread</span>
                                                    {/* Active output-language badge. Without this,
                                                        when the cleanup_mode default was 'auto'
                                                        the user saw mixed Urdu/Roman text and
                                                        couldn't tell whether Roman was even
                                                        requested. Showing the actual mode here
                                                        makes the mismatch obvious. */}
                                                    <span className={
                                                        'normal-case tracking-normal px-1.5 py-0.5 rounded text-[10px] font-mono ' +
                                                        (regenCleanupMode === 'auto'
                                                            ? 'bg-amber-500/15 text-amber-200 border border-amber-500/30'
                                                            : 'bg-primary/15 text-primary border border-primary/30')
                                                    }>
                                                        Output:&nbsp;
                                                        {regenCleanupMode === 'auto' && 'Original (no rewrite)'}
                                                        {regenCleanupMode === 'roman' && 'Roman / Latin'}
                                                        {regenCleanupMode === 'hinglish' && 'Hinglish'}
                                                        {regenCleanupMode === 'urglish' && 'Urglish'}
                                                        {regenCleanupMode === 'translate' && `Translate → ${regenTargetLang}`}
                                                    </span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={cancelRegenerate}
                                                    className="text-[10px] text-zinc-400 hover:text-white"
                                                >
                                                    Discard
                                                </button>
                                            </div>

                                            {/* Inline "wrong language?" recovery panel. Lets the
                                                user re-run Step 1 with a different cleanup mode
                                                without having to scroll up to the Step-1 picker.
                                                Includes the Translate target-language selector
                                                inline so the full picker is right here. */}
                                            <div className="rounded border border-white/10 bg-black/40 p-2.5 space-y-2">
                                                <div className="text-[10px] text-zinc-400 leading-snug">
                                                    Output doesn't match what you wanted? Pick a different language and click <strong className="text-zinc-200">Re-run Step 1</strong> below (your text edits will be replaced).
                                                </div>
                                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1">
                                                    {[
                                                        ['auto', 'Original'],
                                                        ['roman', 'Roman'],
                                                        ['hinglish', 'Hinglish'],
                                                        ['urglish', 'Urglish'],
                                                        ['translate', 'Translate'],
                                                    ].map(([m, lbl]) => (
                                                        <button
                                                            key={m}
                                                            type="button"
                                                            onClick={() => setRegenCleanupMode(m)}
                                                            className={
                                                                'px-1.5 py-1 rounded text-[10px] font-medium transition ' +
                                                                (regenCleanupMode === m
                                                                    ? 'bg-primary/20 text-primary border border-primary/40'
                                                                    : 'bg-black/40 text-zinc-300 border border-white/5 hover:border-white/20')
                                                            }
                                                        >
                                                            {lbl}
                                                        </button>
                                                    ))}
                                                </div>
                                                {/* Inline target-language picker — only shown
                                                    when Translate is selected. Mirrors the Step-1
                                                    dropdown so users don't have to scroll up. */}
                                                {regenCleanupMode === 'translate' && (
                                                    <select
                                                        value={regenTargetLang}
                                                        onChange={(e) => setRegenTargetLang(e.target.value)}
                                                        className="w-full bg-black/40 border border-white/10 rounded-md p-1.5 text-[11px] text-white focus:outline-none focus:border-primary/50"
                                                    >
                                                        {[
                                                            ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
                                                            ['de', 'German'], ['hi', 'Hindi'], ['ur', 'Urdu'],
                                                            ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'],
                                                            ['ko', 'Korean'], ['pt', 'Portuguese'], ['it', 'Italian'],
                                                            ['ru', 'Russian'], ['tr', 'Turkish'],
                                                        ].map(([code, name]) => (
                                                            <option key={code} value={code}>{name}</option>
                                                        ))}
                                                    </select>
                                                )}
                                                {/* Re-run button — discards the current proofread
                                                    result and re-runs Step 1 with the picked
                                                    language. No need to scroll anywhere. */}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setRegenEditedText('');
                                                        // Call DIRECTLY with the picked mode/lang
                                                        // so it never fires with a stale value —
                                                        // runRegenerate clears regenResult itself.
                                                        runRegenerate(regenCleanupMode, regenTargetLang);
                                                    }}
                                                    className="w-full py-1.5 rounded bg-primary/80 hover:bg-primary text-white text-[11px] font-bold flex items-center justify-center gap-1.5"
                                                >
                                                    <RotateCcw size={11} />
                                                    Re-run Step 1 in{' '}
                                                    {regenCleanupMode === 'auto' && 'Original'}
                                                    {regenCleanupMode === 'roman' && 'Roman'}
                                                    {regenCleanupMode === 'hinglish' && 'Hinglish'}
                                                    {regenCleanupMode === 'urglish' && 'Urglish'}
                                                    {regenCleanupMode === 'translate' && `Translate → ${regenTargetLang}`}
                                                </button>
                                            </div>

                                            {/* External-AI workaround: copy transcript + a full
                                                Urglish prompt, do the cleanup in aistudio.google.com /
                                                Gemini / ChatGPT, then paste the result back below.
                                                Useful when the in-app subscription cookies are flaky. */}
                                            <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2.5 space-y-1.5">
                                                <div className="text-[10px] text-cyan-200/90 leading-snug">
                                                    <strong>Do the cleanup in an external AI</strong> (Google AI Studio, Gemini, or ChatGPT) and paste the result back below. The copy includes a ready-made Urglish prompt (Roman Urdu + English words kept in English).
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={copyExternalAiPrompt}
                                                    className={
                                                        'w-full py-1.5 rounded text-[11px] font-bold flex items-center justify-center gap-1.5 transition ' +
                                                        (extCopied
                                                            ? 'bg-green-500/20 text-green-200 border border-green-400/40'
                                                            : 'bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-100 border border-cyan-400/30')
                                                    }
                                                >
                                                    {extCopied
                                                        ? <>✓ Copied — paste into aistudio.google.com, then paste the result below</>
                                                        : <><Copy size={11} /> Copy transcript + Urglish prompt for external AI</>}
                                                </button>
                                            </div>

                                            <textarea
                                                value={regenEditedText}
                                                onChange={(e) => handleRegenTextEdit(e.target.value)}
                                                rows={6}
                                                className="w-full bg-black/40 border border-white/10 rounded-md p-2 text-[12px] text-white focus:outline-none focus:border-green-500/50 resize-y leading-relaxed"
                                            />
                                            <p className="text-[10px] text-zinc-500 leading-relaxed">
                                                Edit the text above (or paste your external-AI result here). After editing, run <strong>Step 3 (Sync)</strong>
                                                so the burned subtitles line up with the spoken audio.
                                            </p>
                                        </div>
                                    )}

                                    {/* Phase-3 SYNC */}
                                    {regenResult && (
                                        <div className={
                                            'rounded-md border p-3 space-y-2.5 ' +
                                            (syncStatus === 'done'
                                                ? 'border-blue-500/40 bg-blue-500/5'
                                                : syncStatus === 'stale'
                                                  ? 'border-amber-500/40 bg-amber-500/5'
                                                  : 'border-white/10 bg-black/40')
                                        }>
                                            <div className="flex items-center justify-between">
                                                <div className={
                                                    'text-[11px] uppercase tracking-wider font-bold ' +
                                                    (syncStatus === 'done' ? 'text-blue-300' : 'text-zinc-300')
                                                }>
                                                    Step 3 · Sync timing to audio
                                                </div>
                                                {syncStatus === 'done' && (
                                                    <span className="text-[10px] text-blue-300 inline-flex items-center gap-1">
                                                        <Lightbulb size={10} /> Synced
                                                    </span>
                                                )}
                                                {syncStatus === 'stale' && (
                                                    <span className="text-[10px] text-amber-300">
                                                        Edited again — re-sync recommended
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-zinc-500 leading-relaxed">
                                                Re-runs Whisper to find where each phrase is actually spoken in the audio,
                                                then maps your edited text onto those time slots. Without this step, after
                                                editing, subtitles can drift a second or two from the voice.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={runSync}
                                                disabled={syncStatus === 'syncing' || !regenEditedText.trim()}
                                                className="w-full py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                                            >
                                                {syncStatus === 'syncing' ? (
                                                    <><Loader2 size={14} className="animate-spin" /> Syncing audio…</>
                                                ) : syncStatus === 'done' ? (
                                                    <><RotateCcw size={14} /> Sync again</>
                                                ) : (
                                                    <><RotateCcw size={14} /> Run Step 3 · Sync now</>
                                                )}
                                            </button>
                                            {syncError && <p className="text-[11px] text-red-400">{syncError}</p>}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* Font Family */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Font</label>
                            <select
                                value={fontName}
                                onChange={(e) => setFontName(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50"
                            >
                                {FONT_OPTIONS.map((f) => (
                                    <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Font Size — slider value = real pixels on the burned video */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block flex items-center justify-between">
                                <span>Font size</span>
                                <span className="tabular-nums text-zinc-200 font-medium">{fontSize}px</span>
                            </label>
                            <input
                                type="range"
                                min={20}
                                max={128}
                                step={2}
                                value={fontSize}
                                onChange={(e) => setFontSize(+e.target.value)}
                                className="w-full accent-primary"
                            />
                            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                                <span>Small</span>
                                <span>Default 64</span>
                                <span>Huge</span>
                            </div>
                            <div className="flex justify-between text-[10px] uppercase tracking-wider text-zinc-500 mt-1">
                                <span>Small</span>
                                <span>Default</span>
                                <span>Huge</span>
                            </div>
                        </div>

                        {/* Text Color */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Text Color</label>
                            <div className="flex flex-wrap gap-2">
                                {COLOR_PRESETS.map((c) => (
                                    <button
                                        key={c.color}
                                        onClick={() => setFontColor(c.color)}
                                        className={`w-7 h-7 rounded-full border-2 transition-all ${fontColor === c.color ? 'border-white scale-110' : 'border-white/20 hover:border-white/50'}`}
                                        style={{ backgroundColor: c.color }}
                                        title={c.label}
                                    />
                                ))}
                                <label className="w-7 h-7 rounded-full border-2 border-dashed border-white/20 cursor-pointer flex items-center justify-center hover:border-white/50 transition-all overflow-hidden relative" title="Custom color">
                                    <span className="text-[10px] text-zinc-400">+</span>
                                    <input type="color" value={fontColor} onChange={(e) => setFontColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                                </label>
                            </div>
                        </div>

                        {/* Highlight Color (new) */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Highlight Color</label>
                            <div className="flex flex-wrap gap-2">
                                {[{ color: '#FFDD00', label: 'Gold' }, { color: '#FF4444', label: 'Red' }, { color: '#00FF88', label: 'Green' }, { color: '#00BBFF', label: 'Blue' }, { color: '#FF69B4', label: 'Pink' }].map((c) => (
                                    <button
                                        key={c.color}
                                        onClick={() => setHighlightColor(c.color)}
                                        className={`w-7 h-7 rounded-full border-2 transition-all ${highlightColor === c.color ? 'border-white scale-110' : 'border-white/20 hover:border-white/50'}`}
                                        style={{ backgroundColor: c.color }}
                                        title={c.label}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Border / Outline */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Border</label>
                            <div className="flex items-center gap-3">
                                <label className="relative w-8 h-8 rounded-lg border border-white/10 cursor-pointer overflow-hidden shrink-0" title="Border color">
                                    <div className="w-full h-full" style={{ backgroundColor: borderColor }} />
                                    <input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                                </label>
                                <div className="flex-1">
                                    <input
                                        type="range"
                                        min="0"
                                        max="5"
                                        value={borderWidth}
                                        onChange={(e) => setBorderWidth(parseInt(e.target.value))}
                                        className="w-full accent-primary"
                                    />
                                    <div className="flex justify-between text-[10px] text-zinc-500">
                                        <span>None</span>
                                        <span>Thick</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Background Box */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Background Box</label>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" checked={bgOpacity > 0} onChange={(e) => setBgOpacity(e.target.checked ? 0.5 : 0)} className="sr-only peer" />
                                    <div className="w-8 h-4 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[0px] after:left-[0px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                                </label>
                            </div>
                            {bgOpacity > 0 && (
                                <div className="space-y-3 animate-[fadeIn_0.2s_ease-out]">
                                    <div className="flex items-center gap-3">
                                        <label className="relative w-8 h-8 rounded-lg border border-white/10 cursor-pointer overflow-hidden shrink-0" title="Background color">
                                            <div className="w-full h-full" style={{ backgroundColor: bgColor }} />
                                            <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                                        </label>
                                        <div className="flex-1">
                                            <input
                                                type="range"
                                                min="10"
                                                max="100"
                                                value={Math.round(bgOpacity * 100)}
                                                onChange={(e) => setBgOpacity(parseInt(e.target.value) / 100)}
                                                className="w-full accent-primary"
                                            />
                                            <div className="flex justify-between text-[10px] text-zinc-500">
                                                <span>Transparent</span>
                                                <span>{Math.round(bgOpacity * 100)}%</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <button
                        onClick={() => onGenerate({
                            position, fontSize, fontName, fontColor, borderColor, borderWidth, bgColor, bgOpacity,
                            // Animation + highlight color — these are
                            // the per-line ASS effects the burn pipeline
                            // applies in subtitles.srt_to_ass. Without
                            // including them here the modal preview
                            // would lie: it shows Pop / Karaoke / Glow
                            // animations that the backend would never
                            // render. Sending them keeps preview = burn.
                            animation, highlightColor,
                            // For regenerate mode we hand the backend the
                            // cleaned per-clip transcript already saved on
                            // the clip — pass scriptMode='auto' so the
                            // subtitle endpoint uses the regen instead of
                            // re-running anything.
                            scriptMode: scriptMode === 'regenerate' ? 'auto' : scriptMode,
                            targetLanguage: scriptMode === 'translate' ? targetLanguage : null,
                            // CRITICAL: when sync just ran (syncStatus==='done'),
                            // the server already saved the per-segment-aligned
                            // transcript. Sending edited_text would trigger the
                            // backend's naive even-redistribution and OVERWRITE
                            // the sync. Only pass edited_text when sync is
                            // stale (user edited after syncing) or hasn't been
                            // run yet — in those cases the backend redistribute
                            // is the only way to apply the user's edits.
                            editedText: (() => {
                                if (scriptMode === 'regenerate') {
                                    if (syncStatus === 'done') return null;  // Sync is fresh — backend has it
                                    return regenEditedText || null;
                                }
                                // Non-regenerate: legacy in-modal text editor
                                if (editableText && editableText !== originalCaptions.map(c => c.text).join(' ')) {
                                    return editableText;
                                }
                                return null;
                            })(),
                        })}
                        disabled={
                            isProcessing
                            || (scriptMode === 'regenerate' && !regenResult)
                        }
                        className="w-full py-3 mt-4 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-black font-bold rounded-xl shadow-lg shadow-orange-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isProcessing ? (
                            <><Loader2 size={20} className="animate-spin" /> Burning…</>
                        ) : scriptMode === 'auto' ? (
                            <><Type size={20} /> Generate Subtitles</>
                        ) : scriptMode === 'regenerate' ? (
                            regenResult
                                ? <><Type size={20} /> Step 4 · Burn into video</>
                                : <><RotateCcw size={20} /> Run Step 1 first</>
                        ) : (
                            <><RotateCcw size={20} /> Regenerate Subtitles</>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
