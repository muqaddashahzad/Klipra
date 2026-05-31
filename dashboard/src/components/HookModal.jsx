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

export default function HookModal({ isOpen, onClose, onGenerate, isProcessing, videoUrl, initialText, durationInSeconds }) {
    const [text, setText] = useState(initialText || 'POV: You are using the viral hook feature');
    const [position, setPosition] = useState('top');
    const [size, setSize] = useState('M');
    // Custom vertical position (0 = very top, 100 = very bottom).
    // Defaults map to the same fixed presets as 'position' so behavior
    // matches the old modal until the user explicitly drags the slider.
    // Once they touch the slider, customY is non-null and overrides
    // the position preset on the backend.
    const [customY, setCustomY] = useState(null);
    const [textColor, setTextColor] = useState('#000000');
    const [bgColor, setBgColor] = useState('#FFFFFF');
    const [bgOpacity, setBgOpacity] = useState(0.94);

    // Effective vertical position (% from top of frame). Used by both
    // the live preview and the request payload.
    const presetY = position === 'center' ? 50 : position === 'bottom' ? 75 : 20;
    const effectiveY = customY !== null ? customY : presetY;

    if (!isOpen) return null;

    // Fallback preview logic (same as original)
    const getPositionClass = () => {
        switch (position) {
            case 'center': return 'items-center justify-center';
            case 'bottom': return 'items-center justify-end pb-[20%]';
            case 'top': default: return 'items-center justify-start pt-[20%]';
        }
    };

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
                    real render happens server-side via FFmpeg + PIL. */}
                <div className="flex-1 flex flex-col items-center justify-center bg-black rounded-lg border border-white/5 overflow-hidden relative aspect-[9/16] max-h-[600px]">
                    {videoUrl && (
                        <video src={videoUrl} className="w-full h-full object-contain opacity-50" muted playsInline />
                    )}
                    <div
                        className="absolute left-0 right-0 px-8 flex items-start justify-center pointer-events-none transition-all duration-200"
                        style={{
                            // effectiveY = % from top of frame to the
                            // CENTER of the hook. translateY(-50%) so
                            // the box stays centered around that point.
                            top: `${effectiveY}%`,
                            transform: 'translateY(-50%)',
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

                        {/* Position Control — preset buttons + fine-tune slider */}
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                <MoveVertical size={12} /> Vertical position
                                <span className="ml-auto tabular-nums text-zinc-200 normal-case">{Math.round(effectiveY)}% from top</span>
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                                {['top', 'center', 'bottom'].map((pos) => (
                                    <button
                                        key={pos}
                                        onClick={() => {
                                            // Preset click resets the custom Y so the
                                            // slider snaps to the preset's default %.
                                            setPosition(pos);
                                            setCustomY(null);
                                        }}
                                        className={`py-2 px-1 rounded-lg text-xs font-bold capitalize transition-all border ${position === pos && customY === null
                                            ? 'bg-white text-black border-white'
                                            : 'bg-white/5 text-zinc-400 border-white/5 hover:bg-white/10'
                                            }`}
                                    >
                                        {pos}
                                    </button>
                                ))}
                            </div>
                            {/* Fine-tune slider — drag anywhere after picking a preset */}
                            <input
                                type="range"
                                min="0"
                                max="100"
                                step="1"
                                value={Math.round(effectiveY)}
                                onChange={(e) => setCustomY(parseInt(e.target.value, 10))}
                                className="w-full accent-yellow-500"
                            />
                            <div className="flex justify-between text-[10px] text-zinc-500">
                                <span>↑ Top of frame</span>
                                {customY !== null && (
                                    <button
                                        type="button"
                                        onClick={() => setCustomY(null)}
                                        className="text-yellow-300 hover:text-yellow-200 underline"
                                    >
                                        Snap to preset
                                    </button>
                                )}
                                <span>Bottom ↓</span>
                            </div>
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
                            text, position, size,
                            text_color: textColor,
                            bg_color: bgColor,
                            bg_opacity: bgOpacity,
                            // Custom Y override (0-100, % from top of frame).
                            // Null when user is on a preset; backend then
                            // uses the preset.
                            y_offset: customY,
                        })}
                        disabled={isProcessing || !text.trim()}
                        className="w-full py-4 mt-4 bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-400 hover:to-amber-500 text-black font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    >
                        {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Sparkles size={20} />}
                        {isProcessing ? 'Generating...' : 'Add Hook'}
                    </button>
                </div>
            </div>
        </div>
    );
}
