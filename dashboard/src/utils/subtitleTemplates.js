/**
 * Subtitle styling templates.
 *
 * A template is just a snapshot of every Phase-2 styling prop —
 * applying one is "set all the sliders / colour pickers at once."
 * The structure mirrors the keys the burn endpoint already accepts,
 * so applying a template is a no-op on the backend side.
 *
 * Tiers:
 *   - 'free'     : ships with every install, applied by anyone
 *   - 'pro'      : visible on the picker but gated behind a paid plan
 *                  (currentUser.plan ∈ {pro, studio}). Users on free
 *                  see them with a lock + a "Pro" badge — that's the
 *                  conversion hook.
 *   - 'custom'   : user-uploaded. Stored in localStorage today; ready
 *                  to lift to a server-side library + marketplace in
 *                  a future release with no schema change.
 *
 * Adding a new template:
 *   1. Append it to FREE_TEMPLATES or PRO_TEMPLATES below.
 *   2. Make sure every prop the burn endpoint reads is present so
 *      applying the template doesn't leave stale state from whatever
 *      the user was tweaking before.
 */

// Default (the values the wizard ships with on a clean state).
const DEFAULT_STYLING = {
    fontName:     'Verdana',
    fontSize:     32,
    fontColor:    '#FFFFFF',
    borderColor:  '#000000',
    borderWidth:  2,
    bgColor:      '#000000',
    bgOpacity:    0.0,
    positionPct:  85,
};

export const FREE_TEMPLATES = [
    {
        id: 'default',
        name: 'Default',
        tier: 'free',
        description: 'Clean white text with black outline — works everywhere.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'zinc' },
        styling: { ...DEFAULT_STYLING },
    },
    {
        id: 'tiktok-yellow',
        name: 'TikTok Yellow',
        tier: 'free',
        description: 'Big bold yellow text — high contrast, viral-ready.',
        preview: { color: '#FFEB00', outline: '#000000', accent: 'yellow' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 40,
            fontColor: '#FFEB00',
            borderColor: '#000000',
            borderWidth: 4,
            positionPct: 80,
        },
    },
    {
        id: 'caption-box',
        name: 'Caption Box',
        tier: 'free',
        description: 'White text on a translucent black box — broadcast caption look.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'zinc', boxed: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Helvetica',
            fontSize: 30,
            fontColor: '#FFFFFF',
            bgColor: '#000000',
            bgOpacity: 0.65,
            borderWidth: 0,
            positionPct: 88,
        },
    },
    {
        id: 'minimal-bottom',
        name: 'Minimal',
        tier: 'free',
        description: 'Small clean text near the bottom — least intrusive.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'zinc' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Helvetica',
            fontSize: 22,
            borderWidth: 1,
            positionPct: 92,
        },
    },
    // ─── Animated free templates ──────────────────────────────────────
    // Each pop / karaoke / word-highlight setting drives a libass
    // effect on the burn pipeline (backend tasks #69 #70 #102). These
    // are the "TikTok-style" looks users expect from CapCut.
    {
        id: 'pop-bounce',
        name: 'Pop Bounce',
        tier: 'free',
        description: 'Bold white text that bounces in — TikTok / Reels staple.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'zinc', animated: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 42,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 5,
            positionPct: 82,
            animation: 'pop',
        },
    },
    {
        id: 'karaoke-yellow',
        name: 'Karaoke',
        tier: 'free',
        description: 'Each word lights up yellow as it\'s spoken — sing-along style.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'yellow', animated: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 38,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 4,
            positionPct: 84,
            animation: 'karaoke',
            highlightColor: '#FFDD00',
        },
    },
    {
        id: 'word-highlight-cyan',
        name: 'Word Highlight',
        tier: 'free',
        description: 'Active word jumps to cyan AND scales up — matches the React preview exactly.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'cyan', animated: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 36,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 4,
            positionPct: 84,
            animation: 'word-highlight',
            highlightColor: '#00E5FF',
        },
    },
    {
        // NEW — answers a direct user ask. The active word gets a
        // solid red box behind it instead of a colour change. Base
        // text is plain white on transparent so the box reveal really
        // pops. Backend renders this via a second ASS named style
        // ("Box") with BorderStyle=3 + red BackColour, swapped in
        // per-word via \rBox{word}\r.
        id: 'red-box-highlight',
        name: 'Red Box Highlight',
        tier: 'free',
        description: 'Active word lands in a solid red box — punchy, news-anchor energy.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'red', animated: true, boxed: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 36,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 3,
            bgColor: '#000000',
            bgOpacity: 0.0,
            positionPct: 84,
            animation: 'word-box',
            highlightColor: '#FF1F1F',
        },
    },
    {
        id: 'black-bg-red-box',
        name: 'Black Strip + Red Box',
        tier: 'free',
        description: 'White text on a black strip; active word jumps to a red box. Maximum readability.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'red', animated: true, boxed: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 34,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 0,
            bgColor: '#000000',
            bgOpacity: 0.78,
            positionPct: 84,
            animation: 'word-box',
            highlightColor: '#FF1F1F',
        },
    },
    {
        id: 'fade-in-soft',
        name: 'Fade In',
        tier: 'free',
        description: 'Soft gentle fade — ideal for ambient / cinematic content.',
        preview: { color: '#F4E5C2', outline: '#000000', accent: 'amber', animated: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Helvetica',
            fontSize: 28,
            fontColor: '#F4E5C2',
            borderColor: '#000000',
            borderWidth: 2,
            positionPct: 86,
            animation: 'pop',
        },
    },
];

