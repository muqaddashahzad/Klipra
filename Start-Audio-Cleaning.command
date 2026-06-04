#!/bin/bash
# Double-click this to start the Audio Cleaning engine (Clearcast sidecar).
# It normally auto-starts via launchd; use this if it ever isn't running.
echo "Starting the Klipra Audio Cleaning engine…"
launchctl load -w ~/Library/LaunchAgents/com.clearcast.sidecar.plist 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.clearcast.sidecar 2>/dev/null
sleep 2
if curl -fsS http://127.0.0.1:8770/api/health >/dev/null 2>&1; then
  echo "✅ Audio Cleaning engine is running. You can close this window and use Klipra."
else
  echo "Starting directly…"
  cd /Users/macos/clearcast
  exec .venv/bin/python -m uvicorn server:app --app-dir backend --host 0.0.0.0 --port 8770 --log-level warning
fi
