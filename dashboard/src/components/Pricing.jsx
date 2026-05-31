import React, { useState } from 'react';
import { Check, X, Github, Sparkles, Zap, Crown, Building2, Heart, ExternalLink } from 'lucide-react';

/**
 * Pricing page. Five tiers:
 *   - Self-Hosted (free, GitHub) — the BYOK open-source path
 *   - Hosted Free                — taste tier, watermark + low quotas
 *   - Pro     ($14/mo)           — entry paid tier, no watermark
 *   - Studio  ($49/mo)           — pooled AI included, multi-brand
 *   - Agency  ($149/mo)          — white-label, team seats, API
 *
 * The whole pricing strategy is "BYOK forever, charge for hosting + the
 * extras around it." The self-hosted column is intentionally given equal
 * visual weight so people understand the open-source path is real, not
 * a teaser.
 */
const TIERS = [
    {
        id: 'self',
        name: 'Self-Hosted',
        price: '$0',
        cadence: 'forever',
        tagline: 'Open source. Bring your own keys. Run it yourself.',
        accent: 'from-zinc-700/40 to-zinc-900/40',
        icon: Github,
        cta: 'Get on GitHub',
        ctaUrl: 'https://github.com/Ilmeaalim/klipra',
        ctaStyle: 'border border-white/15 hover:bg-white/5',
        features: [
            ['Every feature in this app', true],
            ['Unlimited generations', true],
            ['BYOK — pay AI provider directly', true],
            ['7 LLM providers (Gemini, GPT, Claude…)', true],
            ['Free Edge TTS dubbing in 21 languages', true],
            ['Roman Urdu / Hinglish transliteration', true],
            ['Keyframed reframe + Auto Edit', true],
            ['You manage Docker + storage', null],
            ['Community Discord support', true],
        ],
    },
    {
        id: 'free',
        name: 'Hosted Free',
        price: '$0',
        cadence: '/ month',
        tagline: 'Try Klipra without installing anything.',
        accent: 'from-zinc-800/60 to-zinc-900/40',
        icon: Sparkles,
        cta: 'Sign up free',
        ctaUrl: '#signup',
        ctaStyle: 'border border-white/15 hover:bg-white/5',
        features: [
            ['3 video generations / month', true],
            ['Up to 30-min input video', true],
            ['Klipra watermark on output', null],
            ['Whisper Fast (lower accuracy)', true],
            ['Free Edge TTS dubbing', true],
            ['1 social account via Upload-Post', true],
            ['Past projects kept 7 days', true],
            ['BYOK for AI provider', true],
            ['ElevenLabs voice cloning', false],
            ['Scheduled posting', false],
        ],
    },
    {
        id: 'pro',
        name: 'Pro',
        price: '$14',
        cadence: '/ month',
        priceYear: '$120 / year',
        tagline: 'For solo creators who post weekly.',
        accent: 'from-primary/20 to-blue-500/10',
        icon: Zap,
        highlight: true,
        cta: 'Start 7-day trial',
        ctaUrl: '#signup-pro',
        ctaStyle: 'bg-primary hover:bg-blue-600 text-white shadow-lg shadow-primary/20',
        features: [
            ['50 video generations / month', true],
            ['Up to 3-hour input video', true],
            ['No watermark', true],
            ['Whisper Best on priority queue', true],
            ['Free Edge TTS + ElevenLabs (BYOK)', true],
            ['Unlimited social accounts', true],
            ['Past projects kept 90 days', true],
            ['Scheduled batch posting', true],
            ['Email support', true],
            ['BYOK for AI provider', true],
        ],
    },
    {
        id: 'studio',
        name: 'Studio',
        price: '$49',
        cadence: '/ month',
        priceYear: '$420 / year',
        tagline: 'Podcasters & multi-brand creators.',
        accent: 'from-purple-500/20 to-fuchsia-500/10',
        icon: Crown,
        cta: 'Upgrade to Studio',
        ctaUrl: '#signup-studio',
        ctaStyle: 'border border-purple-500/40 hover:bg-purple-500/10 text-white',
        features: [
            ['250 video generations / month', true],
            ['Up to 6-hour input video', true],
            ['No watermark', true],
            ['Pooled AI INCLUDED (we cover LLM cost)', true],
            ['Premium ElevenLabs voices pooled', true],
            ['3 multi-brand workspaces', true],
            ['Priority queue', true],
            ['API access', true],
            ['Past projects kept forever', true],
            ['Priority support', true],
        ],
    },
    {
        id: 'agency',
        name: 'Agency',
        price: '$149',
        cadence: '/ month',
        tagline: 'Agencies running clips for many clients.',
        accent: 'from-orange-500/20 to-amber-500/10',
        icon: Building2,
        cta: 'Contact sales',
        ctaUrl: 'mailto:hello@ilmeaalim.com?subject=Klipra%20Agency',
        ctaStyle: 'border border-orange-500/40 hover:bg-orange-500/10 text-white',
        features: [
            ['Unlimited generations', true],
            ['Unlimited workspaces', true],
            ['White-label (your domain + logo)', true],
            ['5 team seats included', true],
            ['Bulk uploads + programmatic API', true],
            ['SLA + dedicated Slack channel', true],
            ['Custom integrations', true],
            ['Priority feature requests', true],
        ],
    },
];

