#!/bin/bash
# Hard reset of the Klipra backend container.
#
# Use this when:
#   • Code changes to app.py / Python files aren't picked up
#   • You see an error from the OLD version of an endpoint
#   • A plain `restart` was not enough (e.g. you changed docker-compose.yml)
#
# What it does:
#   1. STOPS the backend container (gracefully)
#   2. REMOVES it entirely (so Docker can't reuse a stale image layer)
#   3. CREATES a fresh container with the latest code + latest mounts
#   4. Verifies the new H2V endpoint exists by hitting /docs

KLIPRA_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo " Klipra — FORCE-RESTART backend (clean recreate)"
echo "============================================================"
echo ""

cd "$KLIPRA_PATH" || { echo "FATAL: cannot cd to $KLIPRA_PATH"; read -n 1; exit 1; }

echo "[1/4] Stopping backend container…"
docker compose stop backend

echo ""
echo "[2/4] Removing backend container so it can't reuse stale state…"
docker compose rm -f backend

echo ""
echo "[3/4] Recreating backend with the latest code + folder mounts…"
docker compose up -d backend

echo ""
echo "[4/4] Waiting 20 seconds for FastAPI to come up…"
sleep 20

echo ""
echo "Status:"
docker compose ps backend

echo ""
echo "Verifying the H2V endpoint is live…"
curl -s http://localhost:8000/openapi.json | grep -o '"/api/h2v/analyze"' || echo "  ⚠️  /api/h2v/analyze not found in OpenAPI"

echo ""
echo "Verifying expanded local-mode folders are mounted…"
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
echo "------------------------------------------------------------"
echo ""
echo "Press any key to close this window..."
read -n 1
