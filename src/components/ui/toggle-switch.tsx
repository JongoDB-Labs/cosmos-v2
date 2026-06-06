"use client";

import { cn } from "@/lib/utils";

/**
 * Small accessible toggle (switch role). Used across settings panels —
 * extracted from security-settings-panel so the same primitive can drive
 * webhooks, integrations, etc.
 */
export function ToggleSwitch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        // OFF state needs a visible track: bg-muted ≈ the card surface, so the
        // pill used to disappear and only the thumb showed as a floating dot.
        // A filled grey track + visible border makes on/off unambiguous.
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-transparent bg-primary"
          : "border-[var(--border)] bg-[var(--text-muted)]/30",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
