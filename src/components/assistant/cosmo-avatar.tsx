"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Cosmo — the assistant's avatar: a sleek astronaut waving, clipped to a strict
 * circle, stars behind, mirrored visor, gloved five-fingered hand.
 *
 * THEME-ADAPTIVE BY CONSTRUCTION: every theme-dependent color is derived from
 * the app's live tokens — `--primary` (the user's accent) and `--surface`
 * (flips with dark/light) — via `color-mix`, so the avatar re-tints instantly
 * on any preference change with zero JS. The sky's top mixes accent with the
 * surface (bright in light mode, deep in dark); the sky's base always falls
 * toward black (space stays space); rim-light, nebulae, visor horizon, and one
 * status light ride `--primary` directly.
 *
 * Gradient/clip ids come from useId() so any number of instances can coexist.
 */
export function CosmoAvatar({ size = 32, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = (k: string) => `cosmo-${uid}-${k}`;
  const url = (k: string) => `url(#${id(k)})`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label="Cosmo"
      className={cn("shrink-0", className)}
      style={
        {
          "--cosmo-hi": "color-mix(in oklab, var(--primary) 62%, var(--surface))",
          "--cosmo-lo": "color-mix(in oklab, var(--primary) 38%, black)",
        } as React.CSSProperties
      }
    >
      <defs>
        <clipPath id={id("c")}>
          <circle cx="64" cy="64" r="64" />
        </clipPath>
        <radialGradient id={id("bg")} cx="0.38" cy="0.28" r="1.05">
          <stop offset="0" stopColor="var(--cosmo-hi)" />
          <stop offset="1" stopColor="var(--cosmo-lo)" />
        </radialGradient>
        <radialGradient id={id("sh")} cx="0.36" cy="0.3" r="0.95">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.72" stopColor="#eef1f6" />
          <stop offset="1" stopColor="#c9d1dd" />
        </radialGradient>
        <linearGradient id={id("su")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6f8fb" />
          <stop offset="1" stopColor="#c3ccd9" />
        </linearGradient>
        <linearGradient id={id("gl")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d3dae4" />
        </linearGradient>
        <linearGradient id={id("vi")} x1="0.15" y1="0.1" x2="0.8" y2="1">
          <stop offset="0" stopColor="#2c3a6e" />
          <stop offset="0.55" stopColor="#141c3f" />
          <stop offset="1" stopColor="#070b1d" />
        </linearGradient>
        <linearGradient id={id("pa")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#aab4c2" />
          <stop offset="1" stopColor="#7e8a9b" />
        </linearGradient>
        <filter id={id("bl")} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      <g clipPath={url("c")}>
        {/* deep space */}
        <circle cx="64" cy="64" r="64" fill={url("bg")} />
        <ellipse cx="36" cy="92" rx="52" ry="34" fill="var(--primary)" opacity="0.18" filter={url("bl")} />
        <ellipse cx="102" cy="26" rx="34" ry="22" fill="var(--primary)" opacity="0.1" filter={url("bl")} />
        {/* stars — BEHIND the astronaut */}
        <path d="M 30,17.4 L 31.1,20.9 L 34.6,22 L 31.1,23.1 L 30,26.6 L 28.9,23.1 L 25.4,22 L 28.9,20.9 Z" fill="#fff" opacity="0.95" />
        <path d="M 97,13.8 L 97.77,16.23 L 100.2,17 L 97.77,17.77 L 97,20.2 L 96.23,17.77 L 93.8,17 L 96.23,16.23 Z" fill="#fff" opacity="0.8" />
        <path d="M 112,41.6 L 112.58,43.42 L 114.4,44 L 112.58,44.58 L 112,46.4 L 111.42,44.58 L 109.6,44 L 111.42,43.42 Z" fill="#fff" opacity="0.7" />
        <path d="M 15,52.4 L 15.62,54.38 L 17.6,55 L 15.62,55.62 L 15,57.6 L 14.38,55.62 L 12.4,55 L 14.38,54.38 Z" fill="#fff" opacity="0.75" />
        <path d="M 88,6.1 L 88.46,7.54 L 89.9,8 L 88.46,8.46 L 88,9.9 L 87.54,8.46 L 86.1,8 L 87.54,7.54 Z" fill="#fff" opacity="0.6" />
        <path d="M 46,8 L 46.48,9.52 L 48,10 L 46.48,10.48 L 46,12 L 45.52,10.48 L 44,10 L 45.52,9.52 Z" fill="#fff" opacity="0.55" />
        <circle cx="21" cy="38" r="1.1" fill="#fff" opacity="0.8" />
        <circle cx="55" cy="20" r="0.9" fill="#fff" opacity="0.65" />
        <circle cx="105" cy="30" r="1" fill="#fff" opacity="0.7" />
        <circle cx="10" cy="76" r="1" fill="#fff" opacity="0.55" />
        <circle cx="118" cy="62" r="0.9" fill="#fff" opacity="0.6" />
        {/* astronaut */}
        <g transform="rotate(-3 64 78)">
          <rect x="24" y="92" width="12" height="30" rx="5" fill="#b9c2d0" />
          <path d="M30,130 C30,99 42,85 62,85 C82,85 94,99 94,130 Z" fill={url("su")} />
          <path d="M30,130 C30,99 42,85 62,85 L62,130 Z" fill="#ffffff" opacity="0.35" />
          <rect x="50" y="98" width="24" height="17" rx="4.5" fill={url("pa")} />
          <rect x="50" y="98" width="24" height="17" rx="4.5" fill="none" stroke="#5f6b7c" strokeWidth="0.8" opacity="0.6" />
          <circle cx="56.5" cy="104" r="1.8" fill="var(--primary)" />
          <circle cx="62.5" cy="104" r="1.8" fill="#34d399" />
          <circle cx="68.5" cy="104" r="1.8" fill="#fbbf24" />
          <rect x="54" y="109.5" width="16" height="1.8" rx="0.9" fill="#5f6b7c" opacity="0.7" />
          <path d="M40,114 q22,7 44,0" fill="none" stroke="#9aa6b6" strokeWidth="1.1" opacity="0.6" />
          <ellipse cx="62" cy="86" rx="17.5" ry="6" fill="#8f9aab" />
          <ellipse cx="62" cy="85" rx="15.5" ry="4.6" fill="#6b7686" />
          <circle cx="62" cy="56" r="30" fill={url("sh")} />
          <circle cx="62" cy="56" r="30" fill="none" stroke="#aeb9c8" strokeWidth="1.2" />
          <path d="M85.5,71 A30,30 0 0 0 88,49" fill="none" stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="round" opacity="0.65" />
          <path d="M41,56 C41,41.5 49.5,35 62,35 C74.5,35 83,41.5 83,56 C83,69.5 74.5,77 62,77 C49.5,77 41,69.5 41,56 Z" fill={url("vi")} />
          <path d="M41,56 C41,41.5 49.5,35 62,35 C74.5,35 83,41.5 83,56 C83,69.5 74.5,77 62,77 C49.5,77 41,69.5 41,56 Z" fill="none" stroke="#0a0f24" strokeWidth="1.6" />
          <path d="M46,47 C50,38.5 58,36 66,36.5 L50,68 C46.5,63 45,55 46,47 Z" fill="#ffffff" opacity="0.14" />
          <path d="M54,39 L45.5,57" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" opacity="0.4" />
          <path d="M45,64 q17,10 34,-2" fill="none" stroke="var(--primary)" strokeWidth="2.6" strokeLinecap="round" opacity="0.35" />
          <circle cx="73" cy="44" r="1.1" fill="#fff" opacity="0.9" />
          <circle cx="69" cy="49" r="0.7" fill="#fff" opacity="0.7" />
          <ellipse cx="52" cy="35.5" rx="9" ry="4.5" fill="#ffffff" opacity="0.55" transform="rotate(-28 52 35.5)" />
          {/* waving arm + gloved hand (four fingers + thumb) */}
          <path d="M86,101 C93,92 98,84 102,72" fill="none" stroke={url("su")} strokeWidth="14" strokeLinecap="round" />
          <path d="M88,99 C94,91 98,84 101,75" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity="0.35" />
          <rect x="94.5" y="62.5" width="17" height="7.5" rx="3.7" fill="#8f9aab" transform="rotate(-64 103 66)" />
          <g transform="rotate(8 105 52)">
            <ellipse cx="105" cy="52" rx="7" ry="7.8" fill={url("gl")} />
            <path d="M99.6,48 C99,43.5 99.4,40.5 100.2,38.4" stroke={url("gl")} strokeWidth="3.3" strokeLinecap="round" fill="none" />
            <path d="M103.6,46.6 C103.4,41.6 103.8,38 104.6,35.4" stroke={url("gl")} strokeWidth="3.4" strokeLinecap="round" fill="none" />
            <path d="M107.6,46.8 C107.9,42 108.5,38.6 109.5,36.2" stroke={url("gl")} strokeWidth="3.4" strokeLinecap="round" fill="none" />
            <path d="M111.2,48.4 C111.9,44.6 112.7,41.9 113.7,39.9" stroke={url("gl")} strokeWidth="3.2" strokeLinecap="round" fill="none" />
            <path d="M99.4,55 C96.2,53.4 93.9,51.4 92.4,48.9" stroke={url("gl")} strokeWidth="3.8" strokeLinecap="round" fill="none" />
            <path d="M100.5,49.5 q4.5,-1.6 9,0" fill="none" stroke="#aab4c2" strokeWidth="0.9" opacity="0.7" />
          </g>
        </g>
      </g>
      <circle cx="64" cy="64" r="63.4" fill="none" stroke="#000" strokeOpacity="0.08" strokeWidth="1.2" />
    </svg>
  );
}
