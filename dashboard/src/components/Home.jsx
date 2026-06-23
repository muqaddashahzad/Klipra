import React from 'react';
import {
    Sparkles, Type, Languages, ArrowRight, Play,
    Github, ChevronRight, ArrowDown, Youtube, Facebook, Film, Mic,
} from 'lucide-react';

/**
 * FEATURED demos that the homepage shows by default — using REAL
 * social-media embeds the operator has hand-picked. Each output entry
 * has a platform badge (YouTube Short, TikTok, Facebook Reel, etc.)
 * and the embed URL pulls the actual published clip from that
 * platform — visitors see what those clips look like in the wild,
 * with native player controls and engagement signals.
 *
 * To swap the demo, edit this constant. Per-feature, set:
 *   { source: { kind: 'youtube'|'tiktok'|'facebook', url },
 *     outputs: [ { platform, kind, url, label } ] }
 *
 * `kind: null` for any feature falls back to the auto-fetched past
 * project from the user's own library (good while collecting demos).
 */
const FEATURED_DEMOS = {
    clip: {
        source: {
            kind: 'youtube',
            // Original long-form video the AI watched.
            url: 'https://youtu.be/L6SYWcY9vyU',
            label: 'Original (full video)',
        },
        outputs: [
            {
                kind: 'youtube-short',
                url: 'https://youtube.com/shorts/fVOlfoi3nP8',
                platform: 'YouTube Shorts',
                label: 'Posted to YouTube Shorts',
            },
            // TIKTOK PLACEHOLDER — replace `url` with the actual TikTok
            // post URL of one of your generated clips. The EmbedTile
            // detects `tiktok.com` and renders the official TikTok
            // embed. To hide this tile, comment out the whole block.
            {
                kind: 'tiktok',
                url: 'https://www.tiktok.com/@klipra/video/0000000000000000000',
                platform: 'TikTok',
                label: 'Posted to TikTok',
            },
            // FACEBOOK REEL PLACEHOLDER — replace with a public
            // Facebook Reel URL (https://www.facebook.com/reel/<id>).
            // EmbedTile renders it with Facebook's official embed.
            {
                kind: 'facebook',
                url: 'https://www.facebook.com/reel/0000000000000000',
                platform: 'Facebook Reel',
                label: 'Posted to Facebook Reel',
            },
        ],
    },
    // null entries fall back to auto-pulled past-project demos until
    // the operator provides real social-media embed links for them.
    subtitle: null,
    dub: null,
};

/**
 * In-app homepage. Reachable by clicking the Klipra logo. Acts as the
 * "front door" for users already inside the app — distinct from the
 * pre-app marketing Landing.jsx which only shows on first visit.
 *
 * Three responsibilities:
 *   1. Re-introduce Klipra each time the user comes back, so a new
 *      collaborator who's been handed a logged-in laptop knows what
 *      this thing does.
 *   2. Explain each of the three products in plain language with a
 *      direct CTA into them.
 *   3. Show ORIGINAL vs OUTPUT demo videos pulled from the user's own
 *      past projects so the homepage isn't just claims — visitors can
 *      play both sides and compare. Falls back to a placeholder when
 *      no past project exists yet.
 */
