import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    Upload, Type, Loader2, Download, RotateCcw, Lightbulb, Check,
    ChevronRight, ChevronLeft, AlertCircle, Wand2, Palette, RefreshCw, Volume2,
    Plus, Trash2, Copy,
    // Used by the Phase 1 "Frame & crop" card. Adding the icon was the
    // missing piece that crashed the screen after that feature shipped
    // — `Languages` was referenced in JSX but never imported, so React
    // failed on render with `Languages is not defined`.
    Languages,
} from 'lucide-react';
import { getApiUrl } from '../config';
import StandalonePastList from './StandalonePastList';
import ProcessingPreview from './ProcessingPreview';
import SubtitleTemplatesPicker from './SubtitleTemplatesPicker';
import StandaloneReframeKeyframeModal from './StandaloneReframeKeyframeModal';
import ProviderPicker from './ProviderPicker';
import SubtitleTimeline from './SubtitleTimeline';
import { limitSubtitleLines } from '../utils/subtitleLines';
import { resolvePreviewFontFamily, computeSafeShrinkRatio, longestWrappedLineChars } from '../utils/fontFallbacks';

// Named pipeline stages for the Subtitle wizard. Each entry maps to a
// status the backend emits — ProcessingPreview highlights the active
// one and ticks off the rest. Exposed as a constant so future tweaks
// (renames, added stages) live in one place.
const SUBTITLE_PHASE1_STEPS = [
    { id: 'queued', label: 'Queued' },
    { id: 'transcribing', label: 'Transcribing audio' },
    { id: 'cleaning', label: 'AI cleanup pass' },
];
const SUBTITLE_PHASE2_STEPS = [
    { id: 'rendering', label: 'Burning subtitles into video' },
];

/**
 * Standalone Subtitle — two-phase wizard.
 *
 *   Phase 1 — Transcript:
 *     - Pick transcription engine (Whisper Turbo free / ElevenLabs paid)
 *     - Pick AI cleanup mode (Original / Roman / Translate)
 *     - Generate transcript
 *     - PREVIEW the result; user can hand-edit before continuing
 *
 *   Phase 2 — Subtitle styling:
 *     - Position, font size, font color, border, background, opacity, animation
 *     - Live overlay preview on the video
 *     - Burn button → final downloadable file
 *
 * Each phase is a discrete step the user can stop and inspect at.
 * Burning is the absolute last action.
 */

const SOURCE_LANGS = [
    ['', 'Auto-detect'],
    ['en', 'English'],
    ['ur', 'Urdu'],
    ['hi', 'Hindi'],
    // Mixed-script options for music / vlog content. Whisper sees a
    // primary language token but the AI cleanup + alignment treat
    // these as code-switched English+X. Especially important for
    // Roman Urdu / Hinglish songs where pure 'ur' or 'hi' produces
    // garbage transcription.
    ['hi-en', 'Hinglish (Hindi + English mixed)'],
    ['ur-en', 'Roman Urdu / Urdu + English mixed'],
    ['ar', 'Arabic'], ['fa', 'Persian'], ['es', 'Spanish'], ['fr', 'French'],
    ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['tr', 'Turkish'],
];

