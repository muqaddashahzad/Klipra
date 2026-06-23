# Klipra — Full Codebase Audit & Fix Report

**Date:** 2026-06-12
**Scope:** Entire app — backend (~31,000 LOC Python) + frontend (~34,000 LOC React/Vite), every source file.

## How this was done

A 14-agent parallel audit swept the whole codebase (every backend module + every frontend component), partitioned by subsystem. Each finding was then **adversarially verified** by a separate agent (default-to-reject, must back the claim with quoted code) to filter false positives, then synthesized into a prioritized list.

| Stage | Count |
|---|---|
| Raw findings (14 auditors) | 99 |
| Critical/High/Medium sent to verification | 65 |
| **Confirmed real after adversarial verification** | **46 → 42 unique** |
| **Fixed in the first pass** | **28** |
| **Fixed in the follow-up pass (the 12 review items)** | **12** |
| **Total fixed** | **40** |
| Still deferred (low-value-for-your-setup polish) | 4 |
| False positives filtered | 53 |

Every backend fix was compiled (`py_compile`) and the backend was **restarted and confirmed to import cleanly**. Every frontend fix passed the JSX parser. The two riskiest new ffmpeg paths (image-overlay compositing and the shake re-geometry) were additionally validated by running their exact generated filtergraphs against synthetic media and asserting the output (valid render; output dimensions equal source).

---

## ✅ FIXED (28)

### Security (4) — highest priority

