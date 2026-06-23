import React, { useState, useEffect } from 'react';
import { Upload, FileVideo, Sparkles, Youtube, Instagram, Share2, LogOut, ChevronDown, Check, Activity, LayoutDashboard, Settings, PlusCircle, History, Menu, X, Terminal, Shield, LayoutGrid, Image, Globe, RotateCcw, Calendar, Trash2, Tag, Info, Type, Languages, Brain, Film, UserCircle2, Wand2, Mic } from 'lucide-react';
import KeyInput from './components/KeyInput';
import ProviderPicker from './components/ProviderPicker';
import MediaInput from './components/MediaInput';
import TranscriptReviewPanel from './components/TranscriptReviewPanel';
import ResultCard from './components/ResultCard';
import PastProjects from './components/PastProjects';
import Pricing from './components/Pricing';
import About from './components/About';
import StandaloneDub from './components/StandaloneDub';
import StandaloneSubtitle from './components/StandaloneSubtitle';
import StandaloneAudioClean from './components/StandaloneAudioClean';
import StandaloneYouTubeSEO from './components/StandaloneYouTubeSEO';
import SmartClipper from './components/SmartClipper';
import HorizontalToVertical from './components/HorizontalToVertical';
import AIAvatar from './components/AIAvatar';
import KlipraLogo from './components/KlipraLogo';
import ProcessingAnimation from './components/ProcessingAnimation';
import AuthModal from './components/AuthModal';
import InfluencerApplyModal from './components/InfluencerApplyModal';
import Home from './components/Home';
import { installSinglePlayerCoordinator, pauseAllVideos } from './lib/playerRegistry';
// import Gallery from './components/Gallery';
import ThumbnailStudio from './components/ThumbnailStudio';
import SaaShortsTab from './components/SaaShortsTab';
import UGCGallery from './components/UGCGallery';
import ScheduleWeekModal from './components/ScheduleWeekModal';
import { getApiUrl } from './config';

// Enhanced "Encryption" using XOR + Base64 with a Salt
// This is better than plain Base64 but still client-side.
const SECRET_KEY = import.meta.env.VITE_ENCRYPTION_KEY || "OpenShorts-Static-Salt-Change-Me";
const ENCRYPTION_PREFIX = "ENC:";

const encrypt = (text) => {
  if (!text) return '';
  try {
    const xor = text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
    ).join('');
    return ENCRYPTION_PREFIX + btoa(xor);
  } catch (e) {
    console.error("Encryption failed", e);
    return text;
  }
};

const decrypt = (text) => {
  if (!text) return '';
  if (text.startsWith(ENCRYPTION_PREFIX)) {
    try {
      const raw = text.slice(ENCRYPTION_PREFIX.length);
      // Check if it's plain base64 or our custom XOR (simple try)
      const xor = atob(raw);
      const result = xor.split('').map((c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
      ).join('');
      return result;
    } catch (e) {
      // Fallback if decryption fails (might be old plain text)
      return '';
    }
  }
  // Backward compatibility: If no prefix, assume old plain text (or return empty if you want to force re-login)
  // For migration: Return text as is, so it populates the field, and next save will encrypt it.
  return text;
};

// Simple TikTok icon sine Lucide might not have it or it varies
const TikTokIcon = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z" />
  </svg>
);

