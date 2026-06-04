#!/usr/bin/env bash
# Download the DeepFilterNet `deep-filter` prebuilt binary for Apple Silicon.
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
if [ -x bin/deep-filter ]; then echo "deep-filter already present"; exit 0; fi

echo "fetching latest deep-filter release for aarch64-apple-darwin…"
URL=$(.venv/bin/python - <<'PY'
import json, urllib.request
req = urllib.request.Request(
    "https://api.github.com/repos/Rikorose/DeepFilterNet/releases/latest",
    headers={"User-Agent": "clearcast"})
data = json.load(urllib.request.urlopen(req, timeout=30))
url = ""
for a in data.get("assets", []):
    n = a["name"].lower()
    if "deep-filter" in n and "aarch64" in n and ("darwin" in n or "apple" in n or "macos" in n):
        url = a["browser_download_url"]; break
print(url)
PY
)

if [ -z "$URL" ]; then
  echo "no aarch64-apple-darwin asset found in latest release"; exit 1
fi
echo "downloading: $URL"
curl -fL "$URL" -o bin/deep-filter
chmod +x bin/deep-filter
echo "✓ deep-filter installed -> bin/deep-filter"