export const PRO_TEMPLATES = [
    {
        id: 'beast-mode',
        name: 'Beast Mode',
        tier: 'pro',
        description: 'Huge top-anchored Impact text — the Mr Beast move.',
        preview: { color: '#FFFFFF', outline: '#000000', accent: 'red' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 60,
            fontColor: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 6,
            positionPct: 18,
        },
    },
    {
        id: 'karaoke-pop',
        name: 'Karaoke Pop',
        tier: 'pro',
        description: 'Word-by-word reveal — each word lights up as it\'s spoken.',
        preview: { color: '#FF3D8A', outline: '#FFFFFF', accent: 'pink' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 44,
            fontColor: '#FFFFFF',
            borderColor: '#FF3D8A',
            borderWidth: 5,
            positionPct: 85,
            // animation: 'karaoke' — burn pipeline stub for the
            // per-word ASS animation. Stays in the styling object so
            // backend can detect & honour when implemented.
            animation: 'karaoke',
        },
    },
    {
        id: 'neon-glow',
        name: 'Neon Glow',
        tier: 'pro',
        description: 'Glowing cyan text — perfect for night-time / cyberpunk content.',
        preview: { color: '#00F5FF', outline: '#0066FF', accent: 'cyan' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Impact',
            fontSize: 38,
            fontColor: '#00F5FF',
            borderColor: '#0066FF',
            borderWidth: 5,
            positionPct: 82,
            animation: 'glow',
        },
    },
    {
        id: 'cinematic-serif',
        name: 'Cinematic Serif',
        tier: 'pro',
        description: 'Classy serif with a soft drop shadow — film-trailer feel.',
        preview: { color: '#F4E5C2', outline: '#000000', accent: 'amber' },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Times New Roman',
            fontSize: 30,
            fontColor: '#F4E5C2',
            borderColor: '#000000',
            borderWidth: 2,
            bgColor: '#000000',
            bgOpacity: 0.35,
            positionPct: 88,
        },
    },
    {
        id: 'soft-pastel',
        name: 'Soft Pastel',
        tier: 'pro',
        description: 'Pink text on creamy box — vlog / lifestyle aesthetic.',
        preview: { color: '#FF8FB4', outline: '#FFFFFF', accent: 'pink', boxed: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Comic Sans MS',
            fontSize: 28,
            fontColor: '#FF8FB4',
            bgColor: '#FFFFFF',
            bgOpacity: 0.7,
            borderWidth: 0,
            positionPct: 86,
        },
    },
    {
        id: 'breaking-news',
        name: 'Breaking News',
        tier: 'pro',
        description: 'Red banner with white text — clickbait / news urgency.',
        preview: { color: '#FFFFFF', outline: '#FFFFFF', accent: 'red', boxed: true },
        styling: {
            ...DEFAULT_STYLING,
            fontName: 'Arial',
            fontSize: 32,
            fontColor: '#FFFFFF',
            bgColor: '#D32027',
            bgOpacity: 0.92,
            borderWidth: 0,
            positionPct: 78,
        },
    },
];

