"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * A destructive button with a built-in two-step confirm: the first click "arms"
 * it (swapping to Confirm / Cancel), the second runs `onConfirm`. Lighter than a
 * Dialog for inline one-click-dangerous actions (clear credential, disconnect),
 * and keeps those actions from firing on a single misclick.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirm",
  pending = false,
  disabled = false,
  size,
  variant = "destructive",
  className,
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Button
          variant={variant}
          size={size}
          disabled={pending}
          onClick={() => {
            onConfirm();
            setArmed(false);
          }}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {confirmLabel}
        </Button>
        <Button
          variant="ghost"
          size={size}
          disabled={pending}
          onClick={() => setArmed(false)}
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      className={className}
      onClick={() => setArmed(true)}
    >
      {children}
    </Button>
  );
}
