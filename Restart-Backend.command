#!/bin/bash
# Restart the Klipra backend container so it picks up the
# AI Magic Overlays Ollama-fallback fix in motion_graphics.py.

KLIPRA_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo " Restart Klipra backend (apply Ollama-fallback fix)"
echo "============================================================"
echo ""

cd "$KLIPRA_PATH" || { echo "FATAL: cannot cd to $KLIPRA_PATH"; read -n 1; exit 1; }

echo "Restarting klipra-backend..."
docker compose restart backend

echo ""
echo "Waiting 12 seconds for backend to come back..."
sleep 12

echo ""
echo "Status:"
docker compose ps backend

echo ""
echo "------------------------------------------------------------"
echo " Done. Now make sure Ollama is running on your Mac:"
echo "   1. Open the Ollama app from Applications, OR"
echo "   2. Run 'ollama serve' in a separate Terminal"
echo ""
echo " If you have no model installed yet, the easiest one is:"
echo "   ollama pull llama3.2"
echo ""
echo " Then open any clip in Klipra and click"
echo " 'AI Magic Overlays + SFX' — it will use Gemini if"
echo " quota is fresh, or Ollama (free, local) when Gemini is"
echo " out of quota or overloaded."
echo "------------------------------------------------------------"
echo ""
echo "Press any key to close..."
read -n 1
