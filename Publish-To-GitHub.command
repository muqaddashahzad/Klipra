#!/bin/bash
# Publishes the local Klipra repo to https://github.com/muqaddashahzad/Klipra
#
# What it does:
#   1. Confirms we're in the right folder
#   2. Re-points the git "origin" remote at YOUR Klipra repo
#      (currently it still points at the original openshorts fork)
#   3. Sanity-checks that .env and data/ are NOT being pushed
#   4. Stages every change, commits them with a clear message
#   5. Pushes to GitHub
#   6. If anything fails (usually auth), tells you exactly what to do next
#
# This script is SAFE to run multiple times. If there's nothing new to commit
# it'll just skip the commit step and try the push.
#
# ===========================================================================

set -u

KLIPRA_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_URL="https://github.com/muqaddashahzad/Klipra.git"
TARGET_REPO="muqaddashahzad/Klipra"

echo "============================================================"
echo "  Klipra — Publish to GitHub"
echo "============================================================"
echo ""
echo "  Repo folder : $KLIPRA_PATH"
echo "  Target      : $TARGET_URL"
echo ""

cd "$KLIPRA_PATH" || { echo "FATAL: cannot cd to $KLIPRA_PATH"; read -n 1; exit 1; }

if [ ! -d ".git" ]; then
    echo "ERROR: This folder is not a git repository. Aborting."
    read -n 1; exit 1
fi

# ---------- 0. Clean up stale git locks ----------
if [ -f ".git/index.lock" ]; then
    # Check if any git process is actually running before removing
    if ! pgrep -f "git" >/dev/null 2>&1; then
        echo "[cleanup] Removing stale .git/index.lock"
        rm -f .git/index.lock
    fi
fi

# ---------- 1. Re-point origin ----------
CURRENT_ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
echo "Current origin : ${CURRENT_ORIGIN:-<none>}"
if [ "$CURRENT_ORIGIN" != "$TARGET_URL" ]; then
    echo "Re-pointing origin → $TARGET_URL"
    if [ -z "$CURRENT_ORIGIN" ]; then
        git remote add origin "$TARGET_URL"
    else
        git remote set-url origin "$TARGET_URL"
    fi
fi
echo "New origin     : $(git remote get-url origin)"
echo ""

# ---------- 2. Safety check ----------
echo "[safety] Checking that secrets/private files aren't staged…"
RISKY="$(git ls-files --cached --others --exclude-standard | grep -E '^(\.env$|data/|.*\.db$|.*\.sqlite$)' || true)"
if [ -n "$RISKY" ]; then
    echo ""
    echo "  ⚠️  ABORTING — the following files would be pushed but look private:"
    echo "$RISKY"
    echo ""
    echo "  Open .gitignore and make sure these patterns are listed, then re-run."
    read -n 1; exit 1
fi
echo "[safety] OK — .env, data/, and any *.db files are excluded."
echo ""

# ---------- 3. Stage + commit ----------
echo "[commit] Staging changes…"
git add -A

if git diff --cached --quiet; then
    echo "[commit] Nothing new to commit (already up to date locally)."
else
    COMMIT_MSG="feat: sync latest Klipra changes

Includes the full Klipra fork on top of OpenShorts:
- Smart Clipper Fast + Pro (multimodal VLM picker)
- Standalone Subtitle + Voice Dubbing flows
- Keyframed Reframe (any aspect, draggable, face-aware)
- Word-level subtitle animations (highlight, box, pop, karaoke, glow)
- Hinglish / Roman Urdu / Urglish transliteration modes
- BYOL (Bring Your Own Lyrics) with LLM alignment
- AI Motion Graphics with face-aware text placement
- Voice dub + target-language subtitle combo
- Viral hook overlay with proper emoji rendering
- Pro-NLE EditModal + RetrimModal with waveform + zoom + speed
- Whisper Metal sidecar for Apple Silicon
- Local-file mode (~/Desktop, ~/Downloads, ~/Documents, ~/Movies)
- Auth, influencer programme, welcome email, S3 backup
- Free-first design: Ollama supported as the provider for every AI step"

    git commit -m "$COMMIT_MSG" || {
        echo "[commit] git commit returned non-zero — continuing anyway."
    }
fi
echo ""

# ---------- 4. Fetch what's on GitHub first ----------
CURRENT_BRANCH="$(git branch --show-current)"
echo "[push] Branch    : $CURRENT_BRANCH"
echo "[push] Target    : $TARGET_REPO"
echo "[push] Fetching the current state of GitHub…"
git fetch origin "$CURRENT_BRANCH" 2>&1 | tail -5
echo ""

