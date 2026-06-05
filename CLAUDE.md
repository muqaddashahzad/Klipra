# CLAUDE.md — Klipra

This file is the **entry point** for any AI agent (Claude Code, Cursor, etc.) working on this codebase. Read it before doing anything else.

## What Klipra is

**Klipra** is an AI-powered viral video platform. The user (Muqaddas, muqaddas@ilmeaalim.com) is building it as the operator of ilmeaalim.com. It runs locally on her M1 MacBook Pro (64 GB) via Docker Compose, and in production at **klipra.ilmeaalim.com** on a Hetzner VPS (46.62.194.70) behind Plesk.

The codebase was forked from the open-source `openshorts` project, but has diverged substantially. Treat the README.md and any "OpenShorts" references as legacy — the product is Klipra.

### Five user-facing products

1. **Generate Viral Clips** (full pipeline) — Drop a YouTube URL or video file; Klipra transcribes, picks the best 4–8 viral moments, cuts them, reframes 16:9 → 9:16 with face tracking, burns subtitles, adds viral hook overlays, and optionally posts to TikTok/Instagram/YouTube. Code lives in `main.py` + `app.py`.

2. **AI Audio Cleaning** (`StandaloneAudioClean.jsx`, `clearcast/`) — Adobe Podcast Enhance, self-hosted and open-source. Upload audio or video; the engine auto-diagnoses every problem (noise, reverb, hum, clipping, sibilance) and applies targeted fixes step by step: WPE de-reverb → MossFormer2 voice restoration (ClearVoice) → DeepFilterNet polish → professional mastering to −16 LUFS. Outputs 24-bit/48 kHz WAV or MP3; video files get the clean audio re-muxed back in. Runs as its own Docker service (`clearcast/`, port 8770) so it never interferes with the main backend. Measured noise floor: −81 dB (vs Adobe's −58 dB). Code: `clearcast/backend/pipeline.py`, `clearcast/backend/analyze.py`, `clearcast/backend/engines/`.

3. **Smart Clipper** (`SmartClipper.jsx`, `multimodal_picker.py`, `smart_clipper_pro.py`) — A multimodal-VLM-driven picker that watches the video frame-by-frame in addition to reading the transcript. Has two modes:
   - **Fast** — Single-pass picker with a per-signal scoring rubric (punchline, reversal, awkward_pause, one_liner, audio_peak, visual_energy).
   - **Pro** — 5-stage pipeline (transcribe → translate → per-frame visual analysis → window scoring → greedy selection) with sentence-boundary snapping and multi-size candidate windows.

4. **Standalone Subtitle** (`StandaloneSubtitle.jsx`) — Just subtitles, no clip generation. Three-phase flow: Phase 1 (transcribe + reframe), Phase 2 (style + animations + lyrics align), Phase 3 (burn).

5. **Standalone Voice Dubbing** (`StandaloneDub.jsx`) — Just AI voice dub in 30+ languages, no clip generation. Optionally burns target-language subtitles after dubbing.

(Smart Clipper outputs flow into the same per-clip ResultCard as Generate Viral Clips, so all post-processing — subtitle, dub, edit, reframe, motion graphics, post-to-social — works on Smart Clipper picks too.)

## Architecture

Three Docker services defined in `docker-compose.yml`:

| Service | Container name | Image | Port | What it does |
|---|---|---|---|---|
| `backend` | `klipra-backend` | built from `./Dockerfile` | 8000 | FastAPI + Uvicorn. The main API server (`app.py`) plus all video processing (`main.py`, `motion_graphics.py`, etc.). Has ffmpeg, Whisper, mediapipe, yt-dlp inside. |
| `frontend` | `klipra-frontend` | node:20 | 5175 → 5173 | React + Vite dashboard. Hot-reloads on edit. Proxies `/api/*` calls to backend and `/clearcast/*` to the clearcast service. |
| `renderer` | `klipra-renderer` | built from `render-service/` | 4000 | Optional Remotion-based renderer for advanced compositions. Not always used. |
| `clearcast` | `klipra-clearcast` | built from `./clearcast/` | 8770 | AI Audio Cleaning engine. WPE de-reverb + MossFormer2 + DeepFilterNet + ffmpeg mastering. Separate image so ML deps (torch, clearvoice, nara_wpe) never bloat the main backend. Models cache in `clearcast/.cache` + `clearcast/checkpoints` and survive restarts. |

Optional **sidecar** (NOT in docker-compose): `whisper_sidecar/` is a native macOS service that runs Whisper on the M-series Metal GPU. Backend tries it first via `KLIPRA_WHISPER_SIDECAR_URL` and falls back to in-container CPU Whisper. Start it manually with `./whisper_sidecar/start.sh` if you want 10–15× faster transcription.

### Key bind mounts (`docker-compose.yml`)

```
.:/app                        # whole repo mounted in (live code edits = no rebuild for Python)
./output:/app/output          # past project artifacts — SURVIVE docker compose down
./uploads:/app/uploads        # uploaded source videos — SURVIVE docker compose down
./data:/app/data              # accounts SQLite db — SURVIVES docker compose down
~/Desktop/Movies:/app/local_media:ro   # LOCAL_MODE source-video folder (no upload)
```

**Important:** Because of the `.:/app` mount, edits to Python files are live without rebuild. Edits to `requirements.txt`, `Dockerfile`, or `package.json` DO require `docker compose build` or `docker compose up --build`. Frontend changes (in `dashboard/`) are hot-reloaded by Vite automatically.

## Repo layout

### Top-level Python (`*.py`)

| File | Purpose | Approx. size |
|---|---|---|
| `app.py` | FastAPI server + all REST endpoints. THE central nervous system. **Huge (~520 KB)** — never read whole-file; use Grep. | huge |
| `main.py` | Core video pipeline: download → transcribe → scene detect → AI pick → cut → reframe → subtitle → hook | large |
| `multimodal_picker.py` | Smart Clipper Fast-mode picker (VLM grid + per-signal scoring rubric) | medium |
| `smart_clipper_pro.py` | Smart Clipper Pro 5-stage pipeline | medium |
| `face_track.py` | MediaPipe BlazeFace face detection + ffmpeg scdet scene-cut detection + crop expressions | medium |
| `reframe_kf.py` | Keyframed reframing — arbitrary aspect, full-video, per-clip | medium |
| `motion_graphics.py` | AI Magic Overlays: drawtext/drawbox motion plans, face-aware text placement | medium |
| `subtitles.py` | libass-based subtitle burning. Word-highlight, word-box, pop, karaoke, glow animations. SRT generation. | medium |
| `hooks.py` | Viral-hook image overlay with emoji support (Pillow renders emojis as raster, composites onto frame) | medium |
| `clip_hook_writer.py` | Regenerates per-clip unique hooks from in-range transcript content (fixes "all clips have same title" bug) | small |
| `editor.py` | AI video effects (color grade, zoompan, SFX library, motion) | medium |
| `translate.py` | ElevenLabs voice dub | small |
| `transcribe_elevenlabs.py` | Optional ElevenLabs transcription (alternative to Whisper) | small |
| `accounts.py` | User auth, sessions, influencer apps (SQLite) | small |
| `email_utils.py` | SMTP welcome email | small |
| `prompt_rules.py` | Reusable LLM prompt fragments (CRYPTO_GLOSSARY, SONG_AWARENESS, etc.) | small |
| `retrim.py` | Re-cut an existing clip with new in/out points | small |
| `saasshorts.py` | Schedule-week / AI Shorts feature | small |
| `s3_uploader.py` | Silent background S3 backup | small |
| `stock_backgrounds.py` | lavfi-rendered backgrounds for standalone subtitle without video | small |
| `thumbnail.py` | YouTube thumbnail generator | small |
| `timeline_effects.py` | Zoom-punch, slow-pan, ducking automation | small |
| `transcript_utils.py` | Whisper output normalization, segment splitting/merging | small |
| `verify_*.py` | Internal QA helpers — DO NOT run in user flow | small |

### Dashboard (`dashboard/src/components/`)

Key components (each is one file):

| Component | What it does |
|---|---|
| `App.jsx` | Top-level routing + global state. Lives at `dashboard/src/App.jsx`. |
| `Home.jsx` | Landing page with three product CTAs and demo tiles |
| `SmartClipper.jsx` | Smart Clipper UI (Fast/Pro toggle, Signals/Classic rubric, model picker, processing pane, ResultCards) |
| `StandaloneSubtitle.jsx` | Standalone subtitle 3-phase flow + reframe modal + lyrics align |
| `StandaloneDub.jsx` | Standalone voice dub + add-subtitles-after-dub |
| `StandalonePastList.jsx` | Past projects for standalone tools |
| `StandaloneReframeKeyframeModal.jsx` | Keyframed crop editor for standalone subtitle/dub |
| `ReframeKeyframeModal.jsx` | Same modal, but for Generate Viral Clips per-clip |
| `MotionGraphicsModal.jsx` | AI Magic Overlays — Auto vs Manual mode |
| `EditModal.jsx` | Video effects (color, zoom, SFX, dynamic motion) |
| `SubtitleModal.jsx` | Subtitle styling for individual clips + lyrics-align |
| `SubtitleTimeline.jsx` | Word-level timeline editor |
| `SubtitleTemplatesPicker.jsx` | Pre-built subtitle presets |
| `RetrimModal.jsx` | Adjust clip in/out points after generation |
| `TranslateModal.jsx` | Per-clip voice dub |
| `ResultCard.jsx` | The per-clip card (Subtitle / Dub / Edit / Reframe / Motion / Post buttons) |
| `PastProjects.jsx` | Past projects for Generate Viral Clips |
| `ProcessingAnimation.jsx` | Sora-style animation shown during processing |
| `ProcessingPreview.jsx` | Live preview during clip generation |
| `KeyInput.jsx` | Encrypted API-key input (Gemini, ElevenLabs, Upload-Post) |
| `ProviderPicker.jsx` | LLM provider selector (Gemini, Ollama, OpenAI, etc.) |
| `MediaInput.jsx` | YouTube URL / Upload File / Use file from disk tabs |
| `KlipraLogo.jsx` | The "K klipra" logo |
| `AuthModal.jsx` | Login / signup (regular + Google OAuth) |
| `InfluencerApplyModal.jsx` | Influencer program application |
| `SocialConnectModal.jsx` | Wire TikTok / IG / YouTube accounts via Upload-Post |
| `ScheduleWeekModal.jsx` | Weekly publishing schedule |
| `UGCGallery.jsx` / `Gallery.jsx` / `GalleryCard.jsx` | UGC creators gallery |
| `Pricing.jsx` | Pricing page |
| `About.jsx` | About page |
| `ThumbnailStudio.jsx` | YouTube thumbnail tool |
| `SaaShortsTab.jsx` | AI Shorts (text-to-shorts) |

Utility folder `dashboard/src/utils/`:
- `subtitleTemplates.js` — preset subtitle styles (incl. `red-box-highlight`, `black-bg-red-box` with word-box animation)
- API-key helpers, fonts, formatting

### Data directories

```
output/              # past projects — one folder per job_id, each with metadata.json + clips + thumbnails
uploads/             # uploaded source videos, content-hash-dedup'd (sidecar .json next to each .mp4)
data/                # SQLite db: accounts, sessions, influencer apps
local_media/         # MOUNTED from ~/Desktop/Movies — read-only, for LOCAL_MODE
fonts/               # bundled fonts for libass burn
remotion/            # Remotion composition source (used by renderer service)
render-service/      # Dockerfile + server for the renderer container
whisper_sidecar/     # NATIVE macOS Whisper sidecar (NOT in docker compose — runs on host)
llm/                 # LLM provider adapters (gemini.py, ollama.py, openai.py, etc.)
data/migrations/     # SQL migrations for the accounts db
```

## Running locally

```bash
cd <repo root>              # /Volumes/Data/AntiGravity/Klipra (after migration)
docker compose up -d        # starts backend, frontend, renderer
docker compose ps           # status check
docker compose logs -f backend     # tail backend logs
docker compose logs -f frontend    # tail vite output
docker compose restart backend     # apply Python changes that needed a kick
docker compose down         # stop everything (data on disk survives)
docker compose up -d --build       # rebuild after Dockerfile or requirements.txt change
```

URLs once it's up:
- **Frontend (the app):** http://localhost:5175
- **Backend API:** http://localhost:8000 (Swagger docs at /docs)
- **Renderer:** http://localhost:4000 (rarely accessed directly)

If the frontend shows a stale build after edits, hard-refresh with **Cmd+Shift+R**.

## API conventions

- `/api/process` — Generate Viral Clips submit
- `/api/status/{job_id}` — poll any job
- `/api/multimodal-clip/analyze` — Smart Clipper analyze
- `/api/multimodal-clip/cut` — Smart Clipper cut picked clips
- `/api/standalone/subtitle/*` — Standalone subtitle endpoints
- `/api/standalone/dub/*` — Standalone dub endpoints
- `/clearcast/api/*` — Audio Cleaning engine (proxied by Vite to `clearcast:8770`). Key routes: `POST /enhance` (upload), `POST /enhance_local` (disk path), `GET /status/{jid}`, `GET /media/{jid}/{which}`, `GET /download/{jid}[/video]`
- `/api/clip/{job_id}/{clip_idx}/*` — Per-clip actions (subtitle, dub, edit, retrim, motion-graphics, etc.)
- `/api/retry/{job_id}` — Resume a failed/interrupted job (reconstructs cmd if needed)
- `/api/local/find` — Resolve a host file path → container path (for LOCAL_MODE)

Past-project metadata lives at `output/{job_id}/metadata.json`. The rehydrator in `app.py` reconstructs in-memory state from that file when the backend restarts.

## Important conventions and gotchas

- **`app.py` is ~520 KB.** Use Grep, not full Read. Search by route (`@app.post`) or function name.
- **Container names are hardcoded** in docker-compose (`klipra-backend`, etc.). Only one Klipra stack can run on this host at a time.
- **Past projects use `output/{job_id}/metadata.json`** as source of truth. The `created_at` timestamp in metadata is canonical; if missing, the rehydrator falls back to the oldest clip mp4 mtime, then to the directory ctime.
- **Free-model preference.** The user wants to default to free options: Ollama / Llama 3.2 Vision for VLM, Gemini free tier when paid won't do, fall back gracefully when quota hits.
- **Gemini free tier** = 20 RPM + 20 RPD (daily). Daily quota usually hits early afternoon. `main.py` detects "PerDayPerProject" in error → exits with code 2. Frontend shows "Daily quota hit, resume tomorrow."
- **Resume after restart.** `/api/retry/{job_id}` reconstructs `cmd` from metadata when in-memory record is gone. Daily-quota detection = exit code 2; minute-quota = exit code 3.
- **Reframing is keyframed.** `reframe_kf.py` supports arbitrary aspect (9:16, 16:9, 1:1, or custom) and works on full video or per-clip. Frontend uses `ReframeKeyframeModal.jsx` (per-clip) or `StandaloneReframeKeyframeModal.jsx` (standalone).
- **libass burns the subtitles.** Animations (`word-highlight`, `word-box`, `pop`, `karaoke`, `glow`) are encoded as ASS tags in `subtitles.py` → `srt_to_ass()`. Font fallback is runtime-aware via `fc-match`.
- **Emoji rendering in hooks.** ffmpeg drawtext can't load CBDT bitmap emoji fonts. `motion_graphics.py:_find_emoji_font()` explicitly prefers outline fonts (Symbola, DejaVu Sans Bold) and skips NotoColorEmoji.ttf. The `hooks.py` viral-hook overlay uses Pillow (which CAN do color emojis) and renders to PNG, then drawbox-composites the PNG over the video.
- **Face-aware text placement.** `motion_graphics.py` calls `detect_face_regions()` and uses `_safe_position()` to avoid overlapping faces.
- **Daily Gemini quota** kicks in around the 20th request per project per day. `_complete_json_with_retry()` handles 429s with backoff. Pro mode chunks large scoring prompts to stay under per-minute limits.
- **Smart Clipper face tracking** snaps on scene cuts (no early pan) via `face_track.py:detect_scene_cuts()` injecting `cut=True` keyframes.
- **Whisper sidecar.** When `KLIPRA_WHISPER_SIDECAR_URL` is set, backend tries the native Mac Metal sidecar first. Fall back to in-container CPU automatic on failure.
- **Per-clip unique hooks.** After analysis, `clip_hook_writer.ensure_unique_hooks()` regenerates each clip's hook from transcript text inside its [start,end] range, so clips don't all share one title.

## Recent task history

The full per-task history has 247+ entries. Earlier work spans auto-subtitle 3-phase restructure, Smart Clipper Fast + Pro builds, Smart Clipper face-tracking, keyframed reframe, BYOL (Bring Your Own Lyrics) for songs, Hinglish/Roman Urdu source-language support, AI Magic Overlays, per-clip motion graphics, voice-dub + add-subtitles-after-dub combo, viral-hook emoji rendering, fullscreen-crop CSS fix, font fallback map, Dockerfile fonts (Symbola + Noto Color Emoji), Whisper Metal sidecar, daily Gemini quota detection + resume, content-based upload dedup, account auth + OAuth, welcome email, S3 backup, 5 GB upload limit, local-file mode.

**Recent additions (May-June 2026, tasks #189-#247):**
- **GitHub public release** — repo is now at `github.com/muqaddashahzad/Klipra` under MIT, with a README rewritten from "OpenShorts" branding to "Klipra" branding.
- **EditModal redesign** — pro-NLE modal with gradient surface, frosted header/footer, region cards, motion + colour preset cards with gradient fills, segmented tab control, friendly-error helper that summarises raw FFmpeg dumps.
- **RetrimModal v3-v5** — visual scrubber with audio waveform, zoom, playback speed, mark IN / mark OUT, draggable handles, undo, localStorage persistence, modern gradient styling.
- **ReframeKeyframeModal** — playable preview with audio, transport bar, modern gradient styling, **mouse-mode toggle (Keyframe vs Playback)** that prevents clicks from accidentally toggling playback.
- **AI Avatar tab** — UI placeholder for talking-head generation (photo + audio → lipsynced video). Listed in nav. Engines currently stubbed because LongCat-Video-Avatar is CUDA-only; will wire up SadTalker / MuseTalk when ready. Component: `dashboard/src/components/AIAvatar.jsx`.
- **Switch AI & resume** — `/api/retry/{job_id}` now accepts `X-LLM-Provider`, `X-LLM-Model`, `X-LLM-Key`, `X-LLM-Base-URL` headers. When provided, the resumed run overrides the original provider. Frontend `ResumePanel` (in App.jsx) shows two buttons on the failed-job pane: "♻️ Resume from checkpoint" (original) and "🔄 Switch AI & resume" (with inline provider+model picker that auto-detects installed Ollama models).
- **Ollama uniform-length retry** — when Ollama picker returns clips that are all within ~5 seconds of each other, main.py now retries with a counter-example prompt to encourage diverse durations.
- **Ollama timeouts + retries** — `OllamaProvider` now has retry-with-backoff on connect/read timeouts, smaller batches for transliteration, `keep_alive` at top level (not inside `options`), and a `KLIPRA_OLLAMA_TIMEOUT` env knob.
- **Roman/Hinglish/Urglish improvements** — per-segment retry for any segment the LLM returned in non-Latin script; tighter prompts; inline language picker in Subtitle Step 2.
- **Letterboxing fix** — TRACK vs GENERAL thresholds in `main.py:analyze_scenes_strategy()` tightened (sample 5 frames, avg<0.2 for GENERAL, avg>=2.0 AND max>=2 for group); `OPENSHORTS_FORCE_TRACK=1` env override forces TRACK on all scenes.
- **Hook emoji fallback** — `hooks.py:_load_all_emoji_fonts()` tries every available emoji font per-glyph; silently drops emojis that no font has rather than showing tofu.
- **FFmpeg 4.x compatibility** — `timeline_effects.py:_zoom_scale_crop()` replaces the `crop=...:eval=frame` pattern with scale-then-static-crop, so zoom-punch / slow-pan work on FFmpeg 4.x.
- **Publish-To-GitHub.command** — one-click script that re-points origin, runs a safety check (ensures `.env`, `data/`, and `*.db` are excluded), commits, and pushes. Handles divergence with force-push prompt.

Known pending items:
- **Pro picker scoring rubric** — Fast picker has the per-signal rubric; Pro picker's stage-4 `score_windows()` should adopt it too (multi-window-aware).
- **EditModal color-effect preview** — missing parity with the older edit flow.
- **AI Avatar backend** — engine wrappers (SadTalker / MuseTalk) not wired up. UI is ready, just needs a sidecar or in-container engine.
- **Production homepage audit** — smoke-test deployment at klipra.ilmeaalim.com after recent changes.

## Hermes-as-hands workflow

Muqaddas runs the **Hermes Agent** (from Nous Research, `hermes-agent.nousresearch.com`) on her Mac. It's an MCP-capable agent that uses her xAI OAuth to call Grok. It has a `hermes` CLI binary and can execute shell commands on her Mac.

When an AI agent (Claude, Cursor, etc) running inside a sandbox needs to:
- restart Docker
- check logs
- run `curl` against a localhost endpoint
- copy files
- diagnose mount issues

...it cannot do those things directly. Instead, the agent writes a **Hermes prompt** in a clearly delimited block. Muqaddas copies the block into her Hermes window, Hermes executes the steps, Muqaddas copies the raw output back to the AI. Two clicks per round-trip instead of 20.

Conventions for Hermes prompts (followed by all AI agents in this repo):
1. Start with `═══` separators so the block is easy to spot in chat.
2. Always specify the working directory explicitly (`cd /Volumes/Data/AntiGravity/Klipra`).
3. Ask Hermes to paste **raw stdout/stderr** of each step, never paraphrased summaries.
4. Number the steps.
5. NEVER use Hermes for irreversible operations (delete, force-push, drop database) — those route through Muqaddas with confirmation.
6. Avoid passing secrets through Hermes.

Example:
```
═══════════════════════════════════════════════════
HERMES PROMPT — paste verbatim
═══════════════════════════════════════════════════
1. cd /Volumes/Data/AntiGravity/Klipra
2. docker compose restart backend
3. sleep 15
4. curl -s http://localhost:8000/api/providers | jq '.[] | select(.id=="ollama")'

Paste raw stdout/stderr of each step. Do not summarise.
═══════════════════════════════════════════════════
```

## Where this repo lives

- **GitHub (public):** [https://github.com/muqaddashahzad/Klipra](https://github.com/muqaddashahzad/Klipra) — MIT licensed, public since June 2026. Clone with `git clone https://github.com/muqaddashahzad/Klipra.git`. Anyone can install locally; see the README for `docker compose up -d` instructions.
- **Local (Muqaddas' Mac):** `/Volumes/Data/AntiGravity/Klipra` (after the migration script ran). Before that it lived at `~/Library/Application Support/Claude/local-agent-mode-sessions/.../outputs/openshorts-fork` — older AI-session traces may still reference that path.
- **Production:** Hetzner VPS 46.62.194.70, deployed via Plesk, behind Cloudflare DNS (klipra.ilmeaalim.com → A record points to the VPS).
- **Google OAuth client:** Klipra-494810 GCP project. Production redirect URI is wired for klipra.ilmeaalim.com.

### Pushing changes to GitHub
The git remote `origin` is set to `https://github.com/muqaddashahzad/Klipra.git`. Muqaddas has credentials cached in macOS Keychain from previous pushes. To deploy a local change:
1. From the repo root, `git add -A && git commit -m "..." && git pull --rebase origin main && git push origin main`.
2. If a regular push is rejected because remote has commits local doesn't (e.g. README edits made via GitHub web UI), `git pull --rebase origin main` then push.
3. The one-click script `Publish-To-GitHub.command` automates this; double-click it in Finder.

Because the sandbox AI agents (like Claude in Cowork) cannot reach GitHub directly, agents either ask Muqaddas to run the push commands or relay them through the Hermes Agent (see below).

## Tech stack snapshot

**Backend (Python 3.11):** FastAPI · Uvicorn · faster-whisper · mediapipe · ultralytics (YOLOv8) · yt-dlp · ffmpeg-python · google-genai · ollama-py (via httpx) · Pillow · pysubs2 · libass (system) · SQLAlchemy (SQLite)

**Frontend:** React 18 · Vite 4 · Tailwind 3.4 · lucide-react · Recharts (rarely)

**External services:** Google Gemini API · ElevenLabs (dubbing) · Ollama (local LLM, free) · Upload-Post (social posting) · ElevenLabs Scribe (alt transcription) · AWS S3 (silent backup) · Hetzner + Plesk (prod hosting) · Cloudflare (DNS)

**Infra:** Docker · Docker Compose · macOS host with M1 Max 64 GB

## When you (next AI agent) start working

1. **Read this file.** You just did. Good.
2. `git log --oneline -20` to see recent commits.
3. `docker compose ps` to confirm the stack is healthy.
4. `cat docker-compose.yml` to see the exact volume mounts and env vars.
5. If the user gives a vague request, ASK what they want before writing code — see the AskUserQuestion guidance in the host system prompt.
6. For any file edit, **read the surrounding context with Grep first** — app.py and main.py are huge and assumptions go bad fast.
7. After making changes, propose a one-line `docker compose restart backend` (Python) or just save (frontend HMR auto-reloads) — never restart the renderer unless the user asks.
8. The user is non-technical. Don't ask her to run shell commands. Either explain in plain English, or use a `.command` script + Finder double-click pattern.
9. Free options first — Ollama / Llama 3.2 Vision instead of paid Gemini whenever the quality is acceptable.