export default function Home({ onChooseTab, currentUser }) {
    // HOMEPAGE DEMOS ARE STATIC.
    //
    // The user explicitly asked us to never auto-fetch their past
    // projects onto this page — the curated samples in
    // dashboard/public/samples/ are the permanent set. So the
    // /api/jobs/list and /api/standalone/list calls that used to
    // populate `clipDemo` / `subtitleDemos` / `dubDemos` are gone.
    // Every section below renders straight from the FEATURED_DEMOS
    // constant or a hard-coded sample-file URL.

    // featuredOrStatic: when FEATURED_DEMOS[key] is set we render its
    // social-embed shape (YouTube / TikTok / etc.). Otherwise we use
    // the static fallback object passed by the caller. Same signature
    // as the old featuredOrFallback so callers below didn't need to
    // change — the meaningful change is that the fallback no longer
    // depends on async-fetched past-project state.
    const featuredOrFallback = (key, staticFallback) => {
        const featured = FEATURED_DEMOS[key];
        if (featured) {
            return {
                kind: 'embed',
                source: featured.source,
                outputs: featured.outputs,
            };
        }
        return staticFallback;
    };

    const features = [
        {
            id: 'clip',
            tabId: 'dashboard',
            title: 'Generate Viral Clips',
            tagline: 'Turn long-form into short, share-ready clips.',
            description:
                "Drop in a podcast, lecture, or YouTube link. Klipra finds the moments people will actually share, cuts them into vertical clips, captions them, and gives you 6+ ready-to-publish shorts in minutes. The AI explains its picks so you know why each clip got chosen.",
            bullets: [
                'AI picks the most engaging segments using full transcript context',
                'Auto-vertical reframe with face tracking — no awkward crops',
                'Per-clip retrim, edit, hook overlay, dub, post — all in one place',
            ],
            cta: 'Start generating clips',
            icon: Sparkles,
            accent: { ring: 'ring-primary/30', bg: 'from-primary/15 to-blue-500/5', text: 'text-primary', btn: 'bg-primary hover:bg-blue-600 text-white' },
            // Generate Clips demo — fully static. FEATURED_DEMOS.clip
            // is always defined (YouTube + TikTok + Facebook embeds),
            // so featuredOrFallback returns the embed shape here. The
            // `false` fallback is just for shape-compatibility with
            // BeforeAfterDemo (treated as "no demo configured" if the
            // operator ever blanks FEATURED_DEMOS.clip).
            demo: featuredOrFallback('clip', false),
        },
        {
            id: 'h2v',
            tabId: 'h2v',
            title: 'Horizontal → Vertical',
            tagline: 'Slice a long horizontal video into multiple vertical clips.',
            description:
                "Drop a long-form horizontal video — a lecture, podcast, livestream, screen-recorded talk. AI reads the transcript, finds 2–6 topic boundaries, and intelligently fuses segments from different times that belong together. Per-clip speaker face tracking by default; manually mark hard cuts to switch focus to your screen-share for any range. Pro-grade timeline: drag-select, split (S), merge (M), delete, undo/redo, zoom, JKL transport — everything you'd expect from a real editor.",
            bullets: [
                'AI auto-split into topic-coherent vertical clips',
                'Intelligent merge — same topic at different times fuses into one clip',
                'Per-clip speaker focus, with manual keyframe override for screen shares',
            ],
            cta: 'Open the editor',
            icon: Film,
            accent: { ring: 'ring-fuchsia-500/30', bg: 'from-fuchsia-500/15 to-pink-500/5', text: 'text-fuchsia-300', btn: 'bg-fuchsia-500 hover:bg-fuchsia-400 text-white' },
            // No curated demo yet — falls through to a placeholder.
            demo: false,
        },
        {
            id: 'subtitle',
            tabId: 'subtitle',
            title: 'Auto Subtitle',
            tagline: 'Burn accurate, styled subtitles into any video.',
            description:
                "Two-phase wizard. First, AI generates a clean transcript with full-clip context — fixing Whisper mishears the moment they appear. Edit any line, sync timing to the actual audio, then style: font, colour, outline, vertical position. Burn-in once you're happy.",
            bullets: [
                'Original language, Roman/Latin transliteration, or full translation',
                'Per-segment editing in Timed view — fix specific words without touching anything else',
                'Save as a draft and come back later, or export the .srt for your own editor',
            ],
            cta: 'Try Auto Subtitle',
            icon: Type,
            accent: { ring: 'ring-orange-500/30', bg: 'from-orange-500/15 to-amber-500/5', text: 'text-orange-300', btn: 'bg-orange-500 hover:bg-orange-400 text-black' },
            // Auto Subtitle demo composition.
            //
            // Permanent samples live at dashboard/public/samples/*.mp4 —
            // committed alongside the project so they survive clearing
            // your Desktop or Downloads. Vite serves dashboard/public/*
            // at the URL root in dev AND the build copies it into dist/
            // for prod, so the same URL works in both modes.
            //
            // Layout: ONLY the two curated samples below are rendered.
            // We deliberately ignore subtitleDemos (auto-fetched past
            // project outputs) so noisy past jobs — e.g. a music-video
            // job whose output kept the song instead of speech — don't
            // appear here. The user explicitly asked for "just English
            // + Italian" on this section.
            //   • Source = source-original.mp4 (testing.mp4)
            //   • Outputs:
            //       - subtitle-english.mp4   (English subtitle Sample.mp4)
            //       - subtitled-italian.mp4  (subtitled_italian.mp4)
            demo: featuredOrFallback('subtitle', {
                source: '/samples/source-original.mp4',
                sourceLabel: 'Original (no subtitles)',
                outputs: [
                    {
                        url: '/samples/subtitle-english.mp4',
                        label: 'English subtitles',
                        sublabel: 'Burned-in caption sample',
                    },
                    {
                        url: '/samples/subtitled-italian.mp4',
                        label: 'Italian subtitles',
                        sublabel: 'Translate-then-burn sample',
                    },
                ],
                outputsHeading: 'Subtitled versions',
            }),
        },
        {
            id: 'dub',
            tabId: 'dub',
            title: 'Voice Dubbing',
            tagline: 'Re-voice the whole video into 30+ languages.',
            description:
                "Same context-aware pipeline: transcribe → AI fixes mishears → translate → synthesize voice → mix with your video. Free Microsoft Edge voices in 21 languages out of the box, or bring an ElevenLabs key for voice cloning. Optional: keep the original speaker audible underneath, documentary-style.",
            bullets: [
                '21 free Edge TTS languages, or ElevenLabs voice cloning if you have a key',
                'Auto / male / female voice selection',
                "Pull the source from a paste-link or upload — works with TikTok, YouTube, X, Instagram, and more",
            ],
            cta: 'Try Voice Dubbing',
            icon: Languages,
            accent: { ring: 'ring-emerald-500/30', bg: 'from-emerald-500/15 to-teal-500/5', text: 'text-emerald-300', btn: 'bg-emerald-500 hover:bg-emerald-400 text-black' },
            // Voice Dubbing demo — fully static, same lock as the
            // subtitle section. We deliberately ignore any past dub
            // jobs the user has run; only the curated samples in
            // dashboard/public/samples/ ever appear here.
            //
            //   • Source  = source-original.mp4 (testing.mp4)
            //   • Outputs:
            //       - dub-german.mp4 (dubbed_subtitled_de_*.mp4)
            //       - dub-french.mp4 (French Dubbed.mp4)
            demo: featuredOrFallback('dub', {
                source: '/samples/source-original.mp4',
                sourceLabel: 'Original',
                outputs: [
                    {
                        url: '/samples/dub-german.mp4',
                        kind: 'video',
                        label: 'Dubbed → German',
                    },
                    {
                        url: '/samples/dub-french.mp4',
                        kind: 'video',
                        label: 'Dubbed → French',
                    },
                ],
                outputsHeading: 'Dubbed into different languages',
            }),
        },
        {
            id: 'podcast',
            tabId: 'podcast',
            title: 'Podcast Studio',
            tagline: 'Record high-quality remote video & audio interviews.',
            description:
                "Host virtual podcast sessions. Connect with your guest using an instant low-latency WebRTC link. Ensure 100% crash-proof recording by streaming high-fidelity audio/video directly to your local hard drive. Toggle background blur for messy rooms, and draw annotations live on shared screens.",
            bullets: [
                'Direct-to-Disk (File System Access) streams recordings directly to hard drive',
                'IndexedDB backup cache guarantees zero lost recordings if a browser crashes',
                'Annotation canvas overlays allow live screen share drawings and text overlays',
            ],
            cta: 'Open Podcast Studio',
            icon: Mic,
            accent: { ring: 'ring-pink-500/30', bg: 'from-pink-500/15 to-rose-500/5', text: 'text-pink-300', btn: 'bg-pink-500 hover:bg-pink-400 text-black' },
            demo: false,
        },
    ];

    return (
        <div className="h-full overflow-y-auto custom-scrollbar">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14 animate-[fadeIn_0.3s_ease-out]">

                {/* Hero — punchy single-line headline that names the
                    three actions in order, plus a one-line value prop
                    underneath. The pill above gives a personal greeting
                    when the user is signed in. */}
                <header className="text-center mb-12 sm:mb-16">
                    <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] uppercase tracking-wider text-primary mb-5">
                        <Sparkles size={12} /> {currentUser ? `Welcome back${currentUser.full_name ? ', ' + currentUser.full_name.split(' ')[0] : ''}` : 'Welcome to Klipra'}
                    </div>
                    <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight leading-[1.05]">
                        <span className="bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">Create viral clips,</span>
                        <br className="hidden sm:block" />
                        <span className="bg-gradient-to-r from-orange-300 via-primary to-emerald-300 bg-clip-text text-transparent">captions, and dubs</span>
                        <br className="hidden sm:block" />
                        <span className="bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">from any video.</span>
                    </h1>
                    <p className="mt-5 text-zinc-400 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
                        Drop a long video in. Get back vertical shorts ready for TikTok, subtitles burned in any language, and dubs in 30+ tongues — using the AI providers you already pay for.
                    </p>
                    <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                        <button
                            onClick={() => onChooseTab?.('dashboard')}
                            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-500 text-white font-bold text-sm shadow-glow"
                        >
                            <Sparkles size={16} /> Generate viral clips
                        </button>
                        <button
                            onClick={() => onChooseTab?.('subtitle')}
                            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-white/15 hover:bg-white/5 text-zinc-200 text-sm font-medium"
                        >
                            <Type size={16} /> Auto Subtitle
                        </button>
                        <button
                            onClick={() => onChooseTab?.('dub')}
                            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-white/15 hover:bg-white/5 text-zinc-200 text-sm font-medium"
                        >
                            <Languages size={16} /> Voice Dubbing
                        </button>
                        <button
                            onClick={() => onChooseTab?.('podcast')}
                            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-white/15 hover:bg-white/5 text-zinc-200 text-sm font-medium"
                        >
                            <Mic size={16} /> Podcast Studio
                        </button>
                    </div>
                    <div className="mt-6 inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <ArrowDown size={11} /> See it on real videos below
                    </div>
                </header>

                {/* Three feature explainers, each with an embedded
                    before/after demo grid. */}
                <section className="space-y-14 mb-16">
                    {features.map((f, i) => (
                        <FeatureRow key={f.id} feature={f} reverse={i % 2 === 1} onChooseTab={onChooseTab} />
                    ))}
                </section>

                {/* "How it works" — short three-step */}
                <section className="rounded-2xl border border-white/10 bg-surface/40 p-6 sm:p-8 mb-12">
                    <h2 className="text-xl sm:text-2xl font-bold text-white mb-6 text-center">How it works</h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <Step n={1} title="Drop in a video"
                              body="Upload a file or paste a link from YouTube, TikTok, X, Instagram, Vimeo — any of the 1800+ sites yt-dlp supports. We download, transcribe, and analyse." />
                        <Step n={2} title="AI does the heavy lifting"
                              body="Bring your own Gemini, OpenAI, Anthropic, MiniMax, OpenRouter, or Groq key. Klipra never marks up your AI bill — you pay the provider directly at their rates." />
                        <Step n={3} title="Edit, restyle, post"
                              body="Per-clip retrim, reframe, subtitle, dub, hook overlay. Save drafts, post directly to socials via Upload-Post, or download and use anywhere." />
                    </div>
                </section>

                {/* Footer-ish: pricing + open-source mention */}
                <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <button
                        onClick={() => onChooseTab?.('pricing')}
                        className="text-left rounded-2xl border border-white/10 bg-gradient-to-br from-primary/10 to-blue-500/5 p-5 hover:border-primary/30 transition group"
                    >
                        <div className="text-[11px] uppercase tracking-wider text-primary font-bold mb-2">Pricing</div>
                        <div className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                            Honest pricing for AI clipping
                            <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition" />
                        </div>
                        <div className="text-sm text-zinc-400 leading-relaxed">
                            Self-host free, hosted Free / Pro / Studio / Agency. BYOK across the board. Regional pricing available.
                        </div>
                    </button>
                    <a
                        href="https://github.com/Ilmeaalim/klipra"
                        target="_blank" rel="noreferrer"
                        className="text-left rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-700/20 to-zinc-900/20 p-5 hover:border-white/30 transition group block"
                    >
                        <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-bold mb-2">Open source</div>
                        <div className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                            <Github size={16} /> Run it yourself
                            <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition" />
                        </div>
                        <div className="text-sm text-zinc-400 leading-relaxed">
                            The full source is on GitHub. Bring your own keys, run on your own machine, no usage cap, no markup.
                        </div>
                    </a>
                </section>
            </div>
        </div>
    );
}