/**
 * Parse an uploaded .ass file's [V4+ Styles] header to extract a
 * styling preset. We only look at the FIRST style row — most exports
 * only have one anyway. Returns a styling object compatible with our
 * burn endpoint, or null if the file isn't a recognisable ASS.
 *
 * Mapping:
 *   ASS Fontsize is in PlayRes pixels — for our slider semantic
 *   (which is "preview CSS pixels at a 600-tall reference") we
 *   approximate by dividing by 3 and clamping to 14-72. Imperfect,
 *   but close enough that the imported template lands in a
 *   recognisably similar size.
 */
export function parseAssTemplate(text) {
    if (typeof text !== 'string' || !text.includes('[V4+ Styles]')) return null;
    const lines = text.split(/\r?\n/);
    let formatLine = null, styleLine = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('Format:') && lines[i - 1]?.trim() === '[V4+ Styles]') formatLine = line;
        if (line.startsWith('Format:') && formatLine === null) {
            // some files put Format: directly under [V4+ Styles] without a blank
            const j = i;
            // walk back to confirm
            for (let k = j - 1; k >= 0; k--) {
                const prev = lines[k].trim();
                if (prev === '[V4+ Styles]') { formatLine = line; break; }
                if (prev) break;
            }
        }
        if (line.startsWith('Style:') && !styleLine) styleLine = line;
    }
    if (!formatLine || !styleLine) return null;
    const fields = formatLine.replace(/^Format:\s*/, '').split(',').map((s) => s.trim());
    const values = styleLine.replace(/^Style:\s*/, '').split(',').map((s) => s.trim());
    const get = (name) => {
        const idx = fields.indexOf(name);
        return idx >= 0 ? values[idx] : null;
    };
    const fontname = get('Fontname') || 'Verdana';
    const fontsizeAss = parseInt(get('Fontsize') || '32', 10);
    const primary = assColorToHex(get('PrimaryColour'));
    const outline = assColorToHex(get('OutlineColour'));
    const back = assColorToHex(get('BackColour'));
    const outlineWidth = parseFloat(get('Outline') || '2') || 2;
    const borderStyle = parseInt(get('BorderStyle') || '1', 10);
    return {
        fontName: fontname,
        // Convert ASS px → preview-px (slider): /3 keeps the burn
        // approximately the same on a typical 1080-tall video given
        // the backend's video_h/600 scale-up.
        fontSize: clamp(Math.round(fontsizeAss / 3), 14, 72),
        fontColor: primary || '#FFFFFF',
        borderColor: outline || '#000000',
        borderWidth: clamp(Math.round(outlineWidth), 0, 8),
        bgColor: borderStyle === 3 ? (outline || '#000000') : '#000000',
        bgOpacity: borderStyle === 3 ? 0.65 : 0,
        positionPct: 85,
    };
}

// ASS colour format: &HAABBGGRR&  (alpha + BGR). Convert to #RRGGBB.
function assColorToHex(s) {
    if (!s) return null;
    const m = s.match(/&H([0-9A-Fa-f]+)&?/);
    if (!m) return null;
    const hex = m[1].padStart(8, '0');
    // hex = AABBGGRR
    const r = hex.slice(6, 8);
    const g = hex.slice(4, 6);
    const b = hex.slice(2, 4);
    return `#${r}${g}${b}`.toUpperCase();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const CUSTOM_KEY = 'klipra_subtitle_custom_templates';

export function loadCustomTemplates() {
    try {
        const raw = localStorage.getItem(CUSTOM_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

export function saveCustomTemplate(template) {
    const list = loadCustomTemplates();
    list.unshift(template);
    try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.slice(0, 50)));
    } catch {}
    return list;
}

export function deleteCustomTemplate(id) {
    const list = loadCustomTemplates().filter((t) => t.id !== id);
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch {}
    return list;
}

/**
 * DEV-MODE OVERRIDE: while we're still testing, unlock every Pro
 * template for everyone so the operator can audition each one and
 * decide whether they earn their place behind the paywall. The
 * "Pro" pill stays in the UI for visual differentiation, but the
 * click no longer routes to the upgrade page.
 *
 * BEFORE GOING LIVE: flip this flag to false so the paywall actually
 * paywalls. (Or change the gate to read from a server-side feature
 * flag — that's the cleanest production setup.)
 */
const DEV_PRO_UNLOCK = true;

/** Whether the current user has access to Pro templates. */
export function hasProAccess(currentUser) {
    if (DEV_PRO_UNLOCK) return true;
    const plan = (currentUser?.plan || '').toLowerCase();
    return plan === 'pro' || plan === 'studio';
}
