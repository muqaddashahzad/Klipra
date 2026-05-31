import React, { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, Loader2, Check, Youtube, Instagram } from 'lucide-react';
import { getApiUrl } from '../config';

/**
 * Walks the user through connecting a social platform via Upload-Post.
 *
 * Flow:
 *   1. We fetch a connect URL for the chosen platform.
 *   2. Open it in a popup (the user signs in / authorizes there).
 *   3. Poll /api/social/user every 3s until the target platform appears
 *      in the user's `connected` array.
 *   4. Resolve onSuccess() so the parent can proceed with posting.
 *
 * `pendingPlatforms` is the list we still need to connect — the modal
 * will drive the user through each one in turn.
 */
const PLATFORM_LABELS = {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    youtube: 'YouTube',
};
const PLATFORM_ICONS = {
    youtube: Youtube,
    instagram: Instagram,
};

export default function SocialConnectModal({
    pendingPlatforms,
    profile,
    uploadPostKey,
    onClose,
    onAllConnected,
}) {
    const [active, setActive] = useState(pendingPlatforms[0] || null);
    const [stillNeeded, setStillNeeded] = useState(pendingPlatforms);
    const [connectUrl, setConnectUrl] = useState(null);
    const [popupOpened, setPopupOpened] = useState(false);
    const [polling, setPolling] = useState(false);
    const pollRef = useRef(null);

    // Fetch the connect URL whenever the active platform changes.
    useEffect(() => {
        if (!active) return;
        let alive = true;
        fetch(getApiUrl(`/api/social/connect-link?platform=${active}&profile=${profile || ''}`), {
            headers: { 'X-Upload-Post-Key': uploadPostKey },
        })
            .then((r) => r.json())
            .then((d) => { if (alive) setConnectUrl(d.url); })
            .catch(() => { if (alive) setConnectUrl('https://app.upload-post.com/manage-users'); });
        return () => { alive = false; };
    }, [active, profile, uploadPostKey]);

    // Background poll for connection status.
    useEffect(() => {
        if (!polling || !active) return;
        const tick = async () => {
            try {
                const r = await fetch(getApiUrl('/api/social/user'), {
                    headers: { 'X-Upload-Post-Key': uploadPostKey },
                });
                if (!r.ok) return;
                const data = await r.json();
                const target = (data.profiles || []).find((p) => !profile || p.username === profile)
                    || data.profiles?.[0];
                const connected = target?.connected || [];
                if (connected.includes(active)) {
                    // Move to the next pending platform, or finish.
                    const remaining = stillNeeded.filter((p) => p !== active && !connected.includes(p));
                    setStillNeeded(remaining);
                    if (remaining.length === 0) {
                        setPolling(false);
                        onAllConnected?.();
                    } else {
                        setActive(remaining[0]);
                        setPopupOpened(false);
                        setConnectUrl(null);
                    }
                }
            } catch { /* swallow — keep polling */ }
        };
        pollRef.current = setInterval(tick, 3000);
        return () => clearInterval(pollRef.current);
    }, [polling, active, profile, uploadPostKey, stillNeeded, onAllConnected]);

    function openPopup() {
        if (!connectUrl) return;
        const w = 700, h = 800;
        const x = (window.screen.width - w) / 2;
        const y = (window.screen.height - h) / 2;
        window.open(
            connectUrl,
            'upload-post-connect',
            `width=${w},height=${h},left=${x},top=${y},menubar=no,toolbar=no,location=yes`
        );
        setPopupOpened(true);
        setPolling(true);
    }

    if (!active) return null;
    const Icon = PLATFORM_ICONS[active] || ExternalLink;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                <button
                    onClick={() => { clearInterval(pollRef.current); onClose?.(); }}
                    className="absolute top-4 right-4 text-zinc-500 hover:text-white"
                >
                    <X size={20} />
                </button>

                <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center">
                        <Icon size={20} />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">
                            Connect {PLATFORM_LABELS[active]}
                        </h3>
                        <p className="text-xs text-zinc-500">
                            {stillNeeded.length > 1
                                ? `${stillNeeded.length} platforms left to connect`
                                : 'One quick step before we post'}
                        </p>
                    </div>
                </div>

                {/* What is Upload-Post — and the free alternative */}
                <div className="mb-5 rounded-lg bg-blue-500/5 border border-blue-500/20 p-3">
                    <p className="text-xs text-blue-200/90 leading-relaxed">
                        <strong className="text-blue-100">What is Upload-Post?</strong> A
                        third-party service (
                        <a href="https://upload-post.com" target="_blank" rel="noreferrer"
                           className="underline hover:text-white">upload-post.com</a>
                        ) that handles social-network OAuth and posting on your behalf.
                        We use it because TikTok, Instagram, and YouTube each require their
                        own auth flows that aren&apos;t safe to handle in a self-hosted app.
                    </p>
                    <p className="text-xs text-blue-200/70 mt-2 leading-relaxed">
                        Your videos pass through Upload-Post when you publish — they
                        don&apos;t store the videos long-term. Your social-network credentials
                        stay with the platforms (TikTok / IG / YT) and never with us.
                    </p>
                </div>

                {/* Honest note about pricing + free alternative */}
                <div className="mb-5 rounded-lg bg-amber-500/5 border border-amber-500/20 p-3 text-xs text-amber-100/90 leading-relaxed">
                    <strong className="text-amber-100 block mb-1">
                        Upload-Post is free up to 10 posts/month, then paid.
                    </strong>
                    For unlimited free posting, the simplest path is to <strong>download
                    each clip</strong> (Download button on every result card) and upload
                    manually to TikTok / Reels / Shorts. Native direct posting from inside
                    Klipra is on the roadmap — YouTube first, then Instagram and TikTok
                    once their business APIs approve our app.
                </div>

                <ol className="text-sm text-zinc-300 space-y-3 mb-5">
                    <li className="flex gap-3">
                        <span className="text-primary font-bold">1.</span>
                        <span>Click <strong>Open Upload-Post</strong> below — a popup window appears at upload-post.com.</span>
                    </li>
                    <li className="flex gap-3">
                        <span className="text-primary font-bold">2.</span>
                        <span>Sign up (free) or log in. Pick your profile and click the {PLATFORM_LABELS[active]} connect button.</span>
                    </li>
                    <li className="flex gap-3">
                        <span className="text-primary font-bold">3.</span>
                        <span>Authorize on {PLATFORM_LABELS[active]}'s page, then close the popup. We auto-detect the new connection.</span>
                    </li>
                </ol>

                <button
                    onClick={openPopup}
                    disabled={!connectUrl}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-primary to-blue-600 text-white font-semibold flex items-center justify-center gap-2 mb-3 disabled:opacity-50"
                >
                    <ExternalLink size={16} />
                    Open Upload-Post
                </button>

                {popupOpened && (
                    <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                        {polling ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                <span>Waiting for connection… (checked every 3 s)</span>
                            </>
                        ) : (
                            <>
                                <Check size={14} className="text-green-400" />
                                <span>Connected. Wrapping up.</span>
                            </>
                        )}
                    </div>
                )}

                <p className="text-[11px] text-zinc-500 text-center mt-3">
                    Stuck? Make sure your Upload-Post key is set in Settings.
                </p>
            </div>
        </div>
    );
}
