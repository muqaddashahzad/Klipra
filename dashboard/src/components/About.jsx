import React from 'react';
import {
    Heart, Github, Globe, Shield, Sparkles, Zap, Lock, Eye,
    Languages, Music, Video, Clock, ExternalLink, Mail, Cpu,
} from 'lucide-react';
import KlipraLogo from './KlipraLogo';

/**
 * About page. Tells the story:
 *   - What Klipra is and what makes it different (BYOK, open source)
 *   - The principles we won't compromise on (privacy, transparency)
 *   - Who's building it (Ilmeaalim) and why
 *   - How to reach us
 *
 * No marketing fluff — written in the same plainspoken tone as the
 * Pricing page so the two read like one continuous story.
 */
const PRINCIPLES = [
    {
        icon: Eye,
        title: 'Transparent costs',
        body: 'You pay your AI provider directly at their published rates. No markup, no opaque "credits", no surprises. On Gemini Flash a typical video costs you $0.002.',
    },
    {
        icon: Lock,
        title: 'Your keys stay yours',
        body: 'API keys live in your browser\'s localStorage, encrypted with XOR + base64. They\'re sent to our backend ONLY as request headers and never logged or stored server-side.',
    },
    {
        icon: Github,
        title: 'Open source first',
        body: 'The full Klipra source code is on GitHub. Self-host with one Docker command. Hosted tiers exist for convenience, not for feature gating — every feature is in the open repo.',
    },
    {
        icon: Globe,
        title: 'Built for non-English creators',
        body: 'First-class support for Urdu, Hindi, Arabic, and 21 other languages. Roman Urdu / Hinglish transliteration. Free Edge TTS dubbing. Most clipping tools assume English audio — we don\'t.',
    },
];

const FEATURES = [
    {
        icon: Sparkles,
        title: 'Multi-provider AI',
        body: '7 LLM providers in one app — Gemini, GPT, Claude, OpenRouter, Groq, MiniMax, Ollama. Pick what fits your budget; switch in two clicks.',
    },
    {
        icon: Video,
        title: 'Smart reframing',
        body: 'Scene-aware face tracking with hard cuts between speakers. Pick subjects with keyframes for podcasts. Fixes shaky / drifting subjects automatically.',
    },
    {
        icon: Music,
        title: 'Free dubbing',
        body: 'Microsoft Edge neural voices in 21 languages, no API key needed. Optional ElevenLabs voice cloning if you have an account.',
    },
    {
        icon: Languages,
        title: 'Subtitles done right',
        body: 'Word-level timing, customizable styling, optional translation. Roman script for Urdu / Hindi / Arabic so subtitles read naturally on phones.',
    },
    {
        icon: Clock,
        title: 'Schedule across platforms',
        body: 'TikTok, Instagram Reels, and YouTube Shorts via Upload-Post integration. Drop your week\'s clips, set times, walk away.',
    },
    {
        icon: Cpu,
        title: 'Run it locally',
        body: 'Use Ollama for zero-cost local inference, or run the whole stack on your own server. No vendor lock-in, ever.',
    },
];

const TIMELINE = [
    ['Jan 2026', 'Klipra is forked from openshorts and rewritten with a multi-provider LLM layer.'],
    ['Feb 2026', 'Free Edge TTS dubbing in 21 languages. Roman Urdu transliteration.'],
    ['Mar 2026', 'Keyframed reframe with hard-cuts. Scene-aware face tracking.'],
    ['Apr 2026', 'Past Projects view, subtitle styling controls, frame-granular retrim editing.'],
    ['Coming', 'Multi-account workspaces, hosted tier with auth, scheduled bulk publishing.'],
];