function FeatureRow({ feature, onChooseTab }) {
    const Icon = feature.icon;
    return (
        // Top: explainer text + CTA. Bottom: full-width before/after
        // demo grid so visitors can compare original vs output without
        // any horizontal squeezing.
        <div className="rounded-3xl border border-white/10 bg-surface/30 p-5 sm:p-7">
            <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-5 sm:gap-8 items-start mb-5">
                <div>
                    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-wider font-bold ${feature.accent.text} bg-white/5 border-white/10 mb-3`}>
                        <Icon size={12} /> {feature.title}
                    </div>
                    <h3 className="text-2xl sm:text-3xl font-bold text-white leading-tight mb-2">
                        {feature.tagline}
                    </h3>
                    <p className="text-zinc-400 text-sm sm:text-base leading-relaxed mb-4">
                        {feature.description}
                    </p>
                </div>
                <div>
                    <ul className="space-y-2 mb-5">
                        {feature.bullets.map((b, i) => (
                            <li key={i} className="flex items-start gap-2 text-[13px] text-zinc-300 leading-relaxed">
                                <span className={`shrink-0 mt-0.5 w-4 h-4 rounded-full ${feature.accent.text} bg-white/5 inline-flex items-center justify-center text-[10px] font-bold`}>✓</span>
                                <span>{b}</span>
                            </li>
                        ))}
                    </ul>
                    <button
                        onClick={() => onChooseTab?.(feature.tabId)}
                        className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold ${feature.accent.btn}`}
                    >
                        {feature.cta} <ArrowRight size={14} />
                    </button>
                </div>
            </div>
            <BeforeAfterDemo demo={feature.demo} accent={feature.accent} feature={feature} />
        </div>
    );
}

