import React, { useState } from 'react';
import { X, Loader2, Mail, Lock, User, AtSign } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Sign-up / sign-in modal. Two tabs:
 *   • Sign up — email + password + optional social handles. Captures
 *     the data your monetization plan calls for: who they are, where
 *     they post, so you can verify creators and follow up.
 *   • Sign in — straight email + password.
 *
 * On success calls onSuccess({ user, token }) — the parent stashes the
 * token in localStorage and updates header state.
 */
export default function AuthModal({ initialTab = 'signup', onClose, onSuccess }) {
    const [tab, setTab] = useState(initialTab);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);

    // Shared state across tabs so switching doesn't lose what they typed.
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [fullName, setFullName] = useState('');
    const [tiktok, setTiktok] = useState('');
    const [instagram, setInstagram] = useState('');
    const [youtube, setYoutube] = useState('');
    const [x, setX] = useState('');

    const submit = async () => {
        setError(null);
        if (!email.trim() || !password) {
            setError('Email and password are required.');
            return;
        }
        if (tab === 'signup' && password.length < 8) {
            setError('Password must be at least 8 characters.');
            return;
        }
        setLoading(true);
        try {
            const path = tab === 'signup' ? '/api/auth/signup' : '/api/auth/signin';
            const body = tab === 'signup'
                ? { email, password, full_name: fullName, tiktok, instagram, youtube, x }
                : { email, password };
            const r = await fetch(getApiUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                const text = await r.text();
                throw new Error(text || `HTTP ${r.status}`);
            }
            const data = await r.json();
            onSuccess?.(data);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
             onClick={onClose}>
            <div className="w-full max-w-md rounded-2xl border border-white/10 bg-elevated shadow-2xl"
                 onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                    <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-[11px]">
                        <button onClick={() => setTab('signup')}
                            className={'px-3 py-1.5 transition ' + (tab === 'signup' ? 'bg-primary/15 text-primary' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                            Sign up
                        </button>
                        <button onClick={() => setTab('signin')}
                            className={'px-3 py-1.5 transition ' + (tab === 'signin' ? 'bg-primary/15 text-primary' : 'bg-black/30 text-zinc-400 hover:text-white')}>
                            Sign in
                        </button>
                    </div>
                    <button onClick={onClose} className="text-zinc-400 hover:text-white p-1 rounded-md">
                        <X size={16} />
                    </button>
                </div>

                <div className="px-5 py-5 space-y-3">
                    {/* Social sign-in. Each button just redirects the
                        browser to the backend's /start endpoint, which
                        kicks off the OAuth flow and brings the user
                        back with a session token in the URL fragment.
                        Backend returns 503 if the provider isn't
                        configured — we surface that as a friendly
                        message instead of a redirect loop. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <SocialButton
                            label={tab === 'signin' ? 'Sign in with Google' : 'Continue with Google'}
                            provider="google"
                            iconSvg={<GoogleIcon />}
                        />
                        <SocialButton
                            label={tab === 'signin' ? 'Sign in with GitHub' : 'Continue with GitHub'}
                            provider="github"
                            iconSvg={<GitHubIcon />}
                        />
                    </div>
                    <div className="flex items-center gap-3 my-1">
                        <div className="flex-1 h-px bg-white/10" />
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                            or with email
                        </span>
                        <div className="flex-1 h-px bg-white/10" />
                    </div>

                    <Field icon={Mail} label="Email">
                        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                            className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50" />
                    </Field>
                    <Field icon={Lock} label="Password">
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                            placeholder={tab === 'signup' ? '8+ characters' : 'Your password'}
                            className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50" />
                    </Field>

                    {tab === 'signup' && (
                        <>
                            <Field icon={User} label="Name (optional)">
                                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                                    placeholder="Jane Creator"
                                    className="w-full bg-black/30 border border-white/10 rounded-md py-2 px-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-primary/50" />
                            </Field>

                            <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
                                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
                                    Where do you post? (optional)
                                </div>
                                <p className="text-[10px] text-zinc-500 leading-relaxed">
                                    Helps us verify creators for the influencer program. Just your handle — not the full URL.
                                </p>
                                <SocialInput placeholder="TikTok @handle" value={tiktok} onChange={setTiktok} />
                                <SocialInput placeholder="Instagram @handle" value={instagram} onChange={setInstagram} />
                                <SocialInput placeholder="YouTube @channel" value={youtube} onChange={setYoutube} />
                                <SocialInput placeholder="X / Twitter @handle" value={x} onChange={setX} />
                            </div>
                        </>
                    )}

                    {error && (
                        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                            {error}
                        </div>
                    )}

                    <button onClick={submit} disabled={loading}
                        className="w-full py-2.5 rounded-xl bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-500 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                        {loading && <Loader2 size={14} className="animate-spin" />}
                        {tab === 'signup' ? 'Create free account' : 'Sign in'}
                    </button>

                    <p className="text-[10px] text-zinc-500 text-center leading-relaxed pt-1">
                        {tab === 'signup'
                            ? 'Free plan includes 5 jobs / month. No credit card required.'
                            : "New to Klipra? Tap Sign up above."}
                    </p>
                </div>
            </div>
        </div>
    );
}

function Field({ icon: Icon, label, children }) {
    return (
        <label className="block">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">
                <Icon size={10} /> {label}
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

/**
 * Social sign-in button. Probes the backend's /start endpoint with a
 * HEAD request first to detect 503 (= "provider not configured") so we
 * can show a friendly message instead of a redirect loop. The 503 case
 * is rare in production but extremely common during local dev (before
 * the operator has put their CLIENT_ID in env), and silently breaking
 * is a bad first-run experience.
 */
function SocialButton({ label, provider, iconSvg }) {
    const startUrl = getApiUrl(`/api/auth/oauth/${provider}/start`);
    const onClick = async (e) => {
        e.preventDefault();
        try {
            // Most browsers don't expose 503 from a redirect, so probe
            // first with no-redirect fetch.
            const probe = await fetch(startUrl, { method: 'GET', redirect: 'manual' });
            if (probe.status === 503) {
                let body = '';
                try { body = await probe.text(); } catch {}
                alert(body || `${provider} sign-in isn't configured yet.`);
                return;
            }
        } catch {
            // Network errors fall through to the redirect — let the
            // browser surface the failure naturally.
        }
        window.location.href = startUrl;
    };
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-sm text-white transition"
        >
            {iconSvg}
            <span className="truncate">{label}</span>
        </button>
    );
}

function GoogleIcon() {
    // Official Google "G" mark. Colours follow Google's branding so
    // the button reads as legitimate.
    return (
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16.1 18.9 13 24 13c3.1 0 5.9 1.2 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.4C29.6 34.6 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.6l6.6 5.4C42.6 35.5 44 30.1 44 24c0-1.3-.1-2.4-.4-3.5z"/>
        </svg>
    );
}

function GitHubIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.33.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18A10.95 10.95 0 0 1 12 6.8c.97 0 1.95.13 2.86.39 2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.76.12 3.05.74.8 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.16 0 1.56-.01 2.81-.01 3.2 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
        </svg>
    );
}
