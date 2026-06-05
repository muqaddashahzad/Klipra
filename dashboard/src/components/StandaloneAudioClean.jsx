import React, { useState, useRef, useEffect } from 'react';
import {
  Upload, HardDrive, Download, RotateCcw, AlertCircle, Wand2, Music2,
  Sparkles, X, Loader2, CheckCircle2, Volume2, Film, FileAudio, Repeat2,
  Waves, Activity, Lightbulb, Search,
} from 'lucide-react';
import { getApiUrl } from '../config';

// The Clearcast audio-cleaning engine runs as a local sidecar (host:8770),
// reached through the Vite proxy at /clearcast (see vite.config.js).
const CC = '/clearcast';

const SAMPLE_ORIG = '/samples/audio-cleaning-sample.mp4';          // noisy original
const SAMPLE_ENH = '/samples/audio-cleaning-sample-enhanced.mp4';  // cleaned by Clearcast
const SAMPLE_POSTER = '/samples/audio-cleaning-sample.jpg';

// stage order + which fix-stage clears each detected issue (for live status)
const STAGE_ORDER = ['decode', 'analyze', 'declip', 'dehum', 'music', 'dereverb',
  'denoise', 'polish', 'restore2', 'blend', 'master', 'encode', 'video', 'done'];
const ISSUE_STAGE = { clipping: 'declip', hum: 'dehum', reverb: 'dereverb',
  noise: 'denoise', sibilance: 'master', quiet: 'master' };
const DOT = { high: 'bg-rose-400', medium: 'bg-amber-400', low: 'bg-sky-400' };

const isVideoName = (n) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(n || '');

/* A/B segmented control over the video: both labels always shown. The active
   side is colored (green=Enhanced, red=Original); the inactive side is greyed. */
function ABOverlay({ current, onSet, corner = 'top-3 left-1/2 -translate-x-1/2' }) {
  const enhanced = current === 'enhanced';
  const seg = 'px-6 py-2.5 rounded-full text-[15px] font-bold transition-all duration-200 select-none';
  return (
    <div className={`absolute ${corner} z-20 flex items-center gap-1.5 p-1.5 rounded-full
        backdrop-blur-md bg-black/50 border border-white/15 shadow-2xl`}>
      <button
        onClick={() => onSet('original')}
        className={`${seg} ${!enhanced
          ? 'bg-gradient-to-b from-rose-400 to-red-600 text-white shadow-md shadow-red-500/40'
          : 'text-zinc-400 hover:text-zinc-200'}`}>
        Original
      </button>
      <button
        onClick={() => onSet('enhanced')}
        className={`${seg} ${enhanced
          ? 'bg-gradient-to-b from-emerald-400 to-green-600 text-white shadow-md shadow-emerald-500/40'
          : 'text-zinc-400 hover:text-zinc-200'}`}>
        Enhanced
      </button>
    </div>
  );
}

