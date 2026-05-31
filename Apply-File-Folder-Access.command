#!/bin/bash
# One-shot apply script for the expanded local-file-access change.
#
# docker-compose.yml now mounts:
#   ~/Desktop      → /app/local_desktop  (read-only)
#   ~/Downloads    → /app/local_downloads (read-only)
#   ~/Documents    → /app/local_documents (read-only)
#   ~/Movies       → /app/local_movies   (read-only)
#
# Because the YAML changed (new volumes), a plain `restart` is NOT
# enough — Docker has to RECREATE the container so it picks up the
# new mounts. That's what `up -d` does.

KLIPRA_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo " Klipra — apply expanded file-folder access"
echo "============================================================"
echo ""
echo "This will let Klipra read videos from anywhere in your"
echo "Desktop, Downloads, Documents, or Movies folders without"
echo "uploading them. Files stay on your disk."
echo ""

cd "$KLIPRA_PATH" || { echo "FATAL: cannot cd to $KLIPRA_PATH"; read -n 1; exit 1; }

echo "Recreating the backend container with the new folder mounts…"
echo "(This takes ~30 seconds. The frontend stays up.)"
echo ""
docker compose up -d backend

echo ""
echo "Waiting 15 seconds for the backend to come back…"
sleep 15

echo ""
echo "Status:"
docker compose ps backend

echo ""
echo "Verifying the new folders are mounted inside the container…"
docker compose exec -T backend ls -la /app/local_desktop /app/local_downloads /app/local_documents /app/local_movies 2>&1 | head -20

echo ""
echo "------------------------------------------------------------"
echo " Done."
echo ""
echo " In your browser:"
echo "   1. Hard-refresh:  Cmd+Shift+R"
echo "   2. Open Horizontal → Vertical"
echo "   3. Click 'Use file from disk'"
echo "   4. Drag in your Ethereum video from anywhere on your Mac"
echo "      — Desktop, Downloads, Documents, or Movies all work."
echo "------------------------------------------------------------"
echo ""
echo "Press any key to close this window..."
read -n 1
