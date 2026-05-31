import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
    Upload, Youtube, Link2, Sparkles, Scissors, ArrowRight, Loader2,
    Play, Pause, ChevronLeft, ChevronRight, RotateCcw, RotateCw,
    Plus, Trash2, Wand2, Brain, GripVertical, Download, ZoomIn, ZoomOut,
    Layers, Split, Merge, Eye, Settings, MoveHorizontal, Camera, Monitor,
    CheckCircle2, AlertCircle, X, Save, Film, FolderOpen,
} from 'lucide-react';
import { getApiUrl } from '../config';
import ProviderPicker from './ProviderPicker';
import StandaloneReframeKeyframeModal from './StandaloneReframeKeyframeModal';

/**
 * HorizontalToVertical (H2V)
 *
 * NEW PRODUCT — converts horizontal long-form video into one or many
 * vertical 9:16 clips with:
 *   • AI topic detection (auto-split into coherent vertical clips)
 *   • Intelligent merge of non-contiguous segments on the same topic
 *   • Professional timeline editor: drag-select, split (S), delete
 *     (Backspace), merge (M), undo/redo (Cmd+Z / Cmd+Shift+Z), zoom
 *     (+/- or Ctrl+wheel), play (Space), J/K/L transport, ←/→ nudge
 *   • Per-clip focus: Auto Speaker (mediapipe face track) by default,
 *     or Manual Keyframes (opens existing reframe modal) to switch
 *     focus to a screen-share / any region
 *
 * Three phases:
 *   Phase 0 — setup: URL or upload + provider
 *   Phase 1 — analyzing: polls /api/h2v/status
 *   Phase 2 — editor: timeline + clip list + preview
 */
