import React, { useState } from 'react';
import { X, Sparkles, Loader2, Maximize, MoveVertical, Type, Palette } from 'lucide-react';

// Hook backgrounds the user can pick. Each is `[bgHex, textHex, label]`.
// We fan these out as one-tap presets in the modal so the common-case
// styling (white box / black box / yellow box) is a single click.
const PRESETS = [
    { bg: '#FFFFFF', text: '#000000', label: 'White' },
    { bg: '#000000', text: '#FFFFFF', label: 'Black' },
    { bg: '#FFEB3B', text: '#000000', label: 'Yellow' },
    { bg: '#FF1744', text: '#FFFFFF', label: 'Red' },
    { bg: '#7C3AED', text: '#FFFFFF', label: 'Purple' },
    { bg: '#10B981', text: '#FFFFFF', label: 'Green' },
];

export default function HookModal({
    isOpen, onClose, onGenerate, isProcessing, videoUrl, initialText, durationInSeconds,
    // Optional initializers so the modal can REOPEN on an existing hook
    // (used by the standalone-subtitle styling page, where the hook is
    // edited then burned later). Default to the clip-flow defaults so the
    // existing clip usage is unchanged.
    initialConfig = null,
    submitLabel = 'Add Hook',
}) {
    const [text, setText] = useState(
        (initialConfig && initialConfig.text) || initialText || 'POV: You are using the viral hook feature');
    const [size, setSize] = useState((initialConfig && initialConfig.size) || 'M');
    // 2-D placement: a 9-anchor grid (vAlign × hAlign) + per-axis px margins
    // from the hugged edge. This replaces the old vertical-only control and
    // lets the hook sit in any corner (e.g. top-right, 50 px in). We seed from
    // the new fields when reopening, else map the legacy `position` (top/
    // center/bottom) so previously-saved hooks open sensibly.
    const [hAlign, setHAlign] = useState((initialConfig && initialConfig.h_align) || 'center');
    const [vAlign, setVAlign] = useState(
        (initialConfig && initialConfig.v_align) || (initialConfig && initialConfig.position) || 'top');
    const [marginX, setMarginX] = useState(
        initialConfig && typeof initialConfig.margin_x === 'number' ? initialConfig.margin_x : 40);
    const [marginY, setMarginY] = useState(
        initialConfig && typeof initialConfig.margin_y === 'number' ? initialConfig.margin_y : 40);
    const [textColor, setTextColor] = useState((initialConfig && initialConfig.text_color) || '#000000');
    const [bgColor, setBgColor] = useState((initialConfig && initialConfig.bg_color) || '#FFFFFF');
    const [bgOpacity, setBgOpacity] = useState(
        initialConfig && typeof initialConfig.bg_opacity === 'number' ? initialConfig.bg_opacity : 0.94);
    // The project's real frame dimensions, read from the preview <video> once
    // its metadata loads. The hook box is placed by PIXEL margins on the final
    // frame, so the preview must use the SAME aspect ratio (a 16:9 horizontal
    // project must show a 16:9 preview, not a fixed 9:16) AND map px→% against
    // the SAME width/height — otherwise "top-right" looked centred because the
    // preview pretended every video was 1080×1920.
    const [vidDims, setVidDims] = useState(null);

    if (!isOpen) return null;

    // Preview placement. Margins are px on the real frame; map them to % of the
    // detected frame size (falling back to 1080×1920 until metadata loads).
    const NOMINAL_W = (vidDims && vidDims.w) || 1080;
    const NOMINAL_H = (vidDims && vidDims.h) || 1920;
    const boxPositionStyle = (() => {
        const s = {};
        if (hAlign === 'left') s.left = `${(marginX / NOMINAL_W) * 100}%`;
        else if (hAlign === 'right') s.right = `${(marginX / NOMINAL_W) * 100}%`;
        else { s.left = '50%'; }
        if (vAlign === 'top') s.top = `${(marginY / NOMINAL_H) * 100}%`;
        else if (vAlign === 'bottom') s.bottom = `${(marginY / NOMINAL_H) * 100}%`;
        else { s.top = '50%'; }
        const tx = hAlign === 'center' ? '-50%' : '0';
        const ty = vAlign === 'center' ? '-50%' : '0';
        s.transform = `translate(${tx}, ${ty})`;
        return s;
    })();

    const getSizeStyle = () => {
        switch (size) {
            case 'S': return { fontSize: '14px', maxWidth: '80%' };
            case 'L': return { fontSize: '24px', maxWidth: '95%' };
            case 'M': default: return { fontSize: '18px', maxWidth: '90%' };
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
            <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-4xl shadow-2xl relative flex flex-col md:flex-row gap-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-zinc-500 hover:text-white z-10"
                >
                    <X size={20} />
                </button>

                {/* Left: Preview — always the simple CSS overlay. The
                    Remotion path used to live here but it never actually
                    burned in the hook (Generate-doesn't-apply bug). The
                    real render happens server-side via FFmpeg + PIL.
                    The frame matches the PROJECT's aspect ratio (16:9 for a
                    horizontal video, 9:16 for vertical) so corner placement
                    previews accurately. */}
                <div
                    className="flex-1 flex flex-col items-center justify-center bg-black rounded-lg border border-white/5 overflow-hidden relative max-h-[600px] mx-auto"
                    style={{ aspectRatio: vidDims ? `${vidDims.w} / ${vidDims.h}` : '9 / 16', width: '100%' }}
                >
                    {videoUrl && (
                        <video
                            src={videoUrl}
                            className="w-full h-full object-contain opacity-50"
                            muted
                            playsInline
                            onLoadedMetadata={(e) => {
                                const v = e.currentTarget;
                                if (v.videoWidth && v.videoHeight) setVidDims({ w: v.videoWidth, h: v.videoHeight });
                            }}
                        />
                    )}
                    <div
                        className="absolute pointer-events-none transition-all duration-200"
                        style={{
                            // Anchored to a corner/edge via boxPositionStyle
                            // (left/right/top/bottom + translate), with px
                            // margins mapped to % of a nominal 1080×1920 frame
                            // so the preview matches the burned mp4. Edge-
                            // anchored (left/right) hooks are kept compact (50%)
                            // so they sit in the corner; centred hooks span 90%.
                            ...boxPositionStyle,
                            maxWidth: hAlign === 'center' ? '90%' : '50%',
                        }}
                    >
                        <div
                            className="font-bold px-3 py-2 rounded-xl shadow-2xl text-center whitespace-pre-wrap transition-all duration-200"
                            style={{
                                ...getSizeStyle(),
                                color: textColor,
                                // Convert hex bg + opacity to rgba for the preview.
                                backgroundColor: (() => {
                                    const m = (bgColor || '#FFFFFF').replace('#', '');
                                    const r = parseInt(m.slice(0, 2), 16);
                                    const g = parseInt(m.slice(2, 4), 16);
                                    const b = parseInt(m.slice(4, 6), 16);
                                    return `rgba(${r},${g},${b},${bgOpacity})`;
                                })(),
                                fontFamily: 'Noto Serif, serif',
                                boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
                                paddingTop: '10px',
                                paddingBottom: '10px',
                                paddingLeft: '12px',
                                paddingRight: '12px',
                            }}
                        >
                            {text || "Enter your text..."}
                        </div>
                    </div>
                </div>

                {/* Right: Controls */}
                <div className="w-full md:w-80 flex flex-col">
                    <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                        <Sparkles className="text-yellow-400" /> Viral Hook
                    </h3>

                    <div className="space-y-6 flex-1 overflow-y-auto custom-scrollbar pr-2">
                        {/* Text Input */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 block">Text</label>
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                rows={4}
                                className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-500/50 resize-none font-serif"
                                placeholder="Enter text that will stop the scroll..."
                            />
                        </div>

                        {/* Position Control — 9-anchor grid + per-axis margins.
                            Pick any corner/edge/center, then nudge the gap from
                            the hugged edges in pixels. */}
                        <div className="space-y-2.5">
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                <MoveVertical size={12} /> Position
                                <span className="ml-auto tabular-nums text-zinc-200 normal-case capitalize">{vAlign} {hAlign}</span>
                            </label>
                            {/* 3×3 anchor grid: rows = top/center/bottom, cols = left/center/right */}
                            <div className="grid grid-cols-3 gap-1.5 w-32">
                                {['top', 'center', 'bottom'].map((vy) => (
                                    ['left', 'center', 'right'].map((hx) => {
                                        const active = vAlign === vy && hAlign === hx;
                                        return (
                                            <button
                                                key={`${vy}-${hx}`}
                                                type="button"
                                                title={`${vy} ${hx}`}
                                                onClick={() => { setVAlign(vy); setHAlign(hx); }}
                                                className={`h-9 rounded-md border flex items-center justify-center transition-all ${active
                                                    ? 'bg-yellow-400 border-yellow-300'
                                                    : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                                            >
                                                <span className={`w-2 h-2 rounded-sm ${active ? 'bg-black' : 'bg-zinc-500'}`} />
                                            </button>
                                        );
                                    })
                                ))}
                            </div>
                            {/* Margin sliders — px gap from the hugged edges.
                                Horizontal margin only matters when not centered
                                horizontally; vertical only when top/bottom. */}
                            <div className={`space-y-1 ${hAlign === 'center' ? 'opacity-40 pointer-events-none' : ''}`}>
                                <div className="flex justify-between text-[10px] text-zinc-400">
                                    <span>Horizontal margin</span>
                                    <span className="tabular-nums text-zinc-200">{marginX}px</span>
                                </div>
                                <input type="range" min="0" max="200" step="2" value={marginX}
                                    onChange={(e) => setMarginX(parseInt(e.target.value, 10))}
                                    className="w-full accent-yellow-500" />
                            </div>
                            <div className={`space-y-1 ${vAlign === 'center' ? 'opacity-40 pointer-events-none' : ''}`}>
                                <div className="flex justify-between text-[10px] text-zinc-400">
                                    <span>Vertical margin</span>
                                    <span className="tabular-nums text-zinc-200">{marginY}px</span>
                                </div>
                                <input type="range" min="0" max="200" step="2" value={marginY}
                                    onChange={(e) => setMarginY(parseInt(e.target.value, 10))}
                                    className="w-full accent-yellow-500" />
                            </div>
                            <p className="text-[10px] text-zinc-500 leading-snug">
                                Margins are pixels in the final 9:16 frame (e.g. top-right + 50px both = your corner placement).
                            </p>
                        </div>

                        {/* Size Control */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                                <Maximize size={12} /> Size
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                                {['S', 'M', 'L'].map((sz) => (
                                    <button
                                        key={sz}
                                        onClick={() => setSize(sz)}
                                        className={`py-2 px-1 rounded-lg text-xs font-bold transition-all border ${size === sz
                                            ? 'bg-white text-black border-white'
                                            : 'bg-white/5 text-zinc-400 border-white/5 hover:bg-white/10'
                                            }`}
                                    >
                                        {sz === 'S' ? 'Small' : sz === 'M' ? 'Medium' : 'Large'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Color presets — one-tap palette */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                                <Palette size={12} /> Color preset
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                                {PRESETS.map((p) => {
                                    const active = bgColor === p.bg && textColor === p.text;
                                    return (
                                        <button
                                            key={p.label}
                                            onClick={() => { setBgColor(p.bg); setTextColor(p.text); }}
                                            className={
                                                'py-2 px-1 rounded-lg text-[11px] font-bold transition-all border ' +
                                                (active ? 'border-yellow-400 ring-1 ring-yellow-400/40' : 'border-white/10 hover:border-white/30')
                                            }
                                            style={{ backgroundColor: p.bg, color: p.text }}
                                        >
                                            {p.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Custom color pickers */}
                        <div className="grid grid-cols-2 gap-3">
                            <label className="block">
                                <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1.5 mb-1.5">
                                    <Type size={11} /> Text
                                </span>
                                <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5">
                                    <input
                                        type="color"
                                        value={textColor}
                                        onChange={(e) => setTextColor(e.target.value)}
                                        className="w-6 h-6 cursor-pointer rounded bg-transparent border-0"
                                    />
                                    <span className="text-[11px] font-mono text-zinc-300 uppercase">{textColor}</span>
                                </div>
                            </label>
                            <label className="block">
                                <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1.5 mb-1.5">
                                    <Palette size={11} /> Background
                                </span>
                                <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5">
                                    <input
                                        type="color"
                                        value={bgColor}
                                        onChange={(e) => setBgColor(e.target.value)}
                                        className="w-6 h-6 cursor-pointer rounded bg-transparent border-0"
                                    />
                                    <span className="text-[11px] font-mono text-zinc-300 uppercase">{bgColor}</span>
                                </div>
                            </label>
                        </div>

                        {/* Background opacity / transparency */}
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                                <span>Background opacity</span>
                                <span className="tabular-nums text-zinc-200 font-medium">{Math.round(bgOpacity * 100)}%</span>
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={Math.round(bgOpacity * 100)}
                                onChange={(e) => setBgOpacity(parseInt(e.target.value) / 100)}
                                className="w-full accent-yellow-500"
                            />
                            <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
                                <span>Transparent</span>
                                <span>Solid</span>
                            </div>
                        </div>

                        <div className="p-3 bg-white/5 rounded-lg border border-white/5 text-[11px] text-zinc-400">
                            <strong>Tip:</strong> Keep it short and punchy. Using "POV:" or specific questions works best for retention.
                        </div>
                    </div>

                    <button
                        onClick={() => onGenerate({
                            text, size,
                            // Legacy field kept for any old consumer; backend
                            // prefers v_align when present.
                            position: vAlign,
                            text_color: textColor,
                            bg_color: bgColor,
                            bg_opacity: bgOpacity,
                            // New 2-D placement model.
                            h_align: hAlign,
                            v_align: vAlign,
                            margin_x: marginX,
                            margin_y: marginY,
                            // Legacy vertical % override is unused by the new
                            // anchor model — send null so the backend uses
                            // v_align, not a stale slider value.
                            y_offset: null,
                        })}
                        disabled={isProcessing || !text.trim()}
                        className="w-full py-4 mt-4 bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-400 hover:to-amber-500 text-black font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    >
                        {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Sparkles size={20} />}
                        {isProcessing ? 'Generating...' : submitLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
