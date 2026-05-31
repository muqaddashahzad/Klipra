#!/bin/bash
# Restart Klipra frontend (Vite) + backend (FastAPI) cleanly.
# Use this when the dashboard shows blank clips or a broken UI
# after a hot-reload got confused.

KLIPRA_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo " Restart Klipra (frontend + backend)"
echo "============================================================"
echo ""

cd "$KLIPRA_PATH" || { echo "FATAL: cannot cd to $KLIPRA_PATH"; read -n 1; exit 1; }

echo "Status BEFORE:"
docker compose ps
echo ""

echo "[1/3] Restarting backend (FastAPI)…"
docker compose restart backend

echo ""
echo "[2/3] Restarting frontend (Vite)…"
docker compose restart frontend

echo ""
echo "[3/3] Waiting 15 seconds for both to come back…"
sleep 15

echo ""
echo "Status AFTER:"
docker compose ps
echo ""

echo "------------------------------------------------------------"
echo " Done. Now in your browser:"
echo "   1. Close ALL Klipra tabs"
echo "   2. Open a fresh tab → http://localhost:5175"
echo "   3. If still broken, open DevTools (Cmd+Option+I), check"
echo "      the Console tab, and tell me what red error you see."
echo "------------------------------------------------------------"
echo ""
echo "Press any key to close this window..."
read -n 1