export default function About({ onChooseTab }) {
    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 sm:py-14 animate-[fadeIn_0.3s_ease-out]">

                {/* Hero */}
                <div className="text-center mb-12">
                    <div className="flex items-center justify-center mb-4">
                        <KlipraLogo size={56} showWordmark />
                    </div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-3">
                        About Klipra
                    </p>
                    <h1 className="text-4xl sm:text-5xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent leading-tight">
                        Long videos in.<br /> Viral clips out.
                    </h1>
                    <p className="mt-5 text-zinc-400 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
                        Klipra turns hour-long podcasts, livestreams, and lectures into
                        short-form clips ready for TikTok, Instagram Reels, and YouTube Shorts —
                        in any language, with subtitles, dubbing, and smart reframing built in.
                    </p>
                </div>

                {/* Mission */}
                <section className="mb-14">
                    <h2 className="text-xl font-bold text-white mb-3">Why we built it</h2>
                    <div className="space-y-4 text-sm sm:text-base text-zinc-300 leading-relaxed">
                        <p>
                            Most AI clipping tools charge $19–95 a month and hide what
                            you&apos;re actually paying for. The AI cost is bundled into a
                            subscription, so you can&apos;t tell whether your fee covered
                            $0.05 of inference or $5. The pricing pages mention &quot;credits&quot; and
                            &quot;tokens&quot; but never the underlying API costs.
                        </p>
                        <p>
                            Klipra flips that. The whole app is{' '}
                            <strong className="text-white">open source on GitHub</strong> —
                            you can self-host with one Docker command and pay nothing to us.
                            Or use the hosted version, where you{' '}
                            <strong className="text-white">bring your own AI key</strong>{' '}
                            (Gemini, OpenAI, Claude, Ollama, whatever) and you pay the AI
                            provider directly, at their actual rates. We charge for
                            convenience: hosting, watermark removal, priority queue,
                            multi-account workspaces. Never for the AI itself.
                        </p>
                        <p>
                            We also built it for the parts of the world that English-first
                            tools forget. Urdu, Hindi, Arabic, Persian — first-class support,
                            including Roman/Latin transliteration for clean phone subtitles
                            and Edge TTS dubbing in 21 languages without an API key.
                        </p>
                    </div>
                </section>

                {/* Principles */}
                <section className="mb-14">
                    <h2 className="text-xl font-bold text-white mb-4">What we won&apos;t compromise on</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {PRINCIPLES.map(({ icon: Icon, title, body }) => (
                            <div key={title} className="rounded-xl border border-white/10 bg-surface/40 p-5">
                                <div className="flex items-center gap-2.5 mb-2">
                                    <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                                        <Icon size={16} />
                                    </div>
                                    <div className="font-semibold text-white text-sm">{title}</div>
                                </div>
                                <p className="text-[13px] text-zinc-400 leading-relaxed">{body}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* What's inside */}
                <section className="mb-14">
                    <h2 className="text-xl font-bold text-white mb-4">What&apos;s inside</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {FEATURES.map(({ icon: Icon, title, body }) => (
                            <div key={title} className="rounded-xl border border-white/10 bg-black/20 p-4">
                                <Icon size={16} className="text-primary mb-2" />
                                <div className="font-semibold text-white text-sm mb-1">{title}</div>
                                <p className="text-[12px] text-zinc-400 leading-relaxed">{body}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Timeline */}
                <section className="mb-14">
                    <h2 className="text-xl font-bold text-white mb-4">How we got here</h2>
                    <div className="rounded-xl border border-white/10 bg-surface/40 divide-y divide-white/5">
                        {TIMELINE.map(([when, what]) => (
                            <div key={when} className="px-5 py-3.5 flex items-start gap-4">
                                <span className="text-[11px] uppercase tracking-wider text-zinc-500 shrink-0 w-20 pt-0.5 font-mono">
                                    {when}
                                </span>
                                <span className="text-sm text-zinc-300 leading-relaxed flex-1">
                                    {what}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Team */}
                <section className="mb-14">
                    <h2 className="text-xl font-bold text-white mb-4">Who&apos;s building it</h2>
                    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-surface/60 to-surface/20 p-6">
                        <div className="flex items-start gap-4">
                            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white font-black text-xl shrink-0">
                                I
                            </div>
                            <div className="flex-1">
                                <div className="flex items-baseline gap-2 mb-1">
                                    <h3 className="text-lg font-bold text-white">Ilmeaalim</h3>
                                    <span className="text-[11px] text-zinc-500 uppercase tracking-wider">Maker</span>
                                </div>
                                <p className="text-sm text-zinc-300 leading-relaxed mb-3">
                                    Klipra is built by Ilmeaalim, a small independent team focused on
                                    creator tools that work for the rest of the world — not just
                                    English-speaking US/EU creators. We started Klipra because every
                                    AI clipping tool we tried produced unreadable Hindi script when
                                    we fed it Urdu audio, charged a premium for features we could see
                                    were $0.005 of inference underneath, and locked us out of the
                                    open source ecosystem we&apos;d rather build on top of.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <a
                                        href="https://github.com/Ilmeaalim/klipra"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs text-white transition"
                                    >
                                        <Github size={12} /> GitHub
                                    </a>
                                    <a
                                        href="mailto:hello@ilmeaalim.com"
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs text-white transition"
                                    >
                                        <Mail size={12} /> hello@ilmeaalim.com
                                    </a>
                                    <a
                                        href="https://ilmeaalim.com"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs text-white transition"
                                    >
                                        <Globe size={12} /> ilmeaalim.com
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* FAQ-ish quick links */}
                <section className="mb-14">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button
                            onClick={() => onChooseTab?.('pricing')}
                            className="text-left rounded-xl border border-white/10 hover:border-primary/40 bg-surface/40 hover:bg-surface/60 p-5 transition group"
                        >
                            <Zap size={18} className="text-primary mb-2" />
                            <div className="font-semibold text-white text-sm mb-1">See pricing</div>
                            <p className="text-[12px] text-zinc-400 leading-relaxed">
                                Self-hosted is free. Hosted Pro starts at $14/mo with no AI markup.
                            </p>
                        </button>
                        <a
                            href="https://github.com/Ilmeaalim/klipra"
                            target="_blank"
                            rel="noreferrer"
                            className="text-left rounded-xl border border-white/10 hover:border-primary/40 bg-surface/40 hover:bg-surface/60 p-5 transition group"
                        >
                            <Github size={18} className="text-white mb-2" />
                            <div className="font-semibold text-white text-sm mb-1 inline-flex items-center gap-1.5">
                                Read the source <ExternalLink size={11} />
                            </div>
                            <p className="text-[12px] text-zinc-400 leading-relaxed">
                                Every line of code that runs your generations is on GitHub. Audit it,
                                fork it, run it yourself.
                            </p>
                        </a>
                    </div>
                </section>

                {/* Closing */}
                <div className="text-center text-sm text-zinc-500 pt-8 border-t border-white/5">
                    <p className="flex items-center justify-center gap-1.5">
                        Made with <Heart size={12} className="text-red-400" /> by Ilmeaalim · Klipra v0.1
                    </p>
                </div>
            </div>
        </div>
    );
}
