# 🎙️ Clearcast

**Studio-quality voice from any recording — a local, open-source Adobe Podcast Enhance.**

Drop in noisy, echoey, or music-laden audio (or video). Clearcast strips background
music, removes noise and reverb with AI, isolates the voice, and masters it to broadcast
loudness. Everything runs **100% locally on your Mac** — nothing is uploaded anywhere.

![pipeline](https://img.shields.io/badge/runs-locally-7c5cff) ![apple silicon](https://img.shields.io/badge/Apple%20Silicon-native-23d3ee)

---

## What it does

| Stage | Engine | Purpose |
|------|--------|---------|
| Decode | ffmpeg | Any audio/video → 48 kHz mono |
| **Music removal** | **Demucs** (`htdemucs`) | Separate the voice from background music |
| **Denoise + restore** | **ClearVoice MossFormer2_SE_48K** (Studio) · **DeepFilterNet** (Fast) · ffmpeg DSP (Basic) | Remove noise & reverb, restore voice |
| Strength blend | ffmpeg | Adobe-style enhancement-strength slider |
| Master | ffmpeg | High-pass · de-ess · presence EQ · compression · loudnorm |
| Export | ffmpeg | **WAV 24-bit / 48 kHz** or MP3 192 kbps |
| Video re-mux | ffmpeg | Put the enhanced audio back into the original video |

The Studio engine (MossFormer2) is the modern open-source equivalent of Adobe's
generative restoration; adding **explicit music separation** is something Adobe's tool
does *not* do — so on music-laden clips Clearcast can actually beat it.

## Features
- **Batch processing** — drop in many files; they're enhanced **one at a time** in a FIFO queue, each card showing live progress / queue position.
- **A/B compare** — every finished file gets an **Enhanced ⟷ Original** on/off switch you can flip during playback (position is kept), just like Adobe Podcast.
- **Video in, video out** — upload a video and download it back with the cleaned audio re-muxed in (video stream copied, audio swapped). The extracted audio is also available on its own.
- **24-bit / 48 kHz WAV** master, or MP3 192 kbps.
- Waveform preview, loudness targets (−14/−16/−19/−23 LUFS), strength & warmth controls.

---

## Quick start

```bash
cd clearcast
./setup.sh      # one time: installs Python env + AI engines (~2 GB download)
./run.sh        # launches the app and opens http://127.0.0.1:8765
```

The app works immediately in **Basic** (ffmpeg DSP) mode while the AI engines finish
installing; the engine chips in the header turn green as each becomes available.

### Try it with a generated sample
```bash
bash scripts/make_test_audio.sh    # makes a noisy voice+music clip via macOS 'say'
# then drag jobs/_sample/test_noisy.wav into the app
```

---

## Requirements
- macOS on Apple Silicon (built/tested on M1 Max)
- [`uv`](https://github.com/astral-sh/uv) and [`ffmpeg`](https://ffmpeg.org) (`brew install uv ffmpeg`)
- ~2 GB disk for models (downloaded on first use)

## Architecture
```
backend/
  server.py      FastAPI: upload, background jobs, progress polling, static UI
  pipeline.py    orchestration: ffmpeg + Demucs + ClearVoice/DeepFilterNet + master
  engines/
    run_clearvoice.py   ClearVoice subprocess (torch isolated from the API server)
web/             vanilla-JS UI (drag-drop, A/B before/after player, waveform)
bin/deep-filter  DeepFilterNet arm64 binary (Fast engine)
scripts/         setup helpers + test-audio generator
```
Each ML model runs in its **own subprocess**, so a model crash never takes down the
server and the API process stays light (no torch import).

## Notes / roadmap
- All processing is CPU on Apple Silicon (reliable). Demucs MPS/MLX can be added for speed.
- Designed to be wrapped in **Tauri** later for a standalone `.app` (no terminal).
- Engines auto-downgrade: Studio → Fast → Basic if a model isn't installed yet.

*Built with Demucs, ClearVoice (ClearerVoice-Studio), DeepFilterNet, and ffmpeg.*
