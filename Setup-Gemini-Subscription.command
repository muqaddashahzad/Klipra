#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Setup-Gemini-Subscription.command
#
# Reads your Chrome cookies for gemini.google.com and saves them to
# data/gemini_cookies.json so Klipra's "Google Gemini (Subscription)"
# provider can use your AI Pro subscription instead of the rate-limited
# developer API.
#
# WHAT TO DO BEFORE RUNNING THIS:
#   1. Open Google Chrome
#   2. Go to https://gemini.google.com
#   3. Log in with the Google account that has AI Pro subscription
#   4. Send any test message ("hi") so the session is fully established
#   5. Quit Chrome FULLY (Cmd+Q) — required so the cookie file is unlocked
#   6. Double-click this script
#
# WHAT THIS SCRIPT DOES:
#   - Installs browser_cookie3 in a temp venv (if missing)
#   - Reads __Secure-1PSID and __Secure-1PSIDTS cookies from Chrome
#   - Writes them to /Volumes/Data/AntiGravity/Klipra/data/gemini_cookies.json
#   - Reminds you to restart the backend container
# ─────────────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")"
clear

echo "═══════════════════════════════════════════════════════════════"
echo "  Klipra — Set up Google Gemini Subscription provider"
echo "═══════════════════════════════════════════════════════════════"
echo

# Check Python is available
if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found in PATH. Install Python 3 and re-run."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# Make sure Chrome is closed (its cookie file is locked while running)
if pgrep -x "Google Chrome" >/dev/null; then
  echo "⚠  Google Chrome is currently running."
  echo "   Its cookie database is locked while open — extraction will fail."
  echo
  echo "   Please:"
  echo "     1. Make sure you're logged into gemini.google.com in Chrome"
  echo "     2. Quit Chrome FULLY (Cmd+Q, not just close window)"
  echo "     3. Re-run this script"
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# Ensure browser_cookie3 is installed (in user-site to avoid touching system Python)
echo "Checking dependencies…"
if ! python3 -c "import browser_cookie3" 2>/dev/null; then
  echo "Installing browser_cookie3 (one-time)…"
  python3 -m pip install --user --quiet browser_cookie3 || {
    echo "✗ pip install failed. Try: pip3 install browser_cookie3"
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  }
fi
echo "✓ Dependencies ready"
echo

# Extract cookies
python3 <<'PY'
import json, os, sys
from pathlib import Path
import browser_cookie3

OUT = Path("/Volumes/Data/AntiGravity/Klipra/data/gemini_cookies.json")

NEEDED = ("__Secure-1PSID", "__Secure-1PSIDTS")

try:
    cj = browser_cookie3.chrome(domain_name=".google.com")
except Exception as e:
    print(f"✗ Could not read Chrome cookies: {e}")
    print()
    print("Common causes:")
    print("  - Chrome is still running (quit it fully with Cmd+Q)")
    print("  - macOS Keychain blocked decryption (allow when prompted)")
    print("  - You aren't signed in to Google in Chrome")
    sys.exit(1)

found = {}
for c in cj:
    if c.name in NEEDED:
        found[c.name] = c.value

missing = [k for k in NEEDED if k not in found]
if missing:
    print(f"✗ Missing required cookies: {missing}")
    print()
    print("Please go to https://gemini.google.com in Chrome,")
    print("sign in with your AI Pro account, send any message ('hi'),")
    print("then quit Chrome (Cmd+Q) and re-run this script.")
    sys.exit(1)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(found, indent=2))
os.chmod(OUT, 0o600)

print(f"✓ Saved Gemini subscription cookies to:")
print(f"  {OUT}")
print()
print(f"  Cookie names captured: {list(found.keys())}")
print(f"  __Secure-1PSID length:  {len(found['__Secure-1PSID'])} chars")
print(f"  __Secure-1PSIDTS length:{len(found['__Secure-1PSIDTS'])} chars")
PY

if [ $? -ne 0 ]; then
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Cookies saved. Now restart the Klipra backend:"
echo
echo "      Double-click   Restart-Backend.command"
echo
echo "  Then in Klipra's provider picker, choose:"
echo
echo "      Google Gemini (Subscription — no quota)"
echo
echo "  Cookies stay valid as long as you're signed into gemini.google.com"
echo "  in Chrome. If you sign out or the session expires, re-run this"
echo "  script."
echo "═══════════════════════════════════════════════════════════════"
echo
read -n 1 -s -r -p "Press any key to close..."