const REGIONAL_NOTE = (
    <>
        <strong className="text-zinc-200">Regional pricing:</strong> Klipra Pro is available
        for ₨1,500 / month in Pakistan, India, and Bangladesh — same features,
        priced for the local market. Email{' '}
        <a href="mailto:hello@ilmeaalim.com" className="text-primary hover:underline">hello@ilmeaalim.com</a>{' '}
        to set up regional billing.
    </>
);

const FAQ = [
    {
        q: 'What does BYOK mean?',
        a: 'Bring Your Own Key. You paste your own API key (Gemini, OpenAI, Anthropic, etc.) and you pay the AI provider directly at their published rates — Klipra never sees your AI bill. On Gemini 2.5 Flash, generating clips from a 30-minute video typically costs $0.002–$0.05 of inference. Studio tier swaps BYOK for pooled credits we cover.',
    },
    {
        q: 'Is the self-hosted version really free forever?',
        a: 'Yes. The full source code is on GitHub under an open-source license. Every feature in the hosted Pro tier exists in the self-hosted version — no feature gating. You\'re paying the hosted tiers for the convenience of not running Docker yourself, plus storage, priority queue, and (Studio+) pooled AI credits.',
    },
    {
        q: 'What is Upload-Post and why do I need it?',
        a: 'Upload-Post (upload-post.com) is a third-party service that handles social-network OAuth and auto-posting on your behalf. We use it because TikTok, Instagram, and YouTube each require their own auth flows that aren\'t safe to handle in a self-hosted app. Sign up free at upload-post.com (free tier: 10 posts/month), connect your social accounts there, and Klipra publishes through their API. Optional — you can also just download clips and upload manually.',
    },
    {
        q: 'Can I cancel anytime?',
        a: 'Yes. Cancel from the Settings page in one click. We bill monthly or annually — no contracts, no early-termination fees. If you cancel mid-cycle you keep access until the period ends.',
    },
    {
        q: 'Why is Studio expensive if Pro is $14?',
        a: 'Studio includes pooled AI credits, meaning we cover the LLM API costs (~$0.20 per generation × 250 = $50 of inference baked in). It also includes pooled ElevenLabs voices and multi-brand workspaces. If you have your own AI key and only need one brand, Pro is the right tier.',
    },
    {
        q: 'What payment methods do you accept?',
        a: 'Stripe handles credit/debit cards globally. Pakistan and India can pay via JazzCash / EasyPaisa / UPI through our regional billing. Annual plans get a 30% discount versus monthly.',
    },
    {
        q: 'Can I switch from BYOK to pooled credits later?',
        a: 'Yes. Upgrade from Pro to Studio at any time and we start covering AI costs from the upgrade date. Downgrade just as easily.',
    },
];

