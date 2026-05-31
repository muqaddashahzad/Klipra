import React, { useEffect, useState } from 'react';
import { History, Loader2, RefreshCw, Trash2, Play, Download, RotateCcw, Check, X, CheckSquare, Square, Languages } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Past projects panel rendered INSIDE a standalone feature page
 * (Subtitle / Dub). Filters /api/standalone/list by `kind`, so each
 * feature only shows its own history — no cross-pollution with clip
 * generation jobs from the top-bar Past Projects.
 *
 * Click a card → onOpen(job) lets the parent surface the result panel
 * with its preserved video. Trash button → DELETE /api/standalone/{id}.
 */
export default function StandalonePastList({ kind, accent = 'orange', onOpen, onResume, onRedub, llmHeaders }) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Multi-select state. `selectMode` toggles checkboxes per card;
    // `selected` holds the set of job_ids currently checked. Both
    // reset on refresh / kind change so the UI never shows stale
    // selections after the underlying list rotates.
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState(new Set());
    const [bulkBusy, setBulkBusy] = useState(false);

    const refresh = async () => {
        setLoading(true);
        setError(null);
        try {
            const r = await fetch(getApiUrl(`/api/standalone/list?kind=${encodeURIComponent(kind)}`));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            setJobs(data.jobs || []);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        refresh();
        // Drop any stale selection state when the kind switches —
        // jobs from one feature shouldn't carry over.
        setSelectMode(false);
        setSelected(new Set());
        /* eslint-disable-next-line */
    }, [kind]);

    const handleDelete = async (jobId) => {
        if (!confirm('Delete this past project? This cannot be undone.')) return;
        try {
            const r = await fetch(getApiUrl(`/api/standalone/${jobId}`), { method: 'DELETE' });
            if (!r.ok) throw new Error(await r.text());
            setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
            setSelected((prev) => {
                const next = new Set(prev); next.delete(jobId); return next;
            });
        } catch (e) {
            alert('Could not delete: ' + (e.message || e));
        }
    };

    // Toggle one job in/out of the selection set. Used by the
    // checkbox overlay shown on each card in select mode.
    const toggleSelected = (jobId) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
            return next;
        });
    };
    const selectAll = () => setSelected(new Set(jobs.map((j) => j.job_id)));
    const selectNone = () => setSelected(new Set());

    // Bulk delete the selected jobs (or every job, if `all` is true).
    // We hit the per-job DELETE endpoint in parallel — Promise.all
    // collects failures so a single bad ID doesn't abort the rest.
    const handleBulkDelete = async (all = false) => {
        const ids = all ? jobs.map((j) => j.job_id) : Array.from(selected);
        if (ids.length === 0) return;
        const noun = ids.length === 1 ? 'project' : 'projects';
        if (!confirm(`Delete ${ids.length} ${noun}? This cannot be undone.`)) return;
        setBulkBusy(true);
        const results = await Promise.allSettled(ids.map((id) =>
            fetch(getApiUrl(`/api/standalone/${id}`), { method: 'DELETE' })
                .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return id; })
        ));
        const ok = new Set(
            results
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value)
        );
        const failed = ids.length - ok.size;
        setJobs((prev) => prev.filter((j) => !ok.has(j.job_id)));
        setSelected(new Set());
        setSelectMode(false);
        setBulkBusy(false);
        if (failed > 0) {
            alert(`${ok.size} deleted, ${failed} failed. Try refreshing the list.`);
        }
    };

    // Kick off a resume for a job that was interrupted/failed mid-pipeline.
    // Backend skips any stages whose checkpoint is already on disk and
    // re-runs only what's missing, so the user pays for at most ONE
    // round of retry — never the whole pipeline.
    const handleResume = async (job) => {
        try {
            const r = await fetch(getApiUrl(`/api/standalone/${job.job_id}/resume`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(llmHeaders || {}) },
            });
            if (!r.ok) throw new Error(await r.text());
            // Hand the job up to the parent so it can switch to the
            // running view and start polling for status updates.
            onResume?.(job);
            // Optimistic refresh so the card flips to running state.
            setTimeout(refresh, 500);
        } catch (e) {
            alert('Could not resume: ' + (e.message || e));
        }
    };

    if (jobs.length === 0 && !loading && !error) return null; // hide entirely when empty

    const accentMap = {
        orange: { dot: 'text-orange-300', bg: 'border-orange-500/20 bg-orange-500/5' },
        emerald: { dot: 'text-emerald-300', bg: 'border-emerald-500/20 bg-emerald-500/5' },
    };
    const ac = accentMap[accent] || accentMap.orange;

    const selectedCount = selected.size;
    const allSelected = jobs.length > 0 && selectedCount === jobs.length;

    return (
        <div className={`rounded-xl border ${ac.bg} p-4 mb-6`}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className={`text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5 ${ac.dot}`}>
                    <History size={12} /> Past {kind} projects
                    {jobs.length > 0 && <span className="text-zinc-500 normal-case">· {jobs.length}</span>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                    {!selectMode ? (
                        <>
                            <button
                                onClick={() => setSelectMode(true)}
                                disabled={loading || jobs.length === 0}
                                className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                                title="Select multiple projects to delete at once"
                            >
                                Select
                            </button>
                            <button
                                onClick={() => handleBulkDelete(true)}
                                disabled={loading || jobs.length === 0 || bulkBusy}
                                className="text-[10px] uppercase tracking-wider font-bold text-red-300 hover:text-red-100 px-2 py-1 rounded border border-red-500/30 hover:border-red-500/50 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition"
                                title="Delete every project in this list"
                            >
                                Delete all
                            </button>
                            <button
                                onClick={refresh}
                                disabled={loading}
                                className="text-zinc-400 hover:text-white p-1 rounded disabled:opacity-50"
                            >
                                {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Select-mode toolbar — counts, select-all/none,
                                bulk delete, and an X to bail out without
                                accidentally wiping anything. */}
                            <span className="text-[10px] text-zinc-300">
                                {selectedCount} of {jobs.length} selected
                            </span>
                            <button
                                onClick={allSelected ? selectNone : selectAll}
                                disabled={bulkBusy}
                                className="text-[10px] uppercase tracking-wider font-bold text-zinc-300 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20 transition flex items-center gap-1"
                            >
                                {allSelected ? <CheckSquare size={11} /> : <Square size={11} />}
                                {allSelected ? 'Deselect all' : 'Select all'}
                            </button>
                            <button
                                onClick={() => handleBulkDelete(false)}
                                disabled={selectedCount === 0 || bulkBusy}
                                className="text-[10px] uppercase tracking-wider font-bold text-red-200 px-2 py-1 rounded border border-red-500/40 bg-red-500/15 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1"
                            >
                                {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                                Delete {selectedCount > 0 ? selectedCount : ''}
                            </button>
                            <button
                                onClick={() => { setSelectMode(false); setSelected(new Set()); }}
                                disabled={bulkBusy}
                                title="Exit select mode"
                                className="text-zinc-400 hover:text-white p-1 rounded"
                            >
                                <X size={12} />
                            </button>
                        </>
                    )}
                </div>
            </div>
            {error && <p className="text-[11px] text-red-300 mb-2">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {jobs.map((j) => (
                    <PastCard
                        key={j.job_id}
                        job={j}
                        selectMode={selectMode}
                        isSelected={selected.has(j.job_id)}
                        onToggleSelect={() => toggleSelected(j.job_id)}
                        onOpen={() => onOpen?.(j)}
                        onResume={() => handleResume(j)}
                        onRedub={onRedub ? (() => onRedub(j)) : null}
                        onDelete={() => handleDelete(j.job_id)}
                    />
                ))}
            </div>
        </div>
    );
}

function PastCard({ job, onOpen, onResume, onRedub, onDelete, selectMode = false, isSelected = false, onToggleSelect }) {
    const created = job.created_at
        ? new Date(job.created_at * 1000).toLocaleString()
        : 'Unknown date';
    const statusColor = {
        completed: 'text-green-400 bg-green-500/10 border-green-500/20',
        failed: 'text-red-400 bg-red-500/10 border-red-500/20',
        // 'missing' = backend says the job completed but the mp4 has been
        // removed from disk. Surface it loudly so the user knows why the
        // card won't play and can clean it up with a single click.
        missing: 'text-red-300 bg-red-500/15 border-red-500/30',
        // 'saved_draft' = user clicked "Save for later" in Phase 2. No
        // mp4 yet, but transcript + styling are stored. Click to resume.
        saved_draft: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
        rendering: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
        transcribing: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        cleaning: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        translating: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        transcript_ready: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    }[job.status] || 'text-zinc-400 bg-white/5 border-white/10';

    const isMissing = job.status === 'missing';
    const isDraft = job.status === 'saved_draft' || !!job.is_draft;
    // 'interrupted' / 'failed' jobs that have a saved checkpoint show a
    // Resume button. Without a checkpoint the backend filters them out
    // before we ever see them, so any failed/interrupted card here is
    // guaranteed resumable.
    const isResumable = !!job.is_resumable && (job.status === 'interrupted' || job.status === 'failed');
    // In-progress states surfaced in the list so users can re-attach
    // to a still-running backend job after a browser refresh — exactly
    // the "stuck on cleaning, refreshed, project gone" complaint.
    const RUNNING_STATES = ['queued', 'transcribing', 'cleaning', 'translating', 'rendering', 'transcript_ready'];
    const isRunning = RUNNING_STATES.includes(job.status);
    const hasVideo = !!job.video_url && !isMissing && !isDraft && !isResumable && !isRunning;
    // Card is clickable when there's something to land on: completed
    // playback, draft to resume editing, or an in-progress job to
    // re-attach polling to.
    const playable = (hasVideo && job.status === 'completed') || isDraft || isRunning;

    // In select mode, the entire card becomes a checkbox toggle. We
    // gate `onOpen` so users can't accidentally enter a project while
    // bulk-deleting; the only click target is "select / deselect this
    // card." Visual cue: blue ring when selected.
    const cardOuter = 'group rounded-lg border bg-black/20 hover:bg-black/40 transition overflow-hidden ' +
        (selectMode
            ? (isSelected ? 'border-blue-400/70 ring-2 ring-blue-400/40' : 'border-white/10 hover:border-white/30')
            : 'border-white/10 hover:border-white/20');

    return (
        <div className={cardOuter}>
            <button
                onClick={selectMode ? onToggleSelect : onOpen}
                disabled={!selectMode && !playable}
                className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60 relative"
            >
                {/* Checkbox overlay — only rendered in select mode.
                    Sits on top of the thumbnail so the card itself is
                    still legible underneath. */}
                {selectMode && (
                    <div className="absolute top-2 right-2 z-30 w-6 h-6 rounded-md border-2 flex items-center justify-center pointer-events-none "
                         style={{
                             borderColor: isSelected ? 'rgb(96 165 250)' : 'rgba(255,255,255,0.4)',
                             background: isSelected ? 'rgba(96, 165, 250, 0.9)' : 'rgba(0,0,0,0.6)',
                         }}>
                        {isSelected && <Check size={14} className="text-white" />}
                    </div>
                )}
                <div className="aspect-video bg-black relative">
                    {hasVideo ? (
                        <video src={getApiUrl(job.video_url)} muted playsInline preload="metadata"
                            className="w-full h-full object-cover" />
                    ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-zinc-500">
                            <History size={24} />
                            {isMissing && (
                                <span className="text-[9px] uppercase tracking-wider text-red-300">
                                    File removed
                                </span>
                            )}
                            {isDraft && (
                                <span className="text-[9px] uppercase tracking-wider text-blue-300">
                                    Draft · click to resume
                                </span>
                            )}
                            {isResumable && (
                                <span className="text-[9px] uppercase tracking-wider text-amber-300 text-center px-3 leading-tight">
                                    Interrupted ·<br/>checkpoint saved
                                </span>
                            )}
                            {isRunning && (
                                <span className="text-[9px] uppercase tracking-wider text-yellow-300 text-center px-3 leading-tight flex flex-col items-center gap-1">
                                    <Loader2 size={14} className="animate-spin" />
                                    {job.status} ·<br/>click to re-attach
                                </span>
                            )}
                        </div>
                    )}
                    {playable && hasVideo && (
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                            <Play size={28} className="text-white" />
                        </div>
                    )}
                    <div className={`absolute top-1.5 left-1.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border font-bold ${statusColor}`}>
                        {isDraft ? 'draft' : job.status}
                    </div>
                </div>
                <div className="p-2.5 space-y-0.5">
                    <div className="text-[12px] font-medium text-white truncate" title={job.title}>
                        {job.title}
                    </div>
                    <div className="text-[10px] text-zinc-500 flex items-center justify-between gap-2">
                        <span className="truncate">{created}</span>
                        {job.language && <span className="uppercase shrink-0 text-zinc-400">{job.language}</span>}
                    </div>
                    {isMissing && (
                        <div className="text-[10px] text-red-300/90 leading-snug pt-1">
                            Video file is no longer on disk. Delete to clear.
                        </div>
                    )}
                </div>
            </button>
            <div className="flex items-center justify-end gap-1 px-2 pb-2">
                {isResumable && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onResume?.(); }}
                        className="text-amber-300 hover:text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 transition mr-auto"
                        title="Resume from last checkpoint"
                    >
                        <RotateCcw size={11} /> Resume
                    </button>
                )}
                {/* "Dub →" — only shown for completed projects whose
                    parent passed an onRedub handler. The parent gates
                    this on having a saved transcript checkpoint, so the
                    button only appears when redub is actually possible.
                    Clicking it lets the user generate a NEW dub in a
                    different language without re-running Whisper. */}
                {onRedub && job.status === 'completed' && hasVideo && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onRedub(); }}
                        className="text-emerald-300 hover:text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 px-2 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 transition mr-auto"
                        title="Generate a new dub in another language using the saved transcript (skips re-transcription)"
                    >
                        <Languages size={11} /> Dub →
                    </button>
                )}
                {playable && (
                    <a href={getApiUrl(job.video_url)} download
                        onClick={(e) => e.stopPropagation()}
                        className="text-zinc-500 hover:text-emerald-300 p-1"
                        title="Download">
                        <Download size={12} />
                    </a>
                )}
                <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="text-zinc-500 hover:text-red-400 p-1"
                    title="Delete">
                    <Trash2 size={12} />
                </button>
            </div>
        </div>
    );
}
