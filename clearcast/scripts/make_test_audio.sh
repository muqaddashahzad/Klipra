#!/usr/bin/env bash
# Generate a synthetic "messy" test clip: macOS TTS voice + pink noise + a music bed.
# Used to smoke-test the enhancement pipeline.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-jobs/_sample/test_noisy.wav}"
mkdir -p "$(dirname "$OUT")"
DUR=22
VOICE=/tmp/cc_voice.aiff

TEXT="Welcome back to the show. Today we are talking about how artificial intelligence \
can clean up your audio, removing background noise, echo, and even music, so that your \
voice sounds like it was recorded in a professional studio. Let's dive right in."

echo "▶ generating voice with macOS 'say'…"
say -r 180 -o "$VOICE" "$TEXT"

echo "▶ mixing voice + pink noise + music bed…"
ffmpeg -y -loglevel error \
  -i "$VOICE" \
  -f lavfi -t $DUR -i "anoisesrc=color=pink:amplitude=0.05:sample_rate=48000" \
  -f lavfi -t $DUR -i "sine=frequency=196:sample_rate=48000" \
  -f lavfi -t $DUR -i "sine=frequency=261:sample_rate=48000" \
  -f lavfi -t $DUR -i "sine=frequency=329:sample_rate=48000" \
  -filter_complex "\
    [0:a]aresample=48000,apad=pad_dur=2[v];\
    [1:a]volume=1.0[n];\
    [2:a]volume=0.10[m1];[3:a]volume=0.08[m2];[4:a]volume=0.07[m3];\
    [m1][m2][m3]amix=inputs=3:normalize=0[mus];\
    [mus]tremolo=f=0.4:d=0.7[musb];\
    [v][n][musb]amix=inputs=3:normalize=0:duration=longest,alimiter=limit=0.97[out]" \
  -map "[out]" -ar 48000 -ac 1 "$OUT"

echo "✓ wrote $OUT"
ffprobe -v quiet -show_entries format=duration -of default=nw=1:nk=1 "$OUT" | xargs printf "  duration: %.1fs\n"
