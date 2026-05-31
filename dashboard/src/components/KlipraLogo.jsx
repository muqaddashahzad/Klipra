import React from 'react';

/**
 * Klipra brand mark + optional wordmark.
 * Usage:
 *   <KlipraLogo size={32} />              // mark only
 *   <KlipraLogo size={28} showWordmark />  // mark + "Klipra" text
 */
export default function KlipraLogo({ size = 32, showWordmark = false, className = '' }) {
    const fontSize = Math.round(size * 0.72);
    return (
        <div className={`inline-flex items-center gap-2.5 ${className}`}>
            <svg
                width={size}
                height={size}
                viewBox="0 0 64 64"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-label="Klipra"
            >
                <defs>
                    <linearGradient id={`klg-${size}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#0EA5A4" />
                        <stop offset="0.5" stopColor="#06B6D4" />
                        <stop offset="1" stopColor="#22D3EE" />
                    </linearGradient>
                </defs>
                <rect x="2" y="2" width="60" height="60" rx="14" fill="#0B0F14" stroke={`url(#klg-${size})`} strokeWidth="2" />
                <path d="M19 14 L19 50" stroke={`url(#klg-${size})`} strokeWidth="5" strokeLinecap="round" />
                <path d="M19 32 L45 14" stroke={`url(#klg-${size})`} strokeWidth="5" strokeLinecap="round" />
                <path d="M19 32 L45 50" stroke={`url(#klg-${size})`} strokeWidth="5" strokeLinecap="round" />
                <path d="M22.5 28 L22.5 36 L29 32 Z" fill="#22D3EE" opacity="0.85" />
            </svg>
            {showWordmark && (
                <span
                    className="font-display font-bold text-white tracking-tight"
                    style={{ fontSize: `${fontSize}px`, lineHeight: 1 }}
                >
                    klipra
                </span>
            )}
        </div>
    );
}
