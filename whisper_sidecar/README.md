# Klipra Whisper Sidecar

A tiny native-macOS service that runs Whisper on your Apple Silicon
GPU, so Klipra-in-Docker can offload transcription to it instead of
the CPU. Roughly **10–15× faster** than CPU on an M-series Mac.

It's optional. If it's not running, Klipra falls back to CPU
faster-whisper inside the container — same behaviour as before.

## Why a sidecar?

Klipra runs in Docker. Docker on macOS uses a Linux VM, and **that VM
has no access to Metal** (Apple's GPU API). So inside the container,
the M-series GPU is unreachable. The only way to use it is to run the
inference outside Docker, on the host. That's this sidecar.

The architecture:

```
   ┌─────────────────────┐         loopback HTTP         ┌────────────────────────┐
   │  Klipra (Docker)    │ ─────────────────────────►   │  Whisper Sidecar       │
   │  faster-whisper     │   POST /transcribe            │  mlx-whisper (Metal)   │
   │  CPU fallback       │ ◄───────────────────────────  │  Apple Silicon GPU     │
   └─────────────────────┘         JSON transcript        └────────────────────────┘
            │                                                      │
            └─────────── falls back to CPU if sidecar offline ─────┘
```

## Requirements

- **Apple Silicon Mac** (M1, M2, M3, M4 — any generation).
- **macOS 13 Ventura or newer.**
- **Python 3.9+** (built-in `python3` on modern macOS works).
- **~2 GB free disk** for the Whisper Turbo model.
- **Klipra running in Docker** on the same machine.

(Intel Macs and non-Mac systems can't use this — stick with the CPU
path.)

## Quick start

```bash
cd whisper_sidecar
./start.sh
```

That:

1. Creates a Python venv inside `whisper_sidecar/.venv`
2. Installs `mlx-whisper` + `fastapi` + `uvicorn`
3. Starts the server on `http://127.0.0.1:8765`

The first transcription will pull the model (~1.5 GB, one-time). Every
later transcription is fast.

Then in a different terminal, point Klipra at it and bring it up:

```bash
export KLIPRA_WHISPER_SIDECAR_URL="http://host.docker.internal:8765"
cd /path/to/openshorts-fork
docker compose up -d
```

You can verify the wiring by checking the Klipra backend log on the
next clip-gen / subtitle / dub job. You should see:

```
⚡ Whisper sidecar online: {'ok': True, 'model': 'mlx-community/whisper-large-v3-turbo', 'device': 'mps (Apple Metal)'}
🚀 Sending audio to native Whisper sidecar (http://host.docker.internal:8765) — Metal-accelerated.
✓ Sidecar returned 142 segments, language=ur
```

If the sidecar isn't running, you'll see one line and then the normal
CPU log:

```
🎙️  Transcribing with Whisper Turbo (large-v3-turbo) — running on the
    Faster-Whisper library (device=cpu, ...).
```

That's the graceful fallback — nothing breaks.

## Run it on every login (launchd)

If you want the sidecar to start automatically when you log in, drop
this into `~/Library/LaunchAgents/com.klipra.whisper-sidecar.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.klipra.whisper-sidecar</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/full/path/to/openshorts-fork/whisper_sidecar/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/klipra-sidecar.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/klipra-sidecar.log</string>
</dict>
</plist>
```

Replace `/full/path/to/openshorts-fork/...` with the real path on your
machine, then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.klipra.whisper-sidecar.plist
```

To stop / unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.klipra.whisper-sidecar.plist
```

## Endpoints

### `GET /health`

Liveness probe Klipra hits before deciding to use the sidecar.

```json
{ "ok": true, "model": "mlx-community/whisper-large-v3-turbo",
  "device": "mps (Apple Metal)", "service": "klipra-whisper-sidecar" }
```

### `POST /transcribe`

`multipart/form-data` with these fields:

| Field            | Required | Notes                                                    |
| ---------------- | -------- | -------------------------------------------------------- |
| `audio`          | yes      | Video or audio file. Anything ffmpeg can decode.         |
| `language`       | no       | ISO-639-1 code (e.g. `ur`). Empty = auto-detect.         |
| `initial_prompt` | no       | Text the model "remembers" before the audio starts.      |
| `model`          | no       | Override the HF repo id, e.g. `mlx-community/whisper-base`. |

Returns:

```json
{
  "text": "full transcript",
  "language": "ur",
  "segments": [
    { "start": 0.0, "end": 1.4, "text": "...", "words": [
        { "word": "hello", "start": 0.0, "end": 0.4, "probability": 0.99 }
    ]}
  ]
}
```

Same shape `faster-whisper` produces, so Klipra doesn't care which
path ran.

## Performance ranges (on a real M3 Max, 64 GB)

| Path                                       | 10-min vertical Urdu video |
| ------------------------------------------ | -------------------------- |
| CPU faster-whisper, default Docker (6 cores) | ~9 min                  |
| CPU faster-whisper, Docker bumped to 12 cores | ~5 min                 |
| **MLX sidecar (Metal)**                    | **~45 sec**                |

Numbers will vary with model, audio length, and other load. The big
takeaway: the sidecar is the only path that uses your GPU, and it's
the only one that gets near-realtime on long videos.

## Troubleshooting

**"address already in use" on port 8765**
Something else is listening. Kill it (`lsof -i :8765`) or set
`KLIPRA_SIDECAR_PORT=8766` and update `KLIPRA_WHISPER_SIDECAR_URL` to
match.

**Klipra log says "Whisper sidecar online" then later "Sidecar
transcription failed"**
The sidecar accepted the request but mlx-whisper crashed mid-job.
Most common cause is a corrupt audio file. Check the sidecar's
terminal — the traceback is logged there. The CPU fallback runs
automatically.

**`pip install mlx-whisper` fails with "no matching distribution"**
You're on Intel or Linux. mlx is Apple-Silicon only. The sidecar
isn't useful on those platforms — use the Docker CPU path.

**Model download is hanging**
The first transcription pulls ~1.5 GB from HuggingFace. If your
internet is slow, this can take a few minutes. Subsequent runs are
instant. To pre-pull it manually:

```bash
source whisper_sidecar/.venv/bin/activate
python -c "import mlx_whisper; mlx_whisper.transcribe('/dev/null', \
    path_or_hf_repo='mlx-community/whisper-large-v3-turbo')"
```

(That command will error out at the end because /dev/null isn't audio,
but the model will be cached for next time.)
