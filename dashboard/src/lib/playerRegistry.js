/**
 * Single-active-player coordinator.
 *
 * Why this exists:
 *   The dashboard renders many <video> tags simultaneously — every clip
 *   in the results grid plus the source-video preview plus modals
 *   (Subtitle, Hook, Translate, Reframe). Without coordination, opening
 *   a modal while a clip is playing leaves the clip audio bleeding into
 *   the modal preview and you hear two videos at once.
 *
 * How it works:
 *   We attach ONE capture-phase listener on `document` that watches every
 *   `play` event from any <video> element in the page. When one plays,
 *   we pause all the others. No per-component wiring needed — any new
 *   <video> added anywhere in the app gets the behavior automatically.
 *
 * Idempotent: calling `installSinglePlayerCoordinator()` repeatedly is
 * safe; the listener only attaches once.
 */

let installed = false;

const onPlayCapture = (e) => {
    const target = e.target;
    if (!target || target.tagName !== 'VIDEO') return;
    // The problem this solves is DOUBLE AUDIO, so the rule is about
    // audio, not playback:
    //   • A MUTED video starting (the Live Analysis ambient loop, the
    //     synced source preview) can't bleed audio — pause nothing.
    //   • An UNMUTED video starting pauses only the other UNMUTED
    //     videos. Muted ones (the synced analysis preview that is
    //     SUPPOSED to run alongside the playing clip) keep going.
    //
    // The old "pause every other video" version broke clip playback on
    // the results page: clicking ▶ on a clip started the muted synced
    // analysis preview, whose own 'play' event re-entered this listener
    // and paused the very clip the user just started — every clip froze
    // at 0:00 while the modals (no synced sibling) played fine.
    if (target.muted || target.volume === 0) return;
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => {
        if (v === target) return;
        if (!v.paused && !v.muted && v.volume > 0) {
            try { v.pause(); } catch { /* element may have been removed */ }
        }
    });
};

export function installSinglePlayerCoordinator() {
    if (installed || typeof document === 'undefined') return;
    document.addEventListener('play', onPlayCapture, /* useCapture */ true);
    installed = true;
}

/** Manually pause every <video> in the document (e.g. when navigating away). */
export function pauseAllVideos() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('video').forEach((v) => {
        try { v.pause(); } catch { /* ignore */ }
    });
}
