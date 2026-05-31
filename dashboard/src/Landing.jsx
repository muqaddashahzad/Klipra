import React, { useState } from 'react';
import {
    ArrowRight, Check, Cpu, Zap, Lock, Languages,
    Scissors, MoveHorizontal, Layers, Github, Menu, X,
} from 'lucide-react';
import KlipraLogo from './components/KlipraLogo';

/**
 * Klipra landing page. Mobile-first, single-column on phones, multi-col
 * on tablets+. The "Open app" CTA bypasses the landing on subsequent
 * visits via localStorage.
 */
export default function Landing({ onEnterApp }) {
    const [navOpen, setNavOpen] = useState(false);
    const enter = () => {
        try { localStorage.setItem('klipra_skip_landing', '1'); } catch {}
        onEnterApp?.();
    };

    return (
        <div className="min-h-screen bg-background text-zinc-100 selection:bg-primary/30">
            {/* Top nav */}
            <header className="sticky top-0 z-30 backdrop-blur-md bg-background/70 border-b border-border">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
                    <KlipraLogo size={28} showWordmark />
                    <nav className="hidden md:flex items-center gap-7 text-sm text-zinc-400">
                        <a href="#features" className="hover:text-white">Features</a>
                        <a href="#how" className="hover:text-white">How it works</a>
                        <a href="#providers" className="hover:text-white">AI providers</a>
                        <a href="#faq" className="hover:text-white">FAQ</a>
                    </nav>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={enter}
                            className="hidden sm:inline-flex items-center gap-1.5 bg-primary hover:bg-primary-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition shadow-glow"
                        >
                            Open app <ArrowRight size={14} />
                        </button>
                        <button
                            onClick={() => setNavOpen((o) => !o)}
                            aria-label="Toggle menu"
                            className="md:hidden p-2 -mr-2 rounded-md text-zinc-300 hover:bg-white/5"
                        >
                            {navOpen ? <X size={20} /> : <Menu size={20} />}
                        </button>
                    </div>
                </div>
                {navOpen && (
                    <div className="md:hidden border-t border-border bg-surface">
                        <nav className="flex flex-col px-4 py-3 gap-1 text-sm">
                            <a href="#features" onClick={() => setNavOpen(false)} className="px-2 py-2 rounded hover:bg-white/5">Features</a>
                            <a href="#how" onClick={() => setNavOpen(false)} className="px-2 py-2 rounded hover:bg-white/5">How it works</a>
                            <a href="#providers" onClick={() => setNavOpen(false)} className="px-2 py-2 rounded hover:bg-white/5">AI providers</a>
                            <a href="#faq" onClick={() => setNavOpen(false)} className="px-2 py-2 rounded hover:bg-white/5">FAQ</a>
                            <button
                                onClick={enter}
                                className="mt-2 inline-flex items-center justify-center gap-1.5 bg-primary text-white font-medium px-4 py-2.5 rounded-lg"
                            >
                                Open app <ArrowRight size={14} />
                            </button>
                        </nav>
                    </div>
                )}
            </header>

            {/* Hero */}
            <section className="relative overflow-hidden">
                <div className="absolute inset-0 -z-10 pointer-events-none">
                    <div className="absolute -top-32 -left-32 w-[44rem] h-[44rem] bg-primary/10 rounded-full blur-[140px]" />
                    <div className="absolute top-32 -right-40 w-[36rem] h-[36rem] bg-accent/10 rounded-full blur-[140px]" />
                </div>
                <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-12 pb-16 sm:pt-20 sm:pb-24">
                    <div className="max-w-3xl">
                        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-primary-300 bg-primary/10 border border-primary/20 px-3 py-1.5 rounded-full mb-5">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> v0.1 — public beta
                        </p>
                        <h1 className="font-display font-bold text-4xl sm:text-5xl md:text-6xl lg:text-7xl tracking-tight leading-[1.05] text-white">
                            Long videos to <span className="bg-klipra-gradient bg-clip-text text-transparent">viral clips</span>,
                            <br className="hidden sm:block" /> on any AI.
                        </h1>
                        <p className="mt-6 text-base sm:text-lg text-zinc-400 max-w-2xl leading-relaxed">
                            Klipra clips your podcasts, talks and tutorials into 9:16 shorts.
                            Bring any AI key — OpenAI, Claude, Gemini, MiniMax, Groq, OpenRouter,
                            or run a local model on your own machine. No watermarks, no usage caps.
                        </p>
                        <div className="mt-8 flex flex-col sm:flex-row gap-3 sm:gap-4">
                            <button
                                onClick={enter}
                                className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-600 text-white font-medium px-6 py-3.5 rounded-lg text-base shadow-glow transition"
                            >
                                Start clipping <ArrowRight size={16} />
                            </button>
                            <a
                                href="#how"
                                className="inline-flex items-center justify-center gap-2 bg-surface hover:bg-elevated border border-border text-white font-medium px-6 py-3.5 rounded-lg text-base transition"
                            >
                                See how it works
                            </a>
                        </div>
                        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-500">
                            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-primary-400" /> Self-hosted</span>
                            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-primary-400" /> No watermark</span>
                            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-primary-400" /> 21 subtitle languages</span>
                            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-primary-400" /> MIT licensed</span>
                        </div>
                    </div>
                </div>
            </section>

            {/* Features grid */}
            <section id="features" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
                <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
                    <h2 className="font-display font-bold text-3xl sm:text-4xl tracking-tight text-white">
                        Everything you need to ship shorts
                    </h2>
                    <p className="mt-3 text-zinc-400">
                        Auto detection of viral moments, frame-accurate trimming, smart vertical
                        reframing, multi-language subtitles, and one-click publishing.
                    </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    <Feature icon={Zap} title="Viral-moment detection"
                        body="Your chosen LLM scans the transcript and picks 3–15 high-potential clips with hooks, titles, and scores." />
                    <Feature icon={Scissors} title="Frame-perfect editing"
                        body="Trim each clip in single-frame steps. Drag the slider or use ←/→ keys for sub-second nudges." />
                    <Feature icon={MoveHorizontal} title="Click-to-cut reframing"
                        body="Tap anywhere on the source frame to drop a hard focus cut. Pan smoothly between cuts in advanced mode." />
                    <Feature icon={Languages} title="21-language subtitles + dubbing"
                        body="Auto-translate and burn in subtitles. Free Edge TTS dubbing keeps your original voice underneath, optionally." />
                    <Feature icon={Layers} title="Hooks, thumbnails, dubs"
                        body="Customizable on-screen hook overlays. Generate YouTube thumbnails. Re-render any clip without redoing the whole job." />
                    <Feature icon={Lock} title="Self-hosted, your keys"
                        body="API keys stay in your browser. Run on your own server — your audience and your data never leave your control." />
                </div>
            </section>

            {/* How it works */}
            <section id="how" className="bg-surface border-y border-border">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
                    <h2 className="font-display font-bold text-3xl sm:text-4xl tracking-tight text-white text-center mb-12">
                        Three steps. Five minutes.
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {[
                            ['1', 'Paste a URL or upload', 'Drop a YouTube link or any video file. Klipra transcribes it locally with Whisper — your audio never leaves your server.'],
                            ['2', 'AI picks the best moments', 'Choose your AI provider. Klipra prompts it to extract the most viral 9:16 moments with hooks, titles, and viral-score reasoning.'],
                            ['3', 'Edit and publish', 'Trim, reframe, hook, subtitle, dub. Post directly to TikTok / Instagram / YouTube via Upload-Post or download the MP4.'],
                        ].map(([n, t, b]) => (
                            <div key={n} className="bg-elevated border border-border rounded-2xl p-6">
                                <div className="font-display text-5xl font-bold text-primary-400 mb-3">{n}</div>
                                <h3 className="font-display font-bold text-xl text-white mb-2">{t}</h3>
                                <p className="text-sm text-zinc-400 leading-relaxed">{b}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* AI providers */}
            <section id="providers" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
                <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
                    <h2 className="font-display font-bold text-3xl sm:text-4xl tracking-tight text-white">
                        Bring any AI you want
                    </h2>
                    <p className="mt-3 text-zinc-400">
                        Klipra has no preferred provider. Pick one with a great free tier, or
                        run a local model so nothing leaves your machine.
                    </p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-3">
                    {['OpenAI', 'Anthropic', 'Google Gemini', 'OpenRouter', 'Groq', 'MiniMax', 'Ollama (local)', 'Custom OpenAI-compatible'].map((p) => (
                        <div
                            key={p}
                            className="bg-surface border border-border rounded-lg px-3 py-3 sm:py-4 text-center text-xs sm:text-sm text-zinc-300 hover:border-primary/40 hover:bg-elevated transition"
                        >
                            {p}
                        </div>
                    ))}
                </div>
            </section>

            {/* FAQ */}
            <section id="faq" className="bg-surface border-t border-border">
                <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
                    <h2 className="font-display font-bold text-3xl sm:text-4xl tracking-tight text-white text-center mb-10 sm:mb-12">
                        Questions, answered
                    </h2>
                    <div className="space-y-3">
                        <Faq q="Do I need a paid AI account?"
                            a="No. Klipra works with free tiers (Gemini Flash, OpenRouter free models, MiniMax free), or fully local via Ollama. Bring whatever key you have." />
                        <Faq q="Where do my videos and clips live?"
                            a="On your server (or your laptop, if you're self-hosting). Klipra never uploads source video to a third-party. Only the transcript text goes to the AI provider you select." />
                        <Faq q="Can I edit a clip's timing after generation?"
                            a="Yes. Each clip has Edit-timing (frame-accurate trim) and Reframe (click-to-cut focus). Re-render takes 5–15 seconds and overwrites the file in place." />
                        <Faq q="Will the dub replace my original voice?"
                            a="Optional. By default, dubbing replaces. Toggle 'Keep original voice' and the original plays softly under the translation, documentary-style." />
                        <Faq q="Is there a watermark?"
                            a="Never. Klipra is open-source and self-hosted — there's no central service to brand your output." />
                    </div>
                </div>
            </section>

            {/* Final CTA */}
            <section className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center">
                <h2 className="font-display font-bold text-3xl sm:text-5xl tracking-tight text-white">
                    Stop manually clipping.
                </h2>
                <p className="mt-4 text-zinc-400 max-w-xl mx-auto">
                    Drop a video, pick an AI, get viral shorts. That's it.
                </p>
                <button
                    onClick={enter}
                    className="mt-8 inline-flex items-center gap-2 bg-coral hover:bg-coral-600 text-white font-medium px-8 py-4 rounded-lg text-base shadow-coral transition"
                >
                    Open Klipra <ArrowRight size={16} />
                </button>
            </section>

            {/* Footer */}
            <footer className="border-t border-border bg-background">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-zinc-500">
                    <div className="flex items-center gap-3">
                        <KlipraLogo size={22} showWordmark />
                        <span className="text-zinc-600">·</span>
                        <span>MIT licensed</span>
                    </div>
                    <div className="flex items-center gap-5">
                        <a href="#features" className="hover:text-white">Features</a>
                        <a href="#faq" className="hover:text-white">FAQ</a>
                        <span className="text-zinc-600">© Klipra</span>
                    </div>
                </div>
            </footer>
        </div>
    );
}

function Feature({ icon: Icon, title, body }) {
    return (
        <div className="bg-surface border border-border rounded-2xl p-5 sm:p-6 hover:border-primary/30 hover:bg-elevated transition group">
            <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary-400 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition">
                <Icon size={20} />
            </div>
            <h3 className="font-display font-semibold text-lg text-white mb-1.5">{title}</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
        </div>
    );
}

function Faq({ q, a }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="bg-elevated border border-border rounded-xl overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-4 px-4 sm:px-5 py-4 text-left text-sm sm:text-base font-medium text-white hover:bg-white/[0.02]"
            >
                <span>{q}</span>
                <span className={`text-zinc-500 transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
            </button>
            {open && (
                <div className="px-4 sm:px-5 pb-4 text-sm text-zinc-400 leading-relaxed">{a}</div>
            )}
        </div>
    );
}
