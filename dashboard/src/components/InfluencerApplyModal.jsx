import React, { useState } from 'react';
import { X, Loader2, Mail, User, AtSign, Link2, Check } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Influencer / self-host application form.
 *
 * Public, no auth needed — creators apply to receive the full Klipra
 * self-host script in exchange for promotional videos posted on their
 * social channels. Manual approval (you review the entries in the
 * `influencer_applications` table and email them the install guide).
 *
 * Promo links field: one URL per line. Anything malformed is dropped
 * server-side, so the user doesn't need a strict format.
 */
export default function InfluencerApplyModal({ onClose }) {
    const [email, setEmail] = useState('');
    const [fullName, setFullName] = useState('');
    const [tiktok, setTiktok] = useState('');
    const [instagram, setInstagram] = useState('');
    const [youtube, setYoutube] = useState('');
    const [x, setX] = useState('');
    const [promoLinksRaw, setPromoLinksRaw] = useState('');
    const [notes, setNotes] = useState('');
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);

    const submit = async () => {
        setError(null);
        if (!email.trim()) {
            setError('Email is required so we can reply.');
            return;
        }
        const promoLinks = promoLinksRaw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /^https?:\/\//i.test(l));
        setLoading(true);
        try {
            const r = await fetch(getApiUrl('/api/influencer/apply'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email, full_name: fullName,
                    tiktok, instagram, youtube, x,
                    promo_links: promoLinks,
                    notes,
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            setDone(true);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
             onClick={onClose}>
            <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-elevated shadow-2xl"
                 onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                    <div className="text-sm font-bold text-white">Influencer / self-host program</div>
                    <button onClick={onClose} className="text-zinc-400 hover:text-white p-1 rounded-md">
                        <X size={16} />
                    </button>
                </div>

                {done ? (
                    <div className="px-5 py-8 text-center space-y-3">
                        <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto flex items-center justify-center">
                            <Check size={22} className="text-emerald-300" />
                        </div>
                        <h3 className="text-lg font-bold text-white">Application received</h3>
                        <p className="text-sm text-zinc-400 leading-relaxed max-w-sm mx-auto">
                            We'll review and email you the self-host script + install guide if you're approved. Usually within a few days.
                        </p>
                        <button onClick={onClose}
                            className="mt-2 px-4 py-2 rounded-xl border border-white/15 text-zinc-200 hover:bg-white/5 text-sm">
                            Close
                        </button>
                    </div>
                ) : (
                    <div className="px-5 py-4 space-y-3 max-h-[80vh] overflow-y-auto custom-scrollbar">
                        <p className="text-[12px] text-zinc-400 leading-relaxed bg-amber-500/5 border border-amber-500/20 rounded-md p-3">
                            <strong className="text-amber-200">How it works:</strong> apply with your contact info,
                            the social platforms you post on, and links to the promotional videos
                            you've made about Klipra. Approved creators get the full self-host script
                            + step-by-step install guide for personal use, free.
                        </p>

                        <Field icon={Mail} label="Email">
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50" />
                        </Field>

                        <Field icon={User} label="Name">
                            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                                placeholder="Your name or creator handle"
                                className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50" />
                        </Field>

                        <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
                                Your channels
                            </div>
                            <SocialInput placeholder="TikTok @handle" value={tiktok} onChange={setTiktok} />
                            <SocialInput placeholder="Instagram @handle" value={instagram} onChange={setInstagram} />
                            <SocialInput placeholder="YouTube @channel" value={youtube} onChange={setYoutube} />
                            <SocialInput placeholder="X / Twitter @handle" value={x} onChange={setX} />
                        </div>

                        <Field icon={Link2} label="Promo video links">
                            <textarea
                                value={promoLinksRaw}
                                onChange={(e) => setPromoLinksRaw(e.target.value)}
                                rows={3}
                                placeholder={"https://www.tiktok.com/@you/video/...\nhttps://www.youtube.com/shorts/..."}
                                className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50 resize-y"
                            />
                            <p className="text-[10px] text-zinc-500 mt-1">One link per line. Add as many as you like.</p>
                        </Field>

                        <Field label="Anything else (optional)">
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows={2}
                                placeholder="Audience size, niche, anything you'd like us to know."
                                className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50 resize-y"
                            />
                        </Field>

                        {error && (
                            <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                                {error}
                            </div>
                        )}

                        <button onClick={submit} disabled={loading}
                            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-500 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                            {loading && <Loader2 size={14} className="animate-spin" />}
                            Submit application
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function Field({ icon: Icon, label, children }) {
    return (
        <label className="block">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">
                {Icon ? <Icon size={10} /> : null} {label}
            </div>
            {children}
        </label>
    );
}

function SocialInput({ placeholder, value, onChange }) {
    return (
        <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-md px-2.5">
            <AtSign size={11} className="text-zinc-500 shrink-0" />
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="flex-1 bg-transparent py-1.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none"
            />
        </div>
    );
}
