# Klipra — YouTube Launch Video Script

**Title (working):** I Spent 6 Months Rebuilding This Open-Source AI App So You Can Make Viral Shorts For Free
**Sub-title alt:** Stop Paying $50/mo For AI Video Tools — I Made This Free
**Target length:** 25–30 minutes
**Pace assumption:** ~140 words/min spoken → target ~4,000 words
**Style:** Personal, screen-share heavy. First-person ("I"), warm, opinionated, **no filler**.

> **How to use this script**
> Words in *italics* = your spoken voice-over. Lines in **[brackets]** are camera / B-roll / screen directions for the editor. Aim to keep it conversational — read it twice, then re-record without staring at the page.

---

## 0:00 — 0:45 · The Cold-Open Hook

**[B-ROLL: fast-cut montage — a 45-minute YouTube interview shrinking into 6 vertical shorts, each with a different hook overlay, subtitles flying word-by-word, TikTok / Reels / Shorts logos popping in.]**

*"What if I told you that this single horizontal YouTube video..."*

**[SHOW: a long YouTube video on a laptop screen, then drag it into Klipra]**

*"...just became eight viral vertical clips, with subtitles, with viral hooks, with the camera magically following the speaker's face — and the AI behind all of it costs me literally zero dollars per month?"*

**[CUT TO YOU on camera — well-lit, smiling]**

*"Hey, I'm Muqaddas. For the last six months, I have been re-engineering an open-source AI clip generator into something I actually want to use every single day. I'm calling it Klipra. It's free, it's open-source, it runs on your own computer, and starting today, you can install it."*

*"In the next twenty-five minutes I'm going to show you exactly how I use it to take one long horizontal video — like the kind you and I record for YouTube — and turn it into a whole week's worth of shorts. Stay with me, because at minute eighteen I'm going to show you something that took me a month of full-time work to get right, and most paid tools still cannot do it properly."*

**[LOWER-THIRD: Muqaddas Shahzad · founder, ilmeaalim.com · github.com/muqaddashahzad/Klipra]**

---

## 0:45 — 3:30 · The Honest Origin Story

**[B-ROLL: Slow scroll through the OpenShorts GitHub repo, then a cut to your terminal forking it.]**

*"Let me be upfront with you. I did not build Klipra from scratch. Earlier this year I was googling for an AI clip generator I could self-host, and I stumbled on a beautiful open-source project called OpenShorts. Big credit to the original team — they put the foundations under it under the MIT licence, and that's the only reason what I'm about to show you is even possible."*

*"But when I tried to actually use OpenShorts for my own content, I hit three walls."*

**[SHOW: numbered text on screen as you say each one]**

*"Wall number one — every single AI step demanded a paid Google Gemini API key. Clip picking, transcript cleanup, motion graphics, every step. If you don't have a credit card on Google, you literally cannot run it."*

*"Wall number two — the clip picker was a single text-only pass. It would read the transcript and guess where the funny bits were. It never actually watched the video. So it would pick a moment where the speaker says 'this is hilarious' even when nothing visually was happening on screen."*

*"And wall number three — the reframer would dumbly centre-crop a 16:9 video into 9:16. So if your speaker is sitting on the left side of the frame, half their face just gets sliced off."*

*"So I forked it. I sat down for six months, and I rebuilt almost everything."*

