"use client";
import { motion as fm } from "framer-motion";
import { cn } from "@/lib/utils";

export type BadgeVariant =
  | "progress"
  | "review"
  | "done"
  | "blocked"
  | "critical"
  | "strategic"
  | "discovery"
  | "neutral";

// Tint (background) uses the saturated base; label text uses the
// WCAG-AA-safe darker variant on light mode (`--status-*-text`). Dark
// mode falls back to the base via the cascade in globals.css.
const VARIANT_TINT: Record<BadgeVariant, string> = {
  progress: "var(--status-progress)",
  review: "var(--status-review)",
  done: "var(--status-done)",
  blocked: "var(--status-blocked)",
  critical: "var(--status-critical)",
  strategic: "var(--status-strategic)",
  discovery: "var(--status-discovery)",
  neutral: "var(--text-muted)",
};

const VARIANT_TEXT: Record<BadgeVariant, string> = {
  progress: "var(--status-progress-text, var(--status-progress))",
  review: "var(--status-review-text, var(--status-review))",
  done: "var(--status-done-text, var(--status-done))",
  blocked: "var(--status-blocked-text, var(--status-blocked))",
  critical: "var(--status-critical-text, var(--status-critical))",
  strategic: "var(--status-strategic-text, var(--status-strategic))",
  discovery: "var(--status-discovery-text, var(--status-discovery))",
  neutral: "var(--status-neutral-text, var(--text-muted))",
};

export function Badge({
  variant = "neutral",
  className,
  children,
  showDot = true,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: React.ReactNode;
  showDot?: boolean;
}) {
  const tint = VARIANT_TINT[variant];
  const textColor = VARIANT_TEXT[variant];
  return (
    <fm.span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        className,
      )}
      initial={{
        color: textColor,
        backgroundColor: `color-mix(in oklab, ${tint} 12%, transparent)`,
      }}
      animate={{
        color: textColor,
        backgroundColor: `color-mix(in oklab, ${tint} 12%, transparent)`,
      }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
    >
      {showDot && (
        <fm.span
          className="h-1.5 w-1.5 rounded-full"
          initial={{ backgroundColor: tint }}
          animate={{ backgroundColor: tint }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        />
      )}
      {children}
    </fm.span>
  );
}
