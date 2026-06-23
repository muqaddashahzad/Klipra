import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Loader2, ArrowRight } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Human-in-the-loop transcript cleanup panel for the viral-clips pipeline.
 *
 * Shown when a clip-gen job pauses (status 'awaiting_cleanup') after
 * transcription. The user copies the transcript + a ready-made Urglish prompt,
 * cleans it in an external AI (aistudio.google.com / Gemini / ChatGPT), pastes
 * the result back, and clicks Proceed — which resumes the pipeline with the
 * cleaned transcript (no in-app AI cleanup).
 */
export default function TranscriptReviewPanel({ jobId, transcript, onProceed, onLog }) {
    const segments = transcript?.segments || [];
    const origLineCount = transcript?.line_count ?? segments.length;

    // Pre-fill the editor with the SAME numbered shape we ask the external AI
    // to return ("1| text"), numbered over EVERY segment so the count always
    // equals origLineCount (and the backend can re-align by number).
    const initialText = useMemo(
        () => segments.map((s, i) => `${i + 1}| ${(s.text || '').trim()}`).join('\n'),
        [transcript] // eslint-disable-line react-hooks/exhaustive-deps
    );
    const [editedText, setEditedText] = useState(initialText);
    useEffect(() => { setEditedText(initialText); }, [initialText]);

    const [extCopied, setExtCopied] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Count what the backend will actually keep: numbered "N|" lines if the
    // paste uses that format (the robust path), else non-empty lines (legacy).
    // Code fences and any preamble are ignored, mirroring the server parser.
    const numberedCount = (editedText || '')
        .split('\n')
        .filter(l => /^\s*\d+\s*\|/.test(l))
        .length;
    const pastedLineCount = numberedCount || (editedText || '').split('\n').filter(l => l.trim()).length;
    const mismatch = pastedLineCount !== origLineCount;

    const buildPrompt = () => {
        const n = segments.length;
        const body = segments.map((s, i) => `${i + 1}| ${(s.text || '').trim()}`).join('\n');
        return (
`You are an expert "Urglish" (Roman Urdu + English) writer. Below is a NUMBERED Whisper transcript of Urdu speech that frequently code-switches into English.

YOUR JOB — rewrite the TEXT of each numbered line as clean, readable Urglish:
- Urdu words -> Roman/Latin transliteration the way a Pakistani native types on an English keyboard (e.g. "ہے" -> "hai", "کیا" -> "kya", "نہیں" -> "nahi").
- English words AND phrases -> KEEP THEM IN ENGLISH, verbatim. Do NOT phoneticise English. "community" stays "community", "Bitcoin" stays "Bitcoin", "crypto" stays "crypto", "market" stays "market".
- Proper nouns (people, brands, places, projects) -> correct/canonical English spelling (e.g. Reuters, Trump, Ethereum, Binance).
- Numbers -> digits (e.g. "2.3 million", "$50").

CRITICAL — OUTPUT FORMAT (this is parsed by software, so follow it exactly):
- Return EXACTLY ${n} lines, numbered 1 to ${n}.
- Every line MUST keep its ORIGINAL number and begin with "<number>| ", e.g. "12| yahan rewritten text".
- Line 12 in = line 12 out. Do NOT renumber, merge, split, reorder, add, or drop any line.
- Many lines are a single word or a short fragment — that is intentional (the speaker paused there). Rewrite each on its OWN numbered line; NEVER combine short lines into one.
- Do NOT add timestamps, quotes, bullet points, or ANY commentary, notes, or search results.
- Output ONLY the ${n} numbered lines, wrapped in a SINGLE markdown code block — a line of three backticks, then the lines, then a closing line of three backticks. Nothing before or after the code block.

TRANSCRIPT (${n} lines):
${body}`
        );
    };

    const copyPrompt = async () => {
        const text = buildPrompt();
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            try {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
            } catch { alert('Could not copy automatically — select the transcript and copy manually.'); return; }
        }
        setExtCopied(true);
        setTimeout(() => setExtCopied(false), 2500);
    };

    const proceed = async () => {
        setBusy(true);
        setError(null);
        try {
            onLog?.('Resuming with your cleaned transcript…');
            const r = await fetch(getApiUrl('/api/process/continue'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, cleaned_transcript: editedText }),
            });
            if (!r.ok) {
                const t = await r.text();
                throw new Error(t || `HTTP ${r.status}`);
            }
            onProceed?.();
        } catch (e) {
            setError(e.message || String(e));
            setBusy(false);
        }
    };

    if (!transcript) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-3">
                <Loader2 className="animate-spin" size={24} />
                <p className="text-sm">Loading transcript…</p>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-4 space-y-3">
            <div>
                <h3 className="text-sm font-bold text-cyan-300">Paused · clean the transcript</h3>
                <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">
                    Transcription is done ({origLineCount} lines). Clean it in an external AI, paste the
                    result below, then continue — the pipeline will pick clips from your cleaned text.
                </p>
            </div>

            {/* Copy for external AI */}
            <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2.5 space-y-1.5">
                <div className="text-[10px] text-cyan-200/90 leading-snug">
                    <strong>Step 1.</strong> Copy the transcript + Urglish prompt, run it in Google AI Studio
                    (aistudio.google.com), Gemini, or ChatGPT. The prompt keeps English words in English,
                    transliterates Urdu to Roman, and asks for numbered lines in a code block so the result
                    pastes back cleanly.
                </div>
                <button
                    type="button"
                    onClick={copyPrompt}
                    className={
                        'w-full py-1.5 rounded text-[11px] font-bold flex items-center justify-center gap-1.5 transition ' +
                        (extCopied
                            ? 'bg-green-500/20 text-green-200 border border-green-400/40'
                            : 'bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-100 border border-cyan-400/30')
                    }
                >
                    {extCopied
                        ? <>✓ Copied — paste into aistudio.google.com, then paste the result below</>
                        : <><Copy size={11} /> Copy transcript + Urglish prompt</>}
                </button>
            </div>

            {/* Paste back */}
            <div className="space-y-1">
                <div className="text-[10px] text-zinc-400"><strong>Step 2.</strong> Paste the cleaned result here (replace the text). You can paste the whole code block — the app strips the ``` fences and any extra lines automatically:</div>
                <textarea
                    value={editedText}
                    onChange={(e) => setEditedText(e.target.value)}
                    rows={12}
                    className="w-full bg-black/40 border border-white/10 rounded-md p-2 text-[12px] text-white focus:outline-none focus:border-cyan-500/50 resize-y leading-relaxed font-mono"
                />
                <div className="flex items-center justify-between text-[10px]">
                    <span className={mismatch ? 'text-amber-300' : 'text-emerald-400'}>
                        {pastedLineCount} lines pasted · {origLineCount} original
                        {mismatch
                            ? ' — counts differ. Each line is re-aligned by its number, so any missing line just keeps its original Urdu (no cascade) — but ideally re-run so all numbers are present.'
                            : ' ✓ matched'}
                    </span>
                </div>
            </div>

            {error && (
                <div className="rounded-md ring-1 ring-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
                    {error}
                </div>
            )}

            {/* Proceed */}
            <button
                type="button"
                onClick={proceed}
                disabled={busy || !editedText.trim()}
                className="w-full py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center justify-center gap-2 transition"
            >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                {busy ? 'Resuming…' : 'Proceed with these subtitles → generate clips'}
            </button>
        </div>
    );
}