# Compare local vs remote
REMOTE_COMMIT="$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")"
LOCAL_COMMIT="$(git rev-parse HEAD)"

if [ -z "$REMOTE_COMMIT" ]; then
    DIVERGENCE="empty"
elif [ "$REMOTE_COMMIT" = "$LOCAL_COMMIT" ]; then
    DIVERGENCE="same"
else
    AHEAD="$(git rev-list --count "origin/$CURRENT_BRANCH..HEAD" 2>/dev/null || echo "?")"
    BEHIND="$(git rev-list --count "HEAD..origin/$CURRENT_BRANCH" 2>/dev/null || echo "?")"
    if [ "$BEHIND" = "0" ]; then
        DIVERGENCE="ahead"
    elif [ "$AHEAD" = "0" ]; then
        DIVERGENCE="behind"
    else
        DIVERGENCE="diverged"
    fi
fi

case "$DIVERGENCE" in
    same)
        echo "[push] Local and remote are already identical. Nothing to push."
        PUSH_OK=1
        ;;
    empty|ahead)
        echo "[push] Fast-forward push…"
        if git push -u origin "$CURRENT_BRANCH"; then
            PUSH_OK=1
        else
            PUSH_OK=0
        fi
        ;;
    behind|diverged)
        echo ""
        echo "  ⚠️  GitHub has $BEHIND commit(s) that aren't in your local repo."
        echo "      Your local has $AHEAD commit(s) that aren't on GitHub."
        echo ""
        echo "  You told me your local copy is the source of truth, so I'll"
        echo "  force-push and OVERWRITE whatever is on GitHub right now."
        echo ""
        echo "  This is safe because the Klipra repo only has you as a user —"
        echo "  no one else has cloned it (it's still private)."
        echo ""
        echo "  Press ENTER to overwrite GitHub with your local code, or Ctrl-C to abort…"
        read _confirm
        echo ""
        echo "[push] Force-pushing local → GitHub…"
        if git push -u origin "$CURRENT_BRANCH" --force; then
            PUSH_OK=1
        else
            PUSH_OK=0
        fi
        ;;
    *)
        echo "[push] Unknown state. Trying a normal push…"
        if git push -u origin "$CURRENT_BRANCH"; then
            PUSH_OK=1
        else
            PUSH_OK=0
        fi
        ;;
esac

if [ "$PUSH_OK" -ne 1 ]; then
    echo ""
    echo "============================================================"
    echo "  PUSH FAILED"
    echo "============================================================"
    echo ""
    echo "  If the error above mentions 'authentication' or 'permission',"
    echo "  it's a credential problem. Two ways to fix:"
    echo ""
    echo "  Option A — Install GitHub CLI (recommended):"
    echo "    1. Open Terminal"
    echo "    2. Run:  brew install gh"
    echo "    3. Run:  gh auth login   (follow the prompts)"
    echo "    4. Double-click this script again"
    echo ""
    echo "  Option B — Use a Personal Access Token:"
    echo "    1. Go to https://github.com/settings/tokens"
    echo "    2. Click 'Generate new token (classic)'"
    echo "    3. Tick the 'repo' scope, generate it, copy the token"
    echo "    4. Run this script again — when it prompts for username"
    echo "       enter 'muqaddashahzad' and paste the TOKEN as the password"
    echo ""
    echo "  Otherwise, copy the error above and send it to your AI agent."
    echo ""
    read -n 1
    exit 1
fi

echo ""
echo "============================================================"
echo "  ✅  PUSHED SUCCESSFULLY"
echo "============================================================"
echo ""
echo "  Your latest code is now on GitHub:"
echo "  → https://github.com/muqaddashahzad/Klipra"
echo ""
echo "  NEXT STEP — make the repo public:"
echo "    1. Open https://github.com/muqaddashahzad/Klipra/settings"
echo "    2. Scroll all the way down to the red 'Danger Zone'"
echo "    3. Click 'Change repository visibility'"
echo "    4. Choose 'Make public'  and confirm by typing the repo name"
echo ""
echo "  Once public, anyone can clone and run it with:"
echo "    git clone https://github.com/muqaddashahzad/Klipra.git"
echo "    cd Klipra && docker compose up -d"
echo ""
echo "Press any key to close this window…"
read -n 1