export default function StandaloneAudioClean({ homeBump = 0 }) {
  const [mode, setMode] = useState('upload');           // 'upload' | 'local'
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);

  const [localFile, setLocalFile] = useState(null);
  const [localPath, setLocalPath] = useState('');
  const [localStatus, setLocalStatus] = useState('idle'); // idle|resolving|resolved|multiple|not_found|error
  const [localCandidates, setLocalCandidates] = useState([]);
  const [localError, setLocalError] = useState('');

  const [engine, setEngine] = useState('auto');
  const [removeMusic, setRemoveMusic] = useState(true);
  const [dereverb, setDereverb] = useState(true);
  const [strength, setStrength] = useState(100);
  const [outputFormat, setOutputFormat] = useState('wav');

  const [engines, setEngines] = useState(null);
  const [engineOffline, setEngineOffline] = useState(false);

  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle');         // idle|queued|processing|done|error
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [meta, setMeta] = useState(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [error, setError] = useState('');

  const [abSrc, setAbSrc] = useState('enhanced');       // result A/B
  const [sampleAB, setSampleAB] = useState('enhanced'); // sample A/B

  const playerRef = useRef(null);
  const sampleRef = useRef(null);

  /* ---- engine availability (and is the sidecar running?) ---- */
  useEffect(() => {
    let alive = true, misses = 0;
    const ping = async () => {
      try {
        const j = await (await fetch(`${CC}/api/health`)).json();
        if (!alive) return;
        setEngines(j.engines); setEngineOffline(false); misses = 0;
        if (j.engines && !j.engines.music) setRemoveMusic((v) => v && false);
        if (j.engines && !j.engines[engine]) {
          setEngine(j.engines.studio ? 'studio' : j.engines.fast ? 'fast' : 'basic');
        }
      } catch {
        if (!alive) return;
        if (++misses >= 2) setEngineOffline(true);
      }
    };
    ping();
    const t = setInterval(ping, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []); // eslint-disable-line

  /* ---- reset when the user clicks the active nav tab again ---- */
  useEffect(() => { if (homeBump > 0) resetAll(); }, [homeBump]);
  const resetAll = () => {
    setFile(null); setLocalFile(null); setLocalPath(''); setLocalStatus('idle');
    setLocalCandidates([]); setLocalError(''); setJobId(null); setStatus('idle');
    setStage(''); setProgress(0); setMessage(''); setMeta(null); setHasVideo(false);
    setError(''); setAbSrc('enhanced');
  };

  /* ---- poll job ---- */
  useEffect(() => {
    if (!jobId || status === 'done' || status === 'error') return;
    const t = setInterval(async () => {
      try {
        const j = await (await fetch(`${CC}/api/status/${jobId}`)).json();
        setStatus(j.status); setStage(j.stage || ''); setProgress(j.progress || 0);
        setMessage(j.message || ''); setMeta(j.meta || null); setHasVideo(!!j.has_video);
        if (j.status === 'error') setError(j.error || j.message || 'Processing failed');
      } catch { /* keep polling */ }
    }, 900);
    return () => clearInterval(t);
  }, [jobId, status]);

  /* ---- local-file resolution via Klipra's /api/local/find ---- */
  const resolveLocal = async (f) => {
    if (!f) return;
    setLocalFile(f); setLocalStatus('resolving'); setLocalError('');
    setLocalCandidates([]); setLocalPath('');
    try {
      const params = new URLSearchParams({ name: f.name, size: String(f.size || 0) });
      const res = await fetch(getApiUrl(`/api/local/find?${params.toString()}`));
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const data = await res.json();
      const matches = Array.isArray(data.matches) ? data.matches : [];
      if (matches.length === 1) { setLocalPath(matches[0].path); setLocalStatus('resolved'); }
      else if (matches.length > 1) { setLocalCandidates(matches); setLocalStatus('multiple'); }
      else setLocalStatus('not_found');
    } catch (e) { setLocalStatus('error'); setLocalError(e.message || String(e)); }
  };

  const canSubmit = !engineOffline && ((mode === 'upload' && file) || (mode === 'local' && localPath));
  const inputName = mode === 'upload' ? file?.name : localFile?.name;

  const submit = async () => {
    if (!canSubmit) return;
    setStatus('queued'); setError(''); setMeta(null); setAbSrc('enhanced');
    setProgress(0); setMessage('Queued'); setJobId(null);
    const common = {
      engine, remove_music: removeMusic ? 'true' : 'false',
      dereverb: dereverb ? 'true' : 'false',
      strength: (strength / 100).toFixed(2), warmth: '0.3',
      output_format: outputFormat, target_lufs: '-16',
    };
    try {
      const fd = new FormData();
      let url;
      if (mode === 'upload') { fd.append('file', file); url = `${CC}/api/enhance`; }
      else { fd.append('path', localPath); url = `${CC}/api/enhance_local`; }
      Object.entries(common).forEach(([k, v]) => fd.append(k, v));
      const res = await fetch(url, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.text()) || 'Server rejected the request');
      const j = await res.json();
      setJobId(j.job_id);
    } catch (e) { setStatus('error'); setError(e.message || String(e)); }
  };

  /* ---- swap a media element's source, preserving playback position ---- */
  const swapMedia = (ref, current, setCurrent, next) => {
    if (next === current) return;
    const p = ref.current;
    const t = p ? p.currentTime : 0;
    const playing = p && !p.paused;
    setCurrent(next);
    requestAnimationFrame(() => {
      const np = ref.current;
      if (!np) return;
      const restore = () => {
        try { np.currentTime = t; } catch {}
        if (playing) np.play().catch(() => {});
        np.removeEventListener('loadeddata', restore);
      };
      np.addEventListener('loadeddata', restore);
    });
  };
  const toggleResult = () => swapMedia(playerRef, abSrc, setAbSrc, abSrc === 'enhanced' ? 'original' : 'enhanced');
  const toggleSample = () => swapMedia(sampleRef, sampleAB, setSampleAB, sampleAB === 'enhanced' ? 'original' : 'enhanced');

  const resultIsVideo = hasVideo || (meta && meta.is_video);
  const mediaUrl = (which) => `${CC}/api/media/${jobId}/${which}`;
  const processing = status === 'queued' || status === 'processing';

  /* ===================== RENDER ===================== */
  return (
    <div className="h-full flex flex-col lg:flex-row animate-[fadeIn_0.3s_ease-out]">

      {/* ---------------- LEFT: input + options ---------------- */}
      <div className="w-full lg:w-[42%] xl:w-[38%] h-full flex flex-col border-r border-white/5 bg-black/20 p-6 overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-3 mb-1">
          <span className="w-10 h-10 rounded-xl grid place-items-center bg-primary/15 text-primary"><Wand2 size={20} /></span>
          <div>
            <h1 className="text-xl font-bold text-white leading-tight">Audio Cleaning</h1>
            <p className="text-xs text-zinc-400">Studio-quality voice from any recording</p>
          </div>
        </div>

        {/* engine availability chips */}
        <div className="flex flex-wrap gap-1.5 mt-3 mb-4">
          {[['studio', 'Studio AI'], ['fast', 'Fast AI'], ['dereverb', 'De-reverb'], ['music', 'Music removal'], ['basic', 'DSP']].map(([k, label]) => {
            const on = engines && engines[k];
            return (
              <span key={k} className={`text-[10px] px-2 py-1 rounded-full border flex items-center gap-1.5 ${on ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5' : 'border-white/10 text-zinc-500 bg-white/5'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-zinc-600'}`} />{label}
              </span>
            );
          })}
        </div>

        {engineOffline && (
          <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 flex gap-2">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>The audio-cleaning engine is starting up (it loads AI models on first run). Make sure Docker is running, give it a moment, then retry.</span>
          </div>
        )}

        {/* mode tabs */}
        <div className="flex gap-1 p-1 bg-black/30 rounded-xl mb-4">
          {[['upload', 'Upload file', Upload], ['local', 'From my Mac', HardDrive]].map(([m, label, Icon]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`flex-1 flex items-center justify-center gap-2 text-sm py-2 rounded-lg transition ${mode === m ? 'bg-primary/15 text-primary' : 'text-zinc-400 hover:text-white'}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {/* INPUT — upload */}
        {mode === 'upload' && (
          file ? (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/30 mb-4">
              {isVideoName(file.name) ? <Film size={18} className="text-primary" /> : <FileAudio size={18} className="text-primary" />}
              <span className="flex-1 text-sm truncate">{file.name}</span>
              <button onClick={() => setFile(null)} className="p-1 hover:bg-white/10 rounded-full"><X size={15} /></button>
            </div>
          ) : (
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
              className={`block cursor-pointer border-2 border-dashed rounded-xl p-7 text-center mb-4 transition ${dragging ? 'border-primary bg-primary/10' : 'border-white/15 hover:border-primary/50 bg-white/5'}`}>
              <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <Upload className="mx-auto mb-2 text-primary" size={26} />
              <p className="text-sm font-medium">Drag &amp; drop, or click to browse</p>
              <p className="text-[11px] text-zinc-500 mt-1">Audio or video · WAV · MP3 · MP4 · MOV …</p>
            </label>
          )
        )}

        {/* INPUT — local (direct access, no upload) */}
        {mode === 'local' && (
          <div className="mb-4">
            <label className="block cursor-pointer border-2 border-dashed border-white/15 hover:border-primary/50 bg-white/5 rounded-xl p-5 text-center transition">
              <input type="file" accept="audio/*,video/*" className="hidden"
                onChange={(e) => resolveLocal(e.target.files?.[0] || null)} />
              <HardDrive className="mx-auto mb-2 text-primary" size={24} />
              <p className="text-sm font-medium">Locate a file on your Mac</p>
              <p className="text-[11px] text-zinc-500 mt-1">Read in place — nothing is uploaded or copied</p>
            </label>
            {localStatus === 'resolving' && <p className="text-xs text-zinc-400 mt-2 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Locating…</p>}
            {localStatus === 'resolved' && (
              <p className="text-xs text-emerald-300 mt-2 flex items-start gap-1.5"><CheckCircle2 size={13} className="shrink-0 mt-0.5" /><span className="break-all">{localFile?.name} — ready (read directly from disk)</span></p>
            )}
            {localStatus === 'multiple' && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-amber-300">Multiple matches — pick one:</p>
                {localCandidates.map((c) => (
                  <button key={c.path} onClick={() => { setLocalPath(c.path); setLocalStatus('resolved'); }}
                    className={`block w-full text-left text-[11px] px-2 py-1.5 rounded border break-all ${localPath === c.path ? 'border-primary text-primary bg-primary/10' : 'border-white/10 text-zinc-300 hover:bg-white/5'}`}>{c.path}</button>
                ))}
              </div>
            )}
            {localStatus === 'not_found' && (
              <p className="text-xs text-amber-300 mt-2">Not found in your allowed folders. Put the file in <b>Movies</b>, <b>Desktop</b>, <b>Downloads</b> or <b>Documents</b> and try again.</p>
            )}
            {localStatus === 'error' && <p className="text-xs text-red-300 mt-2">{localError}</p>}
          </div>
        )}

        {/* OPTIONS */}
        <div className="glass-panel p-4 space-y-4 mb-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Cleanup mode</label>
            <select value={engine} onChange={(e) => setEngine(e.target.value)} className="input-field py-2 text-sm">
              <option value="auto">Auto — detect &amp; fix (recommended)</option>
              <option value="studio" disabled={engines && !engines.studio}>Studio AI — denoise + restore</option>
              <option value="fast" disabled={engines && !engines.fast}>Fast AI — quick denoise</option>
              <option value="basic">Basic — DSP only</option>
            </select>
            {engine === 'auto' && (
              <p className="text-[11px] text-zinc-500 mt-1.5">Clearcast inspects your file and removes only the problems it finds — noise, echo, hum, clipping.</p>
            )}
          </div>

          <button
            onClick={() => engines?.music && setRemoveMusic((v) => !v)}
            disabled={engines && !engines.music}
            className="w-full flex items-center justify-between gap-3 disabled:opacity-50">
            <span className="flex items-center gap-2 text-sm"><Music2 size={15} className="text-primary" /> Remove background music</span>
            <span className={`w-10 h-6 rounded-full relative transition ${removeMusic ? 'bg-primary' : 'bg-zinc-600'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${removeMusic ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
          </button>

          {engine !== 'auto' && (
            <button onClick={() => setDereverb((v) => !v)} className="w-full flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm"><Waves size={15} className="text-primary" /> Remove echo / reverb</span>
              <span className={`w-10 h-6 rounded-full relative transition ${dereverb ? 'bg-primary' : 'bg-zinc-600'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${dereverb ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            </button>
          )}

          <div>
            <label className="flex items-center justify-between text-xs text-zinc-400 mb-1">
              <span>Enhancement strength</span><span className="text-primary font-semibold">{strength}%</span>
            </label>
            <input type="range" min="0" max="100" value={strength} onChange={(e) => setStrength(+e.target.value)}
              className="w-full accent-primary" />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Output</label>
            <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} className="input-field py-2 text-sm">
              <option value="wav">WAV — 24-bit lossless</option>
              <option value="mp3">MP3 — 192 kbps</option>
            </select>
          </div>
        </div>

        {/* ACTION */}
        {!processing && status !== 'done' && (
          <button onClick={submit} disabled={!canSubmit}
            className="btn-primary w-full flex items-center justify-center gap-2">
            <Wand2 size={16} /> Clean audio
          </button>
        )}
        {(processing || status === 'done' || status === 'error') && (
          <button onClick={resetAll} className="w-full flex items-center justify-center gap-2 text-sm py-3 rounded-xl border border-white/10 bg-white/5 text-zinc-300 hover:text-white hover:bg-white/10 transition">
            <RotateCcw size={15} /> New file
          </button>
        )}
      </div>

      {/* ---------------- RIGHT: preview / result ---------------- */}
      <div className="flex-1 h-full overflow-y-auto custom-scrollbar bg-background p-6 flex flex-col">

        {/* IDLE → sample demo with overlay A/B */}
        {status === 'idle' && (
          <div className="flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><Sparkles size={15} className="text-primary" /> Sample — hear the difference</h2>
              <span className="text-[11px] text-zinc-500">Demo</span>
            </div>
            <div className="glass-panel p-2 flex-1 flex items-center justify-center">
              <div className="relative w-full flex items-center justify-center">
                <video key={`sample-${sampleAB}`} ref={sampleRef}
                  src={sampleAB === 'enhanced' ? SAMPLE_ENH : SAMPLE_ORIG}
                  poster={SAMPLE_POSTER} controls
                  className="max-h-[58vh] w-full rounded-xl bg-black object-contain" />
                <ABOverlay current={sampleAB} onSet={(m) => swapMedia(sampleRef, sampleAB, setSampleAB, m)} />
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-3 text-center">
              Tap the <b className="text-emerald-300">Enhanced</b> / <b className="text-rose-300">Original</b> button on the video to compare.
              Then drop your own file on the left, or pick one straight from your Mac.
            </p>
          </div>
        )}

        {/* PROCESSING */}
        {processing && (() => {
          const issues = meta?.diagnosis?.issues || [];
          const analyzing = !meta?.diagnosis;
          const curIdx = STAGE_ORDER.indexOf(stage);
          const statusOf = (id) => {
            const s = STAGE_ORDER.indexOf(ISSUE_STAGE[id] || 'master');
            return curIdx > s ? 'fixed' : curIdx === s ? 'fixing' : 'pending';
          };
          return (
            <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full text-center">
              <div className="w-14 h-14 rounded-full border-[3px] border-white/10 border-t-primary animate-spin mb-5" />
              {analyzing ? (
                <>
                  <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2"><Search size={17} className="text-primary" /> Analyzing your recording…</h2>
                  <p className="text-xs text-zinc-500">Checking for noise, echo, hum, clipping and sibilance.</p>
                </>
              ) : issues.length ? (
                <>
                  <h2 className="text-lg font-semibold text-white mb-1">Found {issues.length} issue{issues.length > 1 ? 's' : ''} — fixing now</h2>
                  <p className="text-xs text-primary mb-5 truncate w-full">{message}</p>
                  <ul className="w-full space-y-2.5 text-left">
                    {issues.map((is) => {
                      const st = statusOf(is.id);
                      return (
                        <li key={is.id} className={`flex items-start gap-3 text-sm ${st === 'fixed' ? 'text-emerald-300' : st === 'fixing' ? 'text-white' : 'text-zinc-500'}`}>
                          {st === 'fixed' ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                            : st === 'fixing' ? <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-primary" />
                            : <span className="w-4 h-4 mt-1 rounded-full border border-zinc-700 inline-block shrink-0" />}
                          <span>
                            {is.label}
                            {st === 'fixed' && is.fix && <span className="block text-[11px] text-zinc-500 font-normal">{is.fix}</span>}
                            {st === 'fixing' && <span className="block text-[11px] text-primary/80 font-normal">fixing…</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-white mb-1">Polishing your audio…</h2>
                  <p className="text-xs text-zinc-500">No major problems found — applying a light master.</p>
                </>
              )}
              <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden mt-6">
                <div className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-500" style={{ width: `${Math.max(4, progress * 100)}%` }} />
              </div>
            </div>
          );
        })()}

        {/* DONE → result with overlay A/B + download choice */}
        {status === 'done' && (
          <div className="flex-1 flex flex-col">
            <h2 className="text-base font-semibold text-white flex items-center gap-2 mb-3"><CheckCircle2 size={17} className="text-emerald-400" /> Cleaned &amp; ready</h2>

            {meta?.diagnosis && <DiagnosisCard diag={meta.diagnosis} />}

            <div className="glass-panel p-3">
              <div className="relative w-full flex items-center justify-center">
                {resultIsVideo ? (
                  <video key={`res-${abSrc}`} ref={playerRef} src={mediaUrl(abSrc)} controls autoPlay={false}
                    className="w-full max-h-[52vh] rounded-xl bg-black object-contain" />
                ) : (
                  <div className="w-full py-10 px-4 flex flex-col items-center rounded-xl bg-black/40">
                    <Volume2 size={40} className={abSrc === 'enhanced' ? 'text-emerald-400 mb-4' : 'text-rose-400 mb-4'} />
                    <audio key={`res-${abSrc}`} ref={playerRef} src={mediaUrl(abSrc)} controls className="w-full" />
                  </div>
                )}
                <ABOverlay current={abSrc} onSet={(m) => swapMedia(playerRef, abSrc, setAbSrc, m)} />
              </div>
            </div>

            <p className="text-[11px] text-zinc-500 mt-2 text-center">
              Tap the button on the player to compare <b className="text-emerald-300">Enhanced</b> vs <b className="text-rose-300">Original</b> — playback position is kept.
            </p>

            {/* stats */}
            <div className="flex flex-wrap gap-2 mt-4">
              {meta?.duration && <Stat v={fmtTime(meta.duration)} l="Duration" />}
              {meta?.engine_used && <Stat v={cap(meta.engine_used)} l="Engine" />}
              {(meta?.stages || []).includes('music-removal') && <Stat v="Removed" l="Music" />}
              {typeof meta?.lufs_out === 'number' && <Stat v={`${meta.lufs_out.toFixed(1)}`} l="LUFS" />}
            </div>

            {/* download choice — audio or video */}
            <div className="mt-5">
              <p className="text-xs text-zinc-400 mb-2">Download as:</p>
              <div className="flex flex-wrap gap-3">
                <a href={`${CC}/api/download/${jobId}`} className="btn-primary flex items-center gap-2">
                  <FileAudio size={16} /> Audio ({outputFormat.toUpperCase()})
                </a>
                {resultIsVideo && (
                  <a href={`${CC}/api/download/${jobId}/video`} className="flex items-center gap-2 px-5 py-3 rounded-xl border border-white/10 bg-white/5 text-white hover:bg-white/10 transition font-medium">
                    <Film size={16} /> Video (MP4)
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ERROR */}
        {status === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <AlertCircle size={40} className="text-red-400 mb-4" />
            <h2 className="text-lg font-semibold text-white mb-2">Something went wrong</h2>
            <p className="text-sm text-red-300 break-words">{error}</p>
            <button onClick={resetAll} className="mt-6 px-5 py-2.5 rounded-xl border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10 transition text-sm">Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}

const SEV = {
  high: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  low: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
};
function IssueChip({ issue }) {
  return (
    <span title={issue.detail || ''}
      className={`text-[11px] px-2.5 py-1 rounded-full border ${SEV[issue.severity] || SEV.low}`}>
      {issue.label}
    </span>
  );
}
function DiagnosisCard({ diag }) {
  const issues = diag.issues || [];
  return (
    <div className="glass-panel p-4 mb-3">
      <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <Activity size={15} className="text-primary" /> What we found &amp; fixed
      </h3>
      {issues.length ? (
        <div className="space-y-2.5">
          {issues.map((is) => (
            <div key={is.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className={`w-2 h-2 rounded-full ${DOT[is.severity] || DOT.low}`} />
                <span className="text-sm font-semibold text-white">{is.label}</span>
                {is.detail && <span className="text-[11px] text-zinc-500">· {is.detail}</span>}
              </div>
              {is.fix && (
                <p className="text-xs text-emerald-300 flex items-start gap-1.5 mb-1">
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> {is.fix}
                </p>
              )}
              {is.tip && (
                <p className="text-[11px] text-zinc-400 flex items-start gap-1.5">
                  <Lightbulb size={12} className="mt-0.5 shrink-0 text-amber-300" />
                  <span><span className="text-amber-300/90">Next time:</span> {is.tip}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-emerald-300">No major problems detected — we applied a light master to balance level and tone.</p>
      )}
    </div>
  );
}
function Stat({ v, l }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-center min-w-[78px]">
      <div className="text-sm font-bold text-primary">{v}</div>
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{l}</div>
    </div>
  );
}
const cap = (s) => (s || '').replace(/^\w/, (c) => c.toUpperCase());
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
