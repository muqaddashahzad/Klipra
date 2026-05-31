import React, { useState, useRef, useMemo } from 'react';
import { Lock, Upload, Sparkles, Crown, Trash2, Check } from 'lucide-react';
import {
    FREE_TEMPLATES,
    PRO_TEMPLATES,
    loadCustomTemplates,
    saveCustomTemplate,
    deleteCustomTemplate,
    parseAssTemplate,
    hasProAccess,
} from '../utils/subtitleTemplates';

/**
 * Subtitle styling templates picker. Sits at the top of Phase 2 styling
 * so users can one-click into a curated look instead of fiddling with
 * every slider. Three sections:
 *
 *   • Free — applies immediately on click
 *   • Pro  — visible to everyone, gated for non-paid users (clicking a
 *            locked card opens the upgrade modal). Shipping the cards
 *            visible-but-locked is an intentional conversion lever:
 *            users see what they'd get, then decide if it's worth
 *            upgrading.
 *   • Custom — uploaded .ass templates from the user's own NLE, or
 *              future marketplace downloads. Stored locally for now.
 *
 * `onApply(stylingObj)` lets the parent flatten the template's
 * properties into its component state. We do NOT mutate the parent's
 * fontSize/fontName/etc. directly because each parent owns those as
 * separate useState slots — much cleaner if the parent does it itself.
 */
