// src/components/brand/orbit-illustration.tsx
export function OrbitIllustration({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 80"
      fill="none"
      aria-hidden
    >
      <ellipse
        cx="60"
        cy="40"
        rx="50"
        ry="14"
        stroke="#A78BFA"
        strokeWidth="1"
        opacity="0.4"
        transform="rotate(-15 60 40)"
      />
      <circle cx="60" cy="40" r="10" fill="#7C5CFF" opacity="0.85" />
      <circle cx="92" cy="28" r="2" fill="var(--status-discovery)" />
      <circle cx="22" cy="56" r="1.5" fill="var(--text)" opacity="0.3" />
      <circle cx="106" cy="56" r="1" fill="var(--text)" opacity="0.3" />
    </svg>
  );
}
