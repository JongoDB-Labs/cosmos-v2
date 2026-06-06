// src/lib/confetti.ts
"use client";
import confetti from "canvas-confetti";

const COLORS = [
  "#7C5CFF", "#3B82F6", "#06B6D4", "#10B981",
  "#F59E0B", "#EC4899", "#A78BFA",
];

export function celebrate(origin?: { x: number; y: number }) {
  if (typeof window === "undefined") return;
  const prefersReduced = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  if (prefersReduced) return;

  confetti({
    particleCount: 80,
    spread: 65,
    startVelocity: 35,
    colors: COLORS,
    origin: origin ?? { x: 0.5, y: 0.5 },
    disableForReducedMotion: true,
  });
}
