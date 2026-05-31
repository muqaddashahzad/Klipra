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
    // Pause every other <video> currently in the DOM.
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => {
        if (v === target) return;
        if (!v.paused) {
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
