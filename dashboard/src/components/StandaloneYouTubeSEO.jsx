import React, { useState, useRef, useEffect } from 'react';
import {
  Youtube, Upload, HardDrive, Link2, Loader2, Copy, Check, RotateCcw,
  AlertCircle, Tag, ListOrdered, Type, FileText, Sparkles, Search,
} from 'lucide-react';
import { getApiUrl } from '../config';

function CopyBtn({ text, label = 'Copy', className = '' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text || ''); setDone(true); setTimeout(() => setDone(false), 1400); } catch {}
  };
  return (
    <button onClick={copy}
      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition ${done ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'} ${className}`}>
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Copied' : label}
    </button>
  );
}

export default function StandaloneYouTubeSEO({ llmHeaders, homeBump = 0 }) {
  const [mode, setMode] = useState('upload');     // upload | local | url
  const [outLang, setOutLang] = useState('English');
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [localFile, setLocalFile] = useState(null);
  const [localPath, setLocalPath] = useState('');
  const [localStatus, setLocalStatus] = useState('idle');
  const [localCandidates, setLocalCandidates] = useState([]);
  const [dragging, setDragging] = useState(false);

  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle');    // idle|queued|transcribing|analyzing|completed|failed
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const provider = llmHeaders?.['X-LLM-Provider'] || 'gemini';
  const model = llmHeaders?.['X-LLM-Model'] || '';

  useEffect(() => { if (homeBump > 0) reset(); }, [homeBump]);
  const reset = () => {
    setFile(null); setUrl(''); setLocalFile(null); setLocalPath(''); setLocalStatus('idle');
    setLocalCandidates([]); setJobId(null); setStatus('idle'); setLogs([]); setResult(null); setError('');
  };

  // poll
  useEffect(() => {
    if (!jobId || status === 'completed' || status === 'failed') return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(getApiUrl(`/api/standalone/status/${jobId}`));
        if (!r.ok) return;
        const d = await r.json();
        setStatus(d.status); setLogs(d.logs || []);
        if (d.result) setResult(d.result);
        if (d.status === 'failed') {
          const last = (d.logs || []).slice().reverse().find((l) => /error|fail/i.test(l || ''));
          setError(last || 'Generation failed.');
        }
      } catch {}
    }, 1500);
    return () => clearInterval(id);
  }, [jobId, status]);

  const resolveLocal = async (f) => {
    if (!f) return;
    setLocalFile(f); setLocalStatus('resolving'); setLocalCandidates([]); setLocalPath('');
    try {
      const p = new URLSearchParams({ name: f.name, size: String(f.size || 0) });
      const res = await fetch(getApiUrl(`/api/local/find?${p}`));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const m = Array.isArray(data.matches) ? data.matches : [];
      if (m.length === 1) { setLocalPath(m[0].path); setLocalStatus('resolved'); }
      else if (m.length > 1) { setLocalCandidates(m); setLocalStatus('multiple'); }
      else setLocalStatus('not_found');
    } catch { setLocalStatus('error'); }
  };

  const canSubmit = (mode === 'upload' && file) || (mode === 'url' && url.trim()) || (mode === 'local' && localPath);

  const submit = async () => {
    if (!canSubmit) return;
    setStatus('queued'); setError(''); setResult(null); setLogs(['Starting…']);
    try {
      const fd = new FormData();
      if (mode === 'upload') fd.append('file', file);
      else if (mode === 'url') fd.append('url', url.trim());
      else fd.append('local_path', localPath);
      fd.append('output_language', outLang);
      const r = await fetch(getApiUrl('/api/standalone/seo'), { method: 'POST', body: fd, headers: llmHeaders });
      if (!r.ok) throw new Error((await r.text()) || 'Server rejected the request');
      const d = await r.json();
      setJobId(d.job_id);
    } catch (e) { setStatus('failed'); setError(e.message || String(e)); }
  };

  const busy = ['queued', 'transcribing', 'analyzing'].includes(status);
  const statusText = { queued: 'Queued…', transcribing: 'Transcribing the video (Whisper)…', analyzing: 'Understanding the video & writing SEO…' }[status] || (logs[logs.length - 1] || 'Working…');

  /* ---------- IDLE: input ---------- */
  if (status === 'idle') {
    return (
      <div className="h-full overflow-y-auto custom-scrollbar animate-[fadeIn_0.3s_ease-out]">
        <div className="max-w-2xl mx-auto px-6 py-10">
          <div className="text-center mb-8">
            <div className="inline-grid place-items-center w-14 h-14 rounded-2xl bg-red-500/15 text-red-400 mb-3"><Youtube size={28} /></div>
            <h1 className="text-3xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">YouTube SEO</h1>
            <p className="text-zinc-400 mt-2">Give me your video — I'll watch it (transcribe), then write 5 click-worthy titles, an optimized description, tags, and perfectly-timed chapters.</p>
          </div>

          {/* input tabs */}
          <div className="flex gap-1 p-1 bg-black/30 rounded-xl mb-4">
            {[['upload', 'Upload', Upload], ['local', 'From my Mac', HardDrive], ['url', 'Paste URL', Link2]].map(([m, label, Icon]) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 flex items-center justify-center gap-2 text-sm py-2 rounded-lg transition ${mode === m ? 'bg-primary/15 text-primary' : 'text-zinc-400 hover:text-white'}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {mode === 'upload' && (
            file ? (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/30 mb-4">
                <FileText size={18} className="text-primary" /><span className="flex-1 text-sm truncate">{file.name}</span>
                <button onClick={() => setFile(null)} className="text-zinc-400 hover:text-white text-lg leading-none">×</button>
              </div>
            ) : (
              <label onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
                className={`block cursor-pointer border-2 border-dashed rounded-xl p-8 text-center mb-4 transition ${dragging ? 'border-primary bg-primary/10' : 'border-white/15 hover:border-primary/50 bg-white/5'}`}>
                <input type="file" accept="video/*,audio/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                <Upload className="mx-auto mb-2 text-primary" size={26} />
                <p className="text-sm font-medium">Drag &amp; drop your video, or click to browse</p>
                <p className="text-[11px] text-zinc-500 mt-1">MP4 · MOV · MKV · WEBM · or an audio file</p>
              </label>
            )
          )}

          {mode === 'local' && (
            <div className="mb-4">
              <label className="block cursor-pointer border-2 border-dashed border-white/15 hover:border-primary/50 bg-white/5 rounded-xl p-5 text-center transition">
                <input type="file" accept="video/*,audio/*" className="hidden" onChange={(e) => resolveLocal(e.target.files?.[0] || null)} />
                <HardDrive className="mx-auto mb-2 text-primary" size={24} />
                <p className="text-sm font-medium">Locate a video on your Mac</p>
                <p className="text-[11px] text-zinc-500 mt-1">Read in place — nothing is uploaded</p>
              </label>
              {localStatus === 'resolving' && <p className="text-xs text-zinc-400 mt-2 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Locating…</p>}
              {localStatus === 'resolved' && <p className="text-xs text-emerald-300 mt-2 break-all">✓ {localFile?.name} — ready</p>}
              {localStatus === 'multiple' && (
                <div className="mt-2 space-y-1">{localCandidates.map((c) => (
                  <button key={c.path} onClick={() => { setLocalPath(c.path); setLocalStatus('resolved'); }}
                    className={`block w-full text-left text-[11px] px-2 py-1.5 rounded border break-all ${localPath === c.path ? 'border-primary text-primary' : 'border-white/10 text-zinc-300 hover:bg-white/5'}`}>{c.path}</button>))}
                </div>
              )}
              {localStatus === 'not_found' && <p className="text-xs text-amber-300 mt-2">Not found in your allowed folders (Movies, Desktop, Downloads, Documents).</p>}
              {localStatus === 'error' && <p className="text-xs text-red-300 mt-2">Couldn't locate that file.</p>}
            </div>
          )}

          {mode === 'url' && (
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…  (or any video URL)"
              className="input-field mb-4" />
          )}

          <div className="mb-4">
            <label className="block text-xs text-zinc-400 mb-1">Output language</label>
            <select value={outLang} onChange={(e) => setOutLang(e.target.value)} className="input-field py-2 text-sm">
              <option value="English">English (recommended)</option>
              <option value="Roman Urdu">Roman Urdu (Latin letters)</option>
              <option value="Urdu">Urdu (اردو)</option>
              <option value="Hindi">Hindi</option>
              <option value="Spanish">Spanish</option>
              <option value="Arabic">Arabic</option>
              <option value="French">French</option>
              <option value="German">German</option>
              <option value="Same as video">Same as the video</option>
            </select>
            <p className="text-[11px] text-zinc-500 mt-1">Titles, description, tags &amp; chapters are written in this language — regardless of the video's spoken language.</p>
          </div>

          <button onClick={submit} disabled={!canSubmit} className="btn-primary w-full flex items-center justify-center gap-2">
            <Sparkles size={16} /> Generate SEO
          </button>
          <p className="text-[11px] text-zinc-500 text-center mt-3">
            Uses your selected AI provider — <b className="text-zinc-300">{provider}{model ? ` · ${model}` : ''}</b>. Change it in the provider picker.
          </p>
        </div>
      </div>
    );
  }

  /* ---------- BUSY ---------- */
  if (busy) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto px-6 animate-[fadeIn_0.3s_ease-out]">
        <div className="w-16 h-16 rounded-full border-[3px] border-white/10 border-t-red-400 animate-spin mb-6" />
        <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
          {status === 'transcribing' ? <Search size={17} className="text-primary" /> : <Sparkles size={17} className="text-primary" />}
          {statusText}
        </h2>
        <p className="text-xs text-zinc-500">Longer videos take a little longer to transcribe.</p>
      </div>
    );
  }

  /* ---------- FAILED ---------- */
  if (status === 'failed') {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto px-6">
        <AlertCircle size={40} className="text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Couldn't generate SEO</h2>
        <p className="text-sm text-red-300 break-words mb-2">{error}</p>
        <p className="text-[11px] text-zinc-500 mb-6">If it mentions a key or quota, set/raise your AI provider key in the provider picker, then retry.</p>
        <button onClick={reset} className="px-5 py-2.5 rounded-xl border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10 text-sm">Try again</button>
      </div>
    );
  }

  /* ---------- RESULT ---------- */
  const r = result || {};
  const titles = r.titles || [];
  const tags = r.tags || [];
  const chapters = r.chapters || [];
  return (
    <div className="h-full overflow-y-auto custom-scrollbar animate-[fadeIn_0.3s_ease-out]">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Youtube size={20} className="text-red-400" /> Your YouTube SEO kit</h2>
          <button onClick={reset} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-zinc-300 hover:text-white"><RotateCcw size={13} /> New video</button>
        </div>

        {/* Titles */}
        <section className="glass-panel p-4 mb-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2"><Type size={15} className="text-primary" /> Title ideas (high CTR)</h3>
          <ul className="space-y-2">
            {titles.map((t, i) => (
              <li key={i} className="flex items-center gap-3 group">
                <span className="text-xs text-zinc-600 w-4 shrink-0">{i + 1}</span>
                <span className="flex-1 text-sm text-zinc-100">{t}</span>
                <span className={`text-[10px] shrink-0 ${t.length > 70 ? 'text-amber-400' : 'text-zinc-500'}`}>{t.length}</span>
                <CopyBtn text={t} className="opacity-0 group-hover:opacity-100" />
              </li>
            ))}
          </ul>
        </section>

        {/* Description (chapters/timestamps are included at the bottom) */}
        <section className="glass-panel p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2"><FileText size={15} className="text-primary" /> Description <span className="text-[11px] font-normal text-zinc-500">· chapters included</span></h3>
            <CopyBtn text={r.description_full || r.description} label="Copy description" />
          </div>
          <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans bg-black/30 rounded-lg p-3 max-h-80 overflow-y-auto custom-scrollbar">{r.description_full || r.description}</pre>
          <p className="text-[11px] text-zinc-500 mt-2">Paste this whole description into YouTube — the timestamps at the bottom become clickable chapters automatically (the first is 0:00).</p>
        </section>

        {/* Tags */}
        <section className="glass-panel p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Tag size={15} className="text-primary" /> Tags</h3>
            <CopyBtn text={r.tags_text || tags.join(', ')} label="Copy all tags" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t, i) => <span key={i} className="text-[11px] px-2 py-1 rounded-md bg-white/5 border border-white/10 text-zinc-300">{t}</span>)}
          </div>
        </section>
      </div>
    </div>
  );
}