export default function SubtitleTemplatesPicker({ activeStyling, onApply, currentUser, onUpgradeClick }) {
    const [showPro, setShowPro] = useState(true);
    const [customs, setCustoms] = useState(() => loadCustomTemplates());
    const fileInputRef = useRef(null);
    const [uploadError, setUploadError] = useState(null);
    const proAccess = hasProAccess(currentUser);

    // Match-by-shape so the active template is highlighted even if the
    // user later tweaks ONE slider without leaving template land. Two
    // templates with identical styling share a card — that's fine.
    const activeId = useMemo(() => {
        const all = [...FREE_TEMPLATES, ...PRO_TEMPLATES, ...customs];
        for (const t of all) {
            if (sameStyling(t.styling, activeStyling)) return t.id;
        }
        return null;
    }, [activeStyling, customs]);

    const handleApply = (template) => {
        if (template.tier === 'pro' && !proAccess) {
            onUpgradeClick?.(template);
            return;
        }
        onApply?.(template.styling);
    };

    const handleUpload = async (e) => {
        setUploadError(null);
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const styling = parseAssTemplate(text);
            if (!styling) {
                setUploadError("That file doesn't look like a .ass V4+ subtitle template. Export from Aegisub / Subtitle Edit / DaVinci as Advanced SubStation Alpha.");
                return;
            }
            const newTemplate = {
                id: `custom-${Date.now()}`,
                name: file.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Custom',
                tier: 'custom',
                description: `Imported from ${file.name}`,
                styling,
            };
            const list = saveCustomTemplate(newTemplate);
            setCustoms(list);
            // Auto-apply on import — that's the most useful default.
            onApply?.(styling);
        } catch (err) {
            setUploadError('Could not read that file: ' + (err.message || err));
        } finally {
            // Allow re-uploading the same filename later.
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleDeleteCustom = (id) => {
        if (!confirm('Delete this custom template?')) return;
        const list = deleteCustomTemplate(id);
        setCustoms(list);
    };

    return (
        <div className="rounded-xl border border-white/10 bg-surface/40 p-4 mb-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1.5">
                    <Sparkles size={12} /> Subtitle templates
                </div>
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[10px] uppercase tracking-wider font-bold text-zinc-300 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20 transition flex items-center gap-1"
                        title="Upload a .ass V4+ subtitle styling file from your NLE"
                    >
                        <Upload size={11} /> Upload .ass
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".ass,.ssa,text/plain"
                        onChange={handleUpload}
                        className="hidden"
                    />
                </div>
            </div>

            {uploadError && (
                <div className="mb-3 p-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200 leading-relaxed">
                    {uploadError}
                </div>
            )}

            {/* Free templates — always usable */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                {FREE_TEMPLATES.map((t) => (
                    <TemplateCard
                        key={t.id}
                        template={t}
                        active={activeId === t.id}
                        locked={false}
                        onClick={() => handleApply(t)}
                    />
                ))}
            </div>

            {/* Pro templates — section header with crown icon */}
            <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider font-bold text-amber-300 flex items-center gap-1.5">
                    <Crown size={11} /> Pro templates
                    {!proAccess ? (
                        <span className="text-zinc-500 normal-case font-normal">— upgrade to unlock</span>
                    ) : (
                        <span className="text-zinc-500 normal-case font-normal">— testing access</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => setShowPro((v) => !v)}
                    className="text-[10px] text-zinc-500 hover:text-white"
                >
                    {showPro ? 'Hide' : 'Show'}
                </button>
            </div>
            {showPro && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                    {PRO_TEMPLATES.map((t) => (
                        <TemplateCard
                            key={t.id}
                            template={t}
                            active={activeId === t.id}
                            locked={!proAccess}
                            onClick={() => handleApply(t)}
                        />
                    ))}
                </div>
            )}

            {/* Custom (user-uploaded) templates */}
            {customs.length > 0 && (
                <>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-300 flex items-center gap-1.5 mb-2">
                        <Upload size={11} /> Your imports
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {customs.map((t) => (
                            <div key={t.id} className="relative group">
                                <TemplateCard
                                    template={t}
                                    active={activeId === t.id}
                                    locked={false}
                                    onClick={() => handleApply(t)}
                                />
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); handleDeleteCustom(t.id); }}
                                    className="absolute top-1 right-1 p-1 rounded text-zinc-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition bg-black/60"
                                    title="Delete this custom template"
                                >
                                    <Trash2 size={10} />
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            )}

            <p className="mt-3 text-[10px] text-zinc-500 leading-relaxed">
                Upload templates exported from Aegisub, Subtitle Edit, or DaVinci Resolve as <span className="font-mono">.ass</span> Advanced SubStation Alpha. A subtitle marketplace is coming — your imports stay private until then.
            </p>
        </div>
    );
}

function TemplateCard({ template, active, locked, onClick }) {
    // Tiny preview: a colored "Aa" tile that uses the template's
    // primary + outline colours. Cheap visual hint — much faster than
    // rendering a real video frame per card.
    const c = template.preview || {};
    const isBoxed = !!c.boxed;
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                'relative rounded-lg border p-2 text-left transition group overflow-hidden ' +
                (active
                    ? 'border-emerald-400/70 bg-emerald-500/10 ring-1 ring-emerald-400/40'
                    : locked
                        ? 'border-amber-500/30 bg-amber-500/5 hover:border-amber-400/60'
                        : 'border-white/10 bg-black/30 hover:border-white/30 hover:bg-black/50')
            }
        >
            {/* Mini preview swatch */}
            <div className="aspect-[16/9] rounded-md bg-gradient-to-br from-zinc-900 to-black mb-2 flex items-center justify-center relative overflow-hidden">
                <span
                    className="font-bold leading-none"
                    style={{
                        fontFamily: template.styling?.fontName || 'Arial',
                        fontSize: '22px',
                        color: c.color || '#FFFFFF',
                        textShadow: !isBoxed && c.outline
                            ? `-1px -1px 0 ${c.outline}, 1px -1px 0 ${c.outline}, -1px 1px 0 ${c.outline}, 1px 1px 0 ${c.outline}`
                            : 'none',
                        background: isBoxed ? `${template.styling?.bgColor || '#000000'}cc` : 'transparent',
                        padding: isBoxed ? '2px 6px' : 0,
                        borderRadius: isBoxed ? '2px' : 0,
                    }}
                >Aa</span>
            </div>
            <div className="flex items-center justify-between gap-1">
                <div className="text-[11px] font-semibold text-white truncate">{template.name}</div>
                {locked && (
                    <Lock size={10} className="text-amber-400 shrink-0" />
                )}
                {active && !locked && (
                    <Check size={11} className="text-emerald-300 shrink-0" />
                )}
            </div>
            <div className="text-[9px] text-zinc-500 leading-tight mt-0.5 line-clamp-2">
                {template.description}
            </div>
            {locked && (
                <div className="absolute top-1 left-1 px-1 py-0.5 rounded text-[8px] uppercase tracking-wider font-bold bg-amber-500/20 text-amber-200 border border-amber-500/40">
                    Pro
                </div>
            )}
        </button>
    );
}

/** Shallow equality on the keys that templates set. Robust against
 *  the parent's state having extra unrelated keys (e.g. crop offsets
 *  that aren't part of the template). */
function sameStyling(a, b) {
    if (!a || !b) return false;
    const keys = ['fontName', 'fontSize', 'fontColor', 'borderColor',
                  'borderWidth', 'bgColor', 'bgOpacity', 'positionPct'];
    for (const k of keys) {
        const av = a[k], bv = b[k];
        if (typeof av === 'number' && typeof bv === 'number') {
            if (Math.abs(av - bv) > 0.001) return false;
        } else if (av !== bv) {
            return false;
        }
    }
    return true;
}