function BeforeAfterDemo({ demo, accent, feature }) {
    // Three rendering states for the demo block:
    //   demo === null     → still loading. Render a placeholder so the
    //                       layout doesn't shift when the video arrives.
    //   demo === false    → confirmed no demo (no completed past
    //                       project for this product yet). Show a
    //                       descriptive empty state.
    //   demo is an object → ready. Render the before/after grid.
    if (demo === null) {
        return (
            <div className={`rounded-2xl border border-white/10 bg-gradient-to-br ${accent.bg} aspect-[16/7] flex items-center justify-center text-zinc-500 text-xs`}>
                Loading demo videos…
            </div>
        );
    }
    if (demo === false) {
        return (
            <div className={`rounded-2xl border border-white/10 bg-gradient-to-br ${accent.bg} p-8 flex flex-col items-center justify-center text-center gap-2`}>
                <Play size={28} className={accent.text} />
                <div className="text-sm text-zinc-300 font-medium">Your first {feature.title.toLowerCase()} demo will appear here</div>
                <div className="text-[11px] text-zinc-500 max-w-[320px]">
                    Run a project and we'll surface it as a real before/after example on this page so visitors see your actual output.
                </div>
            </div>
        );
    }

    // Embed demos use platform iframes; self-hosted demos use <video>
    // tags. Both share the same outer layout — an "Original" pane on
    // the left and an outputs grid on the right.
    const isEmbed = demo.kind === 'embed';
    const outCount = demo.outputs.length;
    const outputCols = outCount >= 3 ? 'grid-cols-1 sm:grid-cols-3'
                     : outCount === 2 ? 'grid-cols-1 sm:grid-cols-2'
                     : 'grid-cols-1';

    return (
        <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-3 flex items-center gap-2">
                See it on real videos
                <span className={`text-[10px] normal-case font-medium ${accent.text}`}>
                    {isEmbed
                        ? `(${outCount} live from social media)`
                        : `(${outCount} ${outCount === 1 ? 'example' : 'examples'} from your library)`}
                </span>
            </div>
            {/* lg:items-center vertically centers the outputs column
                relative to the source on the left. With 3 vertical 9:16
                tiles next to a 16:9 horizontal source, this is what
                makes the layout feel balanced. */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-3 sm:gap-4 lg:items-center">
                {/* ORIGINAL */}
                <div>
                    {isEmbed ? (
                        <EmbedTile
                            spec={demo.source}
                            accent={accent}
                            isOriginal
                            label={demo.source.label || 'Original'}
                        />
                    ) : (
                        <DemoTile
                            url={demo.source}
                            label={demo.sourceLabel || 'Original'}
                            sublabel="Source video"
                            accent={accent}
                            isOriginal
                            defaultAspect={demo.sourceAspect || '16 / 9'}
                        />
                    )}
                </div>
                {/* OUTPUTS — vertical clips/embeds are centered within
                    each grid cell via `justify-items-center`. */}
                <div>
                    <div className={`text-[10px] uppercase tracking-wider font-bold ${accent.text} mb-2`}>
                        {demo.outputsHeading || (isEmbed ? 'Posted to social platforms' : 'Outputs')}
                    </div>
                    <div className={`grid ${outputCols} gap-3 justify-items-center`}>
                        {demo.outputs.map((o, i) => (
                            isEmbed ? (
                                <EmbedTile
                                    key={i}
                                    spec={o}
                                    accent={accent}
                                    label={o.label || o.platform}
                                />
                            ) : (
                                <DemoTile
                                    key={i}
                                    url={o.url}
                                    label={o.label}
                                    sublabel={o.sublabel}
                                    accent={accent}
                                    defaultAspect={demo.outputAspect || (feature.id === 'clip' ? '9 / 16' : '16 / 9')}
                                />
                            )
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Render a platform demo tile. Two paths:
 *
 *   YouTube (full + Shorts) → iframe embed. Reliable, supports inline
 *                             playback, respects published metadata.
 *   TikTok / Facebook       → branded "Watch on …" card that opens
 *                             the public link in a new tab.
 *
 * The card path exists because iframe embeds for those two platforms
 * are unreliable in practice: TikTok's embed often returns "Video
 * isn't available" for clips it considers region-restricted, on a
 * profile that requires login, or with embedding disabled by the
 * uploader. Facebook's plugin URL likewise doesn't accept share/r/
 * short links (only canonical /reel/<id> or /<page>/videos/<id>
 * URLs), and many users only have the share link to hand. A branded
 * click-through card removes both failure modes — we still attribute
 * to the platform AND prove the content is published there, but we
 * don't need the iframe to cooperate.
 *
 * spec shape:
 *   { kind: 'youtube'|'youtube-short'|'tiktok'|'facebook',
 *     url:  '<the public link>',
 *     platform?: 'YouTube Shorts' | 'TikTok' | ...,
 *     label?:    'Posted to YouTube Shorts' | ... }
 */
function EmbedTile({ spec, accent, isOriginal, label }) {
    const built = buildEmbed(spec);
    if (!built) {
        return (
            <div className="rounded-xl border border-white/10 bg-black/40 aspect-video flex items-center justify-center text-[11px] text-zinc-500">
                Could not embed this URL
            </div>
        );
    }
    const { embedUrl, aspect, platformLabel, platformIcon, mode } = built;
    if (mode === 'card') {
        return <PlatformCard
            spec={spec} accent={accent} isOriginal={isOriginal}
            platformLabel={platformLabel} platformIcon={platformIcon}
            aspect={aspect}
        />;
    }
    // iframe path (YouTube)
    const maxW = aspect.startsWith('9 ') ? '320px' : '100%';
    return (
        <div
            className={`relative rounded-xl overflow-hidden border bg-black ${isOriginal ? 'border-white/15 ring-1 ring-white/10' : `border-white/10 ring-1 ${accent.ring}`} mx-auto w-full`}
            style={{ aspectRatio: aspect, maxWidth: maxW }}
        >
            <iframe
                src={embedUrl}
                title={label}
                className="absolute inset-0 w-full h-full"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                loading="lazy"
            />
            <div className={`absolute top-2 left-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm border bg-black/60 border-white/20 z-10 ${isOriginal ? 'text-white' : accent.text}`}>
                {platformIcon}
                {isOriginal ? '◆ Original' : platformLabel}
            </div>
            <a href={spec.url} target="_blank" rel="noreferrer"
                className="absolute top-2 right-2 inline-flex items-center text-[9px] text-white/70 hover:text-white bg-black/60 backdrop-blur-sm border border-white/20 rounded-full px-1.5 py-0.5 z-10">
                Open ↗
            </a>
        </div>
    );
}

/**
 * Branded click-through card used for platforms where iframe embeds
 * fail (TikTok, Facebook). Looks intentional — not a fallback — so
 * visitors understand the value: real content posted to real platforms.
 * Clicking anywhere opens the public URL in a new tab.
 */
function PlatformCard({ spec, accent, isOriginal, platformLabel, platformIcon, aspect }) {
    // Per-platform brand gradient. Picked colours that read as that
    // platform without us actually using their proprietary marks.
    const gradients = {
        TikTok:   'bg-gradient-to-br from-pink-600 via-purple-700 to-cyan-600',
        Facebook: 'bg-gradient-to-br from-blue-600 via-indigo-700 to-blue-800',
        YouTube:  'bg-gradient-to-br from-red-600 via-rose-700 to-red-800',
        'YouTube Shorts': 'bg-gradient-to-br from-red-600 via-rose-700 to-red-800',
    };
    const gradient = gradients[platformLabel] || 'bg-gradient-to-br from-zinc-700 to-zinc-900';
    const maxW = aspect.startsWith('9 ') ? '320px' : '100%';
    return (
        <a
            href={spec.url}
            target="_blank"
            rel="noreferrer"
            className={`relative rounded-xl overflow-hidden border ${isOriginal ? 'border-white/15 ring-1 ring-white/10' : `border-white/10 ring-1 ${accent.ring}`} mx-auto w-full block group transition-transform hover:-translate-y-0.5`}
            style={{ aspectRatio: aspect, maxWidth: maxW }}
        >
            {/* Brand-coloured backdrop. */}
            <div className={`absolute inset-0 ${gradient}`} />
            {/* Subtle dot pattern + radial highlight for depth. */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),transparent_60%)]" />
            <div className="relative h-full w-full flex flex-col items-center justify-center p-5 gap-3 text-center">
                <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur-sm border border-white/30 flex items-center justify-center text-white">
                    <PlatformGlyph platform={platformLabel} size={26} />
                </div>
                <div className="text-white text-base font-bold drop-shadow">
                    {isOriginal ? 'Watch the original' : `Posted to ${platformLabel}`}
                </div>
                <div className="text-white/80 text-[11px] leading-snug max-w-[200px]">
                    Real published clip — opens in {platformLabel}.
                </div>
                <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-white bg-white/20 backdrop-blur-sm border border-white/25 rounded-full px-3 py-1.5 group-hover:bg-white/30 transition">
                    Watch on {platformLabel} ↗
                </span>
            </div>
            {/* Top-corner badges echo the iframe tile so the row reads
                consistently whether the slot is iframe-embedded or
                card-rendered. */}
            <div className={`absolute top-2 left-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm border bg-black/40 border-white/20 z-10 text-white`}>
                {platformIcon}
                {isOriginal ? '◆ Original' : platformLabel}
            </div>
        </a>
    );
}

function PlatformGlyph({ platform, size = 16 }) {
    if (platform === 'TikTok') return <TikTokGlyph size={size} />;
    if (platform === 'Facebook') return <Facebook size={size} fill="currentColor" />;
    if (platform && platform.startsWith('YouTube')) return <Youtube size={size} />;
    return null;
}

/**
 * Translate a public social URL into a renderable iframe URL plus
 * aspect ratio + platform label. Returns null when the URL can't be
 * parsed for the given kind.
 */
function buildEmbed(spec) {
    if (!spec || !spec.url) return null;
    const kind = (spec.kind || '').toLowerCase();
    const url = spec.url;

    // YouTube full + Shorts share the same /embed/<id> URL pattern.
    // Reliable iframe embed — visitors play the clip inline.
    if (kind === 'youtube' || kind === 'youtube-short' || /youtu\.?be/i.test(url)) {
        const id = extractYouTubeId(url);
        if (!id) return null;
        const isShort = kind === 'youtube-short' || /\/shorts\//i.test(url);
        return {
            mode: 'iframe',
            embedUrl: `https://www.youtube.com/embed/${id}?modestbranding=1&rel=0&playsinline=1`,
            aspect: isShort ? '9 / 16' : '16 / 9',
            platformLabel: isShort ? 'YouTube Shorts' : 'YouTube',
            platformIcon: <Youtube size={9} />,
        };
    }
    // TikTok — render as a click-through card. TikTok's iframe embed
    // is unreliable in practice ("Video isn't available" for region-
    // restricted, login-required, or embed-disabled clips), so we
    // skip the iframe and ship users straight to the platform.
    if (kind === 'tiktok' || /tiktok\.com/i.test(url)) {
        return {
            mode: 'card',
            aspect: '9 / 16',
            platformLabel: 'TikTok',
            platformIcon: <TikTokGlyph size={9} />,
        };
    }
    // Facebook — same story. The plugin URL is finicky about /share/r/
    // short links and refuses to play many videos when not signed in.
    // A branded card is more reliable and still attributes the post.
    if (kind === 'facebook' || /facebook\.com/i.test(url)) {
        return {
            mode: 'card',
            aspect: '9 / 16',
            platformLabel: 'Facebook',
            platformIcon: <Facebook size={9} />,
        };
    }
    return null;
}

function extractYouTubeId(url) {
    // Handles youtu.be/<id>, youtube.com/watch?v=<id>,
    // youtube.com/shorts/<id>, youtube.com/embed/<id>.
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) {
            return u.pathname.slice(1).split(/[/?]/)[0] || null;
        }
        if (u.pathname.startsWith('/shorts/')) {
            return u.pathname.split('/')[2] || null;
        }
        if (u.pathname.startsWith('/embed/')) {
            return u.pathname.split('/')[2] || null;
        }
        return u.searchParams.get('v');
    } catch { return null; }
}

function extractTikTokId(url) {
    // Match /video/<id> in either the user-page or short-link form.
    const m = String(url).match(/\/video\/(\d+)/);
    return m ? m[1] : null;
}

function TikTokGlyph({ size = 9 }) {
    // Tiny inline SVG — lucide doesn't ship a TikTok mark. Sized via
    // prop so the same glyph works in the corner badge (small) and
    // the centred brand block (larger) of the card view.
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
            <path d="M21 8.13a8.5 8.5 0 0 1-5-1.67v8.79a6.75 6.75 0 1 1-6.75-6.75c.4 0 .77.04 1.14.11v3.4a3.4 3.4 0 1 0 2.4 3.24V2h3.31a5.2 5.2 0 0 0 4.9 4.9V8.13z" />
        </svg>
    );
}

function DemoTile({ url, label, sublabel, accent, isOriginal, defaultAspect = '16 / 9' }) {
    // The container's aspect ratio starts at the caller's hint
    // (so we don't flash a wrong shape during loading) and snaps to
    // the video's intrinsic ratio the moment metadata is available.
    // This is what makes a 9:16 vertical clip render tall and a 16:9
    // horizontal source stay wide on the same page without forcing
    // either of them into the wrong box.
    const [aspect, setAspect] = React.useState(defaultAspect);
    // GRACEFUL MISSING-FILE HANDLING — when the URL points at a
    // sample that doesn't exist on disk yet (e.g. dub-before.mp4
    // before the operator has dropped one in dashboard/public/samples),
    // the <video> tag would otherwise sit there showing a black box
    // forever. We watch for the load failure and hide the entire
    // tile, which is much cleaner than an empty rectangle on the
    // homepage.
    const [loadFailed, setLoadFailed] = React.useState(false);
    const handleMeta = (e) => {
        const v = e.target;
        if (v.videoWidth && v.videoHeight) {
            setAspect(`${v.videoWidth} / ${v.videoHeight}`);
        }
    };
    if (loadFailed) {
        return null;
    }
    // Cap vertical (taller-than-wide) samples at 180 px wide so they
    // VISUALLY match the Generate Clips section's output tiles.
    //
    // Why 180 and not 320: EmbedTile uses a 320 px cap, but in the
    // Generate Clips section it has 3 outputs squeezed into the right
    // column, which forces each tile to ~180 px regardless of the cap.
    // The Auto Subtitle section has fewer outputs, so without a tighter
    // cap a vertical tile expanded to fill its column (~320 px) and
    // looked much larger than the Generate Clips tiles. Setting the cap
    // to 180 makes it the binding constraint regardless of column
    // count, so vertical tiles look the same size everywhere on the
    // homepage. Horizontal tiles still use 100% so they fill naturally.
    const isVertical = aspect.includes('/') && (() => {
        const [w, h] = aspect.split('/').map((s) => parseFloat(s.trim()));
        return w && h && w < h;
    })();
    const maxW = isVertical ? '180px' : '100%';
    return (
        <div
            className={`relative rounded-xl overflow-hidden border bg-black ${isOriginal ? 'border-white/15 ring-1 ring-white/10' : `border-white/10 ring-1 ${accent.ring}`} mx-auto w-full`}
            style={{ aspectRatio: aspect, maxWidth: maxW }}
        >
            <video
                src={url}
                muted autoPlay loop playsInline controls
                preload="metadata"
                onLoadedMetadata={handleMeta}
                onError={() => setLoadFailed(true)}
                className="w-full h-full object-contain bg-black"
            />
            <div className={`absolute top-2 left-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm border ${isOriginal ? 'bg-black/60 text-white border-white/20' : `bg-black/60 ${accent.text} border-white/20`}`}>
                {isOriginal ? '◆ Original' : label}
            </div>
            {sublabel && (
                <div className="absolute bottom-2 left-2 right-2 text-[10px] text-white/85 bg-black/60 backdrop-blur-sm rounded-md px-2 py-0.5 truncate">
                    {sublabel}
                </div>
            )}
        </div>
    );
}

function Step({ n, title, body }) {
    return (
        <div className="rounded-xl border border-white/5 bg-black/30 p-4">
            <div className="text-[10px] uppercase tracking-wider text-primary font-bold mb-2">Step {n}</div>
            <div className="text-base font-bold text-white mb-1">{title}</div>
            <div className="text-[13px] text-zinc-400 leading-relaxed">{body}</div>
        </div>
    );
}
