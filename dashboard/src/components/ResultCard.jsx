import React, { useState, useEffect } from 'react';
import { Download, Share2, Instagram, Youtube, Video, CheckCircle, AlertCircle, X, Loader2, Copy, Wand2, Type, Calendar, Clock, Languages, Scissors, MoveHorizontal, Undo2, AlertTriangle, Sparkles } from 'lucide-react';
import { getApiUrl } from '../config';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';
import TranslateModal from './TranslateModal';
import RetrimModal from './RetrimModal';
import ReframeKeyframeModal from './ReframeKeyframeModal';
import SocialConnectModal from './SocialConnectModal';
import EditModal from './EditModal';
import MotionGraphicsModal from './MotionGraphicsModal';
import { renderInBrowser } from '../lib/renderInBrowser';

export default function ResultCard({ clip, index, jobId, uploadPostKey, uploadUserId, geminiApiKey, llmConfig, elevenLabsKey, onPlay, onPause }) {
    // Headers identifying which LLM to call for AI-powered actions
    // (Auto Edit, Effects, Subtitle, Hook, Translate). React state
    // (llmConfig prop) lags behind user picker clicks; localStorage is
    // the authoritative source set by KeyInput on every change.
    function getLlmHeaders() {
        let provider = llmConfig?.provider || 'gemini';
        let model = llmConfig?.model || 'gemini-2.5-flash';
        let key = llmConfig?.api_key || geminiApiKey || '';
        try {
            const prefRaw = localStorage.getItem('os_llm_pref_last');
            if (prefRaw) {
                const pref = JSON.parse(prefRaw);
                if (pref?.provider) provider = pref.provider;
                if (pref?.model) model = pref.model;
            }
            const keyRaw = localStorage.getItem(`os_llm_key_${provider}`);
            if (keyRaw) {
                const SALT = 'openshorts-llm-v1';
                const decoded = atob(keyRaw);
                let out = '';
                for (let i = 0; i < decoded.length; i++) {
                    out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
                }
                if (out) key = out;
            }
        } catch { /* fall through with React-state defaults */ }
        return {
            'X-LLM-Provider': provider,
            'X-LLM-Model': model,
            'X-LLM-Key': key,
            // Legacy: only fill X-Gemini-Key when the user is actually on Gemini.
            'X-Gemini-Key': provider === 'gemini' ? key : '',
        };
    }
    // Build at-call-time so each fetch picks up the freshest config
    const llmHeaders = getLlmHeaders();
    const [showModal, setShowModal] = useState(false);
    const [showSubtitleModal, setShowSubtitleModal] = useState(false);
    const videoRef = React.useRef(null);
    // Defensive default — past projects rehydrated from disk occasionally
    // have a clip with a missing video_url (mid-edit crash, manual file
    // deletion, etc.). Treating that as an empty string keeps the
    // component from crashing the whole dashboard during render.
    const originalVideoUrl = getApiUrl(clip.video_url || '');
    const [currentVideoUrl, setCurrentVideoUrl] = useState(originalVideoUrl);
    // Surface playback failures (404, codec, network, etc.) directly on
    // the card. Without this, the native <video> just shows a black
    // frame and the user can't tell why it's not playing.
    const [playerError, setPlayerError] = useState(null);

    // The browser <video src=...> needs URL-safe characters. When users
    // upload videos with names containing spaces, '$', '(', ')', or
    // non-ASCII characters like the en-dash '–', the unencoded URL
    // either fails to fetch or silently 404s. encodeURI percent-encodes
    // those without touching valid path separators.
    //
    // We KEEP currentVideoUrl in its raw form because other API calls
    // extract the filename from it via .split('/').pop() and feed it
    // back to the backend, which expects the unencoded form on disk.
    const safePlayerSrc = (url) => {
        if (!url || typeof url !== 'string') return '';
        try {
            // Encode each path segment individually so '/' and '?' stay
            // as separators. We split on '?' to keep the cache-bust
            // query string intact.
            const [base, query] = url.split('?');
            const encodedBase = base.split('/').map((seg, i) =>
                // First two segments are protocol+host (http://localhost)
                // and the leading empty (after '//'). Encode everything
                // after the path begins.
                i < 3 || /^[a-z]+:$/i.test(seg) || seg === '' ? seg : encodeURIComponent(seg)
            ).join('/');
            return query ? `${encodedBase}?${query}` : encodedBase;
        } catch {
            return url;
        }
    };

    // Live timer state — updated as the clip plays. We display it as an
    // overlay so users can decide where to extend/shrink without doing
    // mental math against the native scrubber.
    const [playTime, setPlayTime] = useState(0);
    const [playDuration, setPlayDuration] = useState(0);

    // Retrim (edit start/end) modal state
    const [showRetrim, setShowRetrim] = useState(false);
    const [showReframe, setShowReframe] = useState(false);
    const [liveClip, setLiveClip] = useState(clip);
    useEffect(() => { setLiveClip(clip); }, [clip]);

    // Social-connect modal — opened automatically by handlePost when the
    // selected platforms aren't already linked to the user's profile.
    const [pendingConnect, setPendingConnect] = useState(null); // [platforms] or null
    const [retryPostAfterConnect, setRetryPostAfterConnect] = useState(false);

    const [platforms, setPlatforms] = useState({
        tiktok: true,
        instagram: true,
        youtube: true
    });
    const [postTitle, setPostTitle] = useState("");
    const [postDescription, setPostDescription] = useState("");
    const [isScheduling, setIsScheduling] = useState(false);
    const [scheduleDate, setScheduleDate] = useState("");

    const [posting, setPosting] = useState(false);
    const [postResult, setPostResult] = useState(null);

    const [isEditing, setIsEditing] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    // AI Motion Graphics + SFX modal — proposes overlay events and
    // bakes them into the clip on apply.
    const [showMotionGraphics, setShowMotionGraphics] = useState(false);
    // Aspect re-render — calls /api/clip/{job}/{idx}/aspect to letter/
    // pillar-box the clip into the chosen aspect. The Reframe modal
    // handles the more sophisticated face-tracked crop; this is the
    // quick preset.
    const [aspectChanging, setAspectChanging] = useState(null); // null|'9:16'|'16:9'|'1:1'
    const [aspectError, setAspectError] = useState('');
    const [currentAspect, setCurrentAspect] = useState(clip.aspect || '');
    const changeAspect = async (target) => {
        setAspectChanging(target);
        setAspectError('');
        try {
            const r = await fetch(getApiUrl(`/api/clip/${jobId}/${index}/aspect`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aspect: target }),
            });
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json();
            setCurrentAspect(data.aspect || target);
            // Force the <video> tag to re-fetch by appending a cache-bust
            // — same trick the rest of Klipra uses for re-renders.
            clip.video_url = data.clip_url + (data.clip_url.includes('?') ? '&' : '?') + 'v=' + Date.now();
        } catch (e) {
            setAspectError(e.message || String(e));
        } finally {
            setAspectChanging(null);
        }
    };
    // Sound-effect master controls for Auto Edit. When the toggle is on
    // the backend auto-detects the AI's zoompan transitions and mixes
    // synthetic SFX (whoosh / impact / pop / etc.) at those moments.
    // sfxVolume is a master gain 0..1 applied to all cues. Defaults to
    // off so existing users see no behavior change unless they opt in.
    const [autoEditSfx, setAutoEditSfx] = useState(false);
    const [autoEditSfxVolume, setAutoEditSfxVolume] = useState(0.6);
    const [isSubtitling, setIsSubtitling] = useState(false);
    const [isHooking, setIsHooking] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
    const [isUndoing, setIsUndoing] = useState(false);
    const [showHookModal, setShowHookModal] = useState(false);
    const [showTranslateModal, setShowTranslateModal] = useState(false);
    const [editError, setEditError] = useState(null);

    // Per-clip undo stack — each mutating operation (auto edit, hook,
    // subtitle, dub, retrim, reframe) pushes the previous video_url onto
    // this list on the backend. We mirror the depth here so the Undo
    // button knows whether there's anything to revert.
    const [historyDepth, setHistoryDepth] = useState(
        Array.isArray(clip.history) ? clip.history.length : 0
    );
    // Mirror the reframe-invalidation flag so we can render a banner
    // ("clip timing changed — re-set keyframes") after retrim.
    const [reframeInvalidated, setReframeInvalidated] = useState(
        !!clip.reframe_invalidated_at
    );

    const [clipDuration, setClipDuration] = useState(clip.end && clip.start ? clip.end - clip.start : 30);

    // Accumulate Remotion layers across operations
    const [activeLayers, setActiveLayers] = useState({ subtitles: null, hook: null, effects: null });

    // Fetch clip duration from transcript endpoint
    useEffect(() => {
        if (!jobId || index === undefined) return;
        fetch(getApiUrl(`/api/clip/${jobId}/${index}/transcript`))
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.durationSec) setClipDuration(data.durationSec);
            })
            .catch(() => {});
    }, [jobId, index]);

    // Initialize/Reset form when modal opens
    useEffect(() => {
        if (showModal) {
            setPostTitle(clip.video_title_for_youtube_short || "Viral Short");
            setPostDescription(clip.video_description_for_instagram || clip.video_description_for_tiktok || "");
            setIsScheduling(false);
            setScheduleDate("");
            setPostResult(null);
        }
    }, [showModal, clip]);

    // Tiny convenience: every successful mutating op pushes 1 to history.
    const bumpHistory = () => setHistoryDepth((n) => n + 1);

    const handleUndo = async () => {
        if (historyDepth <= 0 || isUndoing) return;
        setIsUndoing(true);
        setEditError(null);
        try {
            const res = await fetch(getApiUrl(`/api/clip/${jobId}/${index}/undo`), {
                method: 'POST',
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.video_url) {
                setCurrentVideoUrl(getApiUrl(data.video_url));
                if (videoRef.current) videoRef.current.load();
            }
            setHistoryDepth(typeof data.remaining_history === 'number'
                ? data.remaining_history
                : Math.max(0, historyDepth - 1));
        } catch (e) {
            setEditError(e.message || String(e));
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsUndoing(false);
        }
    };

    const handleAutoEdit = async () => {
        setIsEditing(true);
        setEditError(null);
        try {
            const apiKey = geminiApiKey || localStorage.getItem('gemini_key');

            if (!apiKey) {
                throw new Error("Gemini API Key is missing. Please set it in Settings.");
            }

            // The legacy openshorts code path tried a Remotion-preview
            // endpoint first and fell back to FFmpeg. Remotion previewing
            // was never fully wired in this dashboard (refs an undeclared
            // setCompositionParams), so we skip directly to FFmpeg-based
            // auto-edit which actually works and writes to disk.
            const res = await fetch(getApiUrl('/api/edit'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...llmHeaders,
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: currentVideoUrl.split('?')[0].split('/').pop(),
                    enable_sfx: autoEditSfx,
                    sfx_volume: autoEditSfxVolume,
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) {
                    videoRef.current.load();
                }
                bumpHistory();
            }

        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsEditing(false);
        }
    };

    const handleSubtitle = async (options) => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            // Always use the FFmpeg backend. The previous Remotion path
            // produced `blob:http://.../<uuid>` URLs which broke EVERY
            // subsequent op — Hook / Auto Edit / Reframe all parse the
            // current URL with `.split('/').pop()` to find the file
            // they should operate on, and a blob URL gives them the
            // bare UUID with no extension. Backend then 404s with
            // "Video file not found: output/<job>/<uuid>".
            const res = await fetch(getApiUrl('/api/subtitle'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // LLM headers needed for transliteration / translation paths
                    ...llmHeaders,
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    position: options.position,
                    font_size: options.fontSize,
                    font_name: options.fontName,
                    font_color: options.fontColor,
                    border_color: options.borderColor,
                    border_width: options.borderWidth,
                    bg_color: options.bgColor,
                    bg_opacity: options.bgOpacity,
                    script_mode: options.scriptMode || 'auto',
                    target_language: options.targetLanguage || null,
                    edited_text: options.editedText || null,
                    // Animation + highlight color picked in SubtitleModal.
                    // Defaults to 'none' / yellow so callers that don't
                    // pass these fall back to plain subtitles (the legacy
                    // behaviour) instead of producing surprises.
                    animation: options.animation || 'none',
                    highlight_color: options.highlightColor || '#FFDD00',
                    input_filename: currentVideoUrl.split('?')[0].split('/').pop()
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
                bumpHistory();
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleHook = async (hookData) => {
        setIsHooking(true);
        setEditError(null);
        try {
            // Always go through the FFmpeg backend. The previous Remotion
            // branch silently produced a blob URL that wasn't really
            // burned-in to the saved file — that was the
            // "Generate doesn't apply" bug.
            const payload = typeof hookData === 'string'
                ? { text: hookData, position: 'top', size: 'M' }
                : hookData;

            const res = await fetch(getApiUrl('/api/hook'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    text: payload.text,
                    position: payload.position,
                    size: payload.size,
                    text_color: payload.text_color || '#000000',
                    bg_color: payload.bg_color || '#FFFFFF',
                    bg_opacity: typeof payload.bg_opacity === 'number' ? payload.bg_opacity : 0.94,
                    y_offset: typeof payload.y_offset === 'number' ? payload.y_offset : null,
                    input_filename: currentVideoUrl.split('?')[0].split('/').pop()
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
                bumpHistory();
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    const handleTranslate = async (options) => {
        setIsTranslating(true);
        setEditError(null);
        try {
            const dubProvider = options.dubProvider || 'elevenlabs';

            if (dubProvider === 'elevenlabs' && !elevenLabsKey) {
                throw new Error("ElevenLabs API Key is missing. Pick Edge TTS for a free option, or set the key in Settings.");
            }

            const requestBody = {
                job_id: jobId,
                clip_index: index,
                target_language: options.targetLanguage,
                input_filename: currentVideoUrl.split('?')[0].split('/').pop(),
                dub_provider: dubProvider,
                voice: options.voice || null,
                keep_original: !!options.keepOriginal,
                original_volume: typeof options.originalVolume === 'number'
                    ? options.originalVolume
                    : 0.2,
                keep_separate: options.keepSeparate !== false, // default true
                voice_gender: options.voiceGender || 'auto',
            };

            const res = await fetch(getApiUrl('/api/translate'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // ElevenLabs key only when needed; LLM headers used by
                    // Edge path for transcript translation.
                    ...(elevenLabsKey ? { 'X-ElevenLabs-Key': elevenLabsKey } : {}),
                    ...llmHeaders,
                },
                body: JSON.stringify(requestBody)
            });

            console.log('[Translate] Response status:', res.status);

            if (!res.ok) {
                const errText = await res.text();
                console.error('[Translate] Error response:', errText);
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    if (e.message !== errText) throw e;
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            console.log('[Translate] Success response:', data);
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) {
                    videoRef.current.load();
                }
                setShowTranslateModal(false);
                // Only bump history when the dub REPLACED the original
                // clip in place. When keep_separate=true the dub became
                // a new entry in the gallery, no undo applies on this card.
                if (data.keep_separate === false) {
                    bumpHistory();
                }
            }

        } catch (e) {
            console.error('[Translate] Exception:', e);
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsTranslating(false);
        }
    };

    const handlePost = async () => {
        if (!uploadPostKey || !uploadUserId) {
            setPostResult({ success: false, msg: "Missing API Key or User ID." });
            return;
        }

        const selectedPlatforms = Object.keys(platforms).filter(k => platforms[k]);
        if (selectedPlatforms.length === 0) {
            setPostResult({ success: false, msg: "Select at least one platform." });
            return;
        }

        // --- Auto-connect step ---
        // Check the user's current Upload-Post connections; if any selected
        // platform isn't connected, surface the connect modal first and
        // re-call handlePost() once the user finishes connecting.
        try {
            const userRes = await fetch(getApiUrl('/api/social/user'), {
                headers: { 'X-Upload-Post-Key': uploadPostKey },
            });
            if (userRes.ok) {
                const userData = await userRes.json();
                const myProfile = (userData.profiles || []).find(p => p.username === uploadUserId)
                    || userData.profiles?.[0];
                const connected = (myProfile?.connected) || [];
                const missing = selectedPlatforms.filter(p => !connected.includes(p));
                if (missing.length > 0) {
                    setPendingConnect({ platforms: missing, profile: myProfile?.username });
                    setRetryPostAfterConnect(true);
                    return;
                }
            }
        } catch (e) {
            console.warn('[Connect check] failed; falling through to post', e);
        }

        if (isScheduling && !scheduleDate) {
            setPostResult({ success: false, msg: "Please select a date and time." });
            return;
        }

        setPosting(true);
        setPostResult(null);

        try {
            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: uploadPostKey,
                user_id: uploadUserId,
                platforms: selectedPlatforms,
                title: postTitle,
                description: postDescription
            };

            if (isScheduling && scheduleDate) {
                // Convert to ISO-8601
                payload.scheduled_date = new Date(scheduleDate).toISOString();
                // Optional: pass timezone if needed, backend defaults to UTC or we can send user's timezone
                payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            }

            const res = await fetch(getApiUrl('/api/social/post'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            setPostResult({ success: true, msg: isScheduling ? "Scheduled successfully!" : "Posted successfully!" });
            setTimeout(() => {
                setShowModal(false);
                setPostResult(null);
            }, 3000);

        } catch (e) {
            setPostResult({ success: false, msg: `Failed: ${e.message}` });
        } finally {
            setPosting(false);
        }
    };

    return (
        <div className="bg-surface border border-white/5 rounded-2xl overflow-hidden flex flex-col md:flex-row group hover:border-white/10 transition-all animate-[fadeIn_0.5s_ease-out] min-h-[300px] h-auto" style={{ animationDelay: `${index * 0.1}s` }}>
            {/* Left: Video Preview (Responsive Width) */}
            <div className="w-full md:w-[180px] lg:w-[200px] bg-black relative shrink-0 aspect-[9/16] md:aspect-auto group/video">
                <video
                    ref={videoRef}
                    src={safePlayerSrc(currentVideoUrl)}
                    controls
                    preload="metadata"
                    className="w-full h-full object-cover"
                    playsInline
                    data-clip-player="1"
                    onLoadStart={() => setPlayerError(null)}
                    onPlay={() => {
                        document.querySelectorAll('video[data-clip-player]').forEach((v) => {
                            if (v !== videoRef.current && !v.paused) v.pause();
                        });
                        const currentTime = videoRef.current ? videoRef.current.currentTime : 0;
                        onPlay && onPlay(clip.start + currentTime);
                    }}
                    onPause={() => onPause && onPause()}
                    onLoadedMetadata={(e) => setPlayDuration(e.target.duration || 0)}
                    onTimeUpdate={(e) => setPlayTime(e.target.currentTime || 0)}
                    onEnded={() => {
                        if (videoRef.current) {
                            videoRef.current.currentTime = 0;
                            videoRef.current.play();
                        }
                    }}
                    onError={(e) => {
                        // Translate the cryptic MediaError code into a
                        // human-readable reason. This is the missing
                        // piece that's been making "play doesn't work"
                        // impossible to diagnose remotely.
                        const codes = {
                            1: 'MEDIA_ERR_ABORTED — playback was aborted',
                            2: 'MEDIA_ERR_NETWORK — server returned an error or network died',
                            3: 'MEDIA_ERR_DECODE — file is corrupt or codec unsupported',
                            4: 'MEDIA_ERR_SRC_NOT_SUPPORTED — file not found, MIME type wrong, or CORS blocked',
                        };
                        const err = e?.target?.error;
                        const reason = err ? codes[err.code] || `code ${err.code}` : 'unknown';
                        const url = e?.target?.currentSrc || e?.target?.src || '(no src)';
                        const msg = `${reason}\n${url}`;
                        console.error('[Klipra video error]', msg, err);
                        setPlayerError(msg);
                    }}
                />
                {playerError && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 p-3 text-center">
                        <AlertCircle size={20} className="text-red-400 mb-1.5" />
                        <p className="text-[11px] text-red-300 font-bold mb-1.5">Video failed to load</p>
                        <p className="text-[10px] text-zinc-300 whitespace-pre-wrap break-all max-w-full overflow-auto leading-snug">
                            {playerError}
                        </p>
                    </div>
                )}
                <div className="absolute top-3 left-3 flex gap-2">
                    <span className="bg-black/60 backdrop-blur-md text-white text-[10px] font-bold px-2 py-1 rounded-md border border-white/10 uppercase tracking-wide">
                        Clip {index + 1}
                    </span>
                </div>
                {/* Live time overlay — pointer-events:none so it never
                    interferes with the native controls underneath */}
                <div className="absolute top-3 right-3 pointer-events-none bg-black/60 backdrop-blur-md text-white text-[10px] font-mono tabular-nums px-2 py-1 rounded-md border border-white/10">
                    {formatClipTime(playTime)} / {formatClipTime(playDuration)}
                </div>

                {/* Auto Edit Overlay if Processing */}
                {isEditing && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-10 p-4 text-center">
                        <Loader2 size={32} className="text-primary animate-spin mb-3" />
                        <span className="text-xs font-bold text-white uppercase tracking-wider">AI Magic in Progress...</span>
                        <span className="text-[10px] text-zinc-400 mt-1">Applying viral edits & zooms</span>
                    </div>
                )}
            </div>

            {/* Right: Content & Details */}
            <div className="flex-1 p-4 md:p-5 flex flex-col bg-[#121214] overflow-hidden min-w-0">
                <div className="mb-4">
                    <h3 className="text-base font-bold text-white leading-tight line-clamp-2 mb-2 break-words" title={clip.video_title_for_youtube_short}>
                        {clip.video_title_for_youtube_short || "Viral Clip Generated"}
                    </h3>
                    <div className="flex flex-wrap gap-2 text-[10px] text-zinc-500 font-mono">
                        <span className="bg-white/5 px-1.5 py-0.5 rounded border border-white/5 shrink-0">{Math.floor(clip.end - clip.start)}s</span>
                        <span className="bg-white/5 px-1.5 py-0.5 rounded border border-white/5 shrink-0">#shorts</span>
                        <span className="bg-white/5 px-1.5 py-0.5 rounded border border-white/5 shrink-0">#viral</span>
                    </div>
                </div>

                {/* Scrollable Descriptions Area */}
                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-2 mb-4">
                    {/* YouTube */}
                    <div className="bg-black/20 rounded-lg p-3 border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-red-400 mb-1.5 uppercase tracking-wider">
                            <Youtube size={12} className="shrink-0" /> <span className="truncate">YouTube Title</span>
                        </div>
                        <p className="text-xs text-zinc-300 select-all break-words">
                            {clip.video_title_for_youtube_short || "Viral Short Video"}
                        </p>
                    </div>

                    {/* TikTok / IG */}
                    <div className="bg-black/20 rounded-lg p-3 border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-400 mb-1.5 uppercase tracking-wider">
                            <Video size={12} className="text-cyan-400 shrink-0" />
                            <span className="text-zinc-500">/</span>
                            <Instagram size={12} className="text-pink-400 shrink-0" />
                            <span className="truncate">Caption</span>
                        </div>
                        <p className="text-xs text-zinc-300 line-clamp-3 hover:line-clamp-none transition-all cursor-pointer select-all break-words">
                            {clip.video_description_for_tiktok || clip.video_description_for_instagram}
                        </p>
                    </div>
                </div>

                {/* Error Message */}
                {editError && (
                    <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] rounded-lg flex items-center gap-2">
                        <AlertCircle size={12} className="shrink-0" />
                        {editError}
                    </div>
                )}

                {/* Actions Footer */}
                {/* Reframe-invalidated banner — set by retrim if the
                    user had a custom keyframed reframe that the new
                    timing breaks. */}
                {reframeInvalidated && (
                    <div className="mt-3 mb-1 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] leading-relaxed">
                        <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                        <div className="flex-1 text-amber-100/90">
                            Clip timing changed — your previous keyframed reframe no longer applies. Re-open Reframe to set new keyframes.
                        </div>
                        <button
                            onClick={() => setShowReframe(true)}
                            className="text-amber-300 hover:text-white text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded hover:bg-white/5"
                        >
                            Re-set
                        </button>
                    </div>
                )}

                {/* Undo bar — visible whenever there's at least one
                    operation in this clip's history stack. Reverts the
                    most recent edit (auto-edit / hook / subtitle / dub /
                    retrim / reframe) to the previous saved state. */}
                {historyDepth > 0 && (
                    <div className="mt-3 flex items-center justify-between rounded-lg border border-white/5 bg-black/30 px-3 py-2 text-[11px]">
                        <span className="text-zinc-400">
                            {historyDepth} change{historyDepth === 1 ? '' : 's'} on this clip
                        </span>
                        <button
                            onClick={handleUndo}
                            disabled={isUndoing}
                            className="flex items-center gap-1.5 text-zinc-200 hover:text-white px-2 py-1 rounded hover:bg-white/5 disabled:opacity-50"
                            title="Undo the most recent edit"
                        >
                            {isUndoing ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                            {isUndoing ? 'Reverting…' : 'Undo last'}
                        </button>
                    </div>
                )}

                <div className="grid grid-cols-2 gap-3 mt-auto pt-4 border-t border-white/5">
                    {/* Manual region/effect editor — replaces the old
                        Auto Edit "AI does the whole thing" button. The
                        user picks regions + effects explicitly so the
                        result is predictable. */}
                    <button
                        onClick={() => setShowEditModal(true)}
                        disabled={isEditing}
                        className="col-span-1 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-purple-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                    >
                        {isEditing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                        {isEditing ? 'Editing…' : 'Edit'}
                    </button>

                    {/* Trim / extend in-out points — re-cuts from source.
                        Pink/rose because trimming feels surgical, like a
                        scalpel — visually distinct from the AI-magic
                        purple of Auto Edit and the camera-cyan of Reframe. */}
                    <button
                        onClick={() => setShowRetrim(true)}
                        disabled={isEditing}
                        className="col-span-1 py-2 bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-rose-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                        title="Adjust the clip's start / end without redoing the whole job"
                    >
                        <Scissors size={14} /> Edit timing
                    </button>

                    {/* Reframe — keyframed pan from face to screen, etc.
                        Cyan/sky to evoke camera lens / aperture motion. */}
                    <button
                        onClick={() => setShowReframe(true)}
                        disabled={isEditing}
                        className="col-span-2 py-2 bg-gradient-to-r from-sky-500 to-cyan-600 hover:from-sky-400 hover:to-cyan-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-cyan-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                        title="Pan the 9:16 crop window over time — face → screen → face, etc."
                    >
                        <MoveHorizontal size={14} /> Reframe (pan focus)
                    </button>

                    {/* AI Magic — motion graphics + SFX. Violet to
                        match the Smart Clipper accent. */}
                    <button
                        onClick={() => setShowMotionGraphics(true)}
                        disabled={isEditing}
                        className="col-span-2 py-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-violet-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                        title="AI proposes motion-graphic overlays + sound effects, then bakes them into the clip."
                    >
                        <Sparkles size={14} /> AI Magic Overlays + SFX
                    </button>

                    {/* Aspect chips — quick re-render at chosen ratio.
                        The Reframe button above does the deeper face-
                        tracked crop; this is the lightweight preset. */}
                    <div className="col-span-2 flex items-center gap-2 mb-1">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold shrink-0">Dimension</span>
                        {[
                            ['9:16', 'Vertical'],
                            ['16:9', 'Horizontal'],
                            ['1:1', 'Square'],
                        ].map(([target, label]) => {
                            const active = currentAspect === target;
                            const busy = aspectChanging === target;
                            return (
                                <button
                                    key={target}
                                    onClick={() => changeAspect(target)}
                                    disabled={!!aspectChanging}
                                    className={
                                        'flex-1 py-1.5 text-[11px] font-bold rounded-md transition '
                                        + (active
                                            ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                                            : 'bg-black/30 text-zinc-300 border border-white/10 hover:border-white/20 disabled:opacity-50')
                                    }
                                    title={`Re-render this clip at ${target} (${label.toLowerCase()})`}
                                >
                                    {busy ? (
                                        <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> {target}</span>
                                    ) : (
                                        <span>{target} · {label}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    {aspectError && (
                        <div className="col-span-2 text-[10px] text-red-300 mb-1">{aspectError}</div>
                    )}

                    <button
                        onClick={() => setShowSubtitleModal(true)}
                        disabled={isSubtitling}
                        className="col-span-1 py-2 bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-500 hover:to-orange-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-orange-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                    >
                        {isSubtitling ? <Loader2 size={14} className="animate-spin" /> : <Type size={14} />}
                        {isSubtitling ? 'Adding...' : 'Subtitles'}
                    </button>

                    <button
                        onClick={() => setShowHookModal(true)}
                        disabled={isHooking}
                        className="col-span-1 py-2 bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-300 hover:to-yellow-400 text-black rounded-lg text-xs font-bold shadow-lg shadow-yellow-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                    >
                        {isHooking ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                        {isHooking ? 'Adding...' : 'Viral Hook'}
                    </button>

                    <button
                        onClick={() => setShowTranslateModal(true)}
                        disabled={isTranslating}
                        className="col-span-1 py-2 bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-fuchsia-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-1 truncate px-1"
                    >
                        {isTranslating ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />}
                        {isTranslating ? 'Translating...' : 'Dub Voice'}
                    </button>

                    {/* The "Post" button used to live here, wired up to
                        upload-post.com so users could schedule directly
                        to TikTok / Instagram / YouTube via that
                        third-party service. Removed at the operator's
                        request — they prefer users download the clip
                        and upload natively to each platform until we
                        can offer first-party YouTube / TikTok /
                        Facebook OAuth uploads (a v2 piece of work).
                        See the Post Modal further down — kept in code
                        for a possible future revival but unmounted by
                        the absence of this trigger. */}
                    <button
                        onClick={async (e) => {
                            e.preventDefault();
                            try {
                                const response = await fetch(currentVideoUrl);
                                if (!response.ok) throw new Error('Download failed');
                                const blob = await response.blob();
                                const url = window.URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.style.display = 'none';
                                a.href = url;
                                a.download = `clip-${index + 1}.mp4`;
                                document.body.appendChild(a);
                                a.click();
                                window.URL.revokeObjectURL(url);
                                document.body.removeChild(a);
                            } catch (err) {
                                console.error('Download error:', err);
                                window.open(currentVideoUrl, '_blank');
                            }
                        }}
                        className="col-span-1 py-2 bg-gradient-to-r from-emerald-500 to-lime-600 hover:from-emerald-400 hover:to-lime-500 text-white rounded-lg text-xs font-bold shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 truncate px-2"
                    >
                        <Download size={14} className="shrink-0" /> Download
                    </button>
                </div>
            </div>

            {/* Post Modal */}
            {showModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
                    <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                        <button
                            onClick={() => setShowModal(false)}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-white"
                        >
                            <X size={20} />
                        </button>

                        <h3 className="text-lg font-bold text-white mb-4">Post / Schedule</h3>

                        {!uploadPostKey && (
                            <div className="mb-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg space-y-3">
                                <div className="flex items-start gap-2 text-yellow-200 text-xs">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                    <div>
                                        <div className="font-bold mb-0.5">Connect TikTok / Instagram / YouTube</div>
                                        <div className="text-yellow-200/70">
                                            Posting to social platforms goes through Upload-Post — a free service that handles auth + scheduling.
                                        </div>
                                    </div>
                                </div>
                                <ol className="text-xs text-yellow-200/90 space-y-1.5 pl-1 list-decimal list-inside">
                                    <li>
                                        <a
                                            href="https://app.upload-post.com/login"
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-yellow-300 underline hover:text-yellow-100"
                                        >
                                            Sign up for Upload-Post (free, 10 posts/mo)
                                        </a>
                                    </li>
                                    <li>
                                        <a
                                            href="https://app.upload-post.com/manage-users"
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-yellow-300 underline hover:text-yellow-100"
                                        >
                                            Connect your TikTok / IG / YT accounts
                                        </a>
                                    </li>
                                    <li>
                                        <a
                                            href="https://app.upload-post.com/api-keys"
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-yellow-300 underline hover:text-yellow-100"
                                        >
                                            Copy your API key
                                        </a>
                                        {' '}— paste it into <strong>Settings</strong> in this dashboard.
                                    </li>
                                </ol>
                                <p className="text-[11px] text-yellow-200/60">
                                    Total setup: ~3 minutes. Once you connect once, posting is one-click going forward.
                                </p>
                            </div>
                        )}

                        <div className="space-y-4 mb-6">
                            {/* Title & Description */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Video Title</label>
                                <input
                                    type="text"
                                    value={postTitle}
                                    onChange={(e) => setPostTitle(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder-zinc-600"
                                    placeholder="Enter a catchy title..."
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Caption / Description</label>
                                <textarea
                                    value={postDescription}
                                    onChange={(e) => setPostDescription(e.target.value)}
                                    rows={4}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder-zinc-600 resize-none"
                                    placeholder="Write a caption for your post..."
                                />
                            </div>

                            {/* Scheduling */}
                            <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-sm text-white font-medium">
                                        <Calendar size={16} className="text-purple-400" /> Schedule Post
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" checked={isScheduling} onChange={(e) => setIsScheduling(e.target.checked)} className="sr-only peer" />
                                        <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                                    </label>
                                </div>

                                {isScheduling && (
                                    <div className="mt-3 animate-[fadeIn_0.2s_ease-out]">
                                        <label className="block text-xs text-zinc-400 mb-1">Select Date & Time</label>
                                        <div className="relative">
                                            <input
                                                type="datetime-local"
                                                value={scheduleDate}
                                                onChange={(e) => setScheduleDate(e.target.value)}
                                                className="w-full bg-black/40 border border-white/10 rounded-lg p-2 pl-9 text-sm text-white focus:outline-none focus:border-purple-500/50 [color-scheme:dark]"
                                            />
                                            <Clock size={14} className="absolute left-3 top-2.5 text-zinc-500" />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Platforms */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-2">Select Platforms</label>
                                <div className="grid grid-cols-1 gap-2">
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.tiktok} onChange={e => setPlatforms({ ...platforms, tiktok: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Video size={16} className="text-cyan-400" /> TikTok</div>
                                    </label>
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.instagram} onChange={e => setPlatforms({ ...platforms, instagram: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Instagram size={16} className="text-pink-400" /> Instagram</div>
                                    </label>
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.youtube} onChange={e => setPlatforms({ ...platforms, youtube: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Youtube size={16} className="text-red-400" /> YouTube Shorts</div>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {postResult && (
                            <div className={`mb-4 p-3 rounded-lg text-xs flex items-start gap-2 ${postResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                {postResult.success ? <CheckCircle size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                                <div>{postResult.msg}</div>
                            </div>
                        )}

                        <button
                            onClick={handlePost}
                            disabled={posting || !uploadPostKey}
                            className="w-full py-3 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-bold transition-all flex items-center justify-center gap-2"
                        >
                            {posting ? <><Loader2 size={16} className="animate-spin" /> {isScheduling ? 'Scheduling...' : 'Publishing...'}</> : <><Share2 size={16} /> {isScheduling ? 'Schedule Post' : 'Publish Now'}</>}
                        </button>
                    </div>
                </div>
            )}

            <EditModal
                isOpen={showEditModal}
                onClose={() => setShowEditModal(false)}
                videoUrl={safePlayerSrc(currentVideoUrl)}
                jobId={jobId}
                clipIndex={index}
                inputFilename={currentVideoUrl.split('?')[0].split('/').pop()}
                durationSec={clipDuration}
                onApplied={(newUrl) => {
                    setCurrentVideoUrl(getApiUrl(newUrl));
                    if (videoRef.current) videoRef.current.load();
                    bumpHistory();
                }}
            />

            <SubtitleModal
                isOpen={showSubtitleModal}
                onClose={() => setShowSubtitleModal(false)}
                onGenerate={handleSubtitle}
                isProcessing={isSubtitling}
                videoUrl={safePlayerSrc(currentVideoUrl)}
                jobId={jobId}
                clipIndex={index}
                existingHook={activeLayers.hook}
                currentVideoFilename={currentVideoUrl.split('?')[0].split('/').pop()}
                llmHeaders={llmHeaders}
                // When the user just retrimmed this clip, the backend
                // sets subtitles_invalidated_at on the clip record so
                // the modal can show the "Regenerate first" banner
                // instead of silently burning stale captions.
                subtitlesInvalidatedAt={liveClip?.subtitles_invalidated_at || null}
            />

            <HookModal
                isOpen={showHookModal}
                onClose={() => setShowHookModal(false)}
                onGenerate={handleHook}
                isProcessing={isHooking}
                videoUrl={safePlayerSrc(currentVideoUrl)}
                initialText={clip.viral_hook_text}
                durationInSeconds={liveClip.end && liveClip.start ? liveClip.end - liveClip.start : 30}
                existingSubtitles={activeLayers.subtitles}
            />

            <TranslateModal
                isOpen={showTranslateModal}
                onClose={() => setShowTranslateModal(false)}
                onTranslate={handleTranslate}
                isProcessing={isTranslating}
                videoUrl={safePlayerSrc(currentVideoUrl)}
                hasApiKey={!!elevenLabsKey}
            />

            {showRetrim && (
                <RetrimModal
                    clip={liveClip}
                    index={index}
                    jobId={jobId}
                    onClose={() => setShowRetrim(false)}
                    onSaved={(updated) => {
                        setLiveClip(updated);
                        setCurrentVideoUrl(getApiUrl(updated.video_url));
                        if (videoRef.current) videoRef.current.load();
                        setShowRetrim(false);
                        bumpHistory();
                        // Backend tells us when retrim invalidated a previous reframe.
                        if (updated.reframe_invalidated_at) {
                            setReframeInvalidated(true);
                        }
                    }}
                />
            )}

            {showReframe && (
                <ReframeKeyframeModal
                    clip={liveClip}
                    index={index}
                    jobId={jobId}
                    sourceUrl={getApiUrl(`/api/job/${jobId}/source-video`)}
                    onClose={() => setShowReframe(false)}
                    onSaved={(updated) => {
                        setLiveClip(updated);
                        setCurrentVideoUrl(getApiUrl(updated.video_url));
                        if (videoRef.current) videoRef.current.load();
                        setShowReframe(false);
                        bumpHistory();
                        // Reframe re-set — clear the invalidation banner.
                        setReframeInvalidated(false);
                    }}
                />
            )}

            {pendingConnect && (
                <SocialConnectModal
                    pendingPlatforms={pendingConnect.platforms}
                    profile={pendingConnect.profile}
                    uploadPostKey={uploadPostKey}
                    onClose={() => {
                        setPendingConnect(null);
                        setRetryPostAfterConnect(false);
                    }}
                    onAllConnected={() => {
                        setPendingConnect(null);
                        if (retryPostAfterConnect) {
                            setRetryPostAfterConnect(false);
                            // Wait one tick so React unmounts the modal cleanly,
                            // then retry the post with everything connected.
                            setTimeout(() => handlePost(), 200);
                        }
                    }}
                />
            )}

            {/* AI Motion Graphics + SFX modal — proposes overlay
                events and bakes them into the clip when the user
                clicks Apply. Re-uses the standard llmHeaders so it
                respects whatever provider/key the user picked in
                Settings. */}
            <MotionGraphicsModal
                open={showMotionGraphics}
                onClose={() => setShowMotionGraphics(false)}
                jobId={jobId}
                clipIndex={index}
                clipDuration={(clip.end || 0) - (clip.start || 0)}
                aspect={currentAspect || '9:16'}
                llmHeaders={llmHeaders}
                onApplied={(data) => {
                    if (data && data.clip_url) {
                        // Same pattern Subtitle/Dub/Edit/Reframe modals use:
                        // update the React state for the player AND force a
                        // <video>.load() so the new mp4 actually starts
                        // playing. Cache-bust the URL so the browser doesn't
                        // serve the stale original from its cache (the new
                        // file lives at a different path with a _mg<ts>
                        // suffix, but cache-busting is cheap insurance).
                        const fresh = data.clip_url + (data.clip_url.includes('?') ? '&' : '?') + 'v=' + Date.now();
                        clip.video_url = fresh;
                        setCurrentVideoUrl(getApiUrl(fresh));
                        if (videoRef.current) videoRef.current.load();
                    }
                }}
            />

        </div>
    );
}

// Render seconds as M:SS.Ff so the user can pick exact frame boundaries
// when retrimming. Default to 30 fps (matches OpenShorts' render fps).
const PLAYER_FPS = 30;
function formatClipTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00f';
    const m = Math.floor(seconds / 60);
    const restSec = Math.floor(seconds - m * 60);
    const frames = Math.round((seconds - Math.floor(seconds)) * PLAYER_FPS);
    return `${m}:${String(restSec).padStart(2, '0')}.${String(frames).padStart(2, '0')}f`;
}