export default function HorizontalToVertical({
    apiKey,            // legacy alias for llmConfig.api_key
    llmConfig,         // { provider, model, api_key }
    setApiKey,         // accepts string OR config object
    elevenLabsKey,
    onBack,
}) {
    const [phase, setPhase] = useState(0);          // 0=setup, 1=analyzing, 2=editor
    const [jobId, setJobId] = useState(null);
    const [statusMsg, setStatusMsg] = useState('');
    const [logs, setLogs] = useState([]);
    const [progress, setProgress] = useState(0);    // 0–100 from backend
    const [stage, setStage] = useState('queued');   // queued|downloading|transcribing|...
    const [duration, setDuration] = useState(0);
    const [sourceDims, setSourceDims] = useState({ w: 1920, h: 1080 });
    const [topics, setTopics] = useState([]);       // raw AI topics
    const [transcript, setTranscript] = useState([]); // segments
    const [videoUrl, setVideoUrl] = useState(null); // source video URL for editor preview
    const [error, setError] = useState('');

    // Setup form state.
    const [mode, setMode] = useState('url');        // 'url' | 'file' | 'local'
    const [url, setUrl] = useState('');
    const [file, setFile] = useState(null);
    const [sourceLang, setSourceLang] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Local-file mode state — mirrors MediaInput.jsx's flow.
    // The user picks/drops a file; we send name+size to /api/local/find,
    // which scans the bind-mounted media roots and resolves to an
    // in-container path. NO bytes are uploaded.
    const [localCfg, setLocalCfg] = useState({ enabled: false, roots: [], allowed_extensions: [] });
    const [localPath, setLocalPath] = useState(() => localStorage.getItem('klipra_last_local_path') || '');
    const [localFileName, setLocalFileName] = useState('');
    const [localFileSize, setLocalFileSize] = useState(0);
    const [localResolveStatus, setLocalResolveStatus] = useState('idle'); // idle|resolving|resolved|multiple|not_found|error
    const [localResolveError, setLocalResolveError] = useState('');
    const [localCandidates, setLocalCandidates] = useState([]);

    // One-shot probe of local-file mode availability on mount. Endpoint
    // returns enabled=false on production deployments; we hide the tab.
    useEffect(() => {
        fetch(getApiUrl('/api/local/config'))
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) setLocalCfg(d); })
            .catch(() => {});
    }, []);

    const resolveLocalFile = useCallback(async (f) => {
        if (!f) return;
        setLocalFileName(f.name);
        setLocalFileSize(f.size);
        setLocalResolveStatus('resolving');
        setLocalResolveError('');
        setLocalCandidates([]);
        setLocalPath('');
        try {
            const params = new URLSearchParams({ name: f.name, size: String(f.size || 0) });
            const res = await fetch(getApiUrl(`/api/local/find?${params.toString()}`));
            if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
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
    }, []);

    const clearLocalFile = () => {
        setLocalFileName('');
        setLocalFileSize(0);
        setLocalPath('');
        setLocalCandidates([]);
        setLocalResolveStatus('idle');
        setLocalResolveError('');
    };

    // Editor state (Phase 2).
    const [clips, setClips] = useState([]);          // [{id, title, time_ranges, focus_mode, manual_keyframes, color}]
    const [selectedClipIds, setSelectedClipIds] = useState([]);
    const [playheadT, setPlayheadT] = useState(0);   // seconds, source-local
    const [isPlaying, setIsPlaying] = useState(false);
    const [history, setHistory] = useState([]);      // undo stack of clip snapshots
    const [future, setFuture] = useState([]);        // redo stack
    const [zoom, setZoom] = useState(1);             // px per second (logical)
    const [reframeFor, setReframeFor] = useState(null); // clip object or null

    // Render flow state.
    const [rendering, setRendering] = useState(false);
    const [renderedClips, setRenderedClips] = useState([]);

    const videoRef = useRef(null);
    const pollRef = useRef(null);

    // -------------------- Phase 1 polling --------------------
    useEffect(() => {
        if (phase !== 1 || !jobId) return;
        let alive = true;
        async function poll() {
            try {
                const r = await fetch(getApiUrl(`/api/h2v/status/${jobId}`));
                if (!r.ok) throw new Error(`status ${r.status}`);
                const data = await r.json();
                if (!alive) return;
                setLogs(data.logs || []);
                setStatusMsg(data.logs?.[data.logs.length - 1] || data.status || '');
                if (typeof data.progress === 'number') setProgress(data.progress);
                if (data.stage) setStage(data.stage);
                if (data.status === 'analyzed') {
                    const ts = (data.topics || data.result?.topics || []);
                    setTopics(ts);
                    setTranscript(data.transcript?.segments || []);
                    setDuration(data.duration || data.result?.duration || 0);
                    setSourceDims(data.source_dims || data.result?.source_dims || { w: 1920, h: 1080 });
                    // Build initial clips from topics.
                    const initialClips = ts.map((t, i) => ({
                        id: `c_${Date.now()}_${i}`,
                        title: t.title || `Clip ${i + 1}`,
                        summary: t.summary || '',
                        time_ranges: (t.time_ranges || []).map(r => ({ ...r })),
                        focus_mode: 'auto',
                        manual_keyframes: [],
                        color: TOPIC_COLORS[i % TOPIC_COLORS.length],
                        is_merged: !!t.is_merged,
                    }));
                    setClips(initialClips);
                    setVideoUrl(getApiUrl(`/api/standalone/${jobId}/source-video`));
                    setPhase(2);
                } else if (data.status === 'failed') {
                    setError((data.logs || []).slice(-1)[0] || 'Analysis failed');
                    setPhase(0);
                }
            } catch (e) {
                console.warn('h2v poll error', e);
            }
        }
        pollRef.current = setInterval(poll, 2000);
        poll();
        return () => {
            alive = false;
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [phase, jobId]);

    // -------------------- Phase 0: submit --------------------
    async function submitAnalyze() {
        console.log('[H2V] Analyze button clicked', { mode, url, file: !!file, sourceLang, localPath });
        setError('');
        if (mode === 'url' && !url.trim()) {
            setError('Please paste a video URL.');
            return;
        }
        if (mode === 'file' && !file) {
            setError('Please choose a video file first.');
            return;
        }
        if (mode === 'file' && file && file.size > 5 * 1024 * 1024 * 1024) {
            setError('File is over 5 GB. Try compressing the video or using a YouTube link instead.');
            return;
        }
        if (mode === 'local' && !localPath.trim()) {
            setError('Please pick a local file first.');
            return;
        }
        setSubmitting(true);
        setProgress(0);
        setStage('queued');
        const fd = new FormData();
        if (mode === 'url') fd.append('url', url.trim());
        if (mode === 'file' && file) fd.append('file', file);
        if (mode === 'local') fd.append('local_path', localPath.trim());
        if (sourceLang) fd.append('source_language', sourceLang);
        if (mode === 'local') {
            try { localStorage.setItem('klipra_last_local_path', localPath.trim()); } catch {}
        }

        try {
            console.log('[H2V] POST /api/h2v/analyze');
            const r = await fetch(getApiUrl('/api/h2v/analyze'), {
                method: 'POST',
                body: fd,
                headers: {
                    'X-LLM-Provider': llmConfig?.provider || 'gemini',
                    'X-LLM-Model': llmConfig?.model || 'gemini-2.5-flash',
                    'X-LLM-Key': llmConfig?.api_key || apiKey || '',
                    'X-ElevenLabs-Key': elevenLabsKey || '',
                },
            });
            console.log('[H2V] response status', r.status);
            if (!r.ok) {
                const t = await r.text();
                console.error('[H2V] request failed', r.status, t);
                throw new Error(t || `Request failed (${r.status})`);
            }
            const data = await r.json();
            console.log('[H2V] job started', data);
            setJobId(data.job_id);
            setPhase(1);
            setLogs(['Queued.']);
            setStatusMsg('Queued.');
        } catch (e) {
            console.error('[H2V] submitAnalyze threw', e);
            setError(e.message || String(e));
        } finally {
            setSubmitting(false);
        }
    }

    // -------------------- Editor: history --------------------
    const pushHistory = useCallback((nextClips) => {
        setHistory(h => [...h.slice(-30), clips]);
        setFuture([]);
        setClips(nextClips);
    }, [clips]);

    const undo = useCallback(() => {
        setHistory(h => {
            if (!h.length) return h;
            const prev = h[h.length - 1];
            setFuture(f => [clips, ...f].slice(0, 30));
            setClips(prev);
            return h.slice(0, -1);
        });
    }, [clips]);

    const redo = useCallback(() => {
        setFuture(f => {
            if (!f.length) return f;
            const next = f[0];
            setHistory(h => [...h, clips].slice(-30));
            setClips(next);
            return f.slice(1);
        });
    }, [clips]);

    // -------------------- Editor: actions --------------------
    function selectClip(id, additive = false) {
        if (additive) {
            setSelectedClipIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
        } else {
            setSelectedClipIds([id]);
        }
    }

    function deleteSelected() {
        if (!selectedClipIds.length) return;
        const next = clips.filter(c => !selectedClipIds.includes(c.id));
        setSelectedClipIds([]);
        pushHistory(next);
    }

    function splitAtPlayhead() {
        if (!selectedClipIds.length) return;
        const next = [];
        let didSplit = false;
        for (const c of clips) {
            if (!selectedClipIds.includes(c.id)) {
                next.push(c);
                continue;
            }
            // Find the range containing playheadT.
            const trIdx = c.time_ranges.findIndex(r => r.start < playheadT && playheadT < r.end);
            if (trIdx < 0) {
                next.push(c);
                continue;
            }
            const r = c.time_ranges[trIdx];
            const a = { ...c, id: `${c.id}_a${Date.now()}`, title: c.title + ' (part 1)',
                       time_ranges: [...c.time_ranges.slice(0, trIdx), { start: r.start, end: playheadT },
                                     ...c.time_ranges.slice(trIdx + 1).filter(x => x.end <= playheadT)] };
            const b = { ...c, id: `${c.id}_b${Date.now()}`, title: c.title + ' (part 2)',
                       time_ranges: [{ start: playheadT, end: r.end },
                                     ...c.time_ranges.slice(trIdx + 1).filter(x => x.start >= playheadT)] };
            next.push(a, b);
            didSplit = true;
        }
        if (didSplit) {
            setSelectedClipIds([]);
            pushHistory(next);
        }
    }

    function mergeSelected() {
        if (selectedClipIds.length < 2) return;
        const selected = clips.filter(c => selectedClipIds.includes(c.id));
        const others = clips.filter(c => !selectedClipIds.includes(c.id));
        const allRanges = selected.flatMap(c => c.time_ranges).sort((a, b) => a.start - b.start);
        // Coalesce overlapping ranges.
        const merged = [];
        for (const r of allRanges) {
            if (merged.length && r.start <= merged[merged.length - 1].end + 0.5) {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
            } else {
                merged.push({ ...r });
            }
        }
        const newClip = {
            ...selected[0],
            id: `merged_${Date.now()}`,
            title: selected[0].title + ' + others',
            time_ranges: merged,
            is_merged: true,
            color: selected[0].color,
        };
        const insertAt = clips.findIndex(c => c.id === selected[0].id);
        const next = [...others.slice(0, insertAt), newClip, ...others.slice(insertAt)];
        setSelectedClipIds([newClip.id]);
        pushHistory(next);
    }

    function addEmptyClipFromPlayhead() {
        const seedEnd = Math.min(duration, playheadT + 30);
        if (seedEnd - playheadT < 1) return;
        const newClip = {
            id: `manual_${Date.now()}`,
            title: `New clip @ ${formatTime(playheadT)}`,
            summary: '',
            time_ranges: [{ start: playheadT, end: seedEnd }],
            focus_mode: 'auto',
            manual_keyframes: [],
            color: TOPIC_COLORS[clips.length % TOPIC_COLORS.length],
            is_merged: false,
        };
        pushHistory([...clips, newClip]);
        setSelectedClipIds([newClip.id]);
    }

    function updateClip(id, patch) {
        const next = clips.map(c => c.id === id ? { ...c, ...patch } : c);
        pushHistory(next);
    }

    function setRangeBounds(clipId, rangeIdx, patch) {
        const clip = clips.find(c => c.id === clipId);
        if (!clip) return;
        const ranges = clip.time_ranges.map((r, i) => i === rangeIdx ? { ...r, ...patch } : r);
        updateClip(clipId, { time_ranges: ranges });
    }

    // -------------------- Keyboard shortcuts --------------------
    useEffect(() => {
        if (phase !== 2) return;
        function onKey(e) {
            // Skip if user is typing in an input.
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
            const meta = e.metaKey || e.ctrlKey;
            if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
            if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
                e.preventDefault(); redo(); return;
            }
            if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
            if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitAtPlayhead(); return; }
            if (e.key === 'm' || e.key === 'M') { e.preventDefault(); mergeSelected(); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); return; }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const delta = e.shiftKey ? 1 : (e.altKey ? 0.04 : 0.2);
                seekTo(Math.max(0, playheadT - delta));
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                const delta = e.shiftKey ? 1 : (e.altKey ? 0.04 : 0.2);
                seekTo(Math.min(duration, playheadT + delta));
                return;
            }
            if (e.key === 'j' || e.key === 'J') {
                if (videoRef.current) {
                    videoRef.current.playbackRate = Math.max(0.25, (videoRef.current.playbackRate || 1) - 0.5);
                    videoRef.current.play();
                    setIsPlaying(true);
                }
                return;
            }
            if (e.key === 'k' || e.key === 'K') { e.preventDefault(); pauseVideo(); return; }
            if (e.key === 'l' || e.key === 'L') {
                if (videoRef.current) {
                    videoRef.current.playbackRate = Math.min(4, (videoRef.current.playbackRate || 1) + 0.5);
                    videoRef.current.play();
                    setIsPlaying(true);
                }
                return;
            }
            if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(z => Math.min(8, z * 1.25)); return; }
            if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(z => Math.max(0.25, z / 1.25)); return; }
            if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addEmptyClipFromPlayhead(); return; }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [phase, playheadT, duration, clips, selectedClipIds, undo, redo]);

    function togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) { v.play(); setIsPlaying(true); }
        else { v.pause(); setIsPlaying(false); }
    }
    function pauseVideo() {
        const v = videoRef.current;
        if (!v) return;
        v.pause();
        v.playbackRate = 1;
        setIsPlaying(false);
    }
    function seekTo(t) {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, Math.min(duration, t));
        setPlayheadT(Math.max(0, Math.min(duration, t)));
    }
    function onTimeUpdate() {
        const v = videoRef.current;
        if (!v) return;
        setPlayheadT(v.currentTime);
    }

    // -------------------- Render --------------------
    async function submitRender() {
        if (!clips.length) { setError('Add at least one clip.'); return; }
        setRendering(true);
        setError('');
        setRenderedClips([]);
        try {
            const body = {
                clips: clips.map(c => ({
                    title: c.title,
                    time_ranges: c.time_ranges,
                    focus_mode: c.focus_mode,
                    aspect: '9:16',
                    manual_keyframes: c.focus_mode === 'manual' ? (c.manual_keyframes || []) : null,
                })),
            };
            const r = await fetch(getApiUrl(`/api/h2v/${jobId}/render`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                const t = await r.text();
                throw new Error(t || `Render failed (${r.status})`);
            }
            const data = await r.json();
            setRenderedClips(data.clips || []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setRendering(false);
        }
    }

    // ====================================================================
    // RENDER PHASES
    // ====================================================================

    if (phase === 0) {
        return (
            <SetupPhase
                mode={mode} setMode={setMode}
                url={url} setUrl={setUrl}
                file={file} setFile={setFile}
                sourceLang={sourceLang} setSourceLang={setSourceLang}
                error={error}
                apiKey={apiKey} llmConfig={llmConfig} setApiKey={setApiKey}
                submitting={submitting}
                onSubmit={submitAnalyze}
                onBack={onBack}
                localCfg={localCfg}
                localPath={localPath} setLocalPath={setLocalPath}
                localFileName={localFileName}
                localFileSize={localFileSize}
                localResolveStatus={localResolveStatus}
                localResolveError={localResolveError}
                localCandidates={localCandidates}
                resolveLocalFile={resolveLocalFile}
                clearLocalFile={clearLocalFile}
            />
        );
    }

    if (phase === 1) {
        return (
            <AnalyzingPhase
                logs={logs}
                statusMsg={statusMsg}
                progress={progress}
                stage={stage}
                onCancel={() => setPhase(0)}
            />
        );
    }

    // Phase 2: Editor
    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* Top toolbar */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-zinc-900">
                <button
                    onClick={() => { if (confirm('Discard edits and start over?')) setPhase(0); }}
                    className="flex items-center gap-1 text-zinc-400 hover:text-white text-sm"
                >
                    <ChevronLeft size={16} /> Back
                </button>
                <div className="text-zinc-500">·</div>
                <div className="flex items-center gap-1.5">
                    <Film size={16} className="text-fuchsia-400" />
                    <div className="text-sm font-semibold text-white">Horizontal → Vertical Editor</div>
                </div>
                <div className="flex-1" />

                <Toolbar
                    onUndo={undo} canUndo={history.length > 0}
                    onRedo={redo} canRedo={future.length > 0}
                    onSplit={splitAtPlayhead}
                    onMerge={mergeSelected} canMerge={selectedClipIds.length >= 2}
                    onDelete={deleteSelected} canDelete={selectedClipIds.length > 0}
                    onAdd={addEmptyClipFromPlayhead}
                    onZoomIn={() => setZoom(z => Math.min(8, z * 1.25))}
                    onZoomOut={() => setZoom(z => Math.max(0.25, z / 1.25))}
                />

                <button
                    onClick={submitRender}
                    disabled={rendering || !clips.length}
                    className="ml-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-400 hover:to-pink-400 disabled:opacity-40 text-white text-sm font-semibold"
                >
                    {rendering ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {rendering ? 'Rendering…' : `Render ${clips.length} clip${clips.length === 1 ? '' : 's'}`}
                </button>
            </div>

            {/* Editor body: 3-column layout */}
            <div className="flex-1 min-h-0 flex">
                {/* Left: clip list */}
                <div className="w-72 shrink-0 border-r border-white/10 bg-zinc-900 overflow-y-auto custom-scrollbar">
                    <ClipList
                        clips={clips}
                        selectedClipIds={selectedClipIds}
                        onSelect={selectClip}
                        onUpdate={updateClip}
                        onOpenReframe={(clip) => setReframeFor(clip)}
                        onJump={(t) => seekTo(t)}
                    />
                </div>

                {/* Center: video preview + timeline */}
                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex-1 min-h-0 flex items-center justify-center bg-black p-4">
                        <PreviewPane
                            videoRef={videoRef}
                            videoUrl={videoUrl}
                            onTimeUpdate={onTimeUpdate}
                            sourceDims={sourceDims}
                            isPlaying={isPlaying}
                            onPlayToggle={togglePlay}
                            playheadT={playheadT}
                            clips={clips}
                            selectedClipIds={selectedClipIds}
                            onUpdateClip={updateClip}
                        />
                    </div>

                    <div className="border-t border-white/10 bg-zinc-900">
                        <H2VTimeline
                            duration={duration}
                            playheadT={playheadT}
                            onSeek={seekTo}
                            transcript={transcript}
                            clips={clips}
                            selectedClipIds={selectedClipIds}
                            onSelectClip={selectClip}
                            onClipDrag={(id, rangeIdx, patch) => setRangeBounds(id, rangeIdx, patch)}
                            zoom={zoom}
                            setZoom={setZoom}
                            jobId={jobId}
                            onAddRange={addEmptyClipFromPlayhead}
                        />
                    </div>
                </div>

                {/* Right: rendered outputs or shortcuts hint */}
                <div className="w-80 shrink-0 border-l border-white/10 bg-zinc-900 overflow-y-auto custom-scrollbar">
                    <RightPanel
                        renderedClips={renderedClips}
                        rendering={rendering}
                        error={error}
                        clips={clips}
                        selectedClipIds={selectedClipIds}
                        onClipUpdate={updateClip}
                        onOpenReframe={(clip) => setReframeFor(clip)}
                    />
                </div>
            </div>

            {/* Reframe modal — opens when user clicks "Manual keyframes" on a clip */}
            {reframeFor && (
                <StandaloneReframeKeyframeModal
                    videoUrl={videoUrl}
                    targetAspect={9 / 16}
                    initialKeyframes={reframeFor.manual_keyframes || []}
                    onClose={() => setReframeFor(null)}
                    onSave={(kfs) => {
                        updateClip(reframeFor.id, { manual_keyframes: kfs, focus_mode: 'manual' });
                        setReframeFor(null);
                    }}
                />
            )}
        </div>
    );
}


// ===========================================================================
// Sub-components
// ===========================================================================

const TOPIC_COLORS = [
    '#a855f7', // purple
    '#ec4899', // pink
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#14b8a6', // teal
    '#8b5cf6', // violet
];

function formatTime(t) {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 100);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

const SOURCE_LANGS = [
    ['', 'Auto detect'],
    ['en', 'English'],
    ['ur', 'Urdu'],
    ['hi', 'Hindi'],
    ['ar', 'Arabic'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['tr', 'Turkish'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh', 'Chinese'],
];

// ---------------------------------------------------------------------------
// Setup phase
// ---------------------------------------------------------------------------
function SetupPhase({
    mode, setMode, url, setUrl, file, setFile, sourceLang, setSourceLang,
    error, apiKey, llmConfig, setApiKey, submitting, onSubmit, onBack,
    localCfg, localPath, setLocalPath, localFileName, localFileSize,
    localResolveStatus, localResolveError, localCandidates,
    resolveLocalFile, clearLocalFile,
}) {
    return (
        <div className="h-full overflow-y-auto custom-scrollbar bg-zinc-950">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
                <div className="flex items-center gap-2 mb-6">
                    {onBack && (
                        <button
                            onClick={onBack}
                            className="flex items-center gap-1 text-zinc-400 hover:text-white text-sm"
                        >
                            <ChevronLeft size={16} /> Back
                        </button>
                    )}
                </div>
                <header className="text-center mb-10">
                    <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1 text-[11px] uppercase tracking-wider text-fuchsia-300 mb-4">
                        <Sparkles size={12} /> NEW · Horizontal → Vertical
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white mb-3">
                        Turn your horizontal video into <span className="bg-gradient-to-r from-fuchsia-400 to-pink-400 bg-clip-text text-transparent">multiple vertical clips</span>
                    </h1>
                    <p className="text-zinc-400 text-base max-w-2xl mx-auto">
                        AI reads your transcript, finds the topic boundaries, and intelligently merges segments
                        spoken at different times that belong together. Speaker tracking is automatic — manually
                        override per-clip to focus on a screen share or any region.
                    </p>
                </header>

                <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5 sm:p-6 space-y-5">
                    {/* Mode toggle — URL / Upload / Use file from disk.
                        The third tab is only visible when the backend has
                        KLIPRA_LOCAL_MODE=1 enabled (typical for local Mac
                        installs). On production it stays hidden so users
                        don't get a confusing 403. */}
                    <div className="flex gap-2 flex-wrap">
                        <button
                            type="button"
                            onClick={() => setMode('url')}
                            className={`flex-1 min-w-[120px] flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium border transition ${mode === 'url' ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:text-white'}`}
                        >
                            <Link2 size={14} /> Paste URL
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode('file')}
                            className={`flex-1 min-w-[120px] flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium border transition ${mode === 'file' ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:text-white'}`}
                        >
                            <Upload size={14} /> Upload file
                        </button>
                        {localCfg?.enabled && (
                            <button
                                type="button"
                                onClick={() => setMode('local')}
                                className={`flex-1 min-w-[120px] flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium border transition ${mode === 'local' ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:text-white'}`}
                                title="Use a file already on your disk — no upload"
                            >
                                <FolderOpen size={14} /> Use file from disk
                            </button>
                        )}
                    </div>

                    {mode === 'url' && (
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">YouTube / Vimeo / TikTok / Direct link</label>
                            <div className="relative">
                                <Youtube size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                <input
                                    type="url"
                                    value={url}
                                    onChange={e => setUrl(e.target.value)}
                                    placeholder="https://youtube.com/watch?v=…"
                                    className="w-full pl-10 pr-3 py-3 bg-zinc-800 border border-white/10 rounded-lg text-white placeholder-zinc-600 focus:border-fuchsia-500/60 focus:outline-none text-sm"
                                />
                            </div>
                        </div>
                    )}

                    {mode === 'file' && (
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">Video file (mp4, mov, mkv, webm — up to 5 GB)</label>
                            <label className="flex items-center justify-center gap-2 py-8 border-2 border-dashed border-white/15 rounded-lg cursor-pointer hover:border-fuchsia-500/40 hover:bg-fuchsia-500/5 transition">
                                <Upload size={20} className="text-zinc-400" />
                                <span className="text-sm text-zinc-300">
                                    {file ? file.name : 'Click to choose a video'}
                                </span>
                                <input
                                    type="file"
                                    accept="video/*"
                                    className="hidden"
                                    onChange={e => setFile(e.target.files?.[0] || null)}
                                />
                            </label>
                        </div>
                    )}

                    {mode === 'local' && (
                        <LocalFilePicker
                            localCfg={localCfg}
                            localPath={localPath}
                            localFileName={localFileName}
                            localFileSize={localFileSize}
                            localResolveStatus={localResolveStatus}
                            localResolveError={localResolveError}
                            localCandidates={localCandidates}
                            onPick={resolveLocalFile}
                            onChooseCandidate={(p) => setLocalPath(p)}
                            onClear={clearLocalFile}
                        />
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">Source language</label>
                            <select
                                value={sourceLang}
                                onChange={e => setSourceLang(e.target.value)}
                                className="w-full px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-white text-sm focus:border-fuchsia-500/60 focus:outline-none"
                            >
                                {SOURCE_LANGS.map(([code, name]) => (
                                    <option key={code} value={code}>{name}</option>
                                ))}
                            </select>
                            <div className="text-[11px] text-zinc-500 mt-1">Helps Whisper. Auto-detect works for most videos.</div>
                        </div>
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">AI for topic detection</label>
                            <ProviderPicker value={llmConfig || { provider: 'gemini', model: 'gemini-2.5-flash', api_key: apiKey || '' }} onChange={setApiKey} />
                            <div className="text-[11px] text-zinc-500 mt-1">Gemini 2.5 Flash free tier handles ~5 long videos/day. Ollama is free + unlimited.</div>
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                            <AlertCircle size={16} className="shrink-0 mt-0.5" />
                            <div>{error}</div>
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={submitting}
                        className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-400 hover:to-pink-400 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold text-sm shadow-glow"
                    >
                        {submitting ? (
                            <><Loader2 size={16} className="animate-spin" /> Starting analysis…</>
                        ) : (
                            <><Brain size={16} /> Analyze video <ArrowRight size={14} /></>
                        )}
                    </button>
                </div>

                <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <Feature icon={Brain} title="AI auto-split"
                        body="Reads the full transcript and groups it into 2–6 vertical-clip-worthy topics." />
                    <Feature icon={Merge} title="Intelligent merge"
                        body="Same topic spoken at different times? AI fuses those segments into one coherent clip." />
                    <Feature icon={Camera} title="Speaker + screen focus"
                        body="Auto-tracks the speaker. Manually mark hard cuts to switch focus to your screen share." />
                </div>
            </div>
        </div>
    );
}

function Feature({ icon: Icon, title, body }) {
    return (
        <div className="rounded-xl border border-white/10 bg-zinc-900 p-4">
            <Icon size={18} className="text-fuchsia-400 mb-2" />
            <div className="text-white font-semibold text-sm mb-1">{title}</div>
            <div className="text-zinc-400 text-xs leading-relaxed">{body}</div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Local-file picker (mode === 'local')
//
// Mirrors the flow in MediaInput.jsx — user picks/drops a file, we send
// name+size to /api/local/find, backend scans bind-mounted media roots
// and resolves to an in-container path. No bytes uploaded.
// ---------------------------------------------------------------------------
function LocalFilePicker({
    localCfg, localPath, localFileName, localFileSize,
    localResolveStatus, localResolveError, localCandidates,
    onPick, onChooseCandidate, onClear,
}) {
    const inputRef = useRef(null);

    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        const f = e.dataTransfer?.files?.[0];
        if (f) onPick(f);
    }

    return (
        <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
                Pick a file already on your disk
            </label>
            <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={handleDrop}
                className="flex flex-col items-center justify-center gap-2 py-7 border-2 border-dashed border-white/15 rounded-lg cursor-pointer hover:border-fuchsia-500/40 hover:bg-fuchsia-500/5 transition"
            >
                <FolderOpen size={22} className="text-fuchsia-400" />
                <div className="text-sm text-zinc-300 text-center px-4">
                    {localFileName ? (
                        <>
                            <span className="text-white font-medium">{localFileName}</span>
                            <span className="text-zinc-500 ml-2">({(localFileSize / 1024 / 1024).toFixed(1)} MB)</span>
                        </>
                    ) : (
                        <>Click to browse, or drop a video file here</>
                    )}
                </div>
                <div className="text-[11px] text-zinc-500 text-center">
                    The file <strong className="text-zinc-300">stays on your disk</strong> — nothing is uploaded.
                </div>
                <input
                    ref={inputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); }}
                />
            </div>

            {/* Resolution status */}
            {localResolveStatus === 'resolving' && (
                <div className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
                    <Loader2 size={14} className="animate-spin text-fuchsia-400" />
                    Looking up file on your disk…
                </div>
            )}
            {localResolveStatus === 'resolved' && localPath && (
                <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm">
                    <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                        <div>Found it.</div>
                        <div className="text-[11px] text-emerald-400/70 font-mono truncate" title={localPath}>{localPath}</div>
                    </div>
                    <button onClick={onClear} className="text-emerald-300/60 hover:text-white"><X size={14} /></button>
                </div>
            )}
            {localResolveStatus === 'multiple' && (
                <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm">
                    <div className="mb-2 flex items-start gap-2">
                        <AlertCircle size={16} className="shrink-0 mt-0.5" />
                        <div>Multiple matching files. Pick the right one:</div>
                    </div>
                    <div className="space-y-1.5">
                        {localCandidates.map((c, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => onChooseCandidate(c.path)}
                                className={`w-full text-left px-2 py-1.5 rounded text-[12px] font-mono border ${localPath === c.path ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-zinc-800/50 border-white/5 text-zinc-300 hover:bg-zinc-800'}`}
                            >
                                {c.path}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {localResolveStatus === 'not_found' && (
                <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <div>File not found inside the allowed media folders.</div>
                        <div className="text-[11px] text-red-400/70 mt-1">
                            Allowed roots: {(localCfg.roots || []).join(', ') || '(none configured)'}.
                            Move or symlink your file into one of these folders and try again.
                        </div>
                    </div>
                </div>
            )}
            {localResolveStatus === 'error' && (
                <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <div>{localResolveError || 'Lookup failed.'}</div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Analyzing phase — animated progress bar + stage-aware steps + log tail
// ---------------------------------------------------------------------------
function AnalyzingPhase({ logs, statusMsg, progress = 0, stage = 'queued', onCancel }) {
    // The pipeline has 4 visible stages. We highlight whichever one is
    // currently in flight and check off the ones that have finished.
    const STAGES = [
        { id: 'downloading',  label: 'Download video',     atProgress: 5 },
        { id: 'transcribing', label: 'Transcribe with Whisper', atProgress: 15 },
        { id: 'analyzing',    label: 'AI finds topics',    atProgress: 70 },
        { id: 'probing',      label: 'Open the editor',    atProgress: 88 },
    ];
    // Pick the active stage based on the backend's `stage` string, with
    // graceful fallback to whichever progress milestone we're past.
    function stageStatus(s) {
        if (stage === 'done' || progress >= 100) return 'done';
        if (stage === s.id) return 'active';
        if (progress >= s.atProgress) return 'done';
        return 'pending';
    }

    return (
        <div className="h-full overflow-y-auto custom-scrollbar bg-zinc-950">
            <div className="max-w-3xl mx-auto px-4 py-12">
                <div className="text-center mb-8">
                    <Loader2 size={40} className="mx-auto text-fuchsia-400 animate-spin mb-4" />
                    <h2 className="text-2xl font-bold text-white mb-1">AI is reading your video…</h2>
                    <p className="text-zinc-400 text-sm">{statusMsg || 'Working…'}</p>
                </div>

                {/* Progress bar */}
                <div className="bg-zinc-900 border border-white/10 rounded-xl p-5 mb-5">
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs uppercase tracking-wider text-zinc-400 font-semibold">Progress</div>
                        <div className="text-sm font-mono tabular-nums text-fuchsia-300">{Math.round(progress)}%</div>
                    </div>
                    <div className="h-3 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-fuchsia-500 to-pink-500 transition-all duration-500 ease-out"
                            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                        />
                    </div>

                    {/* Stage list */}
                    <div className="mt-5 space-y-2">
                        {STAGES.map(s => {
                            const st = stageStatus(s);
                            return (
                                <div key={s.id} className="flex items-center gap-3">
                                    {st === 'done' ? (
                                        <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                                    ) : st === 'active' ? (
                                        <Loader2 size={16} className="text-fuchsia-400 animate-spin shrink-0" />
                                    ) : (
                                        <div className="w-4 h-4 rounded-full border-2 border-zinc-700 shrink-0" />
                                    )}
                                    <div className={`text-sm ${st === 'done' ? 'text-zinc-400 line-through decoration-zinc-600' : st === 'active' ? 'text-fuchsia-200 font-medium' : 'text-zinc-500'}`}>
                                        {s.label}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Detailed log */}
                <details className="bg-zinc-900 border border-white/10 rounded-xl">
                    <summary className="cursor-pointer px-4 py-3 text-xs uppercase tracking-wider text-zinc-400 font-semibold hover:text-white">
                        Show detailed log
                    </summary>
                    <div className="px-4 pb-4 max-h-64 overflow-y-auto custom-scrollbar font-mono text-[12px] text-zinc-400 space-y-0.5">
                        {(logs || []).map((l, i) => (
                            <div key={i} className="leading-relaxed">{l}</div>
                        ))}
                        {!logs?.length && <div className="text-zinc-600 italic">Waiting for first update…</div>}
                    </div>
                </details>

                <div className="text-center mt-6">
                    <button
                        onClick={onCancel}
                        className="text-sm text-zinc-500 hover:text-zinc-300"
                    >
                        Cancel and start over
                    </button>
                </div>
                <p className="text-center text-[11px] text-zinc-600 mt-4">
                    A 30-minute video typically takes 2–5 minutes (transcribe) + 30 s (AI). It's safe to switch tabs — we'll keep working in the background.
                </p>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Top toolbar
// ---------------------------------------------------------------------------
function Toolbar({ onUndo, canUndo, onRedo, canRedo, onSplit, onMerge, canMerge, onDelete, canDelete, onAdd, onZoomIn, onZoomOut }) {
    const btn = "p-2 rounded-md text-zinc-400 hover:text-white hover:bg-white/5 transition disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400";
    return (
        <div className="flex items-center gap-1">
            <button title="Undo (Cmd+Z)" disabled={!canUndo} onClick={onUndo} className={btn}><RotateCcw size={16} /></button>
            <button title="Redo (Cmd+Shift+Z)" disabled={!canRedo} onClick={onRedo} className={btn}><RotateCw size={16} /></button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button title="Split at playhead (S)" onClick={onSplit} className={btn}><Split size={16} /></button>
            <button title="Merge selected (M)" disabled={!canMerge} onClick={onMerge} className={btn}><Merge size={16} /></button>
            <button title="Add clip at playhead (N)" onClick={onAdd} className={btn}><Plus size={16} /></button>
            <button title="Delete selected (Backspace)" disabled={!canDelete} onClick={onDelete} className={btn}><Trash2 size={16} /></button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button title="Zoom in (+)" onClick={onZoomIn} className={btn}><ZoomIn size={16} /></button>
            <button title="Zoom out (-)" onClick={onZoomOut} className={btn}><ZoomOut size={16} /></button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Left: clip list
// ---------------------------------------------------------------------------
function ClipList({ clips, selectedClipIds, onSelect, onUpdate, onOpenReframe, onJump }) {
    return (
        <div>
            <div className="px-4 py-3 border-b border-white/10 sticky top-0 bg-zinc-900 z-10">
                <div className="flex items-center gap-2">
                    <Layers size={14} className="text-fuchsia-400" />
                    <div className="text-xs uppercase tracking-wider text-zinc-400 font-semibold">
                        Vertical clips ({clips.length})
                    </div>
                </div>
            </div>
            <div className="p-3 space-y-2">
                {!clips.length && (
                    <div className="text-xs text-zinc-500 px-2 py-4 text-center">
                        No clips yet. Press <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/10 text-[10px]">N</kbd> at any point on the timeline to add one.
                    </div>
                )}
                {clips.map((c) => {
                    const sel = selectedClipIds.includes(c.id);
                    const totalDur = c.time_ranges.reduce((s, r) => s + (r.end - r.start), 0);
                    return (
                        <div
                            key={c.id}
                            onClick={(e) => onSelect(c.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                            className={`relative rounded-lg border p-3 cursor-pointer transition ${sel ? 'border-fuchsia-500/60 bg-fuchsia-500/10' : 'border-white/10 bg-zinc-800/60 hover:bg-zinc-800'}`}
                        >
                            <div className="flex items-start gap-2">
                                <div className="w-1 self-stretch rounded" style={{ background: c.color }} />
                                <div className="flex-1 min-w-0">
                                    <input
                                        value={c.title}
                                        onChange={(e) => onUpdate(c.id, { title: e.target.value })}
                                        onClick={(e) => e.stopPropagation()}
                                        className="w-full bg-transparent border-0 outline-none text-sm text-white font-medium px-0"
                                    />
                                    {c.summary && (
                                        <div className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2">{c.summary}</div>
                                    )}
                                    <div className="flex items-center gap-2 mt-2 text-[11px] text-zinc-400">
                                        <span>{formatTime(totalDur)}</span>
                                        {c.is_merged && (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                                <Merge size={10} /> merged
                                            </span>
                                        )}
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-300">
                                            {c.focus_mode === 'manual' ? <><Monitor size={10}/> manual</> :
                                             c.focus_mode === 'center' ? <><Eye size={10}/> center</> :
                                             <><Camera size={10}/> auto</>}
                                        </span>
                                    </div>
                                    <div className="mt-2 space-y-1">
                                        {c.time_ranges.map((r, i) => (
                                            <button
                                                key={i}
                                                onClick={(e) => { e.stopPropagation(); onJump(r.start); }}
                                                className="text-[11px] text-zinc-400 hover:text-fuchsia-300 font-mono"
                                                title="Jump to range start"
                                            >
                                                {formatTime(r.start)} → {formatTime(r.end)}
                                            </button>
                                        )).reduce((acc, el, i) => i === 0 ? [el] : [...acc, <span key={`s${i}`} className="text-zinc-700 mx-1">·</span>, el], [])}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Right panel: rendered outputs + per-clip focus controls
// ---------------------------------------------------------------------------
function RightPanel({ renderedClips, rendering, error, clips, selectedClipIds, onClipUpdate, onOpenReframe }) {
    const selected = clips.find(c => selectedClipIds.includes(c.id) && selectedClipIds.length === 1);
    return (
        <div>
            {/* Focus controls for the active clip */}
            {selected && (
                <div className="p-4 border-b border-white/10">
                    <div className="text-xs uppercase tracking-wider text-zinc-400 font-semibold mb-2">Focus tracking</div>
                    <div className="space-y-2">
                        {[
                            { id: 'auto', label: 'Auto · Speaker face track', icon: Camera, hint: 'Mediapipe finds the speaker each second. Snaps on scene cuts.' },
                            { id: 'manual', label: 'Manual · Pick the focus', icon: MoveHorizontal, hint: 'Open the keyframe editor and mark hard cuts to a screen share or any region.' },
                            { id: 'center', label: 'Center · No tracking', icon: Eye, hint: 'Crops the middle. Use this for screen-only recordings.' },
                        ].map(opt => {
                            const Active = opt.icon;
                            const isOn = selected.focus_mode === opt.id;
                            return (
                                <label key={opt.id} className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer border ${isOn ? 'bg-fuchsia-500/10 border-fuchsia-500/40' : 'bg-zinc-800/60 border-white/10 hover:bg-zinc-800'}`}>
                                    <input
                                        type="radio"
                                        checked={isOn}
                                        onChange={() => onClipUpdate(selected.id, { focus_mode: opt.id })}
                                        className="mt-1 accent-fuchsia-500"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 text-sm text-white"><Active size={13}/> {opt.label}</div>
                                        <div className="text-[11px] text-zinc-500 leading-snug">{opt.hint}</div>
                                    </div>
                                </label>
                            );
                        })}
                        {selected.focus_mode === 'manual' && (
                            <button
                                onClick={() => onOpenReframe(selected)}
                                className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 text-white text-sm font-semibold mt-1"
                            >
                                <Settings size={14} /> Open keyframe editor ({(selected.manual_keyframes || []).length})
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Keyboard shortcuts hint */}
            <div className="p-4 border-b border-white/10">
                <div className="text-xs uppercase tracking-wider text-zinc-400 font-semibold mb-2">Keyboard shortcuts</div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                    <ShortcutRow label="Play/Pause" kb="Space" />
                    <ShortcutRow label="Add clip" kb="N" />
                    <ShortcutRow label="Split selected" kb="S" />
                    <ShortcutRow label="Merge selected" kb="M" />
                    <ShortcutRow label="Delete" kb="⌫" />
                    <ShortcutRow label="Undo / Redo" kb="⌘Z / ⇧⌘Z" />
                    <ShortcutRow label="Nudge frame" kb="⌥ ← →" />
                    <ShortcutRow label="Step 0.2s" kb="← →" />
                    <ShortcutRow label="Step 1s" kb="⇧ ← →" />
                    <ShortcutRow label="Zoom in / out" kb="+ / −" />
                    <ShortcutRow label="JKL transport" kb="J K L" />
                    <ShortcutRow label="Multi-select" kb="⌘ click" />
                </div>
            </div>

            {/* Rendered outputs */}
            <div className="p-4">
                <div className="text-xs uppercase tracking-wider text-zinc-400 font-semibold mb-3">Rendered output</div>
                {error && (
                    <div className="flex items-start gap-2 p-2 mb-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                        <div>{error}</div>
                    </div>
                )}
                {rendering && (
                    <div className="flex items-center gap-2 text-fuchsia-300 text-sm">
                        <Loader2 size={14} className="animate-spin" /> Rendering…
                    </div>
                )}
                {!rendering && !renderedClips.length && (
                    <div className="text-xs text-zinc-500 leading-relaxed">
                        Click <strong className="text-fuchsia-300">Render</strong> in the toolbar to produce the vertical mp4 files.
                    </div>
                )}
                {renderedClips.length > 0 && (
                    <div className="space-y-3">
                        {renderedClips.map(c => (
                            <div key={c.index} className="rounded-lg overflow-hidden border border-white/10 bg-zinc-800">
                                <video
                                    src={getApiUrl(c.video_url)}
                                    controls
                                    className="w-full aspect-[9/16] bg-black"
                                />
                                <div className="p-2 flex items-center justify-between">
                                    <div className="text-xs text-white truncate flex-1 mr-2" title={c.title}>{c.title}</div>
                                    <a
                                        href={getApiUrl(c.video_url)}
                                        download
                                        className="p-1.5 rounded text-fuchsia-300 hover:bg-fuchsia-500/15"
                                        title="Download"
                                    >
                                        <Download size={14} />
                                    </a>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ShortcutRow({ label, kb }) {
    return (
        <>
            <div className="text-zinc-400">{label}</div>
            <div className="text-zinc-500 font-mono text-right">{kb}</div>
        </>
    );
}

// ---------------------------------------------------------------------------
// Preview pane — source video with INTERACTIVE crop overlay
//
// The magenta 9:16 rectangle can be DRAGGED inside the preview to reframe.
// Dragging:
//   1. Switches the selected clip's focus_mode → 'manual'.
//   2. Upserts (or creates) a hard-cut keyframe at the current playhead time
//      with the new (x, y) crop center.
//
// Below the preview:
//   • Play/Pause toggle
//   • "+ Keyframe at playhead" button — explicit hard-cut at current time
//   • "Remove keyframe here" — removes the keyframe within 0.2 s of playhead
//   • Small keyframe strip: visual markers for all keyframes in the clip
// ---------------------------------------------------------------------------
function PreviewPane({
    videoRef, videoUrl, onTimeUpdate, sourceDims, isPlaying, onPlayToggle,
    playheadT, clips, selectedClipIds, onUpdateClip,
}) {
    const aspect = (sourceDims?.w || 16) / (sourceDims?.h || 9);
    const frameRef = useRef(null);
    const [isDragging, setIsDragging] = useState(false);

    // The single-selected clip — drag editing only makes sense when
    // exactly one clip is the "focused" one in the editor. Multi-select
    // and no-select both disable drag.
    const selectedClip = useMemo(() => (
        (selectedClipIds && selectedClipIds.length === 1)
            ? clips.find(c => c.id === selectedClipIds[0]) || null
            : null
    ), [clips, selectedClipIds]);

    // ------ effective crop center at the current playheadT ------
    // For manual focus mode we walk the user's keyframes and use the
    // LAST keyframe whose t <= playheadT (consistent with the backend's
    // reframe_kf.py hard-cut behaviour). For 'auto' / 'center' we fall
    // back to the source frame's centre since we don't know where the
    // backend's face tracker will land until render time.
    const effectiveCenter = useMemo(() => {
        if (!selectedClip) return { x: 0.5, y: 0.5 };
        const kfs = (selectedClip.manual_keyframes || []).slice().sort((a, b) => a.t - b.t);
        if (selectedClip.focus_mode === 'manual' && kfs.length > 0) {
            let active = kfs[0];
            for (const kf of kfs) {
                if (kf.t <= playheadT) active = kf;
                else break;
            }
            return { x: active.x, y: active.y };
        }
        return { x: 0.5, y: 0.5 };
    }, [selectedClip, playheadT]);

    // Compute the crop box's fractional size based on source aspect.
    const targetAspect = 9 / 16;
    const srcAspect = (sourceDims?.w || 16) / (sourceDims?.h || 9);
    const widthFrac = srcAspect >= targetAspect ? targetAspect / srcAspect : 1;
    const heightFrac = srcAspect >= targetAspect ? 1 : srcAspect / targetAspect;

    // ---------- drag handler ----------
    function xyFromMouse(clientX, clientY) {
        const rect = frameRef.current?.getBoundingClientRect();
        if (!rect) return null;
        // Video uses object-fit:cover (full container). Position is
        // direct fraction of the visible rectangle.
        const cx = (clientX - rect.left) / rect.width;
        const cy = (clientY - rect.top) / rect.height;
        // Clamp so the crop rectangle stays inside the frame.
        const minX = widthFrac / 2;
        const maxX = 1 - widthFrac / 2;
        const minY = heightFrac / 2;
        const maxY = 1 - heightFrac / 2;
        return {
            x: Math.max(minX, Math.min(maxX, cx)),
            y: Math.max(minY, Math.min(maxY, cy)),
        };
    }

    function upsertKeyframeAt(t, x, y) {
        if (!selectedClip) return;
        const existing = (selectedClip.manual_keyframes || []).slice();
        // Snap-merge: if there's already a keyframe within 0.15s of t,
        // update it instead of adding a new one. Keeps the keyframe
        // list compact while dragging.
        const idx = existing.findIndex(kf => Math.abs(kf.t - t) < 0.15);
        if (idx >= 0) {
            existing[idx] = { ...existing[idx], x, y, cut: true };
        } else {
            existing.push({ t: +t.toFixed(3), x: +x.toFixed(4), y: +y.toFixed(4), cut: true });
            existing.sort((a, b) => a.t - b.t);
        }
        onUpdateClip(selectedClip.id, {
            focus_mode: 'manual',
            manual_keyframes: existing,
        });
    }

    function handleOverlayMouseDown(e) {
        if (!selectedClip) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
        const xy = xyFromMouse(e.clientX, e.clientY);
        if (xy) upsertKeyframeAt(playheadT, xy.x, xy.y);
    }

    useEffect(() => {
        if (!isDragging) return;
        function onMove(e) {
            const xy = xyFromMouse(e.clientX, e.clientY);
            if (xy) upsertKeyframeAt(playheadT, xy.x, xy.y);
        }
        function onUp() { setIsDragging(false); }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [isDragging, playheadT, selectedClip, widthFrac, heightFrac]);

    // ---------- keyframe controls ----------
    const nearKeyframeIdx = useMemo(() => {
        if (!selectedClip) return -1;
        return (selectedClip.manual_keyframes || []).findIndex(
            kf => Math.abs(kf.t - playheadT) < 0.2
        );
    }, [selectedClip, playheadT]);

    function addKeyframeHere() {
        if (!selectedClip) return;
        upsertKeyframeAt(playheadT, effectiveCenter.x, effectiveCenter.y);
    }

    function removeNearKeyframe() {
        if (!selectedClip || nearKeyframeIdx < 0) return;
        const next = (selectedClip.manual_keyframes || []).filter((_, i) => i !== nearKeyframeIdx);
        onUpdateClip(selectedClip.id, { manual_keyframes: next });
    }

    function resetClipFocus(mode) {
        if (!selectedClip) return;
        onUpdateClip(selectedClip.id, {
            focus_mode: mode,
            manual_keyframes: mode === 'manual' ? selectedClip.manual_keyframes || [] : [],
        });
    }

    // Convert kf list into pixel positions for the keyframe strip.
    const clipDuration = selectedClip
        ? selectedClip.time_ranges.reduce((s, r) => s + (r.end - r.start), 0)
        : 0;

    return (
        <div className="relative w-full max-w-3xl">
            <div
                ref={frameRef}
                className="relative bg-black rounded-lg overflow-hidden shadow-2xl select-none"
                style={{ aspectRatio: `${aspect}` }}
            >
                {videoUrl ? (
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        className="w-full h-full pointer-events-none"
                        onTimeUpdate={onTimeUpdate}
                    />
                ) : (
                    <div className="flex items-center justify-center h-full text-zinc-500 text-sm">Loading…</div>
                )}

                {/* Draggable 9:16 crop overlay. */}
                <div
                    onMouseDown={handleOverlayMouseDown}
                    className={`absolute border-2 transition-colors ${isDragging
                        ? 'border-pink-300 shadow-[0_0_30px_rgba(244,114,182,0.7)] cursor-grabbing'
                        : 'border-fuchsia-400/90 shadow-[0_0_20px_rgba(217,70,239,0.5)] cursor-grab hover:border-fuchsia-300'}`}
                    style={{
                        left: `${(effectiveCenter.x - widthFrac / 2) * 100}%`,
                        top: `${(effectiveCenter.y - heightFrac / 2) * 100}%`,
                        width: `${widthFrac * 100}%`,
                        height: `${heightFrac * 100}%`,
                    }}
                    title={selectedClip
                        ? 'Drag to reframe — a hard-cut keyframe is added at the current playhead time'
                        : 'Select a clip to enable drag-to-reframe'}
                >
                    <div className="absolute -top-6 left-0 text-[10px] uppercase tracking-wider text-fuchsia-300 font-semibold bg-zinc-900/80 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <MoveHorizontal size={10} /> 9:16 crop — drag to reframe
                    </div>
                    {/* Centre crosshair */}
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-fuchsia-300/80 ring-2 ring-fuchsia-500/30" />
                    {/* Per-edge resize-cursor cues — we don't actually
                        resize, but the visual hint helps users realise
                        the box is interactive. */}
                </div>

                {/* "Play" giant button overlay — captures clicks ON the
                    video area outside the crop box so the user has an
                    obvious way to start playback. */}
                {!isPlaying && videoUrl && (
                    <button
                        type="button"
                        onClick={onPlayToggle}
                        className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/20 transition"
                        style={{
                            // Don't intercept clicks inside the crop overlay
                            clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)',
                        }}
                    >
                        <div className="rounded-full bg-fuchsia-500/90 hover:bg-fuchsia-400 p-4 shadow-2xl">
                            <Play size={28} className="text-white ml-1" />
                        </div>
                    </button>
                )}
            </div>

            {/* Transport row */}
            <div className="mt-3 flex items-center justify-center gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={onPlayToggle}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 text-white text-sm font-semibold"
                >
                    {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    {isPlaying ? 'Pause' : 'Play'}
                </button>
                <div className="text-zinc-400 font-mono text-xs tabular-nums">{formatTime(playheadT)}</div>
            </div>

            {/* Inline focus-tracking controls — only show when a clip
                is the single-focus selection. */}
            {selectedClip && (
                <div className="mt-4 rounded-lg border border-white/10 bg-zinc-900/60 p-3">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                        <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold mr-1">
                            Focus tracking
                        </div>
                        <FocusModeButton active={selectedClip.focus_mode === 'auto'} icon={Camera} label="Auto speaker" onClick={() => resetClipFocus('auto')} />
                        <FocusModeButton active={selectedClip.focus_mode === 'manual'} icon={MoveHorizontal} label="Manual" onClick={() => resetClipFocus('manual')} />
                        <FocusModeButton active={selectedClip.focus_mode === 'center'} icon={Eye} label="Center" onClick={() => resetClipFocus('center')} />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            type="button"
                            onClick={addKeyframeHere}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-fuchsia-500/15 hover:bg-fuchsia-500/25 text-fuchsia-200 border border-fuchsia-500/30 text-xs font-medium"
                            title="Add a hard-cut keyframe at the current playhead time"
                        >
                            <Plus size={12} /> Keyframe at {formatTime(playheadT)}
                        </button>
                        <button
                            type="button"
                            onClick={removeNearKeyframe}
                            disabled={nearKeyframeIdx < 0}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-zinc-800 text-zinc-300 border border-white/10 text-xs"
                            title="Remove the keyframe at this playhead time"
                        >
                            <Trash2 size={12} /> Remove keyframe here
                        </button>
                        <div className="text-[11px] text-zinc-500 ml-auto">
                            {(selectedClip.manual_keyframes || []).length} keyframe{(selectedClip.manual_keyframes || []).length === 1 ? '' : 's'}
                        </div>
                    </div>

                    {/* Keyframe strip — shows positions across the
                        clip's local timeline (not the full source). */}
                    {(selectedClip.manual_keyframes || []).length > 0 && (
                        <KeyframeStrip
                            clip={selectedClip}
                            playheadT={playheadT}
                            clipDuration={clipDuration}
                            onRemove={(i) => {
                                const next = (selectedClip.manual_keyframes || []).filter((_, idx) => idx !== i);
                                onUpdateClip(selectedClip.id, { manual_keyframes: next });
                            }}
                        />
                    )}

                    <div className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
                        Tip: drag the magenta box in the preview to mark a hard cut at the playhead. Or click "+ Keyframe at …" then drag.
                    </div>
                </div>
            )}
        </div>
    );
}

function FocusModeButton({ active, icon: Icon, label, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border transition ${active ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:text-white'}`}
        >
            <Icon size={11} /> {label}
        </button>
    );
}

// Visual strip of all keyframes in a clip's timeline, mapped onto the
// clip's concatenated duration (sum of all time_ranges). Clicking a
// marker shows its precise time; ⌥-click removes it. Hover shows time.
function KeyframeStrip({ clip, playheadT, clipDuration, onRemove }) {
    // Find which range the playhead is in (or nearest), and where the
    // current playhead sits along the clip-local timeline.
    const clipLocalT = useMemo(() => {
        let acc = 0;
        for (const r of clip.time_ranges) {
            if (playheadT >= r.start && playheadT <= r.end) return acc + (playheadT - r.start);
            acc += r.end - r.start;
        }
        return null;
    }, [clip, playheadT]);

    function srcTimeToClipLocal(t) {
        // Walk the time_ranges and figure out where source-time `t`
        // lands on the clip's concatenated local timeline. Returns
        // null if t is outside any range.
        let acc = 0;
        for (const r of clip.time_ranges) {
            if (t >= r.start && t <= r.end) return acc + (t - r.start);
            acc += r.end - r.start;
        }
        return null;
    }

    const totalDur = Math.max(0.001, clipDuration);
    return (
        <div className="mt-2 relative h-7 bg-zinc-800/60 rounded border border-white/5">
            {/* Range backgrounds — show which slices of the clip we
                actually keep. */}
            <div className="absolute inset-0 flex">
                <div className="flex-1 bg-fuchsia-500/5" />
            </div>
            {/* Keyframe markers */}
            {(clip.manual_keyframes || []).map((kf, i) => {
                const local = srcTimeToClipLocal(kf.t);
                if (local == null) return null;
                const pct = (local / totalDur) * 100;
                return (
                    <button
                        key={i}
                        type="button"
                        onClick={(e) => {
                            if (e.altKey) onRemove(i);
                        }}
                        title={`t=${kf.t.toFixed(2)}s · x=${(kf.x * 100).toFixed(0)}% · y=${(kf.y * 100).toFixed(0)}% — ⌥-click to remove`}
                        className="absolute top-1 bottom-1 w-2 -ml-1 rounded bg-fuchsia-400 hover:bg-fuchsia-300 shadow"
                        style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
                    />
                );
            })}
            {/* Playhead marker on this strip */}
            {clipLocalT != null && (
                <div
                    className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
                    style={{ left: `${(clipLocalT / totalDur) * 100}%` }}
                >
                    <div className="absolute -top-1 -left-1 w-2 h-2 rotate-45 bg-red-500" />
                </div>
            )}
        </div>
    );
}

// ===========================================================================
// THE TIMELINE — pro-grade interactive
// ===========================================================================
function H2VTimeline({ duration, playheadT, onSeek, transcript, clips, selectedClipIds, onSelectClip, onClipDrag, zoom, setZoom, jobId, onAddRange }) {
    const trackRef = useRef(null);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [viewportWidth, setViewportWidth] = useState(800);
    const [waveform, setWaveform] = useState(null);
    const [drag, setDrag] = useState(null);  // {type: 'play'|'range', clipId?, rangeIdx?, edge?, originX, originT}

    // Compute pixel-per-second based on zoom.
    const pxPerSec = useMemo(() => {
        if (!duration) return 8;
        // Base scale: viewport fits the entire duration at zoom=1.
        const base = (viewportWidth - 40) / duration;
        return Math.max(0.5, base * zoom);
    }, [duration, zoom, viewportWidth]);

    const totalWidth = duration * pxPerSec + 40;

    // Resize observer for viewport width.
    useEffect(() => {
        const el = trackRef.current?.parentElement;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) setViewportWidth(e.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Fetch waveform once we have a jobId.
    useEffect(() => {
        if (!jobId) return;
        let alive = true;
        (async () => {
            try {
                const r = await fetch(getApiUrl(`/api/h2v/${jobId}/waveform?bins=400`));
                if (!r.ok) return;
                const d = await r.json();
                if (alive) setWaveform(d);
            } catch {}
        })();
        return () => { alive = false; };
    }, [jobId]);

    // Keep playhead in view.
    useEffect(() => {
        const wrap = trackRef.current?.parentElement;
        if (!wrap) return;
        const px = playheadT * pxPerSec + 20;
        const margin = 80;
        if (px < wrap.scrollLeft + margin) wrap.scrollLeft = Math.max(0, px - margin);
        else if (px > wrap.scrollLeft + wrap.clientWidth - margin)
            wrap.scrollLeft = px - wrap.clientWidth + margin;
    }, [playheadT, pxPerSec]);

    // Convert client X to seconds.
    function xToT(clientX) {
        const wrap = trackRef.current;
        if (!wrap) return 0;
        const rect = wrap.getBoundingClientRect();
        const localX = clientX - rect.left + wrap.scrollLeft;
        return Math.max(0, Math.min(duration, (localX - 20) / pxPerSec));
    }

    function onTrackMouseDown(e) {
        const t = xToT(e.clientX);
        onSeek(t);
        setDrag({ type: 'play', originX: e.clientX, originT: t });
        e.preventDefault();
    }

    function onClipMouseDown(e, clipId, rangeIdx, edge) {
        e.stopPropagation();
        if (edge) {
            // Resize handle.
            setDrag({ type: 'resize', clipId, rangeIdx, edge, originX: e.clientX, originT: xToT(e.clientX) });
        } else {
            // Whole-clip click: select. Modifier-aware.
            onSelectClip(clipId, e.metaKey || e.ctrlKey || e.shiftKey);
            setDrag({ type: 'move', clipId, rangeIdx, originX: e.clientX, originT: xToT(e.clientX) });
        }
        e.preventDefault();
    }

    useEffect(() => {
        if (!drag) return;
        function onMove(e) {
            const t = xToT(e.clientX);
            if (drag.type === 'play') {
                onSeek(t);
            } else if (drag.type === 'resize') {
                const clip = clips.find(c => c.id === drag.clipId);
                if (!clip) return;
                const r = clip.time_ranges[drag.rangeIdx];
                if (drag.edge === 'left') {
                    onClipDrag(drag.clipId, drag.rangeIdx, { start: Math.max(0, Math.min(r.end - 0.2, t)) });
                } else {
                    onClipDrag(drag.clipId, drag.rangeIdx, { end: Math.max(r.start + 0.2, Math.min(duration, t)) });
                }
            } else if (drag.type === 'move') {
                const dt = t - drag.originT;
                if (Math.abs(dt) < 0.02) return;
                const clip = clips.find(c => c.id === drag.clipId);
                if (!clip) return;
                const r = clip.time_ranges[drag.rangeIdx];
                const dur = r.end - r.start;
                const newStart = Math.max(0, Math.min(duration - dur, r.start + dt));
                onClipDrag(drag.clipId, drag.rangeIdx, { start: newStart, end: newStart + dur });
                setDrag(d => ({ ...d, originT: t }));
            }
        }
        function onUp() { setDrag(null); }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag, clips, duration, pxPerSec, onClipDrag, onSeek]);

    // Wheel: ctrl/cmd = zoom, otherwise normal horizontal scroll.
    function onWheel(e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            setZoom(z => Math.max(0.25, Math.min(8, z * factor)));
        }
    }

    // Timeline ruler (every N seconds depending on zoom).
    const ruler = useMemo(() => {
        if (!duration) return [];
        const tickEverySec = pxPerSec > 30 ? 1 : pxPerSec > 10 ? 5 : pxPerSec > 4 ? 15 : pxPerSec > 1.5 ? 30 : 60;
        const ticks = [];
        for (let t = 0; t <= duration + 0.001; t += tickEverySec) {
            ticks.push(t);
        }
        return ticks;
    }, [duration, pxPerSec]);

    return (
        <div>
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 text-[11px] text-zinc-400">
                <div>Timeline</div>
                <div className="flex-1" />
                <div className="font-mono">{formatTime(playheadT)} / {formatTime(duration)}</div>
                <div className="text-zinc-600 ml-2">Zoom {zoom.toFixed(1)}×</div>
            </div>

            {/* Scroll viewport */}
            <div
                className="overflow-x-auto custom-scrollbar select-none"
                onWheel={onWheel}
                style={{ maxHeight: '300px' }}
            >
                <div
                    ref={trackRef}
                    className="relative"
                    style={{ width: `${totalWidth}px`, paddingLeft: 20, paddingRight: 20 }}
                    onMouseDown={onTrackMouseDown}
                    onDoubleClick={(e) => { e.preventDefault(); onAddRange(); }}
                >
                    {/* Ruler */}
                    <div className="relative h-6 border-b border-white/10">
                        {ruler.map(t => (
                            <div
                                key={t}
                                className="absolute top-0 bottom-0 border-l border-white/10"
                                style={{ left: `${t * pxPerSec}px` }}
                            >
                                <div className="absolute top-0 left-1 text-[10px] text-zinc-500 font-mono">{formatTime(t)}</div>
                            </div>
                        ))}
                    </div>

                    {/* Waveform */}
                    <div className="relative h-10 border-b border-white/5">
                        {waveform?.data?.length && duration > 0 && (
                            <svg
                                className="absolute inset-0"
                                width={duration * pxPerSec}
                                height={40}
                                preserveAspectRatio="none"
                                viewBox={`0 0 ${waveform.data.length} 40`}
                            >
                                {waveform.data.map((v, i) => {
                                    const h = Math.max(1, v * 38);
                                    return (
                                        <rect key={i} x={i + 0.1} y={20 - h / 2} width={0.8} height={h}
                                              fill="rgba(217,70,239,0.45)" />
                                    );
                                })}
                            </svg>
                        )}
                    </div>

                    {/* Transcript track */}
                    <div className="relative h-7 border-b border-white/5">
                        {transcript.map((seg, i) => {
                            const left = seg.start * pxPerSec;
                            const w = Math.max(1, (seg.end - seg.start) * pxPerSec);
                            return (
                                <div
                                    key={i}
                                    className="absolute top-1 bottom-1 px-1 text-[10px] text-zinc-400 bg-zinc-800/50 border border-white/5 rounded overflow-hidden whitespace-nowrap"
                                    style={{ left, width: w }}
                                    title={seg.text}
                                >
                                    {seg.text}
                                </div>
                            );
                        })}
                    </div>

                    {/* Clip ribbons */}
                    <div className="relative" style={{ minHeight: 40 }}>
                        {clips.map((c, ci) => {
                            const sel = selectedClipIds.includes(c.id);
                            return c.time_ranges.map((r, ri) => {
                                const left = r.start * pxPerSec;
                                const w = Math.max(4, (r.end - r.start) * pxPerSec);
                                return (
                                    <div
                                        key={`${c.id}_${ri}`}
                                        className={`absolute h-8 rounded cursor-grab active:cursor-grabbing flex items-center justify-center text-[10px] text-white font-semibold overflow-hidden border ${sel ? 'border-white shadow-lg' : 'border-white/20'}`}
                                        style={{
                                            left, width: w, top: 6,
                                            background: c.color,
                                            opacity: sel ? 1 : 0.85,
                                        }}
                                        onMouseDown={(e) => onClipMouseDown(e, c.id, ri, null)}
                                        title={c.title}
                                    >
                                        {/* Left resize handle */}
                                        <div
                                            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 hover:bg-white"
                                            onMouseDown={(e) => onClipMouseDown(e, c.id, ri, 'left')}
                                        />
                                        <span className="truncate px-2 pointer-events-none">{c.title}{c.time_ranges.length > 1 ? ` · pt ${ri+1}/${c.time_ranges.length}` : ''}</span>
                                        {/* Right resize handle */}
                                        <div
                                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 hover:bg-white"
                                            onMouseDown={(e) => onClipMouseDown(e, c.id, ri, 'right')}
                                        />
                                    </div>
                                );
                            });
                        })}
                    </div>

                    {/* Playhead */}
                    <div
                        className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-20"
                        style={{ left: `${playheadT * pxPerSec + 20}px` }}
                    >
                        <div className="absolute -top-1 -left-1.5 w-3 h-3 rotate-45 bg-red-500" />
                    </div>
                </div>
            </div>
            <div className="px-4 py-1 text-[10px] text-zinc-500 border-t border-white/5">
                Tip: drag the ruler to scrub. Drag a clip ribbon to move it. Drag the edge to resize. Double-click empty timeline to add a clip.
            </div>
        </div>
    );
}