const TARGET_LANGS = [
    ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
    ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['hi', 'Hindi'],
    ['ur', 'Urdu'],
    // Mixed-script targets. Same backend translation pipeline, but the
    // prompt asks the model to emit Latin-script transliteration of
    // Hindi/Urdu instead of native Devanagari/Arabic script. Useful
    // for creators whose audience reads Roman-script South Asian
    // content (the bulk of Web3 / crypto vlogger audiences).
    ['hi-en', 'Hinglish (Hindi in Roman script + English)'],
    ['ur-en', 'Roman Urdu / Urglish (Urdu in Roman script + English)'],
    ['ar', 'Arabic'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['zh', 'Chinese'], ['tr', 'Turkish'],
];

const COLOR_PRESETS = [
    '#FFFFFF', '#FFFF00', '#00FFFF', '#00FF00', '#FF69B4', '#FF0000', '#000000',
];

export default function StandaloneSubtitle({ llmHeaders, elevenLabsKey, homeBump = 0, currentUser, onChooseTab }) {
    // ---- universal state ----
    const fileInputRef = useRef(null);
    const [file, setFile] = useState(null);
    // URL-ingest path. When non-empty, the backend will yt-dlp it
    // server-side instead of taking a file upload.
    const [url, setUrl] = useState('');
    const [phase, setPhase] = useState(1);
    const [jobId, setJobId] = useState(null);
    const [status, setStatus] = useState('idle'); // idle | queued | transcribing | cleaning | transcript_ready | rendering | completed | failed
    const [logs, setLogs] = useState([]);
    const [error, setError] = useState(null);

    // ---- phase 1 state ----
    const [transcribeProvider, setTranscribeProvider] = useState('whisper');
    const [sourceLang, setSourceLang] = useState('');
    const [scriptMode, setScriptMode] = useState('auto');
    const [targetLang, setTargetLang] = useState('en');
    const [transcriptText, setTranscriptText] = useState('');
    const [editedTranscript, setEditedTranscript] = useState('');
    // Per-segment timing payload from Phase 1 — used to render the
    // timestamped segment view AND offer an SRT download.
    const [segments, setSegments] = useState([]);
    // ALIGNED segments — populated by the BYOL "Align to audio" button
    // in Step 2. Coexists with `segments`; the user picks which one
    // to keep via a tab in the Phase 1 Preview editor (Timed / Plain /
    // Aligned). Whichever tab is active when "Continue to Step 3" is
    // clicked becomes the canonical segments for burn. Null = no
    // alignment run yet, "Aligned" tab is hidden.
    const [alignedSegments, setAlignedSegments] = useState(null);
    // BYOL — user can paste lyrics on the upload screen so Whisper
    // runs only for word-level timings; the cleaned transcript text
    // comes from the user's pasted lyrics. Empty string = standard
    // Whisper-only flow (backwards compatible).
    const [upfrontLyrics, setUpfrontLyrics] = useState('');
    const [upfrontLyricsKeepTags, setUpfrontLyricsKeepTags] = useState(false);

    // ---- regenerate / sync state ----
    // 'idle' → no action in flight.
    // 'regenerating' → waiting for /regenerate to push a new transcript_ready.
    // 'syncing' → waiting for /sync (synchronous endpoint, fast).
    // 'synced' → sync just succeeded; flag tells burn step to NOT re-send
    //            edited_text (which would overwrite the aligned timings).
    const [refineStatus, setRefineStatus] = useState('idle');
    const [refineError, setRefineError] = useState(null);
    // True when the backend has a pre-sync snapshot we can roll back
    // to. Cleared after Undo / regenerate / reset.
    const [canUndoSync, setCanUndoSync] = useState(false);

    // ---- phase 2 state ----
    // positionPct: vertical position of the subtitle TOP edge as a
    // percentage of frame height. 0 = top edge, 100 = bottom edge.
    // Default 85 mimics the previous "bottom with safe margin".
    // The legacy 3-button enum (`position`) is kept around for the live
    // preview's anchor anchor logic below.
    const [positionPct, setPositionPct] = useState(85);
    const [position, setPosition] = useState('bottom');
    // Manual time-shift applied to all subtitles at burn time. Lets the
    // user nudge the whole subtitle track forward / backward by ± 60 s
    // when automatic alignment for BYOL / translated content isn't
    // quite right. Live preview applies the offset client-side so the
    // user sees the change instantly without re-burning.
    const [timeOffsetSeconds, setTimeOffsetSeconds] = useState(0);
    // Output orientation. 'original' keeps source aspect. 'vertical'
    // crops to 9:16 (good for TikTok / Reels). 'horizontal' crops to
    // 16:9. cropXOffsetPct controls where the crop window sits when
    // the source is wider than the target (50 = centre by default).
    const [outputOrientation, setOutputOrientation] = useState('original');
    const [cropXOffsetPct, setCropXOffsetPct] = useState(50);
    const [cropYOffsetPct, setCropYOffsetPct] = useState(50);
    // Keyframed crop. When this list is non-empty AND outputOrientation
    // is not 'original', the burn pipeline pans/cuts the crop window
    // through these keyframes over the timeline instead of using the
    // static X/Y sliders. Each entry is { t, x, y, cut }.
    const [cropKeyframes, setCropKeyframes] = useState([]);
    // Default 32 = "preview CSS pixels". Combined with the new burn-time
    // scale-up (video_h/600), 32 produces ~102px on a 1920-tall vertical
    // video — i.e. ~5% of frame height, which is the typical viral
    // caption size on TikTok/Reels.
    const [fontSize, setFontSize] = useState(32);
    // Animation + highlight color — drive the libass effect path on
    // the burn pipeline. Defaults: 'none' = static text (current),
    // 'pop'/'karaoke'/'word-highlight'/'glow' for animated templates.
    // highlightColor is the per-word emphasis color used by Karaoke
    // and Word-Highlight; ignored for Pop/Glow/None.
    const [animation, setAnimation] = useState('none');
    const [highlightColor, setHighlightColor] = useState('#FFDD00');
    // Phase 2 styling: choose whether template clicks restyle ALL
    // subtitles or just the one currently selected on the timeline.
    // 'all' is the classic behaviour and is what the burn honours;
    // 'selected' writes per-segment _style overrides used by the live
    // preview. Backend ASS multi-style support is a follow-up.
    const [applyScope, setApplyScope] = useState('all'); // 'all' | 'selected'
    // Image overlays — drag-and-drop graphics from Finder/Explorer onto
    // the preview window. Each overlay is:
    //   { id, dataUrl, name, start, end, xPct, yPct, widthPct }
    // xPct/yPct are 0..100 (percent of frame width/height for the
    // top-left corner). widthPct is the rendered width as % of frame
    // width — height auto-scales to preserve aspect ratio. start/end
    // are seconds. Stored at the parent so they survive Phase 1 ↔
    // Phase 2 navigation; the timeline shows them as a separate
    // "Images" track and the preview renders them on top of the video
    // during their time range.
    const [imageOverlays, setImageOverlays] = useState([]);

    // ─── AUTO-SAVE / RESTORE ──────────────────────────────────────────
    // Auto-saves the in-progress subtitle edits to localStorage so a
    // crash, refresh, or accidental tab close doesn't lose work. Keyed
    // by jobId so each project has its own saved state.
    //   • Saves are debounced 1500 ms after the last change.
    //   • Image-overlay data URLs can be MEGABYTES, so if the save
    //     overflows localStorage quota we retry without overlays
    //     (better to keep subtitles than lose everything).
    //   • Restores happen ONCE per jobId, the first time status
    //     transitions to 'transcript_ready' (i.e. after the backend
    //     finishes loading the canonical state — that way our local
    //     draft replaces, not gets replaced by, the server's view).
    const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
    const [savedAt, setSavedAt] = useState(null);
    const restoredJobsRef = useRef(new Set());

    const _draftKey = (id) => `klipra_subtitle_draft_${id}`;

    // Build the draft object — single source of truth for what gets
    // persisted. Add fields here to widen the auto-save scope.
    const _buildDraft = useCallback(() => ({
        jobId,
        ts: Date.now(),
        version: 1,
        segments,
        alignedSegments,
        editedTranscript,
        positionPct,
        fontSize,
        imageOverlays,
        timeOffsetSeconds,
    }), [jobId, segments, alignedSegments, editedTranscript, positionPct, fontSize, imageOverlays, timeOffsetSeconds]);

    // Single source of truth for "write the current draft to disk".
    // Used by the debounced effect, periodic interval, beforeunload
    // handler, and the manual Save button. All paths converge here so
    // there's exactly one localStorage write codepath.
    const _flushSave = useCallback(() => {
        if (!jobId) return;
        try {
            const draft = _buildDraft();
            // SAFETY: never overwrite a non-empty saved draft with an
            // empty one. This protects against transient empty-segments
            // states that happen during job-switching (the parent
            // briefly sets segments to [] while fetching the new job's
            // server data). Without this guard, those transient empty
            // states would race the auto-save debounce and clobber the
            // user's good draft. If the in-memory state is empty, just
            // leave whatever's already in localStorage alone.
            const segs = Array.isArray(draft.segments) ? draft.segments : [];
            const aligned = Array.isArray(draft.alignedSegments) ? draft.alignedSegments : [];
            if (segs.length === 0 && aligned.length === 0) {
                try {
                    const existing = localStorage.getItem(_draftKey(jobId));
                    if (existing) {
                        const prior = JSON.parse(existing);
                        const priorSegs = Array.isArray(prior?.segments) ? prior.segments : [];
                        const priorAligned = Array.isArray(prior?.alignedSegments) ? prior.alignedSegments : [];
                        if (priorSegs.length > 0 || priorAligned.length > 0) {
                            // Don't clobber. Bail without changing status.
                            return false;
                        }
                    }
                } catch {}
            }
            // BACKEND PUSH — fire-and-forget POST to /save with the
            // full segments array so the server stays in sync with
            // what's on screen. Throttled to once every ~30 seconds
            // (separate from localStorage's 1.5s debounce) so we
            // don't hammer the backend while the user is actively
            // editing. Without this, Download SRT and re-open both
            // pulled stale data — that's the bug that cost edits.
            const now = Date.now();
            const lastBe = window.__klipraLastBackendPush || 0;
            const FORCE_RECENT = (segs.length > 0 || aligned.length > 0);
            if (FORCE_RECENT && (now - lastBe) > 30000) {
                window.__klipraLastBackendPush = now;
                const segsForBe = (segs.length ? segs : aligned).map((s) => ({
                    start: +s.start || 0,
                    end: +s.end || 0,
                    text: (s.text || '').trim(),
                    words: Array.isArray(s.words) ? s.words.filter((w) => w && (w.word || '').trim()) : undefined,
                }));
                fetch(getApiUrl('/api/standalone/subtitle/save'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        job_id: jobId,
                        full_segments: segsForBe,
                        position_pct: positionPct,
                        font_size: fontSize,
                    }),
                }).catch(() => { /* fire-and-forget; localStorage is the primary save */ });
            }
            try {
                localStorage.setItem(_draftKey(jobId), JSON.stringify(draft));
            } catch {
                // QuotaExceededError — image overlays push past the
                // ~5 MB localStorage cap. Retry without them so the
                // subtitles + styling at least survive.
                const lite = { ...draft, imageOverlays: [] };
                localStorage.setItem(_draftKey(jobId), JSON.stringify(lite));
                if (!(window.__klipraQuotaWarned)) {
                    console.warn('Auto-save: localStorage quota hit; image overlays excluded from draft.');
                    window.__klipraQuotaWarned = true;
                }
            }
            setSavedAt(Date.now());
            setSaveStatus('saved');
            return true;
        } catch (e) {
            console.warn('Auto-save failed:', e);
            setSaveStatus('error');
            return false;
        }
    }, [jobId, _buildDraft]);

    // PATH 1: debounced save — fires 1.5s after the most recent edit.
    // Quick feedback for users who pause briefly.
    useEffect(() => {
        if (!jobId || status !== 'transcript_ready') return;
        setSaveStatus('saving');
        const t = setTimeout(_flushSave, 1500);
        return () => clearTimeout(t);
    }, [jobId, status, _buildDraft, _flushSave]);

    // PATH 2: periodic save — fires every 30s regardless of edits, so
    // a continuous-editing session (e.g. dragging clips around for a
    // few minutes without pause) gets checkpointed too. The debounced
    // path above resets its timer on every keystroke / drag, which on
    // its own could leave a session unsaved for a long time. This
    // covers that gap.
    useEffect(() => {
        if (!jobId || status !== 'transcript_ready') return;
        const id = setInterval(_flushSave, 30000);
        return () => clearInterval(id);
    }, [jobId, status, _flushSave]);

    // PATH 3: save before the user navigates away — closes a tab,
    // navigates back, refreshes via Cmd+R, etc. Synchronous so it
    // always lands before the page unloads.
    useEffect(() => {
        if (!jobId || status !== 'transcript_ready') return;
        const onBeforeUnload = () => { _flushSave(); };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [jobId, status, _flushSave]);

    // Restore on first transition to transcript_ready for this jobId.
    useEffect(() => {
        if (!jobId || status !== 'transcript_ready') return;
        if (restoredJobsRef.current.has(jobId)) return;
        restoredJobsRef.current.add(jobId);
        try {
            const raw = localStorage.getItem(_draftKey(jobId));
            if (!raw) return;
            const draft = JSON.parse(raw);
            if (!draft || draft.jobId !== jobId) return;
            if (Array.isArray(draft.segments) && draft.segments.length) setSegments(draft.segments);
            if (Array.isArray(draft.alignedSegments)) setAlignedSegments(draft.alignedSegments);
            if (typeof draft.editedTranscript === 'string') setEditedTranscript(draft.editedTranscript);
            if (typeof draft.positionPct === 'number') setPositionPct(draft.positionPct);
            if (typeof draft.fontSize === 'number') setFontSize(draft.fontSize);
            if (Array.isArray(draft.imageOverlays)) setImageOverlays(draft.imageOverlays);
            if (typeof draft.timeOffsetSeconds === 'number') setTimeOffsetSeconds(draft.timeOffsetSeconds);
            setSavedAt(draft.ts || Date.now());
            setSaveStatus('saved');
            setLogs((prev) => ([...(prev || []), `🔄 Restored auto-saved draft from ${new Date(draft.ts).toLocaleTimeString()}.`]));
        } catch (e) {
            console.warn('Restore failed:', e);
        }
    }, [jobId, status]);

    // Manual save shortcut — Cmd/Ctrl+S forces an immediate flush so
    // the user gets explicit feedback ("yes, my work is saved"). The
    // debounced effect would still write within 1.5s, but users
    // expect Cmd+S to be authoritative.
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            if ((e.key || '').toLowerCase() !== 's') return;
            // Don't fight the user's actual save in a textarea/input.
            const tag = (document.activeElement?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
            e.preventDefault();
            if (!jobId || status !== 'transcript_ready') return;
            _flushSave();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [jobId, status, _flushSave]);
    const [fontName, setFontName] = useState('Verdana');
    const [fontColor, setFontColor] = useState('#FFFFFF');
    const [borderColor, setBorderColor] = useState('#000000');
    const [borderWidth, setBorderWidth] = useState(2);
    const [bgColor, setBgColor] = useState('#000000');
    const [bgOpacity, setBgOpacity] = useState(0.0);
    const [finalVideoUrl, setFinalVideoUrl] = useState(null);

    // Source video URL used by Phase 1 + Phase 2 previews. Three cases:
    //   • File upload → browser blob URL (instant, no network round-trip).
    //   • URL ingest with a job_id → server-streamed source video.
    //   • Neither → null (preview shows fallback message).
    const [localPreviewUrl, setLocalPreviewUrl] = useState(null);
    useEffect(() => {
        if (file) {
            const u = URL.createObjectURL(file);
            setLocalPreviewUrl(u);
            return () => URL.revokeObjectURL(u);
        }
        if (jobId) {
            // URL-ingest path. Backend exposes the downloaded source.
            // The cache-buster forces a fresh load when the user
            // restarts a job within the same tab.
            setLocalPreviewUrl(getApiUrl(`/api/standalone/${jobId}/source-video`));
            return;
        }
        setLocalPreviewUrl(null);
    }, [file, jobId]);

    // Poll status while a phase is running. Note: 'cleaning' fires from
    // BOTH initial Phase 1 and regenerate, so we keep polling on it.
    useEffect(() => {
        if (!jobId) return;
        if (['idle', 'transcript_ready', 'completed', 'failed'].includes(status)) return;
        const id = setInterval(async () => {
            try {
                const r = await fetch(getApiUrl(`/api/standalone/status/${jobId}`));
                if (!r.ok) return;
                const data = await r.json();
                setStatus(data.status);
                setLogs(data.logs || []);
                // When the backend marks the job failed, surface the
                // actual error from its logs instead of leaving us at
                // the generic "Something went wrong" fallback. Backend
                // pushes the error as the LAST log line (e.g.
                // "Error in Phase 1: <stack trace summary>").
                if (data.status === 'failed') {
                    const last = (data.logs || []).slice().reverse()
                        .find((line) => /error|fail/i.test(line || ''));
                    setError(last || (data.logs && data.logs[data.logs.length - 1]) || 'Pipeline failed without an error message — check Docker logs.');
                }
                if (data.result) {
                    if (data.result.phase === 1 && data.result.transcript_text) {
                        setTranscriptText(data.result.transcript_text);
                        setEditedTranscript(data.result.transcript_text);
                        if (Array.isArray(data.result.segments)) {
                            setSegments(data.result.segments);
                        }
                        // Once we hit transcript_ready, regenerate / sync are
                        // either done or never ran. Clear the in-flight flag.
                        if (data.status === 'transcript_ready') {
                            setRefineStatus(data.result.synced ? 'synced' : 'idle');
                        }
                    }
                    if (data.result.phase === 2 && data.result.video_url) {
                        setFinalVideoUrl(data.result.video_url);
                    }
                }
            } catch { /* keep polling */ }
        }, 2000);
        return () => clearInterval(id);
    }, [jobId, status]);

    // Re-run AI cleanup against the saved RAW Whisper transcript. Cheap —
    // skips re-transcription. Backend pushes a fresh transcript_ready once
    // it's done.
    const regenerateTranscript = async () => {
        if (!jobId) return;
        setRefineError(null);
        setRefineStatus('regenerating');
        setStatus('cleaning');
        try {
            const res = await fetch(getApiUrl('/api/standalone/subtitle/regenerate'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(llmHeaders || {}),
                },
                body: JSON.stringify({ job_id: jobId }),
            });
            if (!res.ok) throw new Error(await res.text());
            // Polling effect picks it up from here.
        } catch (e) {
            setRefineError(e.message || String(e));
            setRefineStatus('idle');
            setStatus('transcript_ready');
        }
    };

    // Re-create a completed project with a different output mode.
    // Two paths share this single handler:
    //   • mode='translate', target=<ISO> → translate to that language
    //   • mode='roman'                   → transliterate the SAME
    //     language into Roman/Latin script (no translation). Use this
    //     when the user wants Roman Urdu / Hinglish / pinyin from a
    //     non-Latin transcript without changing what the speaker said.
    //
    // Both flows reuse the saved Whisper transcript so re-running is
    // ~10 seconds of LLM, not a fresh 10-15-minute transcribe. The
    // original output mp4 stays on disk — re-burn produces a fresh
    // file with a new timestamp, so a single project can yield
    // English / Spanish / Roman Urdu side-by-side.
    const retranslateTo = async (mode, target) => {
        // Backwards compat: callers that pass a single ISO string
        // (the original signature) get treated as translate-to-that.
        // We have to exclude every known mode keyword — not just
        // 'roman' — otherwise calling retranslateTo('auto') would
        // try to translate to a non-existent language code "auto".
        const KNOWN_MODES = new Set(['auto', 'roman', 'translate']);
        if (typeof mode === 'string' && target === undefined && !KNOWN_MODES.has(mode)) {
            target = mode;
            mode = 'translate';
        }
        if (!jobId) return;
        if (mode === 'translate' && !target) return;
        setError(null);
        setRefineError(null);
        // Reset transcript-related state so the old language's
        // segments don't briefly flash through the editor before the
        // new ones arrive.
        setSegments([]);
        setTranscriptText('');
        setEditedTranscript('');
        setFinalVideoUrl(null);
        setScriptMode(mode);
        if (mode === 'translate') setTargetLang(target);
        setRefineStatus('regenerating');
        setPhase(1);
        setStatus('cleaning');
        try {
            const res = await fetch(getApiUrl('/api/standalone/subtitle/regenerate'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(llmHeaders || {}),
                },
                body: JSON.stringify({
                    job_id: jobId,
                    script_mode: mode,
                    target_language: mode === 'translate' ? target : null,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            // Polling effect picks it up — it'll flip status from
            // 'cleaning' to 'transcript_ready' when the new translation
            // arrives, and the user lands on the editor automatically.
        } catch (e) {
            setError('Could not re-create: ' + (e.message || String(e)));
            setRefineStatus('idle');
            setStatus('completed');
        }
    };

    // Word-level alignment of the user's current transcript text against
    // real audio timings. The endpoint may decline to apply (returns
    // applied=false) when alignment quality is too low — e.g. the text
    // has been Romanized or translated. In that case we surface the
    // explanation and DON'T touch the local segments, so the existing
    // good-enough timings stay in place.
    const syncTranscript = async () => {
        if (!jobId) return;
        setRefineError(null);
        setRefineStatus('syncing');
        try {
            const res = await fetch(getApiUrl('/api/standalone/subtitle/sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, edited_text: editedTranscript }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.applied === false) {
                // Sync deliberately did NOT apply. Keep the existing
                // transcript/segments untouched and tell the user why.
                setRefineStatus('idle');
                setRefineError(
                    data.message ||
                    'Sync would not improve timing here, so nothing was changed.'
                );
                return;
            }
            if (Array.isArray(data.segments)) setSegments(data.segments);
            if (data.text) {
                setTranscriptText(data.text);
                setEditedTranscript(data.text);
            }
            setRefineStatus('synced');
            setCanUndoSync(!!data.can_undo);
            setStatus('transcript_ready');
        } catch (e) {
            setRefineError(e.message || String(e));
            setRefineStatus('idle');
        }
    };

    // Restore the transcript snapshot the backend took right before the
    // most recent sync. One-shot — clears can_undo on success.
    const undoSync = async () => {
        if (!jobId) return;
        setRefineError(null);
        setRefineStatus('syncing');
        try {
            const res = await fetch(getApiUrl('/api/standalone/subtitle/undo-sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (Array.isArray(data.segments)) setSegments(data.segments);
            if (data.text) {
                setTranscriptText(data.text);
                setEditedTranscript(data.text);
            }
            setRefineStatus('idle');
            setCanUndoSync(false);
        } catch (e) {
            setRefineError(e.message || String(e));
            setRefineStatus('idle');
        }
    };

    const reset = () => {
        setPhase(1);
        setJobId(null);
        setStatus('idle');
        setLogs([]);
        setError(null);
        setFile(null);
        setUrl('');
        setTranscriptText('');
        setEditedTranscript('');
        setSegments([]);
        setFinalVideoUrl(null);
        setRefineStatus('idle');
        setRefineError(null);
        setCanUndoSync(false);
        // Reset Phase-2 reframe so a fresh upload doesn't inherit the
        // previous job's keyframes. The orientation/X/Y sliders are
        // already kept since they're harmless defaults.
        setCropKeyframes([]);
    };

    // Header re-click → reset to home. App.jsx increments `homeBump`
    // every time the user clicks the Auto Subtitle tab while it's
    // already active. We watch for changes and treat each bump as a
    // "go back to the upload screen" command. Skipping bump=0 (the
    // initial value) so the first mount doesn't trigger a no-op reset.
    useEffect(() => {
        if (homeBump > 0) {
            reset();
            // Also clear the persisted active-job pointer so the next
            // refresh doesn't immediately yank us back into a stale job.
            try { localStorage.removeItem('klipra_subtitle_active_job'); } catch {}
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [homeBump]);

    // Persist the active jobId to localStorage so a browser refresh
    // (or a tab close) doesn't lose the user's connection to a job
    // that's still running on the backend. Without this, the page
    // remounted with status=idle and no way to find the job that was
    // still cleaning/transcribing in the background — exactly the
    // "stuck on AI cleaning, refreshed, project gone" complaint.
    //
    // We persist on every status change to a non-terminal state and
    // clear on completion/failure/reset.
    useEffect(() => {
        const TERMINAL = ['idle', 'completed', 'failed'];
        try {
            if (jobId && !TERMINAL.includes(status)) {
                localStorage.setItem(
                    'klipra_subtitle_active_job',
                    JSON.stringify({ jobId, status, savedAt: Date.now() }),
                );
            } else {
                localStorage.removeItem('klipra_subtitle_active_job');
            }
        } catch {}
    }, [jobId, status]);

    // On mount, check whether there's a running job from a previous
    // session and rehydrate it. The backend keeps the asyncio task
    // running across browser refreshes, so we can just resume polling
    // and the user lands back where they left off — same wizard step,
    // same logs, same transcript if it's already arrived.
    useEffect(() => {
        try {
            const raw = localStorage.getItem('klipra_subtitle_active_job');
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (!saved?.jobId) return;
            // Stale pointers older than 24h get dropped — backend
            // probably already deleted/completed them, and showing a
            // 24h-old stuck job feels wrong.
            const ageMs = Date.now() - (saved.savedAt || 0);
            if (ageMs > 24 * 3600 * 1000) {
                localStorage.removeItem('klipra_subtitle_active_job');
                return;
            }
            (async () => {
                try {
                    const r = await fetch(getApiUrl(`/api/standalone/status/${saved.jobId}`));
                    if (!r.ok) {
                        // Job vanished — clear the pointer.
                        localStorage.removeItem('klipra_subtitle_active_job');
                        return;
                    }
                    const data = await r.json();
                    // Wrong job kind? Don't touch it.
                    if (data.kind && data.kind !== 'subtitle') return;
                    setJobId(saved.jobId);
                    setStatus(data.status || 'queued');
                    setLogs(data.logs || []);
                    if (data.result) {
                        if (data.result.phase === 1 && data.result.transcript_text) {
                            setTranscriptText(data.result.transcript_text);
                            setEditedTranscript(data.result.transcript_text);
                            if (Array.isArray(data.result.segments)) setSegments(data.result.segments);
                            if (data.status === 'transcript_ready') setPhase(1);
                        }
                        if (data.result.phase === 2 && data.result.video_url) {
                            setFinalVideoUrl(data.result.video_url);
                            setPhase(2);
                        }
                    }
                    // If the backend marked the job as failed/interrupted
                    // while we were gone, surface the error so the
                    // failure card with the Retry button shows up.
                    if (data.status === 'failed') {
                        const last = (data.logs || []).slice().reverse()
                            .find((line) => /error|fail/i.test(line || ''));
                        setError(last || 'Job ended in failure while you were away.');
                    }
                } catch {
                    // network error — just leave the user on idle, the
                    // pointer stays in localStorage so the next attempt
                    // can find it.
                }
            })();
        } catch {}
        // Run only once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Open a saved past Subtitle project. Two cases:
    //   • completed (with video_url) → land on the result panel so the
    //     user can replay / download the burned video.
    //   • saved_draft (no video yet) → fetch the saved transcript +
    //     styling, drop the user back into Phase-2 styling ready to
    //     keep editing or burn.
    const openPastJob = async (job) => {
        if (!job) return;
        setError(null);
        // BUG FIX: the localPreviewUrl effect prefers `file` over
        // `jobId` when both are set. If the user uploaded a file
        // earlier this session, that blob URL would still be live
        // when they click a past project — and Phase 2's preview
        // would show that stale upload (or nothing, if the blob was
        // already revoked) instead of the past job's source. Reset
        // the upload-side state up front so the jobId branch wins.
        //
        // IMPORTANT: do NOT reset segments here. We used to call
        // setSegments([]) here, which created a transient empty
        // state that the auto-save's 1.5s debounce would happily
        // commit on top of any good local draft, wiping the user's
        // edits. The branches below replace segments with the
        // freshly-fetched server data anyway, so we don't need to
        // pre-clear.
        setFile(null);
        setUrl('');
        setFinalVideoUrl(null);
        setAlignedSegments(null);
        // CRITICAL: clear the restored-once gate for this jobId so the
        // restore-from-localStorage effect runs again. Without this,
        // re-opening the same project in the same browser session
        // skips the restore (because the gate was set on the first
        // open), leaving React state at the server's stale segments
        // and the auto-save then OVERWRITES the user's good local
        // draft with that stale data. This was the actual cause of
        // your lost edits — every re-open of a project silently
        // demoted localStorage to match the server's view.
        try { restoredJobsRef.current.delete(job.job_id); } catch {}
        if (job.is_draft) {
            // Pull the full job state (transcript + styling snapshot)
            // back from the backend so the wizard picks up where the
            // user left off.
            try {
                const r = await fetch(getApiUrl(`/api/standalone/status/${job.job_id}`));
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                const result = data.result || {};
                if (Array.isArray(result.segments)) {
                    setSegments(result.segments);
                }
                if (result.transcript_text) {
                    setTranscriptText(result.transcript_text);
                    setEditedTranscript(result.transcript_text);
                }
                const styling = result.draft_styling || {};
                if (styling.position) setPosition(styling.position);
                if (typeof styling.position_pct === 'number') setPositionPct(styling.position_pct);
                if (styling.output_orientation) setOutputOrientation(styling.output_orientation);
                if (typeof styling.crop_x_offset_pct === 'number') setCropXOffsetPct(styling.crop_x_offset_pct);
                if (typeof styling.crop_y_offset_pct === 'number') setCropYOffsetPct(styling.crop_y_offset_pct);
                // Restore keyframed crop if the user dropped any
                // before saving. Old drafts (predating keyframes) have
                // null/undefined here — leaving cropKeyframes at its
                // initial [] is the right thing.
                if (Array.isArray(styling.crop_keyframes) && styling.crop_keyframes.length) {
                    setCropKeyframes(styling.crop_keyframes);
                }
                if (typeof styling.font_size === 'number') {
                    // Old drafts stored font_size in the legacy ASS-pixels
                    // semantic (typical values 20-128). The new slider
                    // means "preview CSS pixels" with range 14-72. Map
                    // anything > 72 onto the new range so re-opened
                    // drafts don't snap to a giant value.
                    const fs = styling.font_size;
                    setFontSize(fs > 72 ? Math.max(14, Math.round(fs / 3)) : fs);
                }
                if (styling.font_name) setFontName(styling.font_name);
                if (styling.font_color) setFontColor(styling.font_color);
                if (styling.border_color) setBorderColor(styling.border_color);
                if (typeof styling.border_width === 'number') setBorderWidth(styling.border_width);
                if (styling.bg_color) setBgColor(styling.bg_color);
                if (typeof styling.bg_opacity === 'number') setBgOpacity(styling.bg_opacity);
                setJobId(job.job_id);
                setPhase(2);
                // Treat the resumed draft like Phase 1 just finished —
                // Phase-2 styling renders for status='transcript_ready'.
                setStatus('transcript_ready');
            } catch (e) {
                setError('Could not load the saved draft: ' + (e.message || e));
            }
            return;
        }
        // In-progress job (queued / transcribing / cleaning / etc.):
        // re-attach polling instead of opening the result panel. This
        // is what makes the "stuck on cleaning, refreshed, project
        // gone" recovery possible — the user clicks the running card
        // and lands back on the wizard with logs streaming again.
        const RUNNING = ['queued', 'transcribing', 'cleaning', 'translating', 'rendering', 'transcript_ready'];
        if (RUNNING.includes(job.status)) {
            try {
                const r = await fetch(getApiUrl(`/api/standalone/status/${job.job_id}`));
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                setJobId(job.job_id);
                setStatus(data.status || job.status);
                setLogs(data.logs || []);
                if (data.result) {
                    if (data.result.phase === 1 && data.result.transcript_text) {
                        setTranscriptText(data.result.transcript_text);
                        setEditedTranscript(data.result.transcript_text);
                        if (Array.isArray(data.result.segments)) setSegments(data.result.segments);
                    }
                }
                setPhase(1);
            } catch (e) {
                setError('Could not re-attach to that job: ' + (e.message || e));
            }
            return;
        }
        if (!job.video_url) return;
        setJobId(job.job_id);
        setPhase(2);
        setStatus('completed');
        setFinalVideoUrl(job.video_url);
    };

    // Save the current Phase-2 styling state as a draft instead of
    // burning. Sends current per-segment edits + styling snapshot so
    // reopening the draft restores everything.
    const savePhase2Draft = async () => {
        if (!jobId) return;
        setError(null);
        try {
            const editedSegments = (segments || [])
                .map((s, i) => ({ index: i, text: (s.text || '').trim() }))
                .filter((s) => s.text);
            const sendBulkEdits =
                refineStatus !== 'synced' && editedTranscript !== transcriptText;
            const body = {
                job_id: jobId,
                edited_text: sendBulkEdits ? editedTranscript : null,
                edited_segments: editedSegments.length ? editedSegments : null,
                position,
                position_pct: positionPct,
                output_orientation: outputOrientation,
                crop_x_offset_pct: cropXOffsetPct,
                crop_y_offset_pct: cropYOffsetPct,
                // Persist any keyframed reframe so reopening the draft
                // restores the user's clicks. Send null (not []) when
                // empty — backend treats both as "no keyframes set".
                crop_keyframes: cropKeyframes.length ? cropKeyframes : null,
                font_size: fontSize, font_name: fontName,
                font_color: fontColor, border_color: borderColor,
                border_width: borderWidth, bg_color: bgColor, bg_opacity: bgOpacity,
                // Animated subtitle templates — backend libass renderer
                // honors these. 'none' falls back to the static path.
                animation: animation,
                highlight_color: highlightColor,
            };
            const res = await fetch(getApiUrl('/api/standalone/subtitle/save'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
            // Surface a brief confirmation, then return the user to
            // the idle landing so they can leave the page knowing it's
            // safely stored. The draft is now visible in Past Projects.
            alert('Saved. Reopen any time from "Past subtitle projects".');
            reset();
        } catch (e) {
            setError('Could not save draft: ' + (e.message || e));
        }
    };

    const startPhase1 = async () => {
        if (!file && !(url || '').trim()) {
            setError('Pick a video file or paste a video link first.');
            return;
        }
        setError(null);
        setStatus('queued');
        try {
            const fd = new FormData();
            if (file) {
                fd.append('file', file);
            } else {
                fd.append('url', url.trim());
            }
            fd.append('transcribe_provider', transcribeProvider);
            fd.append('source_language', sourceLang || '');
            fd.append('script_mode', scriptMode);
            fd.append('target_language', scriptMode === 'translate' ? targetLang : '');
            // BYOL: when the user pasted upfront lyrics, send them to
            // the backend. The transcribe endpoint runs Whisper for
            // timings, then aligns the user's text against those
            // timings — skipping the LLM cleanup entirely.
            if ((upfrontLyrics || '').trim()) {
                fd.append('lyrics', upfrontLyrics);
                fd.append('lyrics_keep_tags', upfrontLyricsKeepTags ? 'true' : 'false');
            }
            const res = await fetch(getApiUrl('/api/standalone/subtitle/transcribe'), {
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
        } catch (e) {
            setError(e.message || String(e));
            setStatus('failed');
        }
    };

    // "Export without subtitles" — same backend endpoint as the burn,
    // but explicitly tells it to skip SRT generation + libass and just
    // re-encode the (possibly reframed) source. Lets users use Auto
    // Subtitle purely as a reframing tool: pick orientation, drop
    // keyframes, hit Export. Output lands in Past Projects exactly like
    // a normal burn.
    const exportWithoutSubtitles = async () => {
        if (!jobId) { setError('No project to export yet.'); return; }
        setError(null);
        // PHASE BUMP: the "rendering" loading screen is gated on
        // `phase === 2 && status === 'rendering'`. Without bumping the
        // phase first the page goes blank when we set status — there's
        // no JSX branch for phase=1 + status='rendering'. We move into
        // phase 2 even though we're skipping subtitle styling, then
        // the existing render screen and result panel handle the
        // rest of the flow normally.
        setPhase(2);
        setStatus('rendering');
        try {
            const body = {
                job_id: jobId,
                // Explicit empty list — backend reads this as
                // "no subtitles wanted" (auto-flips burn_subtitles=false
                // and blanks the working transcript so nothing leaks
                // from the saved version).
                full_segments: [],
                burn_subtitles: false,
                // Orientation + crop wired through so the export honours
                // whatever the user set up in the Frame & crop card.
                output_orientation: outputOrientation,
                crop_x_offset_pct: cropXOffsetPct,
                crop_y_offset_pct: cropYOffsetPct,
                crop_keyframes: cropKeyframes.length ? cropKeyframes : null,
                // Subtitle fields are ignored on this path but we send
                // sensible defaults so a future code path that reads
                // them doesn't hit a None.
                position, position_pct: positionPct,
                font_size: fontSize, font_name: fontName,
                font_color: fontColor, border_color: borderColor,
                border_width: borderWidth, bg_color: bgColor, bg_opacity: bgOpacity,
                animation: 'none',
                highlight_color: '#FFDD00',
                time_offset_seconds: 0,
            };
            const res = await fetch(getApiUrl('/api/standalone/subtitle/burn'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
        } catch (e) {
            setError(e.message || String(e));
            setStatus('failed');
        }
    };

    const startPhase2 = async () => {
        if (!jobId) { setError('No transcript yet.'); return; }
        setError(null);

        // FORCE-FLUSH AUTO-SAVE FIRST — never enter the burn path with
        // unsaved edits in flight. Auto-save is debounced (1.5 s) and
        // throttled (30 s for the backend push), so a click-to-burn
        // moment within either window used to ship the burn before
        // the latest edits were persisted. Doing this here makes the
        // localStorage draft + the backend's saved transcript both
        // line up with what the user is about to burn.
        try { _flushSave(); } catch { /* never block burn on save */ }

        setStatus('rendering');
        try {
            // SOURCE OF TRUTH: the in-memory segments array drives both
            // what's on screen and what gets burned. We mirror the auto-
            // save fallback (prefer segments; fall back to aligned for
            // BYOL projects where the user's working in the Aligned tab
            // and the original timeline is untouched). If both are
            // empty, omit full_segments and the backend keeps using the
            // saved transcript — same as before.
            const _liveSegs = (Array.isArray(segments) && segments.length)
                ? segments
                : (Array.isArray(alignedSegments) && alignedSegments.length
                    ? alignedSegments
                    : []);
            // FULL SEGMENTS — authoritative. Captures splits / merges /
            // retiming / inserts / deletes that the legacy index-only
            // edited_segments field can't express. Backend replaces
            // transcript.segments wholesale before SRT generation.
            const fullSegments = _liveSegs.map((s) => ({
                start: +s.start || 0,
                end: +s.end || 0,
                text: (s.text || '').trim(),
                words: Array.isArray(s.words)
                    ? s.words.filter((w) => w && (w.word || '').trim())
                    : undefined,
            })).filter((s) => s.text);
            // Keep edited_segments populated for backward-compat with
            // older backends that don't yet honour full_segments. New
            // backends ignore it when full_segments is present.
            const editedSegments = fullSegments
                .map((s, i) => ({ index: i, text: s.text }));
            const sendBulkEdits =
                refineStatus !== 'synced' && editedTranscript !== transcriptText;
            const body = {
                job_id: jobId,
                // NEW — full segments array (the actual fix for "burned
                // the old un-edited subtitles"). Backend replaces the
                // transcript wholesale and persists the result so the
                // next reopen also reflects what was burned.
                full_segments: fullSegments.length ? fullSegments : null,
                edited_text: sendBulkEdits ? editedTranscript : null,
                edited_segments: editedSegments.length ? editedSegments : null,
                position,
                position_pct: positionPct,
                // Output orientation + crop position. Backend pre-crops
                // the source video to the requested aspect before the
                // subtitle burn, so the final mp4 comes out at exactly
                // the right shape (e.g. 9:16 for TikTok / Reels).
                output_orientation: outputOrientation,
                crop_x_offset_pct: cropXOffsetPct,
                crop_y_offset_pct: cropYOffsetPct,
                // When the user dropped keyframes in Phase 2, hand them
                // to the backend so the burn pans/cuts the crop window
                // over the timeline. Empty list -> backend uses the
                // static X/Y offsets (unchanged legacy behaviour).
                crop_keyframes: cropKeyframes.length ? cropKeyframes : null,
                font_size: fontSize, font_name: fontName,
                font_color: fontColor, border_color: borderColor,
                border_width: borderWidth, bg_color: bgColor, bg_opacity: bgOpacity,
                // Animated subtitle templates — backend libass renderer
                // honors these. 'none' falls back to the static path.
                animation: animation,
                highlight_color: highlightColor,
                // Manual time-shift slider — backend clamps to ±60 s.
                // 0 = no shift (default).
                time_offset_seconds: timeOffsetSeconds || 0,
            };
            // VERY VISIBLE PROOF that the new burn payload code is the
            // one running. If you click Burn and DON'T see this banner
            // in the browser console, the frontend bundle is stale —
            // hard-reload the tab (Shift+Reload / Cmd+Shift+R) so vite
            // serves the latest .jsx. Without this, all the data-flow
            // fixes are invisible because the OLD bundle is still in
            // memory.
            console.log(
                '%c🔥 KLIPRA BURN DEBUG 🔥',
                'background:#dc2626;color:#fff;font-size:14px;padding:4px 8px;border-radius:4px',
                {
                    sentFullSegments: !!body.full_segments,
                    fullSegmentsCount: body.full_segments?.length || 0,
                    firstSegment: body.full_segments?.[0],
                    lastSegment: body.full_segments?.[body.full_segments.length - 1],
                    sentEditedSegments: !!body.edited_segments,
                    editedSegmentsCount: body.edited_segments?.length || 0,
                    onScreenSegmentCount: (segments || []).length,
                    activeView: (alignedSegments && alignedSegments.length) ? 'aligned-or-segments' : 'segments',
                },
            );
            const res = await fetch(getApiUrl('/api/standalone/subtitle/burn'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
        } catch (e) {
            setError(e.message || String(e));
            setStatus('failed');
        }
    };

    // Whether we're inside an opened project / running pipeline. When
    // true, surface a Back-to-home control above the wizard so the user
    // can always escape without hunting for the right button.
    const isInsideJob = status !== 'idle' || phase !== 1 || !!jobId;

    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
                {isInsideJob && (
                    <button
                        type="button"
                        onClick={reset}
                        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-zinc-400 hover:text-white px-2.5 py-1.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition"
                    >
                        <ChevronLeft size={14} /> Back to Auto Subtitle home
                    </button>
                )}
                <Header />
                <PhaseStepper phase={phase} status={status} />
                {/* AI model picker — visible on EVERY step. Changing
                    it here updates the choice for all subsequent AI
                    calls (transcript cleanup, regenerate, sync,
                    translate, lyric alignment, etc.). */}
                <CompactModelBar />

                {/* Past Subtitle projects — only shown on the idle Phase 1 page.
                    Auto-hides when there are zero past jobs (rendered as null
                    by StandalonePastList itself). Clicking a card jumps to the
                    completed result view for replay / download. */}
                {phase === 1 && status === 'idle' && (
                    <StandalonePastList
                        kind="subtitle"
                        accent="orange"
                        onOpen={openPastJob}
                        llmHeaders={llmHeaders}
                        onResume={(job) => {
                            // Resume kick-off worked on the backend; switch
                            // this view into the running state and start
                            // polling for status. The polling effect
                            // already in place picks up the new jobId
                            // automatically.
                            setJobId(job.job_id);
                            setStatus('cleaning');
                            setPhase(1);
                            setError(null);
                            setLogs(['Resuming from saved checkpoint…']);
                        }}
                    />
                )}

                {/* PHASE 1 — pre-transcription setup */}
                {phase === 1 && status === 'idle' && (
                    <Phase1Setup
                        file={file} onFile={setFile} fileInputRef={fileInputRef}
                        url={url} setUrl={setUrl}
                        transcribeProvider={transcribeProvider} setTranscribeProvider={setTranscribeProvider}
                        sourceLang={sourceLang} setSourceLang={setSourceLang}
                        scriptMode={scriptMode} setScriptMode={setScriptMode}
                        targetLang={targetLang} setTargetLang={setTargetLang}
                        hasElevenKey={!!elevenLabsKey} error={error}
                        onStart={startPhase1}
                        upfrontLyrics={upfrontLyrics} setUpfrontLyrics={setUpfrontLyrics}
                        upfrontLyricsKeepTags={upfrontLyricsKeepTags} setUpfrontLyricsKeepTags={setUpfrontLyricsKeepTags}
                    />
                )}

                {/* PHASE 1 — running (initial transcribe). NOT shown during
                    a regenerate-only pass: in that case Phase1Preview stays
                    mounted and shows its own inline spinner on the Refine
                    card. The split-pane preview shows the user's source
                    video on the left so they have something to look at
                    while the backend chews through transcription. */}
                {phase === 1 && ['queued', 'transcribing'].includes(status) && (
                    <ProcessingPreview
                        videoUrl={localPreviewUrl}
                        logs={logs}
                        status={status}
                        accent="orange"
                        title="Phase 1 · Transcript"
                        steps={SUBTITLE_PHASE1_STEPS}
                    />
                )}
                {phase === 1 && status === 'cleaning' && refineStatus !== 'regenerating' && (
                    <ProcessingPreview
                        videoUrl={localPreviewUrl}
                        logs={logs}
                        status={status}
                        accent="orange"
                        title="Phase 1 · Transcript"
                        steps={SUBTITLE_PHASE1_STEPS}
                    />
                )}

                {/* PHASE 1 — transcript preview, ready to move to Phase 2.
                    Now shows a live video player on the left with active
                    segment overlay, plus separate Regenerate and Sync
                    buttons so the user can iterate before burning. We
                    keep the same panel visible during a regenerate (the
                    Refine card shows its own inline spinner) so the user
                    doesn't lose the video preview. */}
                {phase === 1 && (status === 'transcript_ready' || (status === 'cleaning' && refineStatus === 'regenerating')) && (
                    <Phase1Preview
                        videoUrl={localPreviewUrl}
                        transcriptText={transcriptText}
                        editedTranscript={editedTranscript}
                        setEditedTranscript={setEditedTranscript}
                        segments={segments}
                        jobId={jobId}
                        refineStatus={refineStatus}
                        refineError={refineError}
                        canUndoSync={canUndoSync}
                        onRegenerate={regenerateTranscript}
                        onSync={syncTranscript}
                        onUndoSync={undoSync}
                        // Pass styling state to Phase 1 too — the
                        // interactive preview overlay (click/drag/edit)
                        // updates these so positioning + sizing edits
                        // made on Phase 1 carry through to Phase 2 and
                        // the final burn.
                        positionPct={positionPct}
                        setPositionPct={setPositionPct}
                        fontSize={fontSize}
                        setFontSize={setFontSize}
                        imageOverlays={imageOverlays}
                        setImageOverlays={setImageOverlays}
                        animation={animation}
                        highlightColor={highlightColor}
                        saveStatus={saveStatus}
                        savedAt={savedAt}
                        onManualSave={_flushSave}
                        // Per-segment edit handler. Updates the segments
                        // state in place; preserves start/end timings so
                        // the user can fix individual misheard words
                        // without touching the alignment from Sync.
                        onEditSegment={(idx, text) => {
                            setSegments((prev) =>
                                prev.map((s, i) => (i === idx ? { ...s, text } : s))
                            );
                        }}
                        // Split a segment into two at roughly the
                        // midpoint of its words. Used when the user
                        // hits the "+" button on a row because the
                        // line should really be two captions. Time
                        // gets divided proportional to character
                        // count so reading pace stays even.
                        onSplitSegment={(idx) => {
                            setSegments((prev) => {
                                const seg = prev[idx];
                                if (!seg) return prev;
                                const text = (seg.text || '').trim();
                                const start = +seg.start || 0;
                                const end = +seg.end || start + 1;
                                const words = text.split(/\s+/).filter(Boolean);
                                if (words.length < 2) {
                                    // Single-word or empty segment —
                                    // we can't really split, so insert
                                    // a fresh empty segment right
                                    // after this one (1s long, taken
                                    // from the gap to the next or just
                                    // appended). The user fills in.
                                    const next = prev[idx + 1];
                                    const newStart = end;
                                    const newEnd = next ? Math.max(newStart + 0.05, next.start) : newStart + 1;
                                    return [
                                        ...prev.slice(0, idx + 1),
                                        { text: '', start: newStart, end: newEnd },
                                        ...prev.slice(idx + 1),
                                    ];
                                }
                                const mid = Math.ceil(words.length / 2);
                                const firstText = words.slice(0, mid).join(' ');
                                const secondText = words.slice(mid).join(' ');
                                const totalChars = firstText.length + secondText.length || 1;
                                const splitTime = start + (end - start) * (firstText.length / totalChars);
                                const first = { ...seg, text: firstText, start, end: splitTime };
                                const second = { ...seg, text: secondText, start: splitTime, end };
                                return [...prev.slice(0, idx), first, second, ...prev.slice(idx + 1)];
                            });
                        }}
                        // Drop a segment entirely. The neighbour times
                        // stay where they were — we don't auto-stretch
                        // them across the gap because the user might
                        // have legitimate silence there.
                        onDeleteSegment={(idx) => {
                            setSegments((prev) => prev.filter((_, i) => i !== idx));
                        }}
                        onContinue={(commitAligned) => {
                            // Phase1Preview now passes the active tab's
                            // segments back via this argument when the
                            // user clicks "Continue to Step 3". If the
                            // user was viewing Aligned, those replace
                            // the canonical segments; otherwise the
                            // original Whisper-derived segments stay.
                            if (commitAligned && Array.isArray(commitAligned)) {
                                setSegments(commitAligned);
                                setEditedTranscript(commitAligned.map((s) => s.text || '').join(' '));
                            }
                            setPhase(2);
                        }}
                        onRedo={reset}
                        // Step 2 lyrics panel — needs these to call
                        // /lyrics-align with the right LLM headers +
                        // script_mode + target.
                        llmHeaders={llmHeaders}
                        targetLang={targetLang}
                        scriptMode={scriptMode}
                        // Aligned segments live alongside the original
                        // ones. The Aligned tab in the editor only
                        // shows when this is non-null. The preview
                        // window switches between original and aligned
                        // based on the active tab.
                        alignedSegments={alignedSegments}
                        // Called when alignment finishes. Stores the
                        // new segments in parent state without
                        // touching the original segments array.
                        onSegmentsAligned={(newSegs) => {
                            if (Array.isArray(newSegs)) {
                                setAlignedSegments(newSegs);
                            }
                        }}
                        // Direct full-array setters used by the timeline
                        // editor in Phase1Preview. The timeline lets the
                        // user move / resize / split / add / delete
                        // subtitles visually; each edit replaces the
                        // whole segments array, which is much simpler
                        // than the old per-row callbacks for the kinds
                        // of operations the timeline supports.
                        onSegmentsChange={(newSegs) => {
                            if (Array.isArray(newSegs)) setSegments(newSegs);
                        }}
                        onAlignedChange={(newSegs) => {
                            if (Array.isArray(newSegs)) setAlignedSegments(newSegs);
                        }}
                        // "← Re-transcribe" button on Phase 1 — sends
                        // the user back to the setup form so they can
                        // pick a different AI model / source language
                        // and try the transcription pipeline again.
                        // We reset to the setup state but keep the
                        // file already loaded so they don't have to
                        // re-upload (and re-Whisper from scratch unless
                        // they explicitly change settings).
                        onBackToSetup={() => {
                            setStatus('idle');
                            setError(null);
                            setLogs([]);
                            // Don't wipe segments here — the user might
                            // change their mind and come back. We DO
                            // wipe alignedSegments so a re-run produces
                            // a clean Aligned tab.
                            setAlignedSegments(null);
                        }}
                        // Re-translate the current Whisper transcript
                        // to a different language. Lets the user fix
                        // a Phase 1 translation that didn't land —
                        // e.g. they picked English in setup but the
                        // result still looks like Roman Urdu, or they
                        // want to switch from English to Spanish
                        // without re-uploading.
                        onRetranslate={retranslateTo}
                        // Surface what mode + target the user picked
                        // in Phase 1 setup so the Step 2 retranslate
                        // dropdown can pre-fill correctly.
                        currentScriptMode={scriptMode}
                        currentTargetLang={targetLang}
                        // Frame & Crop — wired into the transcript-editor
                        // screen so users can decide orientation (vertical
                        // / horizontal / square) AND set reframe
                        // keyframes BEFORE they sink time into styling.
                        // Both pieces of state are shared with Phase 2
                        // so whatever they set here carries through to
                        // the burn.
                        outputOrientation={outputOrientation}
                        setOutputOrientation={setOutputOrientation}
                        cropXOffsetPct={cropXOffsetPct}
                        setCropXOffsetPct={setCropXOffsetPct}
                        cropYOffsetPct={cropYOffsetPct}
                        setCropYOffsetPct={setCropYOffsetPct}
                        cropKeyframes={cropKeyframes}
                        setCropKeyframes={setCropKeyframes}
                        // Subtitle-free export. Same backend endpoint
                        // as the burn, but tells it to skip libass and
                        // just re-encode the reframed source.
                        onExportNoSubs={exportWithoutSubtitles}
                    />
                )}

                {/* PHASE 2 — styling.  Preview now plays the actual
                    video with the live timed subtitles overlaid using the
                    user's chosen styling, so the styling decisions reflect
                    exactly what will be burned. */}
                {phase === 2 && status === 'transcript_ready' && (
                    <Phase2Styling
                        videoUrl={localPreviewUrl}
                        segments={segments}
                        setSegments={setSegments}
                        jobId={jobId}
                        llmHeaders={llmHeaders}
                        targetLang={targetLang}
                        scriptMode={scriptMode}
                        timeOffsetSeconds={timeOffsetSeconds}
                        setTimeOffsetSeconds={setTimeOffsetSeconds}
                        position={position} setPosition={setPosition}
                        positionPct={positionPct} setPositionPct={setPositionPct}
                        outputOrientation={outputOrientation} setOutputOrientation={setOutputOrientation}
                        cropXOffsetPct={cropXOffsetPct} setCropXOffsetPct={setCropXOffsetPct}
                        cropYOffsetPct={cropYOffsetPct} setCropYOffsetPct={setCropYOffsetPct}
                        cropKeyframes={cropKeyframes} setCropKeyframes={setCropKeyframes}
                        fontSize={fontSize} setFontSize={setFontSize}
                        fontName={fontName} setFontName={setFontName}
                        fontColor={fontColor} setFontColor={setFontColor}
                        borderColor={borderColor} setBorderColor={setBorderColor}
                        borderWidth={borderWidth} setBorderWidth={setBorderWidth}
                        bgColor={bgColor} setBgColor={setBgColor}
                        bgOpacity={bgOpacity} setBgOpacity={setBgOpacity}
                        animation={animation} setAnimation={setAnimation}
                        highlightColor={highlightColor} setHighlightColor={setHighlightColor}
                        applyScope={applyScope} setApplyScope={setApplyScope}
                        fallbackSample={(editedTranscript || transcriptText).split(/\s+/).slice(0, 8).join(' ') || 'Your subtitles look like this'}
                        error={error}
                        currentUser={currentUser}
                        onUpgradeClick={() => onChooseTab?.('pricing')}
                        // One-shot template applier — sets every styling
                        // slot in lockstep so the live preview reflects
                        // the new look immediately. Safe to call with a
                        // partial styling object (only the keys we know
                        // about get applied).
                        onApplyTemplate={(s) => {
                            if (typeof s.fontName === 'string') setFontName(s.fontName);
                            if (typeof s.fontSize === 'number') setFontSize(s.fontSize);
                            if (typeof s.fontColor === 'string') setFontColor(s.fontColor);
                            if (typeof s.borderColor === 'string') setBorderColor(s.borderColor);
                            if (typeof s.borderWidth === 'number') setBorderWidth(s.borderWidth);
                            if (typeof s.bgColor === 'string') setBgColor(s.bgColor);
                            if (typeof s.bgOpacity === 'number') setBgOpacity(s.bgOpacity);
                            if (typeof s.positionPct === 'number') setPositionPct(s.positionPct);
                            // Animated templates — set or RESET. Picking a
                            // static template clears the animation so it
                            // doesn't linger from a previous animated pick.
                            setAnimation(typeof s.animation === 'string' ? s.animation : 'none');
                            if (typeof s.highlightColor === 'string') setHighlightColor(s.highlightColor);
                        }}
                        onBack={() => setPhase(1)}
                        onBurn={startPhase2}
                        onSaveDraft={savePhase2Draft}
                    />
                )}

                {/* PHASE 2 — rendering. Same split-pane treatment so
                    the user keeps the source video visible while the
                    burn step runs. */}
                {phase === 2 && status === 'rendering' && (
                    <ProcessingPreview
                        videoUrl={localPreviewUrl}
                        logs={logs}
                        status={status}
                        accent="emerald"
                        title="Phase 2 · Style & burn"
                        steps={SUBTITLE_PHASE2_STEPS}
                    />
                )}

                {/* PHASE 2 — done */}
                {status === 'completed' && finalVideoUrl && (
                    <ResultPanel
                        videoUrl={finalVideoUrl}
                        jobId={jobId}
                        onAgain={reset}
                        onRetranslate={retranslateTo}
                        currentTargetLang={targetLang}
                        // Send the user back to Phase 2 styling without
                        // losing any of their state. They can change
                        // template / font / position / animation and
                        // hit Burn again to produce a new mp4. The
                        // segments + transcript + alignment all stay
                        // intact — only the visual styling changes.
                        onTweakStyle={() => {
                            setStatus('transcript_ready');
                            setPhase(2);
                            setFinalVideoUrl(null);
                        }}
                        onBackgroundChanged={(newVideoUrl) => {
                            // change-background returns a fresh URL with
                            // a new cache-bust filename — point the
                            // result panel at it so the player reloads.
                            setFinalVideoUrl(newVideoUrl);
                        }}
                        // Cross-product hand-off to Voice Dubbing.
                        // Stash the source job_id in localStorage so the
                        // Dub page can pick it up on mount and open its
                        // redub modal — exactly the flow we want: user
                        // clicks "Dub voice" here, lands on Dub with the
                        // language picker open, no re-uploading or
                        // re-transcribing.
                        onDubVoice={() => {
                            if (!jobId) return;
                            try {
                                localStorage.setItem(
                                    'klipra_redub_target',
                                    JSON.stringify({
                                        source_job_id: jobId,
                                        title: 'Subtitled video',
                                        from_kind: 'subtitle',
                                        savedAt: Date.now(),
                                    }),
                                );
                            } catch {}
                            onChooseTab?.('dub');
                        }}
                    />
                )}

                {status === 'failed' && (
                    <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">
                        <div className="flex items-start gap-2 text-red-200">
                            <AlertCircle size={16} className="mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="font-bold mb-1">Pipeline failed</div>
                                <div className="text-red-300 leading-relaxed break-words">
                                    {error || (logs && logs.length ? logs[logs.length - 1] : 'No error details — check Docker logs for the backend traceback.')}
                                </div>
                            </div>
                        </div>
                        {/* Last few status lines from the backend — gives
                            users a chance to see HOW FAR the pipeline got
                            before it failed (e.g. "Stage 2: AI cleanup…"
                            failing means the LLM call timed out, not
                            transcription). */}
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
                        {/* Retry — most subtitle failures are transient
                            LLM timeouts or quota issues. If we have a
                            saved checkpoint (whisper_original on disk
                            from a previous run), backend's resume
                            endpoint will skip transcription. Otherwise
                            this just calls reset() and the user starts
                            over. */}
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
                                            setStatus('cleaning');
                                            setError(null);
                                            setLogs(['Retrying from last checkpoint…']);
                                        } else {
                                            // No checkpoint to resume from — fall back
                                            // to a clean restart so the user isn't stuck.
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
        </div>
    );
}

// ============================================================
// Sub-components
// ============================================================

function Header() {
    return (
        <header className="mb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-300 text-[11px] uppercase tracking-wider mb-3">
                <Type size={12} /> Auto Subtitle
            </div>
            <h1 className="text-3xl sm:text-4xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
                Add subtitles to any video
            </h1>
            <p className="text-zinc-400 mt-2 text-sm sm:text-base leading-relaxed">
                Three steps — transcribe, fix, and style. AI does the heavy lifting; you stay in control.
            </p>
        </header>
    );
}


// 3-step workflow indicator. Maps the legacy phase+status combo to a
// clean step number. Each step gets an icon, a label, and a sub-label.
// The line between steps fills in as the user advances.
function PhaseStepper({ phase, status }) {
    // Step 1 = transcribe. Active while idle / queued / transcribing /
    // cleaning. Done once we hit transcript_ready (or beyond).
    // Step 2 = fix subtitles. Active while transcript_ready in phase 1.
    //          Done once user clicks Continue and we move to phase 2.
    // Step 3 = style & burn. Active in phase 2.
    let step = 1;
    if (status === 'completed') step = 4;
    else if (phase === 2) step = 3;
    else if (status === 'transcript_ready') step = 2;
    else if (status !== 'idle') step = 1;

    const steps = [
        { n: 1, label: 'Transcribe',   sub: 'AI listens and writes' },
        { n: 2, label: 'Fix subtitles', sub: 'Edit, import, align' },
        { n: 3, label: 'Style & burn',  sub: 'Look + final video'    },
    ];
    return (
        <div className="mb-8">
            <div className="flex items-stretch gap-0">
                {steps.map((s, i) => {
                    const isDone   = step > s.n;
                    const isActive = step === s.n;
                    return (
                        <React.Fragment key={s.n}>
                            <StepBlock {...s} active={isActive} done={isDone} />
                            {i < steps.length - 1 && (
                                <div className="flex items-center px-2 sm:px-4">
                                    <div className={`h-px w-8 sm:w-14 ${
                                        step > s.n ? 'bg-emerald-500/60' : 'bg-white/10'
                                    }`} />
                                </div>
                            )}
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
}


function StepBlock({ n, label, sub, active, done }) {
    const ringColor = done
        ? 'border-emerald-500/50 bg-emerald-500/10'
        : active
          ? 'border-primary/60 bg-primary/10 shadow-[0_0_0_4px] shadow-primary/10'
          : 'border-white/10 bg-black/30';
    const numberColor = done
        ? 'bg-emerald-500/30 text-emerald-200'
        : active
          ? 'bg-primary/30 text-primary'
          : 'bg-white/5 text-zinc-500';
    const labelColor = done
        ? 'text-emerald-200'
        : active
          ? 'text-white'
          : 'text-zinc-500';
    return (
        <div className={`flex items-center gap-3 px-3 sm:px-4 py-2.5 rounded-xl border ${ringColor} transition-all`}>
            <div className={`w-7 h-7 inline-flex items-center justify-center rounded-full font-bold text-xs ${numberColor}`}>
                {done ? <Check size={14} /> : n}
            </div>
            <div className="leading-tight">
                <div className={`text-xs font-bold uppercase tracking-wider ${labelColor}`}>{label}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5 hidden sm:block">{sub}</div>
            </div>
        </div>
    );
}


// Compact "AI model" pill that shows the current provider/model and
// lets the user change it on every step. Persists via the same
// localStorage key ProviderPicker uses, so opening any one of these
// pickers reflects the saved choice everywhere else in the app.
function CompactModelBar() {
    return (
        <div className="mb-6 rounded-xl border border-white/10 bg-surface/40 p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center gap-1.5">
                    <Wand2 size={11} className="text-primary" /> AI model
                </div>
                <div className="flex-1 min-w-[200px]">
                    <ProviderPicker />
                </div>
            </div>
        </div>
    );
}

function Section({ title, subtitle, children }) {
    return (
        <div className="rounded-xl border border-white/10 bg-surface/40 p-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1">{title}</div>
            {subtitle && <div className="text-[11px] text-zinc-400 mb-3 leading-relaxed">{subtitle}</div>}
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
                <p className="col-span-2 text-[10px] text-amber-300">No ElevenLabs key in Settings — falls back to Whisper automatically.</p>
            )}
        </div>
    );
}

function UploadDropzone({ file, onFile, fileInputRef, url, onUrlChange }) {
    // Two-mode source picker: file upload OR paste a URL. The URL path
    // hands off to yt-dlp on the backend, which natively supports
    // YouTube, TikTok, X/Twitter, Instagram, Facebook, Reddit, Vimeo,
    // and ~1800 other sites.
    const [tab, setTab] = useState(file ? 'file' : (url ? 'url' : 'file'));
    const [hasInteracted, setHasInteracted] = useState(false);
    return (
        <div className="space-y-2">
            <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-[11px]">
                <button type="button"
                    onClick={() => { setTab('file'); setHasInteracted(true); onUrlChange?.(''); }}
                    className={'px-3 py-1.5 transition ' + (tab === 'file' ? 'bg-primary/15 text-primary' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                    Upload file
                </button>
                <button type="button"
                    onClick={() => { setTab('url'); setHasInteracted(true); onFile?.(null); }}
                    className={'px-3 py-1.5 transition ' + (tab === 'url' ? 'bg-primary/15 text-primary' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                    Paste link
                </button>
            </div>
            {tab === 'file' ? (
                <div onClick={() => fileInputRef.current?.click()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
                    onDragOver={(e) => e.preventDefault()}
                    className={'border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition ' + (file ? 'border-primary/40 bg-primary/5' : 'border-white/10 bg-surface/30 hover:border-white/30')}>
                    {/* accept= now includes audio/* so musicians and
                        podcasters can drop a vocals-only or voiceover
                        track here and skip the "no video to upload"
                        problem entirely. The burn pipeline detects
                        audio-only inputs and synthesizes a placeholder
                        background; the user can swap it for a real
                        video later via the Change Background panel. */}
                    <input ref={fileInputRef} type="file" accept="video/*,audio/*" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
                    <Upload size={28} className="mx-auto text-zinc-500 mb-2" />
                    {file ? (
                        <>
                            <div className="text-sm font-medium text-white truncate">{file.name}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">{(file.size / (1024 * 1024)).toFixed(1)} MB · click to swap</div>
                        </>
                    ) : (
                        <>
                            <div className="text-sm text-zinc-300">Drag &amp; drop a video <span className="text-zinc-500">or audio</span>, or click to choose</div>
                            <div className="text-[10px] text-zinc-500 mt-1">MP4, MOV, MKV, MP3, WAV, M4A — up to 5 GB</div>
                        </>
                    )}
                </div>
            ) : (
                <div className="rounded-2xl border-2 border-dashed border-white/10 bg-surface/30 p-5">
                    <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">
                        Video link
                    </label>
                    <input
                        type="url"
                        autoFocus={hasInteracted}
                        value={url || ''}
                        onChange={(e) => onUrlChange?.(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=…"
                        className="w-full bg-black/40 border border-white/10 rounded-md py-2.5 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50"
                    />
                    <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                        Works with YouTube, TikTok, X/Twitter, Instagram, Facebook, Reddit, Vimeo, and most other public video links. Private posts may need a manual upload.
                    </p>
                </div>
            )}
        </div>
    );
}

function Phase1Setup(p) {
    const hasSource = !!p.file || !!(p.url || '').trim();
    return (
        <div className="space-y-5">
            <UploadDropzone
                file={p.file} onFile={p.onFile} fileInputRef={p.fileInputRef}
                url={p.url} onUrlChange={p.setUrl}
            />

            <Section title="1a · Transcription engine" subtitle="Choose how the audio is converted to text.">
                <EngineToggle value={p.transcribeProvider} onChange={p.setTranscribeProvider} hasElevenKey={p.hasElevenKey} />
                <div className="mt-3">
                    <label className="text-xs text-zinc-400 mb-1.5 block">Source language</label>
                    <select value={p.sourceLang} onChange={(e) => p.setSourceLang(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-primary/50">
                        {SOURCE_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                    </select>
                </div>
            </Section>

            {/* AI model picker is now in the persistent CompactModelBar
                at the top of the page (visible on every step). */}

            <Section title="1b · AI transliteration / translation" subtitle="The AI uses full-video context to fix Whisper mishears (e.g. 'trail' → 'trade' in a trading video). Same engine your clip generator uses.">
                {/* Match the per-clip Subtitle modal's options so users get
                    the same affordances everywhere: in particular
                    Urglish/Hinglish (code-switch-preserving — keeps English
                    loan words in English) which is what most Roman Urdu
                    creators actually want. */}
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                    {[
                        ['auto',      'Original'],
                        ['roman',     'Roman'],
                        ['hinglish',  'Hinglish'],
                        ['urglish',   'Urglish'],
                        ['translate', 'Translate'],
                    ].map(([m, l]) => (
                        <button key={m} type="button" onClick={() => p.setScriptMode(m)}
                            className={'rounded-md border px-2 py-2 text-xs font-medium transition ' + (p.scriptMode === m ? 'bg-primary/15 text-primary border-primary/40' : 'bg-black/30 text-zinc-300 border-white/10 hover:border-white/20')}>
                            {l}
                        </button>
                    ))}
                </div>
                {p.scriptMode === 'translate' && (
                    <div className="mt-3">
                        <label className="text-xs text-zinc-400 mb-1.5 block">Translate to</label>
                        <select value={p.targetLang} onChange={(e) => p.setTargetLang(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-primary/50">
                            {TARGET_LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                        </select>
                    </div>
                )}
                <p className="mt-2.5 text-[11px] text-zinc-500 leading-relaxed">
                    {p.scriptMode === 'auto' && 'Keeps Whisper output in its original language and script. AI proofreads obvious mishears.'}
                    {p.scriptMode === 'roman' && 'Transliterates everything to Roman/Latin script. Same words, different writing system (e.g. ہے → hai).'}
                    {p.scriptMode === 'hinglish' && 'Hindi → Roman; English words and phrases stay in English (e.g. "yeh layer zero hai", "Bitcoin hold karo").'}
                    {p.scriptMode === 'urglish' && 'Urdu → Roman; English words and phrases stay in English (e.g. "Bitcoin community ke saath grow karo"). Recommended for Pakistani / Urdu creators who code-switch into English.'}
                    {p.scriptMode === 'translate' && 'Translates to the chosen language.'}
                </p>
            </Section>

            {p.error && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" />
                    {p.error}
                </div>
            )}

            <button onClick={p.onStart} disabled={!hasSource}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-black font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                <Wand2 size={18} /> Generate transcript (Phase 1)
            </button>

            {/* Import SRT — alternative entry path. Skips Whisper
                entirely. Useful when:
                  • The user already has an SRT from another project
                    (Klipra Export, or a tool like Aegisub).
                  • They generated subs from clean vocals in a previous
                    project and want to apply them to a different video. */}
            <ImportSrtSection />
        </div>
    );
}


function UpfrontLyricsSection({ value, onChange, keepTags, onKeepTagsChange }) {
    const [open, setOpen] = useState(false);
    const hasContent = (value || '').trim().length > 0;
    return (
        <div className={'rounded-xl border ' + (hasContent ? 'border-violet-500/40 bg-violet-500/10' : 'border-violet-500/20 bg-violet-500/5')}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between p-3 text-xs font-bold text-violet-300 uppercase tracking-wider"
            >
                <span className="flex items-center gap-1.5">
                    🎵 OR — paste your lyrics (best for songs / mistranscribed audio)
                    {hasContent && (
                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-100 border border-emerald-400/40 normal-case">
                            ✓ ready
                        </span>
                    )}
                </span>
                <span className={'transition-transform ' + (open ? 'rotate-180' : '')}>▾</span>
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-2 animate-[fadeIn_0.2s_ease-out]">
                    <p className="text-[11px] text-violet-200/70 leading-snug">
                        For songs, poetry, or audio where Whisper struggles, paste the
                        <strong> official lyrics / script</strong> here. Whisper still runs
                        — but only to capture the <em>timing</em> of each word. Your
                        pasted text replaces what Whisper heard, so you get accurate
                        subtitles with no cleanup pass needed.
                        <span className="block mt-1 text-violet-300/60">
                            Leave empty to use the standard Whisper-only flow.
                        </span>
                    </p>
                    <textarea
                        value={value || ''}
                        onChange={(e) => onChange?.(e.target.value)}
                        placeholder={"[Verse 1]\nLine one of the song goes here\nLine two follows the rhyme\n\n[Chorus]\nThe chorus repeats verbatim each time\nKeep punctuation and line breaks intact"}
                        rows={10}
                        className="w-full rounded-md bg-black/40 border border-violet-500/20 text-zinc-100 text-xs p-2 font-mono resize-y placeholder:text-zinc-600 focus:outline-none focus:border-violet-400"
                    />
                    <label className="flex items-center gap-2 text-[11px] text-violet-200/80">
                        <input
                            type="checkbox"
                            checked={!!keepTags}
                            onChange={(e) => onKeepTagsChange?.(e.target.checked)}
                            className="accent-violet-500"
                        />
                        Keep [Verse]/[Chorus] tags as on-screen subtitles (rare)
                    </label>
                    {hasContent && (
                        <div className="text-[11px] text-emerald-300/90 leading-snug">
                            ✓ Your lyrics are ready. Click <strong>Align my lyrics to the audio</strong> below.
                            Whisper will run for timing only — your text becomes the transcript.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}


function ImportSrtSection() {
    const [open, setOpen] = useState(false);
    const [media, setMedia] = useState(null);
    const [srtFile, setSrtFile] = useState(null);
    const [srtText, setSrtText] = useState('');
    const [running, setRunning] = useState(false);
    const [err, setErr] = useState(null);
    const [done, setDone] = useState(null);
    const mediaRef = useRef(null);
    const srtRef = useRef(null);

    const submit = async () => {
        setErr(null);
        if (!media) { setErr('Choose a media file (audio or video).'); return; }
        if (!srtFile && !srtText.trim()) { setErr('Provide an .srt file or paste SRT text.'); return; }
        setRunning(true);
        try {
            const fd = new FormData();
            fd.append('file', media);
            if (srtFile) fd.append('srt_file', srtFile);
            if (srtText.trim()) fd.append('srt_text', srtText);
            const res = await fetch(getApiUrl('/api/standalone/subtitle/import-srt'), { method: 'POST', body: fd });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            setDone(data);
            // Reload the page so the wizard picks up the new job at
            // status='transcript_ready' and shows Phase 2 immediately.
            // Cheaper than threading state through Phase1Setup → parent.
            setTimeout(() => window.location.reload(), 600);
        } catch (e) {
            setErr(String(e?.message || e));
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between p-3 text-xs font-bold text-cyan-300 uppercase tracking-wider"
            >
                <span>📥 Or — import an existing .srt (skip transcription)</span>
                <span className={'transition-transform ' + (open ? 'rotate-180' : '')}>▾</span>
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-2">
                    <p className="text-[11px] text-cyan-200/70 leading-snug">
                        Already have subtitles from another project, a previous Klipra export,
                        or a tool like Aegisub? Skip Whisper — upload your media + the .srt
                        and jump straight to styling.
                    </p>
                    {/* Media file */}
                    <div
                        onClick={() => mediaRef.current?.click()}
                        className={'border-2 border-dashed rounded-md p-3 text-center cursor-pointer text-[11px] '
                            + (media ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-white/10 bg-black/30 hover:border-white/30')}
                    >
                        <input ref={mediaRef} type="file" accept="video/*,audio/*" className="hidden"
                            onChange={(e) => setMedia(e.target.files?.[0] || null)} />
                        {media ? (
                            <span className="text-white">📁 {media.name} <span className="text-zinc-500">({(media.size / 1024 / 1024).toFixed(1)} MB)</span></span>
                        ) : (
                            <span className="text-zinc-300">1. Audio or video to subtitle (click to choose)</span>
                        )}
                    </div>
                    {/* SRT file or pasted text */}
                    <div
                        onClick={() => srtRef.current?.click()}
                        className={'border-2 border-dashed rounded-md p-3 text-center cursor-pointer text-[11px] '
                            + (srtFile ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-white/10 bg-black/30 hover:border-white/30')}
                    >
                        <input ref={srtRef} type="file" accept=".srt,text/plain" className="hidden"
                            onChange={(e) => setSrtFile(e.target.files?.[0] || null)} />
                        {srtFile ? (
                            <span className="text-white">📝 {srtFile.name}</span>
                        ) : (
                            <span className="text-zinc-300">2. .srt file (click to choose)</span>
                        )}
                    </div>
                    <div className="text-[10px] text-zinc-500 text-center">— or paste SRT contents —</div>
                    <textarea
                        value={srtText}
                        onChange={(e) => setSrtText(e.target.value)}
                        placeholder={"1\n00:00:01,000 --> 00:00:03,000\nFirst subtitle\n\n2\n00:00:03,500 --> 00:00:05,000\nSecond subtitle"}
                        rows={4}
                        className="w-full rounded-md bg-black/40 border border-white/10 text-zinc-100 text-[11px] p-2 font-mono resize-y placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/40"
                    />
                    {err && <div className="text-[11px] text-red-300">{err}</div>}
                    {done && <div className="text-[11px] text-emerald-300">✓ Imported {done.imported_segments} segments. Reloading…</div>}
                    <button
                        onClick={submit}
                        disabled={running || !media || (!srtFile && !srtText.trim())}
                        className="w-full py-2 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-50 text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                    >
                        {running ? (<><Loader2 size={12} className="animate-spin" /> Importing…</>) : 'Import & continue →'}
                    </button>
                </div>
            )}
        </div>
    );
}

// Build SRT text from an array of segments. Inverse of parseSrtToSegments.
// Uses the IN-MEMORY segments — no backend round-trip — so what the user
// downloads always matches what they see on screen, including unsaved edits.
function segmentsToSrt(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return '';
    const fmt = (t) => {
        const total = Math.max(0, +t || 0);
        const ms = Math.round((total % 1) * 1000);
        const s = Math.floor(total) % 60;
        const m = Math.floor(total / 60) % 60;
        const h = Math.floor(total / 3600);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    return segments
        .map((s, i) => `${i + 1}\n${fmt(s.start || 0)} --> ${fmt(s.end || 0)}\n${(s.text || '').trim()}\n`)
        .join('\n');
}

function downloadSegmentsAsSrt(segments, baseName = 'subtitles') {
    const srt = segmentsToSrt(segments || []);
    if (!srt) {
        alert('Nothing to download — there are no subtitles in the editor yet.');
        return;
    }
    const blob = new Blob([srt], { type: 'application/x-subrip;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'subtitles'}.srt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try { URL.revokeObjectURL(a.href); a.remove(); } catch {}
    }, 0);
}

// Parse an SRT file's text into the segment shape our app uses.
// Robust to CRLF, optional sequence numbers, single-line or multi-line
// cues. Returns [] on parse failure rather than throwing — callers
// can detect "nothing imported" and surface a friendly error.
function parseSrtToSegments(srtText) {
    if (!srtText || typeof srtText !== 'string') return [];
    const text = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return [];
    // Each cue block is separated by a blank line.
    const blocks = text.split(/\n\s*\n+/);
    const out = [];
    const tcRe = /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/;
    const toSec = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
    for (const block of blocks) {
        const lines = block.split('\n').map((l) => l.replace(/^﻿/, ''));
        if (lines.length < 2) continue;
        // First line might be a sequence number; second is timecodes,
        // OR the first line is timecodes (some files omit the index).
        let tcLine = -1;
        for (let i = 0; i < Math.min(2, lines.length); i++) {
            if (tcRe.test(lines[i])) { tcLine = i; break; }
        }
        if (tcLine < 0) continue;
        const m = tcRe.exec(lines[tcLine]);
        if (!m) continue;
        const start = toSec(m[1], m[2], m[3], m[4]);
        const end = toSec(m[5], m[6], m[7], m[8]);
        const txt = lines.slice(tcLine + 1).join(' ').trim();
        if (!txt) continue;
        out.push({ start, end, text: txt });
    }
    return out.sort((a, b) => (a.start || 0) - (b.start || 0));
}


// Small chip that communicates auto-save state. Dot-color + label.
//   • idle    — no edits yet this session (subtle)
//   • saving  — debounce window in progress (yellow, pulse)
//   • saved   — flushed to localStorage (green, with last-saved time)
//   • error   — quota or other failure (red, advise user)
function SaveStatusBadge({ status, savedAt }) {
    const fmtTime = (ts) => {
        if (!ts) return '';
        try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
        catch { return ''; }
    };
    const cfg = (() => {
        switch (status) {
            case 'saving':
                return { dot: 'bg-yellow-400 animate-pulse', text: 'Saving…', cls: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200' };
            case 'saved':
                return { dot: 'bg-emerald-400', text: savedAt ? `Saved at ${fmtTime(savedAt)}` : 'Saved', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' };
            case 'error':
                return { dot: 'bg-rose-400', text: 'Save failed — try ⌘S', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-200' };
            default:
                return { dot: 'bg-zinc-500', text: 'Auto-save ready', cls: 'border-white/10 bg-black/30 text-zinc-400' };
        }
    })();
    return (
        <span
            title="Edits are auto-saved to this browser. A crash or refresh won't lose your work — your edits will be restored when you re-open this project."
            className={'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] ' + cfg.cls}
        >
            <span className={'inline-block w-1.5 h-1.5 rounded-full ' + cfg.dot} />
            {cfg.text}
        </span>
    );
}


function Phase1Preview(p) {
    const wordCount = (p.editedTranscript || '').trim().split(/\s+/).filter(Boolean).length;
    // 'timed' / 'plain' = original Whisper-derived view.
    // 'aligned' = BYOL aligned view (only available after the Align
    // button has run successfully, i.e. p.alignedSegments is populated).
    const [view, setView] = useState((p.segments || []).length > 0 ? 'timed' : 'plain');
    // Auto-switch to the Aligned tab the moment alignment finishes —
    // user pastes lyrics → clicks Align → spinner runs → the tab
    // appears AND the editor + preview snap to it. Without this the
    // user has to discover the new tab manually.
    useEffect(() => {
        if (Array.isArray(p.alignedSegments) && p.alignedSegments.length > 0) {
            setView('aligned');
        }
    }, [p.alignedSegments]);
    // Active segments — what the editor + LiveSubtitleVideo + the
    // Continue button all consume. Defaults to the Whisper-derived
    // segments; switches to the aligned set when the user is viewing
    // the Aligned tab.
    const activeSegments = (view === 'aligned' && Array.isArray(p.alignedSegments) && p.alignedSegments.length)
        ? p.alignedSegments
        : (p.segments || []);
    const segCount = activeSegments.length;
    const hasAligned = Array.isArray(p.alignedSegments) && p.alignedSegments.length > 0;
    const isRegen = p.refineStatus === 'regenerating';
    const isSyncing = p.refineStatus === 'syncing';
    const isSynced = p.refineStatus === 'synced';
    const refineBusy = isRegen || isSyncing;
    // Phase 1 reframe-modal state. Mounted in this function (NOT at
    // the top of StandaloneSubtitle) so the modal's local state resets
    // every time the user opens it from this screen — they shouldn't
    // see stale form state if they jumped to Phase 2 and back.
    const [phase1ReframeOpen, setPhase1ReframeOpen] = useState(false);
    const phase1KfCount = Array.isArray(p.cropKeyframes) ? p.cropKeyframes.length : 0;
    // The reframe modal needs a target aspect ratio so it can show the
    // correct crop window outline. We compute the same way Phase 2 does:
    // vertical = 9:16, horizontal = 16:9, square = 1:1. Falls back to
    // 9:16 when outputOrientation isn't passed (shouldn't happen but
    // belt-and-braces — the default in StandaloneSubtitle is 'vertical').
    const phase1TargetAspect =
        p.outputOrientation === 'horizontal' ? (16 / 9)
        : p.outputOrientation === 'square'   ? 1
        :                                       (9 / 16);

    // Shared ref so the segments list on the right can drive the
    // video player on the left — clicking a timestamp seeks the
    // player straight to that segment so the user can verify timing
    // without scrubbing.
    const videoRef = useRef(null);
    const seekTo = (t) => {
        const v = videoRef.current;
        if (!v) return;
        const target = Math.max(0, Number(t) || 0);
        try {
            v.currentTime = target;
            // Auto-play after seeking so the user actually hears the
            // segment they clicked. Browsers block unmuted autoplay if
            // the user hasn't interacted yet — wrap in try/catch.
            v.play?.().catch(() => {});
        } catch {}
    };

    // Copy-all → put the whole transcript on the clipboard. Format
    // depends on which TAB the user is on (NOT just 'view'):
    //   • Timed    → original Whisper segments, "[mm:ss.ss → mm:ss.ss]\ntext\n\n"
    //   • Plain    → joined paragraph text from the original transcript
    //   • Aligned  → translated/aligned segments, same timecoded shape as Timed
    //
    // Earlier this always pulled p.segments, so the Aligned tab's
    // English subtitles silently got replaced by the original
    // Roman-Urdu Whisper text on copy. Now we use activeSegments
    // (which already tracks the active tab) and emit timecodes for
    // both timestamped tabs.
    const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'error'
    const buildCopyPayload = () => {
        const fmt = (t) => {
            const total = Math.max(0, +t || 0);
            const m = Math.floor(total / 60);
            const s = total % 60;
            return `${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
        };
        // Timed and Aligned both produce timecoded output, but each
        // copies from its own source array so the user gets the text
        // they're actually looking at.
        if (view === 'timed' && (p.segments?.length || 0) > 0) {
            return (p.segments || [])
                .map((s) => `[${fmt(s.start)} → ${fmt(s.end)}]\n${(s.text || '').trim()}`)
                .join('\n\n');
        }
        if (view === 'aligned' && Array.isArray(p.alignedSegments) && p.alignedSegments.length > 0) {
            return p.alignedSegments
                .map((s) => `[${fmt(s.start)} → ${fmt(s.end)}]\n${(s.text || '').trim()}`)
                .join('\n\n');
        }
        // Plain view (or fallback when a timed tab has no segments) —
        // the joined paragraph form. If aligned text exists and the
        // user is on the Aligned tab without segments, prefer the
        // aligned plain join so they don't get the original instead.
        if (view === 'aligned' && Array.isArray(p.alignedSegments) && p.alignedSegments.length > 0) {
            return p.alignedSegments.map((s) => (s.text || '').trim()).join(' ').trim();
        }
        return (p.editedTranscript || p.transcriptText || '').trim();
    };
    const copyAll = async () => {
        const payload = buildCopyPayload();
        if (!payload) return;
        try {
            // navigator.clipboard requires a secure context (https or
            // localhost). Wrap in try/catch and fall back to a
            // textarea + execCommand for older browsers / file://.
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(payload);
            } else {
                const ta = document.createElement('textarea');
                ta.value = payload;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 1800);
        } catch {
            setCopyState('error');
            setTimeout(() => setCopyState('idle'), 2400);
        }
    };
    // Setter that respects the active tab — timeline edits write to
    // the right array (Whisper-original vs Aligned) without the
    // timeline component needing to know which is which.
    const setActiveSegments = (newSegs) => {
        if (view === 'aligned' && hasAligned && typeof p.onAlignedChange === 'function') {
            p.onAlignedChange(newSegs);
        } else if (typeof p.onSegmentsChange === 'function') {
            p.onSegmentsChange(newSegs);
        }
    };

    // ─── Layout controls ────────────────────────────────────────────────
    // The user can pick how the preview + transcript editor sit
    // relative to each other. Defaults to 'split-equal' (50/50) but
    // remembers their last choice via localStorage.
    //   • split-equal      — 50/50 (the original behavior)
    //   • preview-large    — preview 66%, editor 33%
    //   • editor-large     — preview 33%, editor 66%
    //   • stacked          — preview full-width on top, editor below
    //   • preview-full     — editor hidden, preview takes 100% (timeline still below)
    // 'swapped' flips left/right within any side-by-side mode so the
    // user can drop the editor on either side.
    // 'previewZoom' scales the preview container — 50 / 75 / 100, or
    // 'fit' to maximize within the column.
    const [layoutMode, setLayoutMode] = useState(() => {
        try { return localStorage.getItem('klipra_phase1_layout') || 'split-equal'; }
        catch { return 'split-equal'; }
    });
    const [swapped, setSwapped] = useState(() => {
        try { return localStorage.getItem('klipra_phase1_swap') === '1'; }
        catch { return false; }
    });
    const [previewZoom, setPreviewZoom] = useState(() => {
        try { return localStorage.getItem('klipra_phase1_zoom') || 'fit'; }
        catch { return 'fit'; }
    });
    useEffect(() => {
        try { localStorage.setItem('klipra_phase1_layout', layoutMode); } catch {}
    }, [layoutMode]);
    useEffect(() => {
        try { localStorage.setItem('klipra_phase1_swap', swapped ? '1' : '0'); } catch {}
    }, [swapped]);
    useEffect(() => {
        try { localStorage.setItem('klipra_phase1_zoom', previewZoom); } catch {}
    }, [previewZoom]);

    // Map mode → Tailwind grid template. Editor on the right by default;
    // when 'swapped', the order utilities flip them.
    const gridClass = (() => {
        switch (layoutMode) {
            case 'preview-large':  return 'grid grid-cols-1 lg:grid-cols-3 gap-4';
            case 'editor-large':   return 'grid grid-cols-1 lg:grid-cols-3 gap-4';
            case 'stacked':        return 'grid grid-cols-1 gap-4';
            case 'preview-full':   return 'grid grid-cols-1 gap-4';
            case 'split-equal':
            default:               return 'grid grid-cols-1 lg:grid-cols-2 gap-4';
        }
    })();
    const previewSpan = (() => {
        if (layoutMode === 'preview-large') return 'lg:col-span-2';
        if (layoutMode === 'editor-large')  return 'lg:col-span-1';
        if (layoutMode === 'stacked' || layoutMode === 'preview-full') return '';
        return ''; // split-equal: 1 col each
    })();
    const editorSpan = (() => {
        if (layoutMode === 'preview-large') return 'lg:col-span-1';
        if (layoutMode === 'editor-large')  return 'lg:col-span-2';
        return '';
    })();
    // CSS-grid `order` flips the visual position without re-rendering JSX.
    const previewOrder = swapped ? 'lg:order-2' : 'lg:order-1';
    const editorOrder  = swapped ? 'lg:order-1' : 'lg:order-2';

    // Preview-zoom scaler. Wrapping the LiveSubtitleVideo in a sized
    // container lets us shrink without breaking the aspect-ratio
    // calculations inside the component.
    const previewWrapperStyle = (() => {
        if (previewZoom === 'fit') return { width: '100%' };
        const pct = parseInt(previewZoom, 10) || 100;
        return { width: `${pct}%`, marginLeft: 'auto', marginRight: 'auto' };
    })();

    // Render the timeline as a JSX variable so we can place it in the
    // RIGHT order depending on the active layout. In 'stacked' mode the
    // user wants Preview → Timeline → Editor (top to bottom); in every
    // other mode the timeline lives BELOW the side-by-side grid.
    const timelineNode = (activeSegments.length > 0 || view === 'aligned') ? (
        <div className="rounded-xl border border-emerald-500/20 bg-black/30">
            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap">
                <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-bold">
                    Timeline · drag to retime
                </div>
                <span className="text-[10px] text-zinc-400">
                    Editing the <strong className="text-zinc-300">{view === 'aligned' ? 'Aligned' : 'Timed'}</strong> track
                </span>
            </div>
            <div className="p-2">
                <SubtitleTimeline
                    segments={activeSegments}
                    setSegments={setActiveSegments}
                    videoRef={videoRef}
                    videoUrl={p.videoUrl}
                />
            </div>
        </div>
    ) : null;

    return (
        <div className="space-y-5">
            {/* Header row: re-transcribe button + light context. The
                re-transcribe button drops the user back into Phase 1's
                setup form so they can pick a different AI model or
                source language and try again — useful when the first
                transcription quality wasn't right. */}
            {typeof p.onBackToSetup === 'function' && (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            onClick={p.onBackToSetup}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-200 hover:bg-orange-500/20 text-[12px] transition"
                            title="Go back to the setup form to re-transcribe with a different AI model or source language"
                        >
                            <ChevronLeft size={14} /> Re-transcribe with different settings
                        </button>
                        {/* IMPORT .SRT — drop a previously-downloaded SRT
                            back into THIS job. Replaces the current
                            timed segments client-side; segments[]
                            change triggers the auto-save so the import
                            persists on next refresh. Use this if you
                            ever lose your work and have an SRT export
                            saved on disk. */}
                        {/* DOWNLOAD .SRT — generates the SRT from
                            in-memory state, NOT from the backend.
                            What you see in the editor is exactly
                            what gets exported, including any unsaved
                            edits. This is your "save my work to disk"
                            escape hatch. */}
                        <button
                            onClick={() => {
                                const segs = (activeSegments && activeSegments.length)
                                    ? activeSegments
                                    : (p.segments || []);
                                downloadSegmentsAsSrt(segs, `klipra-${(p.jobId || 'subs').slice(0, 8)}`);
                            }}
                            disabled={!(activeSegments && activeSegments.length) && !(p.segments && p.segments.length)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-[12px] cursor-pointer transition disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Download the CURRENT subtitles (what's shown in the editor right now) as an .srt file. Built from your live edits — does NOT round-trip through the backend, so unsaved changes are included."
                        >
                            <Download size={14} /> Download .SRT
                        </button>
                        <label
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 text-[12px] cursor-pointer transition"
                            title="Replace the current subtitles with an .srt file you previously exported. Useful for recovering from accidentally lost edits."
                        >
                            <Upload size={14} /> Import .SRT
                            <input
                                type="file"
                                accept=".srt,text/srt,text/plain,application/x-subrip"
                                style={{ display: 'none' }}
                                onChange={async (e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = '';
                                    if (!f) return;
                                    try {
                                        const text = await f.text();
                                        const parsed = parseSrtToSegments(text);
                                        if (parsed.length === 0) {
                                            alert('Could not parse this file as SRT. Make sure it has standard "HH:MM:SS,mmm --> HH:MM:SS,mmm" timecodes.');
                                            return;
                                        }
                                        // Replace via the active-tab setter so the
                                        // import lands on whichever track (Timed/
                                        // Aligned) the user is currently editing.
                                        setActiveSegments(parsed);
                                    } catch (err) {
                                        alert('Failed to read the file: ' + (err?.message || err));
                                    }
                                }}
                            />
                        </label>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        {/* MANUAL SAVE — explicit "save now" button next to
                            the auto-save indicator. Auto-save covers most
                            cases (debounced + every 30s + on tab close),
                            but users want a button they can press to feel
                            confident before walking away. */}
                        {typeof p.onManualSave === 'function' && (
                            <button
                                onClick={p.onManualSave}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-[11px] transition"
                                title="Save your subtitle edits to local storage now (also Cmd+S / Ctrl+S). Auto-save runs every 30s and on close, but this is the explicit button."
                            >
                                💾 Save
                            </button>
                        )}
                        {/* AUTO-SAVE INDICATOR — gives users explicit
                            feedback that their edits are persisted, so a
                            crash or refresh doesn't make them anxious. */}
                        <SaveStatusBadge status={p.saveStatus} savedAt={p.savedAt} />
                    </div>
                </div>
            )}

            {/* LAYOUT TOOLBAR — pick how the preview + editor sit on
                the page. Persists per-user via localStorage. */}
            <div className="flex items-center gap-2 flex-wrap text-[10px]">
                <span className="text-zinc-500 uppercase tracking-wider font-bold">Layout</span>
                {[
                    { id: 'split-equal',   label: '50 / 50',   title: 'Equal columns — preview and editor side by side' },
                    { id: 'preview-large', label: 'Preview big', title: 'Preview takes 2/3, editor 1/3' },
                    { id: 'editor-large',  label: 'Editor big',  title: 'Editor takes 2/3, preview 1/3' },
                    { id: 'stacked',       label: 'Stacked',    title: 'Preview on top, editor below' },
                    { id: 'preview-full',  label: 'Preview only', title: 'Hide the editor list — useful for review-only viewing (timeline below stays)' },
                ].map((opt) => (
                    <button
                        key={opt.id}
                        onClick={() => setLayoutMode(opt.id)}
                        title={opt.title}
                        className={
                            'px-2 py-1 rounded-md border transition '
                            + (layoutMode === opt.id
                                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                                : 'border-white/10 bg-black/30 text-zinc-400 hover:text-white hover:border-white/30')
                        }
                    >
                        {opt.label}
                    </button>
                ))}
                <button
                    onClick={() => setSwapped((v) => !v)}
                    title="Swap left and right panels"
                    className="ml-1 px-2 py-1 rounded-md border border-white/10 bg-black/30 text-zinc-300 hover:text-white hover:border-white/30 transition"
                >
                    ⇄ Swap sides
                </button>
                <div className="mx-2 h-4 w-px bg-white/10" />
                <span className="text-zinc-500 uppercase tracking-wider font-bold">Preview</span>
                {[
                    { id: '50',  label: '50%' },
                    { id: '75',  label: '75%' },
                    { id: '100', label: '100%' },
                    { id: 'fit', label: 'Fit' },
                ].map((opt) => (
                    <button
                        key={opt.id}
                        onClick={() => setPreviewZoom(opt.id)}
                        className={
                            'px-2 py-1 rounded-md border transition '
                            + (previewZoom === opt.id
                                ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                                : 'border-white/10 bg-black/30 text-zinc-400 hover:text-white hover:border-white/30')
                        }
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* TWO-COLUMN: live video preview + transcript editor.
                The video plays the user's actual upload with the timed
                segment overlaid in real time so they can verify timing
                and word accuracy WITHOUT leaving Phase 1. */}
            <div className={gridClass}>
                <div className={`${previewSpan} ${previewOrder}`} style={previewWrapperStyle}>
                    <LiveSubtitleVideo
                        videoUrl={p.videoUrl}
                        segments={activeSegments}
                        // Intentionally no fallbackText: Phase 1's job is to
                        // verify timing, so gaps between segments must read
                        // as empty — exactly how the burned video will look.
                        // Passing the whole transcript here caused stale text
                        // to bleed onto the player during sub-1s silent gaps.
                        externalVideoRef={videoRef}
                        // INTERACTIVE PREVIEW IN PHASE 1 — user can:
                        //   • Click subtitle text → select it
                        //   • Drag body → reposition vertically
                        //   • Drag bottom-right corner → resize font
                        //   • Double-click → inline edit text
                        // Position + font size hand off to the parent's
                        // global styling state so changes carry into
                        // Phase 2 / the final burn. Text edits write back
                        // through the active-tab setter.
                        interactive={true}
                        positionPct={p.positionPct}
                        fontSize={p.fontSize}
                        onPositionChange={(n) => p.setPositionPct?.(n)}
                        onFontSizeChange={(n) => p.setFontSize?.(n)}
                        imageOverlays={p.imageOverlays}
                        setImageOverlays={p.setImageOverlays}
                        animation={p.animation}
                        highlightColor={p.highlightColor}
                        onTextChange={(idx, txt) => {
                            if (idx < 0 || idx >= activeSegments.length) return;
                            const next = activeSegments.map((s, i) => i === idx ? { ...s, text: txt } : s);
                            setActiveSegments(next);
                        }}
                    />
                </div>

                {/* In stacked mode the user wants the order to be
                    Preview → Timeline → Editor. We render the timeline
                    HERE (between preview and editor), and the
                    after-grid render below skips itself when stacked
                    so the timeline doesn't appear twice. */}
                {layoutMode === 'stacked' && timelineNode}

                {layoutMode !== 'preview-full' && (
                <div className={`rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 flex flex-col ${editorSpan} ${editorOrder}`}>
                    <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                        <div className="text-[11px] uppercase tracking-wider text-emerald-300 font-bold flex items-center gap-1.5">
                            <Check size={12} /> Phase 1 result · review and edit
                            {isSynced && (
                                <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-200 text-[9px] tracking-normal normal-case">
                                    <Volume2 size={9} /> Synced to audio
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            {(segCount > 0 || hasAligned) && (
                                <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-[10px]">
                                    <button onClick={() => setView('timed')}
                                        className={'px-2 py-1 transition ' + (view === 'timed' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                                        Timed
                                    </button>
                                    <button onClick={() => setView('plain')}
                                        className={'px-2 py-1 transition ' + (view === 'plain' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                                        Plain
                                    </button>
                                    {/* Third tab — only renders after the
                                        user has run "Align to audio" with
                                        their lyrics. Switching here
                                        instantly flips the live preview
                                        AND the segments below to the
                                        aligned set. The original Whisper
                                        view is preserved under Timed/Plain. */}
                                    {hasAligned && (
                                        <button onClick={() => setView('aligned')}
                                            className={'px-2 py-1 transition flex items-center gap-1 ' + (view === 'aligned' ? 'bg-violet-500/30 text-violet-100' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                                            🎵 Aligned
                                        </button>
                                    )}
                                </div>
                            )}
                            {/* Copy all — copies the entire transcript
                                with timestamps (Timed view) or just
                                the joined text (Plain view). Briefly
                                flips to "Copied" so the user sees the
                                action took. */}
                            <button
                                onClick={copyAll}
                                disabled={!activeSegments?.length && !(p.editedTranscript || p.transcriptText)}
                                title={(view === 'timed' || view === 'aligned')
                                    ? `Copy ${view === 'aligned' ? 'aligned' : 'all'} subtitles with timestamps to your clipboard`
                                    : 'Copy the full transcript text to your clipboard'}
                                className={'inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border transition disabled:opacity-40 disabled:cursor-not-allowed '
                                    + (copyState === 'copied'
                                        ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100'
                                        : copyState === 'error'
                                            ? 'border-red-500/60 bg-red-500/15 text-red-200'
                                            : 'border-white/10 bg-black/30 text-zinc-300 hover:text-white hover:border-white/30')}
                            >
                                {copyState === 'copied' ? <Check size={11} /> : <Copy size={11} />}
                                {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy all'}
                            </button>
                            <span className="text-[10px] text-zinc-400">
                                {wordCount} words{segCount > 0 ? ` · ${segCount} segments` : ''}
                            </span>
                        </div>
                    </div>

                    {(view === 'timed' || view === 'aligned') && segCount > 0 ? (
                        <SegmentsList
                            segments={activeSegments}
                            onEdit={view === 'aligned'
                                ? undefined  // editing aligned is read-only for v1
                                : (idx, text) => p.onEditSegment?.(idx, text)}
                            onSeek={seekTo}
                            onSplit={view === 'aligned'
                                ? undefined
                                : (idx) => p.onSplitSegment?.(idx)}
                            onDelete={view === 'aligned'
                                ? undefined
                                : (idx) => p.onDeleteSegment?.(idx)}
                        />
                    ) : (
                        <textarea
                            value={p.editedTranscript}
                            onChange={(e) => p.setEditedTranscript(e.target.value)}
                            rows={10}
                            className="w-full bg-black/40 border border-white/10 rounded-md p-3 text-[13px] text-white focus:outline-none focus:border-emerald-500/50 resize-y leading-relaxed font-mono"
                        />
                    )}
                    <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
                        {view === 'timed'
                            ? 'Each line is a timed segment — the video player on the left shows the active one as it plays.'
                            : 'Edit anything that\'s still wrong before continuing. Your edits will be used for the burned subtitles.'}
                    </p>
                </div>
                )}
            </div>

            {/* TIMELINE — placed AFTER the preview/editor grid in every
                layout EXCEPT 'stacked' (where it's already injected
                between preview and editor inside the grid). See the
                comment at the timelineNode definition above. */}
            {layoutMode !== 'stacked' && timelineNode}

            {/* Frame & Crop — orientation picker + reframe entry point.
                Lives BEFORE Refine on Phase 1 so the user can decide
                what shape the final video is going to be (and where the
                visible window sits on a horizontal source) BEFORE they
                spend time fixing transcript wording. Whatever they set
                here is shared with Phase 2 via the parent's
                outputOrientation + cropKeyframes state, so styling +
                burn pick it up without any extra wiring.
                Only shown when the parent has wired the state — keeps
                the component backward-compatible. */}
            {(typeof p.setOutputOrientation === 'function' || typeof p.setCropKeyframes === 'function') && (
                <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-3">
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200 font-bold flex items-center gap-1.5">
                        <Languages size={11} /> Frame & crop · output shape
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                        Change the output dimensions and slide / keyframe the visible window so the important part of your video stays in frame after cropping.
                    </p>

                    {/* Orientation pills. The state is owned by the
                        parent so a switch here updates Phase 2 too. */}
                    {typeof p.setOutputOrientation === 'function' && (
                        <div className="grid grid-cols-3 gap-1.5">
                            {[
                                ['vertical',   '9:16',  'Vertical'],
                                ['horizontal', '16:9',  'Horizontal'],
                                ['square',     '1:1',   'Square'],
                            ].map(([code, ratio, label]) => {
                                const active = p.outputOrientation === code;
                                return (
                                    <button
                                        key={code}
                                        type="button"
                                        onClick={() => p.setOutputOrientation(code)}
                                        className={
                                            'rounded-md border px-2 py-2 text-left transition '
                                            + (active
                                                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-50'
                                                : 'bg-black/30 border-white/10 text-zinc-300 hover:border-white/20')
                                        }
                                    >
                                        <div className="text-[12px] font-bold flex items-center gap-1.5">
                                            {label}
                                            <span className="text-[10px] font-mono text-zinc-400">{ratio}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Reframe — opens the keyframe modal. Same component
                        Phase 2 uses; the state is shared so any keyframes
                        set here are visible (and editable) in Phase 2 too. */}
                    {typeof p.setCropKeyframes === 'function' && (
                        <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-white/5">
                            <div className="text-[10px] text-zinc-400 leading-relaxed flex-1 min-w-[180px]">
                                <strong className="text-zinc-200">Reframe:</strong> when your source is wider than the output (e.g. 16:9 source → 9:16 output), set hard-cut keyframes so the visible crop window follows the action.
                                {phase1KfCount > 0 && (
                                    <span className="ml-1 inline-flex items-center gap-1 text-cyan-300">
                                        · {phase1KfCount} keyframe{phase1KfCount === 1 ? '' : 's'} set
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {phase1KfCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => p.setCropKeyframes([])}
                                        className="text-[11px] px-2 py-1 rounded border border-white/10 text-zinc-300 hover:border-white/20 hover:text-white"
                                        title="Remove all reframe keyframes"
                                    >
                                        Clear
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setPhase1ReframeOpen(true)}
                                    className="text-[11px] px-3 py-1.5 rounded bg-gradient-to-r from-indigo-500 to-cyan-500 text-white font-semibold shadow"
                                >
                                    {phase1KfCount > 0 ? 'Edit reframe keyframes' : 'Open reframe editor'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Export-without-subtitles — the "I just want the
                        reframe, not the captions" shortcut. Skips the
                        styling phase entirely; the burn endpoint receives
                        burn_subtitles=false and re-encodes the (possibly
                        reframed) source to the output mp4. Output lands
                        in Past Projects just like a regular burn. */}
                    {typeof p.onExportNoSubs === 'function' && (
                        <div className="pt-2 mt-1 border-t border-white/5 flex items-center justify-between gap-3 flex-wrap">
                            <div className="text-[10px] text-zinc-400 leading-relaxed flex-1 min-w-[180px]">
                                <strong className="text-zinc-200">Just reframing?</strong> Skip the styling step entirely and export the video without any subtitles burned in.
                            </div>
                            <button
                                type="button"
                                onClick={p.onExportNoSubs}
                                className="text-[11px] px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 font-semibold inline-flex items-center gap-1.5"
                                title="Re-encodes the reframed source without burning any subtitles. Output lands in Past Projects."
                            >
                                <Download size={11} /> Export without subtitles
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Reframe modal — same component used in Phase 2. Only
                mounted while open so the underlying <video> isn't
                eating memory in the background. */}
            {phase1ReframeOpen && (
                <StandaloneReframeKeyframeModal
                    videoUrl={p.videoUrl}
                    targetAspect={phase1TargetAspect}
                    initialKeyframes={p.cropKeyframes || []}
                    onClose={() => setPhase1ReframeOpen(false)}
                    onSave={(kfs) => {
                        if (typeof p.setCropKeyframes === 'function') p.setCropKeyframes(kfs);
                        setPhase1ReframeOpen(false);
                    }}
                />
            )}

            {/* Refine controls — Regenerate vs Sync are two distinct
                operations users may want separately:
                  • Regenerate → re-run AI cleanup against the original
                    Whisper transcript. Useful when wording is wrong.
                  • Sync → keep the wording, but realign timestamps to
                    the actual audio. Useful when text is right but the
                    timing has drifted (after edits or for translated text). */}
            <div className="rounded-xl border border-white/10 bg-surface/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-2 flex items-center gap-1.5">
                    <Wand2 size={11} /> Refine before burning
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                        onClick={p.onRegenerate}
                        disabled={refineBusy}
                        className="rounded-md border border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/15 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2.5 text-left transition flex items-start gap-2"
                    >
                        {isRegen
                            ? <Loader2 size={14} className="text-orange-300 mt-0.5 shrink-0 animate-spin" />
                            : <RefreshCw size={14} className="text-orange-300 mt-0.5 shrink-0" />}
                        <div>
                            <div className="text-xs font-semibold text-orange-100">
                                {isRegen ? 'Regenerating…' : 'Regenerate subtitles'}
                            </div>
                            <div className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">
                                Re-run AI cleanup on the original audio words. Best when text is wrong.
                            </div>
                        </div>
                    </button>
                    <button
                        onClick={p.onSync}
                        disabled={refineBusy}
                        className="rounded-md border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2.5 text-left transition flex items-start gap-2"
                    >
                        {isSyncing
                            ? <Loader2 size={14} className="text-blue-300 mt-0.5 shrink-0 animate-spin" />
                            : <Volume2 size={14} className="text-blue-300 mt-0.5 shrink-0" />}
                        <div>
                            <div className="text-xs font-semibold text-blue-100">
                                {isSyncing ? 'Aligning to audio…' : 'Sync audio & subtitles'}
                            </div>
                            <div className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">
                                Keeps your wording, but refines word-level timing within each line. Won't apply if your text is in a different script from the audio.
                            </div>
                        </div>
                    </button>
                </div>
                {/* Re-translate — surfaces the existing retranslateTo
                    helper so users can fix or change the Phase 1
                    translation without re-uploading. Shows the user's
                    current target language as the default. */}
                {p.onRetranslate && (
                    <RetranslateRow
                        onRetranslate={p.onRetranslate}
                        currentTarget={p.currentTargetLang || 'en'}
                        currentMode={p.currentScriptMode || 'auto'}
                        busy={refineBusy}
                    />
                )}

                {/* Undo Sync — visible only after a successful sync.
                    The backend keeps a one-deep snapshot, so this is a
                    one-shot revert (good enough for "I tried it and it
                    made things worse, get me back"). */}
                {p.canUndoSync && (
                    <button
                        onClick={p.onUndoSync}
                        disabled={refineBusy}
                        className="mt-2 w-full rounded-md border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs text-zinc-200 flex items-center justify-center gap-1.5"
                    >
                        <RotateCcw size={12} /> Undo last sync
                    </button>
                )}
                {/* Sync's "applied: false" responses come back as
                    refineError so the user sees a clear, calm
                    explanation instead of silently broken subtitles. */}
                {p.refineError && (
                    <div className="mt-2 flex items-start gap-2 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-200/90 leading-relaxed">
                        <AlertCircle size={12} className="mt-0.5 shrink-0" />
                        <span>{p.refineError}</span>
                    </div>
                )}
            </div>

            {/* Step 2 — Bring-Your-Own-Lyrics. The user pastes
                official lyrics, the LLM matches each Whisper segment
                to a lyric line (or null for noise), and the result
                replaces the current subtitle text while keeping
                Whisper's timing windows. If the user's script_mode
                is 'translate', the matched lines are translated using
                the song-mode prompt (chorus repetition preserved,
                crypto/finance glossary, etc.). Sits BELOW the action
                row so it's a clear "alternative path" rather than
                fighting for attention with the regular flow. */}
            {p.jobId && (
                <StandaloneLyricsPanel
                    jobId={p.jobId}
                    llmHeaders={p.llmHeaders}
                    targetLang={p.targetLang}
                    scriptMode={p.scriptMode}
                    onAligned={(newSegments) => {
                        // Pass aligned segments to the PARENT under
                        // onSegmentsAligned (NOT onSegmentsReplaced).
                        // The parent stores them in `alignedSegments`
                        // state separately from the original segments.
                        // The "Aligned" tab appears, the editor + the
                        // live preview switch to it automatically
                        // (via the useEffect on alignedSegments).
                        if (Array.isArray(newSegments) && p.onSegmentsAligned) {
                            p.onSegmentsAligned(newSegments.map((s) => ({
                                text: s.text || '',
                                start: Number(s.start) || 0,
                                end: Number(s.end) || 0,
                            })));
                        }
                    }}
                />
            )}

            <div className="flex gap-3 flex-wrap">
                <button onClick={p.onRedo}
                    className="flex-1 min-w-[120px] py-2.5 rounded-xl border border-white/15 text-zinc-300 hover:bg-white/5 text-sm flex items-center justify-center gap-2">
                    <RotateCcw size={14} /> Start over
                </button>
                {p.jobId && segCount > 0 && (
                    <a href={getApiUrl(`/api/standalone/subtitle/${p.jobId}/srt`)}
                       download={`klipra_${p.jobId}.srt`}
                       className="flex-1 min-w-[140px] py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-sm flex items-center justify-center gap-2">
                        <Download size={14} /> Download .srt
                    </a>
                )}
                <button
                    onClick={() => {
                        // Commit the active tab's segments to the parent.
                        // If user is viewing Aligned, those become the
                        // canonical segments for burn. Otherwise the
                        // original Whisper-derived ones stay.
                        const commit = (view === 'aligned' && Array.isArray(p.alignedSegments) && p.alignedSegments.length)
                            ? p.alignedSegments
                            : null;
                        p.onContinue?.(commit);
                    }}
                    className="flex-[2] min-w-[180px] py-2.5 rounded-xl bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-500 text-white font-bold text-sm flex items-center justify-center gap-2">
                    Continue to Step 3 · Style & burn <ChevronRight size={14} />
                </button>
            </div>

        </div>
    );
}


// Re-translate row inside Step 2 (Phase1Preview). Lets the user fix
// or change the Phase 1 translation without going back to the upload
// screen. Common case: user picked "Translate → English" in Phase 1
// but the result still reads in Roman Urdu (LLM didn't run, key was
// missing, etc.). Picking a target here + clicking re-translate fires
// /api/standalone/subtitle/regenerate with the new language.
function RetranslateRow({ onRetranslate, currentTarget, currentMode, busy }) {
    // Three modes the user can pick to re-process the saved transcript:
    //   • 'auto'      — re-run AI cleanup, keep original language/script.
    //   • 'roman'     — transliterate the original audio words to Roman/Latin
    //                   script (Roman Urdu, Hinglish, Romaji, pinyin). Doesn't
    //                   change WHAT is said, just the alphabet.
    //   • 'translate' — translate to a different language (with target picker).
    //
    // Picker state starts mirroring whatever the user picked last so the
    // current state of the editor is visible.
    const [mode, setMode] = useState(currentMode || 'auto');
    const [pickerTarget, setPickerTarget] = useState(currentTarget || 'en');

    const handle = () => {
        if (busy) return;
        if (typeof onRetranslate !== 'function') return;
        if (mode === 'translate') {
            onRetranslate('translate', pickerTarget);
        } else if (mode === 'roman') {
            onRetranslate('roman');
        } else {
            onRetranslate('auto');
        }
    };

    const currentLabel =
        currentMode === 'translate'
            ? (TARGET_LANGS.find(([c]) => c === currentTarget)?.[1] || currentTarget)
            : currentMode === 'roman' ? 'Roman / Latin script'
            : currentMode === 'hinglish' ? 'Hinglish (Hindi + English)'
            : currentMode === 'urglish' ? 'Urglish (Roman Urdu + English)'
            : 'original';

    const modes = [
        ['auto',     'Original',           'Same language, AI re-cleanup.'],
        ['roman',    'Roman / Latin',      'Transliterate everything to Roman/Latin (e.g. ہے → hai).'],
        ['hinglish', 'Hinglish',           'Hindi → Roman, English stays English (e.g. "yeh layer zero hai").'],
        ['urglish',  'Urglish',            'Urdu → Roman, English stays English (e.g. "Bitcoin hold karo, community ke saath").'],
        ['translate','Translate',          'A different language entirely.'],
    ];

    let buttonLabel = 'Apply';
    if (mode === 'translate') {
        buttonLabel = `Translate to ${TARGET_LANGS.find(([c]) => c === pickerTarget)?.[1] || pickerTarget}`;
    } else if (mode === 'roman') {
        buttonLabel = 'Rewrite in Roman script';
    } else if (mode === 'hinglish') {
        buttonLabel = 'Rewrite in Hinglish';
    } else if (mode === 'urglish') {
        buttonLabel = 'Rewrite in Urglish';
    } else {
        buttonLabel = 'Re-clean in original language';
    }

    return (
        <div className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[11px] uppercase tracking-wider text-blue-200 font-bold flex items-center gap-1.5">
                    <Wand2 size={11} /> Change subtitle language / script
                </div>
                <span className="text-[10px] text-blue-200/60">
                    Currently in: <strong className="text-blue-100">{currentLabel}</strong>
                </span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
                Re-runs the AI against your saved transcript — no re-uploading, no
                re-transcribing. Pick a mode, then a target if translating.
            </p>

            {/* Mode pills — five options now (Original / Roman / Hinglish /
                Urglish / Translate), mirroring Phase 1 setup AND the
                per-clip Subtitle modal so the naming stays consistent
                across the app. 2-row 3-col on small screens, single-row
                5-col on wider so the new Hinglish/Urglish pills don't
                get squeezed. */}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                {modes.map(([code, label, hint]) => {
                    const active = mode === code;
                    return (
                        <button
                            key={code}
                            type="button"
                            onClick={() => setMode(code)}
                            disabled={busy}
                            className={
                                'rounded-md border px-2 py-2 text-left transition disabled:opacity-50 '
                                + (active
                                    ? 'bg-blue-500/20 border-blue-400/50 text-blue-50'
                                    : 'bg-black/30 border-white/10 text-zinc-300 hover:border-white/20')
                            }
                        >
                            <div className="text-[11px] font-bold">{label}</div>
                            <div className="text-[9px] text-zinc-500 leading-tight mt-0.5">{hint}</div>
                        </button>
                    );
                })}
            </div>

            {/* Target-language picker — only relevant for Translate. For
                Roman the source language is whatever Whisper detected;
                for Original the language doesn't change. */}
            {mode === 'translate' && (
                <select
                    value={pickerTarget}
                    onChange={(e) => setPickerTarget(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-md bg-black/40 border border-white/10 text-zinc-100 text-xs py-2 px-2 focus:outline-none focus:border-blue-400 disabled:opacity-50"
                >
                    {TARGET_LANGS.map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                    ))}
                </select>
            )}

            <button
                type="button"
                onClick={handle}
                disabled={busy}
                className="w-full px-3 py-2 rounded-md border border-blue-500/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-100 text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
                {busy
                    ? <><Loader2 size={12} className="animate-spin" /> Working…</>
                    : buttonLabel}
            </button>
        </div>
    );
}


function StandaloneLyricsPanel({ jobId, onAligned, llmHeaders, targetLang, scriptMode }) {
    // Open by default. Previously this panel was collapsed AND sat below
    // the big "Continue to Step 3" button, so people doing song subtitles
    // missed it entirely. Now it's expanded on open and sits above the
    // action row — they can collapse it if they don't need it.
    const [open, setOpen] = useState(true);
    const [lyrics, setLyrics] = useState('');
    const [keepTags, setKeepTags] = useState(false);
    const [status, setStatus] = useState(null); // null | 'aligning' | 'done' | 'error'
    const [error, setError] = useState(null);
    const [summary, setSummary] = useState(null);
    // Translation target chosen IN this panel. Independent of whatever
    // the user picked in Step 1's setup screen — they can change it
    // here at any time. 'none' means "just align my lyrics to the
    // audio, don't translate". Otherwise it's an ISO language code
    // from TARGET_LANGS and the backend runs the song-mode translate
    // prompt on the aligned segments.
    const [translateTo, setTranslateTo] = useState(
        scriptMode === 'translate' ? (targetLang || 'en') : 'none'
    );

    const submit = async () => {
        if (!lyrics.trim()) {
            setError('Paste your lyrics first.');
            return;
        }
        setStatus('aligning');
        setError(null);
        setSummary(null);
        try {
            const res = await fetch(getApiUrl('/api/standalone/subtitle/lyrics-align'), {
                method: 'POST',
                // Pass llmHeaders so the AI can run semantic alignment +
                // optional translate. Without these the request hits the
                // endpoint but the AI step inside is skipped silently —
                // which is what made it look like "nothing happened".
                headers: {
                    'Content-Type': 'application/json',
                    ...(llmHeaders || {}),
                },
                body: JSON.stringify({
                    job_id: jobId,
                    lyrics,
                    keep_structure_tags: keepTags,
                    // Use the panel's local translateTo state. 'none' =
                    // align only, no translation. Anything else = run
                    // the song-mode translate prompt against the
                    // aligned ground-truth lyrics.
                    target_language: translateTo === 'none' ? null : translateTo,
                    script_mode: translateTo === 'none' ? 'auto' : 'translate',
                }),
            });
            if (!res.ok) {
                const t = await res.text();
                throw new Error(t || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setStatus('done');
            setSummary(data);
            // Hand the new aligned segments up to the parent so it
            // can refresh state in place — NO PAGE RELOAD. Previous
            // version reloaded which dumped users back to the
            // homepage and made the feature feel like a crash.
            if (typeof onAligned === 'function' && Array.isArray(data?.segments)) {
                onAligned(data.segments);
            }
        } catch (e) {
            setStatus('error');
            setError(String(e?.message || e));
        }
    };

    return (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between p-3 text-xs font-bold text-violet-300 uppercase tracking-wider"
            >
                <span className="flex items-center gap-1.5">
                    🎤 Paste your song lyrics — align to audio with AI
                    {status === 'done' && (
                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-100 border border-emerald-400/40 normal-case">
                            ✓ aligned
                        </span>
                    )}
                </span>
                <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-2 animate-[fadeIn_0.2s_ease-out]">
                    <p className="text-[11px] text-violet-200/70 leading-snug">
                        If Whisper got the words wrong (common with songs,
                        mixed languages, or noisy audio), paste your
                        <strong> official lyrics</strong> below. We'll keep
                        Whisper's <em>timings</em> as anchors and replace
                        only the <em>text</em>. Then translate or burn —
                        you'll get accurate subtitles aligned to the audio.
                    </p>
                    <textarea
                        value={lyrics}
                        onChange={(e) => setLyrics(e.target.value)}
                        placeholder={"[Verse 1]\nLine one of the song goes here\nLine two follows the rhyme\n\n[Chorus]\nThe chorus repeats verbatim each time\nKeep punctuation, line breaks intact"}
                        rows={10}
                        className="w-full rounded-md bg-black/40 border border-violet-500/20 text-zinc-100 text-xs p-2 font-mono resize-y placeholder:text-zinc-600 focus:outline-none focus:border-violet-400"
                    />
                    <label className="flex items-center gap-2 text-[11px] text-violet-200/80">
                        <input
                            type="checkbox"
                            checked={keepTags}
                            onChange={(e) => setKeepTags(e.target.checked)}
                            className="accent-violet-500"
                        />
                        Keep [Verse]/[Chorus] tags as on-screen subtitles (rare)
                    </label>

                    {/* Translation target — this is the ESSENTIAL control
                        users were missing. When set, the aligned lyrics
                        are translated to this language using the song-
                        mode prompt (preserves choruses, crypto/finance
                        glossary, keeps already-target-language lines
                        verbatim). 'none' = just align, no translation. */}
                    <div className="space-y-1">
                        <label className="text-[11px] uppercase tracking-wider text-violet-200/80 font-bold flex items-center gap-1.5">
                            <Wand2 size={11} /> Translate aligned lyrics to
                        </label>
                        <select
                            value={translateTo}
                            onChange={(e) => setTranslateTo(e.target.value)}
                            className="w-full rounded-md bg-black/40 border border-violet-500/20 text-zinc-100 text-xs py-2 px-2.5 focus:outline-none focus:border-violet-400"
                        >
                            <option value="none">Keep original — no translation</option>
                            {TARGET_LANGS.map(([code, name]) => (
                                <option key={code} value={code}>{name}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-violet-200/60 leading-snug">
                            {translateTo === 'none'
                                ? 'Aligned subtitles will use your pasted lyrics exactly as written.'
                                : `Aligned subtitles will be translated to ${TARGET_LANGS.find(([c]) => c === translateTo)?.[1] || translateTo}, with already-${TARGET_LANGS.find(([c]) => c === translateTo)?.[1] || translateTo} lines (e.g. an English chorus) preserved verbatim.`}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={submit}
                        disabled={status === 'aligning' || !lyrics.trim()}
                        className="w-full py-2.5 px-2 rounded-md bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 text-violet-50 text-xs font-bold transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {status === 'aligning' ? (
                            <><Loader2 size={12} className="animate-spin" /> Aligning to audio…</>
                        ) : translateTo === 'none' ? (
                            <>Align to audio →</>
                        ) : (
                            <>Align + translate to {TARGET_LANGS.find(([c]) => c === translateTo)?.[1]} →</>
                        )}
                    </button>
                    {status === 'done' && summary && (
                        <div className="text-[11px] text-emerald-300/90 leading-snug space-y-0.5">
                            <div>
                                ✓ Aligned <strong>{summary.lines_count}</strong> lines via <strong>{summary.alignment_method}</strong>.
                            </div>
                            <div className={summary.translated ? 'text-emerald-200' : 'text-amber-300'}>
                                {summary.translated
                                    ? `✓ Translated to ${TARGET_LANGS.find(([c]) => c === translateTo)?.[1] || translateTo} using the song-mode prompt.`
                                    : 'No translation applied (translate target was "Keep original").'}
                            </div>
                            <div className="text-violet-200/70 mt-1">
                                Preview & 🎵 Aligned tab updated. Switch to Aligned above to see the result.
                            </div>
                        </div>
                    )}
                    {status === 'error' && (
                        <div className="text-[11px] text-red-300 leading-snug">
                            Alignment failed: {error}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Plays the user's source video and overlays whichever segment is
 * currently active (start ≤ t ≤ end). Used in Phase 1 for plain visual
 * verification, and in Phase 2 with full styling props for live preview
 * of the burn output.
 */
function LiveSubtitleVideo({
    videoUrl, segments, fallbackText,
    // Optional styling — Phase 2 supplies these. When omitted, we render
    // a minimal white-with-shadow look so Phase 1's preview is readable.
    fontFamily = 'Verdana', fontColor = '#FFFFFF',
    // The slider value (range 14-72). Both preview and burn render this
    // as the same fraction of frame height — the preview achieves that
    // via container-query units, the burn via video_h/600 scaling.
    // Slider value 32 => 32/600 = 5.3% of frame height in BOTH places.
    fontSize = 32,
    // Legacy prop, ignored when fontSize is provided. Kept so older
    // callers don't crash during the transition.
    fontSizeRem,
    // Optional external ref so the parent (Phase1Preview / Phase2Styling)
    // can drive the player — e.g. seeking to a timestamp when the user
    // clicks a segment in the editor list. When omitted we fall back to
    // a local ref so the component still works in isolation.
    externalVideoRef,
    bgColor = '#000000', bgOpacity = 0,
    borderColor = '#000000', borderWidth = 2,
    // Vertical position of the subtitle TOP edge as a percentage of the
    // frame height. 0 = top edge, 100 = bottom edge. Phase 1 leaves it
    // at the default; Phase 2's slider overrides it live.
    positionPct = 86,
    // Output orientation + crop offsets. When orientation is not
    // 'original' the preview re-shapes its container to the target
    // aspect ratio (9:16 or 16:9) and uses object-fit:cover plus
    // object-position to simulate the crop window — so the user sees
    // exactly what the burned mp4 will look like, before they burn.
    outputOrientation = 'original',
    cropXOffsetPct = 50,
    cropYOffsetPct = 50,
    // Optional keyframed crop. When present and non-empty, overrides the
    // static cropX/Y sliders for the live preview: the object-position
    // is computed from the active keyframe at each playback moment, so
    // what the user sees in preview matches what the burn will produce.
    cropKeyframes,
    // Legacy enum, kept for callers that haven't migrated. Ignored when
    // positionPct is provided.
    position,
    // PHASE 2 INTERACTIVE MODE — when interactive=true the subtitle
    // overlay becomes draggable/resizable/editable directly on the
    // preview, not just via sliders. Triggers are:
    //   • Click the subtitle  → select (shows handles)
    //   • Drag body            → vertical reposition (positionPct)
    //   • Drag bottom-right    → resize fontSize
    //   • Double-click         → inline text edit
    // The component is purely presentational about it: it tells the
    // parent via the callbacks below, and the parent updates state.
    // When omitted (Phase 1), the overlay stays pointer-events:none.
    interactive = false,
    onFontSizeChange,        // (newSize: number) => void
    onPositionChange,        // (newPositionPct: number) => void
    onTextChange,            // (segmentIndex: number, newText: string) => void
    // Image overlays — array of { id, dataUrl, name, start, end, xPct, yPct, widthPct }
    // and a setter so the preview can mutate (drop, drag-to-position,
    // resize). When undefined, drag-drop is disabled and no overlays
    // render. Backed by state at the parent so values persist across
    // phases.
    imageOverlays,
    setImageOverlays,
    // ─── Animation preview ─────────────────────────────────────────
    // Choose how the live preview renders subtitles. Drives the same
    // visual effect the backend burn pipeline produces, so what you
    // see here matches what gets baked into the mp4.
    //   'none'           → static text, no animation
    //   'pop'            → bouncy scale-in when each segment becomes
    //                       active (useful for TikTok / Reels style)
    //   'karaoke'        → each word lights up in highlightColor as
    //                       it's spoken (requires word-level timings)
    //   'word-highlight' → same per-word approach as karaoke; the
    //                       active word is colored, others stay
    //                       neutral (requires word-level timings)
    animation = 'none',
    highlightColor = '#FFDD00',
}) {
    const localRef = useRef(null);
    // Honour the parent's ref if one was supplied so they can call
    // .currentTime = X to seek the player from outside (e.g. clicking
    // a segment timestamp in the editor list).
    const videoRef = externalVideoRef || localRef;
    const [aspect, setAspect] = useState(9 / 16);
    // Active SEGMENT (full object) so we can render its words[] array
    // for word-by-word reveal — not just a flat text string. The
    // segment's words[] each carry start/end timestamps so we can
    // highlight whichever word is currently being spoken.
    const [activeSegment, setActiveSegment] = useState(null);
    const activeText = (activeSegment && activeSegment.text) || '';
    // Track current playback time for keyframe-driven crop AND for
    // word-by-word highlight inside the active segment.
    const [playbackTime, setPlaybackTime] = useState(0);

    // Phase-2 interactive overlay state.
    //   isSelected  — has the user clicked the subtitle? Shows handles.
    //   editing     — typing into the inline text field?
    //   editText    — buffer for the inline edit.
    //   drag        — { mode: 'move'|'resize-fs', startY, startX, startPos, startFs, containerH }
    const [isSelected, setIsSelected] = useState(false);
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState('');
    const [drag, setDrag] = useState(null);
    const containerRef = useRef(null);

    // Drag tracking — global pointer move/up so drags don't lose
    // tracking when the cursor leaves the subtitle bounds.
    useEffect(() => {
        if (!drag || !interactive) return;
        const onMove = (e) => {
            if (drag.mode === 'move' && typeof onPositionChange === 'function') {
                const dy = e.clientY - drag.startY;
                const dPct = (dy / Math.max(1, drag.containerH)) * 100;
                const next = Math.max(0, Math.min(100, drag.startPos + dPct));
                onPositionChange(next);
            } else if (drag.mode === 'resize-fs' && typeof onFontSizeChange === 'function') {
                // Diagonal drag: combine x+y movement so users can drag
                // the bottom-right handle naturally outward to grow.
                const dx = e.clientX - drag.startX;
                const dy = e.clientY - drag.startY;
                const delta = (dx + dy) / 8;  // 8px = 1 font unit, feels natural
                const next = Math.max(8, Math.min(120, drag.startFs + delta));
                onFontSizeChange(Math.round(next));
            }
        };
        const onUp = () => setDrag(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [drag, interactive, onPositionChange, onFontSizeChange]);

    // Find the index of the active segment so we can route inline-text
    // edits back to the right entry in the parent's segments array.
    const activeSegmentIdx = useMemo(() => {
        if (!activeSegment || !Array.isArray(segments)) return -1;
        return segments.findIndex((s) => s === activeSegment
            || (s && activeSegment && s.start === activeSegment.start && s.text === activeSegment.text));
    }, [activeSegment, segments]);

    // Click anywhere outside the overlay deselects.
    useEffect(() => {
        if (!isSelected || !interactive) return;
        const onDocClick = (e) => {
            const cont = containerRef.current;
            if (cont && !cont.contains(e.target)) setIsSelected(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [isSelected, interactive]);

    // Find which segment matches the current playback time. Bias by 50ms
    // so the lookup feels in-sync with how the eye reads.
    const handleTimeUpdate = () => {
        const v = videoRef.current;
        if (!v) return;
        // Track the raw playback time on every fire — the word-highlight
        // logic below needs sub-segment-level granularity.
        if (Math.abs(v.currentTime - playbackTime) > 0.04) {
            setPlaybackTime(v.currentTime);
        }
        const t = v.currentTime + 0.05;
        const segs = segments || [];
        let found = null;
        for (const s of segs) {
            const start = +s.start || 0;
            const end = +s.end || 0;
            if (t >= start && t <= end) {
                found = s;
                break;
            }
        }
        // Compare by reference + text since seg objects can be the same
        // reference across renders. setActiveSegment to null to clear.
        const prevText = activeSegment?.text || '';
        const nextText = found?.text || '';
        if (prevText !== nextText) {
            setActiveSegment(found);
        }
    };
    const handleLoadedMetadata = (e) => {
        const v = e.target;
        if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
    };

    // Build the same kind of CSS approximation Phase2Styling uses so a
    // single component covers both phases.
    const bw = Math.max(borderWidth, 0);
    const outlineShadow = bw > 0 ? [
        `-${bw}px -${bw}px 0 ${borderColor}`,
        `${bw}px -${bw}px 0 ${borderColor}`,
        `-${bw}px ${bw}px 0 ${borderColor}`,
        `${bw}px ${bw}px 0 ${borderColor}`,
        `0 -${bw}px 0 ${borderColor}`, `0 ${bw}px 0 ${borderColor}`,
        `-${bw}px 0 0 ${borderColor}`, `${bw}px 0 0 ${borderColor}`,
    ].join(', ') : 'none';
    // Compute the preview font-size in container-query units. The
    // backend ASS Fontsize is computed as `slider * video_h / 600`
    // — so the burn renders text at `slider/600` fraction of video
    // height. We want the preview to render at the SAME fraction of
    // the preview container's height, regardless of aspect ratio. The
    // `cqh` unit is exactly "1% of container height", so:
    //   preview text size = (slider / 6)cqh
    // That's 5.3cqh for slider=32 = 5.3% of preview height. Matches
    // burn's 5.3% of video frame height. Wrapped in clamp() so very
    // small previews (mobile, tiny modals) still produce readable
    // text and very large monitors don't blow it up to absurdity.
    const sliderVal = Number(fontSize) || 32;

    // PARITY WITH BURN — font fallback. The burn pipeline silently
    // substitutes free Linux fonts for proprietary ones (Impact ->
    // DejaVu Sans Condensed, Arial -> Liberation Sans, etc.). Without
    // this resolver the preview used the user's local Mac font (real
    // Impact, narrow), so when the burn substituted a wider font,
    // captions overflowed in the burn even though the preview looked
    // perfect. resolvePreviewFontFamily applies the SAME fallback chain
    // in CSS so what you see here is what the burn produces.
    const previewFontFamily = resolvePreviewFontFamily(fontFamily);

    // PARITY WITH BURN — overflow shrink. subtitles.py auto-shrinks
    // fontsize when the longest wrapped line would overflow the frame.
    // Without mirroring that math here, the preview rendered the user's
    // PICKED size while the burn shrunk it — preview big, burn small,
    // exactly what the user reported. We work in fictional 600-tall
    // video units (matching PREVIEW_REFERENCE_HEIGHT on the backend)
    // and use the target output frame's width. 'original' orientation
    // has no crop so we skip the shrink (source-native width is wider
    // than 9:16 and rarely overflows for typical Whisper segments).
    const _isCroppedForShrink = outputOrientation && outputOrientation !== 'original';
    let shrinkRatio = 1.0;
    if (_isCroppedForShrink) {
        const burnFontsizePx = Math.round(sliderVal * (1920 / 600));
        const longest = longestWrappedLineChars(segments);
        const burnFrameWidth = outputOrientation === 'horizontal'
            ? Math.round(1920 * (16 / 9))   // ~3413 px — almost never shrinks
            : Math.round(1920 * (9 / 16));  // 1080 px — common shrink case
        shrinkRatio = computeSafeShrinkRatio({
            requestedFontsize: burnFontsizePx,
            longestLineChars: longest,
            frameWidthUnits: burnFrameWidth,
            fontName: previewFontFamily,
        });
    }
    const cqhPct = (sliderVal / 6 * shrinkRatio).toFixed(2);
    const previewFontSize = `clamp(11px, ${cqhPct}cqh, 200px)`;
    const overlayStyle = {
        fontFamily: previewFontFamily,
        color: fontColor,
        fontSize: previewFontSize,
        fontWeight: 'bold',
        maxWidth: '92%',
        padding: '6px 12px',
        borderRadius: '4px',
        textAlign: 'center',
        lineHeight: '1.25',
        ...(bgOpacity > 0 ? {
            backgroundColor: `${bgColor}${Math.round(bgOpacity * 255).toString(16).padStart(2, '0')}`,
            textShadow: 'none',
        } : { textShadow: outlineShadow }),
    };
    // GAP-BLEED FIX: only show fallbackText (the styling-preview sample)
    // BEFORE any playback has happened. Once the video plays, gaps must
    // read as gaps — exactly how the burn renders them. Without this
    // gate, every sub-second silence between segments would re-render
    // the fallbackSample (first ~8 words of the transcript) and the
    // user saw stale text pop up "for no reason" during their pauses.
    // Reuses playbackTime state already tracked for keyframed crop.
    const hasStartedPlaying = playbackTime > 0.05;
    const text = activeText || (hasStartedPlaying ? '' : (fallbackText || '')) || '';
    // Don't pre-wrap with limitSubtitleLines anymore — that was
    // forcing a hard \n at 38 chars regardless of the chosen font
    // size, which meant lowering the slider didn't actually let
    // more text fit on one line. The CSS overlay below has a
    // maxWidth of 92% and `wordBreak: normal`, so the browser will
    // word-wrap the text as wide as it can. Result: at small
    // sizes a long segment fits on one line; at large sizes the
    // same text wraps to two. Exactly what the user expected.
    //
    // The burn-time pipeline still does its own splitting via
    // _split_long_segments + wrap_to_two_lines, so the rendered
    // mp4 keeps the 1-2-line rule. The preview just stops being
    // artificially conservative.
    const displayText = text;

    // Apply the user's orientation choice to the preview container.
    // When 'original' we use the auto-detected source aspect; when
    // 'vertical' or 'horizontal' we re-shape the box to the target
    // 9:16 / 16:9 aspect and switch the video to object-cover with
    // object-position driven by the X/Y offset sliders so the user
    // sees exactly what the burned mp4 will be cropped to.
    const isCropped = outputOrientation && outputOrientation !== 'original';
    const targetAspect = outputOrientation === 'vertical'
        ? 9 / 16
        : outputOrientation === 'horizontal'
            ? 16 / 9
            : aspect;

    // STEP 1 — figure out, in SOURCE coordinates (0..1), where the user
    // wants the centre of the crop window to be at this moment.
    //
    //   • slider mode: centre = cropX/Y as a fraction of the source
    //   • keyframe mode: piecewise function across the timeline. Same
    //     selection rule as reframe_kf.py — hold the previous keyframe's
    //     position until the next CUT (snap) or interpolate to the next
    //     PAN (smooth). The hard-cut behaviour is what the user clicks
    //     for and what the burn pipeline produces.
    let srcCenterX = Math.max(0, Math.min(1, (+cropXOffsetPct || 50) / 100));
    let srcCenterY = Math.max(0, Math.min(1, (+cropYOffsetPct || 50) / 100));
    const kfs = Array.isArray(cropKeyframes) ? cropKeyframes : [];
    if (isCropped && kfs.length > 0) {
        const sorted = [...kfs].sort((a, b) => (a.t || 0) - (b.t || 0));
        const t = playbackTime;
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        let pos;
        if (t <= (first.t || 0)) {
            pos = { x: first.x ?? 0.5, y: first.y ?? 0.5 };
        } else if (t >= (last.t || 0)) {
            pos = { x: last.x ?? 0.5, y: last.y ?? 0.5 };
        } else {
            pos = { x: first.x ?? 0.5, y: first.y ?? 0.5 };
            for (let i = 1; i < sorted.length; i++) {
                const a = sorted[i - 1];
                const b = sorted[i];
                const tA = a.t || 0;
                const tB = b.t || 0;
                if (t >= tA && t < tB) {
                    if (b.cut || tB - tA < 0.01) {
                        pos = { x: a.x ?? 0.5, y: a.y ?? 0.5 };
                    } else {
                        const u = (t - tA) / (tB - tA);
                        pos = {
                            x: (a.x ?? 0.5) + ((b.x ?? 0.5) - (a.x ?? 0.5)) * u,
                            y: (a.y ?? 0.5) + ((b.y ?? 0.5) - (a.y ?? 0.5)) * u,
                        };
                    }
                    break;
                }
            }
        }
        srcCenterX = Math.max(0, Math.min(1, pos.x ?? 0.5));
        srcCenterY = Math.max(0, Math.min(1, pos.y ?? 0.5));
    }

    // STEP 2 — convert source-coord crop centre to a CSS object-position
    // percentage. CRITICAL: object-fit:cover does NOT interpret
    // object-position:78% as "78% of source = visible centre". Under
    // cover, X% means "X% of source aligns with X% of container", which
    // gives a DIFFERENT visible centre. Without this conversion the
    // preview lies — clicking on the speaker placed them at the right
    // edge of the cropped frame instead of the centre, even though the
    // burn pipeline crops correctly.
    //
    // Derivation: with cover and source wider than target (the 9:16-
    // from-16:9 case), let r = sourceAspect / targetAspect (overflow
    // ratio in x). A given source-coord centre s maps to CSS coord
    //   c = (s*r - 0.5) / (r - 1)
    // clamped to [0, 1]. The endpoints work out:
    //   s = 0.5/r       -> c = 0  (left-most non-clamped position)
    //   s = 1 - 0.5/r   -> c = 1  (right-most non-clamped position)
    //   s = 0.5         -> c = 0.5 (centre stays centre)
    // For the y axis when the source is TALLER than target (16:9-from-
    // 9:16) the same formula applies symmetrically with r =
    // targetAspect / sourceAspect. When there's no overflow on an axis
    // (the dimension that fills exactly), object-position has no
    // visual effect and we just leave it at 50%.
    const sourceAspectSafe = aspect || 16 / 9;
    const rH = sourceAspectSafe / targetAspect;
    const rV = targetAspect / sourceAspectSafe;
    function srcToCss(s, r) {
        if (r <= 1.0001) return 0.5; // axis doesn't overflow -> CSS pos is moot
        const c = (s * r - 0.5) / (r - 1);
        return Math.max(0, Math.min(1, c));
    }
    const cssX = isCropped ? srcToCss(srcCenterX, rH) : 0.5;
    const cssY = isCropped ? srcToCss(srcCenterY, rV) : 0.5;
    const xPct = cssX * 100;
    const yPct = cssY * 100;
    const videoStyle = isCropped
        ? { objectPosition: `${xPct}% ${yPct}%` }
        : undefined;
    const videoClass = isCropped
        ? 'w-full h-full object-cover bg-black'
        : 'w-full h-full object-contain bg-black';

    // ─── Drag-and-drop image overlays ────────────────────────────────
    // When the user drags an image file from Finder/Explorer onto the
    // preview, we read it as a data URL, save into the parent's
    // imageOverlays state, and render it here on top of the video. The
    // overlay is positioned by xPct/yPct and sized by widthPct (height
    // auto from natural ratio). User can drag overlays around once
    // dropped. The overlay is also visible as a block on the timeline.
    const [dragOver, setDragOver] = useState(false);
    const onDropFile = useCallback(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (!setImageOverlays || typeof setImageOverlays !== 'function') return;
        const files = Array.from(e.dataTransfer?.files || []);
        const images = files.filter((f) => f.type.startsWith('image/'));
        if (!images.length) return;
        const v = videoRef?.current;
        const curT = v ? (v.currentTime || 0) : 0;
        const dur = v && v.duration && isFinite(v.duration) ? v.duration : 60;
        for (const file of images) {
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                const ov = {
                    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    name: file.name || 'image',
                    dataUrl,
                    start: curT,
                    end: Math.min(dur, curT + 5),  // 5s default duration
                    xPct: 50, yPct: 50,             // centred
                    widthPct: 30,                   // 30% of frame width
                };
                setImageOverlays((prev) => [...(prev || []), ov]);
            } catch {}
        }
    }, [setImageOverlays, videoRef]);
    const onDragOver = useCallback((e) => {
        if (!setImageOverlays) return;
        const hasFile = Array.from(e.dataTransfer?.types || []).includes('Files');
        if (!hasFile) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
    }, [setImageOverlays, dragOver]);
    const onDragLeave = useCallback((e) => {
        if (e.target === e.currentTarget) setDragOver(false);
    }, []);

    // Active overlays at the current time — shown on top of the video.
    const activeOverlays = useMemo(() => {
        if (!Array.isArray(imageOverlays) || imageOverlays.length === 0) return [];
        return imageOverlays.filter((ov) =>
            playbackTime >= (ov.start || 0) && playbackTime <= (ov.end || 0)
        );
    }, [imageOverlays, playbackTime]);

    return (
        <div
            className="rounded-xl border border-white/10 bg-black overflow-hidden relative w-full mx-auto max-h-[600px]"
            // containerType: 'size' makes this element a query container
            // for SIZE-based queries — required for cqh to resolve to a
            // % of THIS element's height. Without it, cqh falls back to
            // the viewport height, which would defeat the whole point.
            style={{
                aspectRatio: targetAspect, containerType: 'size',
                outline: dragOver ? '3px dashed #60a5fa' : 'none',
                outlineOffset: dragOver ? '-6px' : '0',
            }}
            onDrop={onDropFile}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
        >
            {/* Inline keyframe definitions for the animated subtitle
                templates. Scoped to global CSS but namespaced so they
                won't collide with anything else. */}
            <style>{`
                @keyframes klipra-pop-in {
                    0%   { opacity: 0; transform: scale(0.7); }
                    60%  { opacity: 1; transform: scale(1.08); }
                    100% { opacity: 1; transform: scale(1); }
                }
            `}</style>
            {videoUrl ? (
                <video
                    ref={videoRef}
                    src={videoUrl}
                    controls playsInline preload="metadata"
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={handleTimeUpdate}
                    onError={(e) => {
                        // Surface a real message when the video src
                        // can't load — most often happens when the
                        // backend's source-video file was cleaned up
                        // (disk-space reclaim) but the job record
                        // still exists. Without this the user sees a
                        // silent blank box and assumes the app broke.
                        const overlay = e?.currentTarget?.parentElement?.querySelector?.('[data-video-error]');
                        if (overlay) overlay.style.display = 'flex';
                        console.warn('[LiveSubtitleVideo] failed to load:', videoUrl);
                    }}
                    className={videoClass}
                    style={videoStyle}
                />
            ) : (
                <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs">
                    Source video preview unavailable
                </div>
            )}

            {/* Failed-to-load overlay — hidden by default, the video
                element's onError handler unhides this when the src
                404s (typically because the backend's source video
                file was cleaned up after a successful burn). Lets the
                user know the player isn't broken — the file is gone. */}
            <div
                data-video-error="1"
                style={{
                    display: 'none',
                    position: 'absolute', inset: 0,
                    background: 'rgba(0,0,0,0.85)',
                    color: 'rgba(255,255,255,0.85)',
                    alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'column', gap: 8, padding: 24,
                    textAlign: 'center', fontSize: 13, lineHeight: 1.4,
                    zIndex: 40,
                }}
            >
                <div style={{ fontWeight: 600 }}>Source video unavailable</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                    The backend cleaned up this project's original upload.
                    Subtitle data is still here — re-upload the same video to keep editing,
                    or download the burned mp4 from Past Projects.
                </div>
            </div>

            {/* IMAGE OVERLAYS — render any active overlays on top of
                the video. Each overlay is a draggable + resizable card.
                During playback only those whose [start, end] window
                contains the current time are shown. */}
            {activeOverlays.map((ov) => (
                <ImageOverlayItem
                    key={ov.id}
                    overlay={ov}
                    onUpdate={(patch) => {
                        setImageOverlays?.((prev) => (prev || []).map((p) =>
                            p.id === ov.id ? { ...p, ...patch } : p));
                    }}
                    onDelete={() => {
                        setImageOverlays?.((prev) => (prev || []).filter((p) => p.id !== ov.id));
                    }}
                />
            ))}

            {/* Drop hint — appears while a file is being dragged over
                the preview, so users know dropping will create an
                overlay. */}
            {dragOver && setImageOverlays && (
                <div
                    style={{
                        position: 'absolute', inset: 0,
                        background: 'rgba(96,165,250,0.12)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none', zIndex: 50,
                        color: 'white', fontWeight: 600, fontSize: 14,
                        textShadow: '0 1px 4px rgba(0,0,0,0.7)',
                    }}
                >
                    Drop image to add as overlay
                </div>
            )}

            {/* Smart vertical anchor for multi-line subtitles:
                  • positionPct ≤ 33   → "Top" anchor: positionPct sets
                    the TOP edge; subsequent lines flow downward.
                  • positionPct ≥ 67   → "Bottom" anchor: positionPct
                    sets the BOTTOM edge; lines stack upward.
                  • else                → "Middle": positionPct is the
                    vertical CENTER; lines distribute equally above and
                    below.
                This means the user's chosen Top/Middle/Bottom button
                actually anchors the subtitle that way regardless of
                line count — a 3-line subtitle with "Bottom" set
                doesn't overflow the bottom edge anymore. */}
            {displayText && (() => {
                const _pp = Math.max(0, Math.min(100, positionPct));
                const anchor = _pp <= 33 ? 'top' : (_pp >= 67 ? 'bottom' : 'middle');
                const yTransform = anchor === 'top'
                    ? 'translateY(0)'
                    : anchor === 'middle'
                        ? 'translateY(-50%)'
                        : 'translateY(-100%)';
                return (
                <div
                    ref={containerRef}
                    onPointerDown={(e) => {
                        // Only handle in interactive mode AND only when
                        // the down-press is on the overlay itself (not
                        // on the resize handle or input field).
                        if (!interactive) return;
                        if (e.target !== e.currentTarget && !e.target.dataset?.dragRoot) return;
                        // Capture the container height so the move handler
                        // can convert pixel-deltas to percent-of-frame.
                        const cont = containerRef.current?.parentElement;
                        const containerH = cont ? cont.clientHeight : 600;
                        setIsSelected(true);
                        setDrag({
                            mode: 'move',
                            startY: e.clientY, startX: e.clientX,
                            startPos: positionPct,
                            startFs: sliderVal,
                            containerH,
                        });
                    }}
                    onDoubleClick={(e) => {
                        if (!interactive) return;
                        if (typeof onTextChange !== 'function' || activeSegmentIdx < 0) return;
                        e.stopPropagation();
                        setIsSelected(true);
                        setEditing(true);
                        setEditText(activeSegment?.text || '');
                    }}
                    className={`absolute left-0 right-0 px-4 flex justify-center ${interactive ? 'cursor-grab' : 'pointer-events-none'}`}
                    style={{
                        top: `${_pp}%`,
                        // Apply the directional anchor — see comment
                        // above the IIFE for top/middle/bottom logic.
                        transform: yTransform,
                        ...(interactive && isSelected ? {
                            outline: '2px dashed rgba(96, 165, 250, 0.85)',
                            outlineOffset: 2,
                            borderRadius: 4,
                        } : {}),
                    }}
                >
                    {/* WORD-BY-WORD RENDER. If the active segment carries
                        word-level timings (BYOL or post-Sync), render
                        each word as its own <span> and highlight the
                        one whose [start, end] window contains the
                        current playback time. This matches what the
                        burn produces with the default 'word-highlight'
                        animation, so what the user sees in preview is
                        what they get in the burned mp4.

                        Falls back to the whole-line render when:
                          • the segment doesn't have a words[] array
                            (older sync-less projects), or
                          • the words array is empty.
                        That way the renderer is forwards-compatible
                        with both BYOL output and legacy transcripts. */}
                    {(() => {
                        // INTERACTIVE INLINE EDIT — when the user double-
                        // clicks the subtitle in Phase 2, render an
                        // <input> instead of the static <span>. Enter
                        // saves, Esc cancels. Blur saves too (matches
                        // typical editor expectations).
                        if (interactive && editing && activeSegmentIdx >= 0) {
                            return (
                                <input
                                    autoFocus
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            onTextChange?.(activeSegmentIdx, editText);
                                            setEditing(false);
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            setEditing(false);
                                        }
                                        e.stopPropagation();
                                    }}
                                    onBlur={() => {
                                        if (editText !== (activeSegment?.text || '')) {
                                            onTextChange?.(activeSegmentIdx, editText);
                                        }
                                        setEditing(false);
                                    }}
                                    style={{
                                        ...overlayStyle,
                                        background: 'rgba(0,0,0,0.7)',
                                        border: '2px solid rgba(96, 165, 250, 0.9)',
                                        outline: 'none',
                                        textAlign: 'center',
                                        width: 'min(80%, 700px)',
                                        whiteSpace: 'normal',
                                    }}
                                />
                            );
                        }
                        const wordList = activeSegment && Array.isArray(activeSegment.words)
                            ? activeSegment.words.filter((w) => w && (w.word || '').trim())
                            : [];
                        // Decide which animation path to render. Honour
                        // the `animation` prop if the user picked one.
                        // For karaoke / word-highlight we NEED word-
                        // level timings; without them, fall back to the
                        // pop animation so the user still sees motion.
                        const wantsPerWord = (animation === 'karaoke' || animation === 'word-highlight');
                        const canDoPerWord = wantsPerWord && wordList.length > 0;
                        // Pop = full-line scale-in / fade-in each time
                        // a NEW segment becomes active. We key the span
                        // off the active segment's start time so React
                        // remounts it on segment change, which retriggers
                        // the CSS animation.
                        if (animation === 'pop' || (wantsPerWord && !canDoPerWord)) {
                            const segKey = activeSegment ? `${activeSegment.start}-${activeSegment.text}` : 'empty';
                            return (
                                <span
                                    key={segKey}
                                    data-drag-root="1"
                                    style={{
                                        ...overlayStyle,
                                        whiteSpace: 'normal',
                                        wordBreak: 'normal',
                                        animation: 'klipra-pop-in 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
                                    }}
                                >
                                    {displayText}
                                </span>
                            );
                        }
                        // No animation OR per-word fallthrough not needed.
                        if (animation === 'none' || !canDoPerWord) {
                            return (
                                <span data-drag-root="1" style={{ ...overlayStyle, whiteSpace: 'normal', wordBreak: 'normal' }}>
                                    {displayText}
                                </span>
                            );
                        }
                        // Per-word render path (karaoke / word-highlight).
                        // Bias by 50ms so highlight feels in-sync with
                        // what the eye/ear are perceiving.
                        const t = (playbackTime || 0) + 0.05;
                        // The active word is the LAST one whose start
                        // is ≤ t. If t precedes all words, none are
                        // active yet (rare — happens at segment edges).
                        let activeWordIdx = -1;
                        for (let i = 0; i < wordList.length; i++) {
                            const ws = +wordList[i].start || 0;
                            if (ws <= t) activeWordIdx = i;
                            else break;
                        }
                        return (
                            <span
                                style={{
                                    ...overlayStyle,
                                    whiteSpace: 'normal',
                                    wordBreak: 'normal',
                                }}
                            >
                                {wordList.map((w, i) => {
                                    const isActive = i === activeWordIdx;
                                    // KARAOKE: active word + already-passed
                                    // words colored (sing-along sweep). Future
                                    // words stay neutral.
                                    // WORD-HIGHLIGHT: only the active word
                                    // colored; others stay neutral.
                                    let coloredNow = false;
                                    if (animation === 'karaoke') coloredNow = i <= activeWordIdx;
                                    else coloredNow = isActive; // 'word-highlight'
                                    return (
                                        <React.Fragment key={i}>
                                            <span
                                                style={{
                                                    color: coloredNow ? highlightColor : (overlayStyle.color || fontColor),
                                                    display: 'inline-block',
                                                    transform: isActive ? 'scale(1.08)' : 'scale(1)',
                                                    transition: 'color 120ms ease-out, transform 120ms ease-out',
                                                }}
                                            >
                                                {w.word}
                                            </span>
                                            {i < wordList.length - 1 ? ' ' : ''}
                                        </React.Fragment>
                                    );
                                })}
                            </span>
                        );
                    })()}

                    {/* PHASE 2 — bottom-right resize handle. Only visible
                        when interactive AND selected. Drag this corner
                        diagonally outward to grow the font, inward to
                        shrink. It positions itself inside the same
                        overlay container so it sits adjacent to the
                        subtitle text, scaling intuitively. */}
                    {interactive && isSelected && !editing && (
                        <div
                            onPointerDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                const cont = containerRef.current?.parentElement;
                                const containerH = cont ? cont.clientHeight : 600;
                                setDrag({
                                    mode: 'resize-fs',
                                    startY: e.clientY, startX: e.clientX,
                                    startPos: positionPct,
                                    startFs: sliderVal,
                                    containerH,
                                });
                            }}
                            title="Drag to resize subtitle font"
                            style={{
                                position: 'absolute',
                                right: -8,
                                bottom: -8,
                                width: 16,
                                height: 16,
                                background: '#60a5fa',
                                border: '2px solid white',
                                borderRadius: 8,
                                cursor: 'nwse-resize',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                            }}
                        />
                    )}

                    {/* Hint chip removed — the floating "Click to select"
                        message was intrusive when it crossed the
                        subtitle text region. Discoverability now lives
                        in the timeline footer below where it doesn't
                        obscure the video preview. */}
                </div>
                );
            })()}
        </div>
    );
}

// Single dropped-image overlay rendered on top of the LiveSubtitleVideo.
// Supports drag-to-position and corner-drag-to-resize. Click outside to
// deselect. The X button removes the overlay entirely.
function ImageOverlayItem({ overlay, onUpdate, onDelete }) {
    const [selected, setSelected] = useState(false);
    const [drag, setDrag] = useState(null);
    const containerW = useRef(0), containerH = useRef(0);
    const elRef = useRef(null);

    // Capture parent container dimensions once on first render so we
    // can convert pixel-deltas to percent-of-frame during drag.
    useEffect(() => {
        const el = elRef.current?.parentElement;
        if (el) {
            containerW.current = el.clientWidth || 1;
            containerH.current = el.clientHeight || 1;
        }
    }, []);

    useEffect(() => {
        if (!drag) return;
        const onMove = (e) => {
            const dxPct = ((e.clientX - drag.startX) / containerW.current) * 100;
            const dyPct = ((e.clientY - drag.startY) / containerH.current) * 100;
            if (drag.mode === 'move') {
                onUpdate({
                    xPct: Math.max(0, Math.min(100, drag.startX2 + dxPct)),
                    yPct: Math.max(0, Math.min(100, drag.startY2 + dyPct)),
                });
            } else if (drag.mode === 'resize') {
                onUpdate({
                    widthPct: Math.max(5, Math.min(100, drag.startWidth + dxPct)),
                });
            }
        };
        const onUp = () => setDrag(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [drag, onUpdate]);

    return (
        <div
            ref={elRef}
            onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setSelected(true);
                setDrag({
                    mode: 'move',
                    startX: e.clientX, startY: e.clientY,
                    startX2: overlay.xPct, startY2: overlay.yPct,
                });
            }}
            style={{
                position: 'absolute',
                left: `${overlay.xPct}%`,
                top: `${overlay.yPct}%`,
                width: `${overlay.widthPct}%`,
                transform: 'translate(-50%, -50%)',
                cursor: 'grab',
                outline: selected ? '2px dashed rgba(96,165,250,0.85)' : 'none',
                outlineOffset: 2,
                zIndex: 30,
            }}
        >
            <img
                src={overlay.dataUrl}
                alt={overlay.name || 'overlay'}
                draggable={false}
                style={{ display: 'block', width: '100%', height: 'auto', userSelect: 'none' }}
            />
            {selected && (
                <>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
                        title="Remove this overlay"
                        style={{
                            position: 'absolute', top: -10, right: -10,
                            width: 22, height: 22, borderRadius: 11,
                            background: '#ef4444', border: '2px solid white',
                            color: 'white', fontSize: 12, lineHeight: '18px',
                            cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                        }}
                    >×</button>
                    <div
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setDrag({
                                mode: 'resize',
                                startX: e.clientX, startY: e.clientY,
                                startWidth: overlay.widthPct,
                            });
                        }}
                        title="Drag to resize"
                        style={{
                            position: 'absolute', right: -8, bottom: -8,
                            width: 16, height: 16, borderRadius: 8,
                            background: '#60a5fa', border: '2px solid white',
                            cursor: 'nwse-resize', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                        }}
                    />
                </>
            )}
        </div>
    );
}


function SegmentsList({ segments, onEdit, onSeek, onSplit, onDelete }) {
    const fmt = (t) => {
        const total = Math.max(0, +t || 0);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    };
    // Each segment's text is now an inline editable field. Edits flow
    // back to the parent via onEdit(index, newText). Timings stay the
    // same — only the text changes — so the burn step can apply per-line
    // fixes without touching the aligned timings from Sync.
    //
    // We use <textarea> rather than <input type="text"> so long
    // segments wrap inside the column instead of overflowing horizontally
    // (the previous behaviour required scrubbing the cursor right just
    // to read the rest of the line). The textarea auto-grows by lines
    // via the AutoGrowTextarea wrapper below.
    //
    // CLICK-TO-JUMP: clicking the timestamp OR focusing the text input
    // seeks the preview player to the segment's start. This makes
    // "I want to fix THIS line" workflow instant — click → hear → edit
    // — instead of scrubbing the player manually first.
    //
    // SPLIT (+) and DELETE (trash) buttons let the user reshape the
    // segment list itself: split a long line into two captions, or
    // drop one entirely if Whisper hallucinated it. Edits stay local
    // to the row's start/end times — neighbours aren't touched.
    return (
        <div className="bg-black/40 border border-white/10 rounded-md max-h-[420px] overflow-y-auto custom-scrollbar divide-y divide-white/5">
            {segments.map((s, i) => (
                <div key={i} className="px-3 py-2 flex gap-3 text-[12px] items-start min-w-0 group">
                    <button
                        type="button"
                        onClick={() => onSeek?.(s.start)}
                        className="font-mono text-zinc-500 hover:text-emerald-300 shrink-0 tabular-nums pt-1.5 cursor-pointer transition text-left"
                        title="Jump player to this segment"
                    >
                        {fmt(s.start)} → {fmt(s.end)}
                    </button>
                    <AutoGrowTextarea
                        value={s.text}
                        onChange={(v) => onEdit?.(i, v)}
                        onFocus={() => onSeek?.(s.start)}
                    />
                    {/* Per-row controls. Visible at low contrast by
                        default, brighten on group-hover so they don't
                        compete with the text but are still discoverable
                        at a glance. */}
                    <div className="flex items-center gap-0.5 shrink-0 pt-1 opacity-50 group-hover:opacity-100 transition">
                        <button
                            type="button"
                            onClick={() => onSplit?.(i)}
                            title="Split this segment into two captions at the middle"
                            className="p-1 rounded text-zinc-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition"
                        >
                            <Plus size={13} />
                        </button>
                        <button
                            type="button"
                            onClick={() => onDelete?.(i)}
                            title="Delete this segment"
                            className="p-1 rounded text-zinc-400 hover:text-red-300 hover:bg-red-500/10 transition"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}

/**
 * Textarea that auto-grows to fit its content height. We can't rely on
 * `field-sizing: content` (still not Safari-supported) so we measure
 * scrollHeight on every change and apply it as a style. The flex
 * container above sets `min-w-0` so the textarea actually shrinks to
 * fit the column instead of forcing horizontal overflow.
 */
function AutoGrowTextarea({ value, onChange, onFocus }) {
    const ref = useRef(null);
    const resize = () => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    };
    useEffect(resize, [value]);
    return (
        <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            onFocus={onFocus}
            spellCheck="false"
            rows={1}
            className="flex-1 min-w-0 w-full resize-none bg-transparent border border-transparent rounded-md px-2 py-1 text-zinc-200 leading-relaxed overflow-hidden break-words
                       hover:border-white/10 focus:border-emerald-500/40 focus:bg-black/40 focus:outline-none transition"
        />
    );
}

function Phase2Styling(p) {
    // Live preview reuses LiveSubtitleVideo so the user sees the EXACT
    // timed transcript playing on the EXACT source video with their
    // current style choices.
    //
    // FONT-SIZE FIX: previously the slider was rendered as fixed CSS
    // pixels in the preview, but the preview's actual rendered height
    // varies with the source aspect ratio (a 16:9 source produces a
    // ~340-tall preview, a 9:16 source produces a 600-tall preview).
    // Meanwhile the BURN scales by video_h/600 — perfectly correct,
    // but only matches the preview when the preview happens to be 600
    // tall too. On a horizontal source the preview was 1.7× the burn
    // proportion, so users picking 32 saw a giant preview but the
    // burn came out at the actual ~5% of frame.
    //
    // We now hand the raw slider value to LiveSubtitleVideo and let
    // CSS container-query units drive the preview text size — that
    // way preview text size is ALWAYS the same fraction of preview
    // height as the burned text is of video height. Identical
    // proportions in every aspect.
    const [reframeModalOpen, setReframeModalOpen] = useState(false);
    // Map orientation -> target aspect for the keyframe modal so the
    // preview crop overlay matches what the burn will actually cut out.
    const targetAspect =
        p.outputOrientation === 'horizontal' ? 16 / 9 : 9 / 16;
    const kfCount = (p.cropKeyframes || []).length;
    // Apply the manual time-shift to the preview segments so the user
    // sees their adjustment reflected immediately. Burn-time the same
    // offset is sent to the backend (StandaloneBurnRequest.time_offset_seconds).
    const _shift = Number(p.timeOffsetSeconds || 0);
    const shiftedSegments = Math.abs(_shift) > 0.01
        ? (p.segments || []).map((s) => ({
              ...s,
              start: Math.max(0, (Number(s.start) || 0) + _shift),
              end: Math.max(0.05, (Number(s.end) || 0) + _shift),
              words: Array.isArray(s.words)
                  ? s.words.map((w) => ({
                        ...w,
                        start: Math.max(0, (Number(w.start) || 0) + _shift),
                        end: Math.max(0.05, (Number(w.end) || 0) + _shift),
                    }))
                  : s.words,
          }))
        : p.segments;
    return (
        <div className="space-y-4">
            {/* BACK TO PHASE 1 — visible button so the user can return
                to subtitle editing without losing work. The onBack
                prop is wired all the way back to the parent's
                setPhase(1). State (segments, position, fontSize,
                etc.) is preserved across the navigation. */}
            {typeof p.onBack === 'function' && (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <button
                        onClick={p.onBack}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-[12px] transition"
                        title="Go back to Step 2 (Fix Subtitles) to keep editing the transcript. Your styling choices on this page are preserved."
                    >
                        <ChevronLeft size={14} /> Back to Fix Subtitles
                    </button>
                    <span className="text-[11px] text-zinc-500">
                        Tip: edits to the transcript can be made in Step 2.
                    </span>
                </div>
            )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <LiveSubtitleVideo
                videoUrl={p.videoUrl}
                segments={shiftedSegments}
                fallbackText={p.fallbackSample}
                fontFamily={p.fontName}
                fontColor={p.fontColor}
                fontSize={p.fontSize}
                bgColor={p.bgColor}
                bgOpacity={p.bgOpacity}
                borderColor={p.borderColor}
                borderWidth={p.borderWidth}
                positionPct={p.positionPct}
                outputOrientation={p.outputOrientation}
                cropXOffsetPct={p.cropXOffsetPct}
                cropYOffsetPct={p.cropYOffsetPct}
                cropKeyframes={p.cropKeyframes}
                // Animation preview — these mirror the burn pipeline.
                animation={p.animation}
                highlightColor={p.highlightColor}
                // PHASE 2 INTERACTIVE — click subtitle to select, drag
                // body to reposition, drag bottom-right corner to
                // resize font, double-click to edit text. Edits flow
                // back to the parent's font/position state and the
                // segments array (via setSegments).
                interactive={true}
                onFontSizeChange={(n) => p.setFontSize?.(n)}
                onPositionChange={(n) => p.setPositionPct?.(n)}
                onTextChange={(idx, txt) => {
                    if (typeof p.setSegments !== 'function' || !Array.isArray(p.segments)) return;
                    if (idx < 0 || idx >= p.segments.length) return;
                    const next = p.segments.map((s, i) => i === idx ? { ...s, text: txt } : s);
                    p.setSegments(next);
                }}
            />

            {/* Style controls */}
            <div className="space-y-3 overflow-y-auto custom-scrollbar pr-1 max-h-[600px]">
                {/* APPLY SCOPE — toggle between "Apply to all" and
                    "Apply to selected only". When 'all', picking a
                    template overwrites the global styling state (the
                    classic behaviour that drives the burn pipeline).
                    When 'selected', the styling is stored on the
                    individual segment as `_style`, and the live preview
                    renders that override. The burn pipeline still
                    needs multi-style ASS support to actually burn
                    per-segment styling — that's a separate backend
                    task. For now 'selected only' is preview-honest. */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2 text-[11px]">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold">
                        Apply template to
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <label className={'flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition '
                            + ((p.applyScope || 'all') === 'all'
                                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100'
                                : 'border-white/10 bg-black/20 text-zinc-300 hover:border-white/30')}>
                            <input
                                type="radio"
                                name="apply-scope"
                                checked={(p.applyScope || 'all') === 'all'}
                                onChange={() => p.setApplyScope?.('all')}
                                className="mt-0.5"
                            />
                            <div className="leading-tight">
                                <div className="font-semibold">All subtitles</div>
                                <div className="text-[10px] text-zinc-400 mt-0.5">Picking a template restyles every line. Standard mode.</div>
                            </div>
                        </label>
                        <label className={'flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition '
                            + (p.applyScope === 'selected'
                                ? 'border-blue-500/50 bg-blue-500/10 text-blue-100'
                                : 'border-white/10 bg-black/20 text-zinc-300 hover:border-white/30')}>
                            <input
                                type="radio"
                                name="apply-scope"
                                checked={p.applyScope === 'selected'}
                                onChange={() => p.setApplyScope?.('selected')}
                                className="mt-0.5"
                            />
                            <div className="leading-tight">
                                <div className="font-semibold">Selected subtitle only</div>
                                <div className="text-[10px] text-zinc-400 mt-0.5">Click a line on the timeline first, then pick a template — only that one gets the new look.</div>
                            </div>
                        </label>
                    </div>
                </div>

                {/* Templates picker. One-click into a curated look
                    (free), or upload a .ass styling preset from any
                    NLE. Pro templates are visible-but-locked for
                    free users — that's the conversion lever. */}
                <SubtitleTemplatesPicker
                    activeStyling={{
                        fontName: p.fontName,
                        fontSize: p.fontSize,
                        fontColor: p.fontColor,
                        borderColor: p.borderColor,
                        borderWidth: p.borderWidth,
                        bgColor: p.bgColor,
                        bgOpacity: p.bgOpacity,
                        positionPct: p.positionPct,
                    }}
                    onApply={p.onApplyTemplate}
                    currentUser={p.currentUser}
                    onUpgradeClick={p.onUpgradeClick}
                />

                {/* Step 3 is purely visual styling. Lyrics import,
                    time-shift, and alignment moved up to Step 2 (Fix
                    subtitles). By the time the user lands here the
                    subtitle TEXT and TIMING are locked. */}

                {/* Manual time-shift — applies to ALL subtitle segments.
                    Lives near the top of the controls because it's the
                    most-used escape hatch when automatic alignment
                    isn't quite right (especially for BYOL / translated
                    content where Sync can't run). The slider applies
                    its offset live to the preview, so the user can
                    drag and watch the subtitles slide forward / back
                    in real time. */}
                <Section
                    title="⏱️ Time-shift subtitles"
                    subtitle="Drag this if your subtitles start a few seconds before or after the audio. Negative pulls them earlier; positive delays them. Live preview updates as you drag — re-burn applies the final value."
                >
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => p.setTimeOffsetSeconds(0)}
                                className="px-2 py-1 rounded-md border border-white/10 bg-black/30 text-zinc-300 hover:border-white/30 text-[10px]"
                                title="Reset to 0 (no shift)"
                            >
                                Reset
                            </button>
                            <input
                                type="range"
                                min="-30"
                                max="30"
                                step="0.1"
                                value={Number(p.timeOffsetSeconds || 0)}
                                onChange={(e) => p.setTimeOffsetSeconds(parseFloat(e.target.value))}
                                className="flex-1 accent-primary"
                            />
                            <input
                                type="number"
                                min="-60"
                                max="60"
                                step="0.1"
                                value={Number(p.timeOffsetSeconds || 0)}
                                onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (Number.isFinite(v)) p.setTimeOffsetSeconds(Math.max(-60, Math.min(60, v)));
                                }}
                                className="w-16 bg-black/40 border border-white/10 rounded-md py-1 px-1.5 text-xs text-white text-center focus:outline-none focus:border-primary/50"
                            />
                            <span className="text-[10px] text-zinc-500 w-3">s</span>
                        </div>
                        <div className="flex justify-between text-[10px] text-zinc-500">
                            <span>← Earlier (−30s)</span>
                            <span>{Number(p.timeOffsetSeconds || 0) === 0 ? 'No shift' : `${(p.timeOffsetSeconds || 0) > 0 ? '+' : ''}${Number(p.timeOffsetSeconds || 0).toFixed(1)}s`}</span>
                            <span>Later (+30s) →</span>
                        </div>
                    </div>
                </Section>

                <Section title="Output orientation" subtitle="Crop the final video to a vertical or horizontal shape — useful for posting straight to TikTok, Reels, or YouTube Shorts. 'Original' keeps the source aspect untouched.">
                    <div className="grid grid-cols-3 gap-2 mb-3">
                        {[
                            { id: 'original', label: 'Original', sub: 'Keep source aspect' },
                            { id: 'vertical', label: 'Vertical 9:16', sub: 'TikTok / Reels' },
                            { id: 'horizontal', label: 'Horizontal 16:9', sub: 'YouTube / Web' },
                        ].map(({ id, label, sub }) => {
                            const active = (p.outputOrientation || 'original') === id;
                            return (
                                <button
                                    key={id}
                                    onClick={() => p.setOutputOrientation(id)}
                                    className={`py-2 px-2 rounded-md border text-xs font-medium text-left transition ${active ? 'bg-primary/15 text-primary border-primary/40' : 'bg-black/30 text-zinc-300 border-white/10 hover:border-white/20'}`}
                                >
                                    <div>{label}</div>
                                    <div className="text-[9px] text-zinc-500 normal-case mt-0.5">{sub}</div>
                                </button>
                            );
                        })}
                    </div>
                    {/* Reframe slider — only meaningful when actually
                        cropping. For 'vertical' on a wider source, we
                        crop horizontally → x offset matters. For
                        'horizontal' on a taller source, we crop
                        vertically → y offset matters. We surface BOTH
                        sliders so the user can adjust whichever applies
                        without us having to detect source aspect on
                        the frontend. */}
                    {p.outputOrientation && p.outputOrientation !== 'original' && (
                        <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-3">
                            <div className="text-[10px] text-zinc-400 leading-relaxed">
                                <strong className="text-zinc-200">Reframe:</strong> if the auto-crop misses the important part of the frame, slide to shift the crop window — or set keyframes below to track a moving subject.
                            </div>
                            {/* The static X/Y sliders are disabled while
                                keyframes are set: the burn will pan/cut
                                through the keyframes instead, so the
                                sliders would be misleading. Clearing all
                                keyframes (in the modal or via the button
                                below) re-enables them. */}
                            <div className={kfCount > 0 ? 'opacity-40 pointer-events-none' : ''}>
                                <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                                    <span>Horizontal position (left ↔ right)</span>
                                    <span className="tabular-nums text-zinc-200">{Math.round(p.cropXOffsetPct ?? 50)}%</span>
                                </label>
                                <input
                                    type="range" min={0} max={100} step={1}
                                    value={p.cropXOffsetPct ?? 50}
                                    onChange={(e) => p.setCropXOffsetPct(parseInt(e.target.value, 10))}
                                    className="w-full accent-primary"
                                    disabled={kfCount > 0}
                                />
                            </div>
                            <div className={kfCount > 0 ? 'opacity-40 pointer-events-none' : ''}>
                                <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                                    <span>Vertical position (top ↔ bottom)</span>
                                    <span className="tabular-nums text-zinc-200">{Math.round(p.cropYOffsetPct ?? 50)}%</span>
                                </label>
                                <input
                                    type="range" min={0} max={100} step={1}
                                    value={p.cropYOffsetPct ?? 50}
                                    onChange={(e) => p.setCropYOffsetPct(parseInt(e.target.value, 10))}
                                    className="w-full accent-primary"
                                    disabled={kfCount > 0}
                                />
                            </div>
                            <div className="text-[10px] text-zinc-500">
                                Whichever axis the source needs to crop along (horizontal for a 9:16 from a 16:9 source, vertical for a 16:9 from a 9:16 source) is what the slider actually moves — the other one becomes a no-op.
                            </div>
                            {/* Keyframed reframe entry point. Opens the
                                same kind of click-to-place editor used by
                                the clip-generation flow, but adapted to
                                run on the FULL video (no clip window). */}
                            <div className="pt-2 mt-1 border-t border-white/5 flex items-center justify-between gap-3 flex-wrap">
                                <div className="text-[10px] text-zinc-400 leading-relaxed">
                                    <strong className="text-zinc-200">Track a moving subject:</strong> drop hard-cut keyframes so the crop window follows your speaker around the frame.
                                    {kfCount > 0 && (
                                        <span className="ml-1 inline-flex items-center gap-1 text-cyan-300">
                                            · {kfCount} keyframe{kfCount === 1 ? '' : 's'} set
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {kfCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => p.setCropKeyframes([])}
                                            className="text-[11px] px-2 py-1 rounded border border-white/10 text-zinc-300 hover:border-white/20 hover:text-white"
                                            title="Remove all keyframes and revert to the X/Y sliders"
                                        >
                                            Clear keyframes
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setReframeModalOpen(true)}
                                        className="text-[11px] px-3 py-1 rounded bg-gradient-to-r from-indigo-500 to-cyan-500 text-white font-semibold shadow"
                                    >
                                        {kfCount > 0 ? 'Edit keyframes' : 'Set keyframes'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </Section>

                {/* Keyframe editor modal. Lives at the Phase2Styling
                    root so its click-outside-to-close doesn't fight the
                    surrounding card. Only mounted when open so the
                    underlying <video> doesn't stay loaded in memory. */}
                {reframeModalOpen && (
                    <StandaloneReframeKeyframeModal
                        videoUrl={p.videoUrl}
                        targetAspect={targetAspect}
                        initialKeyframes={p.cropKeyframes || []}
                        onClose={() => setReframeModalOpen(false)}
                        onSave={(kfs) => {
                            p.setCropKeyframes(kfs);
                            setReframeModalOpen(false);
                        }}
                    />
                )}

                <Section title="Vertical position" subtitle="Slide to fine-tune where the subtitle sits on the frame.">
                    {/* Three quick-jump shortcuts so the user doesn't
                        have to hunt for the common "near top / middle /
                        near bottom" presets, but the slider in between
                        gives full freedom. */}
                    <div className="grid grid-cols-3 gap-2 mb-3">
                        {[
                            { label: 'Top', pct: 8 },
                            { label: 'Middle', pct: 50 },
                            { label: 'Bottom', pct: 86 },
                        ].map(({ label, pct }) => {
                            const active = Math.abs((p.positionPct ?? 86) - pct) < 3;
                            return (
                                <button
                                    key={label}
                                    onClick={() => p.setPositionPct(pct)}
                                    className={`py-2 rounded-md text-xs font-medium border transition ${active ? 'bg-primary/15 text-primary border-primary/40' : 'bg-black/30 text-zinc-300 border-white/10 hover:border-white/20'}`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                    <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                        <span>Position from top</span>
                        <span className="tabular-nums text-zinc-200">{Math.round(p.positionPct ?? 86)}%</span>
                    </label>
                    <input
                        type="range" min={0} max={100} step={1}
                        value={p.positionPct ?? 86}
                        onChange={(e) => p.setPositionPct(parseInt(e.target.value, 10))}
                        className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-[9px] text-zinc-600 mt-1 px-0.5">
                        <span>Top</span><span>Middle</span><span>Bottom</span>
                    </div>
                </Section>

                <Section title="Font">
                    <select value={p.fontName} onChange={(e) => p.setFontName(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-md py-2 px-2.5 text-xs text-white focus:outline-none focus:border-primary/50 mb-3">
                        {['Verdana', 'Arial', 'Impact', 'Helvetica', 'Georgia', 'Courier New', 'Times New Roman', 'Comic Sans MS'].map(f => (
                            // Render each option in the SAME resolved
                            // fallback chain the preview + burn use, so
                            // the dropdown is honest about what each
                            // pick will look like.
                            <option key={f} value={f} style={{ fontFamily: resolvePreviewFontFamily(f) }}>{f}</option>
                        ))}
                    </select>
                    <label className="text-[10px] text-zinc-400 flex items-center justify-between mb-1">
                        <span>Size</span><span className="tabular-nums text-zinc-200">{p.fontSize}px</span>
                    </label>
                    {/* Range tuned for the new "preview CSS pixels"
                        slider semantic: 14 = small, 32 = comfortable
                        viral default, 72 = oversized chunky meme caption.
                        The backend scales these up by video_h/600 so
                        the burned mp4 matches what the preview shows. */}
                    <input type="range" min={14} max={72} step={1} value={p.fontSize}
                        onChange={(e) => p.setFontSize(+e.target.value)} className="w-full accent-primary" />
                </Section>

                <Section title="Text color">
                    <ColorRow value={p.fontColor} onChange={p.setFontColor} />
                </Section>

                <Section title="Outline / border">
                    <ColorRow value={p.borderColor} onChange={p.setBorderColor} />
                    <label className="mt-3 text-[10px] text-zinc-400 flex items-center justify-between">
                        <span>Border width</span><span className="tabular-nums text-zinc-200">{p.borderWidth}px</span>
                    </label>
                    <input type="range" min={0} max={8} step={1} value={p.borderWidth}
                        onChange={(e) => p.setBorderWidth(+e.target.value)} className="w-full accent-primary" />
                </Section>

                <Section title="Background box">
                    <label className="flex items-center gap-2 mb-3 cursor-pointer">
                        <input type="checkbox" checked={p.bgOpacity > 0}
                            onChange={(e) => p.setBgOpacity(e.target.checked ? 0.6 : 0)}
                            className="h-4 w-4 accent-primary" />
                        <span className="text-xs text-zinc-300">Show background box behind text</span>
                    </label>
                    {p.bgOpacity > 0 && (
                        <>
                            <ColorRow value={p.bgColor} onChange={p.setBgColor} />
                            <label className="mt-3 text-[10px] text-zinc-400 flex items-center justify-between">
                                <span>Box opacity</span><span className="tabular-nums text-zinc-200">{Math.round(p.bgOpacity * 100)}%</span>
                            </label>
                            <input type="range" min={10} max={100} step={5}
                                value={Math.round(p.bgOpacity * 100)}
                                onChange={(e) => p.setBgOpacity(parseInt(e.target.value, 10) / 100)}
                                className="w-full accent-primary" />
                        </>
                    )}
                </Section>

                {p.error && (
                    <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300">
                        <AlertCircle size={12} className="mt-0.5 shrink-0" />
                        {p.error}
                    </div>
                )}

                {/* Three-way action row:
                    • Back — return to Phase 1 to keep editing transcript.
                    • Save for later — snapshot current state as a draft
                      and exit. Reopen from Past Projects when ready.
                    • Burn subtitles — final render to mp4. */}
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    <button onClick={p.onBack}
                        className="px-4 py-2.5 rounded-xl border border-white/15 text-zinc-300 hover:bg-white/5 text-sm flex items-center justify-center gap-2">
                        <RotateCcw size={14} /> Back
                    </button>
                    {p.onSaveDraft && (
                        <button onClick={p.onSaveDraft}
                            className="px-4 py-2.5 rounded-xl border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-blue-100 text-sm flex items-center justify-center gap-2"
                            title="Save the project so you can come back and finish styling / burning later">
                            <Check size={14} /> Save for later
                        </button>
                    )}
                    <button onClick={p.onBurn}
                        className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-black font-bold text-sm flex items-center justify-center gap-2">
                        <Type size={14} /> Burn subtitles
                    </button>
                </div>
            </div>
        </div>
        </div>
    );
}

function ColorRow({ value, onChange }) {
    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 w-28 shrink-0">
                <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
                    className="w-6 h-6 cursor-pointer rounded bg-transparent border-0" />
                <span className="text-[11px] font-mono text-zinc-300 uppercase">{value}</span>
            </div>
            <div className="flex flex-wrap gap-1 flex-1">
                {COLOR_PRESETS.map((c) => (
                    <button key={c} type="button" onClick={() => onChange(c)}
                        className={'w-6 h-6 rounded-md border transition ' + (value.toUpperCase() === c.toUpperCase() ? 'border-white' : 'border-white/10 hover:border-white/40')}
                        style={{ backgroundColor: c }} title={c} />
                ))}
            </div>
        </div>
    );
}

function RunningPanel({ logs, status, accent }) {
    const colorClass = accent === 'orange' ? 'text-orange-400' : 'text-emerald-400';
    return (
        <div className="rounded-2xl border border-white/10 bg-surface/40 p-6 text-center">
            <Loader2 size={28} className={`${colorClass} animate-spin mx-auto mb-3`} />
            <div className="text-sm font-medium text-white capitalize">{(status || 'processing').replace('_', ' ')}…</div>
            <div className="mt-4 max-h-40 overflow-y-auto text-left text-[11px] font-mono text-zinc-400 space-y-1">
                {(logs || []).slice(-10).map((l, i) => <div key={i}>{l}</div>)}
            </div>
        </div>
    );
}

function ResultPanel({ videoUrl, jobId, onAgain, onRetranslate, currentTargetLang, onDubVoice, onBackgroundChanged, onTweakStyle }) {
    // Result video preserves the input's aspect ratio (FFmpeg burn step
    // doesn't apply scale/crop). Use object-contain so wide / square /
    // tall outputs all display naturally without forced letterboxing.
    //
    // RE-TRANSLATE: a saved subtitle project carries its raw Whisper
    // checkpoint, so re-running AI cleanup with mode='translate' to a
    // different language is essentially free (~10 seconds of LLM,
    // versus the 10-15 minutes of fresh transcription that starting
    // over would take). The picker below exposes that flow without
    // making the user understand what "regenerate" means.
    const [showLangs, setShowLangs] = useState(false);
    const [showBgPanel, setShowBgPanel] = useState(false);
    return (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center space-y-4">
            <Check size={28} className="text-emerald-400 mx-auto" />
            <h3 className="text-lg font-bold text-white">Your subtitled video is ready</h3>
            <video src={getApiUrl(videoUrl)} controls playsInline preload="metadata"
                className="w-full max-h-[500px] mx-auto rounded-xl bg-black object-contain" />
            <div className="flex gap-3 justify-center flex-wrap">
                {/* TWEAK STYLE & RE-BURN — undo path for "I don't like
                    this look". Sends the user back to Phase 2 with all
                    their styling state preserved (font, position, size,
                    template choice, animation). Subtitles + edits are
                    untouched. They tweak, re-click Burn, get a fresh
                    mp4. Same source video, same transcript, just a
                    different look. */}
                {typeof onTweakStyle === 'function' && (
                    <button
                        onClick={onTweakStyle}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-blue-500/40 bg-blue-500/10 text-blue-100 hover:bg-blue-500/20 text-sm font-bold transition"
                        title="Don't like the result? Go back to styling, change template / font / position, and re-burn. Your subtitles and edits stay intact."
                    >
                        <ChevronLeft size={14} /> Tweak style & re-burn
                    </button>
                )}
                <a href={getApiUrl(videoUrl)} download
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-lime-600 text-white font-bold text-sm">
                    <Download size={14} /> Download
                </a>
                {/* Export the SRT for use in another tool / project. The
                    backend renders the cached transcript on demand; no
                    file is pre-generated, so this is always live. */}
                {jobId && (
                    <a href={getApiUrl(`/api/standalone/subtitle/${jobId}/srt`)} download
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20 text-sm font-bold"
                        title="Download .srt — use it in another video editor or import into a new Klipra project to skip transcription.">
                        <Download size={14} /> Export .srt
                    </a>
                )}
                {/* Change Background — re-burns the same subtitles on a
                    new video / stock pattern. Critical for the song
                    workflow: upload vocals → get clean subs → swap to
                    full song video. */}
                {jobId && onBackgroundChanged && (
                    <button
                        onClick={() => setShowBgPanel((v) => !v)}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-100 hover:bg-violet-500/20 text-sm font-bold"
                        title="Re-burn these subtitles on a different background. If you upload a video with audio, that audio replaces what was used for transcription."
                    >
                        🎨 Change background
                    </button>
                )}
                {onRetranslate && (
                    <button
                        onClick={() => setShowLangs((v) => !v)}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-blue-500/40 bg-blue-500/10 text-blue-100 hover:bg-blue-500/20 text-sm font-bold"
                    >
                        <Wand2 size={14} /> Recreate in another language
                    </button>
                )}
                {/* Cross-product hand-off — sends the user to Voice
                    Dubbing with this subtitle job's saved transcript
                    pre-loaded. The dub backend reuses the checkpoint
                    so no re-transcription is needed. */}
                {onDubVoice && (
                    <button
                        onClick={onDubVoice}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-sm font-bold"
                        title="Dub the SAME video with an AI voice in another language. Uses the transcript already saved here, so no re-transcription."
                    >
                        <Volume2 size={14} /> Dub voice
                    </button>
                )}
                <button onClick={onAgain}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/15 text-zinc-200 hover:bg-white/5 text-sm">
                    <RotateCcw size={14} /> Do another
                </button>
            </div>
            {showBgPanel && jobId && onBackgroundChanged && (
                <BackgroundChangePanel
                    jobId={jobId}
                    onClose={() => setShowBgPanel(false)}
                    onChanged={(newUrl) => {
                        setShowBgPanel(false);
                        onBackgroundChanged(newUrl);
                    }}
                />
            )}
            {showLangs && onRetranslate && (
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 text-left space-y-3">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-blue-200 font-bold">
                        <Wand2 size={12} /> Recreate this video
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                        We'll re-run AI against the saved transcript — no re-transcription, no re-upload. Pick a target and you'll land on the Phase 1 editor so you can review before re-burning.
                    </p>

                    {/* Roman / Latin transliteration — keeps the same
                        spoken language but rewrites it in Roman script.
                        Useful when the original transcript came out
                        in Urdu / Hindi / Arabic / Devanagari script
                        and the user wants the Roman-script version
                        (Roman Urdu, Hinglish, etc.) instead. */}
                    <div>
                        <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-300 mb-1.5">
                            Transliterate (same language, different script)
                        </div>
                        <button
                            onClick={() => { setShowLangs(false); onRetranslate('roman'); }}
                            className="w-full px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-400/50 text-[11px] text-left transition"
                            title="Rewrite the transcript in Roman/Latin script (Roman Urdu, Hinglish, Romaji, etc.) — same words, different alphabet."
                        >
                            <div className="font-bold">Roman / Latin script</div>
                            <div className="text-[10px] text-zinc-400 mt-0.5 leading-snug">Roman Urdu · Hinglish · Romaji · pinyin — keeps the speaker's words, just in Latin letters.</div>
                        </button>
                    </div>

                    <div>
                        <div className="text-[10px] uppercase tracking-wider font-bold text-blue-300 mb-1.5">
                            Translate to a different language
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                            {TARGET_LANGS.map(([code, label]) => {
                                const active = code === currentTargetLang;
                                return (
                                    <button
                                        key={code}
                                        onClick={() => { setShowLangs(false); onRetranslate('translate', code); }}
                                        disabled={active}
                                        className={'px-2 py-1.5 rounded-md border text-[11px] text-left transition '
                                            + (active
                                                ? 'border-zinc-600 bg-zinc-800/40 text-zinc-500 cursor-not-allowed'
                                                : 'border-white/10 bg-black/30 text-zinc-200 hover:border-blue-400/50 hover:bg-blue-500/10')}
                                        title={active ? 'Current language' : `Re-translate to ${label}`}
                                    >
                                        {label}
                                        {active && <span className="block text-[9px] text-zinc-500 mt-0.5">current</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}


// Background-change panel rendered inline under the result video.
// Two tabs: pick a STOCK background (free + pro) or upload a custom
// video / audio file. On submit, hits /change-background-* endpoint;
// on success, calls onChanged with the new video URL so the parent
// reloads the player against the freshly-burned mp4.
function BackgroundChangePanel({ jobId, onClose, onChanged }) {
    const [tab, setTab] = useState('stock'); // 'stock' | 'upload'
    const [stockList, setStockList] = useState([]);
    const [stockLoading, setStockLoading] = useState(true);
    const [stockId, setStockId] = useState(null);
    const [uploadFile, setUploadFile] = useState(null);
    const [replaceAudio, setReplaceAudio] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const [audioReplacedNotice, setAudioReplacedNotice] = useState(null);
    const fileRef = useRef(null);

    // Fetch stock catalog on mount. Cheap (small JSON) so we don't
    // bother caching across mounts.
    useEffect(() => {
        let alive = true;
        fetch(getApiUrl('/api/stock-backgrounds/list'))
            .then((r) => r.ok ? r.json() : { backgrounds: [] })
            .then((data) => {
                if (!alive) return;
                setStockList(data.backgrounds || []);
                if ((data.backgrounds || []).length) setStockId(data.backgrounds[0].id);
            })
            .catch(() => { if (alive) setStockList([]); })
            .finally(() => { if (alive) setStockLoading(false); });
        return () => { alive = false; };
    }, []);

    const submit = async () => {
        setError(null);
        setAudioReplacedNotice(null);
        setRunning(true);
        try {
            let res;
            if (tab === 'stock') {
                if (!stockId) throw new Error('Pick a background first.');
                res = await fetch(getApiUrl(`/api/standalone/${jobId}/change-background-stock`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_id: jobId, stock_id: stockId }),
                });
            } else {
                if (!uploadFile) throw new Error('Choose a file to upload.');
                const fd = new FormData();
                fd.append('bg_file', uploadFile);
                fd.append('replace_audio_with_new', replaceAudio ? 'true' : 'false');
                res = await fetch(getApiUrl(`/api/standalone/${jobId}/change-background-upload`), {
                    method: 'POST',
                    body: fd,
                });
            }
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || `HTTP ${res.status}`);
            }
            const data = await res.json();
            if (data.audio_replaced) {
                setAudioReplacedNotice('New audio replaced original (transcribed) audio.');
            }
            // Cache-bust to force the <video> tag to reload.
            const cacheBusted = data.video_url + (data.video_url.includes('?') ? '&' : '?') + 't=' + Date.now();
            onChanged?.(cacheBusted);
        } catch (err) {
            setError(String(err?.message || err));
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-left space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-violet-200 font-bold">
                    🎨 Change background
                </div>
                <button onClick={onClose} className="text-zinc-500 hover:text-white text-xs">Close</button>
            </div>

            {/* Tabs: stock vs upload */}
            <div className="flex rounded-md overflow-hidden border border-white/10">
                <button
                    onClick={() => setTab('stock')}
                    className={'flex-1 px-3 py-1.5 text-xs ' + (tab === 'stock' ? 'bg-violet-500/20 text-violet-100 font-bold' : 'bg-black/30 text-zinc-400 hover:text-white')}
                >
                    Stock library
                </button>
                <button
                    onClick={() => setTab('upload')}
                    className={'flex-1 px-3 py-1.5 text-xs ' + (tab === 'upload' ? 'bg-violet-500/20 text-violet-100 font-bold' : 'bg-black/30 text-zinc-400 hover:text-white')}
                >
                    Upload your own
                </button>
            </div>

            {tab === 'stock' && (
                <div>
                    {stockLoading ? (
                        <div className="flex items-center gap-2 text-xs text-zinc-400 py-4">
                            <Loader2 size={14} className="animate-spin" /> Loading library…
                        </div>
                    ) : stockList.length === 0 ? (
                        <div className="text-xs text-zinc-500">No stock backgrounds available.</div>
                    ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {stockList.map((entry) => {
                                const isPro = entry.tier === 'pro';
                                const active = stockId === entry.id;
                                return (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => !isPro && setStockId(entry.id)}
                                        disabled={isPro}
                                        className={'relative rounded-md border-2 aspect-[9/16] overflow-hidden transition '
                                            + (active ? 'border-violet-400 ring-2 ring-violet-400/50' : 'border-white/10 hover:border-white/30')
                                            + (isPro ? ' opacity-60 cursor-not-allowed' : '')}
                                        style={{ background: entry.preview?.css || '#222' }}
                                        title={isPro ? `${entry.name} (Pro)` : entry.name}
                                    >
                                        <div className="absolute inset-0 flex items-end p-1">
                                            <div className="text-[9px] text-white/90 font-bold drop-shadow leading-tight">
                                                {entry.name}
                                            </div>
                                        </div>
                                        {isPro && (
                                            <div className="absolute top-1 right-1 text-[8px] uppercase font-bold bg-amber-400/90 text-black px-1 rounded">
                                                Pro
                                            </div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {tab === 'upload' && (
                <div className="space-y-2">
                    <div
                        onClick={() => fileRef.current?.click()}
                        className={'border-2 border-dashed rounded-lg p-4 text-center cursor-pointer text-xs '
                            + (uploadFile ? 'border-violet-500/40 bg-violet-500/10' : 'border-white/10 bg-black/30 hover:border-white/30')}
                    >
                        <input
                            ref={fileRef}
                            type="file"
                            accept="video/*,audio/*"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadFile(f); }}
                        />
                        <Upload size={20} className="mx-auto text-zinc-500 mb-1" />
                        {uploadFile ? (
                            <>
                                <div className="font-medium text-white truncate">{uploadFile.name}</div>
                                <div className="text-zinc-500 mt-0.5">{(uploadFile.size / (1024 * 1024)).toFixed(1)} MB · click to swap</div>
                            </>
                        ) : (
                            <>
                                <div className="text-zinc-300">Drop a video (or audio) here, or click to choose</div>
                                <div className="text-zinc-500 mt-0.5">MP4, MOV, WebM, MP3, WAV…</div>
                            </>
                        )}
                    </div>
                    <label className="flex items-start gap-2 text-[11px] text-zinc-300 leading-snug">
                        <input
                            type="checkbox"
                            checked={replaceAudio}
                            onChange={(e) => setReplaceAudio(e.target.checked)}
                            className="accent-violet-500 mt-0.5"
                        />
                        <span>
                            <strong className="text-violet-200">Replace audio with the uploaded file's audio</strong>
                            <span className="block text-zinc-500 mt-0.5">
                                Recommended: ON for the song workflow (you uploaded vocals to get clean
                                subtitles, now you want the full mix). OFF keeps the original transcribed
                                audio playing under the new visuals.
                            </span>
                        </span>
                    </label>
                </div>
            )}

            {error && (
                <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 leading-snug">
                    {error}
                </div>
            )}
            {audioReplacedNotice && (
                <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-1.5 leading-snug">
                    ✓ {audioReplacedNotice}
                </div>
            )}

            <button
                onClick={submit}
                disabled={running || (tab === 'stock' && !stockId) || (tab === 'upload' && !uploadFile)}
                className="w-full py-2 rounded-md bg-gradient-to-r from-violet-500 to-purple-600 text-white font-bold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                {running ? (<><Loader2 size={14} className="animate-spin" /> Re-burning subtitles on new background…</>) : 'Apply background →'}
            </button>
        </div>
    );
}