const UserProfileSelector = ({ profiles, selectedUserId, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!profiles || profiles.length === 0) return null;

  const selectedProfile = profiles.find(p => p.username === selectedUserId) || profiles[0];

  return (
    <div className="relative z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between bg-surface border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-white/5 transition-colors min-w-[180px]"
      >
        <span className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
            {selectedProfile?.username?.substring(0, 1).toUpperCase() || "U"}
          </div>
          <span className="font-medium text-white truncate max-w-[100px]">{selectedProfile?.username || "Select User"}</span>
        </span>
        <ChevronDown size={14} className={`text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full mt-2 right-0 w-64 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          <div className="max-h-60 overflow-y-auto custom-scrollbar">
            {profiles.map((profile) => (
              <button
                key={profile.username}
                onClick={() => {
                  onSelect(profile.username);
                  setIsOpen(false);
                }}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left group border-b border-white/5 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-purple-500/20 flex items-center justify-center text-xs font-bold text-white border border-white/10 shrink-0">
                    {profile.username.substring(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate">
                      {profile.username}
                    </div>
                    <div className="flex gap-2 mt-0.5">
                      {/* Status indicators */}
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('tiktok') ? 'text-zinc-300' : 'text-zinc-600'}`}>
                        <TikTokIcon size={10} />
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('instagram') ? 'text-pink-400' : 'text-zinc-600'}`}>
                        <Instagram size={10} />
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('youtube') ? 'text-red-400' : 'text-zinc-600'}`}>
                        <Youtube size={10} />
                      </div>
                    </div>
                  </div>
                </div>
                {selectedUserId === profile.username && <Check size={14} className="text-primary shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const SESSION_KEY = 'openshorts_session';
const SESSION_MAX_AGE = 3600000; // 1 hour (matches server job retention)

// Mock polling function
const pollJob = async (jobId) => {
  const res = await fetch(getApiUrl(`/api/status/${jobId}`));
  if (!res.ok) {
    // Carry the HTTP status so the poller can tell "job is gone" (404 —
    // the backend keeps jobs in memory, so a restart wipes them) apart
    // from a transient network blip it should ride out.
    const err = new Error('Status check failed');
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
};

function App() {
  // LLM provider config (set by KeyInput). The legacy `apiKey` local
  // ergonomically maps to `llmConfig.api_key` so the dozens of existing
  // usages don't need rewiring.
  const [llmConfig, setLlmConfig] = useState({
    provider: 'gemini-subscription',
    model: 'gemini-3-flash-plus',
    api_key: localStorage.getItem('gemini_key') || '',
  });
  // Backwards-compatible alias used everywhere else in this component.
  const apiKey = llmConfig.api_key;
  // Setter that accepts EITHER a plain string (legacy) or a config object
  // from the new picker.
  const setApiKey = (next) => {
    if (typeof next === 'string') {
      setLlmConfig((c) => ({ ...c, api_key: next }));
    } else if (next && typeof next === 'object') {
      setLlmConfig((c) => ({ ...c, ...next }));
    }
  };
  // Social API State - Load encrypted or plain
  const [uploadPostKey, setUploadPostKey] = useState(() => {
    const stored = localStorage.getItem('uploadPostKey_v3');
    if (stored) return decrypt(stored);
    return '';
  });
  // ElevenLabs API State - Load encrypted
  const [elevenLabsKey, setElevenLabsKey] = useState(() => {
    const stored = localStorage.getItem('elevenLabsKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });

  // fal.ai API State - Load encrypted
  const [falKey, setFalKey] = useState(() => {
    const stored = localStorage.getItem('falKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });

  const [uploadUserId, setUploadUserId] = useState(() => localStorage.getItem('uploadUserId') || '');
  const [userProfiles, setUserProfiles] = useState([]); // List of {username, connected: []}
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, awaiting_cleanup, complete, error
  const [results, setResults] = useState(null);
  // Raw transcript captured when a job pauses for manual cleanup (HITL).
  const [rawTranscript, setRawTranscript] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsVisible, setLogsVisible] = useState(true);
  const [processingMedia, setProcessingMedia] = useState(null);
  // Default landing tab inside the app is now 'home' — the in-app
  // homepage with feature explainers + demos pulled from past projects.
  // Clicking a product tab (Generate Viral Clips / Subtitle / Dub) or
  // resuming an active job will set this to whichever workspace they
  // need.
  const [activeTab, setActiveTab] = useState('home');

  const [sessionRecovered, setSessionRecovered] = useState(false);
  const [showScheduleWeek, setShowScheduleWeek] = useState(false);

  // True when the currently-open job was loaded from the Past Projects
  // panel (vs. freshly generated this session). Lets the split-view
  // header surface a "Back to past projects" button so users always
  // have a one-click route back to the list.
  const [openedFromPast, setOpenedFromPast] = useState(false);

  // Bump-key per product. When the user clicks the SAME product tab
  // they're already on (or clicks the logo while on a product), we
  // increment the counter for that tab. Each product page has a
  // useEffect that watches its bump key and resets internal state to
  // its idle/home view when the key changes — so re-clicking the
  // header always returns the user to "Add a video" instead of
  // leaving them stranded inside a past project. The counter approach
  // is preferred over remounting (via key prop) because it preserves
  // children's component identity for things that aren't supposed to
  // reset (e.g. sticky LLM provider selection).
  const [tabHomeBump, setTabHomeBump] = useState({
    dashboard: 0,
    subtitle: 0,
    dub: 0,
    audioclean: 0,
    youtubeseo: 0,
  });
  const goHomeOfTab = (id) => {
    setActiveTab(id);
    setTabHomeBump((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
    // Clip-generator state lives in App, so we reset it here directly.
    if (id === 'dashboard') {
      setStatus('idle');
      setJobId(null);
      setResults(null);
      setLogs([]);
      setProcessingMedia(null);
      setOpenedFromPast(false);
    }
  };

  // ---- Auth state ----
  // currentUser is null while loading and after sign-out. Token persists
  // across reloads via localStorage so refreshing the page doesn't sign
  // the user back out.
  const [currentUser, setCurrentUser] = useState(null);
  const [authToken, setAuthToken] = useState(() => {
    try { return localStorage.getItem('klipra_auth_token') || null; } catch { return null; }
  });
  const [authModalTab, setAuthModalTab] = useState(null); // null | 'signin' | 'signup'
  const [showInfluencer, setShowInfluencer] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // OAuth redirect handler. The backend bounces the browser back to
  // the SPA with the new session token in the URL fragment
  // (#oauth_token=…) — fragments aren't sent to the server, so the
  // token never lands in access logs. Pluck it out, persist it, clear
  // the hash. Errors get surfaced via #oauth_error= the same way.
  useEffect(() => {
    const hash = window.location.hash || '';
    const consume = (key) => {
      const m = hash.match(new RegExp(`[#&]${key}=([^&]+)`));
      return m ? decodeURIComponent(m[1]) : null;
    };
    const oauthToken = consume('oauth_token');
    const oauthErr = consume('oauth_error');
    if (oauthToken) {
      try { localStorage.setItem('klipra_auth_token', oauthToken); } catch {}
      setAuthToken(oauthToken);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else if (oauthErr) {
      const friendly = {
        not_configured: "That sign-in option isn't configured yet.",
        invalid_state:  'Sign-in expired or was tampered with. Please try again.',
        no_email:       "We couldn't get an email from that account. Make sure your primary email is verified and not hidden.",
        access_denied:  'Sign-in was cancelled.',
      }[oauthErr] || `Sign-in failed: ${oauthErr}`;
      // Use a tiny delay so the alert isn't blocked by browsers that
      // dislike alerts during the load handler.
      setTimeout(() => alert(friendly), 50);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  // Restore current user from token on mount.
  useEffect(() => {
    if (!authToken) { setCurrentUser(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(getApiUrl('/api/auth/me'), {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok) throw new Error('Unauthorized');
        const data = await r.json();
        if (!cancelled) setCurrentUser(data.user);
      } catch {
        if (!cancelled) {
          // Token expired or DB cleared — clear it.
          try { localStorage.removeItem('klipra_auth_token'); } catch {}
          setAuthToken(null);
          setCurrentUser(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [authToken]);

  const handleAuthSuccess = ({ user, token }) => {
    try { localStorage.setItem('klipra_auth_token', token); } catch {}
    setAuthToken(token);
    setCurrentUser(user);
    setAuthModalTab(null);
  };

  const signOut = async () => {
    try {
      await fetch(getApiUrl('/api/auth/signout'), {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
    } catch { /* swallow */ }
    try { localStorage.removeItem('klipra_auth_token'); } catch {}
    setAuthToken(null);
    setCurrentUser(null);
    setUserMenuOpen(false);
  };

  // Sync state for original video playback
  const [syncedTime, setSyncedTime] = useState(0);
  const [isSyncedPlaying, setIsSyncedPlaying] = useState(false);
  const [syncTrigger, setSyncTrigger] = useState(0);

  const handleClipPlay = (startTime) => {
    setSyncedTime(startTime);
    setIsSyncedPlaying(true);
    setSyncTrigger(prev => prev + 1);
  };

  const handleClipPause = () => {
    setIsSyncedPlaying(false);
  };

  // Single-active-player coordinator. Installed once at boot — listens
  // globally for <video> 'play' events and pauses any other video that's
  // currently playing. Stops the "two clips playing at once" bug when
  // a modal preview opens while a result-grid clip is mid-play.
  useEffect(() => { installSinglePlayerCoordinator(); }, []);

  // Global fullscreen fix.
  //
  // Even though index.css has `:fullscreen video { object-fit: contain }`,
  // browsers (especially Safari and Chrome on macOS) sometimes ignore
  // CSS during native HTML5 video fullscreen — the `<video controls>`
  // element enters its own presentation mode that doesn't apply our
  // stylesheet. The user saw this: vertical 9:16 clips fullscreened
  // from result cards came out cropped to the middle band.
  //
  // This JS handler is the bulletproof fallback. On any
  // fullscreenchange event we:
  //   1. Find the actually-fullscreen element.
  //   2. If it's a <video>, force `object-fit: contain` inline (beats
  //      every Tailwind class, every stylesheet rule, every native
  //      override). Same for any <video> descendant if a container
  //      went fullscreen instead.
  //   3. Save the original `style.objectFit` value so we can restore
  //      it when fullscreen exits — preserves the card's `object-cover`
  //      look for the inline preview.
  useEffect(() => {
    const tracked = new WeakMap(); // video → previous inline style.objectFit
    const apply = () => {
      const fs =
        document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || document.msFullscreenElement;
      // Collect <video> elements affected by the fullscreen state.
      const videos = new Set();
      if (fs) {
        if (fs.tagName === 'VIDEO') {
          videos.add(fs);
        } else {
          fs.querySelectorAll('video').forEach(v => videos.add(v));
        }
        videos.forEach(v => {
          if (!tracked.has(v)) {
            tracked.set(v, v.style.objectFit || '');
          }
          v.style.objectFit = 'contain';
          v.style.background = '#000';
        });
      } else {
        // Restore — fullscreen just exited. Walk every tracked video
        // and put back whatever was there originally (usually empty
        // string, which lets the className's object-cover take over
        // again for the inline card view).
        document.querySelectorAll('video').forEach(v => {
          if (tracked.has(v)) {
            v.style.objectFit = tracked.get(v);
            v.style.background = '';
            tracked.delete(v);
          }
        });
      }
    };
    document.addEventListener('fullscreenchange', apply);
    document.addEventListener('webkitfullscreenchange', apply);
    document.addEventListener('mozfullscreenchange', apply);
    document.addEventListener('MSFullscreenChange', apply);
    return () => {
      document.removeEventListener('fullscreenchange', apply);
      document.removeEventListener('webkitfullscreenchange', apply);
      document.removeEventListener('mozfullscreenchange', apply);
      document.removeEventListener('MSFullscreenChange', apply);
    };
  }, []);

  // When the user navigates between tabs, pause everything. Without this,
  // a clip playing on the dashboard keeps playing in the background after
  // they switch to Past Projects / Pricing / About.
  useEffect(() => { pauseAllVideos(); }, [activeTab]);

  // Session Recovery: Restore on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const session = JSON.parse(saved);
      if (Date.now() - session.timestamp > SESSION_MAX_AGE) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      if (session.jobId && session.status && session.status !== 'idle') {
        setJobId(session.jobId);
        setResults(session.results || null);
        if (session.processingMedia) setProcessingMedia(session.processingMedia);
        if (session.activeTab) setActiveTab(session.activeTab);
        // If was processing, resume polling; if complete/error, just show results
        setStatus(session.status === 'processing' ? 'processing' : session.status);
        setSessionRecovered(true);
        setTimeout(() => setSessionRecovered(false), 5000);
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  // Session Recovery: Save state changes
  useEffect(() => {
    if (status === 'idle') {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    try {
      const sessionData = {
        jobId,
        status,
        results,
        processingMedia: processingMedia?.type === 'url' ? processingMedia : null,
        activeTab,
        timestamp: Date.now()
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    } catch (e) {
      // localStorage full or serialization error - ignore
    }
  }, [jobId, status, results, activeTab]);

  // Mirror the current key to the legacy `gemini_key` slot ONLY when the
  // active provider is Gemini. KeyInput stores per-provider keys under
  // its own `os_llm_key_*` namespace; this line keeps backward-compat
  // for any code still reading the old key directly.
  useEffect(() => {
    if (apiKey && llmConfig.provider === 'gemini') {
      localStorage.setItem('gemini_key', apiKey);
    }
  }, [apiKey, llmConfig.provider]);

  useEffect(() => {
    if (uploadPostKey) {
      localStorage.setItem('uploadPostKey_v3', encrypt(uploadPostKey));
    }
    if (uploadUserId) {
      localStorage.setItem('uploadUserId', uploadUserId);
    }
  }, [uploadPostKey, uploadUserId]);

  useEffect(() => {
    if (elevenLabsKey) {
      localStorage.setItem('elevenLabsKey_v1', encrypt(elevenLabsKey));
    }
  }, [elevenLabsKey]);

  useEffect(() => {
    if (falKey) {
      localStorage.setItem('falKey_v1', encrypt(falKey));
    }
  }, [falKey]);

  useEffect(() => {
    if (uploadPostKey && userProfiles.length === 0) {
      fetchUserProfiles();
    }
  }, [uploadPostKey]);

  useEffect(() => {
    let interval;
    if ((status === 'processing' || status === 'completed') && jobId) {
      interval = setInterval(async () => {
        try {
          const data = await pollJob(jobId);
          console.log("Job status:", data);

          // Update results if available (real-time)
          if (data.result) {
            setResults(data.result);
          }

          if (data.status === 'completed') {
            setStatus('complete');
            clearInterval(interval);
          } else if (data.status === 'failed') {
            setStatus('error');
            const errorMsg = data.error || (data.logs && data.logs.length > 0 ? data.logs[data.logs.length - 1] : "Process failed");
            setLogs(prev => [...prev, "Error: " + errorMsg]);
            clearInterval(interval);
          } else if (data.status === 'awaiting_cleanup') {
            // Human-in-the-loop pause: transcription done, stop polling and
            // load the raw transcript for the review/cleanup panel.
            if (data.logs) setLogs(data.logs);
            clearInterval(interval);
            try {
              const r = await fetch(getApiUrl(`/api/job/${jobId}/transcript`));
              if (r.ok) setRawTranscript(await r.json());
            } catch (_) { /* panel will show a retry */ }
            setStatus('awaiting_cleanup');
          } else {
            // Update logs if available
            if (data.logs) setLogs(data.logs);
          }
        } catch (e) {
          if (e.httpStatus === 404) {
            // The job no longer exists server-side (jobs live in memory,
            // so a backend restart wipes them). Without this branch the
            // poller retried a dead job id every 2s forever and the UI
            // stayed frozen on the processing spinner with no way out.
            clearInterval(interval);
            try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
            setStatus('error');
            setLogs(prev => [...prev,
              "Error: This job no longer exists on the server — the backend was restarted while it was running. Click New to start over."]);
            return;
          }
          console.error("Polling error", e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [status, jobId]);

  // Fetch the paused transcript whenever we're in awaiting_cleanup without it.
  // The polling effect above only runs for processing/completed, so a session
  // RESTORED directly into awaiting_cleanup (e.g. after a page reload) would
  // otherwise render the review panel forever stuck on "Loading transcript…"
  // because nothing ever fetched it. If the job is gone server-side (404 —
  // backend restarted), surface a clear recovery message instead of spinning.
  useEffect(() => {
    if (status !== 'awaiting_cleanup' || !jobId || rawTranscript) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(getApiUrl(`/api/job/${jobId}/transcript`));
        if (!alive) return;
        if (r.ok) {
          setRawTranscript(await r.json());
        } else if (r.status === 404) {
          try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
          setStatus('error');
          setLogs(prev => [...prev,
            "Error: This paused job no longer exists on the server (the backend was restarted). Click New to start a fresh job."]);
        }
      } catch (_) { /* transient — effect re-runs if deps change, or user can reload */ }
    })();
    return () => { alive = false; };
  }, [status, jobId, rawTranscript]);


  const fetchUserProfiles = async () => {
    if (!uploadPostKey) return;
    try {
      const res = await fetch(getApiUrl('/api/social/user'), {
        headers: { 'X-Upload-Post-Key': uploadPostKey }
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.profiles && data.profiles.length > 0) {
        setUserProfiles(data.profiles);
        // Auto select first if none selected
        if (!uploadUserId) {
          setUploadUserId(data.profiles[0].username);
        }
      } else {
        alert("No profiles found for this API Key.");
      }
    } catch (e) {
      alert("Error fetching User Profiles. Please check key.");
      console.error(e);
    }
  };

  const handleProcess = async (data) => {
    // Read the live provider from localStorage FIRST so users on Ollama
    // (which needs no API key) aren't bounced to the "Gemini API Key
    // Required" modal. The old code only looked at `apiKey` (the Gemini
    // key slot) and showed the modal for any empty key — including the
    // perfectly-valid "Ollama, no key needed" case.
    let _gateProvider = 'gemini-subscription';
    let _gateKey = apiKey || '';
    try {
      const prefRaw = localStorage.getItem('os_llm_pref_last');
      if (prefRaw) {
        const pref = JSON.parse(prefRaw);
        if (pref?.provider) _gateProvider = pref.provider;
      }
      const keyRaw = localStorage.getItem(`os_llm_key_${_gateProvider}`);
      if (keyRaw) {
        // XOR-decode (matches ProviderPicker.xorEncode)
        const SALT = 'openshorts-llm-v1';
        const decoded = atob(keyRaw);
        let out = '';
        for (let i = 0; i < decoded.length; i++) {
          out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
        }
        if (out) _gateKey = out;
      }
    } catch (_) { /* localStorage may be unavailable in some browsers */ }
    // Keyless providers — let them through without an API key:
    //   ollama              → local, no key by design
    //   gemini-subscription → uses gemini.google.com cookies, no key
    const KEYLESS_PROVIDERS = ['ollama', 'gemini-subscription'];
    if (!KEYLESS_PROVIDERS.includes(_gateProvider) && !_gateKey) {
      setShowKeyModal(true);
      return;
    }
    setStatus('processing');
    setLogs(["Starting process..."]);
    setResults(null);
    setProcessingMedia(data);

    try {
      let body;

      // CRITICAL: read provider/model/key from localStorage at request
      // time, not from React state. The KeyInput component writes there
      // synchronously when the user clicks a tile or types — but the
      // setLlmConfig path (state) can lag by one render. Reading from
      // localStorage eliminates that whole class of "GEMINI was sent
      // even though I picked MiniMax" bugs.
      let liveProvider = llmConfig.provider || 'gemini-subscription';
      let liveModel = llmConfig.model || 'gemini-3-flash-plus';
      let liveKey = apiKey || '';
      try {
        const prefRaw = localStorage.getItem('os_llm_pref_last');
        if (prefRaw) {
          const pref = JSON.parse(prefRaw);
          if (pref?.provider) liveProvider = pref.provider;
          if (pref?.model) liveModel = pref.model;
        }
        // Per-provider key — KeyInput stores XOR-encoded
        const keyRaw = localStorage.getItem(`os_llm_key_${liveProvider}`);
        if (keyRaw) {
          // XOR-decode (matches KeyInput's xorEncode)
          const SALT = 'openshorts-llm-v1';
          const decoded = atob(keyRaw);
          let out = '';
          for (let i = 0; i < decoded.length; i++) {
            out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
          }
          if (out) liveKey = out;
        }
      } catch (e) {
        console.warn('Could not read provider config from localStorage', e);
      }
      console.log('[Submit] Using provider:', liveProvider, '/', liveModel,
                  '/ key:', liveKey ? `${liveKey.slice(0, 8)}…` : '<none>');

      const opts = data.options || {};
      const headers = {
        'X-LLM-Provider': liveProvider,
        'X-LLM-Model': liveModel,
        'X-LLM-Key': liveKey,
        // Legacy header — only meaningful when the user is on Gemini.
        'X-Gemini-Key': liveProvider === 'gemini' ? liveKey : '',
        'X-Min-Clips': String(opts.minClips ?? 3),
        'X-Max-Clips': String(opts.maxClips ?? 8),
        'X-Min-Duration': String(opts.minDur ?? 20),
        'X-Max-Duration': String(opts.maxDur ?? 60),
        // Transcription tuning. Whisper model is now always
        // large-v3-turbo on the backend (no UI tier picker), so we only
        // pass language hint + script-script preference.
        'X-Transcript-Lang': String(opts.transcriptLang || ''),
        'X-Transcript-Script': String(opts.transcriptScript || 'auto'),
        // Human-in-the-loop: pause after transcription for manual cleanup.
        'X-Pause-After-Transcript': opts.pauseForCleanup ? '1' : '0',
        // Stage-1 engine choice. Header value 'whisper' or 'elevenlabs'.
        'X-Transcribe-Provider': String(opts.transcribeProvider || 'whisper'),
        // Forward the ElevenLabs key so backend can use it for Scribe
        // when the user picked the elevenlabs engine. Same key the dub
        // feature uses — stored in Settings.
        ...(elevenLabsKey ? { 'X-ElevenLabs-Key': elevenLabsKey } : {}),
      };

      if (data.type === 'url') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ url: data.payload });
      } else if (data.type === 'local') {
        // LOCAL-FILE PATH — no upload, just hand the absolute path to
        // the backend as a multipart form field. Backend validates it
        // against KLIPRA_LOCAL_MEDIA_ROOTS before doing anything with
        // it. We use multipart (not JSON) so the same endpoint shape
        // works as the file-upload path.
        const formData = new FormData();
        formData.append('local_path', data.payload);
        body = formData;
      } else {
        const formData = new FormData();
        formData.append('file', data.payload);
        body = formData;
      }

      // For uploads we strip Content-Type so the browser sets the multipart
      // boundary, but we keep the LLM headers.
      const uploadHeaders = { ...headers };
      delete uploadHeaders['Content-Type'];
      const res = await fetch(getApiUrl('/api/process'), {
        method: 'POST',
        headers: data.type === 'url' ? headers : uploadHeaders,
        body
      });

      if (!res.ok) throw new Error(await res.text());
      const resData = await res.json();
      setJobId(resData.job_id);

    } catch (e) {
      setStatus('error');
      setLogs(l => [...l, `Error starting job: ${e.message}`]);
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setJobId(null);
    setResults(null);
    setLogs([]);
    setProcessingMedia(null);
    setOpenedFromPast(false);
    localStorage.removeItem(SESSION_KEY);
  };

  // --- UI Components ---

  // The Clip Generator is the only product on this page. Other tools
  // (AI Shorts / UGC Gallery / YouTube Studio) are temporarily hidden
  // from the dashboard because each is moving to its own dedicated page.
  // The header surfaces only the three product tabs (Clip Generator,
  // Subtitle, Dub) and the overflow menu keeps the rarer ones
  // (Settings, Pricing, About). Past Projects is no longer a tab — it
  // lives inline inside each product's own page.
  const PRIMARY_TAB = 'dashboard';
  const OVERFLOW_TABS = [
    { id: 'settings',    label: 'Settings',       icon: Settings },
    { id: 'pricing',     label: 'Pricing',        icon: Tag },
    { id: 'about',       label: 'About',          icon: Info },
  ];

  const [overflowOpen, setOverflowOpen] = useState(false);
  // Close overflow when clicking outside
  useEffect(() => {
    if (!overflowOpen) return;
    const close = () => setOverflowOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [overflowOpen]);

  /**
   * Klipra top-bar nav. Logo on the left; the three products on the
   * right. The overflow menu carries the rarer routes (Settings,
   * Pricing, About, sign out, landing). Past Projects is NOT here —
   * each product shows its own past-projects panel inline.
   */
  const TopBar = () => {
    // Definitive list of the three products. Order is locked: clip
    // generation first (the flagship), subtitle, then dub. Each entry
    // owns its accent so active state colour-codes the tab.
    const PRODUCTS = [
      { id: 'dashboard', label: 'Generate Viral Clips', icon: Sparkles, accentText: 'text-primary',     accentBg: 'bg-primary/10' },
      { id: 'smartclip', label: 'Smart Clipper',        icon: Brain,    accentText: 'text-violet-300', accentBg: 'bg-violet-500/10' },
      { id: 'h2v',       label: 'Horizontal → Vertical',icon: Film,     accentText: 'text-fuchsia-300',accentBg: 'bg-fuchsia-500/10' },
      { id: 'subtitle',  label: 'Auto Subtitle',        icon: Type,     accentText: 'text-orange-300',  accentBg: 'bg-orange-500/10' },
      { id: 'dub',       label: 'Voice Dubbing',        icon: Languages, accentText: 'text-emerald-300', accentBg: 'bg-emerald-500/10' },
      { id: 'audioclean',label: 'Audio Cleaning',       icon: Wand2,    accentText: 'text-sky-300',     accentBg: 'bg-sky-500/10' },
      { id: 'youtubeseo',label: 'YouTube SEO',          icon: Youtube,  accentText: 'text-red-300',     accentBg: 'bg-red-500/10' },
      { id: 'avatar',    label: 'AI Avatar',            icon: UserCircle2, accentText: 'text-violet-300', accentBg: 'bg-violet-500/10', badge: 'Preview' },
      { id: 'podcast',   label: 'Podcast Studio',       icon: Mic,         accentText: 'text-pink-300',   accentBg: 'bg-pink-500/10' },
    ];
    return (
    <header className="h-14 sm:h-16 border-b border-border bg-surface/80 backdrop-blur-md flex items-center justify-between px-3 sm:px-5 shrink-0 z-20 relative">
      {/* LEFT — logo only. No breadcrumb; the active product is
          highlighted on the right side instead, which is more honest
          about where the user is. */}
      <div className="flex items-center min-w-0">
        <button
          onClick={() => setActiveTab('home')}
          className="flex items-center shrink-0"
          aria-label="Klipra home"
        >
          <KlipraLogo size={28} showWordmark />
        </button>
      </div>

      {/* RIGHT — three product tabs + overflow menu. */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* New Project — visible only when a job is in flight or done */}
        {status !== 'idle' && (
          <button
            onClick={handleReset}
            className="hidden md:inline-flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded-md hover:bg-white/5"
          >
            <PlusCircle size={14} /> New
          </button>
        )}
        {PRODUCTS.map(({ id, label, icon: Icon, accentText, accentBg }) => {
          const active = activeTab === id;
          // Click behaviour:
          //   - inactive tab → switch to it (state preserved)
          //   - active tab   → reset to its home/idle view, so users
          //     viewing a past project can re-click the tab name to
          //     get back to "Add a video" without hunting for a back
          //     button. Also matches what users expect from native
          //     browser tab clicks.
          return (
            <button
              key={id}
              onClick={() => active ? goHomeOfTab(id) : setActiveTab(id)}
              className={
                'inline-flex items-center gap-1.5 text-xs sm:text-[13px] font-medium px-2.5 sm:px-3 py-1.5 rounded-md transition ' +
                (active
                  ? `${accentText} ${accentBg}`
                  : 'text-zinc-300 hover:text-white hover:bg-white/5')
              }
              title={active ? `${label} — click again for home` : label}
            >
              <Icon size={14} />
              {/* Hide labels on very narrow screens — only icon + active
                  pill remains, which is still readable. */}
              <span className="hidden md:inline">{label}</span>
            </button>
          );
        })}
        {!apiKey && (
          <span className="hidden lg:inline-block text-[10px] uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-1 rounded-full border border-amber-500/30">
            No AI key
          </span>
        )}
        {/* Auth — sign in / sign up when logged out, avatar menu when in.
            Uses an inline initial so users can tell at a glance which
            account they're signed in as. */}
        {!currentUser ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAuthModalTab('signin')}
              className="hidden sm:inline-flex items-center text-xs px-2.5 py-1.5 rounded-md text-zinc-300 hover:text-white hover:bg-white/5"
            >
              Sign in
            </button>
            <button
              onClick={() => setAuthModalTab('signup')}
              className="inline-flex items-center text-xs sm:text-[13px] font-medium px-2.5 sm:px-3 py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25"
            >
              Sign up
            </button>
          </div>
        ) : (
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-white/5"
              aria-label="Account menu"
            >
              <span className="w-7 h-7 rounded-full bg-primary/20 border border-primary/40 text-primary text-xs font-bold flex items-center justify-center">
                {(currentUser.email || '?').charAt(0).toUpperCase()}
              </span>
              <ChevronDown size={12} className="text-zinc-400" />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-64 rounded-xl border border-border bg-elevated shadow-2xl py-2 z-50">
                <div className="px-3 py-2 border-b border-white/5">
                  <div className="text-[12px] font-medium text-white truncate">{currentUser.full_name || currentUser.email}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{currentUser.email}</div>
                  <div className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                    {currentUser.plan || 'free'} plan
                    {currentUser.jobs_limit != null && (
                      <span className="text-zinc-400 normal-case">· {currentUser.jobs_used}/{currentUser.jobs_limit} jobs used</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => { setActiveTab('pricing'); setUserMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left text-zinc-300 hover:text-white hover:bg-white/5"
                >
                  <Tag size={14} /> Plans &amp; pricing
                </button>
                {currentUser.stripe_customer_id && (
                  <button
                    onClick={async () => {
                      setUserMenuOpen(false);
                      try {
                        const r = await fetch(getApiUrl('/api/billing/portal'), {
                          method: 'POST',
                          headers: { Authorization: `Bearer ${authToken}` },
                        });
                        if (!r.ok) throw new Error(await r.text());
                        const { url } = await r.json();
                        if (url) window.location.href = url;
                      } catch (e) { alert('Could not open billing portal: ' + e.message); }
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left text-zinc-300 hover:text-white hover:bg-white/5"
                  >
                    <Settings size={14} /> Manage subscription
                  </button>
                )}
                <button
                  onClick={signOut}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left text-zinc-300 hover:text-white hover:bg-white/5"
                >
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        )}
        {/* Overflow menu */}
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setOverflowOpen((v) => !v)}
            aria-label="Open menu"
            className={
              'p-2 rounded-md transition ' +
              (overflowOpen ? 'bg-white/10 text-white' : 'text-zinc-300 hover:text-white hover:bg-white/5')
            }
          >
            <Menu size={18} />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-56 rounded-xl border border-border bg-elevated shadow-2xl py-1.5 z-50">
              {OVERFLOW_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => { setActiveTab(id); setOverflowOpen(false); }}
                  className={
                    'w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition ' +
                    (activeTab === id
                      ? 'text-primary bg-primary/10'
                      : 'text-zinc-300 hover:text-white hover:bg-white/5')
                  }
                >
                  <Icon size={16} /> {label}
                </button>
              ))}
              <button
                onClick={() => { setShowInfluencer(true); setOverflowOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left text-zinc-300 hover:text-white hover:bg-white/5"
              >
                <Sparkles size={16} /> Influencer program
              </button>
              <div className="my-1.5 border-t border-border" />
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setOverflowOpen(false);
                  localStorage.removeItem('klipra_skip_landing');
                  localStorage.removeItem('openshorts_skip_landing');
                  window.location.hash = '';
                  window.location.reload();
                }}
                className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-300 hover:text-white hover:bg-white/5"
              >
                <Globe size={16} /> Landing page
              </a>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                klipra · v0.1
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden selection:bg-primary/30">
      {/* Top app bar — replaces the old left sidebar entirely */}
      <TopBar />

      {/* Optional second-row utility strip — only shows when there's
          something useful to surface (Upload-Post profile picker etc.) */}
      {userProfiles.length > 0 && (
        <div className="border-b border-border bg-background/60 backdrop-blur-sm px-3 sm:px-5 py-2 flex items-center justify-end shrink-0">
          <UserProfileSelector
            profiles={userProfiles}
            selectedUserId={uploadUserId}
            onSelect={setUploadUserId}
          />
        </div>
      )}

      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Background Gradients */}
        <div className="absolute inset-0 overflow-hidden -z-10 pointer-events-none">
          <div className="absolute -top-[10%] -right-[10%] w-[60%] h-[50%] bg-primary/5 rounded-full blur-[120px]" />
          <div className="absolute -bottom-[20%] -left-[10%] w-[50%] h-[50%] bg-accent/5 rounded-full blur-[120px]" />
        </div>

        {/* Session Recovery Banner */}
        {sessionRecovered && (
          <div className="mx-6 mt-2 p-3 bg-primary/10 border border-primary/20 rounded-xl flex items-center justify-between animate-[fadeIn_0.3s_ease-out] shrink-0">
            <div className="flex items-center gap-2 text-sm text-primary">
              <RotateCcw size={16} />
              <span className="font-medium">Session recovered</span>
              <span className="text-zinc-400 text-xs">Your previous work has been restored.</span>
            </div>
            <button onClick={() => setSessionRecovered(false)} className="text-zinc-500 hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex-1 overflow-hidden relative">

          {/* View: Settings */}
          {activeTab === 'settings' && (
            <div className="h-full overflow-y-auto p-8 max-w-2xl mx-auto animate-[fadeIn_0.3s_ease-out]">
              <div className="flex items-center justify-between mb-8">
                <h1 className="text-2xl font-bold">Settings</h1>
                <div className="px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full text-[10px] text-green-400 font-medium flex items-center gap-2">
                  <Shield size={12} /> Privacy: keys only live in your browser (sent to backend just to process)
                </div>
              </div>
              <KeyInput onKeySet={setApiKey} savedKey={apiKey} />

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Social Integration</h2>
                  <span className="text-[10px] bg-white/5 border border-white/5 px-2 py-0.5 rounded text-zinc-500 uppercase tracking-wider">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Automatically publish your clips to TikTok, Instagram Reels, and YouTube Shorts via <strong>Upload-Post</strong>.
                  Includes a <strong>free tier</strong> (no credit card required).
                  If you prefer, you can skip this and manually download/upload your videos.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">Upload-Post API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={uploadPostKey}
                      onChange={(e) => setUploadPostKey(e.target.value)}
                      className="input-field"
                      placeholder="ey..."
                    />
                    <button onClick={fetchUserProfiles} className="btn-primary py-2 px-4 text-sm">
                      Connect
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Connect your Upload-Post account to enable one-click publishing.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <a href="https://app.upload-post.com/login" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Login</span>
                        <span className="text-[10px] text-zinc-600">Register account</span>
                      </a>
                      <a href="https://app.upload-post.com/manage-users" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. Profiles</span>
                        <span className="text-[10px] text-zinc-600">Create & Connect</span>
                      </a>
                      <a href="https://app.upload-post.com/api-keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">3. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. They are sent to the backend only to process your request, never stored server-side.
                    </span>
                  </p>
                </div>
              </div>

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Video Translation</h2>
                  <span className="text-[10px] bg-white/5 border border-white/5 px-2 py-0.5 rounded text-zinc-500 uppercase tracking-wider">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Translate your clips to different languages using <strong>ElevenLabs</strong> AI dubbing.
                  Automatically translates speech while preserving the original voice characteristics.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">ElevenLabs API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={elevenLabsKey}
                      onChange={(e) => setElevenLabsKey(e.target.value)}
                      className="input-field"
                      placeholder="sk_..."
                    />
                    <button
                      onClick={() => {
                        if (elevenLabsKey) {
                          localStorage.setItem('elevenLabsKey_v1', encrypt(elevenLabsKey));
                          alert('ElevenLabs API Key saved!');
                        }
                      }}
                      className="btn-primary py-2 px-4 text-sm"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your API key from ElevenLabs to enable video translation.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a href="https://elevenlabs.io/sign-up" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Sign Up</span>
                        <span className="text-[10px] text-zinc-600">Create account</span>
                      </a>
                      <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. They are sent to the backend only to process your request, never stored server-side.
                    </span>
                  </p>
                </div>
              </div>

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">AI Shorts (UGC Videos)</h2>
                  <span className="text-[10px] bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded text-violet-400 uppercase tracking-wider">New</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Generate UGC-style videos with AI actors for any product or business using <strong>fal.ai</strong>.
                  Just describe your product or paste a URL. Requires fal.ai + ElevenLabs API keys.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">fal.ai API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={falKey}
                      onChange={(e) => setFalKey(e.target.value)}
                      className="input-field"
                      placeholder="fal_..."
                    />
                    <button
                      onClick={() => {
                        if (falKey) {
                          localStorage.setItem('falKey_v1', encrypt(falKey));
                          alert('fal.ai API Key saved!');
                        }
                      }}
                      className="btn-primary py-2 px-4 text-sm"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your API key from fal.ai to enable AI actor video generation.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Sign Up</span>
                        <span className="text-[10px] text-zinc-600">Create fal.ai account</span>
                      </a>
                      <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. Sent to backend only to process requests.
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* View: SaaS Shorts */}
          {activeTab === 'saasshorts' && (
            <SaaShortsTab geminiApiKey={apiKey} elevenLabsKey={elevenLabsKey} falKey={falKey} uploadPostKey={uploadPostKey} uploadUserId={uploadUserId} />
          )}

          {/* View: UGC Gallery */}
          {activeTab === 'ugc-gallery' && (
            <UGCGallery />
          )}

          {/* View: Thumbnails */}
          {activeTab === 'thumbnails' && (
            <ThumbnailStudio geminiApiKey={apiKey} uploadPostKey={uploadPostKey} uploadUserId={uploadUserId} />
          )}

          {/* View: Home — in-app homepage with feature explainers and
              demo videos. Reachable any time by clicking the Klipra
              logo. Distinct from the pre-app Landing.jsx which only
              shows on first visit. */}
          {activeTab === 'home' && (
            <Home
              currentUser={currentUser}
              onChooseTab={setActiveTab}
            />
          )}

          {/* Past Projects view used to live here as its own tab. It now
              lives INSIDE the Clip Generator landing page (the dashboard
              idle view below) — see <PastProjects compact /> there. The
              Subtitle and Dub pages each have their own equivalent
              (<StandalonePastList />). The header only shows the three
              products, nothing else. */}

          {/* View: Pricing */}
          {activeTab === 'pricing' && (
            <Pricing
              onChooseTab={setActiveTab}
              onSignupClick={() => setAuthModalTab('signup')}
              onChoosePlan={async (plan) => {
                // Need an account before we can attach a Stripe customer.
                if (!currentUser) { setAuthModalTab('signup'); return; }
                try {
                  const r = await fetch(getApiUrl('/api/billing/checkout'), {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${authToken}`,
                    },
                    body: JSON.stringify({ plan }),
                  });
                  if (!r.ok) {
                    const t = await r.text();
                    // 503 = Stripe not configured. Show a friendly fallback.
                    if (r.status === 503) {
                      alert('Billing is launching soon — drop us a line at hello@ilmeaalim.com to get on the early-access list.');
                    } else {
                      throw new Error(t || `HTTP ${r.status}`);
                    }
                    return;
                  }
                  const { url } = await r.json();
                  if (url) window.location.href = url;
                } catch (e) {
                  alert('Could not start checkout: ' + e.message);
                }
              }}
            />
          )}

          {/* View: About */}
          {activeTab === 'about' && (
            <About onChooseTab={setActiveTab} />
          )}

          {/* View: Standalone Subtitle (whole-video subtitle burn) */}
          {activeTab === 'subtitle' && (() => {
            // Build LLM headers fresh from localStorage so the page
            // always has the latest provider config.
            let provider = llmConfig?.provider || 'gemini-subscription';
            let model = llmConfig?.model || 'gemini-3-flash-plus';
            let key = apiKey || '';
            try {
              const prefRaw = localStorage.getItem('os_llm_pref_last');
              if (prefRaw) { const p = JSON.parse(prefRaw); if (p?.provider) provider = p.provider; if (p?.model) model = p.model; }
              const keyRaw = localStorage.getItem(`os_llm_key_${provider}`);
              if (keyRaw) {
                const SALT = 'openshorts-llm-v1';
                const decoded = atob(keyRaw); let out = '';
                for (let i = 0; i < decoded.length; i++) out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
                if (out) key = out;
              }
            } catch {}
            const llmHeaders = {
              'X-LLM-Provider': provider, 'X-LLM-Model': model, 'X-LLM-Key': key,
              'X-Gemini-Key': provider === 'gemini' ? key : '',
            };
            return <StandaloneSubtitle llmHeaders={llmHeaders} elevenLabsKey={elevenLabsKey} homeBump={tabHomeBump.subtitle} currentUser={currentUser} onChooseTab={setActiveTab} />;
          })()}

          {/* View: Standalone Dub (whole-video translation + voice) */}
          {activeTab === 'dub' && (() => {
            let provider = llmConfig?.provider || 'gemini-subscription';
            let model = llmConfig?.model || 'gemini-3-flash-plus';
            let key = apiKey || '';
            try {
              const prefRaw = localStorage.getItem('os_llm_pref_last');
              if (prefRaw) { const p = JSON.parse(prefRaw); if (p?.provider) provider = p.provider; if (p?.model) model = p.model; }
              const keyRaw = localStorage.getItem(`os_llm_key_${provider}`);
              if (keyRaw) {
                const SALT = 'openshorts-llm-v1';
                const decoded = atob(keyRaw); let out = '';
                for (let i = 0; i < decoded.length; i++) out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
                if (out) key = out;
              }
            } catch {}
            const llmHeaders = {
              'X-LLM-Provider': provider, 'X-LLM-Model': model, 'X-LLM-Key': key,
              'X-Gemini-Key': provider === 'gemini' ? key : '',
            };
            return <StandaloneDub llmHeaders={llmHeaders} elevenLabsKey={elevenLabsKey} homeBump={tabHomeBump.dub} />;
          })()}

          {/* View: Audio Cleaning (Adobe-Podcast-style noise/music removal) */}
          {activeTab === 'audioclean' && (
            <StandaloneAudioClean homeBump={tabHomeBump.audioclean} />
          )}

          {/* View: YouTube SEO (transcribe -> titles / description / tags / chapters) */}
          {activeTab === 'youtubeseo' && (() => {
            let provider = llmConfig?.provider || 'gemini-subscription';
            let model = llmConfig?.model || 'gemini-3-flash-plus';
            let key = apiKey || '';
            try {
              const prefRaw = localStorage.getItem('os_llm_pref_last');
              if (prefRaw) { const p = JSON.parse(prefRaw); if (p?.provider) provider = p.provider; if (p?.model) model = p.model; }
              const keyRaw = localStorage.getItem(`os_llm_key_${provider}`);
              if (keyRaw) {
                const SALT = 'openshorts-llm-v1';
                const decoded = atob(keyRaw); let out = '';
                for (let i = 0; i < decoded.length; i++) out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
                if (out) key = out;
              }
            } catch {}
            const llmHeaders = {
              'X-LLM-Provider': provider, 'X-LLM-Model': model, 'X-LLM-Key': key,
              'X-Gemini-Key': provider === 'gemini' ? key : '',
            };
            return <StandaloneYouTubeSEO llmHeaders={llmHeaders} homeBump={tabHomeBump.youtubeseo} />;
          })()}

          {/* View: Smart Clipper (multimodal viral-moment picker) */}
          {activeTab === 'smartclip' && (
            <SmartClipper
              currentUser={currentUser}
              onChooseTab={setActiveTab}
              uploadPostKey={uploadPostKey}
              uploadUserId={uploadUserId}
              geminiApiKey={apiKey}
              llmConfig={llmConfig}
              elevenLabsKey={elevenLabsKey}
            />
          )}

          {/* View: Horizontal → Vertical editor — full-canvas timeline
              editor for converting a long horizontal video into one or
              many vertical 9:16 clips with AI-proposed topic boundaries,
              intelligent merge, and per-clip speaker focus tracking. */}
          {activeTab === 'h2v' && (
            <HorizontalToVertical
              apiKey={apiKey}
              llmConfig={llmConfig}
              setApiKey={setApiKey}
              elevenLabsKey={elevenLabsKey}
              onBack={() => setActiveTab('home')}
            />
          )}

          {/* View: AI Avatar — talking-head from photo + audio.
              UI placeholder for now. Reference model LongCat-Video-
              Avatar is CUDA-only; this tab gives users the input
              flow while we wait for a Mac-compatible engine. */}
          {activeTab === 'avatar' && (
            <AIAvatar
              currentUser={currentUser}
              onChooseTab={setActiveTab}
            />
          )}

          {/* View: Podcast Studio (klipra-podcast) */}
          {activeTab === 'podcast' && (
            <div className="w-full h-full flex flex-col bg-[#0a0e17] overflow-hidden">
              <iframe
                src={`${window.location.protocol}//${window.location.hostname}:3000`}
                title="Klipra Podcast Studio"
                className="w-full flex-1 border-0"
                allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write; clipboard-read"
              />
            </div>
          )}

          {/* View: Gallery */}
          {/* {activeTab === 'gallery' && (
            <Gallery />
          )} */}

          {/* View: Dashboard (Idle)

              Scroll-aware layout: the outer wrapper owns the scrollbar
              (h-full + overflow-y-auto), and the inner wrapper uses
              min-h-full + flex items-center to vertically-center the
              content WHEN it fits and let it scroll naturally WHEN the
              Options panel is expanded and overflows. Without this, on
              shorter laptops the "Generate Clips" button gets clipped
              below the viewport with no way to scroll to it. */}
          {activeTab === 'dashboard' && status === 'idle' && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-[fadeIn_0.3s_ease-out]">
              <div className="min-h-full flex flex-col items-center justify-center p-6 py-10">
                <div className="max-w-xl w-full text-center space-y-8">
                  <div className="space-y-4">
                    <h1 className="text-4xl md:text-5xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
                      Create Viral Shorts
                    </h1>
                    <p className="text-zinc-400 text-lg">
                      Drop your long-form video URL or file below to instantly generate viral clips with AI.
                    </p>
                  </div>

                  <MediaInput onProcess={handleProcess} isProcessing={status === 'processing'} provider={llmConfig?.provider} />

                  {/* Interactive AI picker. Click → switch provider /
                      model / paste key right here without going to
                      Settings. Persists per-provider; once saved, stays
                      saved for all future generations. */}
                  <ProviderPicker
                    onChange={({ provider, model, api_key }) => {
                      setLlmConfig({ provider, model });
                      if (api_key) setApiKey(api_key);
                    }}
                  />


                  <div className="flex items-center justify-center gap-8 text-zinc-500 text-sm">
                    <span className="flex items-center gap-2"><Youtube size={16} /> YouTube</span>
                    <span className="flex items-center gap-2"><Instagram size={16} /> Instagram</span>
                    <span className="flex items-center gap-2"><TikTokIcon size={16} /> TikTok</span>
                  </div>

                  {/* Past clip-generation projects — only this page's
                      product. Auto-hides when empty so first-time users
                      see a clean hero. Mirrors the equivalent panel
                      inside Subtitle / Dub. */}
                  <div className="text-left">
                    <PastProjects
                      compact
                      onOpen={async (jobId) => {
                        try {
                          const r = await fetch(getApiUrl(`/api/status/${jobId}`));
                          if (!r.ok) throw new Error('Job not found');
                          const data = await r.json();
                          const clips = (data.result && data.result.clips) || [];
                          if (clips.length === 0) {
                            alert('This project has no clips on disk — they may have been deleted. Try regenerating.');
                            return;
                          }
                          setJobId(jobId);
                          setStatus(data.status === 'completed' ? 'complete' : data.status);
                          setLogs(data.logs || []);
                          setResults(data.result || null);
                          setProcessingMedia({
                            type: 'url',
                            payload: getApiUrl(clips[0].video_url || ''),
                          });
                          // Remember we came in via the past list so the
                          // split-view header can show a "Back to past
                          // projects" button instead of just "New".
                          setOpenedFromPast(true);
                        } catch (e) {
                          alert('Could not load job: ' + e.message);
                        }
                      }}
                      onDelete={async (jobId) => {
                        if (!window.confirm('Delete this project and all its files?')) return;
                        try {
                          await fetch(getApiUrl(`/api/job/${jobId}`), { method: 'DELETE' });
                        } catch { /* swallow */ }
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View: Processing / Results (Split View) */}
          {activeTab === 'dashboard' && (status === 'processing' || status === 'awaiting_cleanup' || status === 'complete' || status === 'error') && (
            <div className="h-full flex flex-col md:flex-row animate-[fadeIn_0.3s_ease-out]">

              {/* Left Panel: Preview & Status */}
              <div className={`${status === 'complete' ? 'w-full md:w-[30%] lg:w-[25%]' : 'w-full md:w-[55%] lg:w-[60%]'} h-full flex flex-col border-r border-white/5 bg-black/20 p-6 overflow-y-auto custom-scrollbar transition-all duration-700 ease-in-out`}>
                {/* Back to past projects — only shown when the current
                    job was opened FROM the Past Projects list. Gives
                    users a one-click route back to pick a different
                    project instead of having to hunt for "New" in the
                    top bar. */}
                {openedFromPast && (
                  <button
                    onClick={handleReset}
                    className="mb-4 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white transition self-start"
                  >
                    <RotateCcw size={12} /> Back to past projects
                  </button>
                )}
                <div className="mb-6 flex items-center justify-between">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Activity className={`text-primary ${status === 'processing' ? 'animate-pulse' : ''}`} size={20} />
                    Live Analysis
                  </h2>
                  <span className={`text-xs px-2 py-1 rounded-full border ${status === 'processing' ? 'bg-primary/10 border-primary/20 text-primary' :
                    status === 'complete' ? 'bg-green-500/10 border-green-500/20 text-green-400' :
                      'bg-red-500/10 border-red-500/20 text-red-400'
                    }`}>
                    {status.toUpperCase()}
                  </span>
                </div>

                {/* Video Preview */}
                {processingMedia && (
                  <ProcessingAnimation
                    media={processingMedia}
                    isComplete={status === 'complete'}
                    syncedTime={syncedTime}
                    isSyncedPlaying={isSyncedPlaying}
                    syncTrigger={syncTrigger}
                    llmConfig={llmConfig}
                  />
                )}

                {/* Logs Terminal */}
                <div className={`bg-[#0c0c0e] rounded-xl border border-white/10 overflow-hidden flex flex-col transition-all duration-500 ${status === 'complete' ? 'h-32 min-h-0 opacity-50 hover:opacity-100' : 'flex-1 min-h-[200px]'}`}>
                  <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between bg-white/5 shrink-0">
                    <span className="text-xs font-mono text-zinc-400 flex items-center gap-2">
                      <Terminal size={12} /> System Logs
                    </span>
                    <button onClick={() => setLogsVisible(!logsVisible)} className="text-zinc-500 hover:text-white transition-colors">
                      {logsVisible ? <ChevronDown size={14} /> : <ChevronDown size={14} className="rotate-180" />}
                    </button>
                  </div>
                  {logsVisible && (
                    <div className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-1.5 custom-scrollbar text-zinc-400">
                      {logs.map((log, i) => (
                        <div key={i} className={`flex gap-2 ${log.toLowerCase().includes('error') ? 'text-red-400' : 'text-zinc-400'}`}>
                          <span className="text-zinc-700 shrink-0">{new Date().toLocaleTimeString()}</span>
                          <span>{log}</span>
                        </div>
                      ))}
                      {status === 'processing' && (
                        <div className="animate-pulse text-primary/70">_</div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Results Grid */}
              <div className={`${status === 'complete' ? 'w-full md:w-[70%] lg:w-[75%]' : 'w-full md:w-[45%] lg:w-[40%]'} h-full flex flex-col bg-background p-6 transition-all duration-700 ease-in-out`}>
                <h2 className="text-lg font-semibold mb-6 flex items-center gap-2 shrink-0">
                  <Sparkles className="text-yellow-400" size={20} />
                  Generated Shorts
                  {results?.clips?.length > 0 && (
                    <span className="text-xs bg-white/10 text-white px-2 py-0.5 rounded-full ml-auto">
                      {results.clips.length} Clips
                    </span>
                  )}
                  {results?.cost_analysis && typeof results.cost_analysis.total_cost === 'number' && (
                    <span className="text-xs bg-green-500/10 border border-green-500/20 text-green-400 px-2 py-0.5 rounded-full ml-2" title={`Input: ${results.cost_analysis.input_tokens ?? 0} | Output: ${results.cost_analysis.output_tokens ?? 0}`}>
                      ${(results.cost_analysis.total_cost || 0).toFixed(5)}
                    </span>
                  )}
                  {jobId && status === 'complete' && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm('Delete this generation and all its clips? This cannot be undone.')) return;
                        try {
                          await fetch(getApiUrl(`/api/job/${jobId}`), { method: 'DELETE' });
                        } catch (e) { /* swallow — UI resets either way */ }
                        setResults(null);
                        setStatus('idle');
                        setJobId(null);
                        setLogs([]);
                        setProcessingMedia(null);
                      }}
                      className="ml-2 text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1"
                      title="Delete this generation"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                  {/* "Programar Semana" weekly-scheduling shortcut removed
                      — feature stays available per-clip via the Post action. */}
                </h2>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                  {results && results.clips && results.clips.length > 0 ? (
                    <div className={`grid gap-4 pb-10 ${status === 'complete' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}>
                      {results.clips.map((clip, i) => (
                        <ResultCard
                          key={i}
                          clip={clip}
                          index={i}
                          jobId={jobId}
                          uploadPostKey={uploadPostKey}
                          uploadUserId={uploadUserId}
                          geminiApiKey={apiKey}
                          llmConfig={llmConfig}
                          elevenLabsKey={elevenLabsKey}
                          onPlay={(time) => handleClipPlay(time)}
                          onPause={handleClipPause}
                        />
                      ))}
                    </div>
                  ) : (
                    status === 'processing' ? (
                      <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4 opacity-50">
                        <div className="w-12 h-12 rounded-full border-2 border-zinc-800 border-t-primary animate-spin" />
                        <p className="text-sm">Waiting for clips...</p>
                      </div>
                    ) : status === 'awaiting_cleanup' ? (
                      <TranscriptReviewPanel
                        jobId={jobId}
                        transcript={rawTranscript}
                        onLog={(line) => setLogs(prev => [...prev, line])}
                        onProceed={() => { setRawTranscript(null); setStatus('processing'); }}
                      />
                    ) : status === 'error' ? (
                      <ResumePanel
                        jobId={jobId}
                        llmConfig={llmConfig}
                        apiKey={apiKey}
                        onLog={(line) => setLogs(prev => [...prev, line])}
                        onResumed={() => setStatus('processing')}
                      />
                    ) : null
                  )}
                </div>
              </div>

            </div>
          )}

        </div>

        {/* Footer */}
        <div className="h-9 border-t border-white/5 flex items-center justify-center gap-4 shrink-0">
          <button
            onClick={() => setActiveTab('pricing')}
            className="text-[10px] text-zinc-500 hover:text-white transition uppercase tracking-wider"
          >
            Pricing
          </button>
          <span className="text-zinc-700">·</span>
          <button
            onClick={() => setActiveTab('about')}
            className="text-[10px] text-zinc-500 hover:text-white transition uppercase tracking-wider"
          >
            About
          </button>
          <span className="text-zinc-700">·</span>
          <span className="text-[10px] text-zinc-600">
            Made with <span aria-hidden="true">❤️</span> by <span className="text-zinc-400">Ilmeaalim</span>
          </span>
        </div>
      </main>

      {/* Missing API Key Modal */}
      {showKeyModal && (() => {
        // Read the currently-active provider so the copy matches what
        // the user actually picked. Without this, an OpenAI/Anthropic
        // user gets "Gemini API Key Required" which is misleading.
        let _activeProv = 'gemini';
        try {
          const prefRaw = localStorage.getItem('os_llm_pref_last');
          if (prefRaw) {
            const pref = JSON.parse(prefRaw);
            if (pref?.provider) _activeProv = pref.provider;
          }
        } catch (_) { /* localStorage may be unavailable */ }
        const _provNames = {
          gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic (Claude)',
          openrouter: 'OpenRouter', groq: 'Groq', minimax: 'MiniMax', ollama: 'Ollama',
        };
        const _provKeyUrls = {
          gemini: 'https://aistudio.google.com/app/apikey',
          openai: 'https://platform.openai.com/api-keys',
          anthropic: 'https://console.anthropic.com/settings/keys',
          openrouter: 'https://openrouter.ai/keys',
          groq: 'https://console.groq.com/keys',
          minimax: 'https://platform.minimax.io',
        };
        const _provName = _provNames[_activeProv] || 'AI provider';
        const _keyUrl = _provKeyUrls[_activeProv] || 'https://aistudio.google.com/app/apikey';
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowKeyModal(false)}>
          <div className="bg-[#18181b] border border-white/10 rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white">{_provName} API Key Required</h2>
            <p className="text-sm text-zinc-400">
              You need a {_provName} API key to use the Clip Generator. You can also switch to <strong className="text-emerald-300">Ollama (local)</strong> in the AI picker — it runs on your Mac and needs no key.
            </p>
            <div className="bg-white/5 border border-white/10 rounded-lg p-4 space-y-2">
              <p className="text-xs font-semibold text-zinc-300">How to get your key:</p>
              <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                <li>Go to <a href={_keyUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">{_keyUrl.replace(/^https?:\/\//, '')}</a></li>
                <li>Sign in to your {_provName} account</li>
                <li>Create an API key</li>
                <li>Copy the key and paste it below</li>
              </ol>
            </div>
            <input
              type="text"
              placeholder={`Paste your ${_provName} API key here...`}
              className="w-full bg-black/50 border border-white/20 rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target.value.trim()) {
                  setApiKey(e.target.value.trim());
                  setShowKeyModal(false);
                }
              }}
            />

            {/* Upload-Post info */}
            <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-4 space-y-2">
              <p className="text-xs font-semibold text-violet-300">Optional: Auto-publish to social media</p>
              <p className="text-xs text-zinc-400">
                With an <strong className="text-zinc-300">Upload-Post</strong> API key you can publish your clips directly to TikTok, Instagram Reels, and YouTube Shorts — or schedule them for later. Free tier available, no credit card needed.
              </p>
              <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                <li>Register at <a href="https://app.upload-post.com/login" target="_blank" rel="noopener noreferrer" className="text-violet-400 underline">app.upload-post.com</a></li>
                <li>Connect your TikTok, Instagram, or YouTube accounts</li>
                <li>Go to API Keys and generate one</li>
                <li>Paste it in Settings — done!</li>
              </ol>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowKeyModal(false)}
                className="flex-1 text-sm text-zinc-400 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowKeyModal(false); setActiveTab('settings'); }}
                className="flex-1 text-sm text-white py-2 rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors font-medium"
              >
                Go to Settings
              </button>
            </div>
          </div>
        </div>
      ); })()}

      <ScheduleWeekModal
        isOpen={showScheduleWeek}
        onClose={() => setShowScheduleWeek(false)}
        clips={results?.clips || []}
        jobId={jobId}
        uploadPostKey={uploadPostKey}
        uploadUserId={uploadUserId}
      />

      {/* Auth + influencer modals — global so any page can trigger them. */}
      {authModalTab && (
        <AuthModal
          initialTab={authModalTab}
          onClose={() => setAuthModalTab(null)}
          onSuccess={handleAuthSuccess}
        />
      )}
      {showInfluencer && (
        <InfluencerApplyModal onClose={() => setShowInfluencer(false)} />
      )}
    </div>
  );
}

/**
 * Tiny chip that shows the provider/model that WILL be sent on the next
 * Generate Clips click. Reads from the same localStorage keys the request
 * builder reads from, refreshed every 1.5s, so it matches what gets
 * transmitted regardless of React state staleness.
 */
function ActiveProviderBadge() {
  const [info, setInfo] = React.useState({ provider: '?', model: '?', hasKey: false });
  React.useEffect(() => {
    const tick = () => {
      try {
        const raw = localStorage.getItem('os_llm_pref_last');
        const pref = raw ? JSON.parse(raw) : {};
        const p = pref?.provider || 'gemini-subscription';
        const m = pref?.model || 'gemini-3-flash-plus';
        const k = localStorage.getItem(`os_llm_key_${p}`);
        setInfo({ provider: p, model: m, hasKey: !!k });
      } catch {
        setInfo({ provider: 'gemini-subscription', model: 'gemini-3-flash-plus', hasKey: false });
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  const ok = info.hasKey || info.provider === 'ollama' || info.provider === 'gemini-subscription';
  return (
    <div className={
      'mt-3 mx-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-mono ' +
      (ok ? 'bg-green-500/10 border border-green-500/20 text-green-300'
          : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-300')
    }>
      <span className="text-zinc-500 uppercase tracking-wider">Active:</span>
      <span className="font-bold">{info.provider}</span>
      <span className="text-zinc-500">/</span>
      <span>{info.model}</span>
      {!ok && <span className="text-yellow-400">· no key set</span>}
    </div>
  );
}

/**
 * ResumePanel — shown on the right-hand "Generated Shorts" pane when a
 * clip-generation job has failed.
 *
 * Gives the user TWO options instead of one:
 *
 *   1. Resume from checkpoint   — re-runs with the ORIGINAL provider
 *      (this is the historical behaviour; useful when the failure was
 *      transient e.g. flaky network).
 *
 *   2. Switch AI & resume       — opens a small inline picker showing
 *      every installed Ollama model + a few hosted provider options.
 *      Picking one + clicking the gradient button calls /api/retry with
 *      X-LLM-Provider / X-LLM-Model / X-LLM-Key headers, so the resumed
 *      subprocess uses the new AI without losing the existing on-disk
 *      transcript / clip-pick checkpoints.
 *
 * Built specifically because Gemini's free tier hits a daily 20-request
 * quota mid-job and forces an "import everything from scratch" cycle
 * unless we can swap to free Ollama mid-stream.
 */
function ResumePanel({ jobId, llmConfig, apiKey, onLog, onResumed }) {
  const [showPicker, setShowPicker] = React.useState(false);
  const [provider, setProvider] = React.useState(() => llmConfig?.provider || 'ollama');
  const [model, setModel] = React.useState(() => llmConfig?.model || '');
  const [ollamaModels, setOllamaModels] = React.useState([]);
  const [busy, setBusy] = React.useState(false);

  // Pull live installed Ollama models — same endpoint the picker uses.
  // /api/providers returns an array of {id, name, models, ...}. Find
  // the Ollama entry and read its models (which the backend has
  // already populated with the LIVE list from the local daemon).
  React.useEffect(() => {
    if (!showPicker) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(getApiUrl('/api/providers?refresh=1'));
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const arr = Array.isArray(j) ? j : (j?.providers || []);
        const ollama = arr.find((p) => p?.id === 'ollama');
        const list = Array.isArray(ollama?.models)
          ? ollama.models.map((m) => (typeof m === 'string' ? m : m?.name || m?.id || ''))
              .filter(Boolean)
          : [];
        setOllamaModels(list);
        if (provider === 'ollama' && !model && list.length) {
          const preferred = list.find((m) => /14b|13b|8b|7b/i.test(m)) || list[0];
          setModel(preferred);
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [showPicker, model, provider]);

  function decryptedKeyFor(prov) {
    try {
      const raw = localStorage.getItem(`os_llm_key_${prov}`);
      if (!raw) return '';
      const SALT = 'openshorts-llm-v1';
      const decoded = atob(raw);
      let out = '';
      for (let i = 0; i < decoded.length; i++) out += String.fromCharCode(decoded.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
      return out;
    } catch (_) { return ''; }
  }

  async function doResume(override) {
    if (!jobId || busy) return;
    setBusy(true);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (override) {
        headers['X-LLM-Provider'] = override.provider || '';
        if (override.model) headers['X-LLM-Model'] = override.model;
        headers['X-LLM-Key'] = override.key || '';
      }
      const r = await fetch(getApiUrl(`/api/retry/${jobId}`), {
        method: 'POST',
        headers,
      });
      if (!r.ok) {
        const t = await r.text();
        onLog?.(`Resume failed: ${t}`);
        setBusy(false);
        return;
      }
      onLog?.(
        override
          ? `🔄 Resume queued with ${override.provider}${override.model ? '/' + override.model : ''} — on-disk checkpoints preserved.`
          : '♻️ Resume queued — re-running with on-disk checkpoints…'
      );
      onResumed?.();
    } catch (e) {
      onLog?.(`Resume error: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center text-red-400 space-y-3 px-6 text-center">
      <p className="font-bold">Generation failed.</p>
      <p className="text-[12px] text-zinc-400 max-w-md">
        Already-finished steps (transcript, clip picks, rendered clips) are checkpointed on disk.
        Hit Resume to pick up where the previous attempt stopped — usually it just re-runs the failing step.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
        <button
          type="button"
          disabled={!jobId || busy}
          onClick={() => doResume(null)}
          className="px-4 py-2 rounded-md bg-amber-500 hover:bg-amber-400 text-black text-[12px] font-bold inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ♻️ Resume from checkpoint
        </button>
        <button
          type="button"
          disabled={!jobId || busy}
          onClick={() => setShowPicker((v) => !v)}
          className={
            'px-4 py-2 rounded-md text-[12px] font-bold inline-flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed ' +
            (showPicker
              ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_6px_22px_-6px_rgba(168,85,247,0.6)]'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 ring-1 ring-white/10')
          }
        >
          🔄 Switch AI &amp; resume
        </button>
      </div>

      {/* Helpful one-liner about Gemini quota — the most common reason
          someone reaches this panel. Always shown so the picker doesn't
          feel cryptic. */}
      <p className="text-[11px] text-zinc-500 max-w-md">
        Out of Gemini quota for today? Pick a local Ollama model below — it's free, runs offline, and inherits your transcript checkpoint.
      </p>

      {showPicker && (
        <div className="w-full max-w-md mt-2 rounded-2xl ring-1 ring-violet-400/30 bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 backdrop-blur-md p-4 text-left shadow-[0_24px_60px_-20px_rgba(168,85,247,0.45)]">
          <p className="text-[11px] uppercase tracking-wider text-violet-300 mb-2">Pick a different AI for the resume</p>

          <label className="block text-[11px] text-zinc-400 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const np = e.target.value;
              setProvider(np);
              // Reset model to a sensible default per provider.
              if (np === 'ollama') {
                const preferred = ollamaModels.find((m) => /14b|13b|8b|7b/i.test(m)) || ollamaModels[0] || '';
                setModel(preferred);
              } else if (np === 'gemini') setModel('gemini-2.5-flash');
              else if (np === 'openai') setModel('gpt-4o-mini');
            }}
            className="w-full bg-zinc-900/80 ring-1 ring-white/10 rounded-lg px-2 py-1.5 text-[12px] text-white mb-3"
          >
            <option value="ollama">Ollama (free, local)</option>
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
          </select>

          <label className="block text-[11px] text-zinc-400 mb-1">Model</label>
          {provider === 'ollama' && ollamaModels.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-zinc-900/80 ring-1 ring-white/10 rounded-lg px-2 py-1.5 text-[12px] text-white mb-3"
            >
              {ollamaModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === 'ollama' ? 'e.g. qwen2.5:14b-instruct' : provider === 'openai' ? 'e.g. gpt-4o-mini' : 'e.g. gemini-2.5-flash'}
              className="w-full bg-zinc-900/80 ring-1 ring-white/10 rounded-lg px-2 py-1.5 text-[12px] text-white mb-3"
            />
          )}

          {provider === 'ollama' && ollamaModels.length === 0 && (
            <p className="text-[11px] text-amber-300 -mt-2 mb-2">
              No Ollama models detected. Start the Ollama app and `ollama pull qwen2.5:14b-instruct`, then re-open this picker.
            </p>
          )}

          <button
            type="button"
            disabled={!model || busy}
            onClick={() => {
              const k = provider === 'ollama' ? '' : (decryptedKeyFor(provider) || apiKey || '');
              doResume({ provider, model, key: k });
            }}
            className="w-full mt-1 rounded-lg bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white text-[12.5px] font-semibold py-2 hover:opacity-95 transition shadow-[0_8px_24px_-8px_rgba(217,70,239,0.55)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Queuing…' : `Resume with ${provider}${model ? ' / ' + model : ''}`}
          </button>
          <p className="text-[10.5px] text-zinc-500 mt-2 leading-snug">
            Your transcript and any already-rendered clips stay. Only the steps that still need an AI run on the new provider.
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