export default function Pricing({ onChooseTab, onChoosePlan, onSignupClick }) {
    const [annual, setAnnual] = useState(false);
    const [openFaq, setOpenFaq] = useState(0);

    // Tier id → handler for the CTA. paid tiers go through the checkout
    // flow; the free tier opens the signup modal; self-host & agency
    // keep their static URLs (GitHub / mailto).
    const tierAction = (tier) => {
        if (tier.id === 'pro' || tier.id === 'studio') {
            return { kind: 'button', onClick: () => onChoosePlan?.(tier.id) };
        }
        if (tier.id === 'free') {
            return { kind: 'button', onClick: () => onSignupClick?.() };
        }
        return { kind: 'link', href: tier.ctaUrl };
    };

    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14 animate-[fadeIn_0.3s_ease-out]">

                {/* Hero */}
                <div className="text-center mb-10">
                    <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] uppercase tracking-wider text-primary mb-4">
                        <Sparkles size={12} /> Open core · BYOK first
                    </div>
                    <h1 className="text-4xl sm:text-5xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
                        Honest pricing for AI clipping.
                    </h1>
                    <p className="mt-4 text-zinc-400 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
                        Klipra is open source and fully BYOK. Pay your AI provider directly — no hidden markup.
                        Hosted plans cover storage, watermark removal, and (on Studio+) pooled AI credits.
                    </p>

                    {/* Monthly / Annual toggle */}
                    <div className="mt-6 inline-flex items-center gap-1 p-1 rounded-full border border-white/10 bg-black/30">
                        <button
                            onClick={() => setAnnual(false)}
                            className={
                                'px-4 py-1.5 rounded-full text-xs font-medium transition ' +
                                (!annual ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white')
                            }
                        >
                            Monthly
                        </button>
                        <button
                            onClick={() => setAnnual(true)}
                            className={
                                'px-4 py-1.5 rounded-full text-xs font-medium transition flex items-center gap-2 ' +
                                (annual ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white')
                            }
                        >
                            Annual
                            <span className="text-[9px] uppercase tracking-wider bg-green-500/20 text-green-300 px-1.5 py-0.5 rounded-full">−30%</span>
                        </button>
                    </div>
                </div>

                {/* Tier cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 mb-10">
                    {TIERS.map((tier) => {
                        const Icon = tier.icon;
                        return (
                            <div
                                key={tier.id}
                                className={
                                    'relative rounded-2xl border bg-gradient-to-b p-5 flex flex-col ' +
                                    tier.accent + ' ' +
                                    (tier.highlight
                                        ? 'border-primary/50 ring-1 ring-primary/20 shadow-xl shadow-primary/10'
                                        : 'border-white/10')
                                }
                            >
                                {tier.highlight && (
                                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-primary text-[10px] uppercase tracking-wider text-white font-semibold">
                                        Most popular
                                    </div>
                                )}

                                <div className="flex items-center gap-2.5 mb-3">
                                    <div className="p-1.5 rounded-lg bg-white/5 text-white">
                                        <Icon size={16} />
                                    </div>
                                    <div className="text-sm font-bold text-white">{tier.name}</div>
                                </div>

                                <div className="mb-1">
                                    <span className="text-3xl font-black text-white">
                                        {annual && tier.priceYear ? tier.priceYear.split(' ')[0] : tier.price}
                                    </span>
                                    <span className="text-zinc-500 text-xs ml-1">
                                        {annual && tier.priceYear ? '/ year' : tier.cadence}
                                    </span>
                                </div>
                                <p className="text-xs text-zinc-400 mb-5 leading-relaxed min-h-[2.5em]">
                                    {tier.tagline}
                                </p>

                                <ul className="space-y-2 mb-5 flex-1">
                                    {tier.features.map(([label, included], i) => (
                                        <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
                                            {included === true ? (
                                                <Check size={13} className="text-green-400 mt-0.5 shrink-0" />
                                            ) : included === false ? (
                                                <X size={13} className="text-zinc-600 mt-0.5 shrink-0" />
                                            ) : (
                                                <span className="text-zinc-500 mt-0.5 shrink-0">·</span>
                                            )}
                                            <span className={included === false ? 'text-zinc-600 line-through' : 'text-zinc-300'}>
                                                {label}
                                            </span>
                                        </li>
                                    ))}
                                </ul>

                                {(() => {
                                    const action = tierAction(tier);
                                    if (action.kind === 'button') {
                                        return (
                                            <button
                                                onClick={action.onClick}
                                                className={
                                                    'block w-full text-center px-3 py-2 rounded-lg text-xs font-semibold transition ' +
                                                    tier.ctaStyle
                                                }
                                            >
                                                {tier.cta}
                                            </button>
                                        );
                                    }
                                    return (
                                        <a
                                            href={action.href}
                                            target={action.href.startsWith('http') || action.href.startsWith('mailto:') ? '_blank' : undefined}
                                            rel="noreferrer"
                                            className={
                                                'block text-center px-3 py-2 rounded-lg text-xs font-semibold transition ' +
                                                tier.ctaStyle
                                            }
                                        >
                                            {tier.cta}
                                        </a>
                                    );
                                })()}
                            </div>
                        );
                    })}
                </div>

                {/* Regional pricing note */}
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 mb-12 text-sm text-blue-100/90 leading-relaxed">
                    {REGIONAL_NOTE}
                </div>

                {/* Comparison anchor — what makes Klipra different */}
                <div className="rounded-2xl border border-white/10 bg-surface/40 p-6 mb-12">
                    <h2 className="text-xl font-bold text-white mb-4">Why Klipra is priced differently</h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5 text-sm">
                        <div>
                            <div className="text-zinc-400 text-[11px] uppercase tracking-wider mb-1">Most clipping tools</div>
                            <p className="text-zinc-300 leading-relaxed">
                                Charge $19–95 / month and bake the AI cost into the subscription.
                                You can&apos;t see what your actual inference cost was.
                            </p>
                        </div>
                        <div>
                            <div className="text-primary text-[11px] uppercase tracking-wider mb-1">Klipra Pro ($14)</div>
                            <p className="text-zinc-200 leading-relaxed">
                                Hosting + watermark removal + scheduled posting. You bring your AI key
                                and pay the provider directly — typically $0.05–$0.50 / video.
                                Total runs ~50% cheaper than Opus Clip.
                            </p>
                        </div>
                        <div>
                            <div className="text-zinc-400 text-[11px] uppercase tracking-wider mb-1">Klipra Self-Hosted ($0)</div>
                            <p className="text-zinc-300 leading-relaxed">
                                Same code as the hosted version. Run on your own server, pay only your
                                AI provider. The hosted tiers exist purely so you don&apos;t have to.
                            </p>
                        </div>
                    </div>
                </div>

                {/* FAQ */}
                <div className="mb-16">
                    <h2 className="text-xl font-bold text-white mb-4">Frequently asked</h2>
                    <div className="rounded-2xl border border-white/10 bg-surface/40 divide-y divide-white/5">
                        {FAQ.map((item, i) => (
                            <div key={i}>
                                <button
                                    onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                                    className="w-full text-left px-5 py-4 flex items-center justify-between gap-3"
                                >
                                    <span className="text-sm font-medium text-white">{item.q}</span>
                                    <span className="text-zinc-500 text-lg leading-none">
                                        {openFaq === i ? '−' : '+'}
                                    </span>
                                </button>
                                {openFaq === i && (
                                    <div className="px-5 pb-4 text-sm text-zinc-300 leading-relaxed">
                                        {item.a}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Footer CTA */}
                <div className="text-center">
                    <p className="text-zinc-400 mb-3 text-sm">
                        Made with <Heart size={12} className="inline text-red-400" /> by Ilmeaalim — open source on GitHub.
                    </p>
                    <button
                        onClick={() => onChooseTab?.('about')}
                        className="text-primary hover:text-blue-400 text-sm inline-flex items-center gap-1.5"
                    >
                        Read more about us <ExternalLink size={12} />
                    </button>
                </div>
            </div>
        </div>
    );
}
