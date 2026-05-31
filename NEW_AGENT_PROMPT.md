# Onboarding prompt for a new AI agent

Copy-paste the block below into a fresh Claude Code / Cursor / Cowork session **the first time** you point a new AI at this repo. After that the AI should remember (or re-read `CLAUDE.md` per session).

---

```
I'm handing you a working project called Klipra. It's running locally on this
Mac as a Docker Compose stack. Please follow this onboarding sequence before
doing any real work:

1. The repo lives at: /Volumes/Data/AntiGravity/Klipra
   `cd` into that folder.

2. Read CLAUDE.md in that folder, top to bottom. It is the entry point and
   explains every product, file, convention, and gotcha. Do not skim — the
   pending tasks and gotchas at the bottom matter.

3. Run `docker compose ps` to confirm the three containers (klipra-backend,
   klipra-frontend, klipra-renderer) are Up. If any are down, run
   `docker compose up -d` and then re-check. The app's frontend is at
   http://localhost:5175, backend at http://localhost:8000.

4. Run `git log --oneline -20` so you know what the most recent commits were
   about. Run `git status` so you know what's uncommitted.

5. The owner is Muqaddas (muqaddas@ilmeaalim.com). She is non-technical —
   speak in plain English, never tell her to copy/paste shell commands. If
   you need her to do something on the system, write a `.command` script
   to a clear path and have her double-click it from Finder. If you have a
   computer-use MCP, use it.

6. The product has three user-facing pieces: Generate Viral Clips, Smart
   Clipper (Fast + Pro), Standalone Subtitle, and Standalone Voice Dubbing.
   The three top-nav links you'll see in the app are "Smart Clipper",
   "Auto Subtitle", and "Voice Dubbing". A header logo "klipra" sits on
   the left.

7. The user prefers FREE options. Default to Ollama / Llama 3.2 Vision for
   VLM work and only use paid Gemini when local quality is insufficient.
   When Gemini's daily quota hits (20 RPD), the backend exits with code 2
   and the frontend shows a "resume tomorrow" state — DO NOT swallow that
   error and pretend it succeeded.

8. app.py is ~520 KB. Never try to Read it whole. Use Grep with route
   patterns like `@app.post` or function names. main.py is also large.

9. There are TWO pending tasks at the bottom of CLAUDE.md. Do not start
   either without checking with Muqaddas first.

10. Before you change anything substantive, tell Muqaddas your plan in 3–5
    sentences and wait for her go-ahead. She has been burned by AI agents
    that "improved" things without asking.

Now: please confirm you've read CLAUDE.md by telling me in your own words
(under 200 words) what Klipra is, what its three products are, where the
code lives, and what the two pending tasks are. Then wait for my next
instruction.
```

---

## Why this prompt is structured this way

- **Forces the agent to read CLAUDE.md** — otherwise it starts inventing.
- **Establishes the location first** so the agent doesn't search around in /Users or /tmp.
- **Sets the non-technical tone** so the agent doesn't ask Muqaddas to debug Docker.
- **Forces a self-quiz** at the end ("tell me in your own words") to catch agents that pattern-match instead of actually reading.
- **The 200-word confirmation** is a cheap sanity check — if the agent's summary is wrong, you ask it to read the file again before it does anything else.

## When to give this prompt

- First message of a new chat session with a new AI.
- After a `/clear` or context compaction in an existing session if the AI seems to have lost the thread.
- Before any major task hand-off between AI tools (e.g. moving from Cowork to Cursor).

## What to do if the agent's confirmation summary is wrong

Reply with: "Please re-read CLAUDE.md carefully. Your summary missed [X]. Try again." The agent will re-read and correct itself. Don't proceed to the real task until the confirmation is right — a wrong understanding now is a wrong implementation later.

## Updating this prompt over time

When you add a new major product or rename something, update three places in lockstep:
1. `CLAUDE.md` (the truth)
2. The block above (the onboarding handoff)
3. The "Three user-facing products" list inside the prompt block

Keep them in sync. Drift kills agent quality.
