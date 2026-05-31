#!/bin/bash
# Installs the recommended Ollama model for AI Magic Overlays + SFX.
# Default: qwen2.5:14b-instruct (best balance of speed + quality on 64GB M1).
# You can change MODEL below to pull a different one (e.g. llama3.2 for speed).

MODEL="qwen2.5:14b-instruct"

echo "============================================================"
echo " Install Ollama model for Klipra"
echo "============================================================"
echo ""

# Locate the ollama binary even if it's not on the default PATH for
# double-clicked .command scripts.
if ! command -v ollama >/dev/null 2>&1; then
    for p in \
        "/Applications/Ollama.app/Contents/Resources/ollama" \
        "/usr/local/bin/ollama" \
        "/opt/homebrew/bin/ollama"; do
        if [ -x "$p" ]; then
            OLLAMA="$p"
            break
        fi
    done
    if [ -z "$OLLAMA" ]; then
        echo "ERROR: Cannot find the 'ollama' command."
        echo "Please install the Ollama app first from https://ollama.com"
        echo ""
        echo "Press any key to close..."
        read -n 1
        exit 1
    fi
else
    OLLAMA="ollama"
fi

echo "Using: $OLLAMA"
echo ""
echo "Currently installed models:"
"$OLLAMA" list
echo ""
echo "------------------------------------------------------------"
echo "Now downloading: $MODEL"
echo "Size: ~9 GB. Time: depends on your internet speed."
echo "(qwen2.5:14b is the best free local model for AI Magic Overlays.)"
echo "------------------------------------------------------------"
echo ""

"$OLLAMA" pull "$MODEL"
RC=$?

echo ""
if [ $RC -eq 0 ]; then
    echo "============================================================"
    echo " ✓ Done! '$MODEL' is now installed."
    echo "============================================================"
    echo ""
    echo "Now in Klipra:"
    echo "  1. Open any clip"
    echo "  2. Click 'AI Magic Overlays + SFX'"
    echo "  3. Pick 'Ollama (local, free)' as provider"
    echo "  4. In the Model field, type: $MODEL"
    echo "  5. Click 'Apply Magic'"
    echo ""
    echo "All currently installed models:"
    "$OLLAMA" list
else
    echo "============================================================"
    echo " ✗ Download failed (exit code $RC)"
    echo "============================================================"
    echo ""
    echo "Common causes:"
    echo "  - Ollama app isn't running (open it from Applications)"
    echo "  - No internet connection"
    echo "  - Not enough disk space (~9 GB needed)"
fi

echo ""
echo "Press any key to close..."
read -n 1
