import React, { useEffect, useState } from 'react';
import { Loader2, History, Trash2, Play, RefreshCw, Check, X, CheckSquare, Square } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Past Projects view. Lists every clip-generation job (in-memory +
 * on-disk leftovers). Click a card to load it back into the Clip
 * Generator. Click the trash icon to wipe it.
 *
 * `compact` mode (used inside the Clip Generator landing page) drops
 * the fullscreen chrome, shows a slimmer accent header, and AUTO-HIDES
 * when there are zero past jobs — same UX pattern as the per-feature
 * StandalonePastList used inside Subtitle / Dub.
 */
export default function PastProjects({ onOpen, onDelete, compact = false }) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Multi-select. Same shape as StandalonePastList — Set of job_ids
    // that are currently checked, plus a `selectMode` toggle so the
    // checkbox UI only appears when the user explicitly opts in.
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState(new Set());
    const [bulkBusy, setBulkBusy] = useState(false);

    const toggleSelected = (jobId) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
            return next;
        });
    };
    const selectAll = () => setSelected(new Set(jobs.map((j) => j.job_id)));
    const selectNone = () => setSelected(new Set());

    // Bulk delete — fans out individual DELETEs in parallel via the
    // parent-supplied onDelete callback (which already handles the
    // confirm + DELETE round-trip). We swallow per-id failures and
    // surface a summary so one stuck job doesn't abort the rest.
    const handleBulkDelete = async (all = false) => {
        const ids = all ? jobs.map((j) => j.job_id) : Array.from(selected);
        if (ids.length === 0) return;
        const noun = ids.length === 1 ? 'project' : 'projects';
        if (!confirm(`Delete ${ids.length} ${noun}? This cannot be undone.`)) return;
        setBulkBusy(true);
        const results = await Promise.allSettled(
            ids.map((id) => fetch(getApiUrl(`/api/job/${id}`), { method: 'DELETE' })
                .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return id; }))
        );
        const ok = new Set(
            results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
        );
        setJobs((prev) => prev.filter((j) => !ok.has(j.job_id)));
        setSelected(new Set());
        setSelectMode(false);
        setBulkBusy(false);
        const failed = ids.length - ok.size;
        if (failed > 0) alert(`${ok.size} deleted, ${failed} failed. Try refreshing.`);
    };

    async function refresh() {
        setLoading(true);
        setError(null);
        try {
            const r = await fetch(getApiUrl('/api/jobs/list'));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            setJobs(data.jobs || []);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setLoading(false);
        }
    }
    useEffect(() => { refresh(); }, []);

    // Compact (embedded) variant — sized to sit at the top of the
    // Clip Generator page. Mirrors StandalonePastList's auto-hide so
    // first-time users see a clean idle page.
    if (compact) {
        if (jobs.length === 0 && !loading && !error) return null;
        const selectedCount = selected.size;
        const allSelected = jobs.length > 0 && selectedCount === jobs.length;
        return (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 mb-6">
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                    <div className="text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5 text-primary">
                        <History size={12} /> Past clip projects
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
                {error && (
                    <div className="mb-2 p-2 rounded-md border border-red-500/40 bg-red-500/10 text-[11px] text-red-300">
                        {error}
                    </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {jobs.map((job) => (
                        <ProjectCard
                            key={job.job_id}
                            job={job}
                            selectMode={selectMode}
                            isSelected={selected.has(job.job_id)}
                            onToggleSelect={() => toggleSelected(job.job_id)}
                            onOpen={() => onOpen?.(job.job_id)}
                            onDelete={async () => {
                                await onDelete?.(job.job_id);
                                setJobs((prev) => prev.filter((j) => j.job_id !== job.job_id));
                            }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    // Fullscreen variant kept for any caller that still wants the
    // dedicated page layout — currently unused after the header tab
    // was removed, but harmless to keep.
    return (
        <div className="h-full overflow-auto p-6 animate-[fadeIn_0.3s_ease-out]">
            <div className="max-w-6xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                            <History size={22} className="text-primary" />
                            Past Projects
                        </h1>
                        <p className="text-sm text-zinc-500 mt-1">
                            All clip-generation jobs you've run on this machine.
                            {jobs.length > 0 && ` · ${jobs.length} total`}
                        </p>
                    </div>
                    <button
                        onClick={refresh}
                        disabled={loading}
                        className="px-3 py-1.5 rounded-lg border border-white/10 bg-black/30 text-sm text-zinc-300 hover:border-white/20 flex items-center gap-2 disabled:opacity-50"
                    >
                        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        Refresh
                    </button>
                </div>

                {error && (
                    <div className="mb-4 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-sm text-red-300">
                        {error}
                    </div>
                )}

                {loading && jobs.length === 0 ? (
                    <div className="flex items-center justify-center py-16 text-zinc-500">
                        <Loader2 size={20} className="animate-spin mr-2" /> Loading…
                    </div>
                ) : jobs.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-zinc-500">
                        <History size={32} className="mx-auto mb-3 opacity-50" />
                        No past projects yet — create one in the Clip Generator.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {jobs.map((job) => (
                            <ProjectCard
                                key={job.job_id}
                                job={job}
                                onOpen={() => onOpen?.(job.job_id)}
                                onDelete={async () => {
                                    await onDelete?.(job.job_id);
                                    setJobs((prev) => prev.filter((j) => j.job_id !== job.job_id));
                                }}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ProjectCard({ job, onOpen, onDelete, selectMode = false, isSelected = false, onToggleSelect }) {
    const created = job.created_at
        ? new Date(job.created_at * 1000).toLocaleString()
        : 'Unknown date';
    const statusColor = {
        completed: 'text-green-400 bg-green-500/10 border-green-500/20',
        processing: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
        queued: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        failed: 'text-red-400 bg-red-500/10 border-red-500/20',
    }[job.status] || 'text-zinc-400 bg-white/5 border-white/10';

    const outerClass = 'group relative bg-surface border rounded-2xl overflow-hidden transition '
        + (selectMode
            ? (isSelected ? 'border-blue-400/70 ring-2 ring-blue-400/40' : 'border-white/5 hover:border-white/30')
            : 'border-white/5 hover:border-white/10');
    return (
        <div className={outerClass}>
            <div
                onClick={selectMode ? onToggleSelect : onOpen}
                className="aspect-video bg-black relative cursor-pointer"
            >
                {selectMode && (
                    <div className="absolute top-2 right-2 z-30 w-6 h-6 rounded-md border-2 flex items-center justify-center pointer-events-none"
                         style={{
                             borderColor: isSelected ? 'rgb(96 165 250)' : 'rgba(255,255,255,0.4)',
                             background: isSelected ? 'rgba(96, 165, 250, 0.9)' : 'rgba(0,0,0,0.6)',
                         }}>
                        {isSelected && <Check size={14} className="text-white" />}
                    </div>
                )}
                {job.thumbnail ? (
                    <video
                        src={getApiUrl(job.thumbnail)}
                        muted
                        playsInline
                        preload="metadata"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                        <History size={32} />
                    </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                    <Play size={32} className="text-white" />
                </div>
                <div className={`absolute top-2 left-2 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-bold ${statusColor}`}>
                    {job.status}
                </div>
            </div>
            <div className="p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white truncate">
                        {job.clip_count > 0 ? `${job.clip_count} clip${job.clip_count === 1 ? '' : 's'}` : 'No clips'}
                    </span>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
                        title="Delete project"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>
                <div className="text-xs text-zinc-500">{created}</div>
                <div className="text-[10px] font-mono text-zinc-600 truncate">{job.job_id}</div>
            </div>
        </div>
    );
}