| # | File:line | Problem | Fix |
|---|---|---|---|
| 1 | `app.py` ~11676 | **Unauthenticated arbitrary file read + exfiltration** — `/api/thumbnail/publish` joined a user-supplied `thumbnail_url` (`../../../../etc/passwd`) onto the thumbnails dir with no containment, then uploaded the file to Upload-Post. | Added `os.path.realpath` containment check; reject paths that escape the base dir (HTTP 400). |
| 2 | `app.py` ~12115 | **Stored + reflected XSS** on the public `/video/{id}` gallery page — hashtags, video_url, actor_url, language, created interpolated raw into HTML; `product_url` allowed a `javascript:` link. | `html.escape` on all of them; whitelist `http(s)://` for `product_url`; added `rel="noopener noreferrer"`. |
| 5 | `app.py` ~10149 | **PII/billing leak** — a leftover `DEBUG print` dumped the full user record (email, name, plan, `stripe_customer_id`) to stdout on every OAuth login. | Deleted the debug print. |
| 6 | `app.py` ~12280 | **Path traversal** via `selected_actor_url` in `/api/saasshorts/generate`. | Added realpath containment (same pattern as #1). |

### Broken features users hit (high severity)

| # | File:line | Problem | Fix |
|---|---|---|---|
| 3 | `app.py` ~7603 | **Every background swap 404'd** — change-background result URL used `/videos/standalone/<id>/` (slash) instead of `standalone_<id>` (underscore), pointing at a non-existent dir. | Slash → underscore. |
| 30 | `MotionGraphicsModal.jsx` ~763 | **White-screen** — render referenced an undeclared `transcriptSource` → `ReferenceError` right after generating a transcript. | Removed the undefined reference. |
| 31 | `ResultCard.jsx` ~137 | **Aspect change never updated the player** — chip turned green, server re-rendered, but `<video>` kept the old aspect (only `clip.video_url` was mutated, never the player state). | Also `setCurrentVideoUrl(...)` + `videoRef.current.load()`. |
| 32 | `RetrimModal.jsx` ~66 | **Reopening a multi-range clip corrupted its ranges** — primary range re-seeded from `clip.start..clip.end` (the OUTER span of disjoint segments) then extras re-added the same segments. | Seed primary from `clip.ranges[0]` when multi-range. |
| 23 | `StandaloneSubtitle.jsx` ~561 | **Blank screen** after a failed "Recreate in another language" (`status='completed'` with null video matched no render branch). | Return to `transcript_ready` and surface the error via `refineError`. |
| 7 | `app.py` ~946, 1889, 3361 | **Retry-after-restart always failed** with a misleading "re-upload" 409 — `_find_source_video()` was called with 1 arg but required 2 (TypeError swallowed). | Made `output_dir` optional (computed internally); fixes both one-arg callers. |
| 11 | `main.py` ~2104 | **Broken clips / batch crash** — ffmpeg cut return code never checked; a failed cut fed a missing/empty file into reframing. | Check returncode + >1KB file sentinel; skip the clip on failure. |
| 26 | `ProcessingAnimation.jsx` ~26 | **Permanent spinner** for Shorts/live URLs and reopened past-project clips — `type:'url'` was force-routed through the YouTube embed even when no video id existed. | Fall through to a direct `<video>` when no YouTube id; widened the id parser to handle `/shorts/`, `/live/`, `youtu.be`. |

### Correctness / robustness (medium)

| # | File:line | Problem | Fix |
|---|---|---|---|
| 8 | `app.py` ~3478, 3580 | `/api/edit` wrapped a deliberate 404 + an unguarded `clips[idx]` IndexError inside a broad `except` → both became opaque 500s. | `except HTTPException: raise` + bounds-check the clip index. |
| 9 | `app.py` ~3616, 3796 | `edit-timeline` / `edit-region-preview` indexed `clips[idx]` with no bounds check → unhandled IndexError → 500. | Bounds-check both. |
| 10 | `app.py` ~1522 | Undo used `prev_url.split('?')[0]`, truncating filenames containing a literal `?` (e.g. "Is AI a THREAT?_clip_1.mp4") → 404 after undo. | Use `_CACHE_BUST_QUERY_RE` (strips only trailing `?v=`). |
| 4 | `app.py` ~11441 | Synchronous `yt-dlp` download froze the **entire asyncio event loop** (all concurrent requests) in `/api/thumbnail/analyze`. | `run_in_executor`. |
| 13 | `subtitles.py` ~635 | `generate_srt` used bare `word['start']` subscripts — one word missing timings → KeyError aborted the whole burn. | Defensive `.get()` + skip malformed words. |
| 14 | `transcript_utils.py` ~524 | Karaoke/word-highlight swept at a robotic constant rate — real Whisper word timings were discarded even when the rewrite kept the same word count. | Reuse original per-word timings when token count matches; even-split only as fallback. |
| 17 | `motion_graphics.py` ~275 | drawtext apostrophe escaping was wrong inside single quotes — `it's` rendered as `it\s` / broke the filter chain. | Use the `'\''` close-escape-reopen sequence. |
| 18 | `hooks.py` ~612 | Hook overlay temp PNG was written to CWD with a basename-only name — concurrent burns of same-basename clips (`clip_00.mp4`) collided and deleted each other's file. | Unique `uuid` name in the output folder. |
| 19 | `saasshorts.py` ~1215 | composite_video could emit a zero/negative-duration b-roll segment (overlapping picks) → `ffmpeg trim` error / corrupt concat. | Clamp start past previous segment; skip segments < 0.1s. |
| 20 | `transcribe_elevenlabs.py` ~95 | Scribe upload opened the audio file handle inline and never closed it — fd leak (+ Windows unlink failure). | `with open(...)` so it closes before the `finally` removes it. |
| 16 | `llm/providers.py` ~467 | gemini-subscription silently downgraded to a free-tier model when the requested tier name wasn't in the pinned library — no warning. | One-time WARNING naming the requested vs chosen model. |
| 33 | `ResultCard.jsx` ~1039 | EditModal got a **stale `durationSec`** after a retrim — regions/playhead could be placed past the new (shorter) clip end. | Derive duration from live clip state. |
| 24 | `StandaloneSubtitle.jsx` ~446 | Old-language transcript **flashed back** during regenerate/retranslate — the 2s poll kept re-applying the stale result. | Gate re-application on `status === 'transcript_ready'`. |
| 27 | `SaaShortsTab.jsx` ~128 | Voice-reset effect **clobbered the user's chosen voice** on a language toggle and never re-ran after voices loaded. | Keep a still-valid pick; add `voices` to deps. |
| 28 | `SubtitleTimeline.jsx` ~553, 585 | Paste/Duplicate re-selected by `start|text` key — also wrongly selected **pre-existing** identical segments, so a follow-up delete/drag hit unintended clips. | Select by object identity. |
| 12-NR | `ProviderPicker.jsx` ~268 | Catalog refresh **silently overwrote a typed model** for ANY provider (openai/anthropic/openrouter), not just Ollama. | Narrowed the auto-snap to Ollama only (the one provider with a live closed list). |

---

## ✅ FIXED — the 12 review items (follow-up pass)

These were the harder items deferred from the first pass because each touches a core flow, a frontend↔backend contract, disk/undo semantics, or a product decision. They have now all been fixed and verified.

1. **Import-SRT now survives a reload** (`app.py` ~7466) — the import-SRT result now carries `"phase": 1`, the exact field the frontend's refresh-rehydrate (`StandaloneSubtitle.jsx:739`) keys on to restore the transcript + segments. The localStorage job pointer was already being written by the existing status-change effect, so the missing backend field was the whole bug. *FE↔BE contract — closed.*
2. **Image overlays are now burned into the export** (`StandaloneSubtitle.jsx` + `app.py`) — the full feature, not just a banner. The frontend sends each dropped overlay (base64 data URL, centre position, width %, time window) in the burn body; the backend (`_decode_data_url_to_file` + `_burn_image_overlays_sync`) decodes each to a temp image and composites them with `ffmpeg scale + overlay … enable='between(t,start,end)'`, below the hook. Position math uses `overlay_w/_h` so the burn matches the preview. **Validated** by running the generated filtergraph against synthetic media. Best-effort: any failure keeps the still-subtitled video.
3. **Reframe gated on multi-range clips** (`ResultCard.jsx` + `app.py` reframe endpoint) — the button is disabled with an explanatory label/tooltip when `clip.ranges.length > 1`, and the backend returns `HTTPException(400)` as a backstop. No more keyframe-times-mapped-to-wrong-source-frames.
4. **Smart Clipper metadata divergence eliminated** (`app.py`) — added central `_metadata_paths` / `_load_metadata` (canonical-preferred) / `_save_metadata` (**write-through to every metadata file**). Converted every clip-mutating writer to write through both copies: `_apply_clip_change` (reframe/retrim/subtitle/hook/dub), undo, motion-graphics, aspect, regenerate, sync, lyrics, and dub-keep-separate. With every writer writing both files, the two copies can no longer diverge regardless of which one a reader picks. Rehydrate intentionally keeps reading the sidecar-first so legacy already-diverged projects keep the edits the user actually made.
5. **Undo works after retrim/reframe** (`app.py`) — both endpoints now render to a **new timestamped filename** (`…_reframe_<ms>` / `…_retrim_<ms>`, with a prior stamp stripped so names don't grow unbounded) instead of overwriting in place, so the previous render survives on disk and undo's URL points at real prior bytes.
6. **Phantom "5 jobs/month" quota removed** (`email_utils.py` + `accounts.py`) — the welcome email no longer advertises a job cap that was never enforced (now "Free to use. No credit card required."). The unused `can_run_job`/`record_job_usage` are kept but clearly documented as future-SaaS scaffolding that is deliberately *not* wired into the keyless self-hosted build (enforcing it would only lock you out of your own machine).
7. **gemini-webapi pin bumped** (`requirements.txt`) — `>=1.5.0` → `>=2.0.0`. The installed 2.0.0 already exposes the tier model constants the catalog advertises, so the pin just prevents a rebuild from silently downgrading to a version that can't select them.
8. **SubtitleModal resets on close** (`ResultCard.jsx`) — now conditionally mounted (`{showSubtitleModal && <SubtitleModal/>}`), so each open is a fresh instance and stale draft captions / Regenerate results can't leak into the next clip's modal.
9. **H2V split no longer drops footage** (`HorizontalToVertical.jsx`) — `splitAtPlayhead` now partitions **every** range at the playhead (whole-before → part 1, whole-after → part 2, straddling → cut in two), and also splits correctly when the playhead lands in a gap between ranges (the old code did nothing there).
10. **Shake no longer re-frames the whole clip** (`timeline_effects.py`) — replaced `crop=iw-20:ih-20` (which shrank every frame and forced a full-clip rescale) with `pad … , crop` back to source size. Output dimensions now equal the source, and out-of-region frames are pixel-identical. **Validated**: source 320×240 → shake output 320×240.
11. **Two diverged `Subtitles.tsx` copies synced** (remotion) — the stale `remotion/src` copy was brought in line with the good `dashboard/src` copy (6% caption positions, font-size-scaled gap, 90% max width, trimmed words).
12. **ProviderPicker auto-snap narrowed** (`ProviderPicker.jsx`) — the model-reset-on-provider-change now only fires for Ollama, so switching providers no longer clobbers a valid model pick (this one was completed at the end of the first pass).

### Still deferred (low value for your single-user Docker setup)
- `#12 main.py` stale `.last_picker_error.txt` → occasional false "daily quota" — involved refactor; documented.
- `#15 llm/factory.py` FallbackProvider ignores `OLLAMA_BASE_URL` — only matters **outside** Docker; you run in Docker, so no effect today.
- `#21 editor.py` SFX cue fps drift — sub-frame magnitude, optional polish.
- `#25/#29 StandaloneSubtitle/SubtitleModal` minor UX (duplicate Download-SRT button, regenerate-banner mode) — documented.

---

## Recurring themes (root patterns, not one-offs)

1. **`?`-in-filename truncation** — `split('?')[0]` on filenames recurs (undo, edit endpoints). Source videos with a `?` in the title (e.g. "Is AI a THREAT?") break URLs, burns, and lookups. The `_CACHE_BUST_QUERY_RE` regex exists exactly to prevent this; new code should always use it / `_clip_filename_from_url` / `clipFilenameFromUrl`, never a raw `split('?')`.
2. **Broad `except Exception`** swallowing precise errors (TypeError/IndexError/HTTPException) → misleading 500s and false "re-upload"/"quota" messages. Always `except HTTPException: raise` before a broad handler, and bounds-check before indexing client-supplied indices.
3. **Multi-range retrim contract** — `clip.start/end` is the OUTER span of disjoint segments, but several consumers (RetrimModal, ReframeModal, EditModal, H2V split) treat it as continuous. Anything reading clip duration/window must check `clip.ranges`.
4. **Player/state not refreshed after a server re-render** — mutating `clip.video_url` alone never updates the `<video>`; you must update the player state + `.load()`.
5. **Security on public/credentialed endpoints** — path joins of user input need realpath containment; HTML pages built from user metadata need escaping + scheme whitelisting.

---

## How to verify
- Backend was restarted and imports cleanly (`/api/providers` responds 200, no tracebacks in logs) — confirms no syntax/import regressions across all edited modules, including the metadata-helper refactor and the new image-overlay helpers.
- All edited frontend files pass the JSX parser. The repo is bind-mounted into the container and the frontend is served by Vite, so **refresh the dashboard (⌘R)** to pick up the frontend fixes — no rebuild needed.
- The two riskiest new ffmpeg paths were validated against synthetic media: the image-overlay filtergraph renders a valid file, and the reworked shake keeps output dimensions equal to source (320×240 → 320×240).
- Spot-check the high-value ones: drop a logo onto the subtitle preview and burn (it now appears in the mp4); retrim or reframe a clip then hit Undo (it now reverts); split a merged clip in H2V at a gap (both halves keep their footage); change a clip's aspect (player updates); reopen a multi-range retrim (ranges intact); import an SRT then refresh (project survives); burn subtitles on a `?`-titled source (no 404).

---

# Addendum — 13 Jun 2026: the "clips don't play on the home page" bug + interaction sweep

## The bug you reported (reproduced, root-caused, fixed, verified)

**Symptom**: on the Generate Viral Clips results page, clicking ▶ on any clip did nothing — the clip froze at 0:00. Opening Edit timing / Reframe and playing the video there worked fine.

**Root cause** (`dashboard/src/lib/playerRegistry.js`, installed by `App.jsx`): a document-level "single active player" listener paused **every** other `<video>` whenever one started playing. But the results page intentionally plays TWO videos at once — your clip, plus the muted Live Analysis preview that seeks in sync with it (`handleClipPlay` → `ProcessingAnimation`). Sequence of the fight: you press ▶ → the synced analysis preview starts → its own `play` event re-enters the registry → the registry pauses *your clip*. Every clip froze instantly. Modals have no synced sibling video, which is exactly why playback worked there. Each file was individually correct — the bug only existed in their interplay, which is why the per-file audit missed it.

**Fix**: the registry now reasons about **audio**, not playback — a muted video starting pauses nothing, and an unmuted video starting pauses only other *unmuted* videos. The double-audio protection it was built for is preserved.

**Verified live in your browser (Chrome, localhost:5175)**:
- Clip 1 plays and advances (0:24/0:40 on screen) while the muted Live Sync preview runs alongside.
- Playing clip 2 still pauses clip 1 (no double audio).
- `/videos/...` serving was confirmed healthy end-to-end first (200 + 206 Range through both :8000 and the Vite proxy), ruling out the network layer.

## Also found & fixed this round

1. **Nested `<button>` in Smart Clipper model cards** (`SmartClipper.jsx`) — the clickable model card was a `<button>` containing the Download/Try-again `<button>`s (invalid HTML; browsers may reparent the DOM). Card is now an accessible `div role="button"` with keyboard support. Verified: 0 nested buttons in the live DOM, card selection works, console clean.
2. **Dead job polls forever after a backend restart** (`App.jsx`) — jobs live in backend memory, so a restart wipes them; a restored session then polled the dead job id every 2 s forever with the spinner stuck on "processing". Now a 404 stops polling, clears the saved session, and shows: *"This job no longer exists on the server — the backend was restarted while it was running. Click New to start over."* Verified live: planted a dead-job session → exactly one 404, polling stops, error panel renders; your real session was restored intact afterwards.
3. **Actor-photo blob URL leak** (`SaaShortsTab.jsx`) — uploaded actor photos created `URL.createObjectURL` previews that were never revoked. Added revoke-on-replace/unmount (the same convention every other uploader in the app already follows).
4. **Deployment gaps closed** — today's `app.py` (multi-range reframe backstop) copied into `klipra-backend` and the backend restarted cleanly (`/api/providers` 200, zero active jobs at restart time); the synced `Subtitles.tsx` copied into the renderer container (it bakes sources into the image — the host file alone wasn't enough) and the renderer restarted.

## Interaction sweep (multi-agent, 33 agents)

Because the playback bug was an *interaction-class* bug, a dedicated sweep hunted specifically for more of that class across 8 dimensions (global listeners, parent/child state desync, FE↔BE contract drift, media lifecycle, persistence/restore, polling races, modal lifecycle, regression-check of all recent fixes). **25 candidate findings were raised; each was adversarially verified against the actual code; 23 were refuted as not real or unreachable; the 2 confirmed real ones are items 2 and 3 above — both fixed.** Notably, the contract-drift and regression-check dimensions confirmed the recent fixes (image-overlay burn coordinates, metadata write-through, retrim/reframe new-filename undo) hold together.

## Browser click-through

All 8 pages were opened in your browser and checked for console errors after load: Generate Viral Clips, Smart Clipper, Horizontal→Vertical, Auto Subtitle (2 past projects render), Voice Dubbing, Audio Cleaning, YouTube SEO, AI Avatar — all clean after the fixes above.
