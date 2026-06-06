"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { indeterminate?: boolean }
>(({ className, indeterminate, ...props }, ref) => {
  const inner = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={(node) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.RefObject<HTMLInputElement | null>).current = node;
      }}
      type="checkbox"
      className={cn(
        "h-4 w-4 cursor-pointer rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--primary)] accent-[var(--primary)]",
        className,
      )}
      {...props}
    />
  );
});
Checkbox.displayName = "Checkbox";
