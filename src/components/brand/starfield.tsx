// src/components/brand/starfield.tsx
export function Starfield({ className = "" }: { className?: string }) {
  // Deterministic-seeming sprinkle of star positions
  const stars = [
    [12, 18], [24, 8], [38, 22], [56, 14], [72, 30], [88, 18],
    [8, 42], [30, 50], [46, 60], [64, 48], [82, 56], [94, 70],
    [16, 78], [42, 86], [68, 82], [90, 92],
  ];
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      {stars.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={i % 4 === 0 ? 0.8 : 0.4}
          fill="var(--text)"
          opacity="0.05"
        />
      ))}
    </svg>
  );
}