**[B-ROLL: time-lapse of git log scrolling — show the 188+ commits if you want, it's impressive]**

*"Today, almost every line of the FastAPI backend has been rewritten or added. The whole dashboard is new. There's a multimodal Smart Clipper that actually watches the frames. There's a keyframed reframer with face tracking that snaps to scene cuts. There's a five-stage pro pipeline. There's a voice-dubbing pipeline in thirty-plus languages. There's a Roman-Urdu and Hinglish subtitle mode for creators who make content in those languages. And — most importantly — every AI step now has a free option. You can run the entire thing on your own MacBook with zero API keys and zero ongoing cost."*

*"I'm making the whole repository public today. The link is in the description. Now let me show you what it actually does."*

---

## 3:30 — 5:30 · Why "Free" Was Worth Six Months Of My Life

**[ON CAMERA, talking directly to the audience]**

*"Before I share my screen, let me explain why I made the free-AI thing such a big deal — because it's the single decision that defines this project."*

*"Most AI clip generators on the market — and I'm not naming names — charge between thirty and ninety-nine dollars a month. You pay even when you don't use it. You're capped on minutes. And the moment the company decides to pivot, your workflow dies overnight."*

*"I have a YouTube channel. My audience are mostly creators from Pakistan, India, Indonesia, the Philippines. Thirty dollars a month is a lot of money in these places. I refused to build a product that priced out the people I'm building it for."*

**[SHOW: ollama.com homepage on screen]**

*"So I integrated something called Ollama. Ollama is a free, open-source piece of software that lets you run language models — like Llama 3, Qwen, Mistral — locally on your own computer. No API key, no subscription, no internet required after you download the model once."*

*"In Klipra, you can pick Ollama as the provider for every single AI step. The clip picker, the subtitle cleanup, the transliteration into Roman script, the motion-graphics planner, the dub-prompt writer — all of it runs on your machine. The output quality with a model like Qwen 2.5 fourteen billion parameters is — and I am not exaggerating here — indistinguishable from Gemini for most of my workflows."*

*"You can still plug in a paid API key if you want — Gemini, ElevenLabs, OpenAI, anything. The point is you no longer have to. The free path is a first-class citizen."*

*"OK, demo time."*

---

## 5:30 — 8:00 · Installing Klipra On Your Mac In 4 Minutes

**[SCREEN SHARE — go to github.com/muqaddashahzad/Klipra]**

*"Step one. Open up your browser and go to github dot com slash muqaddashahzad slash Klipra. The link is pinned in the description and the first comment."*

*"You'll need two things on your computer: Docker Desktop and Git. If you're on a Mac and you've never installed Docker, just go to docker dot com, hit Download Desktop, double-click the dmg. Takes about two minutes."*

**[SHOW: docker.com → download → install]**

*"Once Docker is running, you open Terminal — on Mac that's Command-Space, type 'terminal', hit enter — and you copy-paste these three lines."*

**[ON SCREEN — large readable monospaced text:]**

```
git clone https://github.com/muqaddashahzad/Klipra.git
cd Klipra
docker compose up -d
```

*"That's it. Git clone pulls the code. CD moves into the folder. Docker compose up dash D starts the three containers — backend, frontend, renderer — in the background. The first run takes about ten minutes because Docker has to download the Python image, Whisper, ffmpeg, and so on. After that, every restart is under thirty seconds."*

**[CUT TO: browser opening http://localhost:5175 with the Klipra dashboard loaded]**

*"And then in your browser you visit localhost colon five-one-seven-five and there's the app. That's the whole install."*

*"If you want the truly free path, do one more thing — download Ollama from ollama dot com, it's a normal Mac app, double-click it, then double-click the file called Install-Ollama-Model dot command inside the Klipra folder. That pulls down the Qwen 2.5 fourteen-billion model, which I've found to be the sweet spot of speed and quality on a sixty-four-gig M1 Mac."*

*"OK, the app is running. Let's actually make some clips."*

---

## 8:00 — 14:30 · Generate Viral Clips — The Full Pipeline

**[SCREEN SHARE — Klipra dashboard, click "Generate Viral Clips"]**

*"This is the flagship product. Three inputs, then it does everything."*

**[POINT to the three tabs]**

*"You can paste a YouTube URL, upload a video file, or — my favourite — pick a video that's already on your hard drive without re-uploading it. That last option uses something called local-file mode that I added because I have hundreds of gigabytes of footage on this Mac and I am not waiting three hours to upload a four-gig file."*

*"For this demo I'm going to use a forty-five-minute interview I recorded last week — a horizontal sixteen-by-nine YouTube video. I drop it in."*

**[CUT: drag the video onto the upload zone, watch upload indicator]**

*"Below the upload zone, here is the magic of Klipra. The Provider dropdown. By default it's set to Ollama, because I want the free path. If I open this dropdown, you can see Klipra has auto-detected every model I've already downloaded — Qwen 2.5 fourteen-bee, Llama 3.2 Vision, Mistral. No copy-pasting model names. It just shows you what you have. If Ollama isn't running, this dropdown literally tells you 'Ollama daemon offline' with a link to start it."*

**[POINT to provider dropdown, click between options]**

*"For this video I'll pick Qwen 2.5 fourteen-bee because it's my workhorse. Then I hit 'Generate Clips'."*

**[CUT: Klipra processing animation kicks in — show the Sora-style progress panel]**

*"Now what's happening behind the scenes is something I want you to actually understand, because it's why this works."*

**[OVERLAY: numbered steps appear as voice-over describes them]**

*"Step one — Klipra runs Whisper on the video to get a word-level transcript with timestamps. On a Mac, if you've enabled the Metal sidecar — a free thing I built that runs Whisper on the Apple Silicon GPU — this step is ten to fifteen times faster than the default CPU version."*

*"Step two — Klipra detects scene cuts in the video. This matters because we don't want a clip that starts mid-sentence or right after a hard scene transition."*

*"Step three — the AI picks four to eight viral moments. It looks at every sentence in the transcript, scores it on six different signals — punchline, reversal, awkward pause, one-liner energy, audio peak, visual energy — and picks the highest combined score across non-overlapping windows."*

*"Step four — for each picked moment, Klipra cuts the clip from the source video."*

*"Step five — the reframer. This is where I spent more time than anywhere else. It does not centre-crop. It detects the speaker's face every two seconds using MediaPipe, draws a 9:16 box around the face, and keyframes the box so the camera smoothly follows the speaker. If there's a scene cut in the middle of the clip, the box snaps instantly instead of slowly panning."*

*"Step six — subtitles burn on top, word by word, with the active word highlighted in your accent colour. Step seven — a viral hook overlay appears at the top of the screen, with emojis rendered as real raster glyphs so you don't see tofu boxes."*

**[CUT: the processing finishes, eight result cards appear]**

*"And there we go. Eight clips from one interview. Each one has its own thumbnail, its own unique hook — they're not all the same title, because Klipra regenerates a hook per clip from the actual transcript content inside that clip's time range — and each one has a row of action buttons."*

*"Subtitle. Dub. Edit. Reframe. Motion graphics. Retrim. Post. Each one opens a modal where you can fine-tune that specific clip without re-running the whole pipeline. That's the thing that takes other tools three minutes per change — in Klipra it's instant, because the source video is cached and we only re-burn the modified bits."*

---

## 14:30 — 17:30 · Smart Clipper — When You Want The AI To Watch The Video

**[SCREEN SHARE — click on Smart Clipper tab]**

*"OK, you saw the standard pipeline. Now let me show you the experimental one I've been refining for the last two months — Smart Clipper."*

*"The difference is this. The standard pipeline only reads the transcript. Smart Clipper actually looks at the frames of the video. It samples one frame every few seconds, sends those frames to a vision-language model, and lets the AI reason about visual context — body language, expressions, on-screen text, dramatic gestures — at the same time as the transcript."*

*"There are two modes. Fast and Pro."*

**[POINT to the Fast / Pro toggle]**

*"Fast is a single-pass picker. You give it the video, it returns clips. The whole thing takes about ninety seconds on a fourteen-minute source. Use this when you want speed."*

*"Pro is a five-stage pipeline. Stage one transcribes. Stage two translates the transcript if needed. Stage three analyses every frame of the video, one by one, for visual signals. Stage four scores every possible window — three different window sizes, fifteen, thirty, sixty seconds — using the same six-signal rubric. Stage five greedy-selects non-overlapping winners and snaps each clip to the nearest sentence boundary so nothing starts or ends mid-word."*

*"Pro takes about ten to fifteen minutes for a forty-five-minute video, but the picks are noticeably better. I use Pro for the videos I actually care about and Fast for the rest."*

**[CUT: demo run of Pro mode showing stage progress]**

*"And — same as before — both Fast and Pro modes work with Ollama. You don't need a paid VLM key. If you have Llama 3.2 Vision installed in Ollama, Klipra will pick it up and run the whole visual analysis on your own GPU."*

---

## 17:30 — 21:00 · Retrim And Edit — When The AI Is Almost Right

**[SCREEN SHARE — point to a result clip]**

*"OK, here's the part of the video where I have to be honest with you. AI clip pickers are not perfect. Sometimes they pick a moment that starts two seconds too early, and the speaker is still saying 'and so anyway' as the clip opens. Sometimes they end three seconds too late and you catch dead air."*

*"Every other tool I tried solves this by making you delete the clip and re-run the whole pipeline. Insane. I built two modals to fix it without re-running anything."*

**[CLICK: Retrim button on a clip]**

*"This is the Retrim modal. I rewrote this three times. Look at it."*

*"You get a visual scrubber of the original source video, not the cut clip. So you can see context on either side of your clip — what came before, what comes after. The two green and red handles are the in-point and the out-point. You drag them with the mouse. You can zoom in if you need frame-accuracy. You can play just the selected range. You can mark IN at the current playhead with the I key, OUT with the O key — like a real video editor. There's an audio waveform underneath so you can SEE where the silences are. There's a playback-speed slider so you can scrub through quietly at four-x speed. And — the thing I'm proudest of — every edit is auto-saved to local storage with an Undo button, so if you close the modal by accident you don't lose your changes."*

*"That last bit was a real frustration of mine with paid tools. You spend ten minutes lining up a clip, you accidentally hit Escape, everything's gone. Not here."*

**[CUT: open the Edit modal on a clip]**

*"This is the Edit modal. Same modern design — sticky frosted header, gradient buttons, glass pill transports. But what it actually does — it lets you add motion regions and colour regions to specific time-ranges inside your clip."*

*"Motion presets — zoom-punch where the camera pulses in time with an emphatic word, slow-pan where the camera slowly drifts across the frame, ken-burns. Colour presets — warm-cinematic, cold-thriller, vintage-film, high-contrast-punchy. You pick a preset, you click 'Add region at playhead', you set the duration, you hit Preview. The preview is a low-res quick render so you don't wait."*

*"And there's a synthetic SFX library I built — whoosh, pop, impact, ding, riser. You can attach an SFX cue to any motion region. So your zoom-punch lands with an audible punch sound. That's the kind of thing that makes a clip actually feel viral instead of just being a re-cropped rectangle."*

---

## 21:00 — 23:30 · Standalone Subtitle — When You Just Want Subtitles

**[SCREEN SHARE — Standalone Subtitle tab]**

*"Sometimes you don't want to generate clips. You already have a clip — say, something you cut by hand, or something a friend sent you — and you just want professional, animated, word-level subtitles burned onto it. That's what the Standalone Subtitle product does."*

*"Three phases. Phase one — you upload the video, you tell Klipra the source language, and it transcribes. Phase two — you pick the subtitle style. There are pre-built templates. There's word-highlight, word-box, pop, karaoke, glow — five different animations, all libass-rendered so they look broadcast-clean. You can pick the font, the colour, the position, the highlight colour. There's a live preview. Phase three — it burns."*

*"And then there's the part that I'm probably most proud of as a creator. Look here."*

**[POINT to language picker]**

*"Hinglish. Roman Urdu. Urglish. These are not standard categories in any other tool I've seen. Hinglish is for when you're speaking a mix of Hindi and English and you want the subtitles in Roman script — so 'main kal market jaaonga' instead of the Devanagari. Roman Urdu is the same for Urdu. Urglish is a mode I made specifically for code-switched content where the English words should stay as English and only the non-Latin script gets transliterated."*

*"I built these because my friends in Pakistan and India kept asking me — 'Muqaddas, every subtitle tool turns my videos into pure Urdu or pure Hindi script, but my audience reads Roman, they don't read Nasta'liq.' So I built it. And the model retries any segment that comes back with the wrong script, so you actually get clean Roman output."*

**[OPTIONAL: BYOL demo]**

*"There's also a 'Bring Your Own Lyrics' panel if your video is a song. You paste the lyrics, Klipra uses an LLM to align them to the audio segment-by-segment. So you can subtitle a music video with the real lyrics — capitalisation, punctuation, ad-libs — not the broken stuff Whisper hears."*

---

## 23:30 — 25:00 · Voice Dubbing In 30 Languages

**[SCREEN SHARE — Standalone Voice Dub tab, or click Dub button on a clip]**

*"Two minutes on this one because it's straightforward."*

*"Klipra hooks into ElevenLabs to dub any clip into more than thirty languages. You pick the target language, you pick a voice, you hit Dub. Behind the scenes Klipra transcribes the source, translates the transcript with an LLM, generates the new voice track in the target language, and stitches it back onto the original video — keeping the music bed and the original ambient audio underneath."*

*"And — here's the killer feature — after the dub finishes, there's a button that says 'Burn target-language subtitles on top.' One click. It takes the translated transcript, aligns it to the new dubbed audio, and burns Spanish or German or Arabic subtitles right onto the dubbed video. So you get a localised clip with localised audio and localised subtitles, in one flow."*

*"ElevenLabs is paid, so this one specific step isn't free. But you can dub one fifteen-second clip for fractions of a cent. I'd rather have it as an option than not."*

---

## 25:00 — 26:30 · Reframe And Motion Graphics — The Polish Layer

**[SCREEN SHARE — Reframe modal]**

*"The Reframe modal lets you change the aspect ratio of a clip after the fact. Nine-sixteen for TikTok and Reels. Sixteen-nine for YouTube. One-to-one for Instagram feed. Or a custom ratio if you have a specific platform in mind."*

*"You drag a crop rectangle around the part of the frame you want to keep. The video plays with audio inside the modal — small thing but most tools mute the preview. You can set keyframes at any point on the timeline if you want the crop to move during the clip — for example, panning over to a new speaker when they start talking."*

**[CUT: Motion Graphics modal]**

*"And the Motion Graphics modal — what I call AI Magic Overlays — is the bow on the present. Auto mode is one button. You hit it. Klipra sends the transcript and the visual context to the AI, and it decides where to add zooms, where to flash a callout box with text, where to put a highlight strip with a punchy quote. Manual mode lets you place each overlay by hand if you want full control. And every text overlay is face-aware, so the AI won't put a giant headline on top of the speaker's nose."*

---

## 26:30 — 28:00 · Posting To Social And The Influencer Programme

**[SCREEN SHARE — Post modal]**

*"Final piece. Once a clip is ready, you can post it directly to TikTok, Instagram Reels, or YouTube Shorts without leaving Klipra. Hit Post, pick the platform, write the caption, schedule a time, done. This uses an integration called Upload-Post — it's the only paid piece of this stack and you don't need it if you're happy to download and post manually."*

*"There's also a weekly scheduler. If you generated eight clips, you can click 'Schedule across the week' and Klipra will spread them automatically across the platforms over the next seven days."*

---

## 28:00 — End · Why I'm Open-Sourcing This

**[CUT TO YOU on camera — same lighting as the intro]**

*"OK. That's the tour. Let me close with the why."*

*"I spent six months on this not because I wanted to build a startup. I spent six months on it because I genuinely could not find an AI clip tool that respected my time, respected my wallet, and respected the fact that I make content in three languages."*

*"I'm putting it on GitHub today, fully open-source, MIT licensed, with no paywall and no telemetry. If you want to use Klipra, install it. If you want to fix something, send a pull request. If you want to fork it and build your own thing on top, please do — that's literally how Klipra exists in the first place."*

*"All I ask is two things. First, if you build something with Klipra, tag me. I want to see what you make. Second, if Klipra saves you a subscription, please pay it forward — star the repo on GitHub, share this video, tell one other creator about it. Open source only works when the audience shows up."*

**[ON-SCREEN: github.com/muqaddashahzad/Klipra · big and readable]**

*"Links to the GitHub repo, the install instructions, my email, and my other channels are all in the description. If you got value from this video, hit subscribe — I'm going to drop a deep-dive on each of the four products as separate tutorials over the next few weeks."*

*"And if you have a specific feature you want me to add, drop it in the comments. I genuinely read every one. That's how the Hinglish subtitle mode happened. That's how the Retrim modal happened. Your feedback shapes the next version."*

*"I'm Muqaddas, thanks for spending half an hour with me, and I'll see you in the next one."*

**[OUTRO: 5-second logo card · GitHub URL · subscribe button]**

---

## Appendix — Pinned Comment + Description Box

Use this as the pinned comment and copy a shorter version into the YouTube description.

```
👋 Klipra is live and free.

📦 GitHub:           https://github.com/muqaddashahzad/Klipra
🎯 Hosted version:    https://klipra.ilmeaalim.com
💬 Bugs / feature requests: open an issue on the repo
📧 Me:               muqaddas@ilmeaalim.com

⏱  Chapter markers
0:00  The hook
0:45  Why I forked OpenShorts
3:30  Free AI > Paid subscriptions
5:30  Install in 4 minutes
8:00  Generate Viral Clips (full pipeline)
14:30 Smart Clipper — Fast vs Pro
17:30 Retrim & Edit modals
21:00 Standalone Subtitle (Hinglish / Roman Urdu / BYOL)
23:30 Voice Dubbing in 30+ languages
25:00 Reframe & AI Motion Graphics
26:30 Posting & scheduling
28:00 Why I'm open-sourcing this

🙌 Credits: Klipra is a fork of the OpenShorts project (MIT licence).
   Huge thanks to @mutonby for the original foundations.

If Klipra saves you a subscription, please ⭐ the repo and share
this video with one creator who'd benefit.
```

---

## Appendix — Production checklist

Before you hit record, sanity-check these:

- Klipra is running locally on your laptop and your camera-feed app isn't fighting with Docker for memory.
- You have at least one clean horizontal source video pre-loaded — a 30-to-60-min interview is ideal because the AI has more to pick from.
- You have one shorter "demo failure" clip (where the AI mis-picks) ready, so the Retrim modal demo has real stakes.
- Your provider dropdown shows at least one Ollama model so the "free" promise lands on screen.
- ElevenLabs key set so the dub demo isn't a placeholder.
- A second monitor or split-screen so your face-cam and the screen-share can both be visible.
- Backup your `output/` and `data/` folders before re-recording, because the demo will create new clips.
- Camera framing: rule-of-thirds, eye-line slightly above lens centre, soft key from camera-left.

---

## Appendix — Thumbnail copy options

Pick one. All under five words for mobile legibility.

1. **I REBUILT THIS AI TOOL — IT'S FREE NOW**
2. **STOP PAYING $50/mo FOR THIS**
3. **MY $0 VIRAL CLIPS WORKFLOW**
4. **OPEN-SOURCE OPUS CLIP — FREE**
5. **THE FREE OPUS CLIP ALTERNATIVE**

Pair the text with a split-screen thumbnail — left side a still of you pointing, right side a phone showing a TikTok/Reel with subtitles burned on. The contrast sells "manual → automated".
