# Klipra

> **Free, self-hosted AI video studio.** Drop a long YouTube video in, get viral short-form clips out — vertical-cropped, subtitled, hook-overlaid and ready to post. Built on top of the open-source [OpenShorts](https://github.com/mutonby/openshorts) project, with deep changes that prioritise **free local AI** (Ollama) over paid APIs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open Source](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://opensource.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Fork](https://img.shields.io/badge/forked%20from-OpenShorts-blueviolet)](https://github.com/mutonby/openshorts)

Klipra is maintained by **[ilmeaalim.com](https://ilmeaalim.com)** and runs in production at **[klipra.ilmeaalim.com](https://klipra.ilmeaalim.com)**.

---

## Why Klipra and not OpenShorts?

Klipra was forked from OpenShorts in early 2025. Since then it has diverged substantially — most of `app.py`, all of the multimodal Smart Clipper, the keyframed reframer, the AI Motion Graphics engine, the voice-dubbing pipeline and the entire dashboard have been rewritten or added.

The single biggest change: **Klipra runs on free local AI by default**. The original project required a paid Google Gemini key for everything. In Klipra you can pick **[Ollama](https://ollama.com)** as the provider for *every* AI step — clip picking, transcript cleanup, transliteration, motion-graphics planning, dubbing prompts — so the whole pipeline runs offline on your own machine at zero cost.

Other things Klipra adds on top of OpenShorts:

- **Smart Clipper (Fast + Pro)** — a multimodal-VLM picker that *watches* the video, not just reads the transcript. Pro mode is a 5-stage pipeline with sentence-boundary snapping and multi-size candidates.
- **Standalone Subtitle** — three-phase flow (transcribe → style → burn) that works on any video without the full clip pipeline.
- **Standalone Voice Dubbing** — 30+ languages via ElevenLabs, with optional target-language subtitle burn after dubbing.
- **Keyframed Reframe** — arbitrary aspect (9:16 / 16:9 / 1:1 / custom), per-clip or full-video, draggable crop rectangle, face-aware tracking with scene-cut snapping.
- **Word-level Subtitle Animations** — word-highlight, word-box, pop, karaoke, glow, all libass-burned.
- **Hinglish / Roman Urdu / Urglish** subtitle modes — for creators producing Hindi/Urdu content who want Roman script on screen.
- **BYOL (Bring Your Own Lyrics)** — paste your song lyrics, Klipra aligns them to the audio segment-by-segment using an LLM.
- **AI Motion Graphics / Magic Overlays** — Auto mode lets the AI add zooms, pulses, drawtext callouts, highlight strips, with face-aware text placement.
- **Voice Dubbing + Subtitles combo** — dub a clip, then burn target-language subtitles on top in one flow.
- **Viral Hook Overlay** — auto-written punchy hook with emoji rendered as real raster glyphs (no tofu).
- **AI Effects / Edit Modal** — pro-NLE-style modal with regions, motion presets (zoom-punch, slow-pan), colour grades, synthetic SFX library (whoosh, pop, impact, ding, riser).
- **Retrim Modal** — visual source-video scrubber with audio waveform, zoom, playback speed, mark IN / mark OUT, draggable handles, undo, localStorage persistence.
- **Whisper Metal Sidecar** — optional native macOS sidecar that runs Whisper on Apple Silicon GPU at 10-15× the in-container CPU speed.
- **Local-file Mode** — process videos directly from `~/Desktop`, `~/Downloads`, `~/Documents` or `~/Movies` without uploading.
- **Auth, Influencer Programme, Welcome Email, S3 Backup, Upload-Post integration** — full SaaS surface.

---

## Quick start (macOS / Linux)

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) and `git`. On Mac, give Docker at least 8 GB RAM in Preferences → Resources.

```bash
git clone https://github.com/muqaddashahzad/Klipra.git
cd Klipra
cp .env.example .env       # fill in API keys you want to use (Gemini is optional)
docker compose up -d
```

Once the three containers are healthy (`docker compose ps`), open:

- **App:** http://localhost:5175
- **API docs:** http://localhost:8000/docs

If you want everything to run **completely free** with no API keys, install [Ollama](https://ollama.com), then double-click `Install-Ollama-Model.command` (or run `ollama pull qwen2.5:14b-instruct`). Klipra will detect the local daemon and let you pick it from the Provider dropdown.

---

## What's inside the box

Three Docker services defined in `docker-compose.yml`:

| Service | Container | Port | Purpose |
|---|---|---|---|
| `backend` | klipra-backend | 8000 | FastAPI server + all video processing (Whisper, mediapipe, ffmpeg, yt-dlp) |
| `frontend` | klipra-frontend | 5175 → 5173 | React + Vite dashboard (hot-reload on edit) |
| `renderer` | klipra-renderer | 4000 | Optional Remotion renderer for advanced compositions |

Optional native sidecar (not in compose): `whisper_sidecar/` runs Whisper on the M-series Metal GPU. Start it with `./whisper_sidecar/start.sh` for ~10× faster transcription on Apple Silicon.

Bind mounts (data survives `docker compose down`):
- `./output` — past project artefacts
- `./uploads` — uploaded source videos (content-hash deduped)
- `./data` — accounts SQLite db (excluded from git)
- `~/Desktop/Movies` → `/app/local_media` (read-only) for local-file mode

---

## The four products

1. **Generate Viral Clips** *(full pipeline)* — drop a YouTube URL or video file; Klipra transcribes, picks 4–8 viral moments, cuts them, reframes 16:9 → 9:16 with face tracking, burns subtitles, adds a viral hook, and optionally posts to TikTok / Instagram / YouTube. `main.py` + `app.py`.
2. **Smart Clipper** — multimodal VLM picker. **Fast** mode = single-pass with a per-signal scoring rubric (punchline, reversal, awkward_pause, one_liner, audio_peak, visual_energy). **Pro** mode = 5-stage pipeline. `multimodal_picker.py` + `smart_clipper_pro.py`.
3. **Standalone Subtitle** — three-phase flow, no clip generation, works on any video. `subtitles.py`.
4. **Standalone Voice Dubbing** — 30+ languages, optional target-language subtitle burn. `translate.py`.

All four products feed into the same per-clip ResultCard, so subtitle / dub / edit / reframe / motion-graphics / post-to-social work on every output regardless of which product produced it.

---

## Repo layout

```
app.py                   FastAPI server (huge, ~520 KB; grep it)
main.py                  core pipeline: download → transcribe → pick → cut → reframe → subtitle → hook
multimodal_picker.py     Smart Clipper Fast picker
smart_clipper_pro.py     Smart Clipper Pro 5-stage pipeline
face_track.py            MediaPipe BlazeFace + ffmpeg scdet scene cuts
reframe_kf.py            keyframed reframer (any aspect, per-clip or full video)
motion_graphics.py       AI Magic Overlays
subtitles.py             libass burn pipeline + word-level animations
hooks.py                 viral hook overlay (Pillow renders emojis to PNG)
editor.py                AI video effects (color, zoom, SFX library)
translate.py             ElevenLabs voice dub
accounts.py              user auth (SQLite)
llm/                     provider adapters (gemini, ollama, openai, ...)
whisper_sidecar/         optional native macOS Whisper service

dashboard/src/
  App.jsx                top-level routing + global state
  components/            Home, SmartClipper, StandaloneSubtitle, StandaloneDub,
                         ReframeKeyframeModal, MotionGraphicsModal, EditModal,
                         SubtitleModal, RetrimModal, TranslateModal, ResultCard, ...
```

For a longer tour, read `CLAUDE.md` (intended as an entry point for AI coding agents but useful for humans too).

---

## Working locally

```bash
docker compose up -d              # start stack
docker compose ps                 # status
docker compose logs -f backend    # tail backend logs
docker compose restart backend    # apply Python changes that need a kick
docker compose down               # stop (data on disk survives)
docker compose up -d --build      # rebuild after Dockerfile / requirements.txt change
```

Hot-reload:
- **Python** files (`*.py`) — live thanks to the `.:/app` bind mount; sometimes `docker compose restart backend` is needed.
- **Frontend** (`dashboard/`) — Vite HMR auto-reloads; hard-refresh with **Cmd+Shift+R** if it goes stale.

Mac one-click helpers (double-click in Finder):
- `Restart-Backend.command` — `docker compose restart backend`
- `Force-Restart-Backend.command` — full recreate when restart isn't enough
- `Restart-All.command` — restart whole stack
- `Apply-File-Folder-Access.command` — recreate backend with expanded local-file mounts
- `Install-Ollama-Model.command` — pull the recommended `qwen2.5:14b-instruct` model

---

## API keys and environment

Copy `.env.example` to `.env` and fill in whichever providers you want. **All are optional** if you use Ollama as the main provider.

| Variable | Used for | Free? |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini (clip picking, transcript cleanup) | Free tier: 20 RPM, 20 RPD |
| `ELEVENLABS_API_KEY` | Voice dubbing / Scribe transcription | Paid |
| `OPENAI_API_KEY` | Optional fallback LLM | Paid |
| `UPLOAD_POST_API_KEY` | Posting to TikTok / IG / YouTube | Paid |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Silent S3 backup of finished clips | Paid |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | Welcome email after signup | Free |
| `KLIPRA_WHISPER_SIDECAR_URL` | Native Metal Whisper sidecar | Free |
| `KLIPRA_OLLAMA_TIMEOUT` | Per-request Ollama timeout (seconds) | Free |

---

## Tech stack

- **Backend (Python 3.11):** FastAPI · Uvicorn · faster-whisper · mediapipe · ultralytics (YOLOv8) · yt-dlp · ffmpeg-python · google-genai · ollama (via httpx) · Pillow · pysubs2 · libass · SQLAlchemy
- **Frontend:** React 18 · Vite 4 · Tailwind 3.4 · lucide-react
- **External services:** Google Gemini · ElevenLabs · Ollama · Upload-Post · AWS S3 · Hetzner + Plesk · Cloudflare
- **Infra:** Docker · Docker Compose · macOS host with Apple Silicon

---

## Credits and licence

Klipra is a fork of **OpenShorts** by [@mutonby](https://github.com/mutonby/openshorts). Huge thanks to the original team for putting the foundations under MIT.

Klipra remains under the **[MIT licence](LICENSE)**. Use it, modify it, ship it — just keep the licence notice intact.

If you build something with Klipra, tag [@ilmeaalim](https://ilmeaalim.com) — I'd love to see what you make.

— Muqaddas Shahzad
