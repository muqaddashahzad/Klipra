import React, { useState, useEffect } from 'react';
import { X, Loader2, Globe, Languages, AlertCircle } from 'lucide-react';
import { getApiUrl } from '../config';

const LANGUAGES = {
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "pl": "Polish",
    "hi": "Hindi",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "ar": "Arabic",
    "ru": "Russian",
    "tr": "Turkish",
    "nl": "Dutch",
    "sv": "Swedish",
    "id": "Indonesian",
    "fil": "Filipino",
    "ms": "Malay",
    "vi": "Vietnamese",
    "th": "Thai",
    "uk": "Ukrainian",
    "el": "Greek",
    "cs": "Czech",
    "fi": "Finnish",
    "ro": "Romanian",
    "da": "Danish",
    "bg": "Bulgarian",
    "hr": "Croatian",
    "sk": "Slovak",
    "ta": "Tamil",
    "en": "English",
};

export default function TranslateModal({ isOpen, onClose, onTranslate, isProcessing, videoUrl, hasApiKey }) {
    const [targetLanguage, setTargetLanguage] = useState('es');
    const [dubProvider, setDubProvider] = useState(hasApiKey ? 'elevenlabs' : 'edge');
    const [keepOriginal, setKeepOriginal] = useState(false);
    const [originalVolume, setOriginalVolume] = useState(0.2);
    // Save dubbed clip as a NEW entry instead of replacing the original.
    const [keepSeparate, setKeepSeparate] = useState(true);
    // Voice gender — auto = let LLM detect, or override.
    const [voiceGender, setVoiceGender] = useState('auto');

    if (!isOpen) return null;

    const handleSubmit = () => {
        onTranslate({
            targetLanguage,
            dubProvider,
            keepOriginal,
            originalVolume,
            keepSeparate,
            voiceGender,
        });
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
            <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                <button
                    onClick={onClose}
                    disabled={isProcessing}
                    className="absolute top-4 right-4 text-zinc-500 hover:text-white disabled:opacity-50"
                >
                    <X size={20} />
                </button>

                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-teal-600 flex items-center justify-center">
                        <Languages size={20} className="text-white" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">Dub Voice</h3>
                        <p className="text-xs text-zinc-500">
                            {dubProvider === 'edge'
                                ? 'Free dubbing with Microsoft Edge neural voices'
                                : 'AI voice cloning by ElevenLabs'}
                        </p>
                    </div>
                </div>

                {/* Provider selector */}
                <div className="mb-5">
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Engine</label>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => setDubProvider('edge')}
                            className={
                                'rounded-lg border px-3 py-2 text-left text-sm transition ' +
                                (dubProvider === 'edge'
                                    ? 'border-green-500/60 bg-green-500/10 text-white'
                                    : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                            }
                        >
                            <div className="font-medium">Edge TTS</div>
                            <div className="text-[11px] text-zinc-500">Free · no key · 21 langs</div>
                        </button>
                        <button
                            type="button"
                            onClick={() => setDubProvider('elevenlabs')}
                            className={
                                'rounded-lg border px-3 py-2 text-left text-sm transition ' +
                                (dubProvider === 'elevenlabs'
                                    ? 'border-green-500/60 bg-green-500/10 text-white'
                                    : 'border-white/10 bg-black/30 text-zinc-300 hover:border-white/20')
                            }
                        >
                            <div className="font-medium">ElevenLabs</div>
                            <div className="text-[11px] text-zinc-500">Voice cloning · key needed</div>
                        </button>
                    </div>
                </div>

                {dubProvider === 'elevenlabs' && !hasApiKey && (
                    <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 text-yellow-200 text-xs rounded-lg flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <div>ElevenLabs key not configured. Pick Edge TTS above for a free option.</div>
                    </div>
                )}

                {/* Preview */}
                <div className="mb-6 rounded-xl overflow-hidden bg-black aspect-video relative">
                    <video
                        src={videoUrl}
                        className="w-full h-full object-contain"
                        muted
                        playsInline
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
                </div>

                {/* Language Selection */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-zinc-400 mb-2">
                        <Globe size={14} className="inline mr-2" />
                        Target Language
                    </label>
                    <select
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-green-500/50 appearance-none cursor-pointer"
                        disabled={isProcessing}
                    >
                        {Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Keep original voice (Edge TTS path) */}
                {dubProvider === 'edge' && (
                    <div className="mb-5 p-3 rounded-lg border border-white/10 bg-black/30">
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={keepOriginal}
                                onChange={(e) => setKeepOriginal(e.target.checked)}
                                className="mt-0.5 h-4 w-4 cursor-pointer accent-green-500"
                            />
                            <span className="flex-1">
                                <span className="block text-sm font-medium text-white">
                                    Keep original voice underneath
                                </span>
                                <span className="text-xs text-zinc-500">
                                    Documentary-style: original speaker plays softly, dub plays on top.
                                </span>
                            </span>
                        </label>
                        {keepOriginal && (
                            <div className="mt-3 pl-7">
                                <label className="block text-xs">
                                    <div className="flex items-baseline justify-between text-zinc-400 mb-1">
                                        <span>Original voice volume</span>
                                        <span className="tabular-nums text-zinc-200">
                                            {Math.round(originalVolume * 100)}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0.05}
                                        max={0.7}
                                        step={0.05}
                                        value={originalVolume}
                                        onChange={(e) => setOriginalVolume(+e.target.value)}
                                        className="w-full accent-green-500"
                                    />
                                </label>
                            </div>
                        )}
                    </div>
                )}

                {/* Voice gender + keep-separate (Edge TTS path) */}
                {dubProvider === 'edge' && (
                    <div className="mb-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 block">Voice gender</label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {[
                                    ['auto', 'Auto'],
                                    ['male', 'Male'],
                                    ['female', 'Female'],
                                ].map(([g, label]) => (
                                    <button
                                        key={g}
                                        type="button"
                                        onClick={() => setVoiceGender(g)}
                                        className={
                                            'px-2 py-1.5 rounded-md text-xs font-medium transition ' +
                                            (voiceGender === g
                                                ? 'bg-green-500/15 text-green-300 border border-green-500/40'
                                                : 'bg-black/30 text-zinc-400 border border-white/5 hover:border-white/15 hover:text-zinc-200')
                                        }
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            {voiceGender === 'auto' && (
                                <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                                    AI will detect speaker gender from the source audio.
                                </p>
                            )}
                        </div>
                        <div className="rounded-lg border border-white/10 bg-black/30 p-3 flex items-start gap-2.5 cursor-pointer" onClick={() => setKeepSeparate(!keepSeparate)}>
                            <input
                                type="checkbox"
                                checked={keepSeparate}
                                onChange={(e) => setKeepSeparate(e.target.checked)}
                                className="mt-0.5 h-4 w-4 cursor-pointer accent-green-500"
                                onClick={(e) => e.stopPropagation()}
                            />
                            <div className="flex-1 min-w-0">
                                <div className="text-xs font-bold text-zinc-200">Keep original clip</div>
                                <div className="text-[11px] text-zinc-500 leading-relaxed mt-0.5">
                                    {keepSeparate
                                        ? 'Dubbed version saved as a NEW clip. Original stays untouched.'
                                        : 'Replace original clip with the dubbed version.'}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Info */}
                <div className="mb-6 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                    <p className="text-xs text-green-400">
                        {dubProvider === 'edge' && keepOriginal
                            ? 'A neural narrator speaks the translation. Your original voice plays underneath.'
                            : dubProvider === 'edge'
                                ? 'Free Microsoft neural voice replaces the original audio with the translation.'
                                : 'ElevenLabs clones your voice and dubs it in the selected language.'}
                    </p>
                </div>

                {/* Processing State */}
                {isProcessing && (
                    <div className="mb-4 p-4 bg-white/5 rounded-lg border border-white/10">
                        <div className="flex items-center gap-3">
                            <Loader2 size={20} className="text-green-400 animate-spin" />
                            <div>
                                <p className="text-sm text-white font-medium">Dubbing audio...</p>
                                <p className="text-xs text-zinc-500">This may take a few minutes</p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        disabled={isProcessing}
                        className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-zinc-300 rounded-xl font-medium transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isProcessing || (dubProvider === 'elevenlabs' && !hasApiKey)}
                        className="flex-1 py-3 bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-400 hover:to-teal-500 text-white rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isProcessing ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                Dubbing...
                            </>
                        ) : (
                            <>
                                <Languages size={16} />
                                Dub Voice
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
